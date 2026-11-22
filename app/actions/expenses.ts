'use server';

import { revalidatePath } from 'next/cache';

import { readOcrJobStatus, OCR_JOB_MISSING } from '@/lib/expenses/ocr-status';
import { logAudit } from '@/lib/audit/log';
import { createManualExpense } from '@/lib/expenses/manual-expense';
import { reviewExpense, type ExpenseReviewUpdates } from '@/lib/expenses/review';
import { isUuid } from '@/lib/supabase/active-org';
import { createClient } from '@/lib/supabase/server';
import { requireUserAndActiveOrg } from '@/lib/supabase/auth-context';

/**
 * Sprawdź status OCR joba (do pollowania z UI). Logika i trzy wyniki
 * (zadanie jest, zadania nie ma, „nie wiem”): `lib/expenses/ocr-status.ts`,
 * wspólne z trasą telefonu `GET /api/mobile/v1/wydatki/odczyt/{id}` (M9).
 */
export async function getOcrJobStatusAction(ocrJobId: string) {
  // Argument akcji przychodzi z przeglądarki. Nie-UUID to nie chwilowy błąd,
  // tylko zadanie, którego nie ma: odpowiadamy bez zapytania do bazy.
  if (!isUuid(ocrJobId)) return OCR_JOB_MISSING;
  return readOcrJobStatus(await createClient(), ocrJobId);
}

/**
 * Zaakceptuj/popraw expense; jeśli user zmienił kategorię, ucz się. Logika:
 * `lib/expenses/review.ts`, wspólna z trasą telefonu (M9). Strona dostaje
 * samo `error`, jak przed wydzieleniem.
 */
export async function reviewExpenseAction(
  expenseId: string,
  updates: ExpenseReviewUpdates,
) {
  let auth;
  try {
    auth = await requireUserAndActiveOrg();
  } catch {
    return { success: false as const, error: 'Brak autoryzacji' };
  }
  const { supabase, user, tenantId } = auth;

  const result = await reviewExpense({ supabase, userId: user.id, tenantId }, expenseId, updates);
  if (!result.success) return { success: false as const, error: result.error };
  return { success: true as const };
}

export async function deleteExpenseAction(expenseId: string) {
  // Sesja po drugim kroku MFA i potwierdzone członkostwo, nie sam `getUser()`
  // z firmą z ciasteczka (AUD-58).
  let auth;
  try {
    auth = await requireUserAndActiveOrg();
  } catch {
    return { success: false as const, error: 'Brak autoryzacji' };
  }
  const { supabase, tenantId } = auth;

  const { error, count } = await supabase
    .from('expenses')
    .delete({ count: 'exact' })
    .eq('id', expenseId)
    .eq('tenant_id', tenantId);

  if (error) {
    return {
      success: false as const,
      error: error.code === '42501'
        ? 'Koszt powiązany z KSeF pozostaje jako ślad faktury. Możesz wyłączyć go z KPiR.'
        : error.message,
    };
  }
  if (count === 0) {
    return { success: false as const, error: 'Wydatek nie istnieje' };
  }

  revalidatePath('/expenses');
  return { success: true as const };
}

/**
 * Koszt wpisany ręcznie (krok 3.8, część 1): opłata bez faktury, składka,
 * zakup bez zdjęcia. Logika i opis niezmienników: `lib/expenses/manual-expense.ts`.
 * Osoba i firma z sesji; `expectedTenantId` (firma, dla której strona
 * wyrenderowała formularz) tylko do porównania z firmą aktywną (UX-01).
 */
export type ManualExpenseActionResult =
  | { success: true; expenseId: string; duplicate: boolean }
  | { success: false; error: string };

export async function createManualExpenseAction(
  values: unknown,
  expectedTenantId: string,
): Promise<ManualExpenseActionResult> {
  let auth;
  try {
    auth = await requireUserAndActiveOrg({ expectedTenantId });
  } catch (e) {
    return { success: false, error: e instanceof Error && e.message ? e.message : 'Brak autoryzacji' };
  }
  const { supabase, user, tenantId } = auth;
  const result = await createManualExpense({ supabase, userId: user.id, tenantId }, values);
  if (!result.success) return result;
  if (!result.duplicate && result.row) {
    await logAudit({
      action: 'expense.created_manually',
      tenantId,
      userId: user.id,
      entityType: 'expense',
      entityId: result.expenseId,
      metadata: {
        documentType: result.row.document_type,
        documentNumber: result.row.document_number ?? null,
        grossAmount: result.row.gross_amount,
        kpirColumn: result.row.kpir_column,
        isDeductible: result.row.is_deductible,
      },
    });
    revalidatePath('/expenses');
  }
  return { success: true, expenseId: result.expenseId, duplicate: result.duplicate };
}
