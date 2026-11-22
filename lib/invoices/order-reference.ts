import { formatIsoDatePl } from '@/lib/format/iso-date';
import { FA3_DATE_LIMITS, FA3_TEXT_LIMITS, xsdLength } from '@/lib/xml/fa3-limits';
import type { InvoiceOrder } from '@/types/invoice';

/**
 * Numer zamówienia na zwykłej fakturze (plan kompletnej aplikacji, krok 2.8):
 * wspólne reguły dla formularza, budowania faktury, odczytu dokumentu faktury,
 * PDF i szczegółów. FA(3): `Fa/WarunkiTransakcji/Zamowienia`. Jeden numer
 * na fakturę (z opcjonalną datą): XSD dopuszcza do 100 zamówień, ale lista
 * wymagałaby tabeli w formularzu, a typowy odbiorca (sieć, urząd, firma
 * z systemem zamówień) wymaga jednego numeru na fakturze.
 *
 * Moduł czysty, bez zależności serwerowych: trafia do paczki przeglądarki
 * razem ze schematem formularza.
 */

/** Najdłuższy numer zamówienia: `NrZamowienia` w XSD to TZnakowy (256 znaków). */
export const ORDER_NUMBER_MAX = FA3_TEXT_LIMITS.nrZamowienia.max;

/** Najstarsza data zamówienia, jaką przyjmujemy (zabezpieczenie przed literówką w roku). */
export const ORDER_DATE_MIN = '2000-01-01';

/** Najpóźniejsza data zamówienia: górna granica `TDataU` w XSD (2050-01-01). */
export const ORDER_DATE_MAX = FA3_DATE_LIMITS.max;

export const ORDER_DATE_WITHOUT_NUMBER_MESSAGE = 'Podaj numer zamówienia albo usuń datę zamówienia.';
export const ORDER_DATE_TOO_LATE_MESSAGE = 'Data zamówienia musi być nie późniejsza niż 1 stycznia 2050 r.';
export const ORDER_DATE_INVALID_MESSAGE = 'Wpisz prawdziwą datę zamówienia w formacie RRRR-MM-DD, nie wcześniejszą niż 2000-01-01.';

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Prawdziwy dzień kalendarzowy RRRR-MM-DD (bez 30 lutego), liczony bez `Date`. */
export function isOrderCalendarDay(value: string): boolean {
  const m = ISO_DAY.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day <= days;
}

/** Numer z pola formularza po przycięciu; pusty albo z samych spacji to brak. */
function trimmedNumber(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Zamówienie z pól formularza (`orderNumber`, `orderDate`): numer po przycięciu
 * i data tylko, gdy jest numer. Bez numeru `undefined`, więc faktura nie dostaje
 * klucza `order` i jej plik FA(3) i PDF są takie jak dotąd.
 */
export function orderFromFormValues(values: { orderNumber?: unknown; orderDate?: unknown }): InvoiceOrder | undefined {
  const number = trimmedNumber(values.orderNumber);
  if (number === '') return undefined;
  const date = trimmedNumber(values.orderDate);
  return date !== '' && isOrderCalendarDay(date) ? { number, date } : { number };
}

/**
 * Zamówienie z dokumentu faktury (`fa3_data.order`, `jsonb`): zły kształt,
 * numer pusty albo dłuższy niż w XSD to brak zamówienia (PDF i szczegóły nie
 * pokazują niczego), zła data to brak daty.
 */
export function orderFromJson(raw: unknown): InvoiceOrder | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const number = trimmedNumber(o.number);
  if (number === '' || xsdLength(number, FA3_TEXT_LIMITS.nrZamowienia.kind) > ORDER_NUMBER_MAX) return null;
  const date = trimmedNumber(o.date);
  return date !== '' && isOrderCalendarDay(date) ? { number, date } : { number };
}

/** „Zamówienie: ZAM/1 z dnia 02.11.2026” albo „Zamówienie: ZAM/1”; wiersz PDF i szczegółów faktury. */
export function orderLine(order: InvoiceOrder): string {
  return `Zamówienie: ${order.number}${order.date ? ` z dnia ${formatIsoDatePl(order.date)}` : ''}`;
}

/** Gotowy tekst dla szczegółów faktury z `fa3_data`; reszta dokumentu zostaje na serwerze. `null` bez zamówienia. */
export function orderReferenceView(fa3: unknown): string | null {
  if (!fa3 || typeof fa3 !== 'object' || Array.isArray(fa3)) return null;
  const order = orderFromJson((fa3 as Record<string, unknown>).order);
  return order ? orderLine(order) : null;
}
