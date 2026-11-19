import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatDays, formatPlnPlain } from '@/lib/flo/money';

import { createFakeDb } from './flo-fake-db';

/**
 * LIM-05 (plan skalowania 3000, reszta z #732): limity czasu klienta Anthropic.
 *
 * Klient powstawał z domyślnymi ustawieniami SDK: 600 s na próbę i 2
 * ponowienia. Połączenie, które stanęło, trzymało więc wywołanie do ok. 30 min
 * (3 × 600 s; na produkcji ok. 15 min, bo undici przerywa po 300 s bez
 * nagłówków). Kolejka OCR bierze jedno zadanie naraz, więc jedno takie
 * wywołanie wstrzymywało odczyt zdjęć wszystkim firmom, a w czacie pomocy
 * człowiek patrzył na pustą odpowiedź.
 *
 * Atrapa transportu: `fetch` podstawiony, zanim klient powstanie (SDK bierze
 * globalny `fetch` w konstruktorze, a `getAnthropic()` trzyma klienta
 * w module, stąd `vi.resetModules()`). Zawieszona atrapa nie odpowiada nigdy,
 * a błąd oddaje dopiero po przerwaniu sygnałem, jak prawdziwe połączenie,
 * które stanęło. Zegar jest udawany: test przesuwa czas od timera do timera
 * i mierzy, po ilu udawanych milisekundach przyszedł wynik.
 */

vi.mock('@/lib/support/knowledge-base', () => ({
  buildKnowledgeBaseContext: () => ({ count: 0, text: '' }),
}));

/*
 * Przygotowanie obrazu do OCR (`fitImageForApi`) ładuje bibliotekę natywną
 * sharp przy pierwszym obrazie i czyta nagłówek na wątkach libuv, czyli
 * w prawdziwym czasie, a test przesuwa udawany zegar. Przy zimnym procesie
 * (pierwszy import sharp) pętla `przesuwajZegar` nie widziała żadnego timera
 * przez 20 kroków i kończyła test, zanim SDK wysłało zapytanie. Spóźnione
 * zapytanie stawiało potem limit 120 s na zegarze następnego testu, a ten
 * przesuwał go w czasie, gdy sam czekał na sharp: 230 000 ms zamiast 115 000.
 * Limitów czasu SDK przygotowanie obrazu nie dotyczy, więc obraz przechodzi
 * bez zmian, jak mały obraz w `fitImageForApi`, i cały test biegnie na
 * udawanym zegarze.
 */
vi.mock('@/lib/ocr/image-for-api', () => ({
  fitImageForApi: async (data: string, mediaType: string) => ({ data, mediaType }),
}));

/** Granica przesuwania zegara: za najgorszym przypadkiem domyślnych limitów SDK (3 × 600 s). */
const GRANICA_MS = 40 * 60_000;

interface Proba {
  /** `X-Stainless-Timeout`: limit tej próby w sekundach, tak jak go liczy SDK. */
  limitS: string | null;
  /** `X-Stainless-Retry-Count`: 0 to pierwsza próba, 1 pierwsze ponowienie. */
  ponowienie: string | null;
}

type Transport = (init: RequestInit | undefined) => Promise<Response>;
type Wynik<T> = { ok: true; wartosc: T } | { ok: false; blad: unknown };

const proby: Proba[] = [];

beforeEach(() => {
  proby.length = 0;
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-atrapa');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function podstawTransport(odpowiedz: Transport): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((_adres: unknown, init?: RequestInit) => {
      const naglowki = new Headers(init?.headers);
      proby.push({
        limitS: naglowki.get('x-stainless-timeout'),
        ponowienie: naglowki.get('x-stainless-retry-count'),
      });
      return odpowiedz(init);
    }),
  );
}

