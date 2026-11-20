/**
 * Kontrakt API aplikacji na telefon (`/api/mobile/v1`, plan aplikacji
 * mobilnej 4.1 i 4.3, decyzja M6): nagłówki, kody błędów i kształty odpowiedzi
 * w jednym miejscu dla serwera i aplikacji.
 *
 * BEZ IMPORTÓW: ten plik czyta też aplikacja w `mobile/` (od M7, przez Metro),
 * więc nie może ciągnąć kodu serwera, Supabase ani Nexta. Pilnuje tego
 * `tests/unit/mobile-api-kontrakt.test.ts`. Schematy Zod treści żądań leżą
 * obok, w `lib/api/mobile/schematy.ts` (import `zod`), i do aplikacji nie
 * trafiają (rozstrzygnięcie M8): telefon dostaje stąd typy treści, a serwer
 * sprawdza każde żądanie tym samym schematem formularza co strona i odsyła
 * błąd z polem (`invoice_invalid`). Zgodność typów tu ze schematem pilnuje
 * `tests/unit/mobile-api-faktury.test.ts`.
 */

/** Firma, w której telefon działa, przy trasach z danymi firmy (jak ciasteczko aktywnej firmy na stronie, `ACTIVE_ORG_COOKIE`). */
export const MOBILE_ACTIVE_ORG_HEADER = 'X-Active-Org';

/**
 * Zapis z telefonu (M8 `POST /faktury`, M9 `POST /wydatki/zdjecie`): UUID
 * wylosowany raz na wypełnienie formularza albo jedno zdjęcie. Ponowienie
 * z tym samym kluczem i tą samą treścią oddaje wynik pierwszego zapisu (bez
 * drugiej faktury, drugiej wysyłki, drugiego odczytu i drugiego kosztu).
 */
export const MOBILE_IDEMPOTENCY_HEADER = 'Idempotency-Key';

export const MOBILE_API_ERROR_CODES = [
  /** 401: brak nagłówka `Authorization: Bearer`. */
  'missing_token',
  /**
   * 401: token w złym kształcie albo taki, którego GoTrue nie uznaje (wygasły, wylogowany, podrobiony).
   * Telefon odświeża sesję (`refreshSession`) i ponawia raz; sesję kończy dopiero, gdy odświeżenie się nie uda.
   * Wygasły token dostępu (co godzinę) to zwykły przypadek, nie powód do wylogowania.
   */
  'invalid_token',
  /** 403: konto z 2FA w sesji bez kodu (AAL1). Telefon prosi o kod. */
  'mfa_required',
  /** 400: trasa z danymi firmy bez nagłówka `X-Active-Org` (albo nie UUID). */
  'missing_org',
  /** 403: `X-Active-Org` wskazuje firmę bez aktywnego członkostwa. Telefon odświeża listę firm. */
  'no_active_org',
  /** 400: zapis bez nagłówka `Idempotency-Key` albo klucz nie jest UUID (M8). */
  'missing_idempotency_key',
  /** 409: ten klucz idempotencji był już użyty z inną treścią. Telefon losuje nowy klucz dopiero dla nowej faktury. */
  'idempotency_conflict',
  /** 422: dane faktury nie przeszły schematu formularza strony albo zasad wystawienia; `message` mówi co poprawić, `field` które pole. */
  'invoice_invalid',
  /** 404: faktury nie ma w tej firmie (albo nie należy do niej). */
  'not_found',
  /** 409: wysłać można tylko szkic; faktura jest w innym stanie (np. odrzucona: popraw ją na faktway.pl). */
  'not_draft',
  /** 422: kolejka KSeF odmówiła wysyłki szkicu (brak certyfikatu, pauza, 2FA); szkic zostaje, `message` mówi co zrobić. */
  'ksef_send_refused',
  /**
   * 400, 413, 415: `POST /wydatki/zdjecie` (M9): brak pliku, plik nie jest zdjęciem ani PDF albo jest za duży.
   * `message` mówi, co zrobić; ponowienie tego samego pliku nic nie zmieni.
   */
  'file_invalid',
  /** 400, 408: `POST /wydatki/zdjecie` (M9): nie dotarł cały plik albo wysyłka trwała za długo. Ponów z tym samym kluczem. */
  'upload_incomplete',
  /** 422: `POST /wydatki/{id}/zatwierdzenie` (M9): zasada zapisu kosztu (waluta, KPiR, koszt z KSeF); `message` mówi co zrobić. */
  'expense_invalid',
  /** 429, z nagłówkiem `Retry-After`. */
  'rate_limited',
  /** 503, z nagłówkiem `Retry-After`. */
  'maintenance',
  /** 503: GoTrue nie odpowiedział albo odpowiedział błędem serwera. Ponów, nie wylogowuj. */
  'session_verification_failed',
  /** 503: baza albo GoTrue niedostępne. Ponów. */
  'service_unavailable',
  /** 400: treść żądania w złym kształcie (np. logowanie bez e-maila albo hasła). */
  'invalid_request',
  /** 400: `POST /logowanie`: zły e-mail albo hasło (także niepotwierdzony e-mail, jak na stronie). */
  'invalid_credentials',
  /**
   * 503, z nagłówkiem `Retry-After`: `POST /logowanie` nie może teraz bezpiecznie zalogować
   * (bez Redisa nie ma limitów prób, a trasa nie ma captchy; albo GoTrue odrzucił klucz serwera).
   * Klient loguje się na faktway.pl albo próbuje za kilka minut.
   */
  'login_unavailable',
  /** 400: `POST /kod` (M6c): zły kod 2FA albo nie sześć cyfr. Próba z limitu konta zużyta tylko przy sześciu cyfrach. */
  'invalid_code',
  /**
   * 409: `POST /kod` (M6c) z sesją, która nie czeka na kod (konto bez 2FA albo sesja już po kodzie).
   * Telefon zostaje na obecnej sesji.
   */
  'mfa_not_required',
  // Należności, przypomnienia, PDF (M10a): zdanie z serwera mówi, co zrobić.
  /** 403: rola w firmie nie pozwala na tę zmianę (np. księgowa ma wgląd w zapłaty, przypomnienie zatwierdza właściciel albo administrator). */
  'forbidden',
  /** 422: zapłaty nie zapisano (faktura skorygowana, z innego źródła, data z przyszłości); `message` mówi dlaczego. */
  'payment_refused',
  /** 422: przypomnienia nie przygotowano albo nie zlecono (podgląd wygasł, etap już zlecony, wyłączone); `message` mówi, co zrobić. */
  'reminder_refused',
  /** 409: PDF tej faktury nie powstanie w tym stanie (offline bez kodu QR, szkic wycofany); `message` mówi dlaczego. */
  'pdf_unavailable',
  // Konto i księgowość (M10b): zdanie z serwera mówi, co zrobić.
  /** 403: usunięcie konta bez hasła wymaga świeżego logowania w tej sesji (konto tylko z Google). Telefon prowadzi do ponownego logowania. */
  'reauth_required',
  /** 409: konta nie usuniemy, bo firma ma aktywny abonament; `message` nazywa firmę i mówi, co zrobić. */
  'deletion_blocked',
  /** 409: usuwanie konta już trwa i nie da się go anulować. */
  'deletion_in_progress',
  /**
   * 422: rozliczenia nie zatwierdzono albo zapłaty nie zapisano (miesiąc trwa, dane się zmieniły, zła data); `message` mówi dlaczego.
   * M10d: także odmowa pliku JPK_V7M i zapłaty spoza wyliczenia, z `field` przy złym polu formularza.
   */
  'settlement_refused',
  // Rodzaje faktur, ponowienie, szkic, GUS (M8b): zdanie z serwera mówi, co zrobić.
  /**
   * 422: zmiany stanu faktury nie wykonano (korekta tej faktury, ponowna wysyłka, powrót do szkicu,
   * usunięcie szkicu); `message` to zdanie strony z tym, co zrobić. Ponowienie nic nie zmieni.
   */
  'invoice_change_refused',
  // Kontrahenci (M10e, typy odpowiedzi w `kontrakt-wiecej.ts`): zdanie z serwera mówi, co poprawić.
  /** 422: dane kontrahenta nie przeszły schematu strony (NIP, nazwa, adres, e-mail); `field` to pole formularza telefonu (`nip`, `nazwa`, `adres1`, `adres2`, `email`). */
  'contractor_invalid',
  /** 409: kontrahent z tym NIP jest już zapisany z innymi danymi; `message` nazywa go i mówi, co zrobić. */
  'contractor_exists',
  // Zapisy ustawień (M10c, typy w `kontrakt-ustawienia.ts`): zdanie strony mówi, co poprawić.
  /** 422: wartość ustawienia nie przeszła zasad strony (dane firmy, rachunek, data, zwolnienie, przypomnienia); `field` to pole formularza telefonu. */
  'settings_invalid',
  /** 409: zmiana hasła wymaga kodu z e-maila (GoTrue: `reauthentication_needed`); telefon prosi o kod przez `POST /ustawienia/haslo/kod` (M10c, część 2). */
  'password_code_required',
  // Ręczny eksport (M10d część 2).
  /** 422: eksportu nie zlecono (wstrzymany format, brak urzędu skarbowego, plik niegotowy); `message` to zdanie strony z tym, co zrobić. Porażka techniczna (zapis joba, zdarzenie) to 503 do ponowienia, nie ten kod. */
  'export_refused',
  /** 500, opis z identyfikatorem żądania. */
  'internal_error',
] as const;

