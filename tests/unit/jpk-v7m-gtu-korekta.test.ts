import fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoryTables, Row } from './helpers/baza-w-pamieci';

const db = vi.hoisted(() => ({ tables: {} as MemoryTables }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: vi.fn(async () => ({ ok: true })) }));
// Fikcyjny NIP sprzedawcy 1234567890 (AGENTS.md) nie ma sumy kontrolnej; reszta kalkulatora prawdziwa.
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
    requireUserAndActiveOrg: async () => ({ supabase: memoryClient(db.tables), user: { id: 'uzytkownik' }, tenantId: '11111111-1111-4111-8111-111111111111', role: 'owner' }),
    ActionAuthError: class ActionAuthError extends Error {},
  };
});

import { sprawdzJpkV7m } from '@/lib/bezpieczniki/jpk-v7m';
import { getCorrectionParentContextAction, saveCorrectionDraftAction } from '@/components/invoices/correction-actions';
import { fetchInvoicesForExport } from '@/lib/exports/data-fetcher';
import { JPK_DOCUMENT_REFUSAL_PREFIX, JpkDocumentNotSupportedError, type JpkInvoice } from '@/lib/exports/jpk-fa-generator';
import { generateJpkV7m, summarizeJpkV7m, type JpkV7mInputData } from '@/lib/exports/jpk-v7m-generator';
import { validateJpkV7m } from '@/lib/exports/jpk-v7m-validator';
import { buildInvoiceFromForm } from '@/lib/invoices/build-from-form';
import { GTU_CODES } from '@/lib/invoices/line-codes';
import { generateCorrectionInvoiceXml } from '@/lib/ksef/fa3-correction-generator';
import { vatMiesiaca } from '@/lib/ksiegowosc/vat';
import { invoiceFormSchema, type InvoiceFormValues } from '@/lib/schemas/invoice-form';
import type { CorrectionInvoiceData, InvoiceLine } from '@/types/invoice-types';

/**
 * Oznaczenia GTU wiersza korekty w JPK_V7M(3): plan kompletnej aplikacji,
 * krok 2.6, część 2b-3 (RP-JPK-GTU-01). Reguła ze źródeł urzędowych:
 * § 10 ust. 3 rozporządzenia MFiR z 15.10.2019 (Dz.U. 2019 poz. 1988) i MF,
 * „Pytania i odpowiedzi JPK_VAT z deklaracją” (oznaczenia GTU, pyt. 8):
 * fakturę korygującą oznacza się kodem GTU, gdy dotyczy towaru albo usługi
 * z tym oznaczeniem, a korektę samych pozycji bez GTU zostawia się bez
 * oznaczenia. Korekta FaktWay niesie kody pozycji faktury korygowanej, więc
 * wiersz korekty dostaje kody pozycji, których dotyczy, a odmowa zostaje tam,
 * gdzie FaktWay tego nie wie.
 *
 * Prawdziwa ścieżka: faktura z formularza (schemat, `buildInvoiceFromForm`)
 * w bazie, korekta przez akcje strony (`getCorrectionParentContextAction`,
 * `saveCorrectionDraftAction`), odczyt eksportu (`fetchInvoicesForExport`),
 * plik z walidacją XSD MF i strażnikiem (`sprawdzJpkV7m`), plik FA(3) KOR
 * z koperty. Atrapy: baza w pamięci, sesja, kolejka KSeF, dziennik. Przyjęcie
 * korekty w KSeF to tylko status na wierszu.
 */

const T = '11111111-1111-4111-8111-111111111111';
const NIP = '1234567890';
const PARENT = '00000000-0000-4000-8000-000000000001';
const TENANT = { id: T, nip: NIP, name: 'Firma testowa', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } };

let ksefLicznik = 0;
/** Numer KSeF we wzorze XSD (NIP fikcyjny). */
const KSEF = (n: number) => `${NIP}-20261105-0100001AF6${String(n).padStart(2, '0')}-B${n % 10}`;

type Pozycja = InvoiceFormValues['lines'][number];
const pozycja = (o: Partial<Pozycja>): Pozycja => ({ name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 1000, vatRate: '23', ...o });
const DORADZTWO = pozycja({ name: 'Doradztwo', gtuCode: 'GTU_12' });
const DOJAZD = pozycja({ name: 'Dojazd', unitPriceNet: 50 });
const LEK = pozycja({ name: 'Lek', unit: 'szt.', unitPriceNet: 200, vatRate: '8', gtuCode: 'GTU_09' });

