import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

/**
 * LIM-05, część UPO (plan skalowania 3000): limit czasu pobrania UPO obejmuje
 * także treść odpowiedzi.
 *
 * `downloadUpoFromKsef` kasował zegar zaraz po nagłówkach, a `response.text()`
 * czytało treść bez limitu, w gałęzi błędu (kody KSeF) i sukcesu (XML UPO).
 * KSeF, który wysłał nagłówki i stanął, trzymał job UPO tak długo, jak żyło
 * gniazdo: w undici do 300 s ciszy, przy kapiących bajtach bez końca.
 *
 * Po zmianie zawieszona treść daje po `timeoutMs` od wysłania żądania ten sam
 * wynik co brak nagłówków: `TIMEOUT` do ponowienia i jeden wiersz audytu 408
 * „timeout”. UPO to GET, więc ponowienie niczego w KSeF nie zmienia.
 *
 * Prawdziwa ścieżka: `runDownloadUpo` i prawdziwe `downloadUpoFromKsef`
 * (z prawdziwą kolejką firmy i pauzą po 429). Atrapy tylko dla HTTP (`fetch`,
 * sesja KSeF, magazyn plików) i bazy (klient admina, poświadczenia, dziennik
 * audytu), jak w `upo-blad-bez-tresci.test.ts`. Zegar sztuczny; ostatni test
 * idzie przez prawdziwy `fetch` (undici) do serwera na pętli zwrotnej,
 * z prawdziwym zegarem.
 */

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  credentials: vi.fn(),
  invalidate: vi.fn(),
  audit: vi.fn(),
  xml: vi.fn(),
  pdf: vi.fn(),
  /** Redis pauzy po 429: domyślnie wyłączony (pauza tylko w pamięci procesu). */
  redis: { configured: false, client: null as unknown },
}));

// Baza.
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: mocks.admin }));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: mocks.admin }));
vi.mock('@/lib/supabase/admin-queries', () => ({ getTenantKsefCredentials: mocks.credentials }));
vi.mock('@/lib/ksef/submission-log', () => ({
  findSessionReferenceForKsefNumber: vi.fn(async () => SESSION_REF),
}));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: mocks.audit }));
// HTTP: sesja KSeF (uwierzytelnienie w MF) i magazyn plików.
vi.mock('@/lib/ksef/session-cache', () => ({
  ksefSessionCache: { getSession: async () => ({ accessToken: 'token-testowy' }), invalidate: mocks.invalidate },
}));
vi.mock('@/lib/ksef/upo-storage', () => ({ uploadUpoXml: mocks.xml, uploadUpoPdf: mocks.pdf }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), addBreadcrumb: vi.fn() }));
// Redis pauzy (prawdziwy moduł pauzy niżej, tylko magazyn atrapą).
vi.mock('@/lib/cache/redis', () => ({
  isRedisConfigured: () => mocks.redis.configured,
  getRedis: () => mocks.redis.client,
}));

import { NonRetriableError, RetryAfterError } from '@/lib/jobs/errors';
import { runDownloadUpo } from '@/lib/jobs/runners/download-upo';
import { downloadUpoFromKsef, type UpoDownloadResponse } from '@/lib/ksef/upo-client';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INVOICE = '11111111-1111-4111-8111-111111111111';
const RECEIPT = '33333333-3333-4333-8333-333333333333';
const KSEF_NUMBER = '1234567890-20261001-0100A0B0C0D0-1A';
const SESSION_REF = '20261001-SO-0000000000-0000000000-01';
const NIP = '1234567890';
/** Domyślny limit `downloadUpoFromKsef` (runner go nie zmienia). */
const LIMIT_MS = 30_000;
const encoder = new TextEncoder();

const event = {
  invoiceId: INVOICE,
  tenantId: TENANT,
  ksefNumber: KSEF_NUMBER,
  nip: NIP,
  sessionReferenceNumber: SESSION_REF,
  environment: 'test' as const,
};

