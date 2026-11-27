/**
 * Bezpiecznik daty wystawienia (`ISSUE_DATE_PASSED`, terminal, 00147) — dwie reguły:
 *
 *   - Decyzja Bartosza 06.10.2026 (00147, założenie B1(d)): dokument specjalny
 *     (KOR, ZAL, ROZ) wychodzi do KSeF tylko w dniu swojej daty wystawienia
 *     (Europe/Warsaw). W KSeF dokument wystawia się w dniu wysyłki
 *     (art. 106na ust. 1; F-092) — z wcześniejszą datą byłby fakturą offline
 *     bez oznaczeń.
 *   - B2a (plan „zero zgubionych faktur”, założenie robocze B1(a)): zwykła
 *     faktura, która nie wyszła w dniu wystawienia (P_1), wychodzi bez zmian
 *     do końca następnego dnia roboczego w czasie polskim (art. 106nda ust. 2,
 *     `calculateOfflineDeadline`; sobota i dni wolne od pracy się nie liczą).
 *     KSeF przyjmie ją też po terminie (scenariusz 13b), więc pilnuje go
 *     aplikacja. Data nieczytelna = odmowa.
 *
 * Dwa sprawdzenia: runner przed całą wysyłką (ponowienie, przejęcie) i hak
 * otwarcia sesji tuż przed plikiem — uwierzytelnienie, archiwum i sesja
 * KSeF trwają do kilkudziesięciu sekund i potrafią przeskoczyć północ.
 * Zostaje okno samego żądania z plikiem (poniżej sekundy). Lustra przy
 * zleceniu: `ksefResendFacts` (cron, operator, klient) i filtr kandydatów
 * crona (`ksef-lifecycle-reconcile.ts`).
 */

import { todayInWarsaw } from '@/lib/format/warsaw-date';

import { calculateOfflineDeadline, lastBusinessDayBefore } from './idempotency';
import { SEND_ERROR_CODES } from './send-error-classes';

/** Treść błędu ze znacznikiem kodu — klasyfikator czyta znacznik, klient dostaje resztę. */
export function issueDatePassedMessage(issueDate: string, today: string): string {
  return (
    `[${SEND_ERROR_CODES.ISSUE_DATE_PASSED}] Tego dokumentu nie wysłaliśmy do KSeF: ma datę wystawienia ` +
    `${issueDate || 'brak'}, a dziś jest ${today} — w KSeF dokument wystawia się w dniu wysyłki. ` +
    'Wróć do szkicu, usuń go i wystaw dokument od nowa z dzisiejszą datą.'
  );
}

/** Odmowa z haka sesji (`submitInvoiceFullFlow`) — runner zamienia ją na `NonRetriableError`. */
export class IssueDatePassedError extends Error {
  readonly name = 'IssueDatePassedError';

  constructor(readonly issueDate: string, readonly today: string, message: string = issueDatePassedMessage(issueDate, today)) {
    super(message);
  }
}

/** Reguła 00147 jako predykat (zlecenie z kopii, A4b PR2a): data wystawienia dokumentu specjalnego = dziś w Polsce. */
export function specialIssueDateIsToday(issueDate: unknown, now: Date = new Date()): boolean {
  return typeof issueDate === 'string' && issueDate === todayInWarsaw(now);
}

/** `YYYY-MM-DD`, który istnieje w kalendarzu (nie 2026-02-30, nie data z godziną). */
function isCalendarDay(value: unknown): value is string {
  const match = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * B2a: ostatni dzień (czas polski), w którym zwykła faktura z tą datą
 * wystawienia może wyjść do KSeF — następny dzień roboczy po niej;
 * `null` = data nieczytelna.
 */
export function regularSendDeadlineDay(issueDate: unknown): string | null {
  return isCalendarDay(issueDate) ? todayInWarsaw(calculateOfflineDeadline(issueDate, false)) : null;
}

/** B2a jako predykat: zwykłą fakturę wolno wysłać do końca dnia `regularSendDeadlineDay` włącznie. */
export function regularIssueDateSendable(issueDate: unknown, now: Date = new Date()): boolean {
  const deadline = regularSendDeadlineDay(issueDate);
  return deadline !== null && todayInWarsaw(now) <= deadline;
}

/**
 * B2a dla zapytania (filtr kandydatów crona): najwcześniejsza data wystawienia
 * zwykłej faktury, którą dziś wolno wysłać — ostatni dzień roboczy przed dziś.
 * Dla poprawnej daty `regularIssueDateSendable(d, now)` ⟺ `d >= ta data`
 * (termin to następny dzień roboczy po `d`, więc mija dopiero wtedy, gdy
 * między `d` a dziś leży dzień roboczy; pilnuje tego test własności).
 */
export function regularSendableIssueDateFrom(now: Date = new Date()): string {
  return lastBusinessDayBefore(todayInWarsaw(now));
}

/** Treść odmowy zwykłej faktury po terminie (B2a) — znacznik kodu jak w `issueDatePassedMessage`. */
export function regularIssueDatePassedMessage(issueDate: string): string {
  const deadline = regularSendDeadlineDay(issueDate);
  const why = deadline
    ? `ma datę wystawienia ${issueDate}, a fakturę, która nie wyszła w dniu wystawienia, wysyłamy do KSeF ` +
      `najpóźniej do końca następnego dnia roboczego, a ten termin minął z końcem dnia ${deadline}.`
    : `nie ma poprawnej daty wystawienia (${issueDate || 'brak'}), więc nie sprawdzimy terminu jej przesłania do KSeF.`;
  return (
    `[${SEND_ERROR_CODES.ISSUE_DATE_PASSED}] Tej faktury nie wysłaliśmy do KSeF: ${why} ` +
    'Wróć do szkicu, usuń go i wystaw fakturę od nowa z dzisiejszą datą.'
  );
}

/** Rodzaj dokumentu dla reguły daty: wszystko poza zwykłą fakturą (także nieznane) ma regułę 00147. */
export type IssueDateRule = 'regular' | 'special';

export function issueDateRuleOf(kind: unknown): IssueDateRule {
  return kind === 'regular' ? 'regular' : 'special';
}

/** Czy dokument z tą datą wystawienia wolno teraz wysłać do KSeF (00147 albo B2a). */
export function issueDateSendable(rule: IssueDateRule, issueDate: unknown, now: Date = new Date()): boolean {
  return rule === 'regular' ? regularIssueDateSendable(issueDate, now) : specialIssueDateIsToday(issueDate, now);
}

/**
 * Bezpiecznik runnera i haka sesji: `IssueDatePassedError` z treścią dla
 * klienta, gdy dokumentu z tą datą nie wolno już wysłać.
 */
export function assertIssueDateSendable(rule: IssueDateRule, issueDate: string, now: Date = new Date()): void {
  if (issueDateSendable(rule, issueDate, now)) return;
  const today = todayInWarsaw(now);
  const message = rule === 'regular' ? regularIssueDatePassedMessage(issueDate) : issueDatePassedMessage(issueDate, today);
  throw new IssueDatePassedError(issueDate, today, message);
}
