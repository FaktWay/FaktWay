import fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoryTables, Row } from './helpers/baza-w-pamieci';

const db = vi.hoisted(() => ({ tables: {} as MemoryTables }));
const TENANT = '11111111-1111-4111-8111-111111111111';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: vi.fn(async () => ({ ok: true })) }));
// Fikcyjny NIP 1234567890 (AGENTS.md) nie ma sumy kontrolnej; reszta kalkulatora prawdziwa.
vi.mock('@/lib/xml/invoice-calculator', async (orig) => ({
  ...(await orig<typeof import('@/lib/xml/invoice-calculator')>()),
  validateNipChecksum: () => true,
}));
vi.mock('@/lib/supabase/admin', async () => {
  const { memoryClient } = await import('./helpers/baza-w-pamieci');
  return { createAdminClient: () => memoryClient(db.tables) };
});
vi.mock('@/lib/supabase/auth-context', async () => {
  const { memoryClient } = await import('./helpers/baza-w-pamieci');
  return {
    requireUserAndActiveOrg: async () => ({ supabase: memoryClient(db.tables), user: { id: 'uzytkownik' }, tenantId: TENANT, role: 'owner' }),
    ActionAuthError: class ActionAuthError extends Error {},
  };
});

import { getCorrectionParentContextAction, saveCorrectionDraftAction } from '@/components/invoices/correction-actions';
import { fetchInvoicesForExport } from '@/lib/exports/data-fetcher';
import { generateJpkV7m } from '@/lib/exports/jpk-v7m-generator';
import { validateJpkV7m } from '@/lib/exports/jpk-v7m-validator';
import { resolveAmountChangeVatRate } from '@/lib/invoices/correction-amount-change';
import { generateCorrectionInvoiceXml } from '@/lib/ksef/fa3-correction-generator';
import { calculateLineItem, validateInvoice } from '@/lib/xml/invoice-calculator';
import { validateInvoiceXml } from '@/lib/xml/validator';
import type { Invoice } from '@/types/invoice';
import type { CorrectionInvoiceData } from '@/types/invoice-types';
import { opcje } from '../filtr/generatory/ustawienia';

/**
 * Korekta faktury liczonej od brutto (plan kompletnej aplikacji, ustalenie
 * z #760, R1). Faktura za abonament FaktWay liczy VAT od ceny brutto
 * (`lib/billing/self-invoice.ts`: netto = brutto / 1,23 do grosza, VAT =
 * brutto − netto; art. 106e ust. 7 i 9 ustawy o VAT). Korekta liczyła stan
 * przed od netto, więc przy części kwot (np. 20,99 zł: VAT od netto 3,93
 * zamiast 3,92) odmawiała („Pozycje faktury … nie zgadzają się z jej
 * zaakceptowaną kwotą”), a przy reszcie liczyłaby kwoty inną metodą niż
 * faktura. Stan przed ma odtwarzać kwoty faktury co do grosza.
 *
 * Prawdziwa ścieżka: akcje strony (`getCorrectionParentContextAction`,
 * `saveCorrectionDraftAction`) na bazie w pamięci, koperta z wiersza do
 * generatora FA(3) KOR, XSD MF. Atrapy: sesja, kolejka KSeF, dziennik.
 */