/** Woła `reakcja`, gdy SDK przerwie próbę (własnym limitem albo sygnałem wywołującego). */
function poPrzerwaniu(init: RequestInit | undefined, reakcja: (powod: unknown) => void): void {
  const sygnal = init?.signal;
  if (!sygnal) return;
  const powod = (): unknown => sygnal.reason ?? new DOMException('This operation was aborted', 'AbortError');
  if (sygnal.aborted) reakcja(powod());
  else sygnal.addEventListener('abort', () => reakcja(powod()), { once: true });
}

/** Połączenie, które stanęło: nic nie przychodzi, błąd dopiero po przerwaniu. */
const zawieszone: Transport = (init) => new Promise<Response>((_, reject) => poPrzerwaniu(init, reject));

function wiadomosc(tekst: string) {
  return {
    id: 'msg_atrapa',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: tekst ? [{ type: 'text', text: tekst }] : [],
    stop_reason: tekst ? 'end_turn' : null,
    stop_sequence: null,
    usage: { input_tokens: 1500, output_tokens: 900 },
  };
}

/** Uczciwa, powolna odpowiedź bez strumienia: cała wiadomość po `ms`. */
function wiadomoscPo(ms: number, tekst: string): Transport {
  return (init) =>
    new Promise<Response>((resolve, reject) => {
      const zegar = setTimeout(
        () =>
          resolve(
            new Response(JSON.stringify(wiadomosc(tekst)), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          ),
        ms,
      );
      poPrzerwaniu(init, (powod) => {
        clearTimeout(zegar);
        reject(powod);
      });
    });
}

const sse = (zdarzenie: string, dane: unknown): string => `event: ${zdarzenie}\ndata: ${JSON.stringify(dane)}\n\n`;
const POCZATEK =
  sse('message_start', { type: 'message_start', message: wiadomosc('') }) +
  sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
const fragment = (tekst: string): string =>
  sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: tekst } });
const KONIEC =
  sse('content_block_stop', { type: 'content_block_stop', index: 0 }) +
  sse('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 40 },
  }) +
  sse('message_stop', { type: 'message_stop' });

/**
 * Odpowiedź strumieniem (SSE): nagłówki od razu, kawałki w zadanych chwilach.
 * Bez `zamknij` strumień po ostatnim kawałku stoi, jak serwer, który przestał
 * pisać, a połączenia nie zamknął.
 */
