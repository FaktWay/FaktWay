/**
 * Urząd skarbowy firmy w aplikacji, bez React Native (testy:
 * `tests/unit/mobile-urzad-skarbowy.test.ts`).
 *
 * Bez `tenants.tax_office_code` serwer odmawia czterech plików (JPK_V7M, JPK_FA,
 * JPK_EWP, JPK_PKPIR), bo `KodUrzedu` w pliku wskazywałby przypadkowy urząd.
 * Odmowa musi mieć wyjście (protokół naprawy, punkt 4): urząd ustawia się na
 * stronie `settings/accountant`, jak „Zmień na faktway.pl” na karcie Księgowa.
 */

/** Strona z polem urzędu skarbowego (`app/(dashboard)/settings/accountant`, tylko właściciel). */
export const STRONA_URZEDU = '/settings/accountant';

/** Pliki, których serwer nie wygeneruje bez urzędu skarbowego firmy. */
export const PLIKI_Z_URZEDEM = ['JPK_V7M', 'JPK_FA', 'JPK_EWP', 'JPK_PKPIR'] as const;

export const STOPKA_URZEDU = `Potrzebny do plików ${PLIKI_Z_URZEDEM.slice(0, -1).join(', ')} i ${PLIKI_Z_URZEDEM[PLIKI_Z_URZEDEM.length - 1]}.`;

export const TYTUL_USTAW_URZAD = 'Ustaw urząd na faktway.pl';

const TYLKO_WLASCICIEL = 'Urząd skarbowy ustawia właściciel firmy.';

export type KartaUrzedu = {
  /** Nazwa urzędu, a bez niej kod; „Nie wybrano”, gdy firma urzędu nie ma. */
  tytul: string;
  stopka: string;
  /** Wiersz akcji pod urzędem, gdy go brak i jest dokąd odesłać (adres serwera). */
  akcja: { tytul: string; sciezka: string } | null;
};

/** Karta Księgowa, część „Urząd skarbowy firmy” (`GET /ksiegowa`, tylko właściciel). */
export function kartaUrzedu(urzad: { kod: string; nazwa: string | null } | null, maAdresStrony: boolean): KartaUrzedu {
  return {
    tytul: urzad ? (urzad.nazwa ?? urzad.kod) : 'Nie wybrano',
    stopka: STOPKA_URZEDU,
    akcja: !urzad && maAdresStrony ? { tytul: TYTUL_USTAW_URZAD, sciezka: STRONA_URZEDU } : null,
  };
}

/**
 * Czy zdanie odmowy mówi o braku urzędu skarbowego firmy: „Plik JPK_V7M
 * potrzebuje urzędu skarbowego firmy…” (JPK_V7M, JPK_EWP, JPK_PKPIR),
 * „Najpierw ustaw urząd skarbowy…” (eksport JPK_FA) i „Ustaw urząd skarbowy
 * firmy…” (job eksportu). Zgodność z tekstami serwera pilnuje test, który czyta
 * ich źródła.
 */
export function jestBrakiemUrzedu(komunikat: string): boolean {
  return /urzędu skarbowego firmy|ustaw urząd skarbowy/i.test(komunikat);
}

export type WyjscieBrakUrzedu = {
  /** Czy pokazać odsyłacz „Ustaw urząd na faktway.pl”. */
  strona: boolean;
  /** Zdanie dopisane do odmowy, gdy odsyłacza nie ma. */
  podpowiedz: string | null;
};

/**
 * Wyjście z odmowy o braku urzędu. Stronę z urzędem otwiera tylko właściciel
 * (inne role wracają z niej do Ustawień), więc administrator i księgowa
 * dowiadują się, kto urząd ustawia, zamiast trafić w ślepy odsyłacz.
 */
export function wyjscieBrakUrzedu(rola: string | undefined, maAdresStrony: boolean): WyjscieBrakUrzedu {
  if (rola !== 'owner') return { strona: false, podpowiedz: TYLKO_WLASCICIEL };
  return { strona: maAdresStrony, podpowiedz: null };
}
