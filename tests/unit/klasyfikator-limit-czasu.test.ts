import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import type { ExtractedInvoice } from '@/lib/ocr/schema';

/**
 * LIM-05 (plan skalowania 3000, PR #782, „Ryzyka, które zostają”, punkt 6):
 * limity czasu klasyfikatora kosztów.
 *
 * `classifyByAI` wołał model bez własnych opcji, więc brał limity klienta:
 * domyślne SDK (600 s na próbę i 2 ponowienia, przy połączeniu, które stanęło,
 * ok. 30 min) albo limity klienta z #782 (120 s na próbę i 1 ponowienie,
 * ok. 4 min). Kategoryzacja woła model w jobie OCR (po
 * odczycie zdjęcia) i w jobie skrzynki, a worker przerabia paczkę zadań po
 * kolei (`lib/jobs/run-job.ts`), więc zawieszona kategoryzacja trzymała resztę
 * paczki i kolejkę. Po porażce koszt i tak dostaje kolumnę 13 do ręcznej
 * poprawki (`categorizeExpense`), więc długie czekanie nic nie daje.
 *
 * Teraz próba ma wspólne limity wywołań z gotowym zapasem
 * (`ANTHROPIC_REQUEST_LIMITS`: 20 s i 1 ponowienie), a całe wywołanie własny
 * sufit 45 s. Sufit łapie to, czego limit próby w SDK nie obejmuje: przerwę
 * przed ponowieniem z nagłówka `retry-after` i odczyt treści po nagłówkach.
 * Liczby 20 s i 45 s są tu wpisane na sztywno celowo: zmiana wspólnych
 * limitów ma zaczerwienić ten test, bo przesuwa rachunek sufitu.
 *
 * Ścieżka prawdziwa: `categorizeExpense` → `classifyByAI` → SDK. Atrapy tylko
 * dla bazy (reguły kategorii bez wierszy, budżet AI firmy) i dla transportu.
 * Transport jak w teście limitów klienta z #782
 * (`tests/unit/anthropic-limit-czasu.test.ts`): `fetch`
 * podstawiony, zanim klient powstanie (SDK bierze globalny `fetch`
 * w konstruktorze, a `getAnthropic()` trzyma klienta w module, stąd
 * `vi.resetModules()`). Zawieszona atrapa nie odpowiada nigdy, a błąd oddaje
 * dopiero po przerwaniu sygnałem, jak połączenie, które stanęło. Zegar jest
 * udawany: test przesuwa czas od timera do timera i mierzy, po ilu udawanych
 * milisekundach przyszedł wynik.
 */

const budzet = vi.hoisted(() => ({ sprawdz: vi.fn(), zapisz: vi.fn() }));

vi.mock('@/lib/ai/tenant-ai-budget', () => ({
  checkTenantAiBudget: budzet.sprawdz,
  recordTenantAiUsage: budzet.zapisz,
}));

// Reguły firmy i reguły globalne bez wierszy: koszt przechodzi przez NIP,
// nazwę i słowa kluczowe bez trafienia i dochodzi do warstwy modelu.
vi.mock('@/lib/supabase/admin', () => {
  const zapytanie: Record<string, unknown> = {};
  for (const metoda of ['select', 'eq', 'gt', 'not', 'order', 'limit']) {
    zapytanie[metoda] = () => zapytanie;
  }
  zapytanie.maybeSingle = async () => ({ data: null, error: null });
  zapytanie.then = (ok: (v: unknown) => unknown, blad?: (e: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null }).then(ok, blad);
  return { createAdminClient: () => ({ from: () => zapytanie }) };
});

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
let logBledow: MockInstance<typeof console.error>;

beforeEach(() => {
  proby.length = 0;
  budzet.sprawdz.mockReset();
  budzet.sprawdz.mockResolvedValue({ allowed: true });
  budzet.zapisz.mockReset();
  budzet.zapisz.mockResolvedValue(undefined);
  logBledow = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-atrapa');
});

