'use server';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logAudit } from '@/lib/audit/log';
import {
  deleteInvoiceDefaults,
  validateInvoiceDefaults,
  writeInvoiceDefaults,
  type InvoiceDefaults,
} from '@/lib/invoices/invoice-defaults';
import { ActionAuthError, requireOrgRole } from '@/lib/supabase/auth-context';

/**
 * Domyślne ustawienia nowej faktury w Ustawieniach → Firma (plan kompletnej
 * aplikacji, krok 2.8). Zmienia właściciel i administrator (sprawdza też baza,
 * RLS 00209); zmiana i powrót do domyślnych trafiają do audytu, bez adresu
 * księgowej w treści wpisu. Logika: `lib/invoices/invoice-defaults.ts`.
 */

export type SaveInvoiceDefaultsResult = { success: true; defaults: InvoiceDefaults } | { success: false; error: string };
export type ResetInvoiceDefaultsResult = { success: true } | { success: false; error: string };

const ROLE_MESSAGE = 'Ustawienia nowej faktury zmienia właściciel albo administrator firmy. Poproś jedną z tych osób o zmianę.';
const SAVE_FAILED = 'Nie udało się zapisać ustawień. Sprawdź połączenie i spróbuj ponownie za chwilę.';

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

export async function saveInvoiceDefaultsAction(input: {
  paymentMethod: string | null;
  paymentDays: number | null;
  accountantCopyEmail: string | null;
}): Promise<SaveInvoiceDefaultsResult> {
  const auth = await ownerOrAdmin();
  if (!auth.ok) return { success: false, error: auth.error };
  const checked = validateInvoiceDefaults(input);
  if (!checked.ok) return { success: false, error: checked.error };
  const { supabase, user, tenantId } = auth.ctx;
  const defaults: InvoiceDefaults = {
    paymentMethod: checked.paymentMethod,
    paymentDays: checked.paymentDays,
    accountantCopyEmail: checked.accountantCopyEmail,
  };
  const saved = await writeInvoiceDefaults(supabase as unknown as SupabaseClient, { tenantId, userId: user.id, defaults });
  if (!saved) return { success: false, error: SAVE_FAILED };
  await logAudit({
    action: 'tenant.updated',
    tenantId,
    userId: user.id,
    entityType: 'tenant',
    entityId: tenantId,
    metadata: {
      field: 'invoice_defaults',
      change: 'updated',
      paymentMethod: defaults.paymentMethod,
      paymentDays: defaults.paymentDays,
      accountantCopy: defaults.accountantCopyEmail !== null,
    },
  });
  return { success: true, defaults };
}

export async function resetInvoiceDefaultsAction(): Promise<ResetInvoiceDefaultsResult> {
  const auth = await ownerOrAdmin();
  if (!auth.ok) return { success: false, error: auth.error };
  const { supabase, user, tenantId } = auth.ctx;
  const deleted = await deleteInvoiceDefaults(supabase as unknown as SupabaseClient, tenantId);
  if (!deleted) return { success: false, error: SAVE_FAILED };
  await logAudit({
    action: 'tenant.updated',
    tenantId,
    userId: user.id,
    entityType: 'tenant',
    entityId: tenantId,
    metadata: { field: 'invoice_defaults', change: 'reset' },
  });
  return { success: true };
}
