'use server';

import { revalidatePath } from 'next/cache';

import { saveVatExemption } from '@/lib/settings/company-settings';
import { ActionAuthError, requireOrgRole } from '@/lib/supabase/auth-context';

export type VatExemptionResult =
  | { success: true; basis: string | null }
  | { success: false; error: string };

/**
 * Ustawia (albo zdejmuje — `null`/pusty tekst) zwolnienie z VAT firmy.
 *
 * Tylko właściciel i administrator: to zmienia treść każdej kolejnej faktury
 * wysyłanej do KSeF. Zapis przez klienta serwisowego PO sprawdzeniu roli
 * i aktywnego członkostwa (ten sam wzór co uzupełnianie NIP-u firmy).
 * Zmiana statusu podatkowego trafia do dziennika audytu.
 */
export async function updateVatExemptionAction(basisInput: string | null): Promise<VatExemptionResult> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }

  const result = await saveVatExemption({ tenantId: ctx.tenantId, userId: ctx.user.id }, basisInput);
  if (!result.ok) return { success: false, error: result.error };

  revalidatePath('/settings');
  revalidatePath('/invoices/new/regular');
  return { success: true, basis: result.value };
}
