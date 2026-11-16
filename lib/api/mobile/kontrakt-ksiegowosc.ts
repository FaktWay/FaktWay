/**
 * Kontrakt API księgowości z telefonu (plan aplikacji mobilnej, M10d): ekran VAT
 * z plikiem JPK_V7M, nadwyżka VAT i zapłaty spoza wyliczenia w „Ten miesiąc”.
 * Czyta go też aplikacja przez Metro (`mobile/src/lib/api/kontrakt-ksiegowosc.ts`),
 * więc plik nie ma importów (pilnuje `tests/unit/mobile-api-ksiegowosc-vat.test.ts`).
 *
 * Kwoty w groszach (`…Gr`) albo w pełnych złotych (`zl`, pola deklaracji), daty
 * RRRR-MM-DD. Wszystkie kwoty, terminy, zdania i plik liczy serwer tą samą drogą
 * co strona (`reports/vat`, `reports/ten-miesiac`); telefon tylko pokazuje.
 */

/** Skąd jest nadwyżka z poprzedniej deklaracji (P_39), jak `ZrodloNadwyzki` w `lib/ksiegowosc/vat-dane.ts`. */
export type ZrodloNadwyzkiTelefonu = 'mf' | 'klient' | 'zatwierdzone' | 'ten_miesiac';

/** P_39 w pełnych złotych i jego źródło. */
export interface NadwyzkaVatTelefonu {
  zl: number;
  zrodlo: ZrodloNadwyzkiTelefonu;
}

/** Nadwyżka przy ekranie VAT albo pozycji VAT „Ten miesiąc”. */
export interface PoleNadwyzkiTelefonu {
  nadwyzka: NadwyzkaVatTelefonu | null;
  /** Zdanie strony o źródle nadwyżki albo o jej braku; `null`: nic do powiedzenia. */
  opis: string | null;
  /** Pole na kwotę (nieznana albo do poprawienia); `false` przy nadwyżce z deklaracji przyjętej przez MF. */
  pole: boolean;
  /** Miesiąc poprzedniej deklaracji słownie („październik 2026”), do etykiety pola. */
  poprzedni: string;
  /**
   * Kwota wpisana przez klienta (pełne złote), którą telefon odsyła przy zatwierdzeniu
   * i pobraniu pliku; `null`, gdy nadwyżka jest z innego źródła.
   */
  wpisana: number | null;
}

/** Wysyłka JPK_V7M za miesiąc (lista strony, do odczytu: wysyła się na stronie). */
export interface WysylkaVatTelefonu {
  id: string;
  /** Znacznik czasu utworzenia (ISO). */
  utworzonoO: string;
  /** Nazwa stanu jak na stronie („MF sprawdza plik”, „Przyjęty, UPO gotowe”). */
  stan: string;
  przyjeta: boolean;
  testowe: boolean;
  numer: string | null;
  doWplatyGr: number;
  /** Przy odrzuceniu: co się stało i co zrobić, z kodem MF. */
  odmowa: string | null;
}

/**
 * `GET /api/mobile/v1/ksiegowosc/vat?miesiac=RRRR-MM&nadwyzka=N` (M10d): ekran VAT
 * strony (`reports/vat`). `wlaczona: false`: obszar `vat` modułu wyłączony dla firmy
 * (strona daje wtedy 404), reszta pól pusta.
 */
export interface VatTelefonuOdpowiedz {
  wlaczona: boolean;
  miesiac: string;
  /** Miesiące do wyboru, od najnowszego. */
  miesiace: string[];
  dzis: string;
  /** Kwot VAT nie liczymy: zdanie strony (odczyt, waluta, zwolnienie, wpisy ręczne, braki wyniku). */
  komunikat: string | null;
  /** Zwolnienie podmiotowe (art. 113): firma nie składa JPK_V7M. */
  zwolniona: boolean;
  /** `null` przy `komunikat` z odczytu albo zwolnienia (pola nadwyżki wtedy nie ma). */
  nadwyzka: PoleNadwyzkiTelefonu | null;
  /** Część deklaracyjna (grosze); `null`, gdy kwot nie liczymy. */
  kwoty: {
    naleznyGr: number;
    naliczonyGr: number;
    nadwyzkaPoprzedniaGr: number;
    doZaplatyGr: number;
    nadwyzkaNaNastepnyGr: number;
  } | null;
  /** Podpis pod kwotami (liczba faktur i kosztów, nadwyżka w naliczonym). */
  podpis: string | null;
  termin: { faktyczny: string; nominalny: string; przesuniety: boolean } | null;
  /** Dane do przelewu, to samo zdanie co na stronie. */
  przelew: string;
  /** Miesiąc się skończył: plik JPK_V7M można przygotować. */
  zakonczony: boolean;
  /** Pobranie pliku: właściciel, administrator albo księgowa, po końcu miesiąca, z kwotami. */
  plik: { mozna: boolean; powod: string | null; email: string | null };
  /** Wysyłka do MF z FaktWay włączona (wysyła się na stronie). */
  wysylkaWlaczona: boolean;
  wysylki: WysylkaVatTelefonu[];
}

