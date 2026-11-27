'use server';

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';

import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { isUuid } from '@/lib/supabase/active-org';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireUserAndActiveOrg } from '@/lib/supabase/auth-context';

/** Funkcja 00215 jeszcze nie jest w wygenerowanych typach bazy (types/database.ts po wgraniu migracji). */
interface DecyzjaKopiiRpc {
  rpc(
    name: 'decide_ksef_expense_copy',
    args: {
      p_tenant_id: string;
      p_ksef_expense_id: string;
      p_actor_user_id: string;
      p_ksef_environment: string;
      p_copy_expense_id: string | null;
    },
  ): PromiseLike<{ data: unknown; error: { message: string; code?: string | null } | null }>;
}

/**
 * Decyzja klienta o kopii faktury z KSeF (FZ-022, decyzja D29, 00215):
 * `copyExpenseId` to kopia wybrana z zadania („Połącz koszty”), `null` to
 * „To osobne dokumenty” (zamknięcie zadania) albo „Rozłącz” (kopia wraca do
 * KPiR z wartością sprzed połączenia). Jedyna droga zapisu: RPC tylko dla
 * service_role, które w bazie sprawdza członkostwo, firmę i środowisko KSeF
 * faktury (przy łączeniu), a audyt zapisuje w tej samej transakcji (wzór
 * `decideReceiptMatchAction`, 00175).
 */
export async function decideKsefCopyAction(ksefExpenseId: string, copyExpenseId: string | null) {
  if (!isUuid(ksefExpenseId) || (copyExpenseId !== null && !isUuid(copyExpenseId))) {
    return { success: false as const, error: 'Nieprawidłowe dane kosztów' };
  }
  let auth;
  try {
    auth = await requireUserAndActiveOrg();
  } catch {
    return { success: false as const, error: 'Brak autoryzacji' };
  }
  const { user, tenantId } = auth;
  const environment = configuredKsefEnvironment();
  if (!environment) {
    return { success: false as const, error: 'Nie udało się zapisać decyzji: środowisko KSeF aplikacji nie jest ustawione (sprawa dla pomocy FaktWay).' };
  }

  const { data, error } = await (createAdminClient() as unknown as DecyzjaKopiiRpc).rpc('decide_ksef_expense_copy', {
    p_tenant_id: tenantId,
    p_ksef_expense_id: ksefExpenseId,
    p_actor_user_id: user.id,
    p_ksef_environment: environment,
    p_copy_expense_id: copyExpenseId,
  });
  if (error) {
    // Ślad dla operatora (brak albo błąd funkcji 00215/00217); klient dostaje treść bez szczegółów bazy.
    console.error('[expenses] decyzja o kopii faktury z KSeF', error.message);
    Sentry.captureException(new Error(`decide_ksef_expense_copy: ${error.message}`), { tags: { area: 'koszty.kopia-ksef' }, extra: { tenantId, ksefExpenseId } });
    return { success: false as const, error: 'Nie udało się zapisać decyzji. Zapis można ponowić za chwilę.' };
  }
  if (data === 'not_deductible') {
    return {
      success: false as const,
      error: 'Koszt z KSeF jest wyłączony z KPiR, więc połączenie wyjęłoby z KPiR oba koszty. Decyzja nie została zapisana.',
    };
  }
  if (data !== 'linked' && data !== 'separated') {
    return { success: false as const, error: 'Koszty zmieniły się w międzyczasie, więc decyzja nie została zapisana. Po odświeżeniu strony widać aktualny stan.' };
  }

  revalidatePath('/expenses');
  revalidatePath(`/expenses/${ksefExpenseId}`);
  if (copyExpenseId) revalidatePath(`/expenses/${copyExpenseId}`);
  revalidatePath('/inbox');
  revalidatePath('/reports/kpir');
  return { success: true as const, result: data };
}
