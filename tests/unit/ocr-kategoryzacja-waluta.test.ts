import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

/**
 * Kategoria kosztu w walucie obcej z joba OCR (R1, obszar `koszty`).
 *
 * Przed tą naprawą job OCR podawał klasyfikatorowi kwoty w walucie dokumentu,
 * choć kilka linii wcześniej miał już złote po kursie NBP. Widełki reguły
 * firmy (`min_amount`/`max_amount`, w złotych) i prompt modelu
 * (`kwota_brutto_pln`) oceniały więc 100 EUR jak 100 zł. Suma kosztów w KPiR
 * się zgadzała, ale kolumna i kategoria mogły przyjść z reguły, która przy tej
 * kwocie w złotych nie obowiązuje (albo reguła pasująca nie działała). Job
 * skrzynki KSeF przelicza kwoty przed kategoryzacją
 * (`lib/jobs/runners/auto-categorize-inbox.ts`).
 *
 * Niezmiennik: klasyfikator ocenia tę samą kwotę w złotych, która trafia do
 * wydatku (`expenses.gross_amount`). Bez kursu kwoty w złotych nie ma, więc
 * klasyfikator nie rozstrzyga (jak w skrzynce): kategoria do weryfikacji,
 * a karta FLO prosi o kwotę w złotych.
 *
 * Prawdziwa ścieżka: `runProcessOcr` z prawdziwym `categorizeExpense`
 * (reguły NIP i nazwy, słowa kluczowe, heurystyki, model) i prawdziwym
 * strażnikiem członkostwa. Atrapy tylko dla bazy (tabele w pamięci, filtry
 * jak w PostgREST) i HTTP (NBP, Anthropic, magazyn plików, powiadomienia).
 */

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OCR_JOB = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const RULE_ID = '44444444-4444-4444-8444-444444444444';
/** Fikcyjny NIP testowy (AGENTS.md, „KSeF-specific”). */
const NIP = '1234567890';
const ISSUE_DATE = '2026-09-28';

const st = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  type Filter = { op: 'eq' | 'gt' | 'notNull'; column: string; value?: unknown };

  const tables: Record<string, Row[]> = {};
  const inserts: Row[] = [];
  const updates: { table: string; values: Row }[] = [];

  /** Zapytanie supabase-js na tabelach w pamięci: tyle, ile używa ta ścieżka. */
  function from(table: string) {
    const filters: Filter[] = [];
    let action: 'select' | 'insert' | 'update' = 'select';
    let values: Row = {};
    let max: number | null = null;
    let byId = false;

    const matching = (): Row[] => {
      const rows = (tables[table] ?? []).filter((row) =>
        filters.every((f) => {
          if (f.op === 'eq') return row[f.column] === f.value;
          if (f.op === 'gt') return String(row[f.column]) > String(f.value);
          return row[f.column] !== null && row[f.column] !== undefined;
        }),
      );
      if (byId) rows.sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
      return max === null ? rows : rows.slice(0, max);
    };
    const settle = (): { data: Row[] | null; error: null } => {
      if (action === 'update') {
        updates.push({ table, values });
        return { data: null, error: null };
      }
      return { data: action === 'insert' ? null : matching(), error: null };
    };

    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => {
        filters.push({ op: 'eq', column, value });
        return query;
      },
      gt: (column: string, value: unknown) => {
        filters.push({ op: 'gt', column, value });
        return query;
      },
      not: (column: string, operator: string, value: unknown) => {
        if (operator !== 'is' || value !== null) {
          throw new Error(`atrapa bazy: nieobsłużone not(${column}, ${operator})`);
        }
        filters.push({ op: 'notNull', column });
        return query;
      },
      order: (column: string) => {
        byId = column === 'id';
        return query;
      },
      limit: (n: number) => {
        max = n;
        return query;
      },
      insert: (row: Row) => {
        action = 'insert';
        if (table === 'expenses') inserts.push(row);
        return query;
      },
      update: (patch: Row) => {
        action = 'update';
        values = patch;
        return query;
      },
      single: async () => {
        if (action === 'insert') return { data: { id: 'exp-1' }, error: null };
        const rows = matching();
        return rows.length === 1
          ? { data: rows[0], error: null }
          : { data: null, error: { message: `atrapa bazy: ${rows.length} wierszy w ${table}` } };
      },
      maybeSingle: async () => {
        const { data } = settle();
        if (data === null) return { data: null, error: null };
        return data.length > 1
          ? { data: null, error: { message: `atrapa bazy: ${data.length} wierszy w ${table}` } }
          : { data: data[0] ?? null, error: null };
      },
      then: (ok: (value: unknown) => unknown, fail?: (reason: unknown) => unknown) =>
        Promise.resolve(settle()).then(ok, fail),
    };
    return query;
  }

  return {
    tables,
    inserts,
    updates,
    from,
    doc: {} as Row,
    nbp: vi.fn(),
    ai: vi.fn(),
    budget: vi.fn(),
    proposals: vi.fn(),
  };
});

