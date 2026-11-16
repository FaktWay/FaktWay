import fc from 'fast-check';
import iconv from 'iconv-lite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoryTables, Row } from './helpers/baza-w-pamieci';

const db = vi.hoisted(() => ({ tables: {} as MemoryTables }));
vi.mock('@/lib/supabase/admin', async () => {
  const { memoryClient } = await import('./helpers/baza-w-pamieci');
  return { createAdminClient: () => memoryClient(db.tables) };
});

import { sprawdzJpkV7m } from '@/lib/bezpieczniki/jpk-v7m';
import { fetchInvoicesForExport, importedContentFlags } from '@/lib/exports/data-fetcher';
import { generateEdiPlusPlus } from '@/lib/exports/edi-plus-plus-generator';
import {
  generateJpkFa,
  JPK_DOCUMENT_REFUSAL_PREFIX,
  JpkDocumentNotSupportedError,
  type JpkInvoice,
  type JpkInvoiceLine,
} from '@/lib/exports/jpk-fa-generator';
import { validateJpkFa } from '@/lib/exports/jpk-fa-validator';
import { generateJpkV7m, summarizeJpkV7m, type JpkV7mInputData } from '@/lib/exports/jpk-v7m-generator';
import { validateJpkV7m } from '@/lib/exports/jpk-v7m-validator';
import { buildInvoiceFromForm } from '@/lib/invoices/build-from-form';
import { GTU_CODES } from '@/lib/invoices/line-codes';
import { vatMiesiaca } from '@/lib/ksiegowosc/vat';
import { invoiceFormSchema, type InvoiceFormValues } from '@/lib/schemas/invoice-form';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { roundToCents } from '@/lib/xml/invoice-calculator';
import type { Invoice } from '@/types/invoice';

/**
 * Oznaczenia GTU w JPK_V7M(3): plan kompletnej aplikacji, krok 2.6, część
 * 2b-2 (RP-JPK-GTU-01). Reguły tylko ze źródeł urzędowych:
 *
 * - § 10 ust. 3 rozporządzenia MFiR z 15.10.2019 (Dz.U. 2019 poz. 1988):
 *   ewidencja zawiera oznaczenia dostaw i usług 01-13; XSD JPK_V7M(3) w repo
 *   (`lib/exports/schemas/jpk-v7m3/schemat.xsd`): w wierszu sprzedaży po
 *   `TypDokumentu` sekwencja GTU_01..GTU_13 (`TWybor1`, wartość 1), przed
 *   procedurami i polami K_;
 * - MF, „Pytania i odpowiedzi JPK_VAT z deklaracją” (podatki.gov.pl, odczyt
 *   14.11.2026, oznaczenia GTU): wiele oznaczeń dla jednej faktury bez
 *   dzielenia jej na wpisy (pyt. 2); oznaczeniu podlegają też faktury FP
 *   (pyt. 3); faktura korygująca dostaje GTU, gdy dotyczy towaru albo usługi
 *   z GTU, a korekta samych pozycji bez GTU nie (pyt. 8).
 *
 * Korekta w FaktWay nie zapisuje GTU pozycji (część 2b-3), więc korekta
 * faktury z GTU to odmowa z wyjściem, a nie zgadywanie.
 *
 * Prawdziwa ścieżka: wartości formularza przez schemat (`invoiceFormSchema`)
 * i budowanie faktury (`buildInvoiceFromForm`) do `fa3_data`, odczyt eksportu
 * (`fetchInvoicesForExport`), plik z walidacją XSD MF i strażnikiem
 * (`sprawdzJpkV7m`). Atrapa tylko bazy (w pamięci).
 */

const T = 'firma-gtu';
const NIP = '1234567890';
const KSEF = (n: number) => `${NIP}-20261105-0100001AF6${String(n).padStart(2, '0')}-B${n % 10}`;

const TENANT = { id: T, nip: NIP, name: 'Firma testowa', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } };

type Pozycja = InvoiceFormValues['lines'][number];
const pozycja = (o: Partial<Pozycja> = {}): Pozycja => ({ name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 1000, vatRate: '23', ...o });

