'use server';

import { readTenantSnapshot } from '@/lib/invoices/issue-regular';
import {
  saveAdvance,
  saveAndSendAdvance,
  type AdvanceIssueContext,
  type AdvanceIssueResult,
} from '@/lib/invoices/issue-advance';
import { requireUserAndActiveOrg, type FormTenantCheck } from '@/lib/supabase/auth-context';

/**
 * Faktura zaliczkowa ze strony. Logika zapisu i wysyłki od M8b planu aplikacji
 * mobilnej w `lib/invoices/issue-advance.ts` (ta sama dla telefonu); tu tylko
 * sesja z ciasteczek i firma formularza.
 */

/** `formTenant` — firma formularza musi być firmą aktywną teraz (UX-01). */
async function tenantContext(formTenant: FormTenantCheck): Promise<AdvanceIssueContext> {
  const { supabase, user, tenantId } = await requireUserAndActiveOrg(formTenant);
  return { supabase, userId: user.id, tenant: await readTenantSnapshot(supabase, tenantId) };
}

/**
 * `expectedTenantId` — firma, dla której strona wyrenderowała formularz
 * (UX-01); tylko do porównania z firmą z ciasteczka. Także w wysyłce.
 */
export async function saveAdvanceAction(raw: unknown, expectedTenantId: string): Promise<AdvanceIssueResult> {
  return saveAdvance(() => tenantContext({ expectedTenantId }), raw);
}

export async function saveAndSendAdvanceAction(raw: unknown, expectedTenantId: string): Promise<AdvanceIssueResult> {
  return saveAndSendAdvance(() => tenantContext({ expectedTenantId }), raw);
}
