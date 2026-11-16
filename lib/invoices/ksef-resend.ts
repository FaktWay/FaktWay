import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';

import {
  KSEF_RESEND_SOURCE_COLUMNS,
  ksefResendFacts,
  ksefSendPayloadFromRow,
} from '@/lib/invoices/ksef-requeue-event';
import { enqueueKsefSubmitAfterDraft, type TokenSessionSendActor } from '@/lib/invoices/ksef-submit-enqueue';
import {
  canManageKsefSend,
  decideResend,
  describeResetError,
  KSEF_SEND_MESSAGES,
} from '@/lib/invoices/ksef-send-policy';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { createAdminClient } from '@/lib/supabase/admin';
import { ActionAuthError, type requireUserAndActiveOrg, type UserRole } from '@/lib/supabase/auth-context';
import { validateInvoice } from '@/lib/xml/invoice-calculator';

/**
 * „Wyślij ponownie” i „Wróć do szkicu” po nieudanej wysyłce do KSeF (plan
 * aplikacji mobilnej, etap M8b; wzór `lib/invoices/send-draft.ts`). Do M8b ta
 * logika siedziała w `resendInvoiceAction` i `resetInvoiceToDraftAction`
 * (`components/invoices/actions-detail.ts`), które czytają sesję z ciasteczek.
 * Teraz akcje strony i trasy telefonu wołają te same funkcje; wołający podaje
 * sesję, firmę i rolę leniwie (wewnątrz `try`), więc odmowy i komunikaty są
 * takie jak przed wydzieleniem.
 */

type SessionClient = Awaited<ReturnType<typeof requireUserAndActiveOrg>>['supabase'];

/** Sesja ponowienia: klient z sesją klienta (RLS), firma i rola z sesji (strona) albo z bramki telefonu. */
export interface KsefResendContext {
  supabase: SessionClient;
  userId: string;
  tenantId: string;
  role: UserRole;
  /** Telefon: 2FA i znacznik KSeF z tokenu zamiast z ciasteczek (`ksef-submit-enqueue.ts`). */
  tokenSession?: TokenSessionSendActor;
}

// ═══════════════════════════════════════════════════════════════
// resendInvoiceAction
// ═══════════════════════════════════════════════════════════════

export type ResendResult =
  | { success: true }
  | { success: false; error: string; code?: 'KSEF_NOT_VERIFIED' | 'MFA_REQUIRED' };

interface ResendRow {
  ksef_status: string | null;
  direction: string | null;
  invoice_kind: string | null;
  invoice_type: string | null;
  last_error_code: string | null;
  issue_date: string | null;
  fa3_data: unknown;
  special_data: unknown;
}

/** Kolumny źródła ponowienia (A4b) + stan wysyłki. */
const RESEND_ROW_COLUMNS = `${KSEF_RESEND_SOURCE_COLUMNS}, ksef_status, direction, invoice_type, last_error_code` as const;

/**
 * „Wyślij ponownie” (cykl życia faktury, PR 3b — K3): `failed → queued` przez
 * RPC `requeue_ksef_send` w jednej transakcji ze zleceniem pg-boss. Kto i kiedy:
 * `lib/invoices/ksef-send-policy.ts` (właściciel/admin — D4; `rejected` nigdy,
 * wraca do szkicu — D2; klasy terminal/hold/reconcile nie). Runner i tak
 * zaczyna od uzgodnienia po referencji, więc historyczny `failed` bez kodu
 * nie wysyła faktury drugi raz, jeśli KSeF ją ma.
 *
 * Korektę, zaliczkę i ROZ wysyłamy z kopii na wierszu (A4b PR2b) — te same
 * fakty i builder co cron i operator; tylko w dniu wystawienia (decyzja b),
 * po północy worker kończy kodem ISSUE_DATE_PASSED. `validateInvoice` tylko
 * dla zwykłej faktury: korekta anulująca ma ujemne ilości, a treść dokumentu
 * specjalnego sprawdził zapis, generator i XSD.
 */