/** Wartości formularza zwykłej faktury (nabywca z przykładów testów formularza). */
function formularz(numer: string, lines: Pozycja[], o: Partial<InvoiceFormValues> = {}): InvoiceFormValues {
  return {
    internalNumber: numer,
    issueDate: '2026-11-05',
    saleDate: '',
    buyerNip: '5252241585',
    buyerName: 'Klient Sp. z o.o.',
    buyerAddressLine1: 'ul. B 2',
    buyerAddressLine2: '00-002 Warszawa',
    buyerEmail: '',
    buyerIsConsumer: false,
    buyerPesel: '',
    buyerIdDocument: '',
    paymentMethod: 'transfer',
    paymentDueDate: '2026-11-19',
    bankAccount: 'PL61109010140000071219812874',
    notes: '',
    splitPayment: false,
    lines,
    ...o,
  };
}

let ksefLicznik = 0;

/** Faktura z formularza tak, jak zapisuje ją aplikacja: schemat, budowanie, wiersz z `fa3_data`. */
function zFormularza(numer: string, lines: Pozycja[], o: Partial<InvoiceFormValues> = {}, wiersz: Row = {}): Row {
  const parsed = invoiceFormSchema.safeParse(formularz(numer, lines, o));
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const invoice = buildInvoiceFromForm(parsed.data, TENANT, null, false);
  return {
    id: `inv-${numer}`,
    tenant_id: T,
    direction: 'outgoing',
    invoice_kind: 'regular',
    invoice_type: 'VAT',
    origin: 'app',
    ksef_status: 'accepted',
    ksef_environment: 'test',
    currency: 'PLN',
    internal_number: numer,
    ksef_number: KSEF(++ksefLicznik),
    issue_date: invoice.issueDate,
    sale_date: invoice.saleDate ?? null,
    buyer_nip: invoice.buyer.nip ?? null,
    buyer_data: invoice.buyer,
    seller_data: invoice.seller,
    net_total: invoice.netTotal,
    vat_total: invoice.vatTotal,
    gross_total: invoice.grossTotal,
    fa3_data: invoice,
    parent_invoice_id: null,
    correction_type: null,
    special_data: null,
    advance_invoice_ids: [],
    ...wiersz,
  };
}

/** Korekta kwotowa z FaktWay: pozycja korekty bez GTU (tak zapisuje ją dziś `createCorrectionInvoiceAction`). */
function korekta(numer: string, rodzic: Row): Row {
  const line = { ordinal: 1, name: 'Rabat', unit: 'szt.', quantity: 1, unitPriceNet: -100, vatRate: '23', netAmount: -100, vatAmount: -23, grossAmount: -123 };
  return {
    id: `kor-${numer}`,
    tenant_id: T,
    direction: 'outgoing',
    invoice_kind: 'correction',
    invoice_type: 'KOR',
    origin: 'app',
    ksef_status: 'accepted',
    ksef_environment: 'test',
    currency: 'PLN',
    internal_number: numer,
    ksef_number: KSEF(++ksefLicznik),
    issue_date: '2026-11-20',
    sale_date: null,
    buyer_nip: '5252241585',
    buyer_data: { nip: '5252241585', name: 'Klient Sp. z o.o.' },
    seller_data: null,
    net_total: -100,
    vat_total: -23,
    gross_total: -123,
    fa3_data: { lines: [line] },
    parent_invoice_id: rodzic.id,
    correction_type: 'amount_change',
    correction_reason: 'Rabat',
    special_data: null,
    advance_invoice_ids: [],
  };
}

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
  ksefLicznik = 0;
  db.tables = {
    tenants: [{ id: T, nip: NIP, name: 'Firma testowa', address_json: null }],
    invoices: [],
    invoice_line_items: [],
    expenses: [],
  };
});

async function dane() {
  return fetchInvoicesForExport({ tenantId: T, periodStart: '2026-11-01', periodEnd: '2026-11-30', direction: 'issued' });
}

function plik(issuedInvoices: JpkInvoice[]): JpkV7mInputData {
  return {
    issuer: { nip: NIP, name: 'Firma testowa', email: 'biuro@example.test', taxOfficeCode: '1433' },
    periodStart: '2026-11-01',
    periodEnd: '2026-11-30',
    generatedAt: new Date('2026-12-05T10:00:00Z'),
    issuedInvoices,
    expenses: [],
    previousSurplus: 0,
  };
}

