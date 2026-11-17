import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 3.8, część 1: koszt wpisany ręcznie (opłata bez faktury, składka,
 * zakup bez zdjęcia). Prawdziwa akcja i `createManualExpense`, atrapa tylko
 * bazy, sesji, zwolnienia z VAT i audytu. Niezmienniki: źródło `manual`,
 * osoba i firma z sesji, kwoty spójne co do grosza, VAT odlicza tylko faktura
 * (jak OCR i formularz przeglądu), zwolniona firma nie odlicza, koszt trafia
 * do KPiR tą samą kwotą co koszt z OCR, bliźniak z ostatnich 2 minut nie
 * tworzy drugiego kosztu, firma formularza musi być firmą aktywną.
 */

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = { expenses: [] };
const insertFail = { on: false };

function from(name: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let op: 'select' | 'insert' = 'select';
  let payload: Row | null = null;
  const q: Record<string, unknown> = {
    select: () => q,
    insert: (row: Row) => ((op = 'insert'), (payload = row), q),
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
    is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), q),
    gte: (k: string, v: string) => (filters.push((r) => String(r[k]) >= v), q),
    order: () => q,
    limit: () => q,
    single: async () => {
      if (op === 'insert') {
        if (insertFail.on) return { data: null, error: { message: 'boom' } };
        const row = { id: `exp-${(tables[name] ??= []).length + 1}`, created_at: new Date().toISOString(), ...payload };
        tables[name]!.push(row);
        return { data: { id: row.id }, error: null };
      }
      return { data: null, error: null };
    },
    then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
      Promise.resolve({ data: (tables[name] ?? []).filter((r) => filters.every((f) => f(r))), error: null }).then(ok, ko),
  };
  return q;
}

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const m = vi.hoisted(() => ({ exempt: null as string | null, audit: vi.fn() }));

