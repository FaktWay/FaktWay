import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * LIM-05, punkt 9 „Ryzyk, które zostają” (#782): zapis `ocr_jobs.error_message`
 * zamieniony na zdanie dla klienta (`lib/ocr/komunikat-dla-klienta.ts`).
 *
 * Teksty SDK sprawdzamy na prawdziwym kliencie `@anthropic-ai/sdk` (atrapa
 * tylko dla `fetch`) i prawdziwym silniku OCR: `error` z silnika to dokładnie
 * to, co job zapisuje w zadaniu. Gdy nowa wersja SDK zmieni format błędów, ten
 * plik zaczerwieni się, zamiast po cichu zamieniać każdy błąd w zdanie ogólne.
 */

const sdk = vi.hoisted(() => ({ client: null as unknown, prawdziwy: false }));

vi.mock('@/lib/anthropic/client', async (importOriginal) => {
  const modul = await importOriginal<typeof import('@/lib/anthropic/client')>();
  return {
    OCR_MODEL: 'claude-test',
    // `prawdziwy`: klient z modułu, z jego sprawdzeniem klucza w środowisku.
    getAnthropic: () => (sdk.prawdziwy ? modul.getAnthropic() : sdk.client),
  };
});

import { TENANT_AI_BUDGET_MESSAGES } from '@/lib/ai/tenant-ai-budget-messages';
import { extractInvoiceFromImage } from '@/lib/ocr/engine';
import { IMAGE_TOO_LARGE_MESSAGE as IMAGE_TOO_LARGE_Z_IMAGE_FOR_API } from '@/lib/ocr/image-for-api';
import {
  IMAGE_TOO_LARGE_MESSAGE,
  KOMUNIKAT_ODCZYTU,
  komunikatBleduOdczytu,
  OCR_NIEUDANY_PO_PROBACH,
  POWIADOMIENIE_MAX_ZNAKOW,
  trescPowiadomienia,
} from '@/lib/ocr/komunikat-dla-klienta';

/** „%PDF-1.4\n”: silnik wysyła PDF bez przygotowania obrazu. */
const PDF = 'JVBERi0xLjQK';
/** Obraz 1×1 px: przechodzi prawdziwe przygotowanie obrazu bez zmian. */
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
/** Identyfikator żądania z „pdf”, „Image” i „Document” w środku: kategorii nie wolno brać z całego tekstu. */
const REQUEST_ID = 'req_011CpdfImageDocument';

type Transport = (adres: unknown, init?: RequestInit) => Promise<Response>;

let fetchMock = vi.fn<Transport>();

function podstaw(transport: Transport): void {
  fetchMock = vi.fn<Transport>(transport);
  sdk.client = new Anthropic({ apiKey: 'syntetyczny-klucz', fetch: fetchMock, timeout: 50, maxRetries: 0 });
}

/** Połączenie, które stanęło: błąd dopiero po przerwaniu sygnałem, jak w prawdziwym `fetch`. */
const zawieszone: Transport = (_adres, init) =>
  new Promise<Response>((_ok, odrzuc) => {
    init?.signal?.addEventListener('abort', () => odrzuc(new DOMException('This operation was aborted', 'AbortError')));
  });

const bezPolaczenia: Transport = async () => {
  throw new TypeError('fetch failed');
};

function bladApi(status: number, type: string, message: string, details?: Record<string, string>): Transport {
  return async () =>
    new Response(JSON.stringify({ type: 'error', error: { type, message, details }, request_id: REQUEST_ID }), {
      status,
      headers: { 'content-type': 'application/json', 'request-id': REQUEST_ID },
    });
}

function odpowiedzModelu(content: unknown[]): Transport {
  return async () =>
    new Response(
      JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
}

const tekstModelu = (text: string) => odpowiedzModelu([{ type: 'text', text }]);

/** Tekst, który job zapisałby w `ocr_jobs.error_message` (`ocrResult.error`). */
async function zapisSilnika(data: string, mime: string): Promise<string> {
  const wynik = await extractInvoiceFromImage(data, mime);
  expect(wynik.success).toBe(false);
  return wynik.error ?? '';
}

beforeEach(() => {
  vi.stubEnv('E2E_MOCK_ANTHROPIC', '');
});

afterEach(() => {
  sdk.prawdziwy = false;
  vi.unstubAllEnvs();
});

describe('teksty prawdziwego SDK i silnika: zdanie kategorii', () => {
  it.each([
    ['limit czasu (połączenie stanęło)', 'czas', zawieszone],
    ['brak połączenia', 'niedostepna', bezPolaczenia],
    [
      '429 limit zapytań',
      'zajeta',
      bladApi(429, 'rate_limit_error', 'Number of request tokens has exceeded your per-minute rate limit'),
    ],
    ['529 przeciążenie', 'zajeta', bladApi(529, 'overloaded_error', 'Overloaded')],
    [
      '400 brak środków na koncie dostawcy',
      'niedostepna',
      bladApi(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'),
    ],
    [
      '400 limit użycia konta u dostawcy',
      'niedostepna',
      bladApi(
        400,
        'invalid_request_error',
        'You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.',
      ),
    ],
    [
      // Rozpoznany po kodzie w `error.details`, nie po treści: ta nie ma „usage limit”.
      '429 limit wydatków konta (wraca w nowym okresie, nie za kilka minut)',
      'niedostepna',
      bladApi(429, 'rate_limit_error', 'Monthly spend cap reached.', { error_code: 'enforced_spend_limit_reached' }),
    ],
    ['402 płatność u dostawcy', 'niedostepna', bladApi(402, 'billing_error', 'Payment required.')],
    ['401 zły klucz', 'niedostepna', bladApi(401, 'authentication_error', 'invalid x-api-key')],
    ['404 brak modelu', 'niedostepna', bladApi(404, 'not_found_error', 'model: claude-test')],
    ['500 awaria dostawcy', 'niedostepna', bladApi(500, 'api_error', 'Internal server error')],
    [
      '400 odrzucony PDF',
      'pdf',
      bladApi(400, 'invalid_request_error', 'messages.0.content.0.document.source.base64.data: The PDF specified was not valid.'),
    ],
    [
      '400 PDF ponad limit stron',
      'rozmiar',
      bladApi(
        400,
        'invalid_request_error',
        'messages.0.content.0.document.source.base64.data: A maximum of 100 PDF pages may be provided.',
      ),
    ],
    [
      // W treści tylko ścieżka `document.source`, bez „PDF”: te dwa wiersze strzegą słowa „document” w obu regułach 400.
      '400 odrzucony dokument (w treści tylko ścieżka `document.source`)',
      'pdf',
      bladApi(400, 'invalid_request_error', 'messages.0.content.0.document.source.base64.data: invalid'),
    ],
    [
      '400 dokument ponad limit (w treści tylko ścieżka `document.source`)',
      'rozmiar',
      bladApi(400, 'invalid_request_error', 'messages.0.content.0.document.source.base64.data: exceeds maximum size'),
    ],
    [
      '400 plik ponad okno kontekstu modelu',
      'rozmiar',
      bladApi(400, 'invalid_request_error', 'prompt is too long: 250000 tokens > 200000 maximum'),
    ],
    [
      '400 inny błąd zapytania („maximum” bez pliku, identyfikator żądania z „pdf”)',
      'ogolny',
      bladApi(
        400,
        'invalid_request_error',
        'max_tokens: 100000 > 64000, which is the maximum allowed number of output tokens for claude-test',
      ),
    ],
    [
      '413 za duże zapytanie',
      'rozmiar',
      bladApi(413, 'request_too_large', 'Request exceeds the maximum allowed number of bytes.'),
    ],
    [
      'odpowiedź modelu bez JSON-u, z treścią paragonu',
      'dane',
      tekstModelu('Sprzedawca: Jan Kowalski, ul. Polna 1. Request timed out'),
    ],
    ['JSON niezgodny ze schematem', 'dane', tekstModelu('[]')],
    ['odpowiedź bez bloku tekstu', 'dane', odpowiedzModelu([])],
  ] as const)('%s (PDF): %s', async (_opis, kat, transport) => {
    podstaw(transport);

    const zapis = await zapisSilnika(PDF, 'application/pdf');

    expect(fetchMock).toHaveBeenCalled();
    expect(komunikatBleduOdczytu(zapis)).toBe(KOMUNIKAT_ODCZYTU[kat]);
  });

  it('limit czasu: zapis „Request timed out.”, ten sam tekst liczy raport dzienny', async () => {
    podstaw(zawieszone);

    expect(await zapisSilnika(PDF, 'application/pdf')).toBe('Request timed out.');
  });

  it('błąd HTTP: kod i całe ciało JSON z identyfikatorem żądania (format, na którym stoi podział)', async () => {
    podstaw(bladApi(529, 'overloaded_error', 'Overloaded'));

    const zapis = await zapisSilnika(PDF, 'application/pdf');

    expect(zapis).toMatch(/^529 \{"type":"error","error":\{"type":"overloaded_error","message":"Overloaded"\}/);
    expect(zapis).toContain(REQUEST_ID);
  });

  // Teksty jak w atrapie API w tests/unit/ocr-duzy-obraz.test.ts.
  it.each([
    [
      'niezgodny z typem',
      'zdjecie',
      'messages.0.content.0.image.source.base64: The image was specified using the image/png media type, but does not appear to be a valid png image',
    ],
    ['nieczytelny', 'zdjecie', 'messages.0.content.0.image.source.base64: Could not process image'],
    ['ponad limit bajtów', 'rozmiar', 'messages.0.content.0.image.source.base64: image exceeds 10 MB maximum'],
    [
      'ponad limit pikseli',
      'rozmiar',
      'messages.0.content.0.image.source.base64.data: At least one of the image dimensions exceed max allowed size: 8000 pixels',
    ],
  ] as const)('400 odrzucony obraz, %s (PNG przez prawdziwe przygotowanie obrazu): %s', async (_opis, kat, message) => {
    podstaw(bladApi(400, 'invalid_request_error', message));

    const zapis = await zapisSilnika(PNG_1X1, 'image/png');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(komunikatBleduOdczytu(zapis)).toBe(KOMUNIKAT_ODCZYTU[kat]);
  });

  it('brak klucza w środowisku workera (prawdziwy `getAnthropic`): niedostępna, bez wywołania API', async () => {
    podstaw(tekstModelu('{}'));
    sdk.prawdziwy = true;
    vi.stubEnv('ANTHROPIC_API_KEY', '');

    const zapis = await zapisSilnika(PDF, 'application/pdf');

    expect(zapis).toBe('ANTHROPIC_API_KEY missing');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(komunikatBleduOdczytu(zapis)).toBe(KOMUNIKAT_ODCZYTU.niedostepna);
  });

  it('typ pliku spoza silnika (HEIC): format, bez wywołania modelu', async () => {
    podstaw(tekstModelu('{}'));

    const zapis = await zapisSilnika('AAAA', 'image/heic');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(komunikatBleduOdczytu(zapis)).toBe(KOMUNIKAT_ODCZYTU.format);
  });
});

describe('reguły bez SDK', () => {
  it.each([
    ['tekst silnika wygrywa z wzorcami SDK', 'dane', 'Claude zwrócił nieprawidłowy JSON: 529 overloaded_error Request timed out'],
    ['walidacja schematu', 'dane', 'Schema validation: gross_amount: Expected number, received string'],
    ['brak tekstu w odpowiedzi', 'dane', 'Brak text response z Claude'],
    ['typ obrazu w silniku', 'format', 'Nieobsługiwany typ obrazu: image/heic'],
    ['limit czasu, inna wielkość liter', 'czas', 'request TIMED OUT'],
    [
      'bezczynność gniazda magazynu przy pobieraniu zdjęcia',
      'czas',
      '@smithy/node-http-handler - the request socket timed out after 30000 ms of inactivity',
    ],
    ['503 bez ciała', 'niedostepna', '503 status code (no body)'],
    ['502 z ciałem spoza JSON-u', 'niedostepna', '502 <html>Bad Gateway</html>'],
    [
      // Konto u dostawcy wygrywa z limitem zapytań także bez kodu w `error.details`.
      '429 z treścią o limicie użycia, bez kodu',
      'niedostepna',
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"You have reached your specified API usage limits."}}',
    ],
    ['413 bez ciała (pośrednik)', 'rozmiar', '413 status code (no body)'],
    [
      '400 z „pdf” tylko w identyfikatorze żądania',
      'ogolny',
      `400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: must be positive"},"request_id":"${REQUEST_ID}"}`,
    ],
    [
      // „document” tylko jako całe słowo (ścieżka `…document.source…`), nie w „documentation”.
      '400 ze słowem „documentation”, bez pliku w treści',
      'ogolny',
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"top_k: must be positive. See the documentation for valid values."}}',
    ],
    [
      '400 ze słowami „documentation” i „maximum”, bez pliku w treści',
      'ogolny',
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 100000 > 64000, which is the maximum allowed number of output tokens. See the documentation for model limits."}}',
    ],
    ['przeciążenie bez kodu na początku', 'ogolny', '{"type":"overloaded_error","message":"Overloaded"}'],
    ['przerwane żądanie', 'ogolny', 'Request was aborted.'],
    ['zadanie innej firmy', 'ogolny', 'Job nie istnieje lub niewłaściwy tenant'],
    ['autor usunął konto', 'ogolny', 'Autor zadania OCR usunął konto'],
    ['klucz pliku z magazynu', 'ogolny', 'R2: empty body for expense photo: tenants/aaaaaaaa/expenses/2026/11/job.jpg'],
    ['błąd bazy', 'ogolny', 'duplicate key value violates unique constraint "expenses_ocr_job_id_key"'],
    ['stary zapis joba', 'ogolny', 'OCR failed'],
  ] as const)('%s: %s', (_opis, kat, zapis) => {
    expect(komunikatBleduOdczytu(zapis)).toBe(KOMUNIKAT_ODCZYTU[kat]);
  });

  it.each([
    ['pusty', ''],
    ['same spacje', '  \n '],
    ['null', null],
    ['undefined', undefined],
  ])('brak zapisu (%s): zdanie ogólne', (_opis, zapis) => {
    expect(komunikatBleduOdczytu(zapis)).toBe(KOMUNIKAT_ODCZYTU.ogolny);
  });
});