const wiersze = (xml: string) => [...xml.matchAll(/<SprzedazWiersz>([\s\S]*?)<\/SprzedazWiersz>/g)].map((m) => m[1]!);
const wierszFaktury = (xml: string, numer: string) =>
  wiersze(xml).find((w) => w.includes(`<DowodSprzedazy>${numer}</DowodSprzedazy>`)) ?? '';
/** Oznaczenia GTU wiersza w kolejności pliku, z wartością („GTU_06=1”). */
const gtuWiersza = (w: string) => [...w.matchAll(/<(GTU_\d{2})>([^<]*)<\/GTU_\d{2}>/g)].map((m) => `${m[1]}=${m[2]}`);
const bezGtu = (xml: string) => xml.replace(/\s*<GTU_\d{2}>1<\/GTU_\d{2}>/g, '');

async function bezUwag(xml: string) {
  expect((await validateJpkV7m(xml)).errors).toEqual([]);
  expect(sprawdzJpkV7m(xml, '2026-11')).toEqual([]);
}

describe('JPK_V7M(3): GTU z pozycji faktury FaktWay', () => {
  it('faktura z formularza z GTU w pozycjach: GTU_06=1 i GTU_12=1 po NrKSeF, przed K_, w kolejności XSD; faktura bez GTU bez oznaczeń; XSD i strażnik bez uwag', async () => {
    db.tables.invoices!.push(
      zFormularza('FV/1/11/2026', [
        pozycja({ name: 'Doradztwo', gtuCode: 'GTU_12' }),
        pozycja({ name: 'Telefon', unitPriceNet: 500, gtuCode: 'GTU_06' }),
        pozycja({ name: 'Drugie doradztwo', unitPriceNet: 200, gtuCode: 'GTU_12' }),
        pozycja({ name: 'Dojazd', unitPriceNet: 50 }),
      ]),
      zFormularza('FV/2/11/2026', [pozycja({ name: 'Szkolenie' })]),
    );
    const xml = generateJpkV7m(plik((await dane()).issuedInvoices));
    await bezUwag(xml);

    const zGtu = wierszFaktury(xml, 'FV/1/11/2026');
    // Jeden wiersz na fakturę, każde oznaczenie raz (MF, pyt. 2), w kolejności sekwencji z XSD.
    expect(gtuWiersza(zGtu)).toEqual(['GTU_06=1', 'GTU_12=1']);
    expect(zGtu).toMatch(/<NrKSeF>[^<]+<\/NrKSeF>\s*<GTU_06>1<\/GTU_06>\s*<GTU_12>1<\/GTU_12>\s*<K_19>/);
    expect(gtuWiersza(wierszFaktury(xml, 'FV/2/11/2026'))).toEqual([]);
  });

  it('oznaczenie nie zmienia kwot: plik bez elementów GTU jest taki sam jak dla tych samych faktur bez GTU', async () => {
    const lines = [pozycja({ gtuCode: 'GTU_01', unitPriceNet: 333.33 }), pozycja({ vatRate: '8', unitPriceNet: 99.99, gtuCode: 'GTU_13' })];
    db.tables.invoices!.push(zFormularza('FV/3/11/2026', lines));
    const zGtu = generateJpkV7m(plik((await dane()).issuedInvoices));

    db.tables.invoices = [zFormularza('FV/3/11/2026', lines.map(({ gtuCode: _pomin, ...l }) => l))];
    ksefLicznik = 0;
    db.tables.invoices[0]!.ksef_number = KSEF(1);
    const bez = generateJpkV7m(plik((await dane()).issuedInvoices));

    expect(gtuWiersza(wierszFaktury(zGtu, 'FV/3/11/2026'))).toEqual(['GTU_01=1', 'GTU_13=1']);
    expect(bezGtu(zGtu)).toBe(bez);
  });

  it('faktura do paragonu (FP) z GTU: TypDokumentu FP, zaraz po nim GTU (MF: oznaczeniu GTU podlegają też faktury FP)', async () => {
    db.tables.invoices!.push(
      zFormularza('FV/4/11/2026', [pozycja({ name: 'Rower', gtuCode: 'GTU_07' })], {
        saleDate: '2026-10-15',
        receiptInvoice: true,
        receiptNumber: '000123',
        receiptDate: '2026-10-15',
        cashRegisterNumber: 'ABC1234567890',
        receiptRequestDate: '2026-11-02',
        buyerNipOnReceipt: true,
      } as Partial<InvoiceFormValues>),
    );
    const xml = generateJpkV7m(plik((await dane()).issuedInvoices));
    await bezUwag(xml);
    const fp = wierszFaktury(xml, 'FV/4/11/2026');
    expect(fp).toMatch(/<TypDokumentu>FP<\/TypDokumentu>\s*<GTU_07>1<\/GTU_07>\s*<K_19>/);
  });
});