export type MobileApiErrorCode = (typeof MOBILE_API_ERROR_CODES)[number];

/** Każda odmowa: stały kod po angielsku, po którym telefon wybiera swój tekst, i opis po polsku. */
export interface MobileApiError {
  /** `field` tylko przy `invoice_invalid` (ścieżka pola formularza, np. `buyerName`, `lines.0.name`), `contractor_invalid` (M10e) i `settings_invalid` (M10c). */
  error: { code: MobileApiErrorCode; message: string; field?: string };
}

// ─── Faktury (M8): wystawienie i wysyłka do KSeF ─────────────────────

/**
 * Stawki zwykłej faktury z telefonu (jak `vatRateEnum` strony). „np_ii” (usługa dla
 * firmy z innego kraju UE, art. 100 ust. 1 pkt 4) od M8b, tylko z nabywcą z UE.
 */
export type StawkaVatTelefonu = '23' | '8' | '5' | '0' | 'zw' | 'oo' | 'np' | 'np_ii';

/** Pozycja jak w formularzu strony (`lineItemSchema`): ilość i cena netto w złotych, do 4 miejsc po przecinku. */
export interface PozycjaFakturyTelefonu {
  name: string;
  unit: string;
  quantity: number;
  unitPriceNet: number;
  vatRate: StawkaVatTelefonu;
}

/**
 * Zwykła faktura VAT w złotych z telefonu: te same pola co formularz strony
 * (`InvoiceFormValues`), bez faktury cyklicznej, proformy i paragonu (te
 * wystawia się na faktway.pl). Osoba prywatna: `buyerIsConsumer` i pusty
 * `buyerNip`; bez `buyerConsumerIdType` serwer wpisuje „bez numeru
 * identyfikacyjnego” (jak przed M8b). Od M8b także osoba z PESEL albo
 * dokumentem i firma z UE (numer VAT-UE, kraj adresu); pola opcjonalne, więc
 * starsza aplikacja wysyła to samo co dotąd.
 */