const PARENT = '00000000-0000-4000-8000-000000000001';
const KSEF_RODZICA = '1234567890-20261102-0100001AF601-B1';
const SPRZEDAWCA = { nip: '1234567890', name: 'FaktWay testowy', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } };
const NABYWCA = { nip: '1234567890', name: 'Klient testowy', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' } };

/** Kwoty jak w `buildSelfInvoiceDraft` (`lib/billing/self-invoice.ts`), w groszach całkowitych. */
function zBrutto(bruttoGr: number) {
  const nettoGr = Math.round((bruttoGr * 100) / 123);
  return { netto: nettoGr / 100, vat: (bruttoGr - nettoGr) / 100, brutto: bruttoGr / 100 };
}

/** Faktura za abonament przyjęta w KSeF: jedna pozycja, ilość 1, cena netto z brutto. */
function fakturaZaAbonament(bruttoGr: number) {
  const k = zBrutto(bruttoGr);
  const line = {
    ordinal: 1, name: 'FaktWay, abonament miesięczny', unit: 'usł.', quantity: 1, unitPriceNet: k.netto,
    netAmount: k.netto, vatRate: '23', vatAmount: k.vat, grossAmount: k.brutto,
  };
  db.tables.invoices!.push({
    id: PARENT, tenant_id: TENANT, direction: 'outgoing', invoice_kind: 'regular', invoice_type: 'VAT', origin: 'app',
    ksef_status: 'accepted', ksef_environment: 'test', ksef_number: KSEF_RODZICA, currency: 'PLN',
    internal_number: 'FV 1/11/2026', issue_date: '2026-11-02',
    net_total: k.netto, vat_total: k.vat, gross_total: k.brutto,
    seller_data: SPRZEDAWCA, buyer_data: NABYWCA,
    fa3_data: { internalNumber: 'FV 1/11/2026', lines: [line] },
  });
  db.tables.invoice_line_items!.push({
    id: `${PARENT}-1`, invoice_id: PARENT, ordinal: 1, name: line.name, unit: line.unit, quantity: 1,
    unit_price_net: k.netto, net_amount: k.netto, vat_rate: '23', vat_amount: k.vat, gross_amount: k.brutto,
  });
  return k;
}

function payload(o: Record<string, unknown>) {
  return {
    invoiceType: 'correction', internalNumber: 'FK/1/11/2026', issueDate: '2026-11-16', paymentMethod: 'transfer', paymentDueDate: '2026-11-30',
    parentInvoiceId: PARENT, parentInvoiceNumber: 'FV 1/11/2026', parentInvoiceIssueDate: '2026-11-02', parentKsefNumber: KSEF_RODZICA,
    correctionReason: 'Zwrot za abonament', typKorekty: '2',
    seller: SPRZEDAWCA, buyer: { type: 'b2b', idType: 'nip', ...NABYWCA },
    ...o,
  } as never;
}

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
  db.tables = { tenants: [{ id: TENANT, nip: '1234567890', name: 'FaktWay testowy', address_json: null }], invoices: [], invoice_line_items: [] };
});

const zapisana = () => db.tables.invoices!.find((r) => r.invoice_kind === 'correction')!;
const koperta = () => (zapisana().special_data as { correctionData: CorrectionInvoiceData }).correctionData;
const pole = (xml: string, nazwa: string) => new RegExp(`<${nazwa}>([^<]*)</${nazwa}>`).exec(xml)?.[1];

/** 20,99 zł: VAT od brutto 3,92, od netto 17,07 × 23 % = 3,93. */
const BRUTTO_GR = 2099;

describe('korekta faktury liczonej od brutto (faktura za abonament)', () => {
  it('kontekst formularza: korekta faktury 20,99 zł nie odmawia, stan przed to pozycja faktury', async () => {
    fakturaZaAbonament(BRUTTO_GR);
    const ctx = await getCorrectionParentContextAction(PARENT);
    expect(ctx).toMatchObject({ success: true, grossTotal: 20.99 });
  });

  it('anulowanie: różnica to kwoty faktury z minusem co do grosza (−17,07 netto, −3,92 VAT, −20,99); XSD', async () => {
    fakturaZaAbonament(BRUTTO_GR);
    const ctx = await getCorrectionParentContextAction(PARENT);
    if (!ctx.success) throw new Error(ctx.error);
    const r = await saveCorrectionDraftAction(payload({ correctionType: 'cancellation', linesBefore: ctx.linesBefore, linesAfter: ctx.linesAfter }), TENANT);
    if (!r.success) throw new Error(r.error);
    expect(zapisana()).toMatchObject({ net_total: -17.07, vat_total: -3.92, gross_total: -20.99 });
    const xml = generateCorrectionInvoiceXml(koperta(), { generatedAt: new Date('2026-11-16T10:00:00Z') });
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
    expect([pole(xml, 'P_13_1'), pole(xml, 'P_14_1'), pole(xml, 'P_15'), pole(xml, 'P_11')]).toEqual(['-17.07', '-3.92', '-20.99', '-17.07']);
  });

  it('korekta kwotowa zwrotu liczonego od brutto (−20,99: −17,07 i −3,92) przechodzi; plik ma te kwoty', async () => {
    fakturaZaAbonament(BRUTTO_GR);
    const r = await saveCorrectionDraftAction(
      payload({ correctionType: 'amount_change', amountChange: { netDelta: -17.07, vatDelta: -3.92, grossDelta: -20.99, description: 'Zwrot za abonament' } }),
      TENANT,
    );
    if (!r.success) throw new Error(r.error);
    const xml = generateCorrectionInvoiceXml(koperta(), { generatedAt: new Date('2026-11-16T10:00:00Z') });
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
    expect([pole(xml, 'P_13_1'), pole(xml, 'P_14_1'), pole(xml, 'P_15')]).toEqual(['-17.07', '-3.92', '-20.99']);
  });
});

