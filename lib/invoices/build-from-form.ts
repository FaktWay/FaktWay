/**
 * Zwykła faktura VAT z wartości formularza: obiekt `Invoice` i wiersze szkicu
 * w bazie. Jedna droga dla formularza (`components/invoices/actions.ts`)
 * i publicznego API (`POST /api/v1/invoices`, krok 7.1 planu kompletnej
 * aplikacji): te same kwoty (`calculateLineItem`, `roundToCents`; przy cenach
 * brutto `grossPricedFormLines`), adnotacje, nabywca i kolumny wiersza. Kod
 * przeniesiony bez zmian z akcji formularza.
 *
 * Czysty moduł: bez bazy i bez Next. Plik `'use server'` eksportuje tylko akcje.
 */

import { buildInvoiceAnnotations } from '@/lib/invoices/annotations';
import { isGtuCode } from '@/lib/invoices/line-codes';
import { orderFromFormValues } from '@/lib/invoices/order-reference';
import { addressCountryForKodUE, parseVatUe } from '@/lib/invoices/vat-ue';
import {
  grossPricedFormLines,
  receiptBuyerKindOfForm,
  receiptFromFormValues,
  type InvoiceFormValues,
} from '@/lib/schemas/invoice-form';
import { calculateInvoiceTotals, calculateLineItem } from '@/lib/xml/invoice-calculator';
import type {
  Address,
  BuyerParty,
  Invoice,
  InvoiceLineItem,
  PaymentInfo,
  PaymentMethod,
  SellerParty,
} from '@/types/invoice';

export interface TenantAddressSnapshot {
  countryCode?: string;
  addressLine1?: string;
  addressLine2?: string;
}

export interface TenantSnapshot {
  id: string;
  nip: string;
  name: string;
  address: TenantAddressSnapshot | null;
}