export interface FakturaTelefonu {
  internalNumber: string;
  /** RRRR-MM-DD; przy wysyłce do KSeF tylko dziś (czas polski). */
  issueDate: string;
  /** RRRR-MM-DD albo pusty tekst (= data wystawienia). */
  saleDate: string;
  buyerNip: string;
  buyerName: string;
  buyerAddressLine1: string;
  buyerAddressLine2: string;
  buyerEmail: string;
  buyerIsConsumer: boolean;
  lines: PozycjaFakturyTelefonu[];
  paymentMethod: 'transfer' | 'cash' | 'card' | 'other';
  paymentDueDate: string;
  bankAccount: string;
  notes: string;
  splitPayment: boolean;
  /**
   * Seria numeracji z podpowiedzi (`PodpowiedzFakturyOdpowiedz.seria`, krok 2.5)
   * albo pusty tekst. Gdy `internalNumber` równa się `numberPreview`, numer
   * nadaje licznik serii przy zapisie (jak formularz strony); inny numer
   * zapisze się jak wpisany ręcznie.
   */
  numberSeriesId: string;
  numberPreview: string;
  /** M8b, osoba prywatna: identyfikator jak w formularzu strony; brak = `no_id`. */
  buyerConsumerIdType?: RodzajIdOsobyTelefonu;
  /** M8b: PESEL (11 cyfr) przy `buyerConsumerIdType: 'pesel'`, inaczej pusty tekst. */
  buyerPesel?: string;
  /** M8b: numer dowodu albo paszportu przy `id_card` / `passport`, inaczej pusty tekst. */
  buyerIdDocument?: string;
  /** M8b: firma z innego kraju UE (numer VAT-UE zamiast NIP; wyklucza `buyerIsConsumer`). */
  buyerIsEu?: boolean;
  /** M8b: numer VAT-UE z prefiksem kraju, np. `DE123456789` (Grecja: `EL`). */
  buyerVatUe?: string;
  /** M8b: kraj adresu firmy z UE (`KRAJE_UE_TELEFONU`, Grecja `GR`). */
  buyerCountryCode?: string;
}

/** Identyfikator osoby prywatnej jak `buyerConsumerIdTypeEnum` strony. */
export type RodzajIdOsobyTelefonu = 'pesel' | 'id_card' | 'passport' | 'no_id';

/**
 * Kraje adresu firmy z UE w formularzu (kopia `EU_BUYER_COUNTRIES` strony bez
 * importu; zgodność pilnuje `tests/unit/mobile-api-faktury-rodzaje.test.ts`).
 * Kod domyślny wynika z prefiksu numeru VAT-UE (Grecja: `EL` → `GR`).
 */
export const KRAJE_UE_TELEFONU: ReadonlyArray<{ kod: string; nazwa: string }> = [
  { kod: 'AT', nazwa: 'Austria' },
  { kod: 'BE', nazwa: 'Belgia' },
  { kod: 'BG', nazwa: 'Bułgaria' },
  { kod: 'HR', nazwa: 'Chorwacja' },
  { kod: 'CY', nazwa: 'Cypr' },
  { kod: 'CZ', nazwa: 'Czechy' },
  { kod: 'DK', nazwa: 'Dania' },
  { kod: 'EE', nazwa: 'Estonia' },
  { kod: 'FI', nazwa: 'Finlandia' },
  { kod: 'FR', nazwa: 'Francja' },
  { kod: 'GR', nazwa: 'Grecja' },
  { kod: 'ES', nazwa: 'Hiszpania' },
  { kod: 'NL', nazwa: 'Holandia' },
  { kod: 'IE', nazwa: 'Irlandia' },
  { kod: 'XI', nazwa: 'Irlandia Północna' },
  { kod: 'LT', nazwa: 'Litwa' },
  { kod: 'LU', nazwa: 'Luksemburg' },
  { kod: 'LV', nazwa: 'Łotwa' },
  { kod: 'MT', nazwa: 'Malta' },
  { kod: 'DE', nazwa: 'Niemcy' },
  { kod: 'PT', nazwa: 'Portugalia' },
  { kod: 'RO', nazwa: 'Rumunia' },
  { kod: 'SK', nazwa: 'Słowacja' },
  { kod: 'SI', nazwa: 'Słowenia' },
  { kod: 'SE', nazwa: 'Szwecja' },
  { kod: 'HU', nazwa: 'Węgry' },
  { kod: 'IT', nazwa: 'Włochy' },
];

/**
 * `POST /api/mobile/v1/faktury` (z nagłówkiem `Idempotency-Key`): `wyslij` to „Wyślij do KSeF”, inaczej szkic.
 * Od M8b ta sama trasa przyjmuje zaliczkę, rozliczenie i korektę (`WystawienieRodzajuZadanie`).
 */
export interface WystawienieZadanie {
  wyslij: boolean;
  faktura: FakturaTelefonu;
}

/** Faktura po zapisie: `ksefStatus` jak kolumna `invoices.ksef_status` (`draft`, `queued`, `accepted` …). */
export interface FakturaZapisana {
  id: string;
  numer: string;
  ksefStatus: string;
}

/**
 * `POST /api/mobile/v1/faktury`: 201 nowa faktura, 200 powtórzenie (`powtorzenie: true`,
 * ten sam klucz i ta sama treść). `wysylka` tylko przy `wyslij: true`: `zlecona` to
 * faktura w kolejce KSeF; odmowa kolejki zostawia szkic i daje `blad` (co zrobić).
 */
export interface WystawienieOdpowiedz {
  faktura: FakturaZapisana;
  powtorzenie: boolean;
  wysylka: { zlecona: boolean; blad: string | null } | null;
}

/**
 * `POST /api/mobile/v1/faktury/{id}/wysylka`: szkic do KSeF. 200 także wtedy, gdy
 * faktura jest już w kolejce albo przyjęta (`juzZlecona: true`): ponowienie po
 * zerwanym połączeniu niczego nie wysyła drugi raz.
 */
export interface WysylkaSzkicuOdpowiedz {
  faktura: FakturaZapisana;
  juzZlecona: boolean;
}

/** `GET /api/mobile/v1/faktury/podpowiedz`: to, czym strona wypełnia pusty formularz. */
export interface PodpowiedzFakturyOdpowiedz {
  /** Kolejny numer jak w pustym formularzu strony (seria domyślna albo po ostatniej fakturze); `null`: brak podpowiedzi. */
  numer: string | null;
  /** Seria numeracji domyślna dla zwykłej faktury (krok 2.5), z której pochodzi `numer`; `null`: numeracja jak dotąd. */
  seria: string | null;
  /** Dziś w Polsce, RRRR-MM-DD: data wystawienia faktury wysyłanej do KSeF. */
  dzis: string;
  /** Firma zwolniona z VAT (art. 113): nowa pozycja startuje ze stawką „zw”. */
  zwolnienieVat: boolean;
  /**
   * M8b: wysyłka tego rodzaju do KSeF jest teraz wstrzymana także na stronie (faktura
   * rozliczająca; korekta na produkcji): zdanie strony, telefon proponuje szkic.
   * `null` albo brak: wysyłka możliwa.
   */
  wysylkaWstrzymana?: string | null;
}

