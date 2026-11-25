'use server';

import { revalidatePath } from 'next/cache';

import {
  ACCEPTANCE_NO_ACCESS,
  ACCEPTANCE_ROLE_ONLY,
  ACCEPTANCE_SAVE_ERROR,
  decideRefusalText,
  expenseAcceptanceInputSchema,
  type DecideExpenseAcceptanceResult,
  type ExpenseAcceptanceInput,
} from '@/lib/expenses/acceptance';
import { ActionAuthError, requireOrgRole } from '@/lib/supabase/auth-context';

/**
 * Akceptacja kosztu przez księgową (plan kompletnej aplikacji, krok 6.2,
 * część 5a, 00214): akcja na kliencie sesji, bez klucza serwisowego. Firmę,
 * rolę, koszt, powód i odcisk treści sprawdza jeszcze raz funkcja bazy, która
 * w jednej transakcji zapisuje decyzję, audyt i przy „Do poprawy” wpisy
 * w dzwonku pozostałych członków firmy. Akcja nie dubluje więc ani dzwonka, ani
 * `logAudit`.
 *
 * Ponowienie: ta sama decyzja dla tej samej treści zwraca `exists` bez audytu
 * i dzwonka; dla przeglądarki to sukces.
 */

/**
 * Funkcja z 00214. `types/database.ts` generujemy z produkcji dopiero po wgraniu
 * migracji (AGENTS.md, „Typy bazy”), do tego czasu klient widzi ją przez ten kształt.
 */
type RpcResult = PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
interface ExpenseAcceptanceRpc {
  rpc(
    fn: 'expense_acceptance_decide',
    args: { p_expense_id: string; p_decision: string; p_reason: string | null; p_fingerprint: string },
  ): RpcResult;
}

function field(data: unknown, key: string): unknown {
  return data !== null && typeof data === 'object' ? (data as Record<string, unknown>)[key] : undefined;
}

export async function decideExpenseAcceptanceAction(input: ExpenseAcceptanceInput): Promise<DecideExpenseAcceptanceResult> {
  const parsed = expenseAcceptanceInputSchema.safeParse(input);
  if (!parsed.success) {
    const reasonIssue = parsed.error.issues.find((issue) => issue.path[0] === 'reason');
    return { success: false, error: reasonIssue?.message ?? ACCEPTANCE_SAVE_ERROR };
  }
  const { expenseId, decision, reason, fingerprint } = parsed.data;

  let db: ExpenseAcceptanceRpc;
  try {
    // Decyduje tylko księgowa; funkcja bazy sprawdza rolę jeszcze raz.
    const ctx = await requireOrgRole(['accountant']);
    db = ctx.supabase as unknown as ExpenseAcceptanceRpc;
  } catch (e) {
    if (e instanceof ActionAuthError) {
      return { success: false, error: e.message === 'Niewystarczające uprawnienia' ? ACCEPTANCE_ROLE_ONLY : e.message };
    }
    throw e;
  }

  try {
    const { data, error } = await db.rpc('expense_acceptance_decide', {
      p_expense_id: expenseId,
      p_decision: decision,
      p_reason: decision === 'needs_changes' ? (reason ?? null) : null,
      p_fingerprint: fingerprint,
    });
    if (error) return { success: false, error: error.code === '42501' ? ACCEPTANCE_NO_ACCESS : ACCEPTANCE_SAVE_ERROR };

    const status = field(data, 'status');
    if (status === 'decided' || status === 'exists') {
      revalidatePath(`/expenses/${expenseId}`);
      return { success: true, status, decision };
    }
    if (status === 'refused') return { success: false, error: decideRefusalText(field(data, 'code')) };
    return { success: false, error: ACCEPTANCE_SAVE_ERROR };
  } catch {
    return { success: false, error: ACCEPTANCE_SAVE_ERROR };
  }
}