/** Faktura z formularza tak, jak zapisuje ją aplikacja (`fa3_data` i `invoice_line_items`), przyjęta w KSeF w październiku. */
function faktura(lines: Pozycja[], id = PARENT, numer = 'FV/1/10/2026'): void {
  const parsed = invoiceFormSchema.safeParse({
    internalNumber: numer, issueDate: '2026-10-10', saleDate: '', buyerNip: '5252241585', buyerName: 'Klient Sp. z o.o.',
    buyerAddressLine1: 'ul. B 2', buyerAddressLine2: '00-002 Warszawa', buyerEmail: '', buyerIsConsumer: false,
    buyerPesel: '', buyerIdDocument: '', paymentMethod: 'transfer', paymentDueDate: '2026-10-24',
    bankAccount: 'PL61109010140000071219812874', notes: '', splitPayment: false, lines,
  } satisfies InvoiceFormValues);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const invoice = buildInvoiceFromForm(parsed.data, TENANT, null, false);
  db.tables.invoices!.push({
    id, tenant_id: T, direction: 'outgoing', invoice_kind: 'regular', invoice_type: 'VAT', origin: 'app',
    ksef_status: 'accepted', ksef_environment: 'test', ksef_accepted_at: '2026-10-10T10:00:00Z', currency: 'PLN',
    internal_number: numer, ksef_number: KSEF(++ksefLicznik), issue_date: invoice.issueDate, sale_date: invoice.saleDate ?? null,
    buyer_nip: invoice.buyer.nip ?? null, buyer_data: invoice.buyer, seller_data: invoice.seller,
    net_total: invoice.netTotal, vat_total: invoice.vatTotal, gross_total: invoice.grossTotal, fa3_data: invoice,
    parent_invoice_id: null, correction_type: null, special_data: null, advance_invoice_ids: [], created_at: '2026-10-10T09:00:00Z',
  });
  db.tables.invoice_line_items!.push(...invoice.lines.map((l) => ({
    id: `${id}-${l.ordinal}`, invoice_id: id, ordinal: l.ordinal, name: l.name, unit: l.unit, quantity: l.quantity,
    unit_price_net: l.unitPriceNet, net_amount: l.netAmount, vat_rate: l.vatRate, vat_amount: l.vatAmount, gross_amount: l.grossAmount,
  })));
}

type Rodzaj =
  | { correctionType: 'before_after'; po: (przed: InvoiceLine[]) => InvoiceLine[] }
  | { correctionType: 'cancellation' }
  | { correctionType: 'amount_change'; amountChange: { netDelta: number; vatDelta: number; grossDelta: number; description: string } };

/**
 * Korekta z formularza strony: kontekst faktury, zapis szkicu, potem przyjęcie
 * w KSeF (status na wierszu). Zwraca zapisany wiersz korekty.
 */
async function korekta(rodzaj: Rodzaj, issueDate = '2026-11-20', parentId = PARENT): Promise<Row> {
  const ctx = await getCorrectionParentContextAction(parentId);
  if (!ctx.success) throw new Error(ctx.error);
  const przed = ctx.linesBefore as InvoiceLine[];
  const r = await saveCorrectionDraftAction({
    invoiceType: 'correction', internalNumber: `KOR/${ksefLicznik + 1}/2026`, issueDate, paymentMethod: 'transfer', paymentDueDate: '2026-12-04',
    parentInvoiceId: parentId, parentInvoiceNumber: ctx.internalNumber ?? '', parentInvoiceIssueDate: ctx.issueDate,
    parentKsefNumber: ctx.ksefNumber ?? undefined, correctionReason: 'Zmiana po reklamacji', typKorekty: '2',
    seller: ctx.seller, buyer: ctx.buyer, linesBefore: ctx.linesBefore,
    ...(rodzaj.correctionType === 'before_after'
      ? { correctionType: 'before_after', linesAfter: rodzaj.po(structuredClone(przed)) }
      : rodzaj.correctionType === 'amount_change'
        ? { correctionType: 'amount_change', amountChange: rodzaj.amountChange }
        : { correctionType: 'cancellation' }),
  } as never, T);
  if (!r.success) throw new Error(`Zapis korekty: ${r.error}`);
  const row = db.tables.invoices!.filter((w) => w.invoice_kind === 'correction').at(-1)!;
  Object.assign(row, {
    ksef_status: 'accepted', ksef_environment: 'test', ksef_number: KSEF(++ksefLicznik), currency: row.currency ?? 'PLN',
    origin: row.origin ?? 'app', ksef_accepted_at: `${issueDate}T12:00:00Z`, created_at: row.created_at ?? `${issueDate}T11:00:00Z`,
  });
  return row;
}

