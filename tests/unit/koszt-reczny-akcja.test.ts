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
const ilikeCalls: Array<[string, string]> = [];
const rpcCalls: Array<{ name: string; args: Row }> = [];

/**
 * Od 00127 rola authenticated nie ma INSERT na expenses (klient sesji nie może podrobić kosztu z KSeF),
 * więc zapis idzie przez funkcję expense_create_manual (00212). Atrapa odtwarza jej skutek:
 * źródło `manual` na sztywno, firma i osoba z sesji, pola odczytu puste.
 */
async function rpc(name: string, args: Row) {
  rpcCalls.push({ name, args });
  if (name !== 'expense_create_manual') return { data: null, error: { message: `nieznana funkcja ${name}` } };
  if (insertFail.on) return { data: null, error: { message: 'boom' } };
  const row: Row = {
    id: `exp-${(tables.expenses ??= []).length + 1}`,
    created_at: new Date().toISOString(),
    tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    created_by: 'user-1',
    source: 'manual',
    seller_name: args.p_seller_name,
    seller_nip: args.p_seller_nip,
    document_number: args.p_document_number,
    document_type: args.p_document_type,
    issue_date: args.p_issue_date,
    net_amount: args.p_net_amount,
    vat_amount: args.p_vat_amount,
    gross_amount: args.p_gross_amount,
    vat_deductible_amount: args.p_vat_deductible_amount,
    kpir_column: args.p_kpir_column,
    category_label: args.p_category_label,
    categorization_method: 'manual',
    notes: args.p_notes,
    is_reviewed: true,
    is_deductible: args.p_is_deductible,
  };
  tables.expenses!.push(row);
  return { data: row.id, error: null };
}