/** Tryb rozkazujący (lista kontrolna filtra, pkt 16): czasowniki, które kusiłyby w takich zdaniach. */
const ROZKAZ =
  /(^|[^a-ząćęłńóśźż])(spróbuj|zrób|wgraj|sprawdź|wpisz|dodaj|użyj|wybierz|zmniejsz|prześlij)(?![a-ząćęłńóśźż])/i;

describe('zdania dla klienta', () => {
  const ZDANIA_KATEGORII = Object.values(KOMUNIKAT_ODCZYTU);

  it('wzorzec trybu rozkazującego łapie także czasownik zakończony polską literą', () => {
    expect('Sprawdź zdjęcie.').toMatch(ROZKAZ);
    expect('Można spróbować ponownie.').not.toMatch(ROZKAZ);
  });

  it.each([IMAGE_TOO_LARGE_MESSAGE, OCR_NIEUDANY_PO_PROBACH, ...TENANT_AI_BUDGET_MESSAGES, ...ZDANIA_KATEGORII])(
    '„%s” przechodzi bez zmian (tłumaczenie jest idempotentne)',
    (zdanie) => {
      expect(komunikatBleduOdczytu(zdanie)).toBe(zdanie);
      expect(komunikatBleduOdczytu(` ${zdanie}\n`)).toBe(zdanie);
    },
  );

  it('obraz ponad 8000 px: ta sama stała w image-for-api i tutaj', () => {
    expect(IMAGE_TOO_LARGE_Z_IMAGE_FOR_API).toBe(IMAGE_TOO_LARGE_MESSAGE);
  });

  it.each(ZDANIA_KATEGORII)('„%s”: pełne zdanie do 80 znaków, bez rozkazu i bez nazwy dostawcy', (zdanie) => {
    expect(zdanie.length).toBeLessThanOrEqual(POWIADOMIENIE_MAX_ZNAKOW);
    expect(zdanie).toMatch(/^[A-ZĄĆĘŁŃÓŚŹŻ]/);
    expect(zdanie.endsWith('.')).toBe(true);
    expect(zdanie).not.toContain(String.fromCharCode(0x2014));
    expect(zdanie).not.toMatch(/\b(claude|anthropic|sdk|api)\b/i);
    expect(zdanie).not.toMatch(/faktflow/i);
    // Bez `\b` na końcu: w JS to granica tylko dla liter ASCII, a „sprawdź” kończy się na „ź”.
    expect(zdanie).not.toMatch(ROZKAZ);
    expect(trescPowiadomienia(zdanie)).toBe(zdanie);
  });
});

