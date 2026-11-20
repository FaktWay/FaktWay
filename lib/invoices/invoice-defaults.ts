/**
 * Domyślne ustawienia firmy dla nowej faktury (plan kompletnej aplikacji,
 * krok 2.8, migracja 00209): forma płatności, termin płatności w dniach
 * i adres księgowej, do której idzie kopia maila z fakturą.
 *
 * To tylko PODPOWIEDZI dla nowego formularza i adres kopii: nic z tego nie
 * zmienia kwot ani zapisanych faktur. Formularz bierze je, gdy nie ma podkładu
 * (podkład z faktury, faktura cykliczna i proforma mają pierwszeństwo, bo
 * wpisują własne wartości po domyślnych). Brak ustawienia = dotychczasowe
 * zachowanie (przelew, 14 dni, bez kopii). Odczyt nigdy nie psuje
 * formularza ani wysyłki: błąd bazy, brak tabeli albo niepoprawny wiersz to
 * `null`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { dueDateFrom } from '@/lib/format/warsaw-date';

export const DEFAULTS_TABLE = 'tenant_invoice_defaults';
export const PAYMENT_METHODS = ['transfer', 'cash', 'card', 'other'] as const;
export type DefaultPaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Dotychczasowy termin płatności nowej faktury. */
export const DEFAULT_PAYMENT_DAYS = 14;
export const MAX_PAYMENT_DAYS = 90;
export const MAX_COPY_EMAIL_LENGTH = 254;

export interface InvoiceDefaults {
  paymentMethod: DefaultPaymentMethod | null;
  paymentDays: number | null;
  accountantCopyEmail: string | null;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CONTROL = /[\u0000-\u001F\u007F\u0085\u2028\u2029]/;

export type DefaultsValidation = ({ ok: true } & InvoiceDefaults) | { ok: false; error: string };

/** Sprawdza i normalizuje ustawienia z formularza; ta sama reguła po stronie klienta i serwera. */
export function validateInvoiceDefaults(input: {
  paymentMethod: unknown;
  paymentDays: unknown;
  accountantCopyEmail: unknown;
}): DefaultsValidation {
  const method = input.paymentMethod;
  let paymentMethod: DefaultPaymentMethod | null = null;
  if (method !== null && method !== undefined && method !== '') {
    if (!(PAYMENT_METHODS as readonly unknown[]).includes(method)) return { ok: false, error: 'Wybierz z listy jedną z form płatności.' };
    paymentMethod = method as DefaultPaymentMethod;
  }

  const days = input.paymentDays;
  let paymentDays: number | null = null;
  if (days !== null && days !== undefined) {
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 0 || days > MAX_PAYMENT_DAYS) {
      return { ok: false, error: `Termin płatności to liczba dni od 0 do ${MAX_PAYMENT_DAYS}.` };
    }
    paymentDays = days;
  }

  const rawEmail = typeof input.accountantCopyEmail === 'string' ? input.accountantCopyEmail.trim().toLowerCase() : '';
  if (input.accountantCopyEmail !== null && input.accountantCopyEmail !== undefined && typeof input.accountantCopyEmail !== 'string') {
    return { ok: false, error: 'Adres księgowej jest nieprawidłowy.' };
  }
  let accountantCopyEmail: string | null = null;
  if (rawEmail) {
    if (rawEmail.length > MAX_COPY_EMAIL_LENGTH || !EMAIL_RE.test(rawEmail) || CONTROL.test(rawEmail)) {
      return { ok: false, error: 'Adres księgowej jest nieprawidłowy. Wpisz jeden adres e-mail.' };
    }
    accountantCopyEmail = rawEmail;
  }
  return { ok: true, paymentMethod, paymentDays, accountantCopyEmail };
}

/** Wartości startowe nowego formularza: forma i termin firmy, a brakujące pole zostaje dotychczasowe. */
export function formDefaultsOf(
  defaults: Partial<InvoiceDefaults> | null,
  today: string,
): { paymentMethod: DefaultPaymentMethod; paymentDueDate: string } {
  return {
    paymentMethod: defaults?.paymentMethod ?? 'transfer',
    paymentDueDate: dueDateFrom(today, defaults?.paymentDays ?? DEFAULT_PAYMENT_DAYS),
  };
}

export async function readInvoiceDefaults(db: SupabaseClient, tenantId: string): Promise<InvoiceDefaults | null> {
  try {
    const { data, error } = await db
      .from('tenant_invoice_defaults')
      .select('payment_method, payment_days, accountant_copy_email')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as { payment_method: unknown; payment_days: unknown; accountant_copy_email: unknown };
    const checked = validateInvoiceDefaults({
      paymentMethod: row.payment_method,
      paymentDays: row.payment_days,
      accountantCopyEmail: row.accountant_copy_email,
    });
    return checked.ok
      ? { paymentMethod: checked.paymentMethod, paymentDays: checked.paymentDays, accountantCopyEmail: checked.accountantCopyEmail }
      : null;
  } catch {
    return null;
  }
}

export async function writeInvoiceDefaults(
  db: SupabaseClient,
  input: { tenantId: string; userId: string; defaults: InvoiceDefaults },
): Promise<boolean> {
  try {
    const { error } = await db.from('tenant_invoice_defaults').upsert(
      {
        tenant_id: input.tenantId,
        payment_method: input.defaults.paymentMethod,
        payment_days: input.defaults.paymentDays,
        accountant_copy_email: input.defaults.accountantCopyEmail,
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

export async function deleteInvoiceDefaults(db: SupabaseClient, tenantId: string): Promise<boolean> {
  try {
    const { error } = await db.from('tenant_invoice_defaults').delete().eq('tenant_id', tenantId);
    return !error;
  } catch {
    return false;
  }
}
