import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Sekcja „Akceptacja księgowej” na stronie kosztu (krok 6.2, część 5a, 00214):
 * kto ją widzi. Księgowa zawsze, pozostali dopiero przy decyzji albo błędzie
 * odczytu, więc firma bez księgowej nie dostaje „Czeka na akceptację” na każdym
 * koszcie. Kotwica `#akceptacja` to cel linku z dzwonka.
 */

const m = vi.hoisted(() => ({ context: vi.fn(), load: vi.fn() }));

vi.mock('@/lib/supabase/page-context', () => ({ getPageContext: m.context }));
vi.mock('@/lib/expenses/acceptance-load', () => ({ loadExpenseAcceptance: m.load }));
vi.mock('@/app/actions/expense-acceptance', () => ({ decideExpenseAcceptanceAction: vi.fn() }));

const { ExpenseAcceptanceContent } = await import('@/app/(dashboard)/expenses/[id]/_components/expense-acceptance');
const { ExpenseAcceptancePanel } = await import('@/app/(dashboard)/expenses/[id]/_components/expense-acceptance-panel');

const EXPENSE = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const FP = '0123456789abcdef0123456789abcdef';
const supabase = { rpc: vi.fn(), from: vi.fn() };
const state = (decision: 'accepted' | 'needs_changes' | null) => ({
  ok: true as const,
  decidedByLabel: decision ? 'Anna Księgowa' : null,
  state: { currentFingerprint: FP, decision, reason: decision === 'needs_changes' ? 'Brak faktury.' : null, decidedBy: decision ? 'x' : null, decidedAt: decision ? '2026-11-25T00:30:00Z' : null, isCurrent: decision !== null },
});

beforeEach(() => {
  vi.clearAllMocks();
});

async function content(role: string, load: unknown) {
  m.context.mockResolvedValue({ supabase, user: { id: USER }, role, tenantId: 't' });
  m.load.mockResolvedValue(load);
  return (await ExpenseAcceptanceContent({ expenseId: EXPENSE })) as ReactElement<{ id: string; className: string; children: ReactElement<{ canDecide: boolean; expenseId: string }> }> | null;
}

describe('strona kosztu: sekcja akceptacji', () => {
  it('księgowa widzi sekcję także bez decyzji i może decydować; stan czytany kluczem z sesji dla tego kosztu', async () => {
    const section = await content('accountant', state(null));
    expect(m.load).toHaveBeenCalledWith(supabase, EXPENSE, USER);
    expect(section?.props.id).toBe('akceptacja');
    expect(section?.props.className).toBe('-mt-32 pt-6 pb-32');
    expect(section?.props.children.type).toBe(ExpenseAcceptancePanel);
    expect(section?.props.children.props).toMatchObject({ expenseId: EXPENSE, canDecide: true });
  });

  it('pozostałe role: bez decyzji nie ma sekcji (układ strony bez zmian), z decyzją albo błędem odczytu jest sekcja bez decydowania', async () => {
    for (const role of ['owner', 'admin', 'member']) {
      expect(await content(role, state(null)), role).toBeNull();
      const zDecyzja = await content(role, state('needs_changes'));
      expect(zDecyzja?.props.children.props.canDecide, role).toBe(false);
      const blad = await content(role, { ok: false, error: 'x' });
      expect(blad?.props.id, role).toBe('akceptacja');
    }
  });
});
