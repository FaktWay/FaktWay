/**
 * Potwierdzenie salda z kontrahentem (plan kompletnej aplikacji, krok 2.9,
 * część 2; decyzje D26-D28 w docs/koordynacja/DECYZJE-2026-11-25.md): typy
 * i reguły wspólne dla bazy (00216), obliczenia, PDF, maila i ekranów. Moduł
 * bez importów serwerowych, więc nadaje się i do klienta.
 *
 * Saldo liczy baza (`balance_confirmation_preview`, 00216) tym samym warunkiem
 * co Pulpit; tu tylko kształt danych. Wiersz w nieznanym kształcie to `null`:
 * treści dokumentu dla kontrahenta nie zgadujemy.
 */

/** Przedrostek serii, ten sam co w CHECK `balance_confirmations_number_check` (00216). */
export const BALANCE_NUMBER_PREFIX = 'PS';

/** W tej wersji tylko złote (CHECK `balance_confirmations_currency_check`). */
export const BALANCE_CURRENCY = 'PLN';

/** Kto wystawia i wysyła: każdy aktywny członek firmy, jak przy notach (00193) i w funkcjach 00216. */
export const BALANCE_WRITER_ROLES = ['owner', 'admin', 'member', 'accountant'] as const;

export function canIssueBalanceConfirmations(role: string | null | undefined): boolean {
  return typeof role === 'string' && (BALANCE_WRITER_ROLES as readonly string[]).includes(role);
}

/** Powody pominięcia faktury (CHECK `balance_confirmation_omitted_valid`, 00216). */
export const OMITTED_REASONS = [
  'corrected',
  'correction_due',
  'advance_settlement',
  'advance_settled',
  'awaiting_ksef_number',
  'imported',
  'foreign_currency',
] as const;
export type OmittedReason = (typeof OMITTED_REASONS)[number];

/** Kody odmów funkcji 00216 (nagłówek migracji). */
export const BALANCE_REFUSAL_CODES = [
  'disabled',
  'contractor_not_found',
  'contractor_nip_missing',
  'contractor_incomplete',
  'issuer_incomplete',
  'environment_unknown',
  'too_many',
  'changed',
  'nothing_due',
  'omitted_not_confirmed',
] as const;
export type BalanceRefusalCode = (typeof BALANCE_REFUSAL_CODES)[number];

export function isBalanceRefusalCode(value: unknown): value is BalanceRefusalCode {
  return typeof value === 'string' && (BALANCE_REFUSAL_CODES as readonly string[]).includes(value);
}

/** Migawka strony dokumentu: wystawca (z `tenants`) albo adresat (z `contractors`). */
export interface BalanceParty {
  name: string;
  nip: string;
  countryCode: string;
  addressLine1: string;
  addressLine2: string;
  email: string | null;
}

export type BalanceItemKind = 'regular' | 'advance' | 'final';

/** Pozycja dokumentu: faktura sprzedaży z kwotami w złotych (z groszami). */
export interface BalanceItem {
  invoiceId: string;
  number: string;
  ksefNumber: string | null;
  issueDate: string;
  dueDate: string | null;
  kind: BalanceItemKind;
  type: 'VAT' | 'UPR' | 'ZAL' | 'ROZ';
  /** Brutto faktury (przy ROZ całe zamówienie). */
  gross: number;
  /** Do zapłaty z faktury: przy ROZ reszta po zaliczkach, inaczej brutto. */
  amountDue: number;
  paid: number;
  /** Do zapłaty po wpłatach. */
  outstanding: number;
}

/** Faktura kontrahenta poza saldem, z powodem. */
export interface BalanceOmitted {
  invoiceId: string;
  number: string;
  ksefNumber: string | null;
  issueDate: string;
  kind: string;
  type: string | null;
  /** Waluta faktury; `null` to złote (jak w należnościach). */
  currency: string | null;
  gross: number;
  reason: OmittedReason;
}

