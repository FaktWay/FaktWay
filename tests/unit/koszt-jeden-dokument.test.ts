import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

import { memoryClient, type MemoryTables, type Row } from './helpers/baza-w-pamieci';

/**
 * FZ-022 (R1, obszary `koszty` i `jpk.vat-fa`): ta sama faktura kosztowa ze
 * zdjęcia (OCR) i ze Skrzynki KSeF to dwa wiersze `expenses`. Runner skrzynki
 * szuka istniejącego kosztu tylko po `ksef_invoice_id`, a runner OCR nie
 * szuka wcale, więc w obu kolejnościach powstaje drugi koszt, a KPiR
 * (`getKpirData`) i JPK_V7M (`fetchInvoicesForExport`, `summarizeJpkV7m`)
 * liczyły koszt i VAT do odliczenia podwójnie.
 *
 * Niezmiennik (RP-KOSZT-01): ta sama faktura (NIP sprzedawcy, numer i rok
 * wystawienia) z KSeF i spoza KSeF to w KPiR i w JPK_V7M okresu najwyżej
 * jeden koszt, w obu kolejnościach. Odczyt okresu, w którym są oba, odmawia
 * z numerem, datą, źródłami i wyjściem (przy kopii wyłącza się „Uwzględnij
 * w KPiR”), jak KPiR modułu (F11-C1, `lib/ksiegowosc/kpir-dane.ts`). Inne
 * okresy liczą się jak dotąd; para rozdzielona na dwa okresy nie jest
 * odmową odczytu miesiąca (luka FZ-022, zamknie ją zapis). Zapis jednego
 * kosztu przy drugim źródle czeka na decyzję (FZ-022, `.fails`).
 *
 * Prawdziwa ścieżka: runnery `runProcessOcr` i `runAutoCategorizeInbox`
 * zapisują koszty w tej samej bazie w pamięci, a odczyty KPiR i JPK_V7M
 * czytają te wiersze. Atrapy tylko dla HTTP (KSeF, magazyn plików, model OCR,
 * AI kategoryzacji, NBP, push) i bazy.
 */

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '33333333-3333-4333-8333-333333333333';
const INVOICE = '11111111-1111-4111-8111-111111111111';
const OCR_JOB = '22222222-2222-4222-8222-222222222222';
const OCR_JOB_2 = '22222222-2222-4222-8222-222222222223';
const INVOICE_2 = '11111111-1111-4111-8111-111111111112';
const NR_KSEF = '5260001246-20270205-000000000007-01';
const SELLER_NIP = '5260001246';
const NUMER = 'FV/7/02/2027';
const XML_PATH = `${TENANT}/ksef-import/5260001246-20270205-000000000007-01.xml`;
// Zwykła faktura (bez `FP`), jak w tests/unit/faktura-do-paragonu-skrzynka.test.ts.
const XML = readFileSync(join(process.cwd(), 'tests/fixtures/import-wiersze/daty-pozycji-fp-gtu.xml'), 'utf8').replaceAll(
  '<FP>1</FP>',
  '',
);

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  xml: new Map<string, string>(),
  doc: {} as Record<string, unknown>,
}));

vi.mock('@/lib/ksef/inbox-xml', () => ({
  archiveInboxInvoiceXml: async () => ({ archived: false, reason: 'has-xml' }),
}));
vi.mock('@/lib/storage/r2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storage/r2')>()),
  downloadFromR2: async (key: string) => {
    const xml = state.xml.get(key);
    if (xml === undefined) throw new Error(`R2 object not found: ${key}`);
    return Buffer.from(xml, 'utf8');
  },
}));
vi.mock('@/lib/categorization', () => ({
  categorizeExpense: async () => ({ kpir_column: 'col_13', category_label: 'Usługi', method: 'rule', confidence: 0.95 }),
}));
vi.mock('@/lib/nbp/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/nbp/client')>()),
  nbpRateForCost: vi.fn(),
}));
vi.mock('@/lib/ocr/engine', () => ({
  extractInvoiceFromImage: async () => ({
    success: true,
    data: state.doc,
    modelUsed: 'atrapa-modelu',
    inputTokens: 1,
    outputTokens: 1,
    processingTimeMs: 1,
  }),
}));
vi.mock('@/lib/storage/expenses', () => ({
  downloadExpensePhoto: async () => ({ buffer: Buffer.from('x'), mimeType: 'image/jpeg' }),
}));
vi.mock('@/lib/ai/tenant-ai-budget', () => ({
  checkTenantAiBudget: async () => ({ allowed: true }),
  recordTenantAiUsage: async () => undefined,
}));
vi.mock('@/lib/push/sender', () => ({ sendPushToUser: vi.fn() }));
vi.mock('@/lib/flo/proposals', () => ({ createProposal: async () => ({ status: 'created' }) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => db() }));

