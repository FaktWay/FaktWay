import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * LIM-05, reszta z opisu #732 (plan skalowania 3000): limit czasu `ksefFetch`
 * obejmuje także treść odpowiedzi.
 *
 * Do tej zmiany `ksefFetch` kasował zegar zaraz po nagłówkach, więc
 * `response.text()` i `response.arrayBuffer()` czytały treść bez limitu.
 * KSeF, który wysłał nagłówki i stanął, trzymał job wysyłki, UPO albo
 * skrzynki tak długo, jak żyło gniazdo (w undici do 300 s ciszy, przy
 * kapiących bajtach bez końca), a potem kończył go błędem sieci zamiast 408.
 *
 * Po zmianie zawieszona treść daje po `timeoutMs` od wysłania żądania ten sam
 * błąd co brak nagłówków (`KsefApiError` 408). Przy POST to ważne: MF mógł już
 * przyjąć żądanie, więc wywołujący ma pójść dzisiejszą ścieżką 408 (wysyłka
 * pliku uzgadnia status po numerze sesji zamiast wysyłać drugi raz).
 *
 * Atrapa KSeF to globalny `fetch`, zegar sztuczny. Ostatni test idzie przez
 * prawdziwy `fetch` (undici) do serwera na pętli zwrotnej, z prawdziwym zegarem.
 */

const st = vi.hoisted(() => ({
  /** INSERT-y do `audit_logs` (atrapa klienta serwisowego, prawdziwy `logAuditSystem`). */
  auditRows: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        if (table === 'audit_logs') st.auditRows.push(row);
        return { error: null };
      },
    }),
  }),
}));

import {
  KsefApiError,
  KsefRateLimitPausedError,
  isKsefLocalPause,
  ksefFetch,
  type KsefRequestOptions,
} from '@/lib/ksef/client';
import { recordKsefRateLimit, runWithKsefNip } from '@/lib/ksef/rate-limit-pause';

const NIP = '1234567890';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
/** Domyślny limit `ksefFetch` (żadne wywołanie w `lib/` go nie zmienia). */
const LIMIT_MS = 30_000;
const encoder = new TextEncoder();

type Settled<T> = { done: boolean; value?: T; error?: unknown };

/** Stan obietnicy bez czekania na nią: zegar jest sztuczny, więc test sam go przesuwa. */
function track<T>(promise: Promise<T>): Settled<T> {
  const state: Settled<T> = { done: false };
  promise.then(
    (value) => {
      state.done = true;
      state.value = value;
    },
    (error: unknown) => {
      state.done = true;
      state.error = error;
    },
  );
  return state;
}

/** Wynik przychodzi dokładnie po `limitMs` od startu: wcześniej wywołanie jeszcze czeka. */
async function settlesAt<T>(limitMs: number, work: Promise<T>): Promise<Settled<T>> {
  const state = track(work);
  await vi.advanceTimersByTimeAsync(limitMs - 1);
  expect(state.done, 'przed limitem wywołanie jeszcze czeka').toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(state.done, 'po limicie wywołanie ma wynik (nie wisi)').toBe(true);
  return state;
}

/**
 * Treść, która nigdy się nie kończy: początek JSON-a i cisza. Źródło nie zna
 * sygnału (jak atrapa albo `fetch` opakowany przez bibliotekę), więc skończyć
 * ją może tylko `ksefFetch`. `cancelled` = źródło zamknięte, czyli gniazdo wolne.
 */
function endlessBody(first = '{"referenceNumber":"') {
  const source = { cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(first));
    },
    cancel() {
      source.cancelled = true;
    },
  });
  return { body, source };
}

/** KSeF oddaje nagłówki od razu, a treść staje (źródło ignoruje sygnał). */
function stubHeadersThenSilence(status: number, contentType = 'application/json') {
  const { body, source } = endlessBody();
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(body, { status, headers: { 'content-type': contentType } }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, source };
}

