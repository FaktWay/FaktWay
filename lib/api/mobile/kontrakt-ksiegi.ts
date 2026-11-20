/**
 * Kontrakt API ksiąg i eksportu z telefonu (plan aplikacji mobilnej, M10d część 2):
 * KPiR raportu, ewidencja albo KPiR modułu z plikami JPK_EWP i JPK_PKPIR oraz
 * ręczny eksport dla księgowej. Czyta go też aplikacja przez Metro
 * (`mobile/src/lib/api/kontrakt-ksiegi.ts`), więc plik nie ma importów (pilnuje
 * `tests/unit/mobile-api-ksiegi.test.ts`).
 *
 * Wszystkie kwoty, sumy, udziały, terminy, zdania o brakach i pliki liczy serwer
 * tą samą drogą co strona (`reports/kpir`, `reports/ewidencja`, `reports/exports`).
 * Kwoty raportu KPiR w złotych (jak model strony), kwoty ewidencji i KPiR modułu
 * w groszach (`…Gr`), daty RRRR-MM-DD.
 */

// ─── KPiR raportu (`GET /api/mobile/v1/raport-kpir?miesiac=RRRR-MM`) ─────

/** Wpis księgi raportu: przychód (faktura) albo koszt (wydatek). */
export interface WpisRaportuKpirTelefonu {
  id: string;
  lp: number;
  rodzaj: 'przychod' | 'koszt';
  data: string;
  /** Uwaga o sprzedaży z wcześniejszego okresu („faktura z 03.09”) albo `null`. */
  uwagaDaty: string | null;
  dokument: string | null;
  kontrahent: string;
  opis: string;
  /** Kolumna księgi: '7', '10', '11', '12', '13', '15', 'brak' (do opisania) albo 'poza'. */
  kolumna: string;
  /** Nazwa kolumny z plakietki strony („Kol. 13: Pozostałe wydatki”). */
  kolumnaNazwa: string;
  /** Czy kwota wchodzi do sum KPiR. */
  wSumie: boolean;
  /** Złote. */
  kwota: number;
  dopisek: string | null;
  dopisekOstrzezenie: boolean;
}

export interface KolumnaKosztowTelefonu {
  /** Klucz kolumny jak `wpisy[].kolumna` ('10', '11', '12', '13', '15'). */
  kolumna: string;
  nazwa: string;
  /** Złote. */
  kwota: number;
  /** Udział w kosztach dodatnich (0 do 1); `null`: kolumna na minusie (korekty). */
  udzial: number | null;
}

export interface KpirRaportOdpowiedz {
  miesiac: string;
  /** Miesiące do wyboru, od najnowszego (od stycznia 2020, najwyżej 24). */
  miesiace: string[];
  dzis: string;
  /** `przyklad`: firma przed weryfikacją KSeF, dane przykładowe jak na stronie (plakietka). */
  tryb: 'przyklad' | 'dane';
  /** Zdanie strony o księdze modułu za ten miesiąc albo `null`. */
  odeslanie: string | null;
  /** Raport wstrzymany (waluta nie do potwierdzenia): zdanie strony, bez kwot. */
  blokada: string | null;
  /** Numery faktur sprzedaży, które blokują raport. */
  blokujace: string[];
  /** Zaliczek ROZ nie odczytano: zdanie nad księgą. */
  zaliczkiBlad: string | null;
  sumy: { przychod: number; koszty: number; dochod: number; marza: number | null } | null;
  kolumny: KolumnaKosztowTelefonu[];
  /** Narastająco po dniach (złote). */
  seria: Array<{ dzien: number; data: string; przychod: number; koszty: number }>;
  /** Koszty poza sumą (do opisania): liczba i kwota. */
  doOpisania: { liczba: number; kwota: number } | null;
  /** VAT w kosztach bez odliczenia (złote). */
  vatBezOdliczenia: number;
  wpisy: WpisRaportuKpirTelefonu[];
}

// ─── Ewidencja albo KPiR modułu (`GET /api/mobile/v1/ksiegowosc/ewidencja`) ──

export interface WierszKsiegiTelefonu {
  lp: number;
  data: string;
  dowod: string;
  numerKsef: string | null;
  kontrahent: string;
  /** Kraj i identyfikator kontrahenta („PL 5252248481”) albo `null`. */
  identyfikator: string | null;
  /** Data wpisu do ewidencji (kolumna „Data wpisu” strony); `null` w KPiR modułu. */
  dataWpisu: string | null;
  opis: string | null;
  kwotaGr: number;
  /** Przychód (kolumny 7 i 8, ewidencja) albo koszt. */
  przychod: boolean;
  /** Stawka ryczałtu („8,5%”) albo nazwa kolumny KPiR. */
  kolumna: string;
  uwagi: string | null;
}

export interface WpisRecznyTelefonu {
  id: string;
  tytul: string;
  szczegoly: string;
}