describe('JPK_V7M(3): GTU z pliku KSeF faktury z importu', () => {
  /** Faktura z importu z oznaczeniami z pliku (`fa3_data.ksefMarkers`), jak zapisuje ją import (C5b). */
  function zImportu(numer: string, ksefMarkers: Record<string, unknown>): JpkInvoice {
    return {
      invoiceNumber: numer,
      invoiceType: 'regular',
      currency: 'PLN',
      issueDate: '2026-11-07',
      saleDate: '2026-11-07',
      buyerName: 'Klient Sp. z o.o.',
      buyerNip: '5252241585',
      netTotal: 1000,
      vatTotal: 230,
      grossTotal: 1230,
      ksefNumber: KSEF(90),
      importedFromKsef: true,
      lines: [{ position: 1, name: 'Paliwo', unit: 'l', quantity: 1, unitPriceNet: 1000, netAmount: 1000, vatRate: '23', vatAmount: 230 }],
      ...importedContentFlags('ksef_import', { annotations: {}, ksefMarkers }),
    };
  }

  it('GTU z pliku (poprawne kody) trafia do wiersza tej faktury; XSD i strażnik bez uwag', async () => {
    const xml = generateJpkV7m(plik([zImportu('FA/9/2026', { gtu: ['GTU_02', 'GTU_03'] })]));
    await bezUwag(xml);
    expect(gtuWiersza(wierszFaktury(xml, 'FA/9/2026'))).toEqual(['GTU_02=1', 'GTU_03=1']);
  });

  it('oznaczenie GTU spoza listy GTU_01-GTU_13 w pliku: odmowa z numerem faktury, jak dotąd', () => {
    expect(() => generateJpkV7m(plik([zImportu('FA/10/2026', { gtu: ['GTU_02', '(element złożony)'] })]))).toThrow(
      /JPK wstrzymany: faktura FA\/10\/2026 .*oznaczenie GTU w pozycjach/,
    );
  });

  it('GTU z pliku obok procedury, której FaktWay nie wykazuje: odmowa jak dotąd', () => {
    expect(() => generateJpkV7m(plik([zImportu('FA/11/2026', { gtu: ['GTU_12'], procedures: ['WSTO_EE'] })]))).toThrow(/WSTO_EE/);
  });
});