describe('korekta faktury od brutto: odmowy z wyjściem i cena brutto tylko od serwera', () => {
  it('korekta pozycji („przed / po”) faktury od brutto: odmowa z wyjściem (anuluj albo korekta kwotowa)', async () => {
    fakturaZaAbonament(BRUTTO_GR);
    const ctx = await getCorrectionParentContextAction(PARENT);
    if (!ctx.success) throw new Error(ctx.error);
    const r = await saveCorrectionDraftAction(
      payload({ correctionType: 'before_after', linesBefore: ctx.linesBefore, linesAfter: [{ ...ctx.linesAfter[0]!, quantity: 0.5 }] }),
      TENANT,
    );
    expect(r).toMatchObject({ success: false });
    expect(r.success ? '' : r.error).toMatch(/kwoty nie wynikają z ilości i ceny netto.*Anuluj fakturę albo wystaw korektę kwotową/);
  });

  it('VAT korekty kwotowej od brutto do faktury liczonej od netto: odmowa z podpowiedzią (VAT od netto)', async () => {
    // Faktura od netto: 17,07 netto, 3,93 VAT (17,07 × 23 %), 21,00 brutto.
    db.tables.invoices!.push({
      id: PARENT, tenant_id: TENANT, direction: 'outgoing', invoice_kind: 'regular', invoice_type: 'VAT', origin: 'app',
      ksef_status: 'accepted', ksef_environment: 'test', ksef_number: KSEF_RODZICA, currency: 'PLN',
      internal_number: 'FV 1/11/2026', issue_date: '2026-11-02', net_total: 17.07, vat_total: 3.93, gross_total: 21,
      seller_data: SPRZEDAWCA, buyer_data: NABYWCA, fa3_data: { internalNumber: 'FV 1/11/2026', lines: [] },
    });
    db.tables.invoice_line_items!.push({
      id: `${PARENT}-1`, invoice_id: PARENT, ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1,
      unit_price_net: 17.07, net_amount: 17.07, vat_rate: '23', vat_amount: 3.93, gross_amount: 21,
    });
    const r = await saveCorrectionDraftAction(
      payload({ correctionType: 'amount_change', amountChange: { netDelta: -17.07, vatDelta: -3.92, grossDelta: -20.99, description: 'Zwrot' } }),
      TENANT,
    );
    expect(r).toMatchObject({ success: false });
    // Zdanie odmowy podaje kwoty, które przejdą (uwaga do #881): −17,07 × 23 % = −3,9261, do grosza −3,93; brutto −21,00.
    expect(r.success ? '' : r.error).toMatch(/liczy VAT od netto\. Przy zmianie netto -17,07 zł i stawce 23% zmiana VAT to -3,93 zł, a zmiana brutto -21,00 zł/);
  });

  it('cena brutto z żądania w pozycji „po” faktury od netto się nie liczy: plik liczy od netto', async () => {
    db.tables.invoices!.push({
      id: PARENT, tenant_id: TENANT, direction: 'outgoing', invoice_kind: 'regular', invoice_type: 'VAT', origin: 'app',
      ksef_status: 'accepted', ksef_environment: 'test', ksef_number: KSEF_RODZICA, currency: 'PLN',
      internal_number: 'FV 1/11/2026', issue_date: '2026-11-02', net_total: 100, vat_total: 23, gross_total: 123,
      seller_data: SPRZEDAWCA, buyer_data: NABYWCA, fa3_data: { internalNumber: 'FV 1/11/2026', lines: [] },
    });
    db.tables.invoice_line_items!.push({
      id: `${PARENT}-1`, invoice_id: PARENT, ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1,
      unit_price_net: 100, net_amount: 100, vat_rate: '23', vat_amount: 23, gross_amount: 123,
    });
    const ctx = await getCorrectionParentContextAction(PARENT);
    if (!ctx.success) throw new Error(ctx.error);
    expect(ctx.linesBefore[0]).not.toHaveProperty('unitPriceGross');
    const r = await saveCorrectionDraftAction(
      payload({ correctionType: 'before_after', linesBefore: ctx.linesBefore, linesAfter: [{ ...ctx.linesAfter[0]!, unitPriceNet: 90, unitPriceGross: 1 }] }),
      TENANT,
    );
    if (!r.success) throw new Error(r.error);
    expect(koperta().linesAfter?.[0]).not.toHaveProperty('unitPriceGross');
    expect(zapisana()).toMatchObject({ net_total: -10, vat_total: -2.3, gross_total: -12.3 });
  });
});