const koperta = (row: Row) => (row.special_data as { correctionData: CorrectionInvoiceData }).correctionData;
const numer = (row: Row) => row.internal_number as string;

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
  ksefLicznik = 0;
  db.tables = {
    tenants: [{ id: T, nip: NIP, name: 'Firma testowa', address_json: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } }],
    invoices: [],
    invoice_line_items: [],
    expenses: [],
  };
});

async function dane(): Promise<JpkInvoice[]> {
  return (await fetchInvoicesForExport({ tenantId: T, periodStart: '2026-11-01', periodEnd: '2026-11-30', direction: 'issued' })).issuedInvoices;
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
const wierszFaktury = (xml: string, nr: string) => wiersze(xml).find((w) => w.includes(`<DowodSprzedazy>${nr}</DowodSprzedazy>`)) ?? '';
/** Oznaczenia GTU wiersza w kolejności pliku, z wartością („GTU_12=1”). */
const gtuWiersza = (w: string) => [...w.matchAll(/<(GTU_\d{2})>([^<]*)<\/GTU_\d{2}>/g)].map((m) => `${m[1]}=${m[2]}`);
const bezGtu = (xml: string) => xml.replace(/\s*<GTU_\d{2}>1<\/GTU_\d{2}>/g, '');
/** Kody GTU wierszy FaWiersz pliku FA(3) KOR z koperty korekty, każdy raz, w kolejności XSD. */
function gtuPlikuKorekty(row: Row): string[] {
  const xml = generateCorrectionInvoiceXml(koperta(row), { generatedAt: new Date('2026-11-20T10:00:00Z') });
  const kody = new Set([...xml.matchAll(/<GTU>(GTU_\d{2})<\/GTU>/g)].map((m) => m[1]!));
  return GTU_CODES.filter((c) => kody.has(c));
}

async function wierszKorekty(row: Row): Promise<string[]> {
  const xml = generateJpkV7m(plik(await dane()));
  expect((await validateJpkV7m(xml)).errors).toEqual([]);
  expect(sprawdzJpkV7m(xml, '2026-11')).toEqual([]);
  return gtuWiersza(wierszFaktury(xml, numer(row)));
}

/** Ta sama odmowa w pliku i w rozliczeniu modułu VAT (moduł i plik mówią to samo). */
async function odmowa(): Promise<string> {
  const issuedInvoices = await dane();
  let komunikat = '';
  try {
    generateJpkV7m(plik(issuedInvoices));
  } catch (e) {
    expect(e).toBeInstanceOf(JpkDocumentNotSupportedError);
    komunikat = (e as Error).message;
  }
  expect(komunikat.startsWith(JPK_DOCUMENT_REFUSAL_PREFIX)).toBe(true);
  expect(() => summarizeJpkV7m({ issuedInvoices, expenses: [] })).toThrow(komunikat);
  expect(vatMiesiaca({ sprzedaz: issuedInvoices, koszty: [] }, 0)).toEqual({ ok: false, brak: komunikat });
  expect(komunikat).toMatch(/JPK_V7M za ten miesiąc trzeba przygotować poza FaktWay/);
  return komunikat;
}

const zmien = (nazwa: string, o: Partial<InvoiceLine>) => (przed: InvoiceLine[]) =>
  przed.map((l) => (l.name === nazwa ? { ...l, ...o } : l));
const usun = (nazwa: string) => (przed: InvoiceLine[]) => przed.filter((l) => l.name !== nazwa);
const SZKOLENIE: InvoiceLine = { name: 'Szkolenie', unit: 'usł.', quantity: 1, unitPriceNet: 300, vatRate: '23' };

describe('JPK_V7M(3): GTU wiersza korekty „przed/po” = kody pozycji, których dotyczy', () => {
  it('zmiana ceny pozycji z GTU_12: wiersz korekty GTU_12=1, te same kody co w pliku FA(3) KOR; kwoty jak bez GTU; XSD i strażnik bez uwag', async () => {
    faktura([DORADZTWO, DOJAZD, LEK]);
    const kor = await korekta({ correctionType: 'before_after', po: zmien('Doradztwo', { unitPriceNet: 900 }) });
    expect(await wierszKorekty(kor)).toEqual(['GTU_12=1']);
    expect(gtuPlikuKorekty(kor)).toEqual(['GTU_12']);
    // Oznaczenie nie zmienia kwot: ten sam plik bez GTU faktury korygowanej.
    const issued = await dane();
    const bez = issued.map((inv) => ({ ...inv, correctedInvoiceGtu: undefined }));
    expect(bezGtu(generateJpkV7m(plik(issued)))).toBe(generateJpkV7m(plik(bez)));
  });

  it('zmiana tylko pozycji bez GTU: wiersz korekty bez oznaczeń (MF, pyt. 8)', async () => {
    faktura([DORADZTWO, DOJAZD, LEK]);
    const kor = await korekta({ correctionType: 'before_after', po: zmien('Dojazd', { quantity: 2 }) });
    expect(await wierszKorekty(kor)).toEqual([]);
    expect(gtuPlikuKorekty(kor)).toEqual([]);
  });

  it('usunięcie pozycji z GTU_09 i zmiana pozycji z GTU_12: oba kody w kolejności XSD', async () => {
    faktura([DORADZTWO, DOJAZD, LEK]);
    const kor = await korekta({ correctionType: 'before_after', po: (przed) => zmien('Doradztwo', { quantity: 2 })(usun('Lek')(przed)) });
    expect(await wierszKorekty(kor)).toEqual(['GTU_09=1', 'GTU_12=1']);
    expect(gtuPlikuKorekty(kor)).toEqual(['GTU_09', 'GTU_12']);
  });

  it('dopisana pozycja do faktury z GTU: odmowa z numerem korekty, faktury i kodami, z wyjściem, w pliku i w module VAT', async () => {
    faktura([DORADZTWO, DOJAZD]);
    const kor = await korekta({ correctionType: 'before_after', po: (przed) => [...przed, SZKOLENIE] });
    const komunikat = await odmowa();
    expect(komunikat).toContain(`faktura ${numer(kor)}`);
    expect(komunikat).toContain('FV/1/10/2026');
    expect(komunikat).toContain('GTU_12');
    expect(komunikat).toMatch(/dopisuje pozycję/);
  });

  it('zmiana nazwy pozycji faktury z GTU (para po kolejności): ta sama odmowa co przy pozycji dopisanej; „po” w pliku FA(3) bez kodu', async () => {
    faktura([DORADZTWO, DOJAZD]);
    const kor = await korekta({ correctionType: 'before_after', po: zmien('Doradztwo', { name: 'Doradztwo podatkowe' }) });
    expect(gtuPlikuKorekty(kor)).toEqual(['GTU_12']);
    expect(koperta(kor).linesAfter?.find((l) => l.name === 'Doradztwo podatkowe')?.gtuCode).toBeUndefined();
    expect(await odmowa()).toMatch(/dopisuje pozycję albo zmienia nazwę pozycji/);
  });

  it('dopisana pozycja do faktury bez GTU: wiersz bez oznaczeń, jak dotąd (pytanie do księgowej w RP-JPK-GTU-01)', async () => {
    faktura([DOJAZD]);
    const kor = await korekta({ correctionType: 'before_after', po: (przed) => [...przed, SZKOLENIE] });
    expect(await wierszKorekty(kor)).toEqual([]);
  });
});

describe('JPK_V7M(3): GTU wiersza anulowania i korekty kwotowej', () => {
  it('anulowanie dotyczy wszystkich pozycji: GTU_09=1 i GTU_12=1, jak w pliku FA(3) KOR', async () => {
    faktura([DORADZTWO, DOJAZD, LEK]);
    const kor = await korekta({ correctionType: 'cancellation' });
    expect(await wierszKorekty(kor)).toEqual(['GTU_09=1', 'GTU_12=1']);
    expect(gtuPlikuKorekty(kor)).toEqual(['GTU_09', 'GTU_12']);
  });

  it('kwotowa w stawce 8%, w której jedyna pozycja ma GTU_09: GTU_09=1', async () => {
    faktura([DORADZTWO, DOJAZD, LEK]);
    const kor = await korekta({ correctionType: 'amount_change', amountChange: { netDelta: -100, vatDelta: -8, grossDelta: -108, description: 'Rabat na lek' } });
    expect(await wierszKorekty(kor)).toEqual(['GTU_09=1']);
  });

  it('kwotowa w stawce, w której wszystkie pozycje mają GTU_12: GTU_12=1; w stawce bez GTU: bez oznaczeń', async () => {
    faktura([DORADZTWO, pozycja({ name: 'Konsultacja', unitPriceNet: 400, gtuCode: 'GTU_12' }), pozycja({ name: 'Bilet', unitPriceNet: 80, vatRate: '8' })]);
    const kor = await korekta({ correctionType: 'amount_change', amountChange: { netDelta: -100, vatDelta: -23, grossDelta: -123, description: 'Rabat' } });
    expect(await wierszKorekty(kor)).toEqual(['GTU_12=1']);

    db.tables.invoices = db.tables.invoices!.filter((w) => w.invoice_kind !== 'correction');
    const kor8 = await korekta({ correctionType: 'amount_change', amountChange: { netDelta: -10, vatDelta: -0.8, grossDelta: -10.8, description: 'Rabat na bilet' } });
    expect(await wierszKorekty(kor8)).toEqual([]);
  });

  it('kwotowa w stawce bez pozycji w stanie przed faktury z GTU (koperta sprzed F12-D2 albo nieświeży stan przed): odmowa z numerem i wyjściem', async () => {
    faktura([DORADZTWO, DOJAZD, LEK]);
    const kor = await korekta({ correctionType: 'amount_change', amountChange: { netDelta: -100, vatDelta: -8, grossDelta: -108, description: 'Rabat na lek' } });
    // Stan przed bez pozycji w stawce 8 %: FaktWay nie wie, których pozycji korekta dotyczy.
    const data = koperta(kor) as unknown as Row;
    data.linesBefore = (data.linesBefore as Row[]).filter((l) => l.vatRate !== '8');
    const komunikat = await odmowa();
    expect(komunikat).toContain(`faktura ${numer(kor)}`);
    expect(komunikat).toContain('FV/1/10/2026');
    expect(komunikat).toMatch(/FaktWay nie zna oznaczeń GTU pozycji/);
  });

  it('kwotowa w stawce z pozycją z GTU_12 i pozycją bez GTU: odmowa „kwotowa”, z drogą przez korektę pozycji', async () => {
    faktura([DORADZTWO, DOJAZD, LEK]);
    const kor = await korekta({ correctionType: 'amount_change', amountChange: { netDelta: -100, vatDelta: -23, grossDelta: -123, description: 'Rabat' } });
    const komunikat = await odmowa();
    expect(komunikat).toContain(`faktura ${numer(kor)}`);
    expect(komunikat).toContain('korektą kwotową faktury FV/1/10/2026 w stawce 23%');
    expect(komunikat).toContain('GTU_12');
    expect(komunikat).toMatch(/korektę pozycji \(„przed \/ po”\)/);
  });
});

describe('JPK_V7M(3): korekta, której oznaczeń FaktWay nie zna', () => {
  /** Koperta i dokument korekty bez kodów, tak jak zapisywała je korekta przed częścią 2b-3. */
  function bezKodow(row: Row): void {
    const strip = (lines: unknown) =>
      Array.isArray(lines) ? lines.map(({ pkwiuCode: _p, gtuCode: _g, ...l }: Row) => l) : lines;
    const data = koperta(row) as unknown as Row;
    data.linesBefore = strip(data.linesBefore);
    data.linesAfter = strip(data.linesAfter);
    (row.fa3_data as Row).lines = strip((row.fa3_data as Row).lines);
  }

  it('korekta sprzed zapisu kodów (koperta bez kodów) pozycji z GTU: odmowa z numerem korekty, faktury i kodami', async () => {
    faktura([DORADZTWO, DOJAZD]);
    const kor = await korekta({ correctionType: 'before_after', po: zmien('Doradztwo', { unitPriceNet: 900 }) });
    bezKodow(kor);
    const komunikat = await odmowa();
    expect(komunikat).toContain(`faktura ${numer(kor)}`);
    expect(komunikat).toContain('FV/1/10/2026');
    expect(komunikat).toContain('GTU_12');
    expect(komunikat).toMatch(/FaktWay nie zna oznaczeń GTU pozycji/);
  });

  it('korekta sprzed zapisu kodów, która dotyczy tylko pozycji bez GTU: bez oznaczeń (pozycja faktury bez GTU)', async () => {
    faktura([DORADZTWO, DOJAZD]);
    const kor = await korekta({ correctionType: 'before_after', po: zmien('Dojazd', { quantity: 3 }) });
    bezKodow(kor);
    expect(await wierszKorekty(kor)).toEqual([]);
  });

  it('łańcuch: korekta pozycji dopisanej wcześniejszą korektą faktury z GTU: odmowa; korekta pozycji z GTU w tym łańcuchu: GTU_12', async () => {
    faktura([DORADZTWO, DOJAZD]);
    // KOR1 (październik, przyjęta) dopisuje szkolenie; stan przed kolejnej korekty to jej stan po.
    await korekta({ correctionType: 'before_after', po: (przed) => [...przed, SZKOLENIE] }, '2026-10-20');
    const kor2 = await korekta({ correctionType: 'before_after', po: zmien('Szkolenie', { unitPriceNet: 250 }) });
    expect(koperta(kor2).linesBefore?.find((l) => l.name === 'Doradztwo')?.gtuCode).toBe('GTU_12');
    const komunikat = await odmowa();
    expect(komunikat).toContain(`faktura ${numer(kor2)}`);
    expect(komunikat).toMatch(/FaktWay nie zna oznaczeń GTU pozycji/);

    db.tables.invoices = db.tables.invoices!.filter((w) => w !== kor2);
    const kor3 = await korekta({ correctionType: 'before_after', po: zmien('Doradztwo', { unitPriceNet: 800 }) });
    expect(await wierszKorekty(kor3)).toEqual(['GTU_12=1']);
  });
});

describe('JPK_V7M(3): niezmiennik oznaczeń GTU korekty', () => {
  const STAWKI = ['23', '8'] as const;
  const pozycjaArb = fc.record({
    cena: fc.integer({ min: 1, max: 5_000 }),
    stawka: fc.constantFrom(...STAWKI),
    gtu: fc.option(fc.constantFrom(...GTU_CODES), { nil: undefined }),
    // Co korekta „przed/po” robi z pozycją: bez zmian, nowa ilość, usunięcie.
    zmiana: fc.constantFrom('bez zmian', 'ilość', 'usuń'),
  });

  it('„przed/po” i anulowanie: GTU wiersza = kody GTU w pliku FA(3) KOR (pozycje zmienione, usunięte, anulowane); odmowa tylko przy pozycji dopisanej do faktury z GTU; XSD bez uwag', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(pozycjaArb, { minLength: 1, maxLength: 4 }), fc.boolean(), fc.boolean(), async (opisy, dopisz, anuluj) => {
        if (!anuluj && !dopisz && opisy.every((o) => o.zmiana === 'bez zmian')) return;
        if (!anuluj && !dopisz && opisy.every((o) => o.zmiana === 'usuń')) return;
        ksefLicznik = 0;
        db.tables = { tenants: [{ id: T, nip: NIP, name: 'Firma testowa', address_json: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } }], invoices: [], invoice_line_items: [], expenses: [] };
        faktura(opisy.map((o, i) => pozycja({ name: `Pozycja ${i + 1}`, unitPriceNet: o.cena, vatRate: o.stawka, ...(o.gtu ? { gtuCode: o.gtu } : {}) })));

        const kor = await korekta(anuluj
          ? { correctionType: 'cancellation' }
          : {
              correctionType: 'before_after',
              po: (przed) => [
                ...przed.flatMap((l, i) => (opisy[i]!.zmiana === 'usuń' ? [] : [opisy[i]!.zmiana === 'ilość' ? { ...l, quantity: 2 } : l])),
                ...(dopisz ? [SZKOLENIE] : []),
              ],
            });

        const fakturaZGtu = opisy.some((o) => o.gtu);
        if (!anuluj && dopisz && fakturaZGtu) {
          expect(await odmowa()).toMatch(/dopisuje pozycję/);
          return;
        }
        // Wyrocznia niezależna od parowania: kody pozycji zmienionych i usuniętych (albo wszystkich przy anulowaniu).
        const dotyczy = opisy.filter((o) => anuluj || o.zmiana !== 'bez zmian');
        const oczekiwane = GTU_CODES.filter((c) => dotyczy.some((o) => o.gtu === c));
        expect(gtuPlikuKorekty(kor)).toEqual(oczekiwane);
        expect(await wierszKorekty(kor)).toEqual(oczekiwane.map((c) => `${c}=1`));
      }),
      { numRuns: 25 },
    );
  }, 600_000);
});