function from(name: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let wantCount = false;
  let rangeArr: [number, number] | null = null;
  let lim: number | null = null;
  const q: Record<string, unknown> = {
    select: (_c?: string, opts?: { count?: string }) => ((wantCount = opts?.count === 'exact'), q),
    insert: (row: Row) => {
      // 00127: REVOKE INSERT ON public.expenses FROM authenticated. Akcja nie ma prawa tu zapisywać.
      throw Object.assign(new Error('permission denied for table expenses'), { code: '42501', row });
    },
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
    is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), q),
    not: (k: string, op: string, v: unknown) => (op === 'is' && filters.push((r) => (r[k] ?? null) !== v), q),
    ilike: (k: string, pat: string) => {
      ilikeCalls.push([k, pat]);
      let rx = '';
      for (let i = 0; i < pat.length; i += 1) {
        const c = pat[i]!;
        if (c === '\\') rx += (pat[++i] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        else if (c === '%') rx += '.*';
        else if (c === '_') rx += '.';
        else rx += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      const re = new RegExp(`^${rx}$`, 'i');
      filters.push((r) => re.test(String(r[k] ?? '')));
      return q;
    },
    gte: (k: string, v: string) => (filters.push((r) => String(r[k]) >= v), q),
    order: () => q,
    range: (a: number, b: number) => ((rangeArr = [a, b]), q),
    limit: (n: number) => ((lim = n), q),
    single: async () => ({ data: null, error: null }),
    then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
      Promise.resolve(
        (() => {
          const all = (tables[name] ?? []).filter((r) => filters.every((f) => f(r)));
          const data = rangeArr ? all.slice(rangeArr[0], rangeArr[1] + 1) : lim !== null ? all.slice(0, lim) : all;
          return { data, count: wantCount ? all.length : null, error: null };
        })(),
      ).then(ok, ko),
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
    return { supabase: { from, rpc }, user: { id: 'user-1' }, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'member' };
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
  categoryLabel: 'Pozostałe wydatki',
  notes: '',
  isDeductible: true,
} as const;
const wiersze = () => tables.expenses!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${dzis}T10:00:00Z`));
  tables.expenses = [];
  ilikeCalls.length = 0;
  rpcCalls.length = 0;
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
      category_label: 'Pozostałe wydatki',
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

describe('koszt wpisany ręcznie: zapis przez funkcję bazy (00212), nie przez INSERT', () => {
  it('woła expense_create_manual dokładnie raz, z polami z formularza i bez tenant_id, created_by i source', async () => {
    const r = await createManualExpenseAction({ ...OK, documentType: 'invoice', sellerNip: '5260250274', documentNumber: 'FV9/2026', netAmount: 100, vatAmount: 23, grossAmount: 123, notes: '  uwaga ' }, TENANT);
    expect(r).toEqual({ success: true, expenseId: 'exp-1', duplicate: false });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]!.name).toBe('expense_create_manual');
    expect(rpcCalls[0]!.args).toEqual({
      p_seller_name: 'Urząd Miasta',
      p_seller_nip: '5260250274',
      p_document_type: 'invoice',
      p_document_number: 'FV9/2026',
      p_issue_date: '2026-11-10',
      p_net_amount: 100,
      p_vat_amount: 23,
      p_gross_amount: 123,
      p_vat_deductible_amount: 23,
      p_kpir_column: 'col_13',
      p_category_label: 'Pozostałe wydatki',
      p_notes: 'uwaga',
      p_is_deductible: true,
    });
    for (const zakazane of ['p_tenant_id', 'p_created_by', 'p_source']) expect(rpcCalls[0]!.args).not.toHaveProperty(zakazane);
  });

  it('błąd funkcji bazy po udanym zapisie: komunikat, bez drugiego wiersza i bez drugiego audytu', async () => {
    const r = await createManualExpenseAction(OK, TENANT);
    expect(r.success).toBe(true);
    insertFail.on = true;
    const zly = await createManualExpenseAction({ ...OK, sellerName: 'Inny' }, TENANT);
    expect(zly.success).toBe(false);
    expect(m.audit).toHaveBeenCalledTimes(1);
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
    ['brak kategorii', { categoryLabel: '  ' }],
    ['zbyt długa kategoria', { categoryLabel: 'k'.repeat(201) }],
    ['kwota netto z trzema miejscami (10,004 + 2,004 = 12,008)', { netAmount: 10.004, vatAmount: 2.004, grossAmount: 12.008 }],
    ['kwota VAT z trzema miejscami', { netAmount: 10, vatAmount: 2.004, grossAmount: 12.004 }],
    ['kwota brutto z trzema miejscami', { netAmount: 10, vatAmount: 2, grossAmount: 12.001 }],
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

describe('koszt wpisany ręcznie: kategoria i faktura z KSeF', () => {
  it('kategoria z formularza trafia do category_label (opis zdarzenia w KPiR), także własny tekst', async () => {
    await createManualExpenseAction({ ...OK, categoryLabel: '  Składka członkowska  ' }, TENANT);
    expect(wiersze()[0]).toMatchObject({ category_label: 'Składka członkowska' });
  });

  const FAKTURA = { ...OK, documentType: 'invoice', sellerNip: '5260250274', documentNumber: 'FV1/2026', netAmount: 100, vatAmount: 23, grossAmount: 123 };

  it('faktura, która już jest w Kosztach (np. ze Skrzynki KSeF), nie powstaje drugi raz: ten sam NIP i numer mimo innego zapisu', async () => {
    wiersze().push({ id: 'ksef-1', tenant_id: TENANT, source: 'ksef_inbox', seller_nip: '526-025-02-74', document_number: 'fv 1/2026' });
    const r = await createManualExpenseAction(FAKTURA, TENANT);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain('FV1/2026');
    expect(wiersze()).toHaveLength(1);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('NIP zapisany z przedrostkiem i myślnikami („PL 526-000-12-46”) też wykrywa powtórzoną fakturę', async () => {
    wiersze().push({ id: 'ocr-1', tenant_id: TENANT, source: 'ocr', seller_nip: 'PL 526-000-12-46', document_number: 'FV1/2026' });
    const r = await createManualExpenseAction({ ...FAKTURA, sellerNip: '5260001246' }, TENANT);
    expect(r.success).toBe(false);
    expect(wiersze()).toHaveLength(1);
  });

  it('stały dostawca z ponad 200 kosztami: szukana faktura na końcu też jest znaleziona', async () => {
    for (let i = 1; i <= 250; i += 1) {
      wiersze().push({ id: `r-${String(i).padStart(3, '0')}`, tenant_id: TENANT, source: 'ocr', seller_nip: '5260250274', document_number: `FV1/2026/${i}` });
    }
    wiersze().push({ id: 'r-251', tenant_id: TENANT, source: 'ksef_inbox', seller_nip: '5260250274', document_number: 'FV1/2026' });
    const r = await createManualExpenseAction(FAKTURA, TENANT);
    expect(r.success).toBe(false);
    expect(wiersze()).toHaveLength(251);
  });

  it('znaki „%” i „_” w numerze są szukane dosłownie i nie łapią innych numerów', async () => {
    wiersze().push({ id: 'a-1', tenant_id: TENANT, source: 'ocr', seller_nip: '5260250274', document_number: 'FVX1Y' });
    const r = await createManualExpenseAction({ ...FAKTURA, documentNumber: 'FV_1%' }, TENANT);
    expect(r.success).toBe(true);
    const wzorzec = ilikeCalls.find(([k]) => k === 'document_number')?.[1] ?? '';
    expect(wzorzec).toContain('\\_');
    expect(wzorzec).toContain('\\%');
    wiersze().push({ id: 'a-2', tenant_id: TENANT, source: 'ocr', seller_nip: '5260250274', document_number: 'FV_1%' });
    vi.setSystemTime(new Date(`${dzis}T10:10:00Z`));
    expect((await createManualExpenseAction({ ...FAKTURA, documentNumber: 'FV_1%', sellerName: 'Drugi' }, TENANT)).success).toBe(false);
  });

  it('ta sama faktura w cudzej firmie, paragon z tym numerem albo inny numer nie blokują zapisu', async () => {
    wiersze().push({ id: 'cudza', tenant_id: 'inna-firma', source: 'ksef_inbox', seller_nip: '5260250274', document_number: 'FV1/2026' });
    expect((await createManualExpenseAction(FAKTURA, TENANT)).success).toBe(true);
    expect((await createManualExpenseAction({ ...FAKTURA, documentType: 'receipt', documentNumber: 'FV1/2026', grossAmount: 124, netAmount: 101 }, TENANT)).success).toBe(true);
    expect((await createManualExpenseAction({ ...FAKTURA, documentNumber: 'FV2/2026' }, TENANT)).success).toBe(true);
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
