'use server';

import { revalidatePath } from 'next/cache';

import { saveCashMethod } from '@/lib/settings/company-settings';
import { ActionAuthError, requireOrgRole } from '@/lib/supabase/auth-context';

export type CashMethodResult =
  | { success: true; enabled: boolean }
  | { success: false; error: string };

/**
 * Włącza albo wyłącza metodę kasową VAT firmy.
 *
 * Tylko właściciel i administrator: to zmienia treść każdej kolejnej faktury
 * (P_16 w FA(3)). Zapis przez klienta serwisowego PO sprawdzeniu roli
 * i aktywnego członkostwa (ten sam wzór co zwolnienie z VAT). Zmiana trafia
 * do dziennika audytu.
 */
export async function updateCashMethodAction(enabled: boolean): Promise<CashMethodResult> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }

  const result = await saveCashMethod({ tenantId: ctx.tenantId, userId: ctx.user.id }, enabled);
  if (!result.ok) return { success: false, error: result.error };

  revalidatePath('/settings');
  return { success: true, enabled: result.value };
}
