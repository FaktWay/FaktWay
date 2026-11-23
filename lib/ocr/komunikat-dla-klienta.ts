/**
 * Błąd odczytu dokumentu (OCR) zdaniem dla klienta (LIM-05, punkt 9 „Ryzyk,
 * które zostają” z #782).
 *
 * `ocr_jobs.error_message` to zapis dla operatora i raportu dziennego:
 * angielski tekst SDK („Request timed out.”, „529 {…overloaded_error…}”),
 * odpowiedź modelu z treścią paragonu, klucz pliku z magazynu. Zapis zostaje
 * techniczny (licznik odczytów po przekroczeniu czasu w raporcie dziennym
 * szuka w nim „timed out”, `lib/observability/business-metrics.ts`), a zdanie
 * dla klienta powstaje przy odczycie stanu zadania
 * (`lib/expenses/ocr-status.ts`: strona i telefon) i w powiadomieniu joba
 * (`lib/jobs/runners/process-ocr.ts`).
 *
 * Bez zgadywania po języku: zdanie, które już jest dla klienta (`DLA_KLIENTA`),
 * przechodzi bez zmian, znane teksty silnika i SDK dostają zdanie swojej
 * kategorii, a każdy inny zapis zdanie ogólne. Nowy komunikat dla klienta
 * w jobie OCR trzeba więc dopisać do `DLA_KLIENTA`, inaczej klient zobaczy
 * zdanie ogólne.
 *
 * Zdania kategorii (`KOMUNIKAT_ODCZYTU`): do 80 znaków (tyle zostawia
 * powiadomienie), pełne zdanie z kropką, bez trybu rozkazującego (lista
 * kontrolna filtra, pkt 16) i bez nazwy dostawcy modelu. Starsze zdania
 * z listy (po wyczerpaniu prób, odmowy budżetu) zostają bez zmian. Pilnuje tego
 * tests/unit/ocr-komunikat-dla-klienta.test.ts, razem z tekstami błędów
 * prawdziwego SDK. Wpisu ręcznego kosztu zdania nie obiecują, a strażnik
 * tests/unit/koszt-bez-wpisu-recznego.test.ts czyta też `lib/ocr` (powód
 * opisuje jego nagłówek).
 */

import { TENANT_AI_BUDGET_MESSAGES } from '@/lib/ai/tenant-ai-budget-messages';

/**
 * Komunikat dla klienta, gdy obrazu ponad 8000 px nie da się przygotować dla
 * API: za dużo pikseli, uszkodzony plik albo kopia ponad limit bajtów. Bez
 * trybu rozkazującego (lista kontrolna filtra, pkt 16) i do 80 znaków, bo tyle
 * zostawia powiadomienie. Wyjście: mniejsze zdjęcie albo PDF; oryginał zostaje
 * w archiwum, a karta „nie odczytałem” prowadzi do ponownego wgrania.
 *
 * Rzuca go `lib/ocr/image-for-api.ts` (eksportuje go też stamtąd). Leży
 * tutaj, bo stan zadania czyta aplikacja, a `image-for-api` ładuje tylko
 * worker.
 */
export const IMAGE_TOO_LARGE_MESSAGE = 'Zdjęcie ma ponad 8000 px i nie da się go odczytać. Potrzebne mniejsze albo PDF.';

/** Zadanie oznaczone po wyczerpaniu prób bez treści błędu (`onProcessOcrExhausted`). */
export const OCR_NIEUDANY_PO_PROBACH = 'Nie udało się rozpoznać paragonu. Spróbuj ponownie za kilka minut.';

/** Tyle znaków treści zostawia powiadomienie o nieudanym odczycie. */
export const POWIADOMIENIE_MAX_ZNAKOW = 80;