export function buildInvoiceFromForm(
  values: InvoiceFormValues,
  tenant: TenantSnapshot,
  /** Podstawa zwolnienia z VAT (P_19A) — `null` = czynny podatnik VAT. */
  vatExemptionBasis: string | null,
  /** Metoda kasowa VAT firmy (P_16, #76). */
  cashMethod: boolean,
): Invoice {
  // Plan cen brutto, PR (b): jedna metoda cen na fakturę. Przy cenach brutto
  // pozycje liczy `grossPricedFormLines` (VAT od sumy brutto stawki,
  // RP-FA-BRUTTO-01), to samo liczenie co podgląd sum w formularzu; brak ceny
  // brutto zostaje brakiem (bramka wysyłki odmawia z numerem pozycji), nie 0 zł.
  const pricesGross = values.pricesGross === true;
  const lines: InvoiceLineItem[] = pricesGross
    ? grossPricedFormLines(values.lines).map((line, idx) => ({ ...line, ...lineCodesOfForm(values.lines[idx]!) }))
    : values.lines.map((line, idx) => {
    const calc = calculateLineItem({
      quantity: line.quantity,
      unitPriceNet: line.unitPriceNet,
      vatRate: line.vatRate,
    });
    return {
      ordinal: idx + 1,
      name: line.name,
      unit: line.unit,
      quantity: line.quantity,
      unitPriceNet: line.unitPriceNet,
      vatRate: line.vatRate,
      netAmount: calc.netAmount,
      vatAmount: calc.vatAmount,
      grossAmount: calc.grossAmount,
      ...lineCodesOfForm(line),
    };
  });

  const totals = calculateInvoiceTotals(lines);

  const sellerAddress: Address = {
    countryCode: tenant.address?.countryCode ?? 'PL',
    addressLine1: tenant.address?.addressLine1 ?? '',
    addressLine2: tenant.address?.addressLine2 ?? '',
  };

  const seller: SellerParty = {
    nip: tenant.nip,
    name: tenant.name,
    address: sellerAddress,
  };

  const buyerEmail =
    typeof values.buyerEmail === 'string' && values.buyerEmail.length > 0
      ? values.buyerEmail
      : undefined;

  const buyer: BuyerParty = (() => {
    const jst = 2 as const;
    const gv = 2 as const;
    const addr: Address = {
      countryCode: 'PL',
      addressLine1: values.buyerAddressLine1,
      addressLine2: values.buyerAddressLine2,
    };

    // AUD-70: firma z innego państwa UE — identyfikuje ją numer VAT-UE
    // (FA(3): KodUE + NrVatUE), nie NIP; adres ma kraj nabywcy, nie PL.
    if (values.buyerIsEu) {
      const vat = parseVatUe(values.buyerVatUe);
      // Schemat odrzuca taki numer wcześniej — to tylko zawężenie typu.
      if (!vat) throw new Error('Nieprawidłowy numer VAT-UE nabywcy');
      return {
        vatUeNumber: vat.normalized,
        name: values.buyerName,
        address: {
          countryCode: values.buyerCountryCode || addressCountryForKodUE(vat.kodUE),
          addressLine1: values.buyerAddressLine1,
          addressLine2: values.buyerAddressLine2,
        },
        jst,
        gv,
        email: buyerEmail,
      };
    }

    if (!values.buyerIsConsumer) {
      return {
        nip: values.buyerNip,
        name: values.buyerName,
        address: addr,
        jst,
        gv,
        email: buyerEmail,
      };
    }

    const t = values.buyerConsumerIdType;
    switch (t) {
      case 'pesel':
        return {
          name: values.buyerName,
          address: addr,
          pesel: values.buyerPesel.replace(/\D/g, ''),
          jst,
          gv,
          email: buyerEmail,
        };
      case 'no_id':
        return {
          name: values.buyerName,
          address: addr,
          noIdMarker: true,
          jst,
          gv,
          email: buyerEmail,
        };
      case 'id_card':
      case 'passport':
        return {
          name: values.buyerName,
          address: addr,
          nrInny: values.buyerIdDocument.trim(),
          jst,
          gv,
          email: buyerEmail,
        };
      default:
        return {
          name: values.buyerName,
          address: addr,
          noIdMarker: true,
          jst,
          gv,
          email: buyerEmail,
        };
    }
  })();

  const payment: PaymentInfo = {
    amountDue: totals.grossTotal,
    currency: 'PLN',
    dueDate: values.paymentDueDate,
    method: values.paymentMethod as PaymentMethod,
    bankAccount: values.bankAccount || undefined,
  };

  const saleTrim = values.saleDate?.trim();
  const saleDistinct =
    saleTrim &&
    saleTrim !== values.issueDate
      ? saleTrim
      : undefined;

  // Faktura do paragonu (krok 1.2): ten sam kształt, który sprawdził schemat
  // (`receiptFromFormValues`). Klucz tylko przy FP, zwykła faktura bez zmian.
  const receipt = values.receiptInvoice === true
    ? receiptFromFormValues(values, receiptBuyerKindOfForm(values))
    : undefined;

  // Numer zamówienia (krok 2.8): klucz tylko z numerem, faktura bez niego jak dotąd.
  const order = orderFromFormValues(values);

  return {
    internalNumber: values.internalNumber,
    type: 'VAT',
    issueDate: values.issueDate,
    saleDate: saleDistinct,
    seller,
    buyer,
    lines,
    netTotal: totals.netTotal,
    vatTotal: totals.vatTotal,
    grossTotal: totals.grossTotal,
    payment,
    annotations: buildInvoiceAnnotations({
      lines,
      vatExemptionBasis,
      splitPayment: values.splitPayment === true,
      cashMethod,
    }),
    notes: values.notes && values.notes.length ? values.notes : undefined,
    ...(receipt ? { receipt } : {}),
    ...(order ? { order } : {}),
    // Klucz tylko przy cenach brutto: faktura w cenach netto ma kształt jak dotąd.
    ...(pricesGross ? { pricesGross: true as const } : {}),
  };
}

/**
 * PKWiU i GTU pozycji z formularza, ta sama reguła przy cenach netto i brutto.
 * Krok 2.6, część 2b-1: PKWiU z jawnym typem tylko, gdy jest (puste pole = brak).
 * Część 2b-2: oznaczenie GTU tylko z listy (puste pole = brak). Akcje przekazują
 * dalej także niesparsowane wartości, więc kod jeszcze raz sprawdzony tutaj; to
 * samo oznaczenie idzie do FA(3) i do JPK_V7M.
 */
function lineCodesOfForm(line: InvoiceFormValues['lines'][number]): Pick<InvoiceLineItem, 'pkwiuCode' | 'gtuCode'> {
  const pkwiuCode = line.pkwiuCode?.trim();
  return {
    ...(pkwiuCode ? { pkwiuCode } : {}),
    ...(isGtuCode(line.gtuCode) ? { gtuCode: line.gtuCode } : {}),
  };
}

