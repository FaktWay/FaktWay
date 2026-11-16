'use server';

import {
  AUTH_BUSY_MESSAGE,
  isAuthRateLimited,
  isAuthServiceFailure,
  logAuthServiceFailure,
  SESSION_RETRY_MESSAGE,
} from '@/lib/auth/gotrue-errors';
import {
  KsefNotVerifiedError,
  requireKsefVerification,
} from '@/lib/auth/ksef-verification-guard';
import { createClient } from '@/lib/supabase/server';
import { downloadUpoPdf, downloadUpoXml } from '@/lib/ksef/upo-storage';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';

type Refusal = { success: false; error: string };

/**
 * Zalogowany użytkownik. Limit albo awaria GoTrue (429, 5xx, brak sieci) to
 * „spróbuj ponownie” z wpisem w logu, a nie „Niezalogowany” (plan skalowania
 * 3000, sesja 7). Brak sesji i odrzucony token zostają „Niezalogowany”.
 */
async function signedInRefusal(supabase: Awaited<ReturnType<typeof createClient>>): Promise<Refusal | null> {
  const { data, error } = await supabase.auth.getUser();
  if (data.user) return null;
  if (error && isAuthServiceFailure(error)) {
    logAuthServiceFailure('akcja', error);
    return { success: false, error: isAuthRateLimited(error) ? AUTH_BUSY_MESSAGE : SESSION_RETRY_MESSAGE };
  }
  return { success: false, error: 'Niezalogowany' };
}

/** Błąd bazy przy odczycie faktury to nie „Faktura nie znaleziona” (plan skalowania 3000, sesja 7). */
function invoiceReadFailed(error: { code?: string }): Refusal {
  console.warn('[upo] Odczyt faktury nie powiódł się', { code: error.code ?? null });
  return { success: false, error: 'Nie udało się odczytać faktury. Spróbuj ponownie za chwilę.' };
}

function upoPdfFilename(
  internalNumber: string | null | undefined,
  invoiceId: string,
): string {
  const base =
    typeof internalNumber === 'string' && internalNumber.trim() !== ''
      ? internalNumber.trim()
      : invoiceId;
  return `UPO-${base.replace(/[/\\]/g, '-')}.pdf`;
}

export async function getUpoPdfAction(
  invoiceId: string,
): Promise<
  | { success: true; pdfBase64: string; filename: string }
  | { success: false; error: string }
> {
  const supabase = await createClient();
  const refusal = await signedInRefusal(supabase);
  if (refusal) return refusal;

  const { data: invoice, error: invError } = await supabase
    .from('invoices')
    .select('id, tenant_id, internal_number, ksef_status, ksef_number, ksef_environment')
    .eq('id', invoiceId)
    .maybeSingle();

  if (invError) return invoiceReadFailed(invError);
  if (!invoice) {
    return { success: false, error: 'Faktura nie znaleziona' };
  }

  try {
    await requireKsefVerification(invoice.tenant_id as string);
  } catch (e) {
    if (e instanceof KsefNotVerifiedError) {
      return {
        success: false,
        error:
          'Weryfikacja KSeF wymagana przed pobraniem UPO (PDF). Uzupełnij ją w Ustawieniach → KSeF.',
      };
    }
    throw e;
  }

  if (invoice.ksef_status !== 'accepted') {
    return {
      success: false,
      error: 'UPO dostępne tylko dla zaakceptowanych faktur',
    };
  }

  const environment = configuredKsefEnvironment();
  if (!environment || invoice.ksef_environment !== environment) {
    return { success: false, error: 'Środowisko tej faktury KSeF wymaga uzgodnienia przed pobraniem UPO.' };
  }

  const { data: upo, error: upoError } = await supabase
    .from('upo_receipts')
    .select('status, tenant_id, ksef_number, ksef_environment')
    .eq('invoice_id', invoiceId)
    .maybeSingle();

  if (upoError || !upo || upo.status !== 'downloaded' ||
      upo.tenant_id !== invoice.tenant_id ||
      upo.ksef_number !== invoice.ksef_number ||
      upo.ksef_environment !== environment) {
    return {
      success: false,
      error:
        'UPO jeszcze nie zostało pobrane. Spróbuj za chwilę — KSeF generuje je asynchronicznie.',
    };
  }

  try {
    const pdfBuffer = await downloadUpoPdf(invoice.tenant_id, invoiceId);
    return {
      success: true,
      pdfBase64: pdfBuffer.toString('base64'),
      filename: upoPdfFilename(invoice.internal_number, invoiceId),
    };
  } catch {
    return {
      success: false,
      error: 'Błąd pobierania UPO z storage',
    };
  }
}

export async function getUpoXmlAction(
  invoiceId: string,
): Promise<{ success: true; xml: string } | { success: false; error: string }> {
  const supabase = await createClient();
  const refusal = await signedInRefusal(supabase);
  if (refusal) return refusal;

  const { data: invoice, error: invError } = await supabase
    .from('invoices')
    .select('id, tenant_id, ksef_status, ksef_number, ksef_environment')
    .eq('id', invoiceId)
    .maybeSingle();

  if (invError) return invoiceReadFailed(invError);
  if (!invoice) return { success: false, error: 'Faktura nie znaleziona' };

  if (invoice.ksef_status !== 'accepted') {
    return {
      success: false,
      error: 'UPO dostępne tylko dla zaakceptowanych faktur',
    };
  }

  const environment = configuredKsefEnvironment();
  if (!environment || invoice.ksef_environment !== environment) {
    return { success: false, error: 'Środowisko tej faktury KSeF wymaga uzgodnienia przed pobraniem UPO.' };
  }

  const { data: upo, error: upoError } = await supabase
    .from('upo_receipts')
    .select('status, tenant_id, ksef_number, ksef_environment')
    .eq('invoice_id', invoiceId)
    .maybeSingle();

  if (upoError || !upo || upo.status !== 'downloaded' ||
      upo.tenant_id !== invoice.tenant_id ||
      upo.ksef_number !== invoice.ksef_number ||
      upo.ksef_environment !== environment) {
    return {
      success: false,
      error:
        'UPO jeszcze nie zostało pobrane. Spróbuj za chwilę — KSeF generuje je asynchronicznie.',
    };
  }

  try {
    const xml = await downloadUpoXml(invoice.tenant_id, invoiceId);
    return { success: true, xml };
  } catch {
    return { success: false, error: 'Błąd odczytu UPO XML' };
  }
}