describe('niezmiennik: anulowanie faktury od brutto odtwarza jej kwoty', () => {
  it('dla każdej ceny brutto 0,01-10 000 zł: kontekst bez odmowy, anulowanie = kwoty faktury z minusem; XSD', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1_000_000 }), async (bruttoGr) => {
        db.tables = { tenants: [{ id: TENANT, nip: '1234567890', name: 'FaktWay testowy', address_json: null }], invoices: [], invoice_line_items: [] };
        const k = fakturaZaAbonament(bruttoGr);
        const ctx = await getCorrectionParentContextAction(PARENT);
        if (!ctx.success) throw new Error(ctx.error);
        const r = await saveCorrectionDraftAction(payload({ correctionType: 'cancellation', linesBefore: ctx.linesBefore, linesAfter: ctx.linesAfter }), TENANT);
        if (!r.success) throw new Error(r.error);
        const z: Row = zapisana();
        // `+ 0`: zero bez znaku (jsonb nie zna −0).
        expect([z.net_total, z.vat_total, z.gross_total].map((v) => Number(v) + 0)).toEqual([-k.netto, -k.vat, -k.brutto].map((v) => v + 0));
        const xml = generateCorrectionInvoiceXml(koperta(), { generatedAt: new Date('2026-11-16T10:00:00Z') });
        expect(pole(xml, 'P_14_1')).toBe((-k.vat).toFixed(2));
        expect((await validateInvoiceXml(xml)).errors).toEqual([]);
      }),
      opcje(40),
    );
  });
});

/** Pozycja zapisana tak, jak podaje ją wiersz (`invoice_line_items`) i dokument (`fa3_data.lines`). */
function faktura(linie: Array<{ name: string; quantity: number; unitPriceNet: number; vatRate: '23' | '8' | '5' | '0'; net: number; vat: number; gross: number }>) {
  const r = (v: number) => Math.round(v * 100) / 100;
  const net = r(linie.reduce((a, l) => a + l.net, 0));
  const vat = r(linie.reduce((a, l) => a + l.vat, 0));
  db.tables.invoices!.push({
    id: PARENT, tenant_id: TENANT, direction: 'outgoing', invoice_kind: 'regular', invoice_type: 'VAT', origin: 'app',
    ksef_status: 'accepted', ksef_environment: 'test', ksef_number: KSEF_RODZICA, currency: 'PLN',
    internal_number: 'FV 1/11/2026', issue_date: '2026-11-02', net_total: net, vat_total: vat, gross_total: r(net + vat),
    seller_data: SPRZEDAWCA, buyer_data: NABYWCA,
    fa3_data: { internalNumber: 'FV 1/11/2026', lines: linie.map((l, i) => ({ ordinal: i + 1, name: l.name, unit: 'usł.', quantity: l.quantity, unitPriceNet: l.unitPriceNet, vatRate: l.vatRate, netAmount: l.net, vatAmount: l.vat, grossAmount: l.gross })) },
  });
  db.tables.invoice_line_items!.push(...linie.map((l, i) => ({
    id: `${PARENT}-${i + 1}`, invoice_id: PARENT, ordinal: i + 1, name: l.name, unit: 'usł.', quantity: l.quantity,
    unit_price_net: l.unitPriceNet, net_amount: l.net, vat_rate: l.vatRate, vat_amount: l.vat, gross_amount: l.gross,
  })));
}

