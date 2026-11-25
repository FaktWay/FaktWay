import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Akcja i ładowarka akceptacji kosztu (krok 6.2, część 5a, 00214): prawdziwa
 * akcja serwerowa i prawdziwa ładowarka, atrapy tylko dla sesji i RPC. Decyzję,
 * audyt i dzwonek zapisuje baza w jednej transakcji, więc akcja nie ma klucza
 * serwisowego ani `logAudit`. Funkcje, role i obce firmy na prawdziwej bazie:
 * `tests/rls-akceptacja-kosztow.test.ts`.
 */

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  requireOrgRole: vi.fn(),
  revalidate: vi.fn(),
  logAudit: vi.fn(),
  admin: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: m.revalidate }));
vi.mock('@/lib/audit/log', () => ({ logAudit: m.logAudit }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: m.admin }));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: m.admin, createClient: vi.fn() }));
vi.mock('@/lib/supabase/auth-context', () => {
  class ActionAuthError extends Error {}
  return { ActionAuthError, requireOrgRole: m.requireOrgRole };
});

const { decideExpenseAcceptanceAction } = await import('@/app/actions/expense-acceptance');
const { loadExpenseAcceptance } = await import('@/lib/expenses/acceptance-load');
const { ActionAuthError } = await import('@/lib/supabase/auth-context');
const A = await import('@/lib/expenses/acceptance');

const EXPENSE = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const FP = '0123456789abcdef0123456789abcdef';

const input = (over: Record<string, unknown> = {}) =>
  ({ expenseId: EXPENSE, decision: 'accepted', fingerprint: FP, ...over }) as Parameters<typeof decideExpenseAcceptanceAction>[0];

beforeEach(() => {
  vi.clearAllMocks();
  m.requireOrgRole.mockResolvedValue({ supabase: { rpc: m.rpc }, user: { id: USER }, role: 'accountant' });
  m.rpc.mockResolvedValue({ data: { status: 'decided', expense_id: EXPENSE, decision: 'accepted', notified: 0 }, error: null });
});

describe('decideExpenseAcceptanceAction', () => {
  it('akceptacja: tylko rola księgowej, funkcja bazy kluczem z sesji bez powodu, odświeżenie kosztu, bez audytu w akcji', async () => {
    expect(await decideExpenseAcceptanceAction(input({ reason: 'pomijany' }))).toEqual({ success: true, status: 'decided', decision: 'accepted' });
    expect(m.requireOrgRole).toHaveBeenCalledWith(['accountant']);
    expect(m.rpc).toHaveBeenCalledExactlyOnceWith('expense_acceptance_decide', {
      p_expense_id: EXPENSE, p_decision: 'accepted', p_reason: null, p_fingerprint: FP,
    });
    expect(m.revalidate).toHaveBeenCalledWith(`/expenses/${EXPENSE}`);
    expect(m.logAudit).not.toHaveBeenCalled();
    expect(m.admin).not.toHaveBeenCalled();
  });

  it('„do poprawy”: przycięty powód; ponowienie (exists) to sukces; bez powodu odmowa przed bazą', async () => {
    m.rpc.mockResolvedValueOnce({ data: { status: 'decided', decision: 'needs_changes', notified: 2 }, error: null });
    expect(await decideExpenseAcceptanceAction(input({ decision: 'needs_changes', reason: '  Brak faktury.\n' })))
      .toEqual({ success: true, status: 'decided', decision: 'needs_changes' });
    expect(m.rpc).toHaveBeenLastCalledWith('expense_acceptance_decide', expect.objectContaining({ p_reason: 'Brak faktury.' }));

    m.rpc.mockResolvedValueOnce({ data: { status: 'exists', decision: 'needs_changes' }, error: null });
    expect(await decideExpenseAcceptanceAction(input({ decision: 'needs_changes', reason: 'Brak faktury.' })))
      .toMatchObject({ success: true, status: 'exists' });

    m.rpc.mockClear();
    expect(await decideExpenseAcceptanceAction(input({ decision: 'needs_changes', reason: '  ' }))).toEqual({ success: false, error: A.EMPTY_REASON });
    expect(await decideExpenseAcceptanceAction(input({ fingerprint: 'zly' }))).toEqual({ success: false, error: A.ACCEPTANCE_SAVE_ERROR });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('inna rola i brak sesji: tekst z przyczyną i wyjściem, bez wołania bazy', async () => {
    m.requireOrgRole.mockRejectedValueOnce(new ActionAuthError('Niewystarczające uprawnienia'));
    expect(await decideExpenseAcceptanceAction(input())).toEqual({ success: false, error: A.ACCEPTANCE_ROLE_ONLY });
    m.requireOrgRole.mockRejectedValueOnce(new ActionAuthError('Zaloguj się ponownie.'));
    expect(await decideExpenseAcceptanceAction(input())).toEqual({ success: false, error: 'Zaloguj się ponownie.' });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('odmowy i błędy bazy: tekst odmowy według kodu, 42501 to brak dostępu, reszta to błąd zapisu; bez odświeżenia', async () => {
    for (const code of ['role', 'changed', 'not_found', 'empty_reason', 'reason_too_long']) {
      m.rpc.mockResolvedValueOnce({ data: { status: 'refused', code }, error: null });
      expect(await decideExpenseAcceptanceAction(input()), code).toEqual({ success: false, error: A.decideRefusalText(code) });
    }
    m.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'x' } });
    expect(await decideExpenseAcceptanceAction(input())).toEqual({ success: false, error: A.ACCEPTANCE_NO_ACCESS });
    m.rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'x' } });
    expect(await decideExpenseAcceptanceAction(input())).toEqual({ success: false, error: A.ACCEPTANCE_SAVE_ERROR });
    m.rpc.mockRejectedValueOnce(new Error('sieć'));
    expect(await decideExpenseAcceptanceAction(input())).toEqual({ success: false, error: A.ACCEPTANCE_SAVE_ERROR });
    m.rpc.mockResolvedValueOnce({ data: { status: 'cos' }, error: null });
    expect(await decideExpenseAcceptanceAction(input())).toEqual({ success: false, error: A.ACCEPTANCE_SAVE_ERROR });
    expect(m.revalidate).not.toHaveBeenCalled();
  });
});

