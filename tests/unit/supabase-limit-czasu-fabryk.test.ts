import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MobileCaller } from '@/lib/api/mobile/auth';

/**
 * LIM-05, ustalenie z #732 (plan skalowania 3000): fabryki klientów Supabase
 * poza `lib/supabase/` też dostają limit czasu z `createSupabaseFetch()`.
 * Bez niego zawieszony GoTrue albo PostgREST trzymał żądanie `/api/v1`,
 * `/api/mcp`, `/api/mobile/v1`, sprawdzenie hasła, trasę k6 i skrypty do
 * 300 s (domyślny limit undici).
 *
 * Prawdziwe `@supabase/supabase-js` i `@supabase/ssr`, prawdziwe fabryki
 * i ścieżki klienta. Atrapy tylko dla HTTP, limitów prób, audytu, Sentry
 * i przerwy technicznej. Serwer bez odpowiedzi w kolejce milczy jak undici:
 * kończy go tylko przerwanie sygnałem.
 *
 * Każdy test sprawdza dwie rzeczy: wynik przychodzi dokładnie po limicie
 * (nie wcześniej) i co wtedy widzi klient. Sprawdzenie hasła i logowanie
 * po limicie mówią „spróbuj za chwilę”, nigdy „złe hasło”.
 */

const fake = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  setCookie: vi.fn(),
  maintenance: vi.fn(),
  rateLimit: vi.fn(),
  passwordLimit: vi.fn(),
  mobileLoginLimit: vi.fn(),
  logAudit: vi.fn(),
  logAuditWithResult: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  scheduleDeletion: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    getAll: () => [...fake.cookies].map(([name, value]) => ({ name, value })),
    get: (name: string) => (fake.cookies.has(name) ? { name, value: fake.cookies.get(name)! } : undefined),
    set: fake.setCookie,
  }),
  headers: async () => new Headers(),
}));
vi.mock('@sentry/nextjs', () => ({ captureMessage: fake.captureMessage, captureException: fake.captureException }));
vi.mock('@/lib/feature-flags/maintenance', () => ({
  isMaintenanceMode: fake.maintenance,
  MAINTENANCE_PATH: '/przerwa-techniczna',
}));
vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: fake.rateLimit,
}));
vi.mock('@/lib/rate-limit/password', () => ({ checkPasswordOperationRateLimit: fake.passwordLimit }));
vi.mock('@/lib/rate-limit/auth', () => ({ checkMobileLoginRateLimits: fake.mobileLoginLimit }));
vi.mock('@/lib/cache/redis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cache/redis')>()),
  isRedisConfigured: () => true,
}));
vi.mock('@/lib/audit/log', () => ({ logAudit: fake.logAudit, logAuditWithResult: fake.logAuditWithResult }));
vi.mock('@/lib/api/v1/availability', () => ({ isPublicApiEnabled: async () => true }));
vi.mock('@/lib/gdpr/account-deletion', () => ({ scheduleAccountDeletion: fake.scheduleDeletion, cancelAccountDeletion: vi.fn() }));
vi.mock('@/lib/gdpr/deletion', () => ({ getActiveGdprRequest: vi.fn() }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: vi.fn() }));
vi.mock('@/lib/stripe/client', () => ({
  getStripe: () => ({ refunds: { list: vi.fn() }, disputes: { list: vi.fn() } }),
}));

const SUPABASE_URL = 'https://fixture.supabase.test';
const COOKIE_NAME = 'sb-fixture-auth-token';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const ORG = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const EMAIL = 'konto@ksef-saas.test';
const PASSWORD = 'fixture-haslo-konta';
const API_KEY = `fwk_${'A'.repeat(43)}`;

const b64url = (value: string) => Buffer.from(value).toString('base64url');

/** Token jak z GoTrue (HS256): `getClaims()` sprawdza go wtedy w GoTrue (`GET /auth/v1/user`). */
function accessToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: USER_ID, aud: 'authenticated', role: 'authenticated', aal: 'aal1', session_id: SESSION_ID,
    amr: [{ method: 'password', timestamp: now }], iat: now, exp: now + 3600,
  };
  return [b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), b64url(JSON.stringify(claims)), b64url('fixture-signature')].join('.');
}