vi.mock('@/lib/supabase/auth-context', () => ({
  requireUserAndActiveOrg: vi.fn(async (check?: { expectedTenantId?: string }) => {
    if (check?.expectedTenantId && check.expectedTenantId !== 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') {
      throw new Error('Firma w formularzu jest inna niż aktywna');
    }
    return { supabase: { from }, user: { id: 'user-1' }, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'member' };
  }),
  ActionAuthError: class ActionAuthError extends Error {},
}));
vi.mock('@/lib/invoices/vat-exemption', async (orig) => ({
  ...(await orig<typeof import('@/lib/invoices/vat-exemption')>()),
  readTenantVatExemption: async () => m.exempt,
}));
vi.mock('@/lib/audit/log', () => ({ logAudit: m.audit }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/expenses/review', () => ({ reviewExpense: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createAdminClient: vi.fn() }));

import { createManualExpenseAction } from '@/app/actions/expenses';
import { kpirCostAmount } from '@/lib/categorization/kpir-cost';

const dzis = '2026-11-16';
const OK = {
  sellerName: 'Urząd Miasta',
  sellerNip: '',
  documentType: 'other',
  documentNumber: '',
  issueDate: '2026-11-10',
  netAmount: 100,
  vatAmount: 0,
  grossAmount: 100,
  kpirColumn: 'col_13',
  notes: '',
  isDeductible: true,
} as const;
const wiersze = () => tables.expenses!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${dzis}T10:00:00Z`));
  tables.expenses = [];
  insertFail.on = false;
  m.exempt = null;
  m.audit.mockReset();
});

describe('koszt wpisany ręcznie: zapis', () => {
  it('zapisuje koszt ze źródłem „manual”, osobą i firmą z sesji, bez zdjęcia i bez odczytu', async () => {
    const r = await createManualExpenseAction(OK, TENANT);
    expect(r).toEqual({ success: true, expenseId: 'exp-1', duplicate: false });
    expect(wiersze()[0]).toMatchObject({
      tenant_id: TENANT,
      created_by: 'user-1',
      source: 'manual',
      seller_name: 'Urząd Miasta',
      document_type: 'other',
      issue_date: '2026-11-10',
      net_amount: 100,
      vat_amount: 0,
      gross_amount: 100,
      kpir_column: 'col_13',
      categorization_method: 'manual',
      is_deductible: true,
      is_reviewed: true,
    });
    for (const pole of ['ocr_job_id', 'source_file_path', 'source_file_mime', 'ocr_extracted_data', 'ksef_invoice_id']) {
      expect(wiersze()[0]![pole] ?? null).toBeNull();
    }
  });

  it('puste pola opcjonalne zapisuje jako NULL, nie jako pusty tekst', async () => {
    await createManualExpenseAction({ ...OK, sellerNip: '', documentNumber: '  ', notes: '' }, TENANT);
    expect(wiersze()[0]).toMatchObject({ seller_nip: null, document_number: null, notes: null });
  });

  it('faktura z VAT: VAT do odliczenia w pełnej kwocie, a koszt w KPiR to netto', async () => {
    await createManualExpenseAction({ ...OK, documentType: 'invoice', documentNumber: 'FV/1', netAmount: 100, vatAmount: 23, grossAmount: 123 }, TENANT);
    const w = wiersze()[0]!;
    expect(w.vat_deductible_amount).toBe(23);
    expect(kpirCostAmount(w as never)).toBe(100);
  });

  it('paragon i inny dokument z VAT: VAT nie jest odliczany, koszt w KPiR to brutto (jak koszt z odczytu)', async () => {
    await createManualExpenseAction({ ...OK, documentType: 'receipt', netAmount: 100, vatAmount: 23, grossAmount: 123 }, TENANT);
    const w = wiersze()[0]!;
    expect(w.vat_deductible_amount).toBe(0);
    expect(kpirCostAmount(w as never)).toBe(123);
  });

  it('firma zwolniona z VAT nie odlicza VAT nawet z faktury', async () => {
    m.exempt = 'art. 113 ust. 1 ustawy o VAT';
    await createManualExpenseAction({ ...OK, documentType: 'invoice', netAmount: 100, vatAmount: 23, grossAmount: 123 }, TENANT);
    expect(wiersze()[0]!.vat_deductible_amount).toBe(0);
  });

  it('„Wlicz do KPiR” wyłączone zapisuje is_deductible = false', async () => {
    await createManualExpenseAction({ ...OK, isDeductible: false }, TENANT);
    expect(wiersze()[0]).toMatchObject({ is_deductible: false });
  });

  it('osoba i firma pochodzą z sesji, nie z danych formularza', async () => {
    await createManualExpenseAction({ ...OK, created_by: 'ktos-inny', tenant_id: 'inna-firma', source: 'ksef_inbox' } as never, TENANT);
    expect(wiersze()[0]).toMatchObject({ created_by: 'user-1', tenant_id: TENANT, source: 'manual' });
  });

  it('zapis trafia do audytu (kto, jaki dokument, jaka kwota, jaka kolumna)', async () => {
    await createManualExpenseAction(OK, TENANT);
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'expense.created_manually',
        tenantId: TENANT,
        userId: 'user-1',
        entityType: 'expense',
        entityId: 'exp-1',
        metadata: expect.objectContaining({ grossAmount: 100, kpirColumn: 'col_13', documentType: 'other' }),
      }),
    );
  });
});

describe('koszt wpisany ręcznie: odmowy bez zapisu', () => {
  it.each([
    ['brak sprzedawcy', { sellerName: '  ' }],
    ['netto + VAT różne od brutto', { netAmount: 100, vatAmount: 23, grossAmount: 124 }],
    ['kwota brutto zero', { netAmount: 0, vatAmount: 0, grossAmount: 0 }],
    ['kwota ujemna', { netAmount: -10, vatAmount: 0, grossAmount: -10 }],
    ['NIP z błędną sumą kontrolną', { sellerNip: '1234567891' }],
    ['data z przyszłości', { issueDate: '2026-11-17' }],
    ['data nieistniejąca', { issueDate: '2026-02-30' }],
    ['rodzaj dokumentu spoza listy', { documentType: 'simplified_invoice' }],
    ['kolumna przychodowa 7 (nie jest kosztem w KPiR)', { kpirColumn: 'col_7' }],
    ['kolumna przychodowa 8', { kpirColumn: 'col_8' }],
    ['kolumna 16 (łączona z B+R w eksporcie)', { kpirColumn: 'col_16' }],
    ['kolumna KPiR spoza listy', { kpirColumn: 'col_99' }],
    ['brak kolumny KPiR', { kpirColumn: '' }],
    ['zbyt długie uwagi', { notes: 'x'.repeat(10_001) }],
  ])('%s', async (_nazwa, zmiana) => {
    const r = await createManualExpenseAction({ ...OK, ...zmiana } as never, TENANT);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.length).toBeGreaterThan(5);
    expect(wiersze()).toHaveLength(0);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('grosze liczone jako liczby całkowite: 0,1 + 0,2 = 0,3 przechodzi', async () => {
    const r = await createManualExpenseAction({ ...OK, netAmount: 0.1, vatAmount: 0.2, grossAmount: 0.3 }, TENANT);
    expect(r.success).toBe(true);
  });

  it('firma z formularza inna niż aktywna: odmowa bez zapisu', async () => {
    const r = await createManualExpenseAction(OK, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    expect(r.success).toBe(false);
    expect(wiersze()).toHaveLength(0);
  });

  it('błąd bazy to komunikat z drogą wyjścia, bez audytu', async () => {
    insertFail.on = true;
    const r = await createManualExpenseAction(OK, TENANT);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/Nie udało się zapisać kosztu/);
    expect(m.audit).not.toHaveBeenCalled();
  });
});

describe('koszt wpisany ręcznie: ponowienie', () => {
  it('ten sam koszt wysłany drugi raz w ciągu 2 minut zwraca istniejący, bez drugiego wiersza i audytu', async () => {
    await createManualExpenseAction(OK, TENANT);
    const drugi = await createManualExpenseAction(OK, TENANT);
    expect(drugi).toEqual({ success: true, expenseId: 'exp-1', duplicate: true });
    expect(wiersze()).toHaveLength(1);
    expect(m.audit).toHaveBeenCalledTimes(1);
  });

  it('inna kwota albo inny sprzedawca to nowy koszt', async () => {
    await createManualExpenseAction(OK, TENANT);
    await createManualExpenseAction({ ...OK, netAmount: 101, grossAmount: 101 }, TENANT);
    await createManualExpenseAction({ ...OK, sellerName: 'Inny' }, TENANT);
    expect(wiersze()).toHaveLength(3);
  });

  it('po 2 minutach ten sam koszt to nowy wpis (świadome drugie takie samo wydatkowanie)', async () => {
    await createManualExpenseAction(OK, TENANT);
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    const drugi = await createManualExpenseAction(OK, TENANT);
    expect(drugi).toMatchObject({ success: true, duplicate: false });
    expect(wiersze()).toHaveLength(2);
  });
});