/** KSeF nie odpowiada wcale: `fetch` pada dopiero na sygnał, jak undici. */
function neverAnswers(_url: string, init?: RequestInit): Promise<Response> {
  const signal = init?.signal;
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** Odniesienie: dzisiejszy błąd przekroczenia czasu, gdy nie przyszły nawet nagłówki. */
async function headerTimeoutError(path: string, options: KsefRequestOptions): Promise<unknown> {
  vi.stubGlobal('fetch', vi.fn(neverAnswers));
  const state = await settlesAt(options.timeoutMs ?? LIMIT_MS, ksefFetch(path, options));
  return state.error;
}

/** Wszystko, po czym wywołujący rozpoznaje błąd: klasa, status, treść, komunikat, ponowienie. */
function shape(error: unknown) {
  expect(error).toBeInstanceOf(KsefApiError);
  const e = error as KsefApiError;
  return {
    klasa: e.constructor.name,
    name: e.name,
    status: e.status,
    body: e.body,
    message: e.message,
    retryAfterMs: e.retryAfterMs,
    isRetryable: e.isRetryable,
    isAuthError: e.isAuthError,
    ksefCode: e.ksefCode,
    lokalnaPauza: isKsefLocalPause(e),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-11-15T09:00:00.000Z'));
  vi.stubEnv('KSEF_ENV', 'test');
  st.auditRows = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('LIM-05: treść odpowiedzi KSeF w tym samym limicie co nagłówki', () => {
  it('POST: nagłówki od razu, treść nigdy się nie kończy → po 30 s ten sam 408 co bez nagłówków, jedno żądanie, gniazdo wolne', async () => {
    const options: KsefRequestOptions = { method: 'POST', body: { formCode: { value: 'FA' } }, env: 'test' };
    const { fetchMock, source } = stubHeadersThenSilence(201);

    const state = await settlesAt(LIMIT_MS, ksefFetch('/sessions/online', options));

    expect(shape(state.error)).toMatchObject({
      status: 408,
      body: 'Request timeout',
      message: `KSeF API POST /sessions/online timed out after ${LIMIT_MS}ms`,
      isRetryable: true,
      lokalnaPauza: false,
    });
    // MF mógł przyjąć żądanie: `ksefFetch` nie ponawia go sam z nową treścią.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(source.cancelled, 'źródło treści zamknięte (gniazdo wolne)').toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    expect(shape(state.error)).toEqual(shape(await headerTimeoutError('/sessions/online', options)));
  });

  it('pobranie pliku jako bajty: zawieszona treść → ten sam 408 po limicie', async () => {
    const options: KsefRequestOptions = { env: 'test', responseType: 'bytes' };
    const { source } = stubHeadersThenSilence(200, 'application/octet-stream');

    const state = await settlesAt(LIMIT_MS, ksefFetch('/invoices/ksef/K-1', options));

    expect(shape(state.error)).toMatchObject({
      status: 408,
      message: `KSeF API GET /invoices/ksef/K-1 timed out after ${LIMIT_MS}ms`,
    });
    expect(source.cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(shape(state.error)).toEqual(shape(await headerTimeoutError('/invoices/ksef/K-1', options)));
  });

  it('fetch, który sam przerywa treść na sygnał (jak undici) → 408 po limicie', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"referenceNumber":"'));
          signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      });
      return new Response(body, { status: 201, headers: { 'content-type': 'application/json' } });
    }));

    const state = await settlesAt(LIMIT_MS, ksefFetch('/sessions/online', { method: 'POST', env: 'test' }));

    expect(shape(state.error)).toMatchObject({
      status: 408,
      message: `KSeF API POST /sessions/online timed out after ${LIMIT_MS}ms`,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('limit liczy się od wysłania żądania: nagłówki po 20 s, potem cisza → 408 w 30. sekundzie', async () => {
    const { body } = endlessBody('{"invoices":[');
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((resolve, reject) => {
        const headers = setTimeout(
          () => resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })),
          20_000,
        );
        signal?.addEventListener('abort', () => {
          clearTimeout(headers);
          reject(signal.reason);
        }, { once: true });
      });
    }));

    const state = await settlesAt(LIMIT_MS, ksefFetch('/invoices/query/metadata', { method: 'POST', env: 'test' }));

    expect(shape(state.error)).toMatchObject({ status: 408 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('błąd spoza 2xx z zawieszoną treścią (503) → 408 po limicie zamiast wiszenia', async () => {
    const { source } = stubHeadersThenSilence(503);

    const state = await settlesAt(LIMIT_MS, ksefFetch('/sessions/online', { method: 'POST', env: 'test' }));

    expect(shape(state.error)).toMatchObject({ status: 408, isRetryable: true });
    expect(source.cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('429 z Retry-After i zawieszoną treścią → pauza firmy zapisana od razu po nagłówkach, potem 408', async () => {
    const nip = '1234567890';
    const env = 'production';
    const { body } = endlessBody('{"status":');
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(body, { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '120' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const call = () => runWithKsefNip(nip, () => ksefFetch('/sessions/online', { method: 'POST', env }));

    const state = await settlesAt(LIMIT_MS, call());
    expect(shape(state.error)).toMatchObject({ status: 408 });

    // Pauza trwa pełne 120 s od nagłówków: następne żądanie firmy nie idzie do KSeF.
    const paused = await call().catch((e: unknown) => e);
    expect(paused).toBeInstanceOf(KsefRateLimitPausedError);
    expect(shape(paused)).toMatchObject({ status: 429, lokalnaPauza: true, retryAfterMs: 90_000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treść zerwana przez sieć przed limitem → błąd sieci jak dotąd (nie 408), audyt ze statusem 0', async () => {
    const terminated = new TypeError('terminated');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"referenceNumber":'));
        setTimeout(() => controller.error(terminated), 5_000);
      },
    }), { status: 201, headers: { 'content-type': 'application/json' } })));
    const audit = { tenantId: TENANT, action: 'session.open' };

    const state = track(ksefFetch('/sessions/online', { method: 'POST', env: 'test', audit }));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(state.done).toBe(true);
    expect(state.error).toBe(terminated);
    expect(vi.getTimerCount()).toBe(0);
    await vi.waitFor(() => expect(st.auditRows).toHaveLength(1));
    expect(st.auditRows[0]).toMatchObject({
      metadata: expect.objectContaining({ httpStatus: 0, error: 'terminated', durationMs: 5_000 }),
    });
  });

  it('wolna, ale pełna treść w limicie → zwykły wynik, zegar posprzątany', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"referenceNumber":'));
        setTimeout(() => controller.enqueue(encoder.encode('"S-1"')), 10_000);
        setTimeout(() => {
          controller.enqueue(encoder.encode('}'));
          controller.close();
        }, 25_000);
      },
    }), { status: 201, headers: { 'content-type': 'application/json' } })));

    const state = track(ksefFetch('/sessions/online', { method: 'POST', env: 'test' }));
    await vi.advanceTimersByTimeAsync(25_000);

    expect(state.error).toBeUndefined();
    expect(state).toMatchObject({ done: true, value: { referenceNumber: 'S-1' } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('zawieszona treść z audytem → wiersz 408 „timeout” po 30 s, jak przy braku nagłówków', async () => {
    stubHeadersThenSilence(201);
    const audit = { tenantId: TENANT, action: 'session.open' };

    await settlesAt(LIMIT_MS, ksefFetch('/sessions/online', { method: 'POST', env: 'test', audit }));

    await vi.waitFor(() => expect(st.auditRows).toHaveLength(1));
    expect(st.auditRows[0]).toMatchObject({
      tenant_id: TENANT,
      action: 'ksef.session.open',
      metadata: expect.objectContaining({
        method: 'POST',
        path: '/sessions/online',
        httpStatus: 408,
        durationMs: LIMIT_MS,
        responseBytes: 0,
        error: 'timeout',
      }),
    });
  });
});

