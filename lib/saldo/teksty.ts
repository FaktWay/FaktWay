/**
 * Teksty potwierdzenia salda (krok 2.9, część 2; decyzje D27 i D28)
 * w jednym miejscu: PDF, mail, ekrany i odmowy akcji. Bez długich myślników
 * (strażnik tekstów) i bez porad prawnych.
 *
 * D28: dokument nie pisze nic o uznaniu długu ani o przedawnieniu (uznanie
 * roszczenia przez dłużnika przerywa bieg przedawnienia, art. 123 § 1 pkt 2
 * KC, więc zdanie „to nie jest uznanie długu” na dokumencie wierzyciela
 * mogłoby mu zaszkodzić). Dopisek o zakresie jest dosłownie z decyzji.
 */
import { formatPlMoney } from '@/lib/format/pl';
import type { BalanceRefusalCode, OmittedReason } from '@/lib/saldo/model';

/** Nazwa dokumentu: PDF, mail, ekrany. */
export const BALANCE_TITLE = 'Potwierdzenie salda';

/** Prośba do adresata (plan kroku, pkt 4). */
export const BALANCE_REQUEST =
  'Prosimy o potwierdzenie zgodności salda ze stanem Państwa ewidencji albo o wskazanie różnic (numer dokumentu i kwota) w odpowiedzi na ten dokument.';

/** Dopisek z decyzji D28, dosłownie. */
export const BALANCE_SCOPE_NOTICE =
  'Zestawienie obejmuje wymienione faktury sprzedaży. Nie zawiera odsetek ani not. Nie jest wezwaniem do zapłaty ani fakturą.';

/** Przypis przy fakturze rozliczającej zaliczki (ROZ): kwota do zapłaty to reszta po zaliczkach. */
export const BALANCE_SETTLEMENT_NOTE =
  'Faktura rozliczająca zaliczki: do zapłaty jest kwota po odliczeniu zaliczek (art. 106f ust. 3 ustawy o VAT).';

/** Zdanie o saldzie (PDF, mail, podgląd). */
export function balanceSummarySentence(total: number): string {
  return `Saldo należności wystawcy od adresata według ewidencji wystawcy: ${formatPlMoney(total)} PLN.`;
}

/** Powód pominięcia faktury na liście „Pominięte dokumenty” (ekran wystawienia, D27 K4). */
export const OMITTED_REASON_LABELS: Record<OmittedReason, string> = {
  corrected: 'Faktura ma korektę, a FaktWay nie liczy jeszcze salda po korektach.',
  correction_due: 'Faktura korygująca do zapłaty, a FaktWay nie liczy jeszcze salda po korektach.',
  advance_settlement: 'Zaliczka ma fakturę rozliczającą, której nie ma jeszcze w KSeF.',
  imported: 'Faktura z importu: FaktWay nie zna jej wpłat. Zapłaconą można oznaczyć na liście faktur.',
  foreign_currency: 'Faktura w walucie obcej: zestawienie obejmuje tylko faktury w złotych.',
};