// ─── Wydatki (M9): wydatek ze zdjęcia ─────────────────────────────────

/** `POST /api/mobile/v1/wydatki/zdjecie`: pole formularza `multipart/form-data` z plikiem (JPG, PNG, WEBP, GIF albo PDF). */
export const MOBILE_EXPENSE_FILE_FIELD = 'plik';

/**
 * `POST /api/mobile/v1/wydatki/zdjecie` (z nagłówkiem `Idempotency-Key`): 201 nowe wgranie,
 * 200 powtórzenie (ten sam klucz i ten sam plik). `odczyt.id` to zadanie odczytu (OCR) do
 * `GET /wydatki/odczyt/{id}`; wydatek z odczytu zapisuje serwer.
 */
export interface WgranieWydatkuOdpowiedz {
  odczyt: { id: string };
  powtorzenie: boolean;
}

/** Stan zadania odczytu jak kolumna `ocr_jobs.status`. */
export type StanOdczytu = 'pending' | 'processing' | 'completed' | 'failed';

/**
 * `GET /api/mobile/v1/wydatki/odczyt/{id}`: 200 ze stanem. `wydatekId` przy `completed`;
 * `blad` przy `failed` (zdanie z odczytu). 404 `not_found`: zadania nie ma (koniec czekania);
 * 503: stan nieznany, pytaj dalej (nie wgrywaj zdjęcia drugi raz).
 */
export interface OdczytWydatkuOdpowiedz {
  odczyt: { id: string; stan: StanOdczytu; wydatekId: string | null; blad: string | null };
}

/** Kolumna KPiR jak enum `kpir_column` (ta sama lista co formularz kosztu na stronie). */
export type KolumnaKpirTelefonu = 'col_7' | 'col_8' | 'col_10' | 'col_11' | 'col_12' | 'col_13' | 'col_15' | 'col_16';

/**
 * Zmiany kosztu jak formularz kosztu strony (`ExpenseEditForm`, `ExpenseReviewUpdates`):
 * kwoty w złotych do 2 miejsc, data RRRR-MM-DD, NIP same cyfry albo `null`.
 * `confirmPlnAmounts` tylko przy dokumencie w walucie bez kursu NBP: klient wpisał złote.
 */
export interface ZmianyWydatkuTelefonu {
  seller_name: string;
  seller_nip: string | null;
  document_number?: string;
  issue_date: string;
  net_amount: number;
  vat_amount: number;
  gross_amount: number;
  kpir_column: KolumnaKpirTelefonu;
  category_label: string;
  is_deductible: boolean;
  notes?: string;
  confirmPlnAmounts?: boolean;
}

/** `POST /api/mobile/v1/wydatki/{id}/zatwierdzenie`: opis i akceptacja kosztu ze zdjęcia (nie z KSeF). */
export interface ZatwierdzenieWydatkuZadanie {
  zmiany: ZmianyWydatkuTelefonu;
}

/**
 * `POST /api/mobile/v1/wydatki/{id}/zatwierdzenie`, 200. `opisany: false`, gdy koszt został
 * poza KPiR do wyjaśnienia (kwoty w walucie bez potwierdzenia złotych). Ponowienie zapisuje
 * to samo drugi raz (bez drugiego kosztu), więc nie potrzebuje klucza.
 */
export interface ZatwierdzenieWydatkuOdpowiedz {
  wydatek: { id: string; opisany: boolean; wKpir: boolean };
}

/** Jak `UserRole` strony (`lib/supabase/auth-context.ts`); zgodność sprawdza test kontraktu. */
export type RolaWFirmie = 'owner' | 'admin' | 'member' | 'accountant';

export interface FirmaKonta {
  id: string;
  nazwa: string;
  nip: string;
  rola: RolaWFirmie;
}

/** `GET /api/mobile/v1/konto`, 200. */
export interface KontoOdpowiedz {
  konto: { id: string; email: string | null };
  /** `wlaczone`: konto ma zweryfikowany TOTP. `poziom`: poziom tej sesji. */
  dwaEtapy: { wlaczone: boolean; poziom: 'aal1' | 'aal2' };
  /** Najpierw firmy, do których konto dołączyło najpóźniej. */
  firmy: FirmaKonta[];
  /** `false`, gdy firm jest więcej niż mieści lista (biuro z setkami klientów wybiera resztę na stronie). */
  wszystkie: boolean;
  /** Ostatnio używana na stronie, gdy nadal jest dostęp; inaczej pierwsza z listy; `null` bez firm. */
  aktywnaFirma: string | null;
}

/**
 * `POST /api/mobile/v1/logowanie` (M6b, decyzja D16): treść żądania. Telefon loguje się hasłem
 * przez API, a nie wprost do GoTrue, bo GoTrue z captchą odrzuca logowanie bez tokenu Turnstile.
 */
export interface LogowanieZadanie {
  email: string;
  haslo: string;
}

/**
 * `POST /api/mobile/v1/logowanie`, 200: sesja GoTrue dla `supabase.auth.setSession`. Kod 2FA idzie
 * od M6c przez `POST /kod`; odświeżanie i wylogowanie telefon robi dalej sam w GoTrue (bez captchy).
 * `wymagaKodu`: konto ma zweryfikowany TOTP, a sesja jest jeszcze na poziomie `aal1` (reguła strony).
 */
export interface LogowanieOdpowiedz {
  sesja: { accessToken: string; refreshToken: string };
  wymagaKodu: boolean;
}

/**
 * `POST /api/mobile/v1/kod` (M6c): kod 2FA z aplikacji TOTP. Token sesji AAL1 w `Authorization: Bearer`
 * (tej z `POST /logowanie` albo z Google). Limit prób jak na stronie: 5 na 5 minut na konto, wspólny ze stroną.
 */
export interface KodZadanie {
  kod: string;
}