export async function resendInvoice(
  context: () => Promise<KsefResendContext>,
  invoiceId: string
): Promise<ResendResult> {
  try {
    const { supabase, userId, tenantId, role, tokenSession } = await context();
    if (!canManageKsefSend(role)) {
      return { success: false, error: KSEF_SEND_MESSAGES.role };
    }
    const { data, error } = await supabase
      .from('invoices')
      .select(RESEND_ROW_COLUMNS)
      .eq('id', invoiceId)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (error || !data) {
      return { success: false, error: KSEF_SEND_MESSAGES.notFound };
    }
    const row = data as unknown as ResendRow;
    const env = configuredKsefEnvironment();
    const now = new Date();
    const facts = ksefResendFacts(row, env, now);
    const decision = decideResend({
      direction: row.direction,
      status: row.ksef_status,
      errorCode: row.last_error_code,
      invoiceKind: row.invoice_kind,
      facts,
      environmentKnown: env !== null,
    });
    if (!decision.allowed) {
      if (decision.reason === 'reconcile') {
        // Klient prosi o wysyłkę faktury „do uzgodnienia” — operator ma to zobaczyć.
        Sentry.captureMessage('Klient prosi o ponowną wysyłkę faktury wymagającej uzgodnienia', {
          level: 'warning',
          tags: { area: 'ksef.resend' },
          extra: { tenantId, invoiceId, code: row.last_error_code },
        });
      }
      return { success: false, error: decision.message };
    }

    const built = ksefSendPayloadFromRow(row, { environment: env, reconcileOnly: false, now });
    if (!built.ok) {
      // Nieosiągalne: decyzja wyżej odmówiła braku danych, rodzaju i daty na tych samych faktach.
      throw new Error(`resend: decyzja i dane zdarzenia się rozjechały (${built.reason})`);
    }
    const payload = built.payload;
    const invoice = payload.invoice;
    if (payload.auditKind === 'regular') {
      const problems = validateInvoice(invoice);
      if (problems.length > 0) {
        return { success: false, error: problems[0]! };
      }
    }

    const { data: tenant } = await supabase
      .from('tenants')
      .select('nip')
      .eq('id', tenantId)
      .maybeSingle();
    const nip = (tenant?.nip as string | null | undefined) ?? invoice.seller?.nip;
    if (!nip) return { success: false, error: 'Brak NIP firmy.' };

    const enq = await enqueueKsefSubmitAfterDraft({
      supabase,
      tenantId,
      userId,
      invoiceId,
      nip,
      invoice,
      correctionData: payload.correctionData,
      advanceData: payload.advanceData,
      finalData: payload.finalData,
      finalAdvanceSettlementRows: payload.finalAdvanceSettlementRows,
      auditKind: payload.auditKind,
      internalNumberForAudit: invoice.internalNumber,
      mode: { kind: 'requeue', actorUserId: userId },
      ...(tokenSession ? { tokenSession } : {}),
    });
    if (!enq.ok) {
      return enq.code
        ? { success: false, error: enq.error, code: enq.code }
        : { success: false, error: enq.error };
    }

    revalidatePath('/invoices');
    revalidatePath(`/invoices/${invoiceId}`);
    return { success: true };
  } catch (err) {
    if (err instanceof ActionAuthError) {
      return { success: false, error: err.message };
    }
    // Np. kolumna spoza KSEF_RESEND_SOURCE_COLUMNS albo rozjazd decyzji — błąd programu, nie klienta.
    Sentry.captureException(err, { tags: { area: 'ksef.resend' }, extra: { invoiceId } });
    return {
      success: false,
      error: 'Nie można sprawdzić możliwości ponownej wysyłki. Spróbuj później.',
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// resetInvoiceToDraftAction
// ═══════════════════════════════════════════════════════════════

export type ResetToDraftResult =
  | { success: true }
  | { success: false; error: string };

/**
 * „Wróć do szkicu” (PR 3b, decyzja D2): `failed`/`rejected → draft` przez RPC
 * `reset_ksef_send` (00131). RPC odmawia, gdy faktura ma dowód kontaktu
 * z KSeF (numer KSeF albo wpis `sent`/`accepted`/`duplicate`) albo kod klasy
 * reconcile — wtedy sprawą zajmuje się operator. Klucz serwisowy, bo
 * przejścia stanu są serwerowe (RPC przepuszczają tylko service_role);
 * firma i rola pochodzą z sesji (`requireOrgRole`).
 */
export async function resetInvoiceToDraft(
  context: () => Promise<{ userId: string; tenantId: string }>,
  invoiceId: string
): Promise<ResetToDraftResult> {
  try {
    const { userId, tenantId } = await context();
    const { error } = await createAdminClient().rpc('reset_ksef_send', {
      p_invoice_id: invoiceId,
      p_tenant_id: tenantId,
      p_actor_user_id: userId,
    });
    if (error) {
      return { success: false, error: describeResetError(error) };
    }
    revalidatePath('/invoices');
    revalidatePath(`/invoices/${invoiceId}`);
    return { success: true };
  } catch (err) {
    if (err instanceof ActionAuthError) {
      return { success: false, error: err.message };
    }
    return { success: false, error: KSEF_SEND_MESSAGES.resetFailed };
  }
}