function strumien(kawalki: ReadonlyArray<readonly [ms: number, tekst: string]>, zamknij: boolean): Transport {
  return (init) => {
    const kodowanie = new TextEncoder();
    const cialo = new ReadableStream<Uint8Array>({
      start(kontroler) {
        const zegary = kawalki.map(([ms, tekst]) => setTimeout(() => kontroler.enqueue(kodowanie.encode(tekst)), ms));
        if (zamknij) zegary.push(setTimeout(() => kontroler.close(), Math.max(0, ...kawalki.map(([ms]) => ms))));
        poPrzerwaniu(init, (powod) => {
          zegary.forEach(clearTimeout);
          try {
            kontroler.error(powod);
          } catch {
            // Strumień już zamknięty: nie ma czego przerywać.
          }
        });
      },
    });
    return Promise.resolve(
      new Response(cialo, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
  };
}

/**
 * Przesuwa udawany zegar od timera do timera, aż obietnica się rozstrzygnie,
 * i mówi, po ilu milisekundach. Gdy nie ma już żadnego timera, a wyniku dalej
 * brak, nic tego nie przerwie: `wynik` zostaje pusty (wywołanie wisi bez końca).
 */
async function przesuwajZegar<T>(praca: Promise<T>): Promise<{ wynik: Wynik<T> | undefined; ms: number }> {
  const start = Date.now();
  const stan: { wynik?: Wynik<T> } = {};
  void praca.then(
    (wartosc) => {
      stan.wynik = { ok: true, wartosc };
    },
    (blad: unknown) => {
      stan.wynik = { ok: false, blad };
    },
  );
  let krokiBezTimerow = 0;
  while (!stan.wynik && Date.now() - start < GRANICA_MS && krokiBezTimerow < 20) {
    await vi.advanceTimersToNextTimerAsync();
    krokiBezTimerow = vi.getTimerCount() === 0 ? krokiBezTimerow + 1 : 0;
  }
  return { wynik: stan.wynik, ms: Date.now() - start };
}

const ZDJECIE = Buffer.from('atrapa zdjęcia faktury').toString('base64');

/** Odczyt, który przechodzi schemat OCR (`lib/ocr/schema.ts`). NIP fikcyjny. */
const ODCZYT = {
  seller_name: 'Firma Testowa Sp. z o.o.',
  seller_nip: '1234567890',
  seller_address: 'ul. Testowa 1, 00-001 Warszawa',
  document_number: 'FV/1/11/2026',
  document_type: 'invoice',
  issue_date: '2026-11-10',
  currency: 'PLN',
  net_amount: 100,
  vat_amount: 23,
  gross_amount: 123,
  vat_rate: '23',
  line_items: [{ name: 'Usługa testowa', quantity: 1, unit_price: 100, gross: 123 }],
  ocr_confidence: 0.9,
  notes: null,
};

describe('LIM-05: OCR w workerze (domyślne limity klienta)', () => {
  it('zawieszone połączenie zwalnia kolejkę po 2 próbach po 120 s, nie po 3 × 600 s', async () => {
    podstawTransport(zawieszone);
    const { extractInvoiceFromImage } = await import('@/lib/ocr/engine');

    const { wynik, ms } = await przesuwajZegar(extractInvoiceFromImage(ZDJECIE, 'image/jpeg'));

    expect(ms, 'jak długo zawieszone wywołanie trzyma kolejkę OCR').toBeLessThanOrEqual(241_000);
    expect(proby).toEqual([
      { limitS: '120', ponowienie: '0' },
      { limitS: '120', ponowienie: '1' },
    ]);
    expect(wynik).toMatchObject({ ok: true, wartosc: { success: false, error: expect.stringMatching(/timed out/i) } });
  });

  it('uczciwy, powolny odczyt (115 s, ok. dwa szacunki SDK dla max_tokens 2048) przechodzi za pierwszym razem', async () => {
    podstawTransport(wiadomoscPo(115_000, JSON.stringify(ODCZYT)));
    const { extractInvoiceFromImage } = await import('@/lib/ocr/engine');

    const { wynik, ms } = await przesuwajZegar(extractInvoiceFromImage(ZDJECIE, 'image/jpeg'));

    expect(wynik).toMatchObject({ ok: true, wartosc: { success: true, processingTimeMs: 115_000 } });
    expect(ms).toBe(115_000);
    expect(proby).toHaveLength(1);
  });
});

describe('LIM-05: czat pomocy (czeka człowiek)', () => {
  const PYTANIE = [{ role: 'user' as const, content: 'Jak wystawić fakturę korygującą?' }];

  async function zapytaj() {
    const { streamSupportReply } = await import('@/lib/support/chat');
    const tekst: string[] = [];
    const praca = (async () => {
      for await (const kawalek of streamSupportReply(PYTANIE)) tekst.push(kawalek);
    })();
    const { wynik, ms } = await przesuwajZegar(praca);
    return { wynik, ms, tekst: tekst.join('') };
  }

  it('zawieszone połączenie: komunikat o błędzie po 2 próbach po 20 s, nie po 3 × 600 s', async () => {
    podstawTransport(zawieszone);

    const { wynik, ms } = await zapytaj();

    expect(ms, 'jak długo człowiek czeka na komunikat o błędzie').toBeLessThanOrEqual(41_000);
    expect(proby.map((p) => p.limitS)).toEqual(['20', '20']);
    expect(wynik, 'przerwał limit próby SDK, nie limit całej odpowiedzi').toMatchObject({
      ok: false,
      blad: expect.objectContaining({ message: expect.stringMatching(/timed out/i) }),
    });
    expect(vi.getTimerCount(), 'limit całej odpowiedzi skasowany po błędzie').toBe(0);
  });

  it('odpowiedź, która stanęła w połowie, kończy się błędem po 60 s od pytania', async () => {
    podstawTransport(strumien([[0, POCZATEK + fragment('Fakturę korygującą wystawisz')]], false));

    const { wynik, ms, tekst } = await zapytaj();

    expect(tekst).toBe('Fakturę korygującą wystawisz');
    expect(wynik, 'strumień, który stanął po nagłówkach, bez limitu wisi bez końca').toBeDefined();
    expect(ms).toBeLessThanOrEqual(60_000);
    expect(wynik).toMatchObject({
      ok: false,
      blad: expect.objectContaining({ message: expect.stringContaining('60 s') }),
    });
  });

  it('limit, który minie, gdy nikt nie czeka na fragment, też kończy się błędem, nie uciętą odpowiedzią', async () => {
    // SDK kończy swoją pętlę bez błędu, gdy przerwanie przyjdzie, a nikt akurat
    // nie czeka na następny fragment. Tu odbiorca po pierwszym fragmencie
    // wraca dopiero po 70 s, więc limit 60 s mija właśnie w takiej chwili.
    podstawTransport(strumien([[0, POCZATEK + fragment('Fakturę korygującą wystawisz')]], false));
    const { streamSupportReply } = await import('@/lib/support/chat');
    const tekst: string[] = [];
    const praca = (async () => {
      for await (const kawalek of streamSupportReply(PYTANIE)) {
        tekst.push(kawalek);
        await new Promise((dalej) => setTimeout(dalej, 70_000));
      }
    })();

    const { wynik } = await przesuwajZegar(praca);

    expect(tekst.join('')).toBe('Fakturę korygującą wystawisz');
    expect(wynik, 'ucięta odpowiedź nie może przejść jako cała').toMatchObject({
      ok: false,
      blad: expect.objectContaining({ message: expect.stringContaining('60 s') }),
    });
  });

  it('uczciwa odpowiedź w 30 s przychodzi w całości i nie zostawia zegara', async () => {
    podstawTransport(
      strumien(
        [
          [0, POCZATEK],
          [10_000, fragment('Fakturę korygującą ')],
          [20_000, fragment('wystawisz z listy faktur.')],
          [30_000, KONIEC],
        ],
        true,
      ),
    );

    const { wynik, ms, tekst } = await zapytaj();

    expect(wynik?.ok).toBe(true);
    expect(tekst).toBe('Fakturę korygującą wystawisz z listy faktur.');
    expect(ms).toBe(30_000);
    expect(proby).toHaveLength(1);
    expect(vi.getTimerCount(), 'limit całej odpowiedzi skasowany po końcu').toBe(0);
  });
});

describe('LIM-05: Flo (treść ma szablon w zapasie)', () => {
  it('zawieszone połączenie: szablon po 2 próbach po 20 s, nie po 3 × 600 s', async () => {
    podstawTransport(zawieszone);
    const { generateCopy } = await import('@/lib/flo/llm');
    const wartosci = {
      kontrahent: 'Nowak Sp. z o.o.',
      kwota: formatPlnPlain(4300),
      dni: formatDays(8),
      numer: '5/2026',
    };

    const { wynik, ms } = await przesuwajZegar(
      generateCopy(
        { kind: 'payment.chase', tenantId: 'ten-1', values: wartosci },
        new Date('2026-11-15T12:00:00.000Z'),
        createFakeDb().client,
      ),
    );

    expect(ms, 'jak długo powstaje karta, gdy dostawca nie odpowiada').toBeLessThanOrEqual(41_000);
    expect(proby.map((p) => p.limitS)).toEqual(['20', '20']);
    expect(wynik).toMatchObject({ ok: true, wartosc: { source: 'template', fallbackReason: 'error' } });
  });
});
