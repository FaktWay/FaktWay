/**
 * Kontrakt API telefonu dla zakładki Więcej (plan aplikacji mobilnej, M10e):
 * kontrahenci, import danych i karty ustawień Księgowa, Zespół, Abonament,
 * Dziennik. Osobny plik obok `kontrakt.ts`, żeby równoległe etapy nie
 * zmieniały tych samych linii; kody błędów są w `kontrakt.ts`
 * (`MOBILE_API_ERROR_CODES`, blok M10e).
 *
 * BEZ IMPORTÓW, jak `kontrakt.ts`: aplikacja czyta ten plik przez Metro
 * (`mobile/src/lib/api/kontrakt-wiecej.ts`). Pilnuje tego
 * `tests/unit/mobile-api-kontrakt-wiecej.test.ts`.
 *
 * Kwoty w złotych (jak należności M10a): telefon przelicza je na grosze
 * swojego modelu (`grosze()`), sam niczego nie sumuje.
 */

/** Wynik jednej karty liczonej osobno: błąd zabiera kartę, nie cały ekran (jak kafle strony). */
export type CzescTelefonu<T> = { ok: true; dane: T } | { ok: false; blad: string };

// ─── Kontrahenci ─────────────────────────────────────────────────────

/** Jak `contractors.vat_status`. */
export type StatusVatKontrahenta = 'active' | 'exempt' | 'inactive' | 'unknown' | 'pending';

export interface KontrahentTelefonu {
  id: string;
  nip: string;
  nazwa: string;
  adres: { linia1: string; linia2: string };
  email: string | null;
  telefon: string | null;
  statusVat: StatusVatKontrahenta | null;
  /** Plakietka statusu VAT jak `VatStatusBadge` strony (np. „Czynny VAT”, „Wymaga uwagi”). */
  statusVatEtykieta: string;
  /** Ostrzeżenie z ostatniego sprawdzenia (biała lista, VIES). */
  ostrzezenie: string | null;
  /** Kafel „Status VAT do sprawdzenia” strony (`needsVatCheck`). */
  vatDoSprawdzenia: boolean;
  sprawdzono: string | null;
  przypomnieniaWylaczone: boolean;
  powodWylaczenia: string | null;
  /**
   * Należności kontrahenta po NIP (`getReceivables`, jak kolumny tabeli strony).
   * `null`, gdy należności nie dało się policzyć (wtedy `bladNaleznosci` w odpowiedzi).
   */
  naleznosci: { doZaplaty: number; poTerminie: number } | null;
}

export interface KafleKontrahentow {
  wszyscy: CzescTelefonu<{ wartosc: number }>;
  aktywni: CzescTelefonu<{ wartosc: number; nota: string }>;
  zZaleglosciami: CzescTelefonu<{ wartosc: number; nota: string }>;
  vatDoSprawdzenia: CzescTelefonu<{ wartosc: number; nota: string }>;
}

/** `GET /api/mobile/v1/kontrahenci?q=` (do 200, od ostatnio użytych, jak strona). */
export interface KontrahenciOdpowiedz {
  lista: KontrahentTelefonu[];
  /** Fraza po oczyszczeniu (jak `sanitizeSearch` strony); pusta bez szukania. */
  fraza: string;
  /** Kafle strony; `null` przy szukaniu (telefon pokazuje je tylko nad pełną listą). */
  kafle: KafleKontrahentow | null;
  /** Zdanie strony, gdy należności nie dało się policzyć; kolumny należności są wtedy `null`. */
  bladNaleznosci: string | null;
  /** Stopka listy: na czym liczymy należności i ile pokazujemy (jak notka tabeli strony). */
  nota: string;
  /** Księgowa ma wgląd; dodawać, zmieniać i usuwać mogą pozostali członkowie. */
  mozeEdytowac: boolean;
}

/** `GET /api/mobile/v1/kontrahenci/{id}`. */
export interface KontrahentOdpowiedz {
  kontrahent: KontrahentTelefonu;
  bladNaleznosci: string | null;
  mozeEdytowac: boolean;
}

/** Pola formularza kontrahenta (jak okno edycji strony): nazwa, dwie linie adresu, e-mail do faktur. */
export interface DaneKontrahentaZadanie {
  nazwa: string;
  adres1: string;
  adres2: string;
  /** Pusty: bez adresu. */
  email: string;
}

