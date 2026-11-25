import type { SupabaseClient } from '@supabase/supabase-js';

import { ACCEPTANCE_LOAD_ERROR, parseAcceptanceState, type ExpenseAcceptanceLoad } from './acceptance';

/**
 * Odczyt akceptacji kosztu (plan kompletnej aplikacji, krok 6.2, część 5a,
 * 00214) klientem z sesji. `expense_acceptance_state` działa z RLS czytającego,
 * więc kto nie widzi kosztu, dostaje `NULL` (tu: błąd odczytu, bo ekran kosztu
 * już go wczytał).
 *
 * Nazwa osoby z `users`: RLS (00058) pokazuje osoby ze wspólnej aktywnej firmy.
 * Konto usunięte (decyzja bez osoby) ma napis „Konto usunięte”, a błąd odczytu
 * nazwy nie chowa stanu: zostaje wtedy rola „Księgowy”.
 */

type Db = Pick<SupabaseClient, 'rpc' | 'from'>;

export async function loadExpenseAcceptance(db: Db, expenseId: string, viewerId: string): Promise<ExpenseAcceptanceLoad> {
  try {
    const { data, error } = await db.rpc('expense_acceptance_state', { p_expense_id: expenseId });
    if (error) return { ok: false, error: ACCEPTANCE_LOAD_ERROR };
    const state = parseAcceptanceState(data);
    if (!state) return { ok: false, error: ACCEPTANCE_LOAD_ERROR };
    if (state.decision === null) return { ok: true, state, decidedByLabel: null };
    if (!state.decidedBy) return { ok: true, state, decidedByLabel: 'Konto usunięte' };
    if (state.decidedBy === viewerId) return { ok: true, state, decidedByLabel: 'Ty' };

    let name = '';
    try {
      const { data: user } = await db.from('users').select('name').eq('id', state.decidedBy).maybeSingle();
      const raw = (user as { name?: unknown } | null)?.name;
      name = typeof raw === 'string' ? raw.trim() : '';
    } catch {
      name = '';
    }
    return { ok: true, state, decidedByLabel: name || 'Księgowy' };
  } catch {
    return { ok: false, error: ACCEPTANCE_LOAD_ERROR };
  }
}
