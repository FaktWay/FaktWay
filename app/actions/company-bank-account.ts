'use server';

import { revalidatePath } from 'next/cache';

import { saveCompanyBankAccount } from '@/lib/settings/company-settings';
import { ActionAuthError, requireOrgRole } from '@/lib/supabase/auth-context';

export type CompanyBankAccountResult = { success: true; rachunek: string | null } | { success: false; error: string };

/**
 * Ustawia (albo czyści: pusty tekst) rachunek firmy, z którego plik
 * przelewów zleca przelewy (krok 3.4, część 2; `tenants.bank_account`, 00183).
 * Tylko właściciel i administrator, jak dane firmy; zapis kluczem serwisowym
 * PO sprawdzeniu roli (wzór: `updateBusinessStartAction`), zmiana w audycie.
 */
export async function updateCompanyBankAccountAction(input: string | null): Promise<CompanyBankAccountResult> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) {
      return {
        success: false,
        error: e.message === 'Niewystarczające uprawnienia' ? 'Rachunek firmy zmienia właściciel albo administrator firmy.' : e.message,
      };
    }
    throw e;
  }

  const result = await saveCompanyBankAccount({ tenantId: ctx.tenantId, userId: ctx.user.id }, input);
  if (!result.ok) return { success: false, error: result.error };

  revalidatePath('/settings');
  revalidatePath('/expenses');
  return { success: true, rachunek: result.value };
}