/**
 * `POST /api/mobile/v1/kod`, 200: nowa sesja GoTrue na poziomie `aal2` (ta sama sesja, nowy token
 * i refresh token) dla `supabase.auth.setSession`.
 */
export interface KodOdpowiedz {
  sesja: { accessToken: string; refreshToken: string };
}

/** `POST /api/mobile/v1/sesja`: 201 `{ zapisane: true }` przy pierwszym wywołaniu dla sesji, potem 200 `{ zapisane: false }`. */
export interface SesjaOdpowiedz {
  zapisane: boolean;
}

// ─── Należności, zapłata, przypomnienia, PDF, skrzynka KSeF (M10a) ─────

/** Wpis przypomnienia o zapłacie (`payment_reminders.status`). */
export type StatusPrzypomnienia = 'pending' | 'sent' | 'failed' | 'cancelled';

/**
 * Faktura po terminie, jak wiersz strony „Po terminie” (`/payments/overdue`):
 * te same faktury (te same zasady: środowisko KSeF, korekty, zaliczki, kwoty),
 * ten sam limit 100 i ten sam stan przypomnień. Kwoty w złotych.
 */
export interface NaleznoscTelefonu {
  id: string;
  numer: string;
  kontrahent: string;
  nip: string | null;
  email: string | null;
  /** Termin płatności, RRRR-MM-DD. */
  termin: string;
  brutto: number;
  doZaplaty: number;
  dniPoTerminie: number;
  wstrzymane: boolean;
  /** Wysłane przypomnienia tej faktury. */
  wyslane: number;
  /**
   * Przypomnienie w kolejce: `brak`, `zaplanowane`, `do_sprawdzenia` (czeka dłużej niż 30 minut)
   * albo `nieznany` (odczyt się nie udał, przygotowanie nowego jest wtedy zablokowane jak na stronie).
   */
  kolejka: 'brak' | 'zaplanowane' | 'do_sprawdzenia' | 'nieznany';
  /** Ostatni wpis przypomnienia (etap 1 do 4, czas UTC); `null` bez przypomnień, `nieznany` bez odczytu. */
  ostatnie: { status: StatusPrzypomnienia; etap: number; kiedy: string } | null | 'nieznany';
}

/** `GET /api/mobile/v1/naleznosci`, 200. `blad`: listy nie da się potwierdzić (to samo zdanie co na stronie), lista jest wtedy pusta. */
export interface NaleznosciOdpowiedz {
  faktury: NaleznoscTelefonu[];
  blad: string | null;
  /** Lista mogła się nie zmieścić w limicie 100: reszta na faktway.pl. */
  limit: boolean;
  /** Przypomnień wysłanych w tym miesiącu; `null`, gdy odczyt się nie udał. */
  wyslaneWMiesiacu: number | null;
  /** Rola pozwala oznaczać zapłatę (księgowa ma wgląd). */
  mozeOznaczac: boolean;
  /** Przypomnienie zatwierdza do wysyłki właściciel albo administrator. */
  mozeZatwierdzac: boolean;
}

/** `POST /api/mobile/v1/faktury/{id}/zaplata`: opcjonalny dzień zapłaty RRRR-MM-DD (domyślnie dziś w Polsce). */
export interface ZaplataZadanie {
  dzien?: string;
}

/**
 * `POST /faktury/{id}/zaplata` (oznacz) i `POST /faktury/{id}/zaplata/cofnij`, 200.
 * `juzBylo`: stan był już taki (ponowienie po zerwanym połączeniu), nic się nie zmieniło.
 */
export interface ZaplataOdpowiedz {
  zaplacona: boolean;
  juzBylo: boolean;
  numer: string | null;
}

/** `POST /api/mobile/v1/faktury/{id}/przypomnienie`: podgląd przypomnienia; pusty `email` to adres z faktury. Nic jeszcze nie wychodzi. */
export interface PodgladPrzypomnieniaZadanie {
  email?: string;
}

/** Podgląd do sprawdzenia i zatwierdzenia (jak okno „Przygotuj przypomnienie” na stronie). */
export interface PodgladPrzypomnieniaOdpowiedz {
  propozycja: string;
  /** Wersja podglądu: zatwierdzenie z inną wersją odmawia (podgląd zmienił się w międzyczasie). */
  wersja: string;
  /** Do kiedy podgląd jest ważny (ISO). */
  wazneDo: string;
  od: string;
  do: string;
  odpowiedzNa: string | null;
  temat: string;
  tresc: string;
  /** Załącznik PDF do obejrzenia przed zgodą; `null` bez załącznika. */
  zalacznik: { nazwa: string; pdfBase64: string } | null;
}

/** `POST /api/mobile/v1/przypomnienia/{propozycja}/zatwierdz`: zgoda na tę wersję i tę treść (klient może ją poprawić). */
export interface ZatwierdzeniePrzypomnieniaZadanie {
  wersja: string;
  tresc: string;
}

/** 200: przypomnienie zlecone do wysyłki (wychodzi w oknie wysyłki z ustawień przypomnień). */
export interface ZatwierdzeniePrzypomnieniaOdpowiedz {
  zlecone: true;
}

/** `POST /api/mobile/v1/faktury/{id}/wstrzymanie`: wstrzymuje albo wznawia przypomnienia faktury. */
export interface WstrzymanieZadanie {
  wstrzymane: boolean;
}

export interface WstrzymanieOdpowiedz {
  wstrzymane: boolean;
}

/** `GET /api/mobile/v1/faktury/{id}/pdf`, 200: ten sam PDF co na stronie (`/api/invoices/{id}/pdf`), w Base64. */
export interface PdfFakturyOdpowiedz {
  nazwa: string;
  pdfBase64: string;
}

/**
 * `POST /api/mobile/v1/skrzynka/sprawdz`, 200: „Sprawdź teraz” w skrzynce KSeF (najwyżej raz na 5 minut).
 * Faktury pobiera serwer w tle; `komunikat` to zdanie strony.
 */
export interface SprawdzenieSkrzynkiOdpowiedz {
  stan: 'zlecone' | 'w_toku' | 'za_wczesnie' | 'bez_ksef' | 'blad';
  komunikat: string;
  ponowZaSekund: number | null;
}