const { runAutoCategorizeInbox } = await import('@/lib/jobs/runners/auto-categorize-inbox');
const { runProcessOcr } = await import('@/lib/jobs/runners/process-ocr');
const { getKpirData } = await import('@/lib/reports/kpir-data');
const { fetchInvoicesForExport } = await import('@/lib/exports/data-fetcher');
const { summarizeJpkV7m } = await import('@/lib/exports/jpk-v7m-generator');
const { getCostsWithKsefPurchases } = await import('@/lib/dashboard/costs');
const { customerErrorDetail } = await import('@/lib/dashboard/customer-error');
const { onExportsGenerateExhausted } = await import('@/lib/jobs/runners/exports-generate');
const { NonRetriableError } = await import('@/lib/jobs/errors');

/**
 * Baza w pamięci z wartościami domyślnymi kosztu (00034), osadzeniem
 * `expenses!expenses_ksef_invoice_id_fkey(id)` (pierwszy krok runnera skrzynki)
 * i RPC faktury do paragonu (00175; zwykła faktura nie ma kandydatów).
 */
function db() {
  const tables = state.tables as MemoryTables;
  const client = memoryClient(tables);
  return {
    from(table: string) {
      const q = client.from(table) as unknown as Record<string, unknown> & {
        select: (cols?: string, o?: unknown) => unknown;
        insert: (p: Row | Row[]) => unknown;
        then: (ok: (v: { data: unknown; error: unknown }) => unknown, fail?: (e: unknown) => unknown) => Promise<unknown>;
      };
      if (table === 'expenses') {
        const insert = q.insert;
        // Kolumny bez wartości w insercie mają w bazie NULL albo wartość domyślną z 00034.
        const withDefaults = (r: Row): Row => ({ is_deductible: true, is_reviewed: false, document_type: 'invoice', ksef_invoice_id: null, ...r });
        q.insert = (p: Row | Row[]) => insert(Array.isArray(p) ? p.map(withDefaults) : withDefaults(p));
      }
      if (table !== 'invoices') return q;
      const select = q.select;
      const then = q.then;
      let embed = false;
      q.select = (cols?: string, o?: unknown) => {
        embed = Boolean(cols?.includes('expenses!expenses_ksef_invoice_id_fkey'));
        return select(cols, o);
      };
      q.then = (ok, fail) =>
        then((res) => {
          if (embed && res.data && !Array.isArray(res.data)) {
            const invoice = res.data as Row;
            const linked = (tables.expenses ?? []).filter((e) => e.ksef_invoice_id === invoice.id).map((e) => ({ id: e.id }));
            return ok({ ...res, data: { ...invoice, expenses: linked } });
          }
          return ok(res);
        }, fail);
      return q;
    },
    async rpc(name: string) {
      if (name === 'match_receipt_to_ksef_invoice') return { data: 'no_candidates', error: null };
      return { data: null, error: { message: `unknown rpc ${name}` } };
    },
  };
}

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

/** Faktura zakupu tak, jak zapisuje ją odbiór skrzynki (`inbox-polling.ts`), z XML w archiwum. */
function fakturaZSkrzynki(o: Row = {}): Row {
  return {
    id: INVOICE,
    tenant_id: TENANT,
    direction: 'incoming',
    origin: 'ksef_inbox',
    ksef_status: 'accepted',
    ksef_environment: 'test',
    ksef_number: NR_KSEF,
    internal_number: NUMER,
    issue_date: '2027-02-05',
    currency: 'PLN',
    seller_data: null,
    seller_nip: SELLER_NIP,
    gross_total: 123,
    net_total: 100,
    vat_total: 23,
    xml_storage_path: XML_PATH,
    fa3_data: { _source: 'inbox-metadata', _pendingFullFetch: true, seller: { name: 'Sklep Przykład', nip: SELLER_NIP } },
    ...o,
  };
}