/**
 * `POST /api/mobile/v1/ksiegowosc/vat/plik`: dane osoby fizycznej do pliku (nie
 * zapisujemy ich, D9) i nadwyżka wpisana przez klienta (`null`: z innego źródła).
 */
export interface PlikVatZadanie {
  miesiac: string;
  nadwyzka: number | null;
  imie: string;
  nazwisko: string;
  /** RRRR-MM-DD. */
  dataUrodzenia: string;
  email: string;
}

/** 200: ten sam plik JPK_V7M(3) co „Pobierz” na stronie (XML w UTF-8). Odmowa: 422 `settlement_refused` z `field`. */
export interface PlikVatOdpowiedz {
  nazwa: string;
  xml: string;
}

/** Zapłata spoza wyliczenia (K7.2) na liście „Ten miesiąc”. */
export interface ZaplataRecznaTelefonu {
  id: string;
  rodzaj: 'zus_spoleczne' | 'zdrowotna';
  /** Zdanie strony: rodzaj, okres, kwota, część bez Funduszu Pracy, data zapłaty. */
  opis: string;
  zaplacone: boolean;
  /** Najwcześniejszy dzień zapłaty (pierwszy dzień okresu). */
  najwczesniej: string;
}

/** Formularz zapłaty spoza wyliczenia: granice z tych samych funkcji co pole strony. */
export interface FormularzZaplatyRecznej {
  /** Najwcześniejszy okres (RRRR-MM). */
  od: string;
  /** Najpóźniejszy okres (poprzedni miesiąc). */
  doMiesiaca: string;
  domyslnyMiesiac: string;
  domyslnaData: string;
}

/**
 * `POST /api/mobile/v1/ksiegowosc/zaplaty-reczne`: kwoty jak w polu strony
 * („1234,56”), `bezFp` tylko przy składkach społecznych.
 */
export interface ZaplataRecznaZadanie {
  zaMiesiac: string;
  rodzaj: 'zus_spoleczne' | 'zdrowotna';
  kwota: string;
  bezFp: string;
  dataZaplaty: string;
}

/** 201: zapisano. Odmowa: 422 `settlement_refused` z `field` (`zaMiesiac`, `kwota`, `bezFp`, `dataZaplaty`). */
export interface ZaplataRecznaOdpowiedz {
  zapisano: true;
}

/**
 * Dodatki M10d do `TenMiesiacOdpowiedz` (`GET /api/mobile/v1/ksiegowosc?miesiac=…&nadwyzka=N`):
 * `nadwyzka` (pełne złote) to kwota wpisana przy pozycji VAT, jak `?nadwyzka=` strony.
 * `POST /ksiegowosc/zatwierdz` przyjmuje wtedy `nadwyzkaVat` z `nadwyzkaVat.wpisana`.
 */
export interface TenMiesiacDodatki {
  /** Nadwyżka przy pozycji VAT; `null`: VAT nie jest pozycją miesiąca albo pole nic nie zmieni. */
  nadwyzkaVat: PoleNadwyzkiTelefonu | null;
  /** Zapłacone w tym miesiącu i te bez daty zapłaty. */
  zaplatyReczne: ZaplataRecznaTelefonu[];
  /** Formularz dla właściciela i administratora; `null` dla pozostałych ról. */
  zaplataReczna: FormularzZaplatyRecznej | null;
}