/** Odmowy z bazy (00215): przyczyna i wyjście (protokół napraw, pkt 4). */
export const BALANCE_REFUSALS: Record<BalanceRefusalCode, string> = {
  disabled:
    'Potwierdzenie salda nie jest jeszcze dostępne w FaktWay. Jeśli potrzebujesz zestawienia dla kontrahenta, napisz do nas przez Pomoc.',
  contractor_not_found:
    'Nie znaleziono tego kontrahenta w bazie kontrahentów firmy. Odśwież stronę Kontrahenci i wybierz kontrahenta ponownie.',
  contractor_nip_missing:
    'Kontrahent nie ma NIP, więc FaktWay nie przypisze mu faktur. Dopisz NIP w danych kontrahenta i spróbuj ponownie.',
  contractor_incomplete:
    'Dane kontrahenta są niepełne albo za długie (nazwa, NIP, adres). Popraw je w Kontrahentach i spróbuj ponownie.',
  issuer_incomplete:
    'Uzupełnij dane firmy w Ustawieniach (nazwa, NIP i adres), a potem wystaw potwierdzenie salda. Te dane trafiają na dokument jako dane wystawcy.',
  environment_unknown:
    'Część przyjętych faktur tego kontrahenta nie ma zapisanego środowiska KSeF, więc FaktWay nie policzy salda. Napisz do nas przez Pomoc, a uzgodnimy te faktury.',
  too_many:
    'Kontrahent ma więcej faktur, niż mieści jedno zestawienie (1000 do zapłaty albo 5000 pominiętych). Napisz do nas przez Pomoc.',
  changed:
    'Faktury albo wpłaty tego kontrahenta zmieniły się od otwarcia podglądu. Odśwież podgląd, sprawdź zestawienie i wystaw je ponownie.',
  nothing_due:
    'Kontrahent nie ma nieopłaconych faktur w złotych, więc nie ma salda do potwierdzenia.',
  omitted_not_confirmed:
    'Część faktur kontrahenta nie wchodzi do zestawienia. Sprawdź listę pominiętych dokumentów i wybierz „Wystaw bez tych dokumentów”, jeśli zestawienie ma wyjść bez nich.',
};

export const BALANCE_TEXTS = {
  role: 'Twoja rola w tej firmie nie pozwala wystawiać ani wysyłać potwierdzeń salda.',
  notFound: 'Nie znaleziono potwierdzenia salda. Mogło należeć do innej firmy.',
  readFailed: 'Nie udało się policzyć salda kontrahenta. Spróbuj ponownie za chwilę.',
  documentReadFailed: 'Nie udało się wczytać potwierdzenia salda. Spróbuj ponownie za chwilę.',
  receivablesFailed:
    'Nie udało się policzyć należności firmy do porównania z zestawieniem. Spróbuj ponownie za chwilę, a jeśli komunikat wraca, napisz do nas przez Pomoc.',
  issueFailed: 'Nie udało się wystawić potwierdzenia salda. Spróbuj ponownie za chwilę.',
  flagUnknown: 'Nie udało się sprawdzić, czy potwierdzenie salda jest dostępne. Spróbuj ponownie za chwilę.',
  /** Saldo z bazy różni się od należności na Pulpicie: dokument nie wychodzi, operator szuka przyczyny. */
  pulpitMismatch:
    'Saldo w zestawieniu różni się od należności tego kontrahenta na Pulpicie, więc nie wystawiliśmy dokumentu. Napisz do nas przez Pomoc, sprawdzimy różnicę.',
  emailInvalid: 'Podaj poprawny adres e-mail odbiorcy.',
  emailNotConfigured: 'Wysyłka e-mail nie jest skonfigurowana.',
  emailBlocked:
    'Nie wysłaliśmy potwierdzenia salda: ten adres wcześniej odrzucał pocztę albo zgłosił ją jako niechcianą. Sprawdź adres albo przekaż PDF inną drogą.',
  emailInProgress: 'To potwierdzenie salda właśnie wychodzi na ten adres. Odśwież stronę za chwilę i sprawdź historię wysyłek.',
  emailFailed: 'Nie udało się wysłać potwierdzenia salda. Spróbuj ponownie za chwilę.',
  emailNotRecorded:
    'Potwierdzenie salda zostało wysłane, ale nie udało się zapisać tego w historii wysyłek. Kliknij Wyślij jeszcze raz na ten sam adres: drugi mail nie wyjdzie, a historia się uzupełni.',
} as const;

/** Limit wysyłek mailem (jak przy notach i fakturach, AUD-102). */
export function balanceEmailLimitMessage(limit: number): string {
  return `Osiągnięto limit ${limit} wysyłek potwierdzeń salda mailem na godzinę. Spróbuj później.`;
}