/** Zdania dla klienta według rodzaju błędu odczytu. */
export const KOMUNIKAT_ODCZYTU = {
  /**
   * Wywołanie modelu przekroczyło limit czasu (`lib/anthropic/client.ts`).
   * Także bezczynność gniazda magazynu przy pobieraniu zdjęcia („socket timed
   * out”), którą tak samo liczy raport dzienny.
   */
  czas: 'Odczyt trwał zbyt długo. Można spróbować ponownie za kilka minut.',
  /** Dostawca odmawia z powodu obciążenia albo limitu zapytań (429, 529). */
  zajeta: 'Usługa odczytu jest teraz zajęta. Można spróbować ponownie za kilka minut.',
  /**
   * Brak połączenia, awaria u dostawcy, kłopot z kontem u dostawcy (klucz,
   * środki, limit wydatków) albo brak klucza w środowisku workera.
   */
  niedostepna: 'Usługa odczytu jest chwilowo niedostępna. Można spróbować ponownie później.',
  /** Model odpowiedział, ale z odpowiedzi nie da się złożyć danych kosztu. */
  dane: 'Nie udało się odczytać danych z tego dokumentu. Można wgrać go ponownie.',
  /** Dostawca odrzucił obraz. */
  zdjecie: 'Nie udało się odczytać tego zdjęcia. Wyraźniejsze zdjęcie może pomóc.',
  /** Dostawca odrzucił plik PDF. */
  pdf: 'Nie udało się odczytać tego pliku PDF. Można wgrać zdjęcie dokumentu.',
  /**
   * Plik ponad limit dostawcy: obraz ponad limit bajtów albo pikseli, PDF ponad
   * limit stron albo okno kontekstu modelu, zapytanie ponad limit (413).
   * Ponowienie z tym samym plikiem nic nie da.
   */
  rozmiar: 'Plik jest za duży do odczytu. Potrzebne mniejsze zdjęcie albo krótszy PDF.',
  /** Typ pliku, którego silnik nie wysyła do modelu (wgranie przyjmuje te same pięć). */
  format: 'Nieobsługiwany format pliku. Potrzebne zdjęcie (JPG, PNG, WEBP, GIF) albo PDF.',
  /** Każdy inny zapis: błąd wewnętrzny, magazyn plików, baza, nieznany tekst. */
  ogolny: 'Nie udało się odczytać dokumentu. Można spróbować ponownie.',
} as const;

type Kategoria = keyof typeof KOMUNIKAT_ODCZYTU;

/** Zdania, które job zapisuje już dla klienta: przechodzą bez zmian. */
const DLA_KLIENTA: ReadonlySet<string> = new Set<string>([
  IMAGE_TOO_LARGE_MESSAGE,
  OCR_NIEUDANY_PO_PROBACH,
  ...TENANT_AI_BUDGET_MESSAGES,
  ...Object.values(KOMUNIKAT_ODCZYTU),
]);

/** Początki tekstów silnika (`lib/ocr/engine.ts`), gdy odpowiedzi modelu nie da się użyć. */
const DANE_SILNIKA = ['Claude zwrócił nieprawidłowy JSON', 'Brak text response z Claude', 'Schema validation:'];

/** Początki tekstów silnika o typie pliku (`lib/ocr/engine.ts`). */
const FORMAT_SILNIKA = ['Nieobsługiwany format pliku: ', 'Nieobsługiwany typ obrazu: '];

/** Tekst `getAnthropic` (`lib/anthropic/client.ts`), gdy w środowisku workera nie ma klucza. */
const BRAK_KLUCZA = 'ANTHROPIC_API_KEY missing';

interface BladHttpSdk {
  status: number;
  /** `error.type` z ciała odpowiedzi, np. `overloaded_error`; pusty, gdy go nie ma. */
  typ: string;
  /** `error.details.error_code`, np. `enforced_spend_limit_reached`; pusty, gdy go nie ma. */
  kod: string;
  /** `error.message` z ciała odpowiedzi; bez ciała w JSON-ie cały tekst po kodzie. */
  tresc: string;
}

/**
 * Błąd HTTP z SDK (0.137): `${status} ${JSON.stringify(body)}`, np.
 * `529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_…"}`,
 * albo `503 status code (no body)`. Typ i treść bierzemy z ciała, nie z całego
 * tekstu, bo losowy `request_id` potrafi zawierać na przykład „pdf”.
 */
function bladHttpSdk(t: string): BladHttpSdk | null {
  const m = /^(\d{3}) ([\s\S]*)$/.exec(t);
  if (!m) return null;
  const wynik: BladHttpSdk = { status: Number(m[1]), typ: '', kod: '', tresc: m[2] };
  try {
    const cialo = JSON.parse(m[2]) as {
      error?: { type?: unknown; message?: unknown; details?: { error_code?: unknown } | null };
    } | null;
    if (typeof cialo?.error?.type === 'string') wynik.typ = cialo.error.type;
    if (typeof cialo?.error?.details?.error_code === 'string') wynik.kod = cialo.error.details.error_code;
    if (typeof cialo?.error?.message === 'string') wynik.tresc = cialo.error.message;
  } catch {
    // Ciało nie jest JSON-em: zostaje cały tekst po kodzie.
  }
  return wynik;
}

