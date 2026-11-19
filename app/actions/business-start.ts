'use server';

import { revalidatePath } from 'next/cache';

import { saveBusinessStart } from '@/lib/settings/company-settings';
import { ActionAuthError, requireOrgRole } from '@/lib/supabase/auth-context';

export type BusinessStartResult =
  | { success: true; startedOn: string | null }
  | { success: false; error: string };

/**
 * Ustawia (albo czyści — `null`/pusty tekst) datę rozpoczęcia działalności.
 * Tylko właściciel i administrator; zapis przez klienta serwisowego PO
 * sprawdzeniu roli (jak zwolnienie z VAT). Data zmienia limit zwolnienia
 * z VAT na Pulpicie, więc zmiana trafia do dziennika audytu.
 */
export async function updateBusinessStartAction(input: string | null): Promise<BusinessStartResult> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }

  // Wyjątek poza kontraktem { success:false } przewróciłby /settings w error.tsx: odczyt
  // „przed” i zapis łapie `saveBusinessStart` (`lib/settings/company-settings.ts`).
  const result = await saveBusinessStart({ tenantId: ctx.tenantId, userId: ctx.user.id }, input);
  if (!result.ok) return { success: false, error: result.error };

  revalidatePath('/settings');
  revalidatePath('/dashboard');
  return { success: true, startedOn: result.value };
}
