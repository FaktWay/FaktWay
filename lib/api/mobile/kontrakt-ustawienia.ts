/**
 * Kontrakt zapisów ustawień z telefonu (plan aplikacji mobilnej, M10c). Czyta
 * go też aplikacja przez Metro (`mobile/src/lib/api/kontrakt-ustawienia.ts`),
 * więc plik nie ma importów (pilnuje `tests/unit/mobile-api-ustawienia-zapis.test.ts`).
 *
 * Odmowa danych: 422 `settings_invalid` ze zdaniem strony i `field` (pole
 * formularza telefonu, nazwy jak w treści żądania). Rola: 403 `forbidden`.
 */

// ─── Firma: dane, rachunek, data rozpoczęcia, VAT ────────────────────

/**
 * `POST /api/mobile/v1/ustawienia/firma`: jedna zmiana na żądanie, jak osobne
 * formularze strony (każda ma własny wpis w dzienniku zdarzeń). Pusty tekst
 * czyści wartość (rachunek, data, zwolnienie: czynny podatnik VAT). Tylko
 * właściciel i administrator. Odpowiedź: karty po zapisie, ten sam kształt co
 * `GET /ustawienia` (`UstawieniaOdpowiedz` z `kontrakt.ts`).
 */
export type ZmianaFirmyZadanie =
  | { zmiana: 'dane'; nazwa: string; adres1: string; adres2: string }
  | { zmiana: 'rachunek'; rachunek: string }
  /** RRRR-MM-DD albo pusty tekst. */
  | { zmiana: 'rozpoczecie'; data: string }
  /** Podstawa prawna zwolnienia z VAT albo pusty tekst (czynny podatnik VAT). */
  | { zmiana: 'zwolnienie'; podstawa: string }
  | { zmiana: 'metodaKasowa'; wlaczona: boolean };

/** Podstawy zwolnienia, które strona podpowiada (`VAT_EXEMPTION_PRESETS`); inne wpisuje się tekstem. */
export const PODSTAWY_ZWOLNIENIA_VAT = [
  { podstawa: 'art. 113 ust. 1 ustawy o VAT', etykieta: 'Zwolnienie podmiotowe, sprzedaż do 240 000 zł rocznie (art. 113 ust. 1)' },
  { podstawa: 'art. 113 ust. 9 ustawy o VAT', etykieta: 'Zwolnienie podmiotowe, działalność rozpoczęta w tym roku (art. 113 ust. 9)' },
] as const;

// ─── Przypomnienia o zapłacie ────────────────────────────────────────

/**
 * `POST /api/mobile/v1/ustawienia/przypomnienia`: cały formularz strony naraz,
 * te same granice (etap 1 do 90 dni po terminie, godzina 6 do 18, najwyżej 1 do
 * 20 przypomnień na fakturę). Tylko właściciel (zakładka strony też tylko dla
 * niego). Po zapisie FaktWay przygotowuje przypomnienia (bez zapisu nie).
 * Odpowiedź jak `GET /ustawienia`.
 */
export interface PrzypomnieniaZadanie {
  wlaczone: boolean;
  /** Dokładnie trzy etapy, w kolejności 1, 2, 3. */
  etapy: Array<{ etap: 1 | 2 | 3; wlaczony: boolean; dniPoTerminie: number }>;
  godzina: number;
  tylkoDniRobocze: boolean;
  najwiecej: number;
  /** Pusty tekst: nazwa firmy. */
  nadawca: string;
  /** Adres do odpowiedzi klienta; pusty tekst: bez adresu. */
  odpowiedzNa: string;
  wstrzymajPoOdpowiedzi: boolean;
  wstrzymajPoCzesciowej: boolean;
}

// ─── Powiadomienia e-mail ────────────────────────────────────────────

/** Kategorie e-maili, które klient może wyłączyć (jak strona: porady i nowości, oferty). Transakcyjnych nie. */
export type KategoriaEmaila = 'porady' | 'oferty';

/**
 * `GET /api/mobile/v1/ustawienia/powiadomienia` (konto, bez firmy). Przełącznik
 * jest włączony tylko przy zgodzie i bez wypisu, jak wysyłka (`canSendTo`).
 * `email: null`: odczyt się nie udał, telefon nie pokazuje przełączników.
 */
export interface PowiadomieniaOdpowiedz {
  email: Record<KategoriaEmaila, boolean> | null;
}

/** `POST /api/mobile/v1/ustawienia/powiadomienia`: włączenie to zgoda na tę kategorię, wyłączenie to jej wycofanie. */
export interface ZmianaPowiadomienZadanie {
  kategoria: KategoriaEmaila;
  wlaczone: boolean;
}