describe('JPK_V7M(3): korekta faktury z GTU (korekta w FaktWay nie zapisuje GTU pozycji)', () => {
  /** Ta sama odmowa w pliku i w rozliczeniu modułu VAT (moduł i plik mówią to samo). */
  async function odmowa(): Promise<string> {
    const { issuedInvoices } = await dane();
    let komunikat = '';
    try {
      generateJpkV7m(plik(issuedInvoices));
    } catch (e) {
      expect(e).toBeInstanceOf(JpkDocumentNotSupportedError);
      komunikat = (e as Error).message;
    }
    expect(() => summarizeJpkV7m({ issuedInvoices, expenses: [] })).toThrow(komunikat || 'brak odmowy');
    expect(vatMiesiaca({ sprzedaz: issuedInvoices, koszty: [] }, 0)).toEqual({ ok: false, brak: komunikat });
    return komunikat;
  }

  it('korekta faktury FaktWay z GTU w pozycjach: odmowa z numerem korekty, faktury korygowanej i kodami, z wyjściem', async () => {
    const rodzic = zFormularza('FV/5/10/2026', [pozycja({ gtuCode: 'GTU_12' }), pozycja({ name: 'Dojazd', unitPriceNet: 50 })], {
      issueDate: '2026-10-10',
      paymentDueDate: '2026-10-24',
    });
    db.tables.invoices!.push(rodzic, korekta('KOR/1/11/2026', rodzic), zFormularza('FV/6/11/2026', [pozycja()]));
    const komunikat = await odmowa();
    expect(komunikat.startsWith(JPK_DOCUMENT_REFUSAL_PREFIX)).toBe(true);
    expect(komunikat).toContain('faktura KOR/1/11/2026');
    expect(komunikat).toContain('FV/5/10/2026');
    expect(komunikat).toContain('GTU_12');
    expect(komunikat).toMatch(/poza FaktWay/);
  });

  it('korekta faktury z importu z GTU w pliku KSeF: ta sama odmowa', async () => {
    const rodzic: Row = {
      id: 'imp-1', tenant_id: T, direction: 'outgoing', invoice_kind: 'regular', invoice_type: 'VAT', origin: 'ksef_import',
      ksef_status: 'accepted', ksef_environment: 'test', currency: 'PLN', internal_number: 'FA/77/2026', ksef_number: KSEF(77),
      issue_date: '2026-09-15', sale_date: '2026-09-15', buyer_nip: '5252241585', buyer_data: { nip: '5252241585', name: 'Klient' },
      seller_data: null, net_total: 1000, vat_total: 230, gross_total: 1230,
      fa3_data: { import: { source: 'ksef_history' }, annotations: {}, ksefMarkers: { gtu: ['GTU_06'] } },
      parent_invoice_id: null, correction_type: null, special_data: null, advance_invoice_ids: [],
    };
    db.tables.invoices!.push(rodzic, korekta('KOR/2/11/2026', rodzic));
    const komunikat = await odmowa();
    expect(komunikat).toContain('faktura KOR/2/11/2026');
    expect(komunikat).toContain('FA/77/2026');
    expect(komunikat).toContain('GTU_06');
  });

  it('korekta faktury bez GTU: wiersz korekty bez oznaczeń, jak dotąd', async () => {
    const rodzic = zFormularza('FV/7/10/2026', [pozycja()], { issueDate: '2026-10-10', paymentDueDate: '2026-10-24' });
    db.tables.invoices!.push(rodzic, korekta('KOR/3/11/2026', rodzic));
    const xml = generateJpkV7m(plik((await dane()).issuedInvoices));
    await bezUwag(xml);
    expect(gtuWiersza(wierszFaktury(xml, 'KOR/3/11/2026'))).toEqual([]);
  });
});

describe('JPK_FA(4) i EDI++: własna faktura z GTU (pola GTU w nich nie ma)', () => {
  const ADRES = {
    voivodeship: 'MAZOWIECKIE', county: 'Warszawa', commune: 'Mokotów', street: 'ul. Testowa',
    buildingNumber: '1', city: 'Warszawa', postCode: '00-001',
  };

  it('faktura z formularza z GTU w pozycjach: JPK_FA zgodny z XSD i EDI++ powstają bez odmowy i bez GTU; ta sama faktura ma GTU w FA(3) i w JPK_V7M', async () => {
    db.tables.invoices!.push(
      zFormularza('FV/12/11/2026', [pozycja({ name: 'Doradztwo', gtuCode: 'GTU_12' }), pozycja({ name: 'Telefon', unitPriceNet: 500, gtuCode: 'GTU_06' })]),
    );
    const { issuer, issuedInvoices } = await dane();

    // Faktura naprawdę niesie oznaczenia: plik FA(3) i wiersz JPK_V7M (inaczej test przeszedłby fakturą bez GTU).
    const fa3 = generateFA3Xml(db.tables.invoices![0]!.fa3_data as Invoice, { validate: false, generatedAt: new Date('2026-11-05T10:00:00Z') });
    expect([...fa3.matchAll(/<GTU>([^<]+)<\/GTU>/g)].map((m) => m[1])).toEqual(['GTU_12', 'GTU_06']);
    expect(gtuWiersza(wierszFaktury(generateJpkV7m(plik(issuedInvoices)), 'FV/12/11/2026'))).toEqual(['GTU_06=1', 'GTU_12=1']);

    // JPK_FA(4): ścieżka bez opcji `gtuInRow` (`amountsOf(inv)`), schemat bez pola GTU.
    const jpkFa = generateJpkFa({
      issuer: { ...issuer, taxOfficeCode: '1433', registeredAddress: ADRES },
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      issuedInvoices,
      generatedAt: new Date('2026-12-05T10:00:00Z'),
    });
    expect((await validateJpkFa(jpkFa)).errors).toEqual([]);
    expect(jpkFa).toContain('<P_2A>FV/12/11/2026</P_2A>');
    expect(jpkFa).not.toContain('GTU');

    // EDI++: ta sama ścieżka kwot (`amountsOf(inv)`), format 1.05 bez pola GTU.
    const epp = iconv.decode(
      generateEdiPlusPlus({ issuer, periodStart: '2026-11-01', periodEnd: '2026-11-30', issuedInvoices, receivedInvoices: [], generatedAt: new Date('2026-12-05T10:00:00Z') }),
      'win1250',
    );
    expect(epp).toContain('FS FV/12/11/2026');
    expect(epp).not.toContain('GTU');
  });
});