describe('uwagi drugiego czytelnika (31a9e96c)', () => {
  // Naprawa ilość × cena (stos na #828): 10,125 → 10,12 to połówka grosza w dół, więc pozycja od netto
  // (`amountsFollowNetPrice`, tests/unit/korekta-stara-faktura.test.ts); odmowę sprawdza netto spoza połówki.
  it('pozycja od netto z netto ≠ ilość × cena (import: cena 10,13, netto 10,12): „przed/po” odmawia neutralnie, z wyjściem; anulowanie odtwarza kwoty', async () => {
    faktura([{ name: 'Usługa z importu', quantity: 1, unitPriceNet: 10.13, vatRate: '23', net: 10.12, vat: 2.33, gross: 12.45 }]);
    const ctx = await getCorrectionParentContextAction(PARENT);
    if (!ctx.success) throw new Error(ctx.error);
    const r = await saveCorrectionDraftAction(
      payload({ correctionType: 'before_after', linesBefore: ctx.linesBefore, linesAfter: [{ ...ctx.linesAfter[0]!, quantity: 2 }] }),
      TENANT,
    );
    const blad = r.success ? '' : r.error;
    expect(blad).toMatch(/kwoty nie wynikają z ilości i ceny netto/);
    expect(blad).toMatch(/Anuluj fakturę albo wystaw korektę kwotową/);
    expect(blad).not.toMatch(/faktura za abonament\)/);
  });

  it('drobne korekty kwotowe od netto mają jedną stawkę jak przed zmianą (np. 0,06/0,01/0,07 przy 23 %, 0,10/0/0,10 przy 0 %)', () => {
    const przypadki: Array<[number, number, number, string]> = [
      [0.06, 0.01, 0.07, '23'], [0.07, 0.01, 0.08, '8'], [0.1, 0, 0.1, '0'], [0.19, 0.01, 0.2, '5'],
    ];
    for (const [netDelta, vatDelta, grossDelta, stawka] of przypadki) {
      expect(resolveAmountChangeVatRate({ netDelta, vatDelta, grossDelta })).toBe(stawka);
    }
  });

  it('przegląd do 2000 zł: każda trójka z jedną stawką od netto ma tę samą stawkę także teraz', () => {
    // Wyrocznia w groszach całkowitych (art. 106e ust. 11: od 0,5 grosza w górę), nie w liczbach
    // zmiennoprzecinkowych: dawne `r = Math.round(v * 100) / 100` na połówce grosza szło w dół
    // (FZ-025) i uzgadniało test z tym samym błędem co kod. VAT = ⌊(netto_gr × stawka + 50) / 100⌋.
    const stawki = [['23', 23], ['8', 8], ['5', 5], ['0', 0]] as const;
    const vatGr = (netGr: number, stopa: number) => Math.floor((netGr * stopa + 50) / 100);
    let sprawdzone = 0;
    for (let netGr = 1; netGr <= 200_000; netGr += 1) {
      for (const [, stopa] of stawki) {
        const vGr = vatGr(netGr, stopa);
        const odNetto = stawki.filter(([, s]) => vatGr(netGr, s) === vGr);
        if (odNetto.length !== 1) continue;
        sprawdzone += 1;
        expect(resolveAmountChangeVatRate({ netDelta: netGr / 100, vatDelta: vGr / 100, grossDelta: (netGr + vGr) / 100 })).toBe(odNetto[0]![0]);
      }
    }
    expect(sprawdzone).toBeGreaterThan(700_000);
    // Ponad 700 000 sprawdzeń: w CI ok. 7 s, więcej niż domyślne 5 s (jak #872 dla fa3-fawiersz-klasyfikacja-xsd).
  }, 600_000);

  it('pozycja z importu z ceną brutto z pliku (P_9B) waliduje się jak dotąd: kwoty od netto, bez zmiany wzoru', () => {
    const line = { ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 17.07, unitPriceGross: 20.99, vatRate: '23' as const, netAmount: 17.07, vatAmount: 3.93, grossAmount: 21 };
    expect(calculateLineItem(line)).toEqual({ netAmount: 17.07, vatAmount: 3.93, grossAmount: 21 });
    const invoice = {
      internalNumber: 'FV/1', type: 'VAT', issueDate: '2026-11-02', saleDate: '2026-11-02',
      seller: SPRZEDAWCA, buyer: NABYWCA, lines: [line], netTotal: 17.07, vatTotal: 3.93, grossTotal: 21,
      currency: 'PLN', payment: { method: 'transfer', dueDate: '2026-11-16', amountDue: 21, currency: 'PLN' },
    } as unknown as Invoice;
    expect(validateInvoice(invoice, new Date('2026-11-02T10:00:00Z')).filter((e) => /Pozycja 1/.test(e))).toEqual([]);
  });

  it('JPK_V7M: anulowanie faktury od brutto ma w wierszu korekty kwoty faktury z minusem (K_19 −17,07, K_20 −3,92); XSD', async () => {
    fakturaZaAbonament(BRUTTO_GR);
    const ctx = await getCorrectionParentContextAction(PARENT);
    if (!ctx.success) throw new Error(ctx.error);
    const r = await saveCorrectionDraftAction(payload({ correctionType: 'cancellation', linesBefore: ctx.linesBefore, linesAfter: ctx.linesAfter }), TENANT);
    if (!r.success) throw new Error(r.error);
    Object.assign(zapisana(), { ksef_status: 'accepted', ksef_environment: 'test', ksef_number: '1234567890-20261116-0100001AF602-B2', currency: 'PLN', origin: 'app' });
    const { issuedInvoices } = await fetchInvoicesForExport({ tenantId: TENANT, periodStart: '2026-11-01', periodEnd: '2026-11-30', direction: 'issued' });
    const xml = generateJpkV7m({
      issuer: { nip: '1234567890', name: 'FaktWay testowy', email: 'biuro@example.test', taxOfficeCode: '1433' },
      periodStart: '2026-11-01', periodEnd: '2026-11-30', generatedAt: new Date('2026-12-05T10:00:00Z'),
      issuedInvoices, expenses: [], previousSurplus: 0,
    });
    expect((await validateJpkV7m(xml)).errors).toEqual([]);
    const wiersz = [...xml.matchAll(/<SprzedazWiersz>([\s\S]*?)<\/SprzedazWiersz>/g)].map((m) => m[1]!).find((w) => w.includes('FK/1/11/2026')) ?? '';
    expect([pole(wiersz, 'K_19'), pole(wiersz, 'K_20')]).toEqual(['-17.07', '-3.92']);
  });
});

