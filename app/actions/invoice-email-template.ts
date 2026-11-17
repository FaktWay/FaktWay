'use server';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logAudit } from '@/lib/audit/log';
import { validateInvoiceEmailTemplate, type InvoiceEmailTemplate } from '@/lib/email/invoice-email-template';
import { deleteInvoiceEmailTemplate, writeInvoiceEmailTemplate } from '@/lib/email/invoice-email-template-store';
import { ActionAuthError, requireOrgRole } from '@/lib/supabase/auth-context';

/**
 * Własny szablon maila z fakturą w Ustawieniach → Firma (plan kompletnej
 * aplikacji, krok 2.8). Zmienia właściciel i administrator (sprawdza też baza,
 * RLS 00208); zapis i powrót do domyślnego trafiają do audytu. Logika
 * szablonu: `lib/email/invoice-email-template.ts`.
 */

export type SaveInvoiceEmailTemplateResult =
  | { success: true; template: InvoiceEmailTemplate }
  | { success: false; error: string };
export type ResetInvoiceEmailTemplateResult = { success: true } | { success: false; error: string };

const ROLE_MESSAGE = 'Szablon maila z fakturą zmienia właściciel albo administrator firmy. Poproś jedną z tych osób o zmianę.';
const SAVE_FAILED = 'Nie udało się zapisać szablonu. Sprawdź połączenie i spróbuj ponownie za chwilę.';

async function ownerOrAdmin() {
  try {
    return { ok: true as const, ctx: await requireOrgRole(['owner', 'admin']) };
  } catch (e) {
    if (e instanceof ActionAuthError) {
      return { ok: false as const, error: e.message === 'Niewystarczające uprawnienia' ? ROLE_MESSAGE : e.message };
    }
    throw e;
  }
}

export async function saveInvoiceEmailTemplateAction(input: { subject: string; body: string }): Promise<SaveInvoiceEmailTemplateResult> {
  const auth = await ownerOrAdmin();
  if (!auth.ok) return { success: false, error: auth.error };
  const checked = validateInvoiceEmailTemplate(input);
  if (!checked.ok) return { success: false, error: checked.error };
  const { supabase, user, tenantId } = auth.ctx;
  const template = { subject: checked.subject, body: checked.body };
  const saved = await writeInvoiceEmailTemplate(supabase as unknown as SupabaseClient, { tenantId, userId: user.id, template });
  if (!saved) return { success: false, error: SAVE_FAILED };
  await logAudit({
    action: 'tenant.updated',
    tenantId,
    userId: user.id,
    entityType: 'tenant',
    entityId: tenantId,
    metadata: { field: 'invoice_email_template', change: 'updated', subjectLength: template.subject.length, bodyLength: template.body.length },
  });
  return { success: true, template };
}

export async function resetInvoiceEmailTemplateAction(): Promise<ResetInvoiceEmailTemplateResult> {
  const auth = await ownerOrAdmin();
  if (!auth.ok) return { success: false, error: auth.error };
  const { supabase, user, tenantId } = auth.ctx;
  const deleted = await deleteInvoiceEmailTemplate(supabase as unknown as SupabaseClient, tenantId);
  if (!deleted) return { success: false, error: SAVE_FAILED };
  await logAudit({
    action: 'tenant.updated',
    tenantId,
    userId: user.id,
    entityType: 'tenant',
    entityId: tenantId,
    metadata: { field: 'invoice_email_template', change: 'reset' },
  });
  return { success: true };
}
