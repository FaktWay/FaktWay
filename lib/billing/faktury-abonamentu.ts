/**
 * Lista faktur za abonament FaktWay dla klienta (plan kompletnej aplikacji,
 * krok 8.1): Ustawienia → Abonament. Każda udana płatność Stripe ma fakturę
 * VAT wystawioną przez operatora (`stripe_payments.vat_invoice_id`, 00047,
 * `lib/billing/self-invoice.ts`), a klient dostaje ją w KSeF.
 *
 * Granice dostępu: płatności czyta klient sesji (RLS `stripe_payments_select_own_tenant`:
 * tylko własna firma). Faktury należą do firmy operatora, więc ich numery
 * czyta klient serwisowy, ale TYLKO po identyfikatorach z płatności własnej
 * firmy i tylko trzy kolumny (numer, numer KSeF, status): nic z treści faktury.
 * Błąd odczytu to `null` (strona pokazuje komunikat), brak płatności to `[]`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type SubscriptionInvoiceState = 'in_ksef' | 'issued' | 'preparing';

export interface SubscriptionInvoiceRow {
  paymentId: string;
  /** Dzień płatności RRRR-MM-DD w czasie polskim. */
  paidOn: string;
  amountLabel: string;
  number: string | null;
  ksefNumber: string | null;
  /** `in_ksef`: przyjęta przez KSeF; `issued`: wystawiona, czeka na KSeF; `preparing`: faktury jeszcze nie ma. */
  state: SubscriptionInvoiceState;
}

interface PaymentRow {
  id: string;
  status: string;
  amount_cents: number;
  currency?: string | null;
  paid_at: string | null;
  vat_invoice_id: string | null;
}

interface InvoiceRow {
  id: string;
  internal_number: string | null;
  ksef_number: string | null;
  ksef_status: string | null;
}

/** Najwyżej tyle ostatnich płatności na liście (dwa lata przy planie miesięcznym). */
export const SUBSCRIPTION_INVOICES_LIMIT = 24;

const WARSAW_DAY = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' });

export function subscriptionInvoiceRow(payment: PaymentRow, invoice: InvoiceRow | undefined): SubscriptionInvoiceRow {
  const currency = payment.currency?.trim() || 'PLN';
  const amount = (payment.amount_cents / 100).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const accepted = invoice?.ksef_status === 'accepted' && Boolean(invoice.ksef_number);
  return {
    paymentId: payment.id,
    paidOn: payment.paid_at ? WARSAW_DAY.format(new Date(payment.paid_at)) : '',
    amountLabel: `${amount} ${currency}`,
    number: invoice?.internal_number ?? null,
    ksefNumber: accepted ? (invoice?.ksef_number ?? null) : null,
    state: !invoice ? 'preparing' : accepted ? 'in_ksef' : 'issued',
  };
}

export async function listSubscriptionInvoices(
  session: SupabaseClient,
  admin: SupabaseClient,
  tenantId: string,
): Promise<SubscriptionInvoiceRow[] | null> {
  try {
    const { data, error } = await session
      .from('stripe_payments')
      .select('id, status, amount_cents, currency, paid_at, vat_invoice_id')
      .eq('tenant_id', tenantId)
      .eq('status', 'succeeded')
      .order('paid_at', { ascending: false })
      .limit(SUBSCRIPTION_INVOICES_LIMIT);
    if (error || !Array.isArray(data)) return null;
    const payments = (data as PaymentRow[]).filter((p) => p.status === 'succeeded');
    if (payments.length === 0) return [];

    const ids = payments.map((p) => p.vat_invoice_id).filter((id): id is string => typeof id === 'string');
    const byId = new Map<string, InvoiceRow>();
    if (ids.length > 0) {
      const res = await admin.from('invoices').select('id, internal_number, ksef_number, ksef_status').in('id', ids);
      if (res.error || !Array.isArray(res.data)) return null;
      for (const row of res.data as InvoiceRow[]) {
        byId.set(row.id, { id: row.id, internal_number: row.internal_number, ksef_number: row.ksef_number, ksef_status: row.ksef_status });
      }
    }
    return payments
      .map((p) => subscriptionInvoiceRow(p, p.vat_invoice_id ? byId.get(p.vat_invoice_id) : undefined))
      .sort((a, b) => b.paidOn.localeCompare(a.paidOn));
  } catch {
    return null;
  }
}