/** `POST /api/mobile/v1/kontrahenci`: nowy kontrahent z polskim NIP (10 cyfr z sumą kontrolną). */
export interface NowyKontrahentZadanie extends DaneKontrahentaZadanie {
  nip: string;
}

/**
 * 201 nowy, 200 `juzBylo`: ten sam NIP z tymi samymi danymi był już zapisany
 * (ponowienie po zerwanym połączeniu). Inne dane pod tym NIP to 409 `contractor_exists`.
 */
export interface NowyKontrahentOdpowiedz {
  kontrahent: KontrahentTelefonu;
  juzBylo: boolean;
}

/** `POST /api/mobile/v1/kontrahenci/{id}`: poprawka danych (NIP się nie zmienia). `zmienione` puste: nic do zapisania. */
export interface ZmianaKontrahentaOdpowiedz {
  kontrahent: KontrahentTelefonu;
  zmienione: Array<'nazwa' | 'adres' | 'email'>;
}

/** `POST /api/mobile/v1/kontrahenci/{id}/usuniecie`, 200. Drugie usunięcie to 404 `not_found`. */
export interface UsuniecieKontrahentaOdpowiedz {
  usuniety: true;
}

// ─── Import danych ───────────────────────────────────────────────────

/** Odcień komunikatu i plakietki jak na stronie. */
export type OdcienTelefonu = 'ok' | 'ostrzezenie' | 'blad' | 'neutralny';

export interface KafelImportu {
  podpis: string;
  /** `null`: wartości nie znamy (stan historii nieczytelny, jeszcze bez pobrania); strona pisze wtedy kreskę. */
  wartosc: string | null;
  nota: string | null;
}

/** Sekcja „Sprzedaż” albo „Zakupy” karty „Historia z KSeF”. */
export interface SekcjaHistoriiKsef {
  kierunek: 'outgoing' | 'incoming';
  tytul: string;
  linie: string[];
  postep: { podpis: string; procent: number } | null;
  tempo: string[];
  /** „Pobieranie historii stoi…”: alarm u nas, klient nic nie robi. */
  stoi: string | null;
  /** Sprzedaż z KSeF spoza FaktWay nie trafia do należności ani przypomnień (zdanie strony). */
  nota: string | null;
}

export interface HistoriaKsefTelefonu {
  odznaka: { etykieta: string; odcien: OdcienTelefonu };
  /** Podtytuł karty: ostatnie pobranie albo „Sprzedaż i zakupy z KSeF”. */
  podtytul: string;
  /** Bez certyfikatu albo bez potwierdzenia: zdanie strony; pobieranie i tak nie ruszy. */
  certyfikat: 'brak' | 'niepotwierdzony' | 'gotowy';
  /**
   * Komunikaty nad sekcjami (wstrzymanie, błąd certyfikatu, limit KSeF, zmiany po eksporcie).
   * `doUstawienKsef`: klient naprawi to sam w ustawieniach KSeF (link strony „Przejdź do ustawień KSeF”).
   */
  komunikaty: Array<{ tekst: string; odcien: OdcienTelefonu; doUstawienKsef?: boolean }>;
  sekcje: SekcjaHistoriiKsef[];
  /** Stanu nie dało się wczytać (zdanie strony). */
  blad: string | null;
}

export type GrupaStatusuImportu = 'running' | 'completed' | 'failed' | 'cancelled';

export interface ImportTelefonu {
  id: string;
  zrodlo: string;
  szczegol: string | null;
  status: GrupaStatusuImportu;
  statusEtykieta: string;
  /** Dzień rozpoczęcia (Warszawa). */
  data: string;
  /** Jedno zdanie o wyniku: podsumowanie, powód błędu albo krok w toku. */
  opis: string | null;
  procent: number | null;
}

/** `GET /api/mobile/v1/import`: tylko odczyt; wgranie pliku i wstrzymanie pobierania są na faktway.pl. */
export interface ImportOdpowiedz {
  kafle: KafelImportu[] | null;
  historiaKsef: HistoriaKsefTelefonu;
  /** `null`, gdy historii importów nie dało się wczytać. */
  importy: ImportTelefonu[] | null;
  /** Programy, z których strona przyjmuje pliki CSV (Fakturownia, inFakt …). */
  programy: string[];
}

// ─── Księgowa ────────────────────────────────────────────────────────