// Baza: budżet AI firmy (AUD-107) w limicie; test liczy, o co job pytał.
vi.mock('@/lib/ai/tenant-ai-budget', () => ({
  checkTenantAiBudget: st.budget,
  recordTenantAiUsage: async () => undefined,
}));
// HTTP: odczyt zdjęcia modelem oddaje gotowy dokument.
vi.mock('@/lib/ocr/engine', () => ({
  extractInvoiceFromImage: async () => ({
    success: true,
    data: st.doc,
    modelUsed: 'atrapa-modelu',
    inputTokens: 1,
    outputTokens: 1,
    processingTimeMs: 1,
  }),
}));
// HTTP: kurs NBP bez sieci.
vi.mock('@/lib/nbp/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/nbp/client')>()),
  nbpRateForCost: st.nbp,
}));
// HTTP: wywołanie modelu w klasyfikatorze kosztów (`classifyByAI`).
vi.mock('@/lib/anthropic/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/anthropic/client')>()),
  getAnthropic: () => ({ messages: { create: st.ai } }),
}));
// HTTP: zdjęcie z magazynu plików i powiadomienie push.
vi.mock('@/lib/storage/expenses', () => ({
  downloadExpensePhoto: async () => ({ buffer: Buffer.from('x'), mimeType: 'image/jpeg' }),
}));
vi.mock('@/lib/push/sender', () => ({ sendPushToUser: vi.fn() }));
// Baza: zapis karty FLO (test czyta, z czym job ją tworzy).
vi.mock('@/lib/flo/proposals', () => ({ createProposal: st.proposals }));
// Baza: odczyty i zapisy joba, klasyfikatora i strażnika członkostwa.
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: st.from }) }));

import { runProcessOcr } from '@/lib/jobs/runners/process-ocr';
import { costInPln } from '@/lib/ocr/currency';

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

const run = () => runProcessOcr({ ocrJobId: OCR_JOB, tenantId: TENANT }, ctx);

/** Faktura od kontrahenta, którego nie łapie żadna heurystyka ani słowo kluczowe. */
function dokument(currency: string, gross: number): Record<string, unknown> {
  return {
    seller_name: 'Kontrahent Testowy Sp. z o.o.',
    seller_nip: NIP,
    seller_address: null,
    document_number: 'FV/2026/09/17',
    document_type: 'invoice',
    issue_date: ISSUE_DATE,
    currency,
    net_amount: gross,
    vat_amount: 0,
    gross_amount: gross,
    vat_rate: 'np',
    line_items: null,
    ocr_confidence: 0.95,
    notes: null,
  };
}

function kursNbp(currency: string, mid: number) {
  return {
    found: true as const,
    rate: { currency, mid, tableNo: '188/A/NBP/2026', effectiveDate: '2026-09-25' },
    gapDays: 3,
  };
}

