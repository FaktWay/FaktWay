import { z } from 'zod';

import type { KorektaTelefonu, NabywcaRodzajuTelefonu, PozycjaRodzajuTelefonu, RozliczenieTelefonu, ZaliczkaTelefonu } from '@/lib/api/mobile/kontrakt';
import { MAX_POZYCJI_TELEFONU } from '@/lib/api/mobile/schematy';
import type { getCorrectionParentContext } from '@/lib/invoices/issue-correction';

/**
 * Schematy treści zaliczki, rozliczenia i korekty z telefonu (plan aplikacji
 * mobilnej, M8b) i zamiana na wartości formularzy strony.
 *
 * Jak w `schematy.ts` (M8): tu tylko kształt (pola i typy z kontraktu); treść
 * spoza kontraktu to błąd programu w telefonie (400 `invalid_request`). Zasady
 * dokumentu sprawdza potem schemat formularza strony (`advanceInvoiceSchema`,
 * `finalInvoiceSchema`, `correctionInvoiceSchema`) i ta sama logika zapisu co
 * strona (`lib/invoices/issue-*.ts`), z błędem dla klienta i polem (422
 * `invoice_invalid`). Typy wyjścia są równe typom kontraktu (test
 * `tests/unit/mobile-api-faktury-rodzaje.test.ts`).
 */

const metoda = z.enum(['transfer', 'cash', 'card', 'compensation', 'other']);

export const nabywcaRodzajuSchema = z.strictObject({
  nip: z.string(),
  name: z.string(),
  addressLine1: z.string(),
  addressLine2: z.string(),
  email: z.string(),
});

export const pozycjaRodzajuSchema = z.strictObject({
  name: z.string(),
  unit: z.string(),
  quantity: z.number(),
  unitPriceNet: z.number(),
  vatRate: z.enum(['23', '8', '5', '0', 'oo', 'np', 'np_ii']),
});

const dokument = {
  internalNumber: z.string(),
  issueDate: z.string(),
  paymentMethod: metoda,
  paymentDueDate: z.string(),
  bankAccount: z.string(),
  notes: z.string(),
  numberSeriesId: z.string(),
  numberPreview: z.string(),
};

export const zaliczkaTelefonuSchema = z.strictObject({
  ...dokument,
  splitPayment: z.boolean(),
  buyer: nabywcaRodzajuSchema,
  advanceAmount: z.number(),
  totalContractAmount: z.number(),
  expectedDeliveryDate: z.string(),
  advanceReceivedDate: z.string(),
  vatRate: z.enum(['23', '8', '5', '0']),
  description: z.string(),
});

export const rozliczenieTelefonuSchema = z.strictObject({
  ...dokument,
  splitPayment: z.boolean(),
  buyer: nabywcaRodzajuSchema,
  advanceInvoiceIds: z.array(z.string()).max(MAX_POZYCJI_TELEFONU),
  lines: z.array(pozycjaRodzajuSchema).max(MAX_POZYCJI_TELEFONU),
});

export const korektaTelefonuSchema = z.strictObject({
  ...dokument,
  parentInvoiceId: z.string(),
  correctionType: z.enum(['before_after', 'amount_change', 'cancellation']),
  correctionReason: z.string(),
  typKorekty: z.enum(['1', '2', '3']),
  linesAfter: z.array(pozycjaRodzajuSchema).max(MAX_POZYCJI_TELEFONU),
  amountChange: z
    .strictObject({ netDelta: z.number(), vatDelta: z.number(), grossDelta: z.number(), description: z.string() })
    .nullable(),
});

/** `POST /faktury` dla rodzajów spoza zwykłej faktury (M8b): dokładnie jeden z kluczy. */
export const wystawienieRodzajuSchema = z.union([
  z.strictObject({ wyslij: z.boolean(), zaliczka: zaliczkaTelefonuSchema }),
  z.strictObject({ wyslij: z.boolean(), rozliczenie: rozliczenieTelefonuSchema }),
  z.strictObject({ wyslij: z.boolean(), korekta: korektaTelefonuSchema }),
]);

/** `POST /faktury/wyliczenie` (M8b): ta sama treść bez `wyslij`. */
export const wyliczenieSchema = z.union([
  z.strictObject({ zaliczka: zaliczkaTelefonuSchema }),
  z.strictObject({ rozliczenie: rozliczenieTelefonuSchema }),
  z.strictObject({ korekta: korektaTelefonuSchema }),
]);

/** Treść żądania z kluczem rodzaju: zwykła faktura (M8) ma klucz `faktura`. */
export function rodzajTresci(value: unknown): 'zaliczka' | 'rozliczenie' | 'korekta' | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  for (const k of ['zaliczka', 'rozliczenie', 'korekta'] as const) if (k in value) return k;
  return null;
}

/** Sprzedawca formularza strony: dane firmy z bazy (`sellerFromTenantProfile`), nigdy z telefonu. */
export interface SprzedawcaFormularza {
  nip: string;
  name: string;
  address: { addressLine1: string; addressLine2: string; countryCode: string };
}

const pustyNaBrak = (v: string): string | undefined => (v.trim() === '' ? undefined : v);