afterEach(() => {
  vi.doUnmock('@/lib/anthropic/client');
  logBledow.mockRestore();
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

/** Uczciwa, powolna odpowiedź bez strumienia: cała wiadomość po `ms`. */
function wiadomoscPo(ms: number, tekst: string): Transport {
  return (init) =>
    new Promise<Response>((resolve, reject) => {
      const zegar = setTimeout(
        () =>
          resolve(
            new Response(
              JSON.stringify({
                id: 'msg_atrapa',
                type: 'message',
                role: 'assistant',
                model: 'claude-sonnet-4-6',
                content: [{ type: 'text', text: tekst }],
                stop_reason: 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: 620, output_tokens: 48 },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          ),
        ms,
      );
      poPrzerwaniu(init, (powod) => {
        clearTimeout(zegar);
        reject(powod);
      });
    });
}

/** Odpowiedź 429: SDK ponawia dopiero po przerwie z nagłówka `retry-after` (w sekundach). */
function limitZapytan(retryAfterS: number): Transport {
  return async () =>
    new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Atrapa limitu zapytań' } }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': String(retryAfterS) },
    });
}

/** Nagłówki przychodzą od razu, a treść nie: odczyt stoi, aż ktoś przerwie połączenie. */
const trescStoi: Transport = async (init) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(kontroler) {
        poPrzerwaniu(init, (powod) => kontroler.error(powod));
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

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

/**
 * Koszt, którego nie łapie żadna reguła ani heurystyka, więc trafia do modelu.
 * NIP fikcyjny.
 */
const KOSZT: ExtractedInvoice = {
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

/** Kategoria domyślna po porażce modelu: kolumna 13 do ręcznej poprawki. */
const KOLUMNA_13 = { kpir_column: 'col_13', category_label: 'Pozostałe wydatki', confidence: 0.3, method: 'manual' };

describe('LIM-05: kategoryzacja kosztu w jobie OCR i skrzynki', () => {
  it('zawieszone połączenie: kolumna 13 do poprawki po 2 próbach po 20 s, nie po minutach', async () => {
    podstawTransport(zawieszone);
    const { categorizeExpense } = await import('@/lib/categorization');

    const { wynik, ms } = await przesuwajZegar(categorizeExpense('ten-1', KOSZT));

    expect.soft(ms, 'jak długo zawieszona kategoryzacja trzyma zadanie i kolejkę').toBeLessThanOrEqual(41_000);
    expect.soft(proby).toEqual([
      { limitS: '20', ponowienie: '0' },
      { limitS: '20', ponowienie: '1' },
    ]);
    expect(wynik, 'porażka modelu daje kategorię domyślną, nie błąd joba').toEqual({ ok: true, wartosc: KOLUMNA_13 });
    expect(logBledow, 'limit próby, a nie sufit').toHaveBeenCalledWith('AI categorization failed:', expect.anything());
    expect(budzet.sprawdz).toHaveBeenCalledWith('ten-1', 'classify');
    expect(budzet.zapisz, 'bez odpowiedzi nie ma zużycia do zapisania').not.toHaveBeenCalled();
  });

  it('429 z retry-after 600 s: sufit 45 s przerywa przerwę przed ponowieniem', async () => {
    let proba = 0;
    podstawTransport((init) => (proba++ === 0 ? limitZapytan(600)(init) : zawieszone(init)));
    const { categorizeExpense } = await import('@/lib/categorization');

    const { wynik, ms } = await przesuwajZegar(categorizeExpense('ten-1', KOSZT));

    expect.soft(ms, 'bez sufitu: 600 s przerwy z nagłówka i 20 s zawieszonego ponowienia').toBe(45_000);
    expect.soft(proby, 'ponowienie nie rusza po przerwaniu').toEqual([{ limitS: '20', ponowienie: '0' }]);
    expect(wynik).toEqual({ ok: true, wartosc: KOLUMNA_13 });
    expect(logBledow).toHaveBeenCalledWith('AI categorization failed: deadline 45 s', expect.anything());
    expect(budzet.zapisz).not.toHaveBeenCalled();
  });

  it('nagłówki przyszły, treść stanęła: sufit 45 s przerywa odczyt, którego limit próby nie obejmuje', async () => {
    podstawTransport(trescStoi);
    const { categorizeExpense } = await import('@/lib/categorization');

    const { wynik, ms } = await przesuwajZegar(categorizeExpense('ten-1', KOSZT));

    expect(wynik, 'bez sufitu SDK nie przerywa odczytu treści, a atrapa wisi bez końca').toEqual({
      ok: true,
      wartosc: KOLUMNA_13,
    });
    expect(ms).toBe(45_000);
    expect(proby).toEqual([{ limitS: '20', ponowienie: '0' }]);
    expect(logBledow).toHaveBeenCalledWith('AI categorization failed: deadline 45 s', expect.anything());
  });

  it('uczciwa, powolna klasyfikacja (14,4 s, dwa szacunki SDK dla max_tokens 256) przechodzi za pierwszym razem', async () => {
    podstawTransport(
      wiadomoscPo(
        14_400,
        JSON.stringify({ kpir_column: 'col_10', category_label: 'Towary handlowe', reasoning: 'Zakup do odsprzedaży.' }),
      ),
    );
    const { categorizeExpense } = await import('@/lib/categorization');

    const { wynik, ms } = await przesuwajZegar(categorizeExpense('ten-1', KOSZT));

    expect(wynik).toEqual({
      ok: true,
      wartosc: { kpir_column: 'col_10', category_label: 'Towary handlowe', confidence: 0.7, method: 'ai_claude' },
    });
    expect(ms).toBe(14_400);
    expect(proby).toHaveLength(1);
    expect(budzet.zapisz).toHaveBeenCalledWith('ten-1', { inputTokens: 620, outputTokens: 48 });
    expect(vi.getTimerCount(), 'sufit sprzątnięty po odpowiedzi').toBe(0);
  });

  it('limit próby i ponowienia bierze ze wspólnych limitów klienta (`ANTHROPIC_REQUEST_LIMITS`)', async () => {
    // Inne liczby niż w kliencie, żeby było widać, skąd klasyfikator je bierze.
    // Własna kopia stałych w klasyfikatorze dałaby 2 próby po 20 s.
    vi.doMock('@/lib/anthropic/client', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/lib/anthropic/client')>()),
      ANTHROPIC_REQUEST_LIMITS: { timeout: 7_000, maxRetries: 0 },
    }));
    podstawTransport(zawieszone);
    const { categorizeExpense } = await import('@/lib/categorization');

    const { wynik, ms } = await przesuwajZegar(categorizeExpense('ten-1', KOSZT));

    expect.soft(proby, 'jedna próba z limitem ze wspólnej stałej').toEqual([{ limitS: '7', ponowienie: '0' }]);
    expect.soft(ms).toBe(7_000);
    expect(wynik).toEqual({ ok: true, wartosc: KOLUMNA_13 });
    expect(logBledow, 'limit próby, a nie sufit').toHaveBeenCalledWith('AI categorization failed:', expect.anything());
  });
});