/** Kwota brutto w złotych, jaką liczy job (`costInPln`) i zapisuje w wydatku. */
function zlote(currency: string, gross: number, mid: number): number {
  const cost = costInPln(
    { currency, net_amount: gross, vat_amount: 0, gross_amount: gross },
    ISSUE_DATE,
    kursNbp(currency, mid),
  );
  if (cost.kind !== 'pln') throw new Error('atrapa kursu: kwota nieprzeliczona');
  return cost.gross;
}

/** Reguła firmy po NIP z widełkami w złotych (migracja 00063). */
function regulaNip(widelki: { min_amount: number | null; max_amount: number | null }) {
  return {
    id: RULE_ID,
    tenant_id: TENANT,
    match_type: 'nip',
    match_value: NIP,
    hit_count: 3,
    kpir_column: 'col_10',
    category_label: 'Towary handlowe',
    ...widelki,
  };
}

/** Jedyny wydatek zapisany przez job. */
function wydatek(): Record<string, unknown> {
  expect(st.inserts).toHaveLength(1);
  return st.inserts[0]!;
}

/** Blok danych faktury z promptu klasyfikatora (`wrapAsData`: jedna linia JSON). */
function daneDlaModelu(): Record<string, unknown> {
  expect(st.ai).toHaveBeenCalledTimes(1);
  const params = st.ai.mock.calls[0]![0] as { messages: { content: string }[] };
  const line = params.messages[0]!.content.split('\n').find((l) => l.startsWith('{"sprzedawca"'));
  if (!line) throw new Error('brak bloku danych faktury w prompcie klasyfikatora');
  return JSON.parse(line) as Record<string, unknown>;
}

/** Zapisy „reguła użyta” (`hit_count`): reguła rozstrzygnęła kategorię. */
const uzyciaReguly = () => st.updates.filter((u) => u.table === 'categorization_rules');