describe('niezmiennik: faktura od netto bez zmian', () => {
  it('pozycje liczone od netto (ilość × cena, VAT od netto): stan przed bez ceny brutto, anulowanie = kwoty faktury z minusem', async () => {
    const stawki = ['23', '8', '5', '0'] as const;
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({
          quantity: fc.oneof(fc.integer({ min: 1, max: 50 }), fc.integer({ min: 1, max: 9_999 }).map((n) => n / 1000)),
          cenaGr: fc.integer({ min: 1, max: 500_000 }),
          vatRate: fc.constantFrom(...stawki),
        }), { minLength: 1, maxLength: 4 }),
        async (opisy) => {
          db.tables = { tenants: [{ id: TENANT, nip: '1234567890', name: 'FaktWay testowy', address_json: null }], invoices: [], invoice_line_items: [] };
          const linie = opisy.map((o, i) => {
            const c = calculateLineItem({ quantity: o.quantity, unitPriceNet: o.cenaGr / 100, vatRate: o.vatRate });
            return { name: `Pozycja ${i + 1}`, quantity: o.quantity, unitPriceNet: o.cenaGr / 100, vatRate: o.vatRate, net: c.netAmount, vat: c.vatAmount, gross: c.grossAmount };
          });
          faktura(linie);
          const ctx = await getCorrectionParentContextAction(PARENT);
          if (!ctx.success) throw new Error(ctx.error);
          expect(ctx.linesBefore.every((l) => !('unitPriceGross' in l))).toBe(true);
          const r = await saveCorrectionDraftAction(payload({ correctionType: 'cancellation', linesBefore: ctx.linesBefore, linesAfter: ctx.linesAfter }), TENANT);
          if (!r.success) throw new Error(r.error);
          const z: Row = zapisana();
          const inv = db.tables.invoices!.find((w) => w.id === PARENT)!;
          expect([z.net_total, z.vat_total, z.gross_total].map((v) => Number(v) + 0))
            .toEqual([inv.net_total, inv.vat_total, inv.gross_total].map((v) => -Number(v) + 0));
        },
      ),
      opcje(40),
    );
  });
});
