'use server';

import type { SupabaseClient } from '@supabase/supabase-js';

import { requireUserAndActiveOrg } from '@/lib/supabase/auth-context';
import { discardInvoiceAutosave, saveInvoiceAutosave } from '@/lib/invoices/form-autosave';

/**
 * Autozapis formularza zwykłej faktury (plan kompletnej aplikacji, krok 2.8).
 * Firma i osoba pochodzą z sesji; `expectedTenantId` (firma formularza) służy
 * tylko do porównania z firmą aktywną, jak przy zapisie szkicu (UX-01).
 * Logika i opis: `lib/invoices/form-autosave.ts`.
 */

export type InvoiceAutosaveResult = { ok: true; savedAt: string } | { ok: false };

export async function saveInvoiceAutosaveAction(
  values: unknown,
  expectedTenantId: string,
): Promise<InvoiceAutosaveResult> {
  try {
    const { supabase, user, tenantId } = await requireUserAndActiveOrg({ expectedTenantId });
    const requestKey =
      typeof values === 'object' && values !== null ? (values as { numberRequestKey?: unknown }).numberRequestKey : undefined;
    const result = await saveInvoiceAutosave(supabase as unknown as SupabaseClient, {
      tenantId,
      userId: user.id,
      requestKey: typeof requestKey === 'string' ? requestKey : '',
      values,
    });
    return result.ok ? { ok: true, savedAt: result.savedAt } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** „Zacznij od nowa” w banerze przywracania: kasuje własną kopię roboczą o tym kluczu. */
export async function discardInvoiceAutosaveAction(requestKey: string, expectedTenantId: string): Promise<void> {
  try {
    const { supabase, user, tenantId } = await requireUserAndActiveOrg({ expectedTenantId });
    await discardInvoiceAutosave(supabase as unknown as SupabaseClient, tenantId, user.id, requestKey);
  } catch {
    // Brak sesji albo inna firma: nie ma czego kasować.
  }
}
