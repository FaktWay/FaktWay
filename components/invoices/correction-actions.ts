'use server';

import { readTenantSnapshot } from '@/lib/invoices/issue-regular';
import {
  getCorrectionParentContext,
  saveAndSendCorrection,
  saveCorrectionDraft,
  type CorrectionActionResult,
  type CorrectionIssueContext,
} from '@/lib/invoices/issue-correction';
import { requireUserAndActiveOrg, type FormTenantCheck } from '@/lib/supabase/auth-context';
import type { CorrectionInvoiceSchemaIn } from '@/lib/validators/invoice-validators';

export type { CorrectionActionResult };

/**
 * Faktura korygująca ze strony. Logika (faktura pierwotna, łańcuch korekt,
 * zapis, wysyłka) od M8b planu aplikacji mobilnej w
 * `lib/invoices/issue-correction.ts` (ta sama dla telefonu); tu tylko sesja
 * z ciasteczek i firma formularza.
 */

/**
 * `formTenant` — zapis korekty z formularza: firma formularza musi być firmą
 * aktywną teraz (UX-01). Odczyt faktury pierwotnej woła bez niego.
 */
async function tenantContext(formTenant?: FormTenantCheck): Promise<CorrectionIssueContext> {
  const { supabase, user, tenantId } = await requireUserAndActiveOrg(formTenant);
  return { supabase, userId: user.id, tenant: await readTenantSnapshot(supabase, tenantId) };
}

export async function getCorrectionParentContextAction(parentId: string): ReturnType<typeof getCorrectionParentContext> {
  return getCorrectionParentContext(() => tenantContext(), parentId);
}

/**
 * `expectedTenantId` — firma, dla której strona wyrenderowała formularz
 * (UX-01); tylko do porównania z firmą z ciasteczka. Także w wysyłce.
 */
export async function saveCorrectionDraftAction(
  raw: CorrectionInvoiceSchemaIn,
  expectedTenantId: string,
): Promise<CorrectionActionResult> {
  return saveCorrectionDraft(() => tenantContext({ expectedTenantId }), raw);
}

export async function saveAndSendCorrectionAction(
  raw: CorrectionInvoiceSchemaIn,
  expectedTenantId: string,
): Promise<CorrectionActionResult> {
  return saveAndSendCorrection(() => tenantContext({ expectedTenantId }), raw);
}