beforeEach(() => {
  Object.assign(st.tables, {
    ocr_jobs: [
      {
        id: OCR_JOB,
        tenant_id: TENANT,
        created_by: USER,
        source_file_path: 'r2/paragon.jpg',
        source_file_mime: 'image/jpeg',
        extracted_data: null,
      },
    ],
    memberships: [{ user_id: USER, organization_id: TENANT, status: 'active' }],
    tenants: [{ id: TENANT, vat_exemption_basis: null }],
    expenses: [],
    categorization_rules: [],
    kpir_global_rules: [],
    flo_proposals: [],
  });
  st.inserts.length = 0;
  st.updates.length = 0;
  st.doc = dokument('PLN', 123);
  st.nbp.mockReset();
  st.ai.mockReset().mockResolvedValue({
    content: [{ type: 'text', text: '{"kpir_column":"col_13","category_label":"Usługi obce","reasoning":"atrapa"}' }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  st.budget.mockReset().mockResolvedValue({ allowed: true });
  st.proposals.mockReset().mockResolvedValue({ status: 'created' });
});

/** Waluta, kwota brutto w walucie dokumentu, kurs średni NBP. */
const PRZYPADKI: ReadonlyArray<readonly [string, number, number]> = [
  ['EUR', 100, 4.2567], // 425,67 zł
  ['USD', 250, 3.9876], // 996,90 zł
  ['GBP', 80, 5.1234], // 409,87 zł
  ['HUF', 50_000, 0.010912], // 545,60 zł: liczba forintów większa niż kwota w złotych
];

describe('job OCR: kategoria kosztu w walucie obcej liczona od kwoty w złotych', () => {
  it.each(PRZYPADKI)(
    '%s %d: reguła NIP z widełkami równymi kwocie w złotych stosuje się',
    async (waluta, kwota, mid) => {
      const pln = zlote(waluta, kwota, mid);
      st.tables.categorization_rules = [regulaNip({ min_amount: pln, max_amount: pln })];
      st.doc = dokument(waluta, kwota);
      st.nbp.mockResolvedValue(kursNbp(waluta, mid));

      await run();

      expect(wydatek()).toMatchObject({
        gross_amount: pln,
        kpir_column: 'col_10',
        category_label: 'Towary handlowe',
        categorization_method: 'learned',
      });
      expect(uzyciaReguly()).toHaveLength(1);
      expect(st.ai).not.toHaveBeenCalled();
    },
  );

  it.each(PRZYPADKI)(
    '%s %d: reguła NIP z górną granicą grosz poniżej kwoty w złotych nie stosuje się',
    async (waluta, kwota, mid) => {
      const pln = zlote(waluta, kwota, mid);
      st.tables.categorization_rules = [
        regulaNip({ min_amount: null, max_amount: Math.round(pln * 100 - 1) / 100 }),
      ];
      st.doc = dokument(waluta, kwota);
      st.nbp.mockResolvedValue(kursNbp(waluta, mid));

      await run();

      expect(wydatek()).toMatchObject({
        gross_amount: pln,
        kpir_column: 'col_13',
        category_label: 'Usługi obce',
        categorization_method: 'ai_claude',
      });
      expect(uzyciaReguly()).toEqual([]);
    },
  );

  it.each(PRZYPADKI)(
    '%s %d: model dostaje jako kwota_brutto_pln kwotę zapisaną w wydatku',
    async (waluta, kwota, mid) => {
      st.doc = dokument(waluta, kwota);
      st.nbp.mockResolvedValue(kursNbp(waluta, mid));

      await run();

      expect(wydatek().gross_amount).toBe(zlote(waluta, kwota, mid));
      expect(daneDlaModelu().kwota_brutto_pln).toBe(wydatek().gross_amount);
    },
  );
});

describe('job OCR: koszt w walucie obcej bez kursu NBP', () => {
  beforeEach(() => {
    st.doc = dokument('EUR', 100);
    st.nbp.mockResolvedValue({ found: false, reason: 'no_table_before' });
  });

  it('reguła z widełkami w złotych nie rozstrzyga na kwocie w walucie dokumentu', async () => {
    // 100 mieści się w „do 300 zł” tylko jako liczba; 100 EUR to ok. 430 zł.
    st.tables.categorization_rules = [regulaNip({ min_amount: null, max_amount: 300 })];

    await run();

    expect(wydatek()).toMatchObject({
      gross_amount: 100,
      is_deductible: false,
      kpir_column: 'col_13',
      category_label: 'Do weryfikacji waluty',
      categorization_method: 'manual',
      categorization_confidence: 0,
    });
    expect(uzyciaReguly()).toEqual([]);
  });

  it('model nie dostaje dokumentu, a budżet AI klasyfikacji zostaje nietknięty', async () => {
    await run();

    expect(st.ai).not.toHaveBeenCalled();
    expect(st.budget).toHaveBeenCalledWith(TENANT, 'ocr');
    expect(st.budget).not.toHaveBeenCalledWith(TENANT, 'classify');
    expect(wydatek()).toMatchObject({
      category_label: 'Do weryfikacji waluty',
      categorization_method: 'manual',
    });
  });

  it('karta FLO prosi o kwotę w złotych zamiast meldować kategorię', async () => {
    await run();

    expect(st.proposals).toHaveBeenCalledTimes(1);
    const karta = st.proposals.mock.calls[0]![0] as { payload: { issues: string[] } };
    expect(karta.payload.issues[0]).toBe('missing_rate');
    expect(karta.payload).toMatchObject({ primaryIntent: 'open', primaryLabel: 'Uzupełnij kwotę w złotych' });
  });
});

describe('job OCR: koszt w złotych jak dotąd', () => {
  it.each([
    [123, 'col_10', 'learned'],
    [400, 'col_13', 'ai_claude'],
  ] as const)('%d zł przy regule do 300 zł: %s (%s)', async (brutto, kolumna, metoda) => {
    st.tables.categorization_rules = [regulaNip({ min_amount: null, max_amount: 300 })];
    st.doc = dokument('PLN', brutto);

    await run();

    expect(st.nbp).not.toHaveBeenCalled();
    expect(wydatek()).toMatchObject({ gross_amount: brutto, kpir_column: kolumna, categorization_method: metoda });
  });
});