/** Treść zestawienia: to samo w podglądzie i w wystawionym dokumencie. */
export interface BalanceContent {
  contractorId: string | null;
  /** Dzień salda RRRR-MM-DD (w tej wersji dzień wystawienia w Polsce). */
  asOf: string;
  counterparty: BalanceParty;
  issuer: BalanceParty;
  items: BalanceItem[];
  omitted: BalanceOmitted[];
  /** Saldo: suma kwot do zapłaty pozycji, PLN. */
  total: number;
}

export interface BalancePreview extends BalanceContent {
  /** Odcisk treści z bazy; wystawienie przyjmuje tylko ten odcisk. */
  fingerprint: string;
}

export interface BalanceConfirmation extends BalanceContent {
  id: string;
  tenantId: string;
  number: string;
  issuedAt: string;
}

export interface BalanceEmailRecord {
  id: string;
  recipient: string;
  sentAt: string;
}

/** Numer w kształcie z bazy (00216): `PS/1/2026`. */
export function formatBalanceNumber(seq: number, year: number): string {
  return `${BALANCE_NUMBER_PREFIX}/${seq}/${year}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ITEM_PAIRS: Record<BalanceItemKind, readonly string[]> = { regular: ['VAT', 'UPR'], advance: ['ZAL'], final: ['ROZ'] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Kwota z JSON-a: liczba skończona (numeric z PostgREST bywa też napisem). */
function money(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function day(value: unknown): string | null {
  return typeof value === 'string' && ISO_DAY.test(value) ? value : null;
}

/** Migawka strony; bez nazwy albo NIP to null. */
export function balancePartyFromJson(value: unknown): BalanceParty | null {
  if (!isRecord(value)) return null;
  const name = text(value.name)?.trim() ?? '';
  const nip = text(value.nip)?.trim() ?? '';
  if (!name || !nip) return null;
  return {
    name,
    nip,
    countryCode: text(value.countryCode)?.trim() || 'PL',
    addressLine1: text(value.addressLine1)?.trim() ?? '',
    addressLine2: text(value.addressLine2)?.trim() ?? '',
    email: text(value.email)?.trim() || null,
  };
}

function itemFromJson(raw: unknown): BalanceItem | null {
  if (!isRecord(raw)) return null;
  const invoiceId = text(raw.invoiceId);
  const number = text(raw.number);
  const issueDate = day(raw.issueDate);
  const dueDate = raw.dueDate === null ? null : day(raw.dueDate);
  const kind = raw.kind === 'regular' || raw.kind === 'advance' || raw.kind === 'final' ? raw.kind : null;
  const type = text(raw.type);
  const gross = money(raw.gross);
  const amountDue = money(raw.amountDue);
  const paid = money(raw.paid);
  const outstanding = money(raw.outstanding);
  if (!invoiceId || !UUID.test(invoiceId) || !number || !issueDate || !kind || !type) return null;
  if (raw.dueDate !== null && dueDate === null) return null;
  if (!ITEM_PAIRS[kind].includes(type)) return null;
  if (gross === null || amountDue === null || paid === null || outstanding === null) return null;
  const ksefNumber = raw.ksefNumber === null ? null : text(raw.ksefNumber);
  if (raw.ksefNumber !== null && ksefNumber === null) return null;
  return {
    invoiceId,
    number,
    ksefNumber,
    issueDate,
    dueDate,
    kind,
    type: type as BalanceItem['type'],
    gross,
    amountDue,
    paid,
    outstanding,
  };
}

function omittedFromJson(raw: unknown): BalanceOmitted | null {
  if (!isRecord(raw)) return null;
  const invoiceId = text(raw.invoiceId);
  const number = text(raw.number);
  const issueDate = day(raw.issueDate);
  const kind = text(raw.kind);
  const gross = money(raw.gross);
  const reason = (OMITTED_REASONS as readonly unknown[]).includes(raw.reason) ? (raw.reason as OmittedReason) : null;
  if (!invoiceId || !UUID.test(invoiceId) || !number || !issueDate || !kind || gross === null || !reason) return null;
  if (raw.type !== null && text(raw.type) === null) return null;
  if (raw.currency !== null && text(raw.currency) === null) return null;
  if (raw.ksefNumber !== null && text(raw.ksefNumber) === null) return null;
  return {
    invoiceId,
    number,
    ksefNumber: raw.ksefNumber === null ? null : text(raw.ksefNumber),
    issueDate,
    kind,
    type: raw.type === null ? null : text(raw.type),
    currency: raw.currency === null ? null : text(raw.currency),
    gross,
    reason,
  };
}

/** Pozycje z JSONB; jedna zła pozycja to null dla całości. */
export function balanceItemsFromJson(value: unknown): BalanceItem[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.map(itemFromJson);
  return items.every((item): item is BalanceItem => item !== null) ? items : null;
}

/** Pominięte z JSONB; jedna zła pozycja to null dla całości. */
export function balanceOmittedFromJson(value: unknown): BalanceOmitted[] | null {
  if (!Array.isArray(value)) return null;
  const omitted = value.map(omittedFromJson);
  return omitted.every((item): item is BalanceOmitted => item !== null) ? omitted : null;
}

export type BalancePreviewResult =
  | { ok: true; preview: BalancePreview }
  | { ok: false; code: BalanceRefusalCode; omittedCount?: number; count?: number };

/**
 * Wynik `balance_confirmation_preview` albo odmowy `issue_balance_confirmation`
 * (00216). Nieznany kształt albo nieznany kod to null (błąd, nie odmowa).
 */
export function balancePreviewFromRpc(data: unknown): BalancePreviewResult | null {
  if (!isRecord(data)) return null;
  if (data.status === 'refused') {
    if (!isBalanceRefusalCode(data.code)) return null;
    const omittedCount = money(data.omitted_count);
    const count = money(data.count);
    return {
      ok: false,
      code: data.code,
      ...(omittedCount !== null ? { omittedCount } : {}),
      ...(count !== null ? { count } : {}),
    };
  }
  if (data.status !== 'ok') return null;
  const asOf = day(data.as_of);
  const counterparty = balancePartyFromJson(data.counterparty);
  const issuer = balancePartyFromJson(data.issuer);
  const items = balanceItemsFromJson(data.items);
  const omitted = balanceOmittedFromJson(data.omitted);
  const total = money(data.total);
  const fingerprint = text(data.fingerprint);
  const contractorId = text(data.contractor_id);
  if (!asOf || !counterparty || !issuer || !items || !omitted || total === null || !fingerprint || !contractorId) return null;
  if (data.currency !== BALANCE_CURRENCY) return null;
  return { ok: true, preview: { contractorId, asOf, counterparty, issuer, items, omitted, total, fingerprint } };
}

/** Wiersz `balance_confirmations` → dokument; nieznany kształt to null. */
export function balanceConfirmationFromRow(row: unknown): BalanceConfirmation | null {
  if (!isRecord(row)) return null;
  const id = text(row.id);
  const tenantId = text(row.tenant_id);
  const number = text(row.number);
  const asOf = day(row.as_of);
  const issuedAt = text(row.issued_at);
  const counterparty = balancePartyFromJson(row.counterparty);
  const issuer = balancePartyFromJson(row.issuer);
  const items = balanceItemsFromJson(row.items);
  const omitted = balanceOmittedFromJson(row.omitted);
  const total = money(row.total);
  if (!id || !tenantId || !number || !asOf || !issuedAt || !counterparty || !issuer || !items || !omitted || total === null) {
    return null;
  }
  if (row.currency !== BALANCE_CURRENCY) return null;
  return { id, tenantId, number, asOf, issuedAt, contractorId: text(row.contractor_id), counterparty, issuer, items, omitted, total };
}
