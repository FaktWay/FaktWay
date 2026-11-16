import 'server-only';

import { revalidatePath } from 'next/cache';
import type { SupabaseClient } from '@supabase/supabase-js';

import { logAudit } from '@/lib/audit/log';
import { enqueueKsefSubmitAfterDraft, type TokenSessionSendActor } from '@/lib/invoices/ksef-submit-enqueue';
import type { AfterDraftSaved } from '@/lib/invoices/issue-regular';
import { formatJobSendError } from '@/lib/jobs/error-message';
import { calculateAdvanceTotals } from '@/lib/invoices/calculator';
import { specialDataInsertError } from '@/lib/invoices/special-data';
import { issueDateNotTodayError } from '@/lib/invoices/issue-date';
import { readTenantCashMethodForIssuance } from '@/lib/invoices/cash-method';
import { matchesTenantSeller, sellerFromTenantProfile } from '@/lib/invoices/tenant-seller';
import {
  numberConflictOf,
  numberRefusalText,
  numberRequestOf,
  saveWithInvoiceNumber,
  type NumberColumns,
  type NumberedResult,
} from '@/lib/numeracja/nadanie';
import {
  buyerPartyFromBuyerData,
  sellerPartyFromSellerData,
} from '@/lib/invoices/map-buyer-party';
import {
  salesQuoteConflictMessage,
  salesQuoteConvertedAudit,
  salesQuoteLinkForSave,
  withSalesQuoteColumns,
  type SalesQuoteIssueLink,
} from '@/lib/proformy/powiazanie';
import {
  advanceInvoiceSchema,
  type AdvanceInvoiceSchemaIn,
} from '@/lib/validators/invoice-validators';
import type {
  Invoice,
  InvoiceLineItem,
  PaymentMethod,
  SellerParty,
  VatRate,
} from '@/types/invoice';
import type { AdvanceInvoiceData, BuyerData, SellerData } from '@/types/invoice-types';

/**
 * Faktura zaliczkowa z wartości formularza: szkic albo szkic i kolejka KSeF
 * (plan aplikacji mobilnej, etap M8b; wzór `lib/invoices/issue-regular.ts`).
 *
 * Do M8b ta logika siedziała w akcjach `saveAdvanceAction` i
 * `saveAndSendAdvanceAction` (`components/invoices/advance-actions.ts`), które
 * czytają sesję z ciasteczek. Teraz akcje strony i trasa telefonu wołają te same
 * funkcje; wołający podaje sesję i firmę (`AdvanceContextSource`). Kolejność
 * kroków i komunikaty są takie jak w akcjach przed wydzieleniem (testy akcji
 * strony bez zmian; telefon: `tests/unit/mobile-api-faktury-rodzaje.test.ts`).
 */

export type AdvanceIssueResult =
  | { success: true; invoiceId: string; offline?: boolean }
  | { success: false; error: string; invoiceId?: string };

function zodIssuesMessage(err: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): string {
  return err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' · ');
}

interface TenantSnap {
  id: string;
  nip: string;
  name: string;
  address: {
    countryCode?: string;
    addressLine1?: string;
    addressLine2?: string;
  } | null;
}

/**
 * Sesja i firma zapisu: akcja strony (`requireUserAndActiveOrg` z
 * `expectedTenantId`, UX-01) albo trasa telefonu (`authenticateMobileRequest`).
 * Wołane leniwie wewnątrz `try`, więc błąd sesji daje ten sam wynik co przed
 * wydzieleniem (zdanie w `{ success: false, error }`).
 */
export interface AdvanceIssueContext {
  supabase: SupabaseClient;
  userId: string;
  tenant: TenantSnap;
  /** Telefon: 2FA i znacznik KSeF z tokenu zamiast z ciasteczek (`ksef-submit-enqueue.ts`). */
  tokenSession?: TokenSessionSendActor;
}

export type AdvanceContextSource = () => Promise<AdvanceIssueContext>;

function normalizeBank(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  return raw.replace(/\s+/g, '');
}

function paymentMethodFa(m: AdvanceInvoiceSchemaIn['paymentMethod']): PaymentMethod {
  if (m === 'compensation') return 'other';
  return m as PaymentMethod;
}