// ─── Firma i usunięcie konta (M10b) ───────────────────────────────────

/** `POST /api/mobile/v1/firma` (z `X-Active-Org`): firma zapisana jako ostatnio używana, wspólna ze stroną. `zapisane: false`: zapis się nie udał, wybór zostaje na telefonie. */
export interface FirmaZapisanaOdpowiedz {
  aktywnaFirma: string;
  zapisane: boolean;
}

/**
 * `GET /api/mobile/v1/konto/usuniecie`: stan usunięcia konta i to, jak je potwierdzić.
 * `potwierdzenie` z serwera: `haslo` (konto z hasłem) albo `swieze_logowanie` (konto
 * tylko z Google: logowanie w tej sesji nie starsze niż 10 minut, do `swiezeDo`).
 */
export interface UsuniecieKontaOdpowiedz {
  /** Kiedy konto zostanie usunięte (ISO); `null` bez żądania. */
  zaplanowane: string | null;
  potwierdzenie: 'haslo' | 'swieze_logowanie';
  /** Do kiedy świeże logowanie wystarcza (ISO); `null`, gdy nie wystarcza albo konto ma hasło. */
  swiezeDo: string | null;
}

/** `POST /konto/usuniecie` i `POST /konto/usuniecie/anuluj`: hasło tylko przy koncie z hasłem. */
export interface PotwierdzenieKontaZadanie {
  haslo?: string;
}

/** `POST /konto/usuniecie`, 200. `juzBylo`: żądanie już istniało (ponowienie), bez nowego maila. */
export interface UsuniecieZaplanowaneOdpowiedz {
  zaplanowane: string;
  juzBylo: boolean;
  /** Mail z linkiem do anulowania wyszedł. */
  mailWyslany: boolean;
}

/** `POST /konto/usuniecie/anuluj`, 200. `juzBylo`: nie było czego anulować (ponowienie). */
export interface AnulowanieUsunieciaOdpowiedz {
  anulowane: true;
  juzBylo: boolean;
}

// ─── Księgowość, „Ten miesiąc” (M10b) ─────────────────────────────────

/** Rodzaj rozliczenia (`RodzajRozliczenia` z `lib/ksiegowosc/ten-miesiac.ts`; zgodność sprawdza test). */
export type RodzajRozliczeniaTelefonu = 'ryczalt' | 'pit' | 'zus_spoleczne' | 'zdrowotna' | 'vat';

/** Pozycja „Do zapłaty”, jak wiersz strony `reports/ten-miesiac`. Kwoty w groszach. */
export interface PozycjaRozliczeniaTelefonu {
  rodzaj: RodzajRozliczeniaTelefonu;
  nazwa: string;
  /** `null`: kwoty nie liczymy (`brak` mówi dlaczego i co dalej). */
  kwotaGr: number | null;
  brak: string | null;
  /** Termin faktyczny i ustawowy (RRRR-MM-DD); `przesuniety` na dzień roboczy. */
  termin: { faktyczny: string; nominalny: string; przesuniety: boolean } | null;
  /** Dane do przelewu, to samo zdanie co na stronie. */
  przelew: string;
  /** Ostatnia zatwierdzona wersja; `null`: niezatwierdzone. */
  rozliczenie: { id: string; wersja: number; kwotaGr: number; status: 'zatwierdzone' | 'zaplacone'; zaplaconeO: string | null } | null;
  /** Ile już zapłacono (najwyższa zapłacona wersja), w groszach. */
  zaplaconoGr: number;
  /** Dane zmieniły się po zatwierdzeniu: nowa kwota czeka na zatwierdzenie. */
  zmiana: boolean;
}

/**
 * `GET /api/mobile/v1/ksiegowosc?miesiac=RRRR-MM` (domyślnie poprzedni miesiąc, jak strona).
 * `wlaczona: false`: moduł księgowości nie jest włączony dla tej firmy (reszta pól pusta).
 */
export interface TenMiesiacOdpowiedz {
  wlaczona: boolean;
  miesiac: string;
  /** Miesiące do wyboru, od najnowszego. */
  miesiace: string[];
  dzis: string;
  /** Podpis pod kwotami („Według Twoich danych i stawek na … r.”). */
  podpis: string;
  forma: 'ryczalt' | 'skala' | 'liniowy' | null;
  /** Braki, przez które miesiąca nie liczymy (zdania strony); `null`, gdy policzony. */
  braki: string[] | null;
  przychodGr: number | null;
  kosztyGr: number | null;
  pozycje: PozycjaRozliczeniaTelefonu[];
  /** Właściciel albo administrator zatwierdza i oznacza zapłaty. */
  mozeEdytowac: boolean;
  miesiacZakonczony: boolean;
  /** Pozycje policzone, a jeszcze niezatwierdzone w tej postaci. */
  doZatwierdzenia: number;
  /** Skróty pozycji z tego widoku: zatwierdzenie zapisze tylko to, co klient widział. */
  skroty: Partial<Record<RodzajRozliczeniaTelefonu, string>>;
  /** Wszystkie wersje rozliczeń miesiąca, od najnowszej. */
  historia: Array<{ rodzaj: RodzajRozliczeniaTelefonu; nazwa: string; wersja: number; kwotaGr: number; zatwierdzoneO: string; zaplaconeO: string | null }>;
}

/** `POST /api/mobile/v1/ksiegowosc/zatwierdz`: miesiąc i skróty z widoku. */
export interface ZatwierdzenieMiesiacaZadanie {
  miesiac: string;
  skroty: Partial<Record<RodzajRozliczeniaTelefonu, string>>;
}

/** 200: `nowe` wersji zapisanych (0: wszystko było już zatwierdzone, ponowienie). */
export interface ZatwierdzenieMiesiacaOdpowiedz {
  nowe: number;
}

/** `POST /api/mobile/v1/ksiegowosc/rozliczenia/{id}/zaplata`: `dzien` RRRR-MM-DD przy `zaplacone: true`. */
export interface ZaplataRozliczeniaZadanie {
  zaplacone: boolean;
  dzien: string | null;
}