let tables: Record<string, Row[]>;

/** Minimalny klient PostgREST w pamięci: tylko to, czego używa runner UPO. */
function client() {
  return {
    from(table: string) {
      let operation: 'select' | 'insert' | 'update' = 'select';
      let patch: Row = {};
      let one = false;
      const predicates: Array<(r: Row) => boolean> = [];
      const execute = () => {
        let rows = (tables[table] ?? []).filter((r) => predicates.every((check) => check(r)));
        if (operation === 'insert') {
          const inserted = { id: RECEIPT, download_attempts: 0, last_error: null, ...patch };
          (tables[table] ??= []).push(inserted);
          rows = [inserted];
        }
        if (operation === 'update') rows.forEach((r) => Object.assign(r, patch));
        const result = rows.map((r) => ({ ...r }));
        return { data: one ? (result[0] ?? null) : result, error: null };
      };
      const builder = {
        select: () => builder,
        insert: (value: Row) => { operation = 'insert'; patch = value; return builder; },
        update: (value: Row) => { operation = 'update'; patch = value; return builder; },
        eq: (key: string, value: unknown) => { predicates.push((r) => r[key] === value); return builder; },
        in: (key: string, values: unknown[]) => { predicates.push((r) => values.includes(r[key])); return builder; },
        single: () => { one = true; return Promise.resolve(execute()); },
        maybeSingle: () => { one = true; return Promise.resolve(execute()); },
      };
      return builder;
    },
  };
}

const context: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_name, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

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
 * Treść, która nigdy się nie kończy: początek dokumentu i cisza. Źródło nie zna
 * sygnału (jak atrapa albo `fetch` opakowany przez bibliotekę), więc skończyć
 * ją może tylko klient UPO. `cancelled` = źródło zamknięte, czyli gniazdo wolne.
 */