function gotrueUser() {
  return {
    id: USER_ID, aud: 'authenticated', role: 'authenticated', email: EMAIL,
    app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, factors: [],
    created_at: '2026-01-01T00:00:00Z',
  };
}

function gotrueSession() {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return {
    access_token: accessToken(), refresh_token: 'fixture-refresh', token_type: 'bearer',
    expires_in: 3600, expires_at: exp, user: gotrueUser(),
  };
}

/** Ciasteczko sesji strony (`@supabase/ssr`, kodowanie base64url). */
function sessionCookie(): string {
  return `base64-${b64url(JSON.stringify(gotrueSession()))}`;
}

/** Odpowiedzi serwera po kolei dla `METODA /ścieżka`; gdy kolejka jest pusta, serwer milczy. */
let answers: Map<string, Array<() => Response>>;
/** Żądania, które doszły do serwera. */
let calls: { operation: string; headers: Headers; signal?: AbortSignal }[];
let fetchMock: ReturnType<typeof vi.fn>;

function answer(operation: string, reply: () => Response): void {
  answers.set(operation, [...(answers.get(operation) ?? []), reply]);
}

function server(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const operation = `${method} ${new URL(href).pathname}`;
  const signal = init?.signal ?? undefined;
  calls.push({ operation, headers: new Headers(init?.headers), signal });
  const reply = answers.get(operation)?.shift();
  if (reply) return Promise.resolve(reply());
  return new Promise((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** Serwer wysyła nagłówki i początek treści, a potem staje (treść przerywa sygnał, jak w undici). */
function stallsBody(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const signal = init?.signal ?? undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('[{"id":'));
      signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  });
  return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
}

/** Stan obietnicy bez czekania na nią: zegar jest sztuczny, więc test sam go przesuwa. */
function track<T>(promise: PromiseLike<T>) {
  const state: { done: boolean; value?: T; error?: unknown } = { done: false };
  Promise.resolve(promise).then(
    (value) => { state.done = true; state.value = value; },
    (error: unknown) => { state.done = true; state.error = error; },
  );
  return state;
}

/** Wynik przychodzi dokładnie po `limitMs`, a nie wcześniej. */
async function settlesAt<T>(limitMs: number, work: PromiseLike<T>): Promise<T> {
  const result = track(work);
  await vi.advanceTimersByTimeAsync(limitMs - 1);
  expect(result.done, 'przed limitem wywołanie jeszcze czeka').toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(result.done, 'po limicie wywołanie ma wynik').toBe(true);
  expect(result.error).toBeUndefined();
  return result.value!;
}

function expectTimeoutResult(result: { data: unknown; error: { message: string } | null; status: number }, limitMs: number, operation: string) {
  expect(result.data).toBeNull();
  expect(result.status).toBe(0);
  expect(result.error?.message).toBe(`TimeoutError: Supabase nie odpowiedział w ${limitMs} ms (${operation})`);
}

function refused(result: { ok: true } | { ok: false; response: Response }): Response {
  if (result.ok) throw new Error('oczekiwana odmowa, a żądanie przeszło');
  return result.response;
}

function mobileRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://app.fixture.test${path}`, { headers: { authorization: `Bearer ${accessToken()}`, ...headers } });
}