/** Plik JPK za rok do końca miesiąca: stan jak karta pliku strony. */
export interface PlikKsiegiTelefonu {
  plik: 'JPK_EWP' | 'JPK_PKPIR';
  /** Zdanie strony: okres, liczba wierszy, sumy, cel złożenia albo powód braku pliku. */
  opis: string;
  /** Zdanie o spisie z natury w pliku (KPiR) albo `null`. */
  spis: string | null;
  rok: number;
  doMiesiaca: number;
  /** Można pobrać: bez braków, są wiersze, rola właściciel, administrator albo księgowa. */
  mozna: boolean;
  /** Dlaczego nie (rola); `null`, gdy brak pliku z powodu danych (wtedy mówi `opis`). */
  powod: string | null;
}

export interface KsiegaTelefonuOdpowiedz {
  /** Obszar `ewidencja` modułu włączony (strona daje inaczej 404). */
  wlaczona: boolean;
  miesiac: string;
  miesiace: string[];
  dzis: string;
  /** `ewidencja` (ryczałt) albo `kpir` (skala, liniowy); `null`, gdy ustalenie się nie udało (`komunikat`). */
  rodzaj: 'ewidencja' | 'kpir' | null;
  /** Księgi nie pokazujemy: zdanie strony (odczyt, KPiR wyłączona, okres przed 2026). */
  komunikat: string | null;
  /** Zdania braków okresu; przy brakach nie ma sum ani pliku. */
  braki: string[];
  /** Faktury poza księgą („Poza ewidencją: …”) albo `null`. */
  pominiete: string | null;
  wiersze: WierszKsiegiTelefonu[];
  /** Podpisane sumy okresu (grosze); `null` przy brakach. */
  sumy: Array<{ podpis: string; kwotaGr: number }> | null;
  podpisSum: string | null;
  /** Zdanie strony, gdy ryczałt w roku nie ma ewidencji (skala, liniowy). */
  uwaga: string | null;
  wpisyReczne: WpisRecznyTelefonu[];
  spisy: WpisRecznyTelefonu[];
  plik: PlikKsiegiTelefonu | null;
  /** Wpisy dodaje i usuwa właściciel albo administrator (na stronie). */
  mozeEdytowac: boolean;
}

/** `POST /api/mobile/v1/ksiegowosc/ewidencja/plik`: dane osoby do pliku nie są zapisywane (D9). */
export interface PlikKsiegiZadanie {
  plik: 'JPK_EWP' | 'JPK_PKPIR';
  rok: number;
  doMiesiaca: number;
  imie: string;
  nazwisko: string;
  /** RRRR-MM-DD. */
  dataUrodzenia: string;
}

/** 200: ten sam plik co „Pobierz” na stronie. Odmowa: 422 `settlement_refused` z `field`. */
export interface PlikKsiegiOdpowiedz {
  nazwa: string;
  xml: string;
}

// ─── Eksport (`/api/mobile/v1/eksport`) ───────────────────────────

export interface FormatEksportuTelefonu {
  format: 'kpir_excel' | 'csv_universal' | 'jpk_fa';
  nazwa: string;
  /** Do czego służy plik („Księga dla księgowej”). */
  opis: string;
}

export interface ZadanieEksportuTelefonu {
  id: string;
  nazwaFormatu: string;
  /** „Październik 2026” albo zakres. */
  okres: string;
  /** `completed`, `empty`, `failed`, `generating`, `pending`, `expired` (jak historia strony). */
  stan: string;
  stanNazwa: string;
  /** „12 faktur · 14,2 KB” albo `null`. */
  podsumowanie: string | null;
  /** Powód pod nazwą pliku: błąd albo wyjaśnienie przy „Pusty”. */
  notatka: { tekst: string; blad: boolean } | null;
  /** Gotowy plik do pobrania (`GET /eksport/pliki/{id}`). */
  plik: { id: string; nazwa: string } | null;
  /** Znacznik czasu utworzenia (ISO); dzień w Polsce liczy aplikacja (`dzienZnacznika`). */
  utworzonoO: string;
}

export interface EksportTelefonuOdpowiedz {
  formaty: FormatEksportuTelefonu[];
  miesiac: string;
  miesiace: string[];
  /** `false`: urząd skarbowy nie ustawiony (JPK_FA odmówi), `true`: ustawiony, `null`: nie wiemy. */
  urzadUstawiony: boolean | null;
  /** Wstrzymane formaty jednym zdaniem strony albo `null`. */
  wstrzymane: string | null;
  historia: ZadanieEksportuTelefonu[];
}

/** `POST /api/mobile/v1/eksport`: zakres z reguły formatu (FIR-01), jak na stronie. */
export interface EksportStartZadanie {
  format: 'kpir_excel' | 'csv_universal' | 'jpk_fa';
  miesiac: string;
}

/** 201: job utworzony, plik powstaje w tle (stan w historii). Odmowa: 422 `export_refused` ze zdaniem strony. */
export interface EksportStartOdpowiedz {
  jobId: string;
}

/** `GET /api/mobile/v1/eksport/pliki/{id}`: plik gotowego eksportu w Base64. */
export interface EksportPlikOdpowiedz {
  nazwa: string;
  mimeType: string;
  base64: string;
}