function endlessBody(first: string) {
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
function stubHeadersThenSilence(status: number, first: string, headers: Record<string, string> = {}) {
  const { body, source } = endlessBody(first);
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(body, { status, headers }));
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

/** Pobranie UPO tak, jak woła je runner: numer faktury do audytu i numer sesji. */
function download(timeoutMs?: number): Promise<UpoDownloadResponse> {
  return downloadUpoFromKsef(TENANT, KSEF_NUMBER, {
    env: 'test',
    invoiceId: INVOICE,
    sessionReferenceNumber: SESSION_REF,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

/** Wiersze dziennika `ksef.upo.download` (atrapa `logAuditSystem`). */
function auditRows(): Row[] {
  return mocks.audit.mock.calls.map(([entry]) => entry as Row);
}

/**
 * Czeka prawdziwą pętlą zdarzeń, bez ruszania sztucznego zegara, aż `ready()`
 * (najwyżej 5 s). `vi.waitFor` przy sztucznym zegarze przesuwa go o 50 ms na
 * każde sprawdzenie, a to zmienia `durationMs` w audycie i pozostały czas pauzy.
 * Skrót SHA-256 UPO liczy się w puli wątków, więc też potrzebuje tej pętli.
 */
async function realTurnsUntil(ready: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!ready() && performance.now() < deadline) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Wiersze audytu po zapisie w tle (import modułu i zapis bez czekania), także spóźniony kolejny wiersz. */
async function auditAfter(expected: number): Promise<Row[]> {
  await realTurnsUntil(() => mocks.audit.mock.calls.length >= expected);
  for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  return auditRows();
}

/** Wiersz audytu jednej próby pobrania UPO. */
function auditRow(metadata: Row): Row {
  return {
    action: 'ksef.upo.download',
    tenantId: TENANT,
    userId: null,
    entityType: 'invoice',
    entityId: INVOICE,
    metadata: { ksefNumber: KSEF_NUMBER, ...metadata },
  };
}

/** Odniesienie: dzisiejszy wynik i audyt, gdy KSeF nie odda nawet nagłówków. */
async function headerTimeout(): Promise<{ result: UpoDownloadResponse | undefined; audit: Row[] }> {
  mocks.audit.mockClear();
  vi.stubGlobal('fetch', vi.fn(neverAnswers));
  const state = await settlesAt(LIMIT_MS, download());
  return { result: state.value, audit: await auditAfter(1) };
}

function receipt(): Row {
  const row = tables.upo_receipts.find((r) => r.invoice_id === INVOICE);
  if (!row) throw new Error('brak rekordu UPO');
  return row;
}

/**
 * Zegar tylko do przodu, w przeszłości względem prawdziwego. Prawdziwa kolejka
 * firmy (p-queue, jedna na NIP w procesie) pamięta koniec okna z poprzedniego
 * testu: ten sam start w każdym teście nie zerowałby jej licznika okna, a
 * prawdziwy zegar ostatniego testu musi być już po wszystkich oknach.
 */
let clock = Date.parse('2026-01-05T09:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  clock += 3_600_000;
  vi.setSystemTime(clock);
  vi.stubEnv('KSEF_ENV', 'test');
  mocks.redis.configured = false;
  mocks.redis.client = null;
  tables = {
    invoices: [{
      id: INVOICE, tenant_id: TENANT, ksef_number: KSEF_NUMBER, ksef_status: 'accepted', ksef_environment: 'test',
      internal_number: 'FV 1/2026', issue_date: '2026-10-01', gross_total: 123, buyer_data: { name: 'Nabywca' },
      buyer_nip: NIP, seller_nip: NIP, tenants: { id: TENANT, name: 'Sprzedawca', nip: NIP },
    }],
    upo_receipts: [],
  };
  mocks.admin.mockImplementation(client);
  mocks.credentials.mockResolvedValue({ type: 'token', nip: NIP, token: 'token-ksef' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('LIM-05 UPO: treść odpowiedzi w tym samym limicie co nagłówki', () => {
  it('200, nagłówki od razu, XML nigdy się nie kończy → po 30 s ten sam TIMEOUT i audyt co bez nagłówków, gniazdo wolne', async () => {
    const { fetchMock, source } = stubHeadersThenSilence(200, '<Potwierdzenie><NumerUPO>', {
      'content-type': 'application/xml',
    });

    const state = await settlesAt(LIMIT_MS, download());

    expect(state.error).toBeUndefined();
    expect(state.value).toMatchObject({ success: false, errorCode: 'TIMEOUT', retryable: true });
    // GET bez ponowień w kliencie: następną próbę robi runner (pg-boss).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(source.cancelled, 'źródło treści zamknięte (gniazdo wolne)').toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const audit = await auditAfter(1);
    expect(audit).toEqual([auditRow({ httpStatus: 408, durationMs: LIMIT_MS, error: 'timeout' })]);
    const hung = { result: state.value, audit };

    expect(hung).toEqual(await headerTimeout());
  });

  it('fetch, który sam przerywa treść na sygnał (jak undici) → TIMEOUT po limicie', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('<Potwierdzenie>'));
          signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } });
    }));

    const state = await settlesAt(LIMIT_MS, download());

    expect(state.value).toMatchObject({ success: false, errorCode: 'TIMEOUT', retryable: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('limit liczy się od wysłania żądania: nagłówki po 20 s, potem cisza → TIMEOUT w 30. sekundzie', async () => {
    const { body } = endlessBody('<Potwierdzenie>');
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((resolve, reject) => {
        const headers = setTimeout(
          () => resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } })),
          20_000,
        );
        signal?.addEventListener('abort', () => {
          clearTimeout(headers);
          reject(signal.reason);
        }, { once: true });
      });
    }));

    const state = await settlesAt(LIMIT_MS, download());

    expect(state.value).toMatchObject({ success: false, errorCode: 'TIMEOUT', retryable: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('503 z zawieszoną treścią (czytaną po kody KSeF) → TIMEOUT po limicie, jeden wiersz audytu 408', async () => {
    const { source } = stubHeadersThenSilence(503, '{"errors":[{"code":', {
      'content-type': 'application/problem+json',
    });

    const state = await settlesAt(LIMIT_MS, download());

    expect(state.value).toMatchObject({ success: false, errorCode: 'TIMEOUT', retryable: true });
    expect(source.cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(await auditAfter(1)).toEqual([auditRow({ httpStatus: 408, durationMs: LIMIT_MS, error: 'timeout' })]);
  });

  it('429 z Retry-After i zawieszoną treścią → pauza firmy zapisana od razu po nagłówkach, potem TIMEOUT; następna próba bez żądania', async () => {
    const { fetchMock } = stubHeadersThenSilence(429, '{"status":', {
      'content-type': 'application/json',
      'retry-after': '120',
    });

    const state = await settlesAt(LIMIT_MS, download());
    expect(state.value).toMatchObject({ success: false, errorCode: 'TIMEOUT', retryable: true });

    // Pauza trwa pełne 120 s od nagłówków: następna próba firmy nie idzie do KSeF.
    await expect(download()).resolves.toMatchObject({
      success: false,
      errorCode: 'KSEF_RATE_LIMIT_PAUSE',
      retryable: true,
      retryAfterMs: 90_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('429 tuż przed limitem, zapis pauzy w Redisie czeka swój 1 s → dalej HTTP_429 jak dotąd, nie TIMEOUT', async () => {
    // Zapis pauzy w Redisie nie trzyma odczytu treści: limit żądania mija
    // w trakcie zapisu, a pełna treść 429 przyszła razem z nagłówkami.
    mocks.redis.configured = true;
    mocks.redis.client = {
      get: vi.fn(async () => null),
      set: vi.fn(() => new Promise(() => {})),
      zadd: vi.fn(async () => 1),
      zremrangebyscore: vi.fn(async () => 0),
      pexpire: vi.fn(async () => 1),
    };
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((resolve, reject) => {
        const headers = setTimeout(() => resolve(new Response('{"errors":[{"code":21405}]}', {
          status: 429,
          headers: { 'content-type': 'application/problem+json', 'retry-after': '45' },
        })), LIMIT_MS - 500);
        signal?.addEventListener('abort', () => {
          clearTimeout(headers);
          reject(signal.reason);
        }, { once: true });
      });
    }));

    // Wynik po zapisie pauzy (nagłówki + 1 s limitu zapisu w Redisie).
    const state = await settlesAt(LIMIT_MS + 500, download());

    expect(state.value).toEqual({
      success: false,
      error: 'KSeF zwrócił HTTP 429 kody:21405',
      errorCode: 'HTTP_429',
      retryable: false,
    });
    expect(vi.getTimerCount()).toBe(0);
    // Czas w audycie liczy się dopiero po imporcie modułu dziennika, a zegar
    // biegł w tym czasie do końca zapisu pauzy: sprawdzamy tylko wiersz.
    expect(await auditAfter(1)).toEqual([
      auditRow({ httpStatus: 429, durationMs: expect.any(Number), error: 'HTTP 429' }),
    ]);
  });

  it('runner: zawieszona treść → po 30 s `failed`, jedna próba w `download_attempts`, błąd do ponowienia', async () => {
    stubHeadersThenSilence(200, '<Potwierdzenie><NumerUPO>', { 'content-type': 'application/xml' });

    const state = await settlesAt(LIMIT_MS, runDownloadUpo(event, context));

    expect(state.error).toBeInstanceOf(Error);
    expect(state.error).not.toBeInstanceOf(NonRetriableError);
    const message = (state.error as Error).message;
    expect(message).toContain(`przekroczono limit czasu żądania (${LIMIT_MS} ms)`);
    expect(receipt()).toMatchObject({ status: 'failed', download_attempts: 1, last_error: message });
    expect(mocks.xml).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runner, ponowienie od zera po 429 z zawieszoną treścią: druga próba czeka na pauzę firmy, bez żądania do KSeF i bez kolejnej próby', async () => {
    const { fetchMock } = stubHeadersThenSilence(429, '{"status":', {
      'content-type': 'application/json',
      'retry-after': '120',
    });

    const first = await settlesAt(LIMIT_MS, runDownloadUpo(event, context));
    expect(first.error).toBeInstanceOf(Error);
    expect(first.error).not.toBeInstanceOf(NonRetriableError);
    expect(receipt()).toMatchObject({ status: 'failed', download_attempts: 1 });

    // Ponowienie pg-boss wykonuje cały handler od nowa; pauza (120 s od
    // nagłówków) jeszcze trwa, więc bramka runnera zatrzymuje próbę przed
    // zapisem i przed żądaniem.
    const second = track(runDownloadUpo(event, context));
    await realTurnsUntil(() => second.done);

    expect(second.error).toBeInstanceOf(RetryAfterError);
    expect(second.error).toMatchObject({ pause: true, countsAsAttempt: false });
    expect((second.error as Error).message).toContain('KSEF_RATE_LIMIT_PAUSE');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(receipt()).toMatchObject({ status: 'failed', download_attempts: 1 });
    expect(mocks.xml).not.toHaveBeenCalled();
  });

  it('treść zerwana przez sieć przed limitem → błąd sieci jak dotąd (nie TIMEOUT), audyt ze statusem 0', async () => {
    const terminated = new TypeError('terminated');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('<Potwierdzenie>'));
        setTimeout(() => controller.error(terminated), 5_000);
      },
    }), { status: 200, headers: { 'content-type': 'application/xml' } })));

    const state = track(download());
    await vi.advanceTimersByTimeAsync(5_000);

    expect(state.done).toBe(true);
    expect(state.value).toEqual({ success: false, error: 'Błąd pobierania UPO: terminated', retryable: true });
    expect(vi.getTimerCount()).toBe(0);
    expect(await auditAfter(1)).toEqual([auditRow({ httpStatus: 0, durationMs: 5_000, error: 'terminated' })]);
  });

  it('wolny, ale pełny XML w limicie → zwykły wynik, zegar posprzątany', async () => {
    const xml = '<Potwierdzenie><NumerUPO>UPO-1</NumerUPO><DataPrzyjeciaWKsef>2026-01-05T10:00:00Z</DataPrzyjeciaWKsef></Potwierdzenie>';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(xml.slice(0, 20)));
        setTimeout(() => controller.enqueue(encoder.encode(xml.slice(20, 60))), 10_000);
        setTimeout(() => {
          controller.enqueue(encoder.encode(xml.slice(60)));
          controller.close();
        }, 25_000);
      },
    }), { status: 200, headers: { 'content-type': 'application/xml' } })));

    const state = track(download());
    await vi.advanceTimersByTimeAsync(25_000);
    await realTurnsUntil(() => state.done);

    expect(state.done).toBe(true);
    expect(state.value).toMatchObject({ success: true, upoXml: xml, upoId: 'UPO-1' });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('zwykłe odpowiedzi działają jak dotąd', () => {
  function reply(body: BodyInit | null, status: number, headers: Record<string, string> = {}) {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(body, { status, headers }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('200 z XML (BOM, polskie znaki) → ten sam tekst bez BOM, skrót SHA-256, numer UPO i data przyjęcia', async () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?><Potwierdzenie><NumerUPO>UPO-1</NumerUPO>'
      + '<DataPrzyjeciaWKsef>2026-01-05T10:00:00Z</DataPrzyjeciaWKsef><Nazwa>zażółć gęślą jaźń</Nazwa></Potwierdzenie>';
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode(xml)]);
    const fetchMock = reply(bytes, 200, { 'content-type': 'application/xml' });

    await expect(download()).resolves.toEqual({
      success: true,
      upoXml: xml,
      upoXmlHash: createHash('sha256').update(xml, 'utf8').digest('hex'),
      upoId: 'UPO-1',
      acceptanceTimestamp: '2026-01-05T10:00:00Z',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(vi.getTimerCount()).toBe(0);
    expect(await auditAfter(1)).toEqual([auditRow({ httpStatus: 200, durationMs: 0 })]);
  });

  it('404 → UPO jeszcze niegotowe, do ponowienia', async () => {
    reply('{}', 404, { 'content-type': 'application/json' });

    await expect(download()).resolves.toEqual({
      success: false,
      error: 'UPO nie zostało jeszcze wygenerowane przez KSeF',
      errorCode: 'UPO_NOT_READY',
      retryable: true,
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(await auditAfter(1)).toEqual([auditRow({ httpStatus: 404, durationMs: 0, error: 'HTTP 404' })]);
  });

  it('401 → sesja wygasła, sesja firmy unieważniona, do ponowienia', async () => {
    reply('{}', 401, { 'content-type': 'application/json' });

    await expect(download()).resolves.toEqual({
      success: false,
      error: 'Sesja KSeF wygasła',
      errorCode: 'SESSION_EXPIRED',
      retryable: true,
    });
    expect(mocks.invalidate).toHaveBeenCalledWith(NIP, 'test');
    expect(vi.getTimerCount()).toBe(0);
    expect(await auditAfter(1)).toEqual([auditRow({ httpStatus: 401, durationMs: 0, error: 'HTTP 401' })]);
  });

  it('429 z Retry-After → HTTP_429 jak dotąd i pauza firmy: następna próba bez żądania do KSeF', async () => {
    const fetchMock = reply('{"errors":[{"code":21405}]}', 429, {
      'content-type': 'application/problem+json',
      'retry-after': '45',
    });

    await expect(download()).resolves.toEqual({
      success: false,
      error: 'KSeF zwrócił HTTP 429 kody:21405',
      errorCode: 'HTTP_429',
      retryable: false,
    });
    expect(await auditAfter(1)).toEqual([auditRow({ httpStatus: 429, durationMs: 0, error: 'HTTP 429' })]);

    await expect(download()).resolves.toMatchObject({
      success: false,
      errorCode: 'KSEF_RATE_LIMIT_PAUSE',
      retryable: true,
      retryAfterMs: 45_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { status: 503, retryable: true },
    { status: 500, retryable: true },
    { status: 400, retryable: false },
  ])('$status z kodami KSeF → status i kody, retryable=$retryable', async ({ status, retryable }) => {
    reply('{"errors":[{"code":21405,"description":"Jan Kowalski"}]}', status, {
      'content-type': 'application/problem+json',
    });

    await expect(download()).resolves.toEqual({
      success: false,
      error: `KSeF zwrócił HTTP ${status} kody:21405`,
      errorCode: `HTTP_${status}`,
      retryable,
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(await auditAfter(1)).toEqual([auditRow({ httpStatus: status, durationMs: 0, error: `HTTP ${status}` })]);
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

  it('nagłówki i początek XML, potem cisza → TIMEOUT po limicie i zamknięte połączenie', async () => {
    vi.useRealTimers();
    const connection = { closed: false };
    const running = createServer((req, res) => {
      req.socket.on('close', () => {
        connection.closed = true;
      });
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.write('<Potwierdzenie><NumerUPO>');
    });
    server = running;
    await new Promise<void>((resolve) => running.listen(0, '127.0.0.1', resolve));
    const { port } = running.address() as AddressInfo;
    vi.stubEnv('KSEF_TEST_URL', `http://127.0.0.1:${port}/v2`);

    const outcome = await Promise.race([
      download(300),
      new Promise((resolve) => setTimeout(() => resolve('wisi po 3 s'), 3_000)),
    ]);

    expect(outcome).toMatchObject({ success: false, errorCode: 'TIMEOUT', retryable: true });
    await vi.waitFor(() => expect(connection.closed, 'połączenie zamknięte, gniazdo wolne').toBe(true));
  });
});