/** Nabywca B2B jak w formularzach zaliczki i rozliczenia strony (kraj adresu PL). */
function nabywcaB2B(b: NabywcaRodzajuTelefonu) {
  return {
    type: 'b2b' as const,
    idType: 'nip' as const,
    nip: b.nip.replace(/\D/g, ''),
    name: b.name,
    address: { addressLine1: b.addressLine1, addressLine2: b.addressLine2, countryCode: 'PL' },
    ...(pustyNaBrak(b.email) ? { email: b.email.trim() } : {}),
  };
}

const pozycja = (l: PozycjaRodzajuTelefonu) => ({
  name: l.name,
  unit: l.unit,
  quantity: l.quantity,
  unitPriceNet: l.unitPriceNet,
  vatRate: l.vatRate,
});

/** Numer z serii jak w formularzu strony; klucz żądania telefonu jest kluczem zapisu faktury (00199). */
function numeracja(d: { numberSeriesId: string; numberPreview: string }, klucz: string) {
  return { numberSeriesId: d.numberSeriesId, numberPreview: d.numberPreview, numberRequestKey: klucz };
}

/** Wartości `advanceInvoiceSchema` (formularz zaliczki strony) z zaliczki telefonu. */
export function zaliczkaDoFormularza(z: ZaliczkaTelefonu, sprzedawca: SprzedawcaFormularza, klucz: string): Record<string, unknown> {
  return {
    invoiceType: 'advance',
    internalNumber: z.internalNumber,
    ...numeracja(z, klucz),
    issueDate: z.issueDate,
    paymentMethod: z.paymentMethod,
    paymentDueDate: z.paymentDueDate,
    bankAccount: z.bankAccount.replace(/\s/g, ''),
    splitPayment: z.splitPayment,
    notes: z.notes,
    seller: sprzedawca,
    buyer: nabywcaB2B(z.buyer),
    advanceAmount: z.advanceAmount,
    totalContractAmount: z.totalContractAmount,
    ...(pustyNaBrak(z.expectedDeliveryDate) ? { expectedDeliveryDate: z.expectedDeliveryDate } : {}),
    ...(pustyNaBrak(z.advanceReceivedDate) ? { advanceReceivedDate: z.advanceReceivedDate } : {}),
    vatRate: z.vatRate,
    description: z.description,
  };
}

/**
 * Wartości `finalInvoiceSchema` (formularz rozliczenia strony). `totalAdvances: 0`:
 * sumę zaliczek liczy serwer z bazy (`resolveFinalPayload`); porównanie z koszykiem
 * formularza strony pomija się przy zerze, bo telefon kwot nie liczy, a kwotę do
 * zapłaty pokazuje z `POST /faktury/wyliczenie`.
 */
export function rozliczenieDoFormularza(r: RozliczenieTelefonu, sprzedawca: SprzedawcaFormularza, klucz: string): Record<string, unknown> {
  return {
    invoiceType: 'final',
    internalNumber: r.internalNumber,
    ...numeracja(r, klucz),
    issueDate: r.issueDate,
    paymentMethod: r.paymentMethod,
    paymentDueDate: r.paymentDueDate,
    bankAccount: r.bankAccount.replace(/\s/g, ''),
    splitPayment: r.splitPayment,
    notes: r.notes,
    seller: sprzedawca,
    buyer: nabywcaB2B(r.buyer),
    advanceInvoiceIds: r.advanceInvoiceIds.map((id) => id.toLowerCase()),
    totalAdvances: 0,
    lines: r.lines.map(pozycja),
  };
}

type KontekstKorekty = Extract<Awaited<ReturnType<typeof getCorrectionParentContext>>, { success: true }>;

/**
 * Wartości `correctionInvoiceSchema` (formularz korekty strony). Sprzedawca,
 * nabywca, numer, daty i numer KSeF faktury pierwotnej oraz pozycje „przed”
 * z kontekstu serwera (`getCorrectionParentContext`, z bazy), tak jak formularz
 * strony je wypełnia; zapis i tak sprawdza je drugi raz z bazy (`normalizePayload`).
 */
export function korektaDoFormularza(k: KorektaTelefonu, kontekst: KontekstKorekty, klucz: string): Record<string, unknown> {
  return {
    invoiceType: 'correction',
    internalNumber: k.internalNumber,
    ...numeracja(k, klucz),
    issueDate: k.issueDate,
    paymentMethod: k.paymentMethod,
    paymentDueDate: k.paymentDueDate,
    bankAccount: k.bankAccount.replace(/\s/g, ''),
    notes: k.notes,
    parentInvoiceId: k.parentInvoiceId.toLowerCase(),
    parentInvoiceNumber: kontekst.internalNumber ?? '',
    parentInvoiceIssueDate: kontekst.issueDate,
    ...(kontekst.ksefNumber ? { parentKsefNumber: kontekst.ksefNumber } : {}),
    correctionType: k.correctionType,
    correctionReason: k.correctionReason,
    typKorekty: k.typKorekty,
    seller: kontekst.seller,
    buyer: kontekst.buyer,
    linesBefore: kontekst.linesBefore,
    linesAfter: k.correctionType === 'before_after' ? k.linesAfter.map(pozycja) : kontekst.linesAfter,
    ...(k.correctionType === 'amount_change' && k.amountChange
      ? { amountChange: { ...k.amountChange, ...(kontekst.amountChangeVatRate ? { vatRate: kontekst.amountChangeVatRate } : {}) } }
      : {}),
  };
}