export interface PaczkaKsiegowej {
  id: string;
  format: string;
  status: string;
  statusEtykieta: string;
  okresOd: string | null;
  okresDo: string | null;
  utworzono: string;
  wyslano: string | null;
}

export interface DostepKsiegowej {
  id: string;
  nazwa: string;
  email: string;
  poziom: 'Pobieranie' | 'Podgląd';
  stan: 'aktywny' | 'odebrany' | 'wygasl';
  wygasa: string | null;
  uzycia: number;
  ostatnio: string | null;
}

/** `GET /api/mobile/v1/ksiegowa` (tylko właściciel, jak zakładka strony): urząd skarbowy, Co-Pilot, dostępy. */
export interface KsiegowaOdpowiedz {
  urzad: { kod: string; nazwa: string | null } | null;
  coPilot: {
    wlaczony: boolean;
    ksiegowa: string | null;
    biuro: string | null;
    email: string | null;
    dw: string[];
    /** Formaty paczki, które naprawdę wyjdą (jak wysyłka Co-Pilota: wstrzymane zamienione, JPK_FA bez urzędu jako CSV). */
    formaty: string[];
    dzienWysylki: number | null;
    zakres: { wystawione: boolean; otrzymane: boolean; korekty: boolean };
    ostatnio: string | null;
  } | null;
  paczki: PaczkaKsiegowej[];
  dostepy: DostepKsiegowej[];
}

// ─── Zespół ──────────────────────────────────────────────────────────

/**
 * `GET /api/mobile/v1/zespol` (właściciel albo administrator, jak zakładka strony).
 * Bez adresów e-mail członków: strona czyta je kluczem serwisowym, a telefon
 * pyta bazę tylko tokenem użytkownika.
 */
export interface ZespolOdpowiedz {
  czlonkowie: Array<{ id: string; imie: string; rola: 'owner' | 'admin' | 'member' | 'accountant'; status: string; dolaczyl: string | null; ty: boolean }>;
  zaproszenia: Array<{ id: string; email: string; rola: string; zaproszono: string; wygasa: string }>;
  prosby: Array<{ id: string; imie: string; wiadomosc: string | null; utworzono: string }>;
}

// ─── Abonament ───────────────────────────────────────────────────────

/**
 * `GET /api/mobile/v1/abonament` (właściciel albo administrator). Plan D5:
 * bez cen i bez zakupu, tylko stan subskrypcji. `subskrypcja: null`: brak
 * aktywnej subskrypcji albo płatności nie są skonfigurowane.
 */
export interface AbonamentOdpowiedz {
  /** `false`: płatności nie są skonfigurowane na tym serwerze (stanu subskrypcji nie znamy). */
  platnosci: boolean;
  subskrypcja: {
    status: string;
    statusEtykieta: string;
    odcien: OdcienTelefonu;
    plan: string;
    okresOd: string | null;
    okresDo: string | null;
    /** Dni okresu próbnego do końca; `null` poza okresem próbnym. */
    dniProby: number | null;
    probaDo: string | null;
    konczySiePoOkresie: boolean;
  } | null;
}

// ─── Dziennik ────────────────────────────────────────────────────────

/** `GET /api/mobile/v1/dziennik`: ostatnie 200 wpisów, jak zakładka strony. */
export interface DziennikOdpowiedz {
  /** `zasob` i `ip` są `null`, gdy wpis ich nie ma (strona pisze wtedy kreskę). */
  wpisy: Array<{ id: string; kiedy: string; akcja: string; zasob: string | null; ip: string | null }>;
}

// ─── Przepływy i Analizy (M10e, część 2) ─────────────────────────────

/**
 * Tryb danych firmy jak na stronie (`lib/demo/tryb-danych.ts`): `przyklad`
 * przed potwierdzeniem KSeF (dane przykładowe, plakietka), `synchronizacja`
 * w trakcie pobierania historii, `prawdziwe`.
 */
export type TrybDanychTelefonu = 'przyklad' | 'synchronizacja' | 'prawdziwe';

/** Kubełek wykresu przepływów (tydzień, miesiąc, rok): wpływy oznaczone jako zapłacone i koszty brutto, w złotych. */
export interface KubelekPrzeplywow {
  klucz: string;
  etykieta: string;
  okres: string;
  wplywy: number;
  koszty: number;
  /** Wpływy minus koszty (liczy serwer). */
  saldo: number;
  liczbaWplywow: number;
}

