'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';

import { getReceivables, type Receivables } from '@/lib/dashboard/receivables';
import { sendEmail, type EmailStubResult } from '@/lib/email/send';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { normalizeNoteRecipient } from '@/lib/noty/mail';
import { loadCompanyPdfLogo } from '@/lib/pdf/logo-odczyt';
import { checkRateLimit } from '@/lib/rate-limit';
import { countBalanceEmailsTo, getBalanceConfirmation } from '@/lib/saldo/baza';
import { balanceEmailHtml, balanceEmailIdempotencyKey, balanceEmailSubject } from '@/lib/saldo/mail';
import {
  canIssueBalanceConfirmations,
  isBalanceRefusalCode,
  type BalanceConfirmation,
  type BalancePreview,
  type BalancePreviewResult,
} from '@/lib/saldo/model';
import { matchesReceivables, readBalancePreview } from '@/lib/saldo/oblicz';
import { balancePdfFilename, renderBalancePdf } from '@/lib/saldo/pdf';
import { BALANCE_REFUSALS, BALANCE_TEXTS, balanceEmailLimitMessage } from '@/lib/saldo/teksty';
import { czyPotwierdzenieSaldaWlaczone } from '@/lib/saldo/wylacznik';
import { ActionAuthError, requireUserAndActiveOrg, type AuthContext } from '@/lib/supabase/auth-context';

/**
 * Potwierdzenie salda z kontrahentem (plan kompletnej aplikacji, krok 2.9,
 * część 2, PR B; D26-D28): podgląd, wystawienie i wysyłka mailem. Ekrany są
 * w PR C.
 *
 * Firma i rola z sesji, klient z sesji, więc te same reguły egzekwuje baza
 * (RLS i funkcje 00216). Saldo liczy baza; akcja sprawdza je jeszcze
 * z należnościami Pulpitu (`matchesReceivables`): różnica zatrzymuje dokument
 * z wyjściem (Pomoc). Całość za wyłącznikiem `balanceConfirmationsEnabled`
 * (`lib/saldo/wylacznik.ts`), który sprawdza też baza.
 *
 * Ponowienie od zera (protokół, pkt 5):
 *  - podgląd: tylko odczyt;
 *  - wystawienie: RPC `issue_balance_confirmation` w jednej transakcji (numer,
 *    dokument, audyt); ta sama treść drugi raz oddaje ten sam dokument
 *    (`already_issued`), zmieniona treść odmowę `changed`;
 *  - mail: klucz `saldo/<id>/<skrót adresu>/<liczba zapisanych wysyłek>`
 *    i powtarzalny PDF, więc ponowienie po wysyłce bez zapisu historii nie
 *    wyśle drugiego maila (Resend, 24 h); zapis historii raz na klucz
 *    (`record_balance_confirmation_email`).
 */

type Failure = { success: false; error: string };
export type PreviewBalanceResult = { success: true; preview: BalancePreview } | Failure;
export type IssueBalanceResult = { success: true; id: string; number: string; alreadyIssued: boolean } | Failure;
export type SendBalanceEmailResult = { success: true; recipient: string } | Failure;

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINT_SHAPE = /^[0-9a-f]{32}$/;

/** Ile potwierdzeń salda firma może wysłać mailem w godzinie (jak noty i faktury, AUD-102). */
const BALANCE_EMAILS_PER_HOUR = 30;

/** Funkcje 00216 nie są jeszcze w `types/database.ts` (typy z produkcji po wgraniu migracji). */
function rpcClient(supabase: AuthContext['supabase']): SupabaseClient {
  return supabase as unknown as SupabaseClient;
}

async function writerContext(expectedTenantId?: string, disabledText: string = BALANCE_REFUSALS.disabled): Promise<{ ok: true; ctx: AuthContext } | { ok: false; error: string }> {
  let ctx: AuthContext;
  try {
    ctx = await requireUserAndActiveOrg(expectedTenantId === undefined ? undefined : { expectedTenantId });
  } catch (err) {
    if (err instanceof ActionAuthError) return { ok: false, error: err.message };
    throw err;
  }
  if (!canIssueBalanceConfirmations(ctx.role)) return { ok: false, error: BALANCE_TEXTS.role };
  let enabled: boolean;
  try {
    enabled = await czyPotwierdzenieSaldaWlaczone();
  } catch {
    return { ok: false, error: BALANCE_TEXTS.flagUnknown };
  }
  if (!enabled) return { ok: false, error: disabledText };
  return { ok: true, ctx };
}