/** Odczyt zdjęcia tej samej faktury (schemat OCR: NIP z 10 cyfr), numer małymi literami i ze spacją na końcu. */
function zdjecieFaktury(o: Row = {}): Row {
  return {
    seller_name: 'Sklep Przykład',
    seller_nip: SELLER_NIP,
    seller_address: null,
    document_number: 'fv/7/02/2027 ',
    document_type: 'invoice',
    issue_date: '2027-02-05',
    currency: 'PLN',
    net_amount: 100,
    vat_amount: 23,
    gross_amount: 123,
    vat_rate: '23',
    line_items: null,
    ocr_confidence: 0.95,
    notes: null,
    ...o,
  };
}

function baza(faktury: Row[] = [fakturaZSkrzynki()]) {
  const zadanie = (id: string) => ({
    id, tenant_id: TENANT, created_by: USER, source_file_path: `${TENANT}/expenses/${id}.jpg`, source_file_mime: 'image/jpeg', status: 'pending', extracted_data: null,
  });
  state.tables = {
    tenants: [{ id: TENANT, nip: '1234567890', name: 'Moja Firma', address_json: null, vat_exemption_basis: null }],
    memberships: [{ organization_id: TENANT, user_id: USER, role: 'owner', status: 'active' }],
    invoices: faktury,
    invoice_line_items: [],
    expenses: [],
    expense_receipt_matches: [],
    ocr_jobs: [zadanie(OCR_JOB), zadanie(OCR_JOB_2)],
    categorization_rules: [],
    kpir_global_rules: [],
    flo_proposals: [],
    audit_logs: [],
  };
  state.xml.clear();
  for (const f of faktury) if (typeof f.xml_storage_path === 'string') state.xml.set(f.xml_storage_path, XML);
}

const zdjecie = async (doc: Row = zdjecieFaktury(), zadanie = OCR_JOB) => {
  state.doc = doc;
  await runProcessOcr({ ocrJobId: zadanie, tenantId: TENANT }, ctx);
};
const skrzynka = (invoiceId = INVOICE) => runAutoCategorizeInbox({ invoiceId, tenantId: TENANT, environment: 'test' }, ctx);
const koszty = () => (state.tables as MemoryTables).expenses!;
const kluczNumeru = (numer: unknown) => String(numer ?? '').replace(/\s+/g, '').toUpperCase();
const LUTY = { month: '2', year: '2027', od: '2027-02-01', do: '2027-02-28' };
const STYCZEN = { month: '1', year: '2027', od: '2027-01-01', do: '2027-01-31' };

/** KPiR i zakupy JPK_V7M okresu z tych samych wierszy; odmowa zamiast kwot, gdy odczyt odmawia. */
async function odczyty(okres = LUTY, numer = NUMER) {
  const kpir = await getKpirData(db() as never, TENANT, { month: okres.month, year: okres.year }, new Date('2027-02-20T12:00:00Z'));
  const wKpir = kpir.expenses.filter((e) => kluczNumeru(e.document_number) === numer).length;
  let jpk: { odmowa: null; wJpk: number; vatDoOdliczenia: number; nrKsef: Array<string | null> } | { odmowa: string };
  try {
    const dane = await fetchInvoicesForExport(
      { tenantId: TENANT, periodStart: okres.od, periodEnd: okres.do, direction: 'issued', includeCorrections: true, includeExpenses: true },
      db() as never,
    );
    const suma = summarizeJpkV7m({ issuedInvoices: [], expenses: dane.expenses });
    const tego = dane.expenses.filter((e) => kluczNumeru(e.documentNumber) === numer);
    jpk = { odmowa: null, wJpk: tego.length, vatDoOdliczenia: suma.vatDeductible, nrKsef: tego.map((e) => e.ksefNumber ?? null) };
  } catch (e) {
    jpk = { odmowa: e instanceof Error ? e.message : String(e) };
  }
  return { kpirOdmowa: kpir.currencyBlocked, wKpir, jpk };
}

const KOLEJNOSCI = [
  ['zdjęcie, potem Skrzynka', async () => { await zdjecie(); await skrzynka(); }],
  ['Skrzynka, potem zdjęcie', async () => { await skrzynka(); await zdjecie(); }],
] as const;

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
});
afterEach(() => vi.unstubAllEnvs());