function requireTenantSeller(supplied: SellerData, tenant: TenantSnap): SellerData {
  const seller = sellerFromTenantProfile({
    nip: tenant.nip,
    name: tenant.name,
    address_json: tenant.address,
  });
  if (!seller) {
    throw new Error('Uzupełnij poprawne dane sprzedawcy w ustawieniach firmy przed wystawieniem faktury.');
  }
  if (!matchesTenantSeller(supplied, seller)) {
    throw new Error('Dane sprzedawcy zmieniły się lub nie należą do tej firmy. Odśwież formularz.');
  }
  return seller;
}

function buildAdvanceEnvelope(parsed: AdvanceInvoiceSchemaIn, cashMethod: boolean): AdvanceInvoiceData {
  const bankNorm = normalizeBank(parsed.bankAccount ?? '');
  const buyer = parsed.buyer as BuyerData;
  const seller = parsed.seller as SellerData;

  return {
    invoiceType: 'advance',
    internalNumber: parsed.internalNumber,
    issueDate: parsed.issueDate,
    paymentMethod: parsed.paymentMethod,
    paymentDueDate: parsed.paymentDueDate,
    bankAccount: bankNorm,
    notes: parsed.notes?.trim()?.length ? parsed.notes.trim() : undefined,
    seller,
    buyer,
    taxAnnotations: {
      cashMethod: cashMethod ? 1 : 2,
      splitPayment: parsed.splitPayment ? 1 : 2,
    },
    advanceAmount: parsed.advanceAmount,
    totalContractAmount: parsed.totalContractAmount,
    expectedDeliveryDate: parsed.expectedDeliveryDate,
    advanceReceivedDate: parsed.advanceReceivedDate || undefined,
    vatRate: parsed.vatRate,
    description: parsed.description,
  };
}

function ghostAdvanceInvoice(envelope: AdvanceInvoiceData): Invoice {
  const totals = calculateAdvanceTotals(envelope);
  const rate = envelope.vatRate as VatRate;

  const line: InvoiceLineItem = {
    ordinal: 1,
    name: `Zaliczka: ${envelope.description}`,
    unit: 'szt.',
    quantity: 1,
    unitPriceNet: totals.advanceNet,
    vatRate: rate,
    netAmount: totals.advanceNet,
    vatAmount: totals.advanceVat,
    grossAmount: totals.advanceGross,
  };

  const seller: SellerParty = sellerPartyFromSellerData(envelope.seller);

  const buyer = buyerPartyFromBuyerData(envelope.buyer);

  return {
    internalNumber: envelope.internalNumber,
    type: 'ZAL',
    issueDate: envelope.issueDate,
    // F12-D1: P_6 zaliczki to data otrzymania zapłaty (PDF i eksport z `sale_date`).
    saleDate: envelope.advanceReceivedDate,
    seller,
    buyer,
    lines: [line],
    netTotal: totals.advanceNet,
    vatTotal: totals.advanceVat,
    grossTotal: totals.advanceGross,
    payment: {
      amountDue: totals.advanceGross,
      currency: 'PLN',
      dueDate: envelope.paymentDueDate,
      method: paymentMethodFa(envelope.paymentMethod),
      bankAccount: normalizeBank(envelope.bankAccount),
    },
    annotations: envelope.taxAnnotations,
    notes: envelope.notes,
    advanceEnvelope: envelope,
  };
}

/**
 * `salesQuote` (krok 2.4): zaliczka z proformy albo oferty. Powiązanie idzie
 * w TYM SAMYM INSERT (`uq_invoices_sales_quote_seq`, 00198); bez dokumentu
 * wiersz jest taki jak dotąd.
 *
 * `numberColumns` (krok 2.5, 00199): seria, okres, licznik i klucz zapisu;
 * bez serii pusty obiekt (wiersz jak dotąd). Odmowę numeru przez bazę wynik
 * niesie w `numberConflict` dla `saveWithInvoiceNumber`.
 */