describe('loadExpenseAcceptance', () => {
  const state = (over: Record<string, unknown> = {}) => ({
    current_fingerprint: FP, decision: 'accepted', reason: null, decided_by: OTHER, decided_at: '2026-11-25T01:00:00Z', is_current: true, ...over,
  });
  const db = (rpcResult: unknown, user: unknown = { data: { name: ' Anna Księgowa ' }, error: null }) => {
    const maybeSingle = typeof user === 'function' ? user : vi.fn().mockResolvedValue(user);
    return {
      rpc: vi.fn().mockResolvedValue(rpcResult),
      from: vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle }) }) })),
    } as unknown as Parameters<typeof loadExpenseAcceptance>[0];
  };

  it('stan i osoba: nazwa ze wspólnej firmy, „Ty”, „Konto usunięte”, rola przy błędzie odczytu nazwy', async () => {
    expect(await loadExpenseAcceptance(db({ data: state(), error: null }), EXPENSE, USER)).toMatchObject({ ok: true, decidedByLabel: 'Anna Księgowa', state: { decision: 'accepted', isCurrent: true } });
    expect(await loadExpenseAcceptance(db({ data: state({ decided_by: USER }), error: null }), EXPENSE, USER)).toMatchObject({ ok: true, decidedByLabel: 'Ty' });
    expect(await loadExpenseAcceptance(db({ data: state({ decided_by: null }), error: null }), EXPENSE, USER)).toMatchObject({ ok: true, decidedByLabel: 'Konto usunięte' });
    expect(await loadExpenseAcceptance(db({ data: state(), error: null }, vi.fn().mockRejectedValue(new Error('x'))), EXPENSE, USER)).toMatchObject({ ok: true, decidedByLabel: 'Księgowy' });
    expect(await loadExpenseAcceptance(db({ data: state({ decision: null, decided_by: null, decided_at: null, is_current: false }), error: null }), EXPENSE, USER))
      .toMatchObject({ ok: true, decidedByLabel: null, state: { decision: null } });
  });

  it('błąd odczytu, brak kosztu dla czytającego (NULL) i zły kształt: błąd z „Spróbuj ponownie”, nie pusty stan', async () => {
    for (const wynik of [{ data: null, error: { message: 'x' } }, { data: null, error: null }, { data: { status: 'x' }, error: null }]) {
      expect(await loadExpenseAcceptance(db(wynik), EXPENSE, USER)).toEqual({ ok: false, error: A.ACCEPTANCE_LOAD_ERROR });
    }
    expect(A.ACCEPTANCE_LOAD_ERROR).toContain('Spróbuj ponownie');
  });
});