describe('zwykłe odpowiedzi działają jak dotąd', () => {
  function reply(body: BodyInit | null, status: number, headers: Record<string, string> = {}) {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(body, { status, headers }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('JSON 2xx → obiekt, zegar posprzątany', async () => {
    reply('{"referenceNumber":"S-1"}', 201, { 'content-type': 'application/json' });

    await expect(ksefFetch('/sessions/online', { method: 'POST', env: 'test' })).resolves.toEqual({ referenceNumber: 'S-1' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('204 bez treści → pusty tekst', async () => {
    reply(null, 204);

    await expect(ksefFetch('/sessions/online/S-1/close', { method: 'POST', env: 'test' })).resolves.toBe('');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('problem+json 400 → KsefApiError z kodem KSeF, bez ponowienia; 503 z tekstem → do ponowienia', async () => {
    const problem = { errors: [{ code: 21405, description: 'Błąd walidacji' }] };
    reply(JSON.stringify(problem), 400, { 'content-type': 'application/problem+json' });

    const rejected = await ksefFetch('/sessions/online', { method: 'POST', env: 'test' }).catch((e: unknown) => e);
    expect(shape(rejected)).toMatchObject({
      status: 400,
      body: problem,
      message: 'KSeF API POST /sessions/online failed: 400',
      ksefCode: 21405,
      isRetryable: false,
    });

    reply('Service Unavailable', 503, { 'content-type': 'text/plain' });
    const unavailable = await ksefFetch('/sessions/online', { method: 'POST', env: 'test' }).catch((e: unknown) => e);
    expect(shape(unavailable)).toMatchObject({ status: 503, body: 'Service Unavailable', isRetryable: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bajty z BOM → dokładnie te bajty; tekst XML → bez BOM, jak dotąd', async () => {
    const xml = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode('<Faktura>zażółć</Faktura>')]);
    reply(xml, 200, { 'content-type': 'application/octet-stream' });

    const bytes = await ksefFetch<Buffer>('/invoices/ksef/K-1', { env: 'test', responseType: 'bytes' });
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.equals(Buffer.from(xml))).toBe(true);

    reply(xml, 200, { 'content-type': 'application/xml' });
    await expect(ksefFetch('/sessions/S-1/upo', { env: 'test' })).resolves.toBe('<Faktura>zażółć</Faktura>');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('429 z Retry-After → retryAfterMs i pauza firmy; następne żądanie to lokalny 429 bez sieci', async () => {
    const fetchMock = reply('{}', 429, { 'content-type': 'application/json', 'retry-after': '45' });
    const call = () => runWithKsefNip(NIP, () => ksefFetch('/sessions/online', { method: 'POST', env: 'test' }))
      .catch((e: unknown) => e);

    expect(shape(await call())).toMatchObject({ status: 429, retryAfterMs: 45_000, isRetryable: true, lokalnaPauza: false });

    const paused = await call();
    expect(paused).toBeInstanceOf(KsefRateLimitPausedError);
    expect(shape(paused)).toMatchObject({ status: 429, lokalnaPauza: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lokalny 429 (firma w pauzie) → bez żądania do KSeF i bez zegara', async () => {
    const fetchMock = reply('{}', 200, { 'content-type': 'application/json' });
    await recordKsefRateLimit('test', NIP, 60_000);

    const error = await runWithKsefNip(NIP, () => ksefFetch('/invoices/query/metadata', { method: 'POST', env: 'test' }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KsefRateLimitPausedError);
    expect(shape(error)).toMatchObject({ status: 429, lokalnaPauza: true, retryAfterMs: 60_000 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('prawdziwy fetch (undici) i serwer na pętli zwrotnej', () => {
  let server: Server | null = null;

  afterEach(async () => {
    const running = server;
    server = null;
    if (!running) return;
    running.closeAllConnections();
    await new Promise<void>((resolve) => running.close(() => resolve()));
  });

  it('nagłówki i początek treści, potem cisza → 408 po limicie i zamknięte połączenie', async () => {
    vi.useRealTimers();
    const connection = { closed: false };
    const running = createServer((req, res) => {
      req.socket.on('close', () => {
        connection.closed = true;
      });
      res.writeHead(201, { 'content-type': 'application/json' });
      res.write('{"referenceNumber":"');
    });
    server = running;
    await new Promise<void>((resolve) => running.listen(0, '127.0.0.1', resolve));
    const { port } = running.address() as AddressInfo;
    vi.stubEnv('KSEF_TEST_URL', `http://127.0.0.1:${port}/v2`);

    const outcome = await Promise.race([
      ksefFetch('/sessions/online', { method: 'POST', body: {}, env: 'test', timeoutMs: 300 }).then(
        () => 'odpowiedź bez błędu',
        (error: unknown) => error,
      ),
      new Promise((resolve) => setTimeout(() => resolve('wisi po 3 s'), 3_000)),
    ]);

    expect(shape(outcome)).toMatchObject({ status: 408, message: 'KSeF API POST /sessions/online timed out after 300ms' });
    await vi.waitFor(() => expect(connection.closed, 'połączenie zamknięte, gniazdo wolne').toBe(true));
  });
});