function kategoria(t: string): Kategoria {
  // Teksty silnika najpierw: odpowiedź modelu w nich może zawierać dowolne
  // słowa, także „timed out” albo kod na początku.
  if (FORMAT_SILNIKA.some((p) => t.startsWith(p))) return 'format';
  if (DANE_SILNIKA.some((p) => t.startsWith(p))) return 'dane';
  // Konfiguracja po naszej stronie: naprawia operator, ponowienie nic nie zmieni.
  if (t.startsWith(BRAK_KLUCZA)) return 'niedostepna';

  // `APIConnectionTimeoutError` („Request timed out.”), także limit połączenia
  // i bezczynność gniazda magazynu. Ten sam wzorzec liczy raport dzienny.
  if (/timed out/i.test(t)) return 'czas';
  // `APIConnectionError` („Connection error.”).
  if (t.startsWith('Connection error')) return 'niedostepna';

  const http = bladHttpSdk(t);
  if (!http) return 'ogolny';
  const { status, typ, kod, tresc } = http;
  // Konto u dostawcy: limit wydatków (429 bez `retry-after`, wraca dopiero
  // w nowym okresie), płatność (402), brak środków albo limit użycia (400).
  // Klient nic tu nie zmieni, a za kilka minut też nie wróci, więc nie „zajęta”.
  if (kod === 'enforced_spend_limit_reached' || status === 402 || typ === 'billing_error') return 'niedostepna';
  if (/credit balance|usage limits?/i.test(tresc)) return 'niedostepna';
  if (status === 429 || status === 529 || typ === 'rate_limit_error' || typ === 'overloaded_error') return 'zajeta';
  if (status === 413 || typ === 'request_too_large') return 'rozmiar';
  if (status === 400) {
    // Plik ponad okno kontekstu modelu (gęsty PDF): prompt OCR jest stały i krótki.
    if (/prompt is too long/i.test(tresc)) return 'rozmiar';
    // Ścieżka bloku z plikiem („…image.source…”, „…document.source…”) i słowo
    // o limicie: obraz ponad limit bajtów albo pikseli, PDF ponad limit stron.
    // Bez pliku w treści „maximum” znaczy co innego (np. `max_tokens`).
    // „document” tylko jako całe słowo: „documentation” to nie plik.
    if (/\bpdf\b|\bdocuments?\b|image/i.test(tresc) && /exceed|maximum|too (large|big|long)/i.test(tresc)) return 'rozmiar';
    if (/\bpdf\b|\bdocuments?\b/i.test(tresc)) return 'pdf';
    if (/image/i.test(tresc)) return 'zdjecie';
    return 'ogolny';
  }
  // Klucz, uprawnienia, model albo awaria po stronie dostawcy.
  if (status === 401 || status === 403 || status === 404 || status >= 500) return 'niedostepna';
  return 'ogolny';
}

/**
 * Zdanie dla klienta zamiast zapisu `ocr_jobs.error_message`. Idempotentne:
 * zdanie z `DLA_KLIENTA` wraca bez zmian, więc podwójne tłumaczenie niczego
 * nie psuje.
 */
export function komunikatBleduOdczytu(techniczny: string | null | undefined): string {
  const t = techniczny?.trim() ?? '';
  if (!t) return KOMUNIKAT_ODCZYTU.ogolny;
  if (DLA_KLIENTA.has(t)) return t;
  return KOMUNIKAT_ODCZYTU[kategoria(t)];
}

/**
 * Treść powiadomienia: komunikat w całości, gdy się mieści, a inaczej tyle
 * pełnych zdań z początku, ile wejdzie w `max` znaków. Wcześniej job ucinał
 * tekst w połowie słowa („Spróbuj ponown”). Gdy już pierwsze zdanie jest za
 * długie, cięcie na granicy słowa z wielokropkiem.
 */
export function trescPowiadomienia(komunikat: string, max: number = POWIADOMIENIE_MAX_ZNAKOW): string {
  if (komunikat.length <= max) return komunikat;

  const zdania = komunikat.match(/[^.!?]+[.!?]+/g) ?? [];
  let tresc = '';
  for (const zdanie of zdania) {
    const dluzsza = tresc ? `${tresc} ${zdanie.trim()}` : zdanie.trim();
    if (dluzsza.length > max) break;
    tresc = dluzsza;
  }
  if (tresc) return tresc;

  const spacja = komunikat.lastIndexOf(' ', max - 1);
  return `${spacja > 0 ? komunikat.slice(0, spacja).trimEnd() : komunikat.slice(0, max - 1)}…`;
}