export interface ZaplataRozliczeniaOdpowiedz {
  zaplacone: boolean;
}

// ─── Ustawienia firmy (M10b) ──────────────────────────────────────────

/**
 * `GET /api/mobile/v1/ustawienia`: to, co karty Firma, KSeF i Przypomnienia
 * strony pokazują, do odczytu. Zmiany zapisuje się na stronie.
 */
export interface UstawieniaOdpowiedz {
  firma: {
    nazwa: string;
    nip: string;
    /** Dwie linie adresu jak na stronie (`address_json`). */
    adres: { linia1: string; linia2: string };
    rachunek: string | null;
    /** RRRR-MM-DD albo `null`. */
    rozpoczecie: string | null;
    /** Podstawa zwolnienia z VAT; `null`: czynny podatnik VAT bez zwolnienia. */
    zwolnienie: string | null;
    /** Zwolnienie podmiotowe (art. 113): firma nie jest czynnym podatnikiem VAT. */
    zwolnieniePodmiotowe: boolean;
    metodaKasowa: boolean;
  };
  ksef: {
    /** Jak plakietka strony: połączono (dowód w środowisku aplikacji), do potwierdzenia, brak certyfikatu. */
    stan: 'polaczono' | 'do_potwierdzenia' | 'brak';
    /** RRRR-MM-DD albo `null`. */
    certyfikatDo: string | null;
  };
  /**
   * Tylko dla właściciela (zakładka strony też tylko dla niego); `null` dla
   * pozostałych ról. `zapisane: false`: firma nie zapisała ustawień, więc
   * FaktWay nie przygotowuje przypomnień (reszta pól to propozycja strony).
   */
  przypomnienia: {
    zapisane: boolean;
    wlaczone: boolean;
    etapy: Array<{ etap: 1 | 2 | 3; wlaczony: boolean; dniPoTerminie: number }>;
    godzina: number;
    tylkoDniRobocze: boolean;
    najwiecej: number;
    nadawca: string | null;
    odpowiedzNa: string | null;
    wstrzymajPoOdpowiedzi: boolean;
    wstrzymajPoCzesciowej: boolean;
  } | null;
}

// ─── Rodzaje faktur, korekta, ponowienie, szkic, GUS (M8b) ────────────

/**
 * Nabywca zaliczki i rozliczenia: firma z NIP, jak formularze strony („Nabywca
 * (B2B)”, `buyerB2BSchema`). Osoby prywatnej i firmy z UE te formularze nie mają.
 */
export interface NabywcaRodzajuTelefonu {
  /** 10 cyfr. */
  nip: string;
  name: string;
  addressLine1: string;
  addressLine2: string;
  /** Pusty tekst = brak. */
  email: string;
}

/** Metoda płatności zaliczki, rozliczenia i korekty (jak formularze strony, z kompensatą). */
export type MetodaRodzajuTelefonu = 'transfer' | 'cash' | 'card' | 'compensation' | 'other';

/** Pola wspólne zaliczki, rozliczenia i korekty (jak formularze strony). Daty RRRR-MM-DD. */
interface DokumentRodzajuTelefonu {
  internalNumber: string;
  /** Przy wysyłce do KSeF tylko dziś (czas polski). */
  issueDate: string;
  paymentMethod: MetodaRodzajuTelefonu;
  paymentDueDate: string;
  /** 26 cyfr albo pusty tekst. */
  bankAccount: string;
  notes: string;
  /** Seria z podpowiedzi (`GET /faktury/podpowiedz?rodzaj=`) albo pusty tekst; numer jak w `FakturaTelefonu`. */
  numberSeriesId: string;
  numberPreview: string;
}

/**
 * Faktura zaliczkowa (`advanceInvoiceSchema` strony). Kwoty brutto w złotych;
 * netto i VAT zaliczki liczy serwer (`POST /faktury/wyliczenie`).
 */
export interface ZaliczkaTelefonu extends DokumentRodzajuTelefonu {
  /** Przy MPP: przelew i rachunek. */
  splitPayment: boolean;
  buyer: NabywcaRodzajuTelefonu;
  /** Kwota zaliczki brutto. */
  advanceAmount: number;
  /** Wartość zamówienia brutto (co najmniej zaliczka). */
  totalContractAmount: number;
  /** Planowana realizacja albo pusty tekst. */
  expectedDeliveryDate: string;
  /** Data otrzymania zaliczki (P_6), gdy inna niż wystawienia, albo pusty tekst. */
  advanceReceivedDate: string;
  vatRate: '23' | '8' | '5' | '0';
  /** Za co jest zaliczka (5 do 502 znaków). */
  description: string;
}

/** Pozycja rozliczenia i korekty „przed / po” (`invoiceLineSchema` strony, bez „zw”). */
export interface PozycjaRodzajuTelefonu {
  name: string;
  unit: string;
  quantity: number;
  unitPriceNet: number;
  /** Korekta faktury dla firmy z UE dopuszcza też `np_ii`. */
  vatRate: '23' | '8' | '5' | '0' | 'oo' | 'np' | 'np_ii';
}

/**
 * Faktura rozliczająca zaliczki (`finalInvoiceSchema` strony). Zaliczki z
 * `GET /faktury/zaliczki`; sumę zaliczek i kwotę do zapłaty liczy serwer.
 * Wysyłka do KSeF faktury rozliczającej jest dziś wstrzymana także na stronie:
 * `wyslij: true` daje 422 ze zdaniem strony, szkic się zapisuje.
 */
export interface RozliczenieTelefonu extends DokumentRodzajuTelefonu {
  splitPayment: boolean;
  buyer: NabywcaRodzajuTelefonu;
  advanceInvoiceIds: string[];
  lines: PozycjaRodzajuTelefonu[];
}

/**
 * Korekta faktury przyjętej w KSeF (`correctionInvoiceSchema` strony).
 * Sprzedawcę, nabywcę, numer i daty faktury pierwotnej oraz pozycje „przed”
 * bierze serwer z bazy (`GET /faktury/{id}/korekta`), nigdy z telefonu.
 */