function jsonPost(path: string, body: unknown): Request {
  return new Request(`https://app.fixture.test${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

/** Konto z hasłem po bramce `authenticateMobileRequest` (bez 2FA). */
function mobileCaller(): MobileCaller {
  return {
    requestId: 'fixture-request',
    headers: { 'X-Request-Id': 'fixture-request' },
    user: { id: USER_ID, email: EMAIL, providers: ['email'] },
    mfaEnabled: false,
    accessToken: null,
    totpFactorId: null,
    session: { sessionId: SESSION_ID, aal: 'aal1', amrMethods: ['password'], potwierdzonoO: null },
    org: null,
    db: {} as MobileCaller['db'],
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'fixture-anon-key');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fixture-service-role-key-do-testow');
  vi.stubEnv('SUPABASE_JWT_SECRET', 'fixture-jwt-secret-do-testow-dluzszy-niz-32-znaki');
  fake.cookies = new Map();
  fake.setCookie.mockReset();
  fake.maintenance.mockReset().mockResolvedValue(false);
  fake.rateLimit.mockReset().mockResolvedValue({ allowed: true, remaining: 59, retryAfter: 0 });
  fake.passwordLimit.mockReset().mockResolvedValue({ allowed: true, retryAfter: 0, unavailable: false });
  fake.mobileLoginLimit.mockReset().mockResolvedValue({ allowed: true, remaining: 4, retryAfter: 0 });
  fake.logAudit.mockReset().mockResolvedValue(undefined);
  fake.logAuditWithResult.mockReset().mockResolvedValue({ ok: true });
  fake.captureMessage.mockReset();
  fake.captureException.mockReset();
  fake.scheduleDeletion.mockReset();
  answers = new Map();
  calls = [];
  fetchMock = vi.fn(server);
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('fabryki: wynik dokładnie po limicie i przerwane żądanie', () => {
  it('klucz API (`/api/v1`, `/api/mcp`): odczyt po 10 s, RPC po 30 s, token klucza zostaje w nagłówku', async () => {
    const { createApiKeyDbClient } = await import('@/lib/api/v1/db');
    const db = createApiKeyDbClient('fixture-api-key-token');

    expectTimeoutResult(await settlesAt(10_000, db.from('invoices').select('id')), 10_000, 'GET /rest/v1/invoices');
    expectTimeoutResult(
      await settlesAt(30_000, db.rpc('api_key_session', { p_endpoint: 'GET /api/v1/faktury' })),
      30_000,
      'POST /rest/v1/rpc/api_key_session',
    );

    expect(calls.map((call) => call.headers.get('authorization'))).toEqual(['Bearer fixture-api-key-token', 'Bearer fixture-api-key-token']);
    expect(calls.every((call) => call.signal?.aborted === true)).toBe(true);
  });

  it('klucz API: serwer, który wysłał nagłówki i stanął w połowie treści, też kończy się po 10 s', async () => {
    fetchMock.mockImplementation(stallsBody);
    const { createApiKeyDbClient } = await import('@/lib/api/v1/db');

    const result = await settlesAt(10_000, createApiKeyDbClient('fixture-api-key-token').from('invoices').select('id'));

    expectTimeoutResult(result, 10_000, 'GET /rest/v1/invoices');
  });

  it('baza z telefonu (`createMobileDbClient`): odczyt po 10 s, zapis po 30 s, token klienta i firma w nagłówkach', async () => {
    const { createMobileDbClient } = await import('@/lib/api/mobile/db');
    const db = createMobileDbClient('fixture-client-token', { activeOrg: ORG });

    expectTimeoutResult(await settlesAt(10_000, db.from('invoices').select('id')), 10_000, 'GET /rest/v1/invoices');
    expectTimeoutResult(await settlesAt(30_000, db.from('mobile_sessions').insert({ id: 'x' })), 30_000, 'POST /rest/v1/mobile_sessions');

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.headers.get('authorization')).toBe('Bearer fixture-client-token');
      expect(call.headers.get('x-active-org')).toBe(ORG);
      expect(call.signal?.aborted).toBe(true);
    }
  });

  it('GoTrue dla tokenu telefonu (`createMobileAuthClient`): getUser kończy się błędem przejściowym po 10 s', async () => {
    const { createMobileAuthClient } = await import('@/lib/api/mobile/db');

    const { data, error } = await settlesAt(10_000, createMobileAuthClient().auth.getUser(accessToken()));

    expect(data.user).toBeNull();
    expect(error?.name).toBe('AuthRetryableFetchError');
    expect(error?.message).toBe('Supabase nie odpowiedział w 10000 ms (GET /auth/v1/user)');
  });

  it('logowanie hasłem kluczem serwisowym (`createMobileLoginClient`): błąd przejściowy po 30 s', async () => {
    const { createMobileLoginClient } = await import('@/lib/api/mobile/db');

    const { data, error } = await settlesAt(30_000, createMobileLoginClient().auth.signInWithPassword({ email: EMAIL, password: PASSWORD }));

    expect(data.session).toBeNull();
    expect(error?.name).toBe('AuthRetryableFetchError');
    expect(error?.message).toBe('Supabase nie odpowiedział w 30000 ms (POST /auth/v1/token)');
  });

  it('skrypty CLI (`createScriptAdminClient`): limity workera, odczyt po 60 s, zapis po 120 s', async () => {
    const { createScriptAdminClient } = await import('@/scripts/_supabase');
    const db = createScriptAdminClient();

    expectTimeoutResult(await settlesAt(60_000, db.from('ksef_credentials').select('id')), 60_000, 'GET /rest/v1/ksef_credentials');
    expectTimeoutResult(
      await settlesAt(120_000, db.from('ksef_credentials').update({ key_version: 2 }).eq('id', ORG)),
      120_000,
      'PATCH /rest/v1/ksef_credentials',
    );
  });
});

describe('co widzi klient po limicie', () => {
  it('`/api/v1` i `/api/mcp`: baza milczy przy `api_key_session` → 503 po 30 s, bez danych', async () => {
    const { authenticateApiRequest } = await import('@/lib/api/v1/auth');
    const request = new Request('https://app.fixture.test/api/v1/faktury', { headers: { authorization: `Bearer ${API_KEY}` } });

    const response = refused(await settlesAt(30_000, authenticateApiRequest(request, { scope: null })));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'service_unavailable' } });
    expect(calls.map((call) => call.operation)).toEqual(['POST /rest/v1/rpc/api_key_session']);
  });

  it('telefon, sprawdzenie sesji: GoTrue milczy → 503 `session_verification_failed` po 10 s, nie 401 (telefon nie wylogowuje)', async () => {
    const { authenticateMobileRequest } = await import('@/lib/api/mobile/auth');

    const response = refused(await settlesAt(10_000, authenticateMobileRequest(mobileRequest('/api/mobile/v1/konto'), { org: 'none' })));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'session_verification_failed' } });
  });

  it('telefon, sprawdzenie sesji: getUser odpowiada, a getClaims (przy HS256 pyta GoTrue) milczy → też 503 po 10 s', async () => {
    answer('GET /auth/v1/user', () => Response.json(gotrueUser()));
    const { authenticateMobileRequest } = await import('@/lib/api/mobile/auth');

    const response = refused(await settlesAt(10_000, authenticateMobileRequest(mobileRequest('/api/mobile/v1/konto'), { org: 'none' })));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'session_verification_failed' } });
    expect(calls.map((call) => call.operation)).toEqual(['GET /auth/v1/user', 'GET /auth/v1/user']);
  });

  it('telefon, dane firmy: członkostwo w bazie milczy → 503 `service_unavailable` po 10 s', async () => {
    answer('GET /auth/v1/user', () => Response.json(gotrueUser()));
    answer('GET /auth/v1/user', () => Response.json(gotrueUser()));
    const { authenticateMobileRequest } = await import('@/lib/api/mobile/auth');
    const request = mobileRequest('/api/mobile/v1/faktury', { 'X-Active-Org': ORG });

    const response = refused(await settlesAt(10_000, authenticateMobileRequest(request, { org: 'required' })));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'service_unavailable' } });
    expect(calls.map((call) => call.operation)).toEqual(['GET /auth/v1/user', 'GET /auth/v1/user', 'GET /rest/v1/memberships']);
  });

  it('telefon, logowanie hasłem: GoTrue milczy → 503 `service_unavailable` po 30 s, bez wpisu „nieudane logowanie”', async () => {
    const { handleMobilePasswordLogin } = await import('@/lib/api/mobile/logowanie');

    const response = await settlesAt(30_000, handleMobilePasswordLogin(jsonPost('/api/mobile/v1/logowanie', { email: EMAIL, haslo: PASSWORD })));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'service_unavailable' } });
    expect(fake.logAudit).not.toHaveBeenCalled();
  });

  it('telefon, usunięcie konta hasłem: GoTrue milczy → 503 po 30 s, nie „Hasło jest nieprawidłowe”', async () => {
    const { requestDeletionFromMobile } = await import('@/lib/api/mobile/konto-usuniecie');

    const response = await settlesAt(30_000, requestDeletionFromMobile(mobileCaller(), jsonPost('/api/mobile/v1/konto/usuniecie', { haslo: PASSWORD })));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'service_unavailable' } });
    expect(fake.scheduleDeletion).not.toHaveBeenCalled();
  });

  it('strona (`reauthenticateWithPassword`): GoTrue milczy przy haśle → po 30 s „nie możemy potwierdzić”, nie „złe hasło”', async () => {
    fake.cookies.set(COOKIE_NAME, sessionCookie());
    answer('GET /auth/v1/user', () => Response.json(gotrueUser()));
    const { reauthenticateWithPassword } = await import('@/lib/auth/reauth');

    const result = await settlesAt(30_000, reauthenticateWithPassword(PASSWORD));

    expect(result).toEqual({ ok: false, error: 'verification_unavailable' });
    expect(calls.map((call) => call.operation)).toEqual(['GET /auth/v1/user', 'POST /auth/v1/token']);
    expect(calls[1]!.signal?.aborted).toBe(true);
  });

  it.each([
    { name: '503 z bramki', status: 503, body: { message: 'upstream unavailable' } },
    { name: '500 z GoTrue', status: 500, body: { code: 'unexpected_failure', msg: 'Unexpected failure' } },
    { name: '429 (limit GoTrue)', status: 429, body: { code: 'over_request_rate_limit', msg: 'Request rate limit reached' } },
  ])('strona: $name przy haśle → „nie możemy potwierdzić”, nie „złe hasło”', async ({ status, body }) => {
    fake.cookies.set(COOKIE_NAME, sessionCookie());
    answer('GET /auth/v1/user', () => Response.json(gotrueUser()));
    answer('POST /auth/v1/token', () => Response.json(body, { status }));
    const { reauthenticateWithPassword } = await import('@/lib/auth/reauth');

    await expect(reauthenticateWithPassword(PASSWORD)).resolves.toEqual({ ok: false, error: 'verification_unavailable' });
  });

  it('strona: odpowiedź nie-JSON spoza 5xx (403 ze stroną HTML, `AuthUnknownError` bez kodu) → „nie możemy potwierdzić”, nie „złe hasło”', async () => {
    // Prawdziwe złe hasło GoTrue zawsze opisuje w JSON z kodem 400. Ciało nie-JSON
    // (auth-js daje wtedy błąd bez `status`) to awaria po drodze, jak w `POST /logowanie`
    // telefonu (lib/api/mobile/logowanie.ts). 5xx z HTML auth-js sam uznaje za przejściowe.
    fake.cookies.set(COOKIE_NAME, sessionCookie());
    answer('GET /auth/v1/user', () => Response.json(gotrueUser()));
    answer('POST /auth/v1/token', () => new Response('<html>403 Forbidden</html>', {
      status: 403, headers: { 'content-type': 'text/html' },
    }));
    const { reauthenticateWithPassword } = await import('@/lib/auth/reauth');

    await expect(reauthenticateWithPassword(PASSWORD)).resolves.toEqual({ ok: false, error: 'verification_unavailable' });
  });

  it('strażnik: złe hasło (400 `invalid_credentials`) dalej jest złym hasłem', async () => {
    fake.cookies.set(COOKIE_NAME, sessionCookie());
    answer('GET /auth/v1/user', () => Response.json(gotrueUser()));
    answer('POST /auth/v1/token', () => Response.json(
      { code: 'invalid_credentials', error: 'invalid_grant', error_description: 'Invalid login credentials', msg: 'Invalid login credentials' },
      { status: 400 },
    ));
    const { reauthenticateWithPassword } = await import('@/lib/auth/reauth');

    await expect(reauthenticateWithPassword(PASSWORD)).resolves.toEqual({ ok: false, error: 'invalid_password' });
  });

  it('strona: hasło dobre, ale wylogowanie sesji tymczasowej milczy → po 30 s `unknown` (UI: „nie możemy potwierdzić”)', async () => {
    fake.cookies.set(COOKIE_NAME, sessionCookie());
    answer('GET /auth/v1/user', () => Response.json(gotrueUser()));
    answer('POST /auth/v1/token', () => Response.json(gotrueSession()));
    const { reauthenticateWithPassword } = await import('@/lib/auth/reauth');

    const result = await settlesAt(30_000, reauthenticateWithPassword(PASSWORD));

    expect(result).toEqual({ ok: false, error: 'unknown' });
    expect(calls.map((call) => call.operation)).toEqual(['GET /auth/v1/user', 'POST /auth/v1/token', 'POST /auth/v1/logout']);
  });

  it('trasa sesji k6 (`/api/dev/load-test-session`): GoTrue milczy → 503 `auth_unavailable` po 30 s, nie 401 `invalid_credentials`', async () => {
    vi.stubEnv('LOAD_TEST_MODE', 'true');
    const { POST } = await import('@/app/api/dev/load-test-session/route');

    const response = await settlesAt(30_000, POST(jsonPost('/api/dev/load-test-session', { email: EMAIL, password: PASSWORD })));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'auth_unavailable' });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('strażnik: trasa sesji k6 przy złym haśle dalej daje 401 `invalid_credentials`', async () => {
    vi.stubEnv('LOAD_TEST_MODE', 'true');
    answer('POST /auth/v1/token', () => Response.json({ code: 'invalid_credentials', msg: 'Invalid login credentials' }, { status: 400 }));
    const { POST } = await import('@/app/api/dev/load-test-session/route');

    const response = await POST(jsonPost('/api/dev/load-test-session', { email: EMAIL, password: PASSWORD }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: 'invalid_credentials' });
  });

  it('trasa sesji k6: limit żądań GoTrue (429) → 429 `rate_limited`, nie 401 `invalid_credentials`', async () => {
    vi.stubEnv('LOAD_TEST_MODE', 'true');
    answer('POST /auth/v1/token', () => Response.json(
      { code: 'over_request_rate_limit', msg: 'Request rate limit reached' },
      { status: 429 },
    ));
    const { POST } = await import('@/app/api/dev/load-test-session/route');

    const response = await POST(jsonPost('/api/dev/load-test-session', { email: EMAIL, password: PASSWORD }));

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ ok: false, error: 'rate_limited' });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('skrypt audytu Stripe: baza milczy przy sprawdzeniu schematu → po 60 s raport `incomplete`, `database_unavailable`, kod 2', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_fixture123');
    const argv = process.argv;
    const exitCode = process.exitCode;
    const writes: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    process.argv = ['node', 'audit-stripe-financial-gaps.ts', '--mode', 'test', '--from', '2026-09-01', '--to', '2026-09-25'];
    try {
      await import('@/scripts/security/audit-stripe-financial-gaps');
      const reports = () => writes.filter((chunk) => chunk.startsWith('{'));

      await vi.advanceTimersByTimeAsync(59_999);
      expect(reports(), 'przed limitem raportu jeszcze nie ma').toEqual([]);
      await vi.advanceTimersByTimeAsync(1);

      expect(reports()).toEqual(['{"status":"incomplete","reason":"database_unavailable"}\n']);
      expect(process.exitCode).toBe(2);
      expect(calls.map((call) => call.operation)).toEqual(['HEAD /rest/v1/stripe_financial_cases']);
    } finally {
      write.mockRestore();
      process.argv = argv;
      process.exitCode = exitCode;
    }
  });
});