async function insertAdvanceDraft(
  supabase: SupabaseClient,
  tenantId: string,
  ghost: Invoice,
  envelope: AdvanceInvoiceData,
  salesQuote?: { link: SalesQuoteIssueLink; userId: string },
  numberColumns: NumberColumns = {},
): Promise<NumberedResult<AdvanceIssueResult>> {
  const { data: inserted, error: invErr } = await supabase
    .from('invoices')
    .insert(withSalesQuoteColumns({
      ...numberColumns,
      tenant_id: tenantId,
      direction: 'outgoing',
      ksef_status: 'draft',
      internal_number: ghost.internalNumber,
      invoice_kind: 'advance',
      invoice_type: 'ZAL',
      issue_date: ghost.issueDate,
      sale_date: envelope.advanceReceivedDate ?? null,
      seller_nip: ghost.seller.nip,
      buyer_nip: ghost.buyer.nip ?? null,
      seller_data: ghost.seller,
      buyer_data: ghost.buyer,
      payment_data: ghost.payment,
      payment_due_date: ghost.payment.dueDate,
      currency: 'PLN',
      net_total: ghost.netTotal,
      vat_total: ghost.vatTotal,
      gross_total: ghost.grossTotal,
      advance_amount: envelope.advanceAmount,
      notes: envelope.notes ?? null,
      fa3_data: ghost,
    }, salesQuote?.link))
    .select('id')
    .single();

  if (invErr || !inserted) {
    // Krok 2.4: numer zamiany dokumentu zajęła inna faktura (dwa zapisy naraz).
    if (salesQuote) {
      const taken = await salesQuoteConflictMessage(supabase, tenantId, salesQuote.link, invErr);
      if (taken) return { success: false, error: taken };
    }
    const numberConflict = numberConflictOf(invErr);
    return {
      success: false,
      error: specialDataInsertError(invErr, `zaliczki ${ghost.internalNumber}`)
        ?? numberRefusalText(invErr) ?? invErr?.message ?? 'Nie udało się zapisać faktury zaliczkowej',
      ...(numberConflict ? { numberConflict } : {}),
    };
  }

  const invoiceId = inserted.id as string;

  const { error: lineErr } = await supabase.from('invoice_line_items').insert(
    ghost.lines.map((l) => ({
      invoice_id: invoiceId,
      ordinal: l.ordinal,
      name: l.name,
      unit: l.unit,
      quantity: l.quantity,
      unit_price_net: l.unitPriceNet,
      net_amount: l.netAmount,
      vat_rate: l.vatRate,
      vat_amount: l.vatAmount,
      gross_amount: l.grossAmount,
    })),
  );

  if (lineErr) {
    await supabase.from('invoices').delete().eq('id', invoiceId);
    return { success: false, error: `Błąd zapisu pozycji: ${lineErr.message}` };
  }

  if (salesQuote) {
    await logAudit(
      salesQuoteConvertedAudit(salesQuote.link, tenantId, salesQuote.userId, {
        invoiceId,
        internalNumber: ghost.internalNumber,
        invoiceKind: 'advance',
      }),
    );
  }

  return { success: true, invoiceId };
}

/**
 * Kwoty zaliczki bez zapisu (telefon pokazuje kwoty policzone przez serwer,
 * plan aplikacji mobilnej M8b): te same kroki co zapis aż do faktury, bez
 * numeru z serii i bez bazy poza odczytem metody kasowej.
 */
export async function previewAdvance(
  context: AdvanceContextSource,
  raw: unknown,
): Promise<{ success: true; invoice: Invoice } | { success: false; error: string }> {
  try {
    const { supabase, tenant } = await context();
    const parsed = advanceInvoiceSchema.safeParse(raw);
    if (!parsed.success) return { success: false, error: zodIssuesMessage(parsed.error) };

    const seller = requireTenantSeller(parsed.data.seller, tenant);
    const cashMethod = await readTenantCashMethodForIssuance(supabase, tenant.id);
    return { success: true, invoice: ghostAdvanceInvoice(buildAdvanceEnvelope({ ...parsed.data, seller }, cashMethod)) };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Nieznany błąd' };
  }
}

/** Szkic zaliczki z wartości formularza (`saveAdvanceAction` strony, `POST /api/mobile/v1/faktury` telefonu). */
export async function saveAdvance(context: AdvanceContextSource, raw: unknown): Promise<AdvanceIssueResult> {
  try {
    const { supabase, tenant, userId } = await context();
    const parsed = advanceInvoiceSchema.safeParse(raw);
    if (!parsed.success) return { success: false, error: zodIssuesMessage(parsed.error) };

    const seller = requireTenantSeller(parsed.data.seller, tenant);
    const cashMethod = await readTenantCashMethodForIssuance(supabase, tenant.id);
    const envelope = buildAdvanceEnvelope({ ...parsed.data, seller }, cashMethod);

    // Krok 2.4: dokument (proforma, oferta) z formularza sprawdzony przed zapisem.
    const salesQuote = await salesQuoteLinkForSave(supabase, tenant.id, parsed.data.salesQuoteId, parsed.data.salesQuoteSeq);
    if (!salesQuote.ok) return { success: false, error: salesQuote.error };
    const quoteIssue = salesQuote.link ? { link: salesQuote.link, userId } : undefined;

    // Krok 2.5: numer z licznika serii albo z pola, ten sam w kolumnie, w kopercie i w fa3_data.
    const saved = await saveWithInvoiceNumber(supabase, numberRequestOf(parsed.data), envelope.issueDate, async (assigned) => {
      const numbered = { ...envelope, internalNumber: assigned.number };
      const ghost = ghostAdvanceInvoice(numbered);
      return { result: await insertAdvanceDraft(supabase, tenant.id, ghost, numbered, quoteIssue, assigned.columns), built: ghost };
    });
    const result = saved.result;
    if (result.success && saved.built) {
      await logAudit({
        action: 'invoice.draft_created',
        tenantId: tenant.id,
        userId,
        entityType: 'invoice',
        entityId: result.invoiceId,
        metadata: { kind: 'advance', internalNumber: saved.built.internalNumber },
      });
      revalidatePath('/invoices');
    }
    return result;
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Nieznany błąd' };
  }
}

