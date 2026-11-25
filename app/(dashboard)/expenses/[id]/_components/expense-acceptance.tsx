import { Suspense } from 'react';

import { EXPENSE_ACCEPTANCE_ANCHOR, canDecideExpenseAcceptance } from '@/lib/expenses/acceptance';
import { loadExpenseAcceptance } from '@/lib/expenses/acceptance-load';
import { getPageContext } from '@/lib/supabase/page-context';

import { ExpenseAcceptancePanel } from './expense-acceptance-panel';

/**
 * Akceptacja kosztu przez księgową (plan kompletnej aplikacji, krok 6.2,
 * część 5a, 00214) pod formularzem kosztu, przed wątkiem. Stan czyta się
 * w osobnej granicy Suspense, więc formularz nie czeka na zapytanie.
 *
 * Kto widzi sekcję: księgowa zawsze (może zdecydować), pozostali dopiero gdy
 * jest decyzja albo błąd odczytu. Firma bez księgowej w FaktWay nie dostaje więc
 * na każdym koszcie „Czeka na akceptację księgowej”.
 *
 * Odstępy jak w wątku (`expense-thread.tsx`): sekcja wchodzi w `pb-32`
 * poprzedniego bloku (`-mt-32 pt-6`) i sama zostawia `pb-32`; bez treści nie
 * ma sekcji, więc układ strony się nie zmienia. Kotwica `#akceptacja` to cel
 * linku z dzwonka.
 */
export function ExpenseAcceptance({ expenseId }: { expenseId: string }) {
  return (
    <Suspense fallback={null}>
      <ExpenseAcceptanceContent expenseId={expenseId} />
    </Suspense>
  );
}

/** Dane z sesji: aktywna firma, użytkownik i rola (członkostwo sprawdza `getPageContext`). */
export async function ExpenseAcceptanceContent({ expenseId }: { expenseId: string }) {
  const { supabase, user, role } = await getPageContext();
  const load = await loadExpenseAcceptance(supabase, expenseId, user.id);
  const canDecide = canDecideExpenseAcceptance(role);
  if (!canDecide && load.ok && load.state.decision === null) return null;
  return (
    <section id={EXPENSE_ACCEPTANCE_ANCHOR} aria-label="Akceptacja księgowej" className="-mt-32 pt-6 pb-32">
      <ExpenseAcceptancePanel expenseId={expenseId} load={load} canDecide={canDecide} />
    </section>
  );
}