export interface KorektaTelefonu extends DokumentRodzajuTelefonu {
  parentInvoiceId: string;
  correctionType: 'before_after' | 'amount_change' | 'cancellation';
  /** Przyczyna korekty (co najmniej 5 znaków). */
  correctionReason: string;
  /** MF `TTypKorekty`: 1 skutek w okresie faktury, 2 w dacie korekty, 3 inna data. */
  typKorekty: '1' | '2' | '3';
  /** `before_after`: pozycje po korekcie (start: kopia „przed”). Inne typy: pusta lista. */
  linesAfter: PozycjaRodzajuTelefonu[];
  /** `amount_change`: różnica wpisana przez klienta, jak na stronie; inne typy: `null`. */
  amountChange: { netDelta: number; vatDelta: number; grossDelta: number; description: string } | null;
}

/**
 * `POST /api/mobile/v1/faktury` dla zaliczki, rozliczenia i korekty (M8b): ta
 * sama trasa, ten sam nagłówek `Idempotency-Key` i ta sama odpowiedź
 * (`WystawienieOdpowiedz`) co zwykła faktura. Szkic zaliczki, rozliczenia
 * i korekty nie wysyła się później do KSeF (jak na stronie): wysyłka idzie
 * tylko razem z zapisem.
 */
export type WystawienieRodzajuZadanie =
  | { wyslij: boolean; zaliczka: ZaliczkaTelefonu }
  | { wyslij: boolean; rozliczenie: RozliczenieTelefonu }
  | { wyslij: boolean; korekta: KorektaTelefonu };

/**
 * `POST /api/mobile/v1/faktury/wyliczenie` (M8b): kwoty bez zapisu, policzone tymi
 * samymi funkcjami co zapis (telefon kwot nie liczy). Treść jak przy wystawieniu
 * bez `wyslij`; błąd danych to 422 `invoice_invalid` z polem.
 */
export type WyliczenieZadanie = { zaliczka: ZaliczkaTelefonu } | { rozliczenie: RozliczenieTelefonu } | { korekta: KorektaTelefonu };

/** Pozycja z kwotami serwera (zł). Korekta: pozycje po korekcie albo jedna pozycja różnicy. */
export interface PozycjaWyliczona {
  nazwa: string;
  ilosc: number;
  jednostka: string;
  cenaNetto: number;
  stawka: string;
  netto: number;
  vat: number;
  brutto: number;
}

/**
 * Kwoty dokumentu w złotych. Zaliczka: kwoty zaliczki. Rozliczenie: suma
 * pozycji, `doZaplaty` po odjęciu zaliczek. Korekta: różnica (może być ujemna).
 */
export interface WyliczenieOdpowiedz {
  netto: number;
  vat: number;
  brutto: number;
  doZaplaty: number;
  pozycje: PozycjaWyliczona[];
  /** Rozliczenie: zaliczki odjęte od kwoty do zapłaty (kwota brutto zaliczki). */
  zaliczki: Array<{ id: string; numer: string; brutto: number }>;
}

/** Zaliczka przyjęta w KSeF, jeszcze nierozliczona (jak lista formularza rozliczenia na stronie). */
export interface ZaliczkaDoRozliczenia {
  id: string;
  numer: string;
  numerKsef: string | null;
  dataWystawienia: string;
  /** Kwota zaliczki brutto (zł). */
  brutto: number;
  /** Nabywca zaliczki: rozliczenie obejmuje tylko zaliczki tego samego nabywcy (art. 106f ust. 3). */
  nabywca: { nazwa: string; nip: string | null; adres1: string; adres2: string; email: string };
}

/** `GET /api/mobile/v1/faktury/zaliczki` (M8b): najnowsze najpierw, najwyżej 120. */
export interface ZaliczkiOdpowiedz {
  zaliczki: ZaliczkaDoRozliczenia[];
}

/**
 * `GET /api/mobile/v1/faktury/{id}/korekta` (M8b): faktura pierwotna jak
 * kontekst formularza korekty strony. Stan „przed” to stan po poprzednich
 * przyjętych korektach. Odmowa (brak numeru KSeF, korekta w toku, anulowana)
 * to 422 `invoice_change_refused` ze zdaniem strony.
 */
export interface KontekstKorektyOdpowiedz {
  faktura: { id: string; numer: string; numerKsef: string; dataWystawienia: string; brutto: number | null };
  nabywca: { nazwa: string; nip: string | null; vatUe: string | null; osoba: boolean; adres1: string; adres2: string };
  /** `amount_change_only`: po korekcie kwotowej wolno tylko kolejną kwotową. */
  dozwolone: 'all' | 'amount_change_only';
  poprzedniaKorekta: { numer: string | null; typ: string | null } | null;
  /** Wspólna stawka bez VAT pozycji (VAT 0, brutto równe netto w korekcie kwotowej). */
  stawkaBezVat: 'np' | 'np_ii' | 'oo' | null;
  npIiDozwolone: boolean;
  pozycje: PozycjaRodzajuTelefonu[];
}

/**
 * `POST /faktury/{id}/ponowienie` („Wyślij ponownie” po błędzie wysyłki) i
 * `POST /faktury/{id}/szkic` („Wróć do szkicu”), M8b: faktura po zmianie.
 * Odmowa ze zdaniem strony: 422 `invoice_change_refused`; rola: 403 `forbidden`.
 */
export interface ZmianaFakturyOdpowiedz {
  faktura: FakturaZapisana;
}

/** `POST /api/mobile/v1/faktury/{id}/usuniecie` (M8b): szkic usunięty (numer wolny). */
export interface UsuniecieSzkicuOdpowiedz {
  usuniety: true;
}

/**
 * `GET /api/mobile/v1/gus/{nip}` (M8b): nabywca z kontrahentów firmy albo z GUS
 * (REGON), jak „Pobierz z GUS” na stronie. Zły NIP: 422 `invoice_invalid` z polem
 * `buyerNip`; brak w GUS: 404 `not_found`; GUS niedostępny: 503 `service_unavailable`.
 */
export interface GusOdpowiedz {
  zrodlo: 'kontrahenci' | 'gus';
  nabywca: { nip: string; nazwa: string; adres1: string; adres2: string };
}