describe('FZ-022: ta sama faktura ze zdjęcia i ze Skrzynki KSeF', () => {
  it.each(KOLEJNOSCI)('%s: KPiR i JPK_V7M okresu nie liczą faktury dwa razy (jeden koszt albo odmowa z numerem)', async (_kolejnosc, przebieg) => {
    baza();
    await przebieg();
    // Oba źródła doszły do bazy: dokument jest w kosztach (stan sprzed decyzji o zapisie).
    expect(koszty().map((e) => e.source).sort()).toEqual(['ksef_inbox', 'ocr_photo']);

    const { kpirOdmowa, wKpir, jpk } = await odczyty();
    if (kpirOdmowa === null) expect(wKpir).toBeLessThanOrEqual(1);
    else expect(kpirOdmowa).toContain(NUMER);
    if (jpk.odmowa === null) expect(jpk.wJpk).toBeLessThanOrEqual(1);
    else expect(jpk.odmowa).toContain(NUMER);
  });

  it('odmowa podaje numer, datę i oba źródła, bez nazwy sprzedawcy', async () => {
    baza();
    await zdjecie();
    await skrzynka();
    const { kpirOdmowa, jpk } = await odczyty();
    for (const odmowa of [kpirOdmowa, jpk.odmowa]) {
      expect(odmowa).toContain(`${NUMER} z 05.02.2027 (2 razy: ze Skrzynki KSeF i ze zdjęcia)`);
      expect(odmowa).not.toContain('Sklep Przykład');
    }
  });

  it('wyjście z odmowy: koszt ze zdjęcia poza KPiR, a KPiR i JPK_V7M liczą raz koszt z KSeF z numerem KSeF', async () => {
    baza();
    await zdjecie();
    await skrzynka();
    koszty().find((e) => e.source === 'ocr_photo')!.is_deductible = false;

    const { kpirOdmowa, wKpir, jpk } = await odczyty();
    expect(kpirOdmowa).toBeNull();
    expect(wKpir).toBe(1);
    expect(jpk).toEqual({ odmowa: null, wJpk: 1, vatDoOdliczenia: 23, nrKsef: [NR_KSEF] });
  });

  it('dubel z lutego nie zatrzymuje stycznia: raport KPiR i eksport za styczeń liczą się jak dotąd', async () => {
    baza();
    await zdjecie();
    await skrzynka();
    const styczen = await odczyty(STYCZEN);
    expect(styczen).toEqual({ kpirOdmowa: null, wKpir: 0, jpk: { odmowa: null, wJpk: 0, vatDoOdliczenia: 0, nrKsef: [] } });
  });

  it('karty kosztów Pulpitu, Przepływów i Analiz: ta sama odmowa z numerem, którą klient widzi na karcie', async () => {
    baza();
    await zdjecie();
    await skrzynka();
    const blad = await getCostsWithKsefPurchases(db() as never, TENANT, { from: '2027-02-01', toExclusive: '2027-03-01' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(blad).toBeInstanceOf(Error);
    expect(customerErrorDetail(blad)).toBe((blad as Error).message);
    expect((blad as Error).message).toContain(NUMER);
    expect((blad as Error).message).toContain('Uwzględnij w KPiR');
  });

  it('eksport w Centrum eksportu: odmowa zostaje w historii z treścią (numer i wyjście), nie jako błąd ogólny', async () => {
    baza();
    await zdjecie();
    await skrzynka();
    const { jpk } = await odczyty();
    const odmowa = jpk.odmowa ?? '';
    (state.tables as MemoryTables).export_jobs = [{ id: 'eksport-1', tenant_id: TENANT, status: 'generating', error_message: null }];
    await onExportsGenerateExhausted(new NonRetriableError(odmowa), { exportJobId: 'eksport-1' });
    expect((state.tables as MemoryTables).export_jobs![0]).toMatchObject({ status: 'failed', error_message: odmowa });
    expect(odmowa).toContain(NUMER);
  });
});

describe('FZ-022: bez odmowy, gdy to nie ten sam dokument', () => {
  it.each([
    ['inny NIP sprzedawcy', { seller_nip: '1111111111' }],
    ['inny numer', { document_number: 'FV/8/02/2027' }],
    ['bez NIP-u (np. sprzedawca zagraniczny)', { seller_nip: null }],
  ])('zdjęcie innego dokumentu (%s) i faktura z KSeF: dwa koszty', async (_nazwa, zmiana) => {
    baza();
    await zdjecie(zdjecieFaktury(zmiana));
    await skrzynka();

    const { kpirOdmowa, jpk } = await odczyty();
    expect(kpirOdmowa).toBeNull();
    expect(jpk.odmowa).toBeNull();
    const dane = await fetchInvoicesForExport(
      { tenantId: TENANT, periodStart: '2027-02-01', periodEnd: '2027-02-28', direction: 'issued', includeCorrections: true, includeExpenses: true },
      db() as never,
    );
    expect(dane.expenses).toHaveLength(2);
  });

  it('ten sam NIP i numer w innym roku (numeracja od nowa co rok): dwie faktury, bez odmowy także w odczycie obu lat', async () => {
    baza([fakturaZSkrzynki({ internal_number: '15', ksef_number: '5260001246-20270205-000000000015-01' })]);
    await zdjecie(zdjecieFaktury({ document_number: '15', issue_date: '2026-12-15' }));
    await skrzynka();
    const dane = await fetchInvoicesForExport(
      { tenantId: TENANT, periodStart: '2026-12-01', periodEnd: '2027-02-28', direction: 'issued', includeCorrections: true, includeExpenses: true },
      db() as never,
    );
    expect(dane.expenses.map((e) => e.documentNumber).sort()).toEqual(['15', '15']);
    const karty = await getCostsWithKsefPurchases(db() as never, TENANT, { from: '2026-12-01', toExclusive: '2027-03-01' });
    expect(karty.filter((k) => k.documentNumber === '15')).toHaveLength(2);
  });

  it('dwie faktury z KSeF z tym samym numerem (np. faktura i korekta): dla KSeF to dwa dokumenty, bez odmowy', async () => {
    baza([fakturaZSkrzynki(), fakturaZSkrzynki({ id: INVOICE_2, ksef_number: '5260001246-20270206-000000000008-01', xml_storage_path: null })]);
    await skrzynka();
    await skrzynka(INVOICE_2);
    expect(koszty().filter((e) => e.source === 'ksef_inbox')).toHaveLength(2);
    const { kpirOdmowa, jpk } = await odczyty();
    expect(kpirOdmowa).toBeNull();
    expect(jpk).toMatchObject({ odmowa: null, wJpk: 2 });
  });

  it('jedna faktura rozpisana na dwa koszty spoza KSeF z różnymi kwotami (np. dwie kolumny KPiR): bez odmowy', async () => {
    baza([]);
    await zdjecie(zdjecieFaktury({ net_amount: 60, vat_amount: 13.8, gross_amount: 73.8 }));
    await zdjecie(zdjecieFaktury({ net_amount: 40, vat_amount: 9.2, gross_amount: 49.2 }), OCR_JOB_2);
    const { kpirOdmowa, wKpir, jpk } = await odczyty();
    expect(kpirOdmowa).toBeNull();
    expect(wKpir).toBe(2);
    expect(jpk).toMatchObject({ odmowa: null, wJpk: 2 });
  });

  it('to samo zdjęcie wgrane dwa razy (te same kwoty): odmowa z wyjściem przy jednym z nich', async () => {
    baza([]);
    await zdjecie();
    await zdjecie(zdjecieFaktury(), OCR_JOB_2);
    const { kpirOdmowa, jpk } = await odczyty();
    // Bez kosztu z KSeF numer jest taki, jak go odczytało zdjęcie.
    expect(kpirOdmowa).toContain('fv/7/02/2027 z 05.02.2027 (2 razy: ze zdjęcia)');
    expect(kpirOdmowa).toContain('przy pozostałych wyłącza się w Kosztach');
    expect(jpk.odmowa).toContain('fv/7/02/2027');
  });
});

describe('FZ-022: zapis jednego kosztu przy drugim źródle (decyzja Bartosza)', () => {
  // Cel zapisu niezależny od wariantu „połącz sam” i „czekaj na przegląd”: jeden
  // koszt w KPiR i JPK, z numerem KSeF (JPK_V7M(3) wymaga NrKSeF), bez odmowy.
  // Przy decyzji „zostać przy odmowie” ten test się usuwa, a FZ-022 zamyka.
  it.fails.each(KOLEJNOSCI)('%s: jeden koszt z numerem KSeF w KPiR i JPK_V7M, bez odmowy (FZ-022)', async (_kolejnosc, przebieg) => {
    baza();
    await przebieg();
    const { kpirOdmowa, wKpir, jpk } = await odczyty();
    expect(kpirOdmowa).toBeNull();
    expect(wKpir).toBe(1);
    expect(jpk).toEqual({ odmowa: null, wJpk: 1, vatDoOdliczenia: 23, nrKsef: [NR_KSEF] });
  });
});