export interface WykresPrzeplywow {
  kubelki: KubelekPrzeplywow[];
  sumaWplywow: number;
  sumaKosztow: number;
}

/** Pierścień „Odłóż na podatek” albo „Limit zwolnienia z VAT”: zdania i procent liczy serwer (adaptery strony). */
export interface PierscienTelefonu {
  tytul: string;
  podtytul: string;
  procent: number;
  linie: [string, string, string];
  podpis: string;
}

/** `GET /api/mobile/v1/przeplywy`: karty strony `/przeplywy`, każda liczona osobno. */
export interface PrzeplywyOdpowiedz {
  tryb: TrybDanychTelefonu;
  /** Od kiedy koszty z KSeF są w danych (zakupy nie pobrane w całości); `null`, gdy wszystkie. */
  kosztyKsefOd: string | null;
  wykres: CzescTelefonu<{ tydzien: WykresPrzeplywow; miesiac: WykresPrzeplywow; rok: WykresPrzeplywow }>;
  miesiac: CzescTelefonu<{
    wplywy: { kwota: number; poprzednio: number; liczba: number; zmianaPct: number | null };
    koszty: { kwota: number; poprzednio: number; liczba: number; zmianaPct: number | null };
  }>;
  pierscien: CzescTelefonu<PierscienTelefonu>;
  zrodla: CzescTelefonu<Array<{ klucz: string; nazwa: string; kierunek: 'in' | 'out'; kwota: number; liczba: number; udzial: number }>>;
  spodziewane: CzescTelefonu<{ pozycje: Array<{ id: string; nazwa: string; numer: string | null; termin: string; dniDoTerminu: number; kwota: number }>; liczba: number; suma: number }>;
  /** Wpływy i koszty z ostatnich 12 miesięcy, od najnowszych (do 100; kwota ze znakiem dokumentu). */
  operacje: CzescTelefonu<Array<{ id: string; kierunek: 'in' | 'out'; data: string; kontrahent: string; numer: string | null; kategoria: string; status: 'paid' | 'correction' | 'reviewed' | 'pending' | 'ksef'; kwota: number }>>;
}

export interface PunktTrendu {
  klucz: string;
  etykieta: string;
  kwota: number;
}

export interface CzescPodzialu {
  klucz: string;
  etykieta: string;
  kwota: number;
  /** Procent udziału (liczy serwer). */
  procent: number;
  pozostale: boolean;
}

/** `GET /api/mobile/v1/analizy?widok=sprzedaz|koszty&miesiac=RRRR-MM`: karty stron `/analizy/sprzedaz` i `/analizy/koszty`. */
export interface AnalizyOdpowiedz {
  tryb: TrybDanychTelefonu;
  widok: 'sprzedaz' | 'koszty';
  miesiac: string;
  /** Miesiące do wyboru jak na stronie (`analyticsMonthOptions`). */
  miesiace: Array<{ klucz: string; etykieta: string }>;
  kosztyKsefOd: string | null;
  kafle: CzescTelefonu<{ suma: number; srednioDziennie: number; zmianaPct: number | null; najlepszy: string | null }>;
  trend: CzescTelefonu<PunktTrendu[]>;
  podzial: CzescTelefonu<CzescPodzialu[]>;
  ostatnie: CzescTelefonu<Array<{ id: string; nazwa: string; numer: string | null; data: string; kwota: number; korekta: boolean }>>;
  /** Tylko sprzedaż; `null` też w danych przykładowych (`tryb: 'przyklad'`): należności dopiero po połączeniu KSeF. */
  naleznosci: CzescTelefonu<{ doZaplaty: number; poTerminie: number; liczba: number; liczbaPoTerminie: number; najstarszaDni: number | null; pominieteWWalucie: number }> | null;
  /** Tylko koszty. */
  vat: CzescTelefonu<{ vat: number; doOdliczenia: number; doOpisania: number }> | null;
  wynik: CzescTelefonu<{ przychody: number; koszty: number; wynik: number }>;
  stali: CzescTelefonu<Array<{ klucz: string; nazwa: string; srednio: number; dzien: number; miesiace: number }>>;
  /** Ostatnie 180 dni; `poziom` 0 do 4 (0: nic) to odcień pola kalendarza, liczony przez serwer względem najwyższego dnia. */
  kalendarz: CzescTelefonu<Array<{ dzien: string; kwota: number; poziom: number }>>;
}