/** Podgląd z bazy sprawdzony z należnościami Pulpitu. */
async function checkedPreview(ctx: AuthContext, contractorId: string): Promise<PreviewBalanceResult> {
  let result: BalancePreviewResult;
  try {
    result = await readBalancePreview(ctx.supabase, contractorId);
  } catch (err) {
    Sentry.captureException(err, { tags: { action: 'saldo.preview' } });
    return { success: false, error: BALANCE_TEXTS.readFailed };
  }
  if (!result.ok) return { success: false, error: BALANCE_REFUSALS[result.code] };

  let receivables: Receivables;
  try {
    receivables = await getReceivables(ctx.supabase, ctx.tenantId);
  } catch (err) {
    Sentry.captureException(err, { tags: { action: 'saldo.receivables' } });
    return { success: false, error: BALANCE_TEXTS.receivablesFailed };
  }
  if (!matchesReceivables(result.preview, receivables)) {
    Sentry.captureMessage('Potwierdzenie salda: saldo z bazy różne od należności Pulpitu', {
      level: 'error',
      tags: { action: 'saldo.mismatch' },
      extra: { tenantId: ctx.tenantId, contractorId },
    });
    return { success: false, error: BALANCE_TEXTS.pulpitMismatch };
  }
  return { success: true, preview: result.preview };
}

/**
 * Podgląd salda kontrahenta: pozycje, pominięte dokumenty, saldo i odcisk do
 * wystawienia. Formularz odsyła firmę, dla której go wyrenderowano (UX-01).
 */
export async function previewBalanceConfirmationAction(contractorId: string, expectedTenantId: string): Promise<PreviewBalanceResult> {
  if (typeof contractorId !== 'string' || !UUID_SHAPE.test(contractorId)) {
    return { success: false, error: BALANCE_REFUSALS.contractor_not_found };
  }
  const auth = await writerContext(expectedTenantId);
  if (!auth.ok) return { success: false, error: auth.error };
  return checkedPreview(auth.ctx, contractorId);
}

export interface IssueBalanceInput {
  contractorId: string;
  /** Odcisk z podglądu, który klient widział. */
  fingerprint: string;
  /** Świadome „Wystaw bez tych dokumentów” przy niepustej liście pominiętych (D27 K4). */
  withoutOmitted: boolean;
}

/**
 * Wystawienie: treść liczy baza od nowa i przyjmuje tylko odcisk z podglądu;
 * numer, dokument i audyt w jednej transakcji (RPC `issue_balance_confirmation`).
 * Przed RPC to samo sprawdzenie z Pulpitem co w podglądzie.
 */
export async function issueBalanceConfirmationAction(input: IssueBalanceInput, expectedTenantId: string): Promise<IssueBalanceResult> {
  const contractorId = typeof input?.contractorId === 'string' ? input.contractorId : '';
  const fingerprint = typeof input?.fingerprint === 'string' ? input.fingerprint : '';
  if (!UUID_SHAPE.test(contractorId)) return { success: false, error: BALANCE_REFUSALS.contractor_not_found };
  if (!FINGERPRINT_SHAPE.test(fingerprint)) return { success: false, error: BALANCE_REFUSALS.changed };
  const auth = await writerContext(expectedTenantId);
  if (!auth.ok) return { success: false, error: auth.error };

  const checked = await checkedPreview(auth.ctx, contractorId);
  if (!checked.success) return checked;
  if (checked.preview.fingerprint !== fingerprint) return { success: false, error: BALANCE_REFUSALS.changed };

  const { data, error } = await rpcClient(auth.ctx.supabase).rpc('issue_balance_confirmation', {
    p_contractor_id: contractorId,
    p_ksef_environment: requireConfiguredKsefEnvironment(),
    p_fingerprint: fingerprint,
    p_without_omitted: input.withoutOmitted === true,
  });
  if (error) {
    if (error.code !== '42501') Sentry.captureException(error, { tags: { action: 'saldo.issue' } });
    return { success: false, error: error.code === '42501' ? BALANCE_TEXTS.role : BALANCE_TEXTS.issueFailed };
  }
  const result = (data ?? null) as { status?: unknown; id?: unknown; number?: unknown; code?: unknown } | null;
  if (
    (result?.status === 'issued' || result?.status === 'already_issued') &&
    typeof result.id === 'string' &&
    typeof result.number === 'string'
  ) {
    revalidatePath('/noty');
    revalidatePath('/contractors');
    return { success: true, id: result.id, number: result.number, alreadyIssued: result.status === 'already_issued' };
  }
  return { success: false, error: isBalanceRefusalCode(result?.code) ? BALANCE_REFUSALS[result.code] : BALANCE_TEXTS.issueFailed };
}

