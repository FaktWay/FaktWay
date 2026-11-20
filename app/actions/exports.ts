'use server';

import { revalidatePath } from 'next/cache';
import { sendJobEvent } from '@/lib/jobs/enqueue';

import { requireCodeForAccessGrant } from '@/lib/auth/access-grant-mfa';
import { exportsCoPilotSendPackage } from '@/lib/jobs/events';
import { formatJobSendError } from '@/lib/jobs/error-message';
import {
  ActionAuthError,
  requireOrgRole,
  requireUserAndTenant,
} from '@/lib/supabase/auth-context';
import { downloadExportFile, isExportDbFormat, startManualExport } from '@/lib/exports/eksport-reczny';
import { isExportFormatSuspended } from '@/lib/exports/suspended-formats';
import type { Database } from '@/types/database';

export type ExportFormatParam =
  | 'jpk_fa'
  | 'jpk_v7m'
  | 'kpir_excel'
  | 'comarch_optima'
  | 'insert_subiekt'
  | 'symfonia'
  | 'wapro';

function parsePreferredFormats(formats: string[]) {
  const out = formats.filter(isExportDbFormat).filter((f) => !isExportFormatSuspended(f));
  return [...new Set(out)];
}

function inngestEventIdFromSendResult(result: unknown): string {
  if (
    typeof result === 'object' &&
    result !== null &&
    'ids' in result &&
    Array.isArray((result as { ids: unknown }).ids)
  ) {
    const ids = (result as { ids: unknown[] }).ids;
    const first = ids[0];
    return typeof first === 'string' ? first : '';
  }
  return '';
}

// ============================================================================
// Manual export trigger
// ============================================================================

export async function startExportAction(params: {
  format: ExportFormatParam | 'csv_universal';
  periodStart: string;
  periodEnd: string;
  includeIssued?: boolean;
  includeReceived?: boolean;
  includeCorrections?: boolean;
}): Promise<
  | { success: true; jobId: string }
  | { success: false; error: string }
> {
  let ctx;
  try {
    ctx = await requireUserAndTenant();
  } catch (e) {
    if (e instanceof ActionAuthError) {
      return { success: false, error: e.message };
    }
    throw e;
  }
  // Format, zakres, job i zdarzenie: `lib/exports/eksport-reczny.ts` (to samo dla telefonu, M10d).
  return startManualExport({ client: ctx.supabase, tenantId: ctx.tenantId, userId: ctx.user.id }, params);
}

// ============================================================================
// Pobierz wygenerowany plik
// ============================================================================


export async function downloadExportFileAction(
  fileId: string,
): Promise<
  | { success: true; base64: string; filename: string; mimeType: string }
  | { success: false; error: string }
> {
  let ctx;
  try {
    ctx = await requireUserAndTenant();
  } catch (e) {
    if (e instanceof ActionAuthError) {
      return { success: false, error: e.message };
    }
    throw e;
  }
  return downloadExportFile({ client: ctx.supabase, tenantId: ctx.tenantId, userId: ctx.user.id }, fileId);
}

// ============================================================================
// Co-Pilot settings update
// ============================================================================

export type AccountantSettingsUpsertPayload = Pick<
  Database['public']['Tables']['accountant_settings']['Insert'],
  | 'tenant_id'
  | 'co_pilot_enabled'
  | 'accountant_email'
  | 'accountant_name'
  | 'preferred_formats'
  | 'send_day_of_month'
  | 'include_issued_invoices'
  | 'include_received_invoices'
  | 'include_corrections'
> &
  Partial<
    Pick<
      Database['public']['Tables']['accountant_settings']['Insert'],
      'accountant_company' | 'cc_emails'
    >
  >;

export async function updateAccountantSettingsAction(settings: {
  co_pilot_enabled: boolean;
  accountant_email: string;
  accountant_name: string;
  accountant_company?: string;
  preferred_formats: string[];
  send_day_of_month: number;
  include_issued_invoices: boolean;
  include_received_invoices: boolean;
  include_corrections: boolean;
  cc_emails?: string[];
}): Promise<
  | { success: true }
  // `mfaStepUp`: konto ma 2FA, a ta sesja (logowanie biometrią) kodu nie podała. Formularz pokazuje
  // wtedy przejście na ekran kodu (`MfaStepUpNotice`), nie sam tekst błędu.
  | { success: false; error: string; mfaStepUp?: true }
> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) {
      return { success: false, error: e.message };
    }
    throw e;
  }
  const { supabase, tenantId, user } = ctx;

  if (settings.co_pilot_enabled && !settings.accountant_email?.trim()) {
    return { success: false, error: 'Email księgowego wymagany' };
  }

  const trimmedEmail = settings.accountant_email.trim();
  if (trimmedEmail.length > 0 && !isValidEmail(trimmedEmail)) {
    return { success: false, error: 'Nieprawidłowy email' };
  }

  if (
    settings.send_day_of_month < 1 ||
    settings.send_day_of_month > 28
  ) {
    return {
      success: false,
      error: 'Dzień miesiąca musi być między 1 a 28',
    };
  }

  const parsedFormats = parsePreferredFormats(settings.preferred_formats ?? []);
  if (
    settings.co_pilot_enabled &&
    parsedFormats.length === 0
  ) {
    return {
      success: false,
      error: 'Wybierz co najmniej jeden rozpoznawalny format eksportu',
    };
  }

  // Adres księgowej i kopie dostają co miesiąc JPK i KPiR firmy, a "Wyślij teraz" zapisuje te
  // ustawienia przed wysyłką. Sesja po biometrii potrzebuje więc kodu (jak przy zaproszeniach).
  // `triggerCoPilotNowAction` adresu nie przyjmuje (bierze go z zapisanych ustawień), więc kroku nie ma.
  const stepUp = await requireCodeForAccessGrant(supabase, user.id, 'Zmiana ustawień wysyłki dla księgowej');
  if (stepUp) return stepUp;

  const upsertPayload: AccountantSettingsUpsertPayload = {
    tenant_id: tenantId,
    co_pilot_enabled: settings.co_pilot_enabled,
    accountant_email: trimmedEmail.length > 0 ? trimmedEmail : null,
    accountant_name: settings.accountant_name.trim() || null,
    preferred_formats:
      parsedFormats.length > 0 ? parsedFormats : ['jpk_fa', 'kpir_excel'],
    send_day_of_month: settings.send_day_of_month,
    include_issued_invoices: settings.include_issued_invoices,
    include_received_invoices: settings.include_received_invoices,
    include_corrections: settings.include_corrections,
    accountant_company:
      settings.accountant_company?.trim() || undefined,
    cc_emails: settings.cc_emails ?? undefined,
  };

  const { error } = await supabase
    .from('accountant_settings')
    .upsert(pickDefined(upsertPayload), { onConflict: 'tenant_id' });

  if (error) return { success: false, error: error.message };

  revalidatePath('/settings/accountant');
  return { success: true };
}

// ============================================================================
// Manual trigger Co-Pilota (dla teraz)
// ============================================================================

export async function triggerCoPilotNowAction(
  periodMonth: number,
  periodYear: number,
): Promise<{ success: true; jobId: string } | { success: false; error: string }> {
  if (
    !Number.isInteger(periodMonth) ||
    periodMonth < 1 ||
    periodMonth > 12 ||
    !Number.isInteger(periodYear) ||
    periodYear < 1970 ||
    periodYear > 2100
  ) {
    return { success: false, error: 'Niepoprawny okres' };
  }

  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) {
      return { success: false, error: e.message };
    }
    throw e;
  }
  const { supabase, tenantId } = ctx;

  const periodStart = dateToIsoDate(
    new Date(Date.UTC(periodYear, periodMonth - 1, 1)),
  );
  const periodEnd = dateToIsoDate(new Date(Date.UTC(periodYear, periodMonth, 0)));

  const { data: settings } = await supabase
    .from('accountant_settings')
    .select('*')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!settings?.accountant_email?.trim()) {
    return {
      success: false,
      error: 'Skonfiguruj księgową w Ustawienia → Księgowa',
    };
  }

  if (!settings.co_pilot_enabled) {
    return {
      success: false,
      error: 'Włącz Co-Pilota w ustawieniach księgowej',
    };
  }

  const formats = parsePreferredFormats(settings.preferred_formats ?? []);
  if (formats.length === 0) {
    return {
      success: false,
      error: 'Ustaw co najmniej jeden preferowany format eksportu',
    };
  }

  try {
    const sent = await sendJobEvent(
      exportsCoPilotSendPackage.create({
        tenantId,
        periodStart,
        periodEnd,
        formats,
        accountantEmail: settings.accountant_email.trim(),
        accountantName: settings.accountant_name,
        manual: true,
      }),
    );
    return {
      success: true,
      jobId: inngestEventIdFromSendResult(sent),
    };
  } catch (e) {
    return { success: false, error: formatJobSendError(e) };
  }
}

// ============================================================================
// Helpers
// ============================================================================

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Usuwa pola z `undefined` zachowując wnioskowanie typów. Zamiast podwójnego
 * castu (`as Record<string, unknown>` → `as TPayload`), generic zwraca
 * `Partial<T>` ze wszystkimi propami z oryginalnego typu — Supabase'owy
 * `.upsert(...)` dostaje akceptowalny shape bez utraty bezpieczeństwa typów.
 *
 * Specjalnie nie używamy `Pick`/`Omit` na kluczach, bo runtime nie wie, które
 * pola są undefined w tym konkretnym wywołaniu — `Partial<T>` to najwęższy
 * typ pasujący do każdej możliwej kombinacji.
 */
function pickDefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined) {
      out[key] = obj[key];
    }
  }
  return out;
}

/** Data w UTC jako YYYY-MM-DD (bez przesunięcia strefy lokalnej). */
function dateToIsoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
