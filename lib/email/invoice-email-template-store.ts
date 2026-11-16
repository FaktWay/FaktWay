/**
 * Szablon maila z fakturą w bazie (plan kompletnej aplikacji, krok 2.8,
 * migracja 00208): jeden wiersz na firmę w `invoice_email_templates`.
 * Odczyt nigdy nie psuje wysyłki: brak wiersza, błąd bazy, brak tabeli albo
 * szablon, który dziś nie przechodzi walidacji, to `null` i mail idzie domyślny.
 * Zapis i usunięcie (owner i administrator, RLS) robią akcje z wpisem w audycie.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { validateInvoiceEmailTemplate, type InvoiceEmailTemplate } from './invoice-email-template';

export async function readInvoiceEmailTemplate(db: SupabaseClient, tenantId: string): Promise<InvoiceEmailTemplate | null> {
  try {
    const { data, error } = await db.from('invoice_email_templates').select('subject, body').eq('tenant_id', tenantId).maybeSingle();
    if (error || !data) return null;
    const checked = validateInvoiceEmailTemplate(data as { subject: unknown; body: unknown });
    return checked.ok ? { subject: checked.subject, body: checked.body } : null;
  } catch {
    return null;
  }
}

export async function writeInvoiceEmailTemplate(
  db: SupabaseClient,
  input: { tenantId: string; userId: string; template: InvoiceEmailTemplate },
): Promise<boolean> {
  try {
    const { error } = await db.from('invoice_email_templates').upsert(
      {
        tenant_id: input.tenantId,
        subject: input.template.subject,
        body: input.template.body,
        updated_at: new Date().toISOString(),
        updated_by: input.userId,
      },
      { onConflict: 'tenant_id' },
    );
    return !error;
  } catch {
    return false;
  }
}

export async function deleteInvoiceEmailTemplate(db: SupabaseClient, tenantId: string): Promise<boolean> {
  try {
    const { error } = await db.from('invoice_email_templates').delete().eq('tenant_id', tenantId);
    return !error;
  } catch {
    return false;
  }
}