function sendRefusal(result: EmailStubResult): string {
  if (result.reason === 'not-configured') return BALANCE_TEXTS.emailNotConfigured;
  if (result.reason === 'hard_bounce' || result.reason === 'complaint') return BALANCE_TEXTS.emailBlocked;
  return BALANCE_TEXTS.emailFailed;
}

/** Wysyłka wystawionego potwierdzenia salda mailem z PDF do kontrahenta (opis ponowienia w nagłówku pliku). */
export async function sendBalanceConfirmationEmailAction(confirmationId: string, recipientEmail: string): Promise<SendBalanceEmailResult> {
  const recipient = normalizeNoteRecipient(typeof recipientEmail === 'string' ? recipientEmail : '');
  if (!recipient) return { success: false, error: BALANCE_TEXTS.emailInvalid };
  if (typeof confirmationId !== 'string' || !UUID_SHAPE.test(confirmationId)) return { success: false, error: BALANCE_TEXTS.notFound };
  const auth = await writerContext(undefined, BALANCE_TEXTS.emailDisabled);
  if (!auth.ok) return { success: false, error: auth.error };
  const { supabase, tenantId } = auth.ctx;

  // Limit na firmę przed PDF i wysyłką: mail idzie z domeny FaktWay na dowolny adres.
  const quota = await checkRateLimit({
    bucket: 'balance_confirmation_email',
    identifier: tenantId,
    limit: BALANCE_EMAILS_PER_HOUR,
    windowSeconds: 3600,
  });
  if (!quota.allowed) return { success: false, error: balanceEmailLimitMessage(BALANCE_EMAILS_PER_HOUR) };

  let doc: BalanceConfirmation | null;
  let previousSends = 0;
  try {
    doc = await getBalanceConfirmation(supabase, tenantId, confirmationId);
    if (doc) previousSends = await countBalanceEmailsTo(supabase, tenantId, confirmationId, recipient);
  } catch {
    return { success: false, error: BALANCE_TEXTS.documentReadFailed };
  }
  if (!doc) return { success: false, error: BALANCE_TEXTS.notFound };

  // Logo firmy z ustawień (krok 2.2); bez pliku albo przy błędzie PDF bez logo.
  const companyLogo = await loadCompanyPdfLogo(tenantId);
  const pdf = await renderBalancePdf(doc, { logo: companyLogo.logo });
  const content = { number: doc.number, asOf: doc.asOf, total: doc.total, issuerName: doc.issuer.name };
  const idempotencyKey = balanceEmailIdempotencyKey(doc.id, recipient, previousSends, companyLogo.logo ? companyLogo.key : null);

  let sent: EmailStubResult;
  try {
    sent = await sendEmail({
      to: recipient,
      subject: balanceEmailSubject(content),
      html: balanceEmailHtml(content),
      category: 'transactional',
      attachments: [{ filename: balancePdfFilename(doc.number), content: pdf }],
      idempotencyKey,
    });
  } catch (err) {
    // Dwa kliknięcia naraz: Resend odrzuca drugie żądanie z tym samym kluczem (409).
    const message = err instanceof Error ? err.message : '';
    return {
      success: false,
      error: /concurrent_idempotent_requests/.test(message) ? BALANCE_TEXTS.emailInProgress : BALANCE_TEXTS.emailFailed,
    };
  }
  if (!sent.sent) return { success: false, error: sendRefusal(sent) };

  const { data, error } = await rpcClient(supabase).rpc('record_balance_confirmation_email', {
    p_confirmation_id: doc.id,
    p_recipient: recipient,
    p_idempotency_key: idempotencyKey,
    p_provider_message_id: sent.messageId ?? null,
  });
  const status = (data as { status?: unknown } | null)?.status;
  if (error || (status !== 'recorded' && status !== 'already_recorded')) {
    return { success: false, error: BALANCE_TEXTS.emailNotRecorded };
  }

  revalidatePath('/noty');
  return { success: true, recipient };
}
