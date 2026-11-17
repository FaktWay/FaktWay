'use server';

import { revalidatePath } from 'next/cache';

import type { CompanyProfileInput } from '@/lib/schemas/company-profile';
import { saveCompanyProfile } from '@/lib/settings/company-settings';
import { ActionAuthError, requireOrgRole } from '@/lib/supabase/auth-context';

export type CompanyProfileResult = { success: true } | { success: false; error: string };

/**
 * Zmiana nazwy i adresu siedziby firmy (F-008). Do 02.10.2026 dane były tylko
 * do odczytu: błędny albo nieaktualny adres z GUS trafiał na każdą fakturę.
 *
 * Tylko właściciel i administrator — zmienia to treść każdej kolejnej faktury
 * (Podmiot1) i JPK. Zapis klientem serwisowym PO sprawdzeniu roli i aktywnego
 * członkostwa (ten sam wzór co ustawienie zwolnienia z VAT). NIP pozostaje bez
 * zmian. Wystawione faktury mają własną kopię danych sprzedawcy, więc zmiana
 * ich nie dotyka. Logika zapisu: `lib/settings/company-settings.ts` (ta sama dla telefonu, M10c).
 */
export async function updateCompanyProfileAction(input: CompanyProfileInput): Promise<CompanyProfileResult> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }

  const result = await saveCompanyProfile({ tenantId: ctx.tenantId, userId: ctx.user.id }, input);
  if (!result.ok) return { success: false, error: result.error };

  revalidatePath('/settings');
  return { success: true };
}