describe('JPK_V7M(3): niezmiennik oznaczeń GTU', () => {
  const STAWKI = ['23', '8', '5', '0'] as const;
  const PCT: Record<(typeof STAWKI)[number], number> = { '23': 0.23, '8': 0.08, '5': 0.05, '0': 0 };

  const liniaArb = fc.record({
    netto: fc.integer({ min: 1, max: 500_000 }).map((gr) => gr / 100),
    stawka: fc.constantFrom(...STAWKI),
    gtu: fc.option(fc.constantFrom(...GTU_CODES), { nil: undefined }),
  });
  const fakturaArb = fc.record({
    linie: fc.array(liniaArb, { minLength: 1, maxLength: 6 }),
    // Faktura z importu: oznaczenia z pliku KSeF (`ksefMarkers.gtu`) zamiast z pozycji.
    zImportu: fc.boolean(),
    fp: fc.boolean(),
  });

  function faktura(f: { linie: Array<{ netto: number; stawka: (typeof STAWKI)[number]; gtu?: (typeof GTU_CODES)[number] }>; zImportu: boolean; fp: boolean }, i: number): JpkInvoice {
    const lines: JpkInvoiceLine[] = f.linie.map((l, j) => ({
      position: j + 1, name: `Pozycja ${j + 1}`, unit: 'szt.', quantity: 1, unitPriceNet: l.netto, netAmount: l.netto,
      vatRate: l.stawka, vatAmount: roundToCents(l.netto * PCT[l.stawka]),
      ...(!f.zImportu && l.gtu ? { gtuCode: l.gtu } : {}),
    }));
    const gtuZPliku = [...new Set(f.linie.flatMap((l) => (l.gtu ? [l.gtu] : [])))];
    const markers = {
      ...(f.zImportu && gtuZPliku.length ? { gtu: gtuZPliku } : {}),
      ...(f.fp ? { fp: true as const } : {}),
    };
    const net = roundToCents(lines.reduce((s, l) => s + l.netAmount, 0));
    const vat = roundToCents(lines.reduce((s, l) => s + (l.vatAmount ?? 0), 0));
    return {
      invoiceNumber: `FV/${i + 1}/11/2026`, invoiceType: 'regular', currency: 'PLN',
      issueDate: '2026-11-10', saleDate: f.fp ? '2026-10-20' : '2026-11-10',
      buyerName: 'Klient', buyerNip: '5252241585', netTotal: net, vatTotal: vat, grossTotal: roundToCents(net + vat),
      ksefNumber: KSEF(i + 1), lines,
      ...(f.zImportu ? { importedFromKsef: true } : {}),
      ...(Object.keys(markers).length ? { ksefMarkers: markers } : {}),
    };
  }

  it('zbiór GTU_xx w wierszu = zbiór oznaczeń pozycji faktury, w kolejności XSD, każde z wartością 1; reszta pliku jak bez GTU; XSD bez uwag', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fakturaArb, { minLength: 1, maxLength: 5 }), async (opisy) => {
        const faktury = opisy.map(faktura);
        const xml = generateJpkV7m(plik(faktury));
        for (const [i, opis] of opisy.entries()) {
          const oczekiwane = GTU_CODES.filter((c) => opis.linie.some((l) => l.gtu === c)).map((c) => `${c}=1`);
          expect(gtuWiersza(wierszFaktury(xml, faktury[i]!.invoiceNumber))).toEqual(oczekiwane);
        }
        const bez = faktury.map((f) => ({
          ...f,
          lines: f.lines.map(({ gtuCode: _pomin, ...l }) => l),
          ...(f.ksefMarkers ? { ksefMarkers: { ...f.ksefMarkers, gtu: undefined } } : {}),
        }));
        expect(bezGtu(xml)).toBe(generateJpkV7m(plik(bez)));
        expect((await validateJpkV7m(xml)).errors).toEqual([]);
      }),
      { numRuns: 40 },
    );
  });
});