describe('treść powiadomienia', () => {
  it('mieści się: bez zmian', () => {
    expect(trescPowiadomienia('Krótkie zdanie.')).toBe('Krótkie zdanie.');
  });

  it('dwa zdania ponad 80 znaków: pierwsze w całości, nie urwane słowo', () => {
    const komunikat = 'Automatyczne rozpoznawanie dokumentów jest chwilowo niedostępne. Spróbuj ponownie później.';
    expect(komunikat.length).toBeGreaterThan(POWIADOMIENIE_MAX_ZNAKOW);

    expect(trescPowiadomienia(komunikat)).toBe('Automatyczne rozpoznawanie dokumentów jest chwilowo niedostępne.');
  });

  it('kilka zdań: tyle pełnych, ile wejdzie', () => {
    expect(trescPowiadomienia('Raz dwa. Trzy cztery. Pięć sześć siedem.', 25)).toBe('Raz dwa. Trzy cztery.');
  });

  it('pierwsze zdanie ponad limit: cięcie na granicy słowa z wielokropkiem', () => {
    const komunikat =
      'Bardzo długie zdanie bez kropki w środku, które ma znacznie więcej niż osiemdziesiąt znaków razem.';
    expect(komunikat.length).toBeGreaterThan(POWIADOMIENIE_MAX_ZNAKOW);

    const tresc = trescPowiadomienia(komunikat);

    expect(tresc.length).toBeLessThanOrEqual(POWIADOMIENIE_MAX_ZNAKOW);
    expect(tresc.endsWith('…')).toBe(true);
    expect(komunikat.startsWith(tresc.slice(0, -1))).toBe(true);
    expect(komunikat.charAt(tresc.length - 1)).toBe(' ');
  });

  it('słowo dłuższe niż limit: twarde cięcie z wielokropkiem', () => {
    expect(trescPowiadomienia('x'.repeat(100))).toBe(`${'x'.repeat(79)}…`);
  });
});
