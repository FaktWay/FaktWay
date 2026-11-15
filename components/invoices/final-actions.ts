'use server';

import { readTenantSnapshot } from '@/lib/invoices/issue-regular';
import {
  saveAndSendFinal,
  saveFinal,
  type FinalIssueContext,
  type FinalIssueResult,
} from '@/lib/invoices/issue-final';
import { requireUserAndActiveOrg, type FormTenantCheck } from '@/lib/supabase/auth-context';

/**
 * Faktura rozliczająca zaliczki ze strony. Logika zapisu od M8b planu aplikacji
 * mobilnej w `lib/invoices/issue-final.ts` (ta sama dla telefonu); tu tylko
 * sesja z ciasteczek i firma formularza.
 */

/** `formTenant` — firma formularza musi być firmą aktywną teraz (UX-01). */
async function tenantContext(formTenant: FormTenantCheck): Promise<FinalIssueContext> {
  const { supabase, user, tenantId } = await requireUserAndActiveOrg(formTenant);
  return { supabase, userId: user.id, tenant: await readTenantSnapshot(supabase, tenantId) };
}

/**
 * `expectedTenantId` — firma, dla której strona wyrenderowała formularz
 * (UX-01); tylko do porównania z firmą z ciasteczka. Także w wysyłce.
 */
export async function saveFinalAction(raw: unknown, expectedTenantId: string): Promise<FinalIssueResult> {
  return saveFinal(() => tenantContext({ expectedTenantId }), raw);
}

export async function saveAndSendFinalAction(raw: unknown, expectedTenantId: string): Promise<FinalIssueResult> {
  return saveAndSendFinal(() => tenantContext({ expectedTenantId }), raw);
}