/**
 * Szkic zaliczki i kolejka KSeF (`saveAndSendAdvanceAction` strony, telefon).
 * `afterDraftSaved` (telefon: klucz idempotencji żądania) biegnie po zapisie
 * szkicu, przed kolejką; odmowa zostawia szkic i nie zleca wysyłki.
 */
export async function saveAndSendAdvance(
  context: AdvanceContextSource,
  raw: unknown,
  afterDraftSaved?: AfterDraftSaved,
): Promise<AdvanceIssueResult> {
  try {
    const { supabase, tenant, userId, tokenSession } = await context();
    const parsed = advanceInvoiceSchema.safeParse(raw);
    if (!parsed.success) return { success: false, error: zodIssuesMessage(parsed.error) };

    const seller = requireTenantSeller(parsed.data.seller, tenant);
    const cashMethod = await readTenantCashMethodForIssuance(supabase, tenant.id);
    const envelope = buildAdvanceEnvelope({ ...parsed.data, seller }, cashMethod);

    // Ta sama reguła co zwykła faktura (A1, W5): w KSeF tylko z dzisiejszą datą
    // wystawienia — odmowa przed zapisem, żeby nie zostawić szkicu zaliczki,
    // którego i tak nie da się później wysłać.
    const notToday = issueDateNotTodayError(envelope.issueDate, 'special');
    if (notToday) return { success: false, error: notToday };

    // Krok 2.4: dokument z formularza: wystawiony, tej firmy, numer zamiany wolny.
    const salesQuote = await salesQuoteLinkForSave(supabase, tenant.id, parsed.data.salesQuoteId, parsed.data.salesQuoteSeq);
    if (!salesQuote.ok) return { success: false, error: salesQuote.error };
    const quoteIssue = salesQuote.link ? { link: salesQuote.link, userId } : undefined;

    // Krok 2.5: numer z licznika serii albo z pola; kolejka KSeF dostaje
    // kopertę i fakturę z numerem, który się zapisał.
    const numbered = await saveWithInvoiceNumber(supabase, numberRequestOf(parsed.data), envelope.issueDate, async (assigned) => {
      const env = { ...envelope, internalNumber: assigned.number };
      const ghost = ghostAdvanceInvoice(env);
      return { result: await insertAdvanceDraft(supabase, tenant.id, ghost, env, quoteIssue, assigned.columns), built: { ghost, env } };
    });
    const saved = numbered.result;
    if (!saved.success) return saved;
    if (!numbered.built) return { success: false, error: 'Brak danych zapisanej zaliczki', invoiceId: saved.invoiceId };
    const { ghost, env: advanceData } = numbered.built;

    const invoiceId = saved.invoiceId;

    if (afterDraftSaved) {
      const after = await afterDraftSaved(invoiceId);
      if (!after.ok) return { success: false, error: after.error, invoiceId };
    }

    const enq = await enqueueKsefSubmitAfterDraft({
      supabase,
      tenantId: tenant.id,
      userId,
      invoiceId,
      nip: tenant.nip,
      invoice: ghost,
      advanceData,
      auditKind: 'advance',
      internalNumberForAudit: ghost.internalNumber,
      ...(tokenSession ? { tokenSession } : {}),
    });

    if (!enq.ok) {
      return { success: false, error: enq.error, invoiceId };
    }

    return {
      success: true,
      invoiceId,
      offline: false,
    };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? formatJobSendError(e) : 'Nieznany błąd wysyłki',
    };
  }
}