/**
 * Kolumny nabywcy w `public.invoices` (ułatwia raportowanie bez parsowania JSON).
 *
 * Firma z UE (AUD-70) zapisuje się jak przy imporcie (`buyerIdentityFromParsed`):
 * B2B, typ `nip`, ale `buyer_nip` pusty — kolumna to VARCHAR(10) na polski
 * NIP, a numer VAT-UE leży w `buyer_data` / `fa3_data`.
 */
export function buyerColumnsFromInvoiceForm(values: InvoiceFormValues): {
  is_b2c: boolean;
  buyer_id_type: 'nip' | 'pesel' | 'id_card' | 'passport' | 'no_id';
  buyer_nip: string | null;
  buyer_pesel: string | null;
  buyer_id_number: string | null;
} {
  if (values.buyerIsEu) {
    return {
      is_b2c: false,
      buyer_id_type: 'nip',
      buyer_nip: null,
      buyer_pesel: null,
      buyer_id_number: null,
    };
  }

  if (!values.buyerIsConsumer) {
    return {
      is_b2c: false,
      buyer_id_type: 'nip',
      buyer_nip: values.buyerNip,
      buyer_pesel: null,
      buyer_id_number: null,
    };
  }

  const t = values.buyerConsumerIdType ?? 'no_id';

  const pes =
    t === 'pesel' ? values.buyerPesel.replace(/\D/g, '') || null : null;
  const idNum =
    t === 'id_card' || t === 'passport'
      ? values.buyerIdDocument.trim() || null
      : null;

  return {
    is_b2c: true,
    buyer_id_type: t,
    buyer_nip: null,
    buyer_pesel: pes,
    buyer_id_number: idNum,
  };
}

/**
 * Wiersz szkicu w `public.invoices` (bez kolumn faktury cyklicznej, które
 * dokłada `withRecurringColumns`). Stan, kierunek i firma z argumentów,
 * reszta z faktury: tak zapisuje formularz i tak samo API (00184 bierze
 * z tego wiersza tylko kolumny treści).
 */
export function draftInvoiceRow(tenantId: string, invoice: Invoice, formValues?: InvoiceFormValues) {
  const b2c = formValues ? buyerColumnsFromInvoiceForm(formValues) : null;
  return {
    tenant_id: tenantId,
    // DB CHECK: 'outgoing' | 'incoming' - NIE 'issued'.
    direction: 'outgoing',
    ksef_status: 'draft',
    internal_number: invoice.internalNumber,
    invoice_type: invoice.type,
    issue_date: invoice.issueDate,
    sale_date: invoice.saleDate ?? null,
    seller_nip: invoice.seller.nip,
    buyer_nip: b2c ? b2c.buyer_nip : invoice.buyer.nip ?? null,
    seller_data: invoice.seller,
    buyer_data: invoice.buyer,
    payment_data: invoice.payment,
    payment_due_date: invoice.payment.dueDate,
    currency: invoice.payment.currency,
    notes: invoice.notes ?? null,
    net_total: invoice.netTotal,
    vat_total: invoice.vatTotal,
    gross_total: invoice.grossTotal,
    is_b2c: b2c?.is_b2c ?? false,
    buyer_id_type: b2c?.buyer_id_type ?? 'nip',
    buyer_pesel: b2c?.buyer_pesel ?? null,
    buyer_id_number: b2c?.buyer_id_number ?? null,
    // fa3_data NOT NULL w 00001 - trzymamy tam ten sam snapshot co w
    // seller_data/buyer_data/payment_data, plus ewentualne adnotacje.
    // Generator XML i tak odtworzy go z `invoice` w jobie - to jest
    // jedynie źródło prawdy dla UI/raportów.
    fa3_data: invoice,
  };
}

/** Pozycje szkicu w `public.invoice_line_items` (bez `invoice_id`, który zna dopiero zapis faktury). */
export function draftLineRows(invoice: Invoice) {
  return invoice.lines.map((line) => ({
    ordinal: line.ordinal,
    name: line.name,
    unit: line.unit,
    quantity: line.quantity,
    // Faktura w cenach brutto nie ma ceny netto (`unitPriceNetMissing`): NULL zamiast 0,
    // jak import od brutto (F12-E4); PDF i widoki biorą wtedy cenę brutto z dokumentu (#837).
    unit_price_net: line.unitPriceNetMissing ? null : line.unitPriceNet,
    net_amount: line.netAmount,
    vat_rate: line.vatRate,
    vat_amount: line.vatAmount,
    gross_amount: line.grossAmount,
  }));
}
