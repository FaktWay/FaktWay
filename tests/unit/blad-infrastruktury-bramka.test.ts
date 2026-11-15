import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { NextRequest } from 'next/server';

import { ES256_JWKS, signEs256Jwt } from '../helpers/gotrue-es256';

/**
 * Plan skalowania 3000, sesja 7 (REQ-V02, GTR-03, QAL-06).
 *
 * Bramka w proxy brała awarię za odmowę. 503 albo 429 z GoTrue kończyło się
 * przekierowaniem na `/login` (strona) albo 401 (API), odmowa 429 przy
 * odświeżeniu wygasłego tokenu kasowała sesję, a błąd zapytania o członkostwo
 * wysyłał zalogowanego z firmą na „Załóż firmę”. Zalogowany na
 * `/login?redirect=…` tracił adres, do którego szedł.
 *
 * Test używa PRAWDZIWEGO `@supabase/ssr` i `updateSession`; atrapa gra tylko
 * GoTrue i PostgREST. Sprawdza, że awaria i limit dają od razu 503 „spróbuj
 * ponownie” (limit z osobnym tekstem i wpisem w logu), bez przekierowania
 * i bez kasowania sesji, a prawdziwa odmowa dalej prowadzi na logowanie
 * (fail-closed bez zmian).
 */

const mocks = vi.hoisted(() => ({ maintenance: vi.fn() }));
vi.mock('@/lib/feature-flags/maintenance', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/feature-flags/maintenance')>(),
  isMaintenanceMode: mocks.maintenance,
}));

import { ACTIVE_ORG_COOKIE } from '@/lib/supabase/active-org';
import { updateSession } from '@/lib/supabase/middleware';

const LIMIT_MS = 5_000;
const SUPABASE_URL = 'https://fixture.supabase.test';
const COOKIE_NAME = 'sb-fixture-auth-token';
const SESSION_ID = 'fixture-session-id';
const userId = '22222222-2222-4222-8222-222222222222';
const org = '11111111-1111-4111-8111-111111111111';
const totp = { id: 'fixture-factor', factor_type: 'totp', status: 'verified' };
const UNAVAILABLE_TEXT = 'Nie udało się zweryfikować sesji. Spróbuj ponownie.';
const BUSY_TEXT = 'System logowania jest chwilowo przeciążony. Spróbuj ponownie za minutę.';

type Keys = 'hs256' | 'es256';
type Aal = 'aal1' | 'aal2';
type Respond = () => Response;

let keys: Keys;
/** Ścieżki atrapy, które zamiast zwykłej odpowiedzi oddają błąd (albo rzucają, jak padnięta sieć). */
let failures: Map<string, Respond>;
/** Wiersze `memberships` dla wyboru firmy (domyślnie jedna aktywna firma). */
let membershipRows: unknown[];
let refreshCalls: number;
/** Żądania spoza atrapy. Błąd z atrapy auth-js wziąłby za awarię sieci, więc test sprawdza, że ich nie ma. */
let unexpected: string[];
let warn: MockInstance<typeof console.warn>;

const b64url = (value: string) => Buffer.from(value).toString('base64url');

function jwt(sub: string, exp: number, aal: Aal): string {
  const payload = {
    sub, aal, role: 'authenticated', aud: 'authenticated',
    iat: Math.floor(Date.now() / 1000), exp, session_id: SESSION_ID,
  };
  if (keys === 'es256') return signEs256Jwt(payload);
  return [b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), b64url(JSON.stringify(payload)), b64url('fixture-signature')].join('.');
}

function session(sub: string, expiresAt: number, aal: Aal, refreshToken: string) {
  return {
    access_token: jwt(sub, expiresAt, aal), refresh_token: refreshToken, token_type: 'bearer',
    expires_in: expiresAt - Math.floor(Date.now() / 1000), expires_at: expiresAt,
    user: { id: sub, aud: 'authenticated', role: 'authenticated' },
  };
}

function gotrueError(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status, headers: { 'x-supabase-api-version': '2024-01-01' } });
}

const networkDown: Respond = () => {
  throw new TypeError('fetch failed');
};

/** Awaria GoTrue: odpowiedź, po której sesji nie da się teraz sprawdzić. */
const GOTRUE_DOWN: [string, Respond][] = [
  ['503 z GoTrue', () => gotrueError(503, 'unexpected_failure', 'Service Unavailable')],
  ['500 z GoTrue', () => gotrueError(500, 'unexpected_failure', 'Internal Server Error')],
  ['502 z bramki, bez JSON', () => new Response('<html>502 Bad Gateway</html>', {
    status: 502, statusText: 'Bad Gateway', headers: { 'content-type': 'text/html' },
  })],
  ['brak sieci', networkDown],
];

const gotrueRateLimited: Respond = () => gotrueError(429, 'over_request_rate_limit', 'Request rate limit reached');

/** Prawdziwa odmowa: token albo sesja są nieważne. */
const DENIALS: [string, Respond][] = [
  ['token odrzucony (403 bad_jwt)', () => gotrueError(403, 'bad_jwt', 'invalid JWT')],
  ['brak autoryzacji (401)', () => gotrueError(401, 'no_authorization', 'This endpoint requires a Bearer token')],
  ['sesja usunięta (403 session_not_found)', () => gotrueError(403, 'session_not_found', 'Session from session_id claim in JWT does not exist')],
];

/**
 * Błąd zapytania o członkostwo, który PostgREST oddaje od razu. Brak sieci i 503
 * postgrest-js sam ponawia (1 s, 2 s, 4 s), więc w proxy kończy je termin bramki.
 */
const DB_DOWN: [string, Respond][] = [
  ['przekroczony czas zapytania (57014)', () => Response.json(
    { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null },
    { status: 500 },
  )],
  ['brak wolnego połączenia w puli (PGRST003)', () => Response.json(
    { code: 'PGRST003', message: 'Timed out acquiring connection from connection pool.', details: null, hint: null },
    { status: 504 },
  )],
  ['502 z bramki, bez JSON', () => new Response('<html>502 Bad Gateway</html>', {
    status: 502, statusText: 'Bad Gateway', headers: { 'content-type': 'text/html' },
  })],
];

function answer(url: URL, init?: RequestInit): Response {
  if (url.pathname === '/auth/v1/token') {
    return Response.json(session(userId, Math.floor(Date.now() / 1000) + 3600, 'aal2', 'fixture-refresh-2'));
  }
  if (url.pathname === '/auth/v1/.well-known/jwks.json') return Response.json(ES256_JWKS);
  if (url.pathname === '/auth/v1/user') {
    const token = new Headers(init?.headers).get('authorization')!.replace('Bearer ', '');
    const { sub } = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { sub: string };
    return Response.json({ id: sub, aud: 'authenticated', role: 'authenticated', factors: [totp] });
  }
  if (url.pathname === '/rest/v1/memberships') return Response.json(membershipRows);
  if (url.pathname === '/rest/v1/users') return Response.json([{ last_active_tenant_id: org }]);
  unexpected.push(url.href);
  throw new Error(`Nieoczekiwane żądanie w teście proxy: ${url.href}`);
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.pathname === '/auth/v1/token') refreshCalls += 1;
  const fail = failures.get(url.pathname);
  if (fail) return fail();
  return answer(url, init);
}

function request(path: string, opts: { state?: 'valid' | 'expired'; aal?: Aal; org?: boolean } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = opts.state === 'expired' ? now - 60 : now + 3600;
  const value = session(userId, expiresAt, opts.aal ?? 'aal2', 'fixture-refresh-1');
  const cookies = [`${COOKIE_NAME}=base64-${b64url(JSON.stringify(value))}`];
  if (opts.org ?? true) cookies.push(`${ACTIVE_ORG_COOKIE}=${org}`);
  return new NextRequest(`https://app.example.test${path}`, { headers: { cookie: cookies.join('; ') } });
}

// Podpis ES256 sprawdza WebCrypto w puli wątków, poza sztucznym zegarem
// (jak w `proxy-limit-czasu-supabase.test.ts`): test czeka na tę pracę naprawdę.
const pendingCrypto = new Set<Promise<unknown>>();
function trackWebCrypto(): void {
  const subtle = globalThis.crypto.subtle;
  for (const method of ['importKey', 'verify', 'digest'] as const) {
    const original = (subtle[method] as (...args: unknown[]) => Promise<unknown>).bind(subtle);
    vi.spyOn(subtle, method).mockImplementation(((...args: unknown[]) => {
      const work = original(...args);
      pendingCrypto.add(work);
      const forget = () => { pendingCrypto.delete(work); };
      work.then(forget, forget);
      return work;
    }) as never);
  }
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function settleRealWork(): Promise<void> {
  await nextTurn();
  while (pendingCrypto.size > 0) {
    await Promise.allSettled([...pendingCrypto]);
    await nextTurn();
  }
}

async function advance(ms: number): Promise<void> {
  let left = ms;
  do {
    await settleRealWork();
    const step = Math.min(50, left);
    vi.advanceTimersByTime(step);
    left -= step;
  } while (left > 0);
  await settleRealWork();
}

/**
 * Decyzja bramki BEZ przesuwania zegara: awaria i limit mają dać odpowiedź od
 * razu, a nie dopiero po terminie bramki (to już robi sesja 5 dla zawieszenia).
 */
async function decideNow(path: string, opts?: Parameters<typeof request>[1]): Promise<Response> {
  const state: { done: boolean; value?: Response; error?: unknown } = { done: false };
  updateSession(request(path, opts)).then(
    (value) => { state.done = true; state.value = value; },
    (error: unknown) => { state.done = true; state.error = error; },
  );
  for (let turn = 0; turn < 50 && !state.done; turn += 1) await settleRealWork();
  expect(state.done, `${path}: decyzja bez czekania na termin bramki`).toBe(true);
  expect(state.error).toBeUndefined();
  return state.value!;
}

const passedToRoute = (response: Response) => response.headers.get('x-middleware-next') === '1';
const loginFor = (path: string) => `https://app.example.test/login?redirect=${encodeURIComponent(path)}`;

const clearedSessionCookies = (response: Response) => response.headers.getSetCookie()
  .filter((cookie) => cookie.startsWith(COOKIE_NAME) && /max-age=0|expires=thu, 01 jan 1970/i.test(cookie));

/** 503 „spróbuj ponownie”: bez przekierowania, bez cache i bez kasowania ciasteczka sesji. */
async function expectUnavailable(response: Response, api: boolean, text = UNAVAILABLE_TEXT): Promise<void> {
  expect(response.status).toBe(503);
  expect(response.headers.get('location')).toBeNull();
  expect(response.headers.get('cache-control')).toContain('no-store');
  if (api) expect(await response.json()).toEqual({ error: 'session_verification_failed' });
  else expect(await response.text()).toBe(text);
  expect(clearedSessionCookies(response)).toEqual([]);
}

/** Pierwsze argumenty wpisów `[auth]` i `[proxy]` w logu. */
const warnedLines = () => warn.mock.calls
  .map(([first]) => String(first))
  .filter((line) => line.startsWith('[auth]') || line.startsWith('[proxy]'));

/** Cały log jako tekst: nie może nieść tokenu (JWT zaczyna się od `eyJ`). */
function wholeLog(): string {
  return warn.mock.calls.flat().map((arg) => {
    if (typeof arg === 'string') return arg;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }).join('\n');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  pendingCrypto.clear();
  trackWebCrypto();
  keys = 'hs256';
  failures = new Map();
  membershipRows = [{ organization_id: org, joined_at: '2026-10-01T00:00:00Z' }];
  refreshCalls = 0;
  unexpected = [];
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'fixture-anon-key');
  vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'production');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fixture-service-role-key-do-testow');
  mocks.maintenance.mockResolvedValue(false);
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => {
  expect(unexpected).toEqual([]);
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const PROTECTED = [
  ['strona panelu', '/invoices', false],
  ['API panelu', '/api/invoices', true],
  ['panel operatora', '/admin', false],
] as const;

describe.each(['hs256', 'es256'] as const)('klucze %s', (mode) => {
  beforeEach(() => { keys = mode; });

  describe('GoTrue nie działa: od razu 503 „spróbuj ponownie”, nigdy logowanie', () => {
    it.each(GOTRUE_DOWN)('%s', async (_name, respond) => {
      failures.set('/auth/v1/user', respond);

      for (const [, path, api] of PROTECTED) await expectUnavailable(await decideNow(path), api);

      expect(warnedLines().some((line) => line.startsWith('[auth] gotrue_unavailable'))).toBe(true);
      expect(warnedLines().some((line) => line.startsWith('[auth] gotrue_rate_limited'))).toBe(false);
      expect(wholeLog()).not.toContain('eyJ');
    });

    // Klucze publiczne (JWKS) auth-js pobiera na nowo po 10 minutach.
    it.runIf(mode === 'es256')('klucze JWKS niedostępne: 503, nie logowanie', async () => {
      vi.setSystemTime(Date.now() + 11 * 60_000);
      failures.set('/auth/v1/.well-known/jwks.json', () => gotrueError(503, 'unexpected_failure', 'Service Unavailable'));

      await expectUnavailable(await decideNow('/invoices'), false);
      expect(warnedLines().some((line) => line.startsWith('[auth] gotrue_unavailable'))).toBe(true);
    });

    // Przy HS256 każda trasa z ciasteczkiem sesji pyta GoTrue, także publiczna.
    // Publiczna sesji nie potrzebuje: jedzie dalej jak dla gościa, ale awaria
    // trafia do logu.
    it.runIf(mode === 'hs256')('trasa publiczna z sesją: jak dla gościa, sesja zostaje, wpis w logu', async () => {
      failures.set('/auth/v1/user', () => gotrueError(503, 'unexpected_failure', 'Service Unavailable'));

      for (const path of ['/login', '/', '/pomoc']) {
        const response = await decideNow(path);
        expect(passedToRoute(response), path).toBe(true);
        expect(response.headers.get('location'), path).toBeNull();
        expect(clearedSessionCookies(response), path).toEqual([]);
      }
      expect(warnedLines().some((line) => line.startsWith('[auth] gotrue_unavailable'))).toBe(true);
    });
  });

  describe('GoTrue odmawia limitem (429): 503 z osobnym tekstem i wpisem w logu', () => {
    it.each(PROTECTED)('sprawdzenie sesji, %s (%s)', async (_name, path, api) => {
      failures.set('/auth/v1/user', gotrueRateLimited);

      await expectUnavailable(await decideNow(path), api, BUSY_TEXT);
      expect(warnedLines().some((line) => line.startsWith('[auth] gotrue_rate_limited'))).toBe(true);
      expect(wholeLog()).not.toContain('eyJ');
    });

    it.each(PROTECTED)('odświeżenie wygasłego tokenu, %s (%s): sesja zostaje, bez kolejnych prób do GoTrue', async (_name, path, api) => {
      failures.set('/auth/v1/token', gotrueRateLimited);

      await expectUnavailable(await decideNow(path, { state: 'expired' }), api, BUSY_TEXT);
      expect(refreshCalls).toBe(1);
      // auth-js ponawia odświeżenie (po 200 ms, 400 ms, …): po decyzji bramki już bez sieci.
      await advance(LIMIT_MS + 500);
      expect(refreshCalls).toBe(1);
      expect(warnedLines().some((line) => line.startsWith('[auth] gotrue_rate_limited'))).toBe(true);
    });

    it('trasa publiczna z wygasłą sesją: jak dla gościa, sesja zostaje, wpis w logu', async () => {
      failures.set('/auth/v1/token', gotrueRateLimited);

      const response = await decideNow('/login', { state: 'expired' });
      expect(passedToRoute(response)).toBe(true);
      expect(response.headers.get('location')).toBeNull();
      expect(clearedSessionCookies(response)).toEqual([]);
      expect(warnedLines().some((line) => line.startsWith('[auth] gotrue_rate_limited'))).toBe(true);
    });
  });

  describe('prawdziwa odmowa GoTrue: dalej logowanie (fail-closed bez zmian)', () => {
    it.each(DENIALS)('%s', async (_name, respond) => {
      failures.set('/auth/v1/user', respond);

      expect((await decideNow('/invoices')).headers.get('location')).toBe(loginFor('/invoices'));
      expect((await decideNow('/admin')).headers.get('location')).toBe(loginFor('/admin'));
      const api = await decideNow('/api/invoices');
      expect(api.status).toBe(401);
      expect(await api.json()).toEqual({ error: 'not_authenticated' });
      expect(warnedLines().filter((line) => line.startsWith('[auth] gotrue_'))).toEqual([]);
    });
  });

  describe('wybór firmy: błąd zapytania o członkostwo to 503, nie „Załóż firmę”', () => {
    it.each(DB_DOWN)('%s', async (_name, respond) => {
      failures.set('/rest/v1/memberships', respond);

      await expectUnavailable(await decideNow('/dashboard', { org: false }), false);
      expect(warnedLines().some((line) => line.startsWith('[proxy]') && line.includes('wybór firmy'))).toBe(true);
    });

    it('brak sieci: postgrest-js ponawia, termin bramki daje 503, nie /onboarding', async () => {
      failures.set('/rest/v1/memberships', networkDown);

      const pending = updateSession(request('/dashboard', { org: false }));
      await advance(LIMIT_MS + 500);
      await expectUnavailable(await pending, false);
    });

    it('naprawdę bez firmy: dalej /onboarding', async () => {
      membershipRows = [];

      expect((await decideNow('/dashboard', { org: false })).headers.get('location'))
        .toBe('https://app.example.test/onboarding');
    });
  });

  describe('zalogowany na /login albo /register wraca tam, dokąd szedł', () => {
    it.each([
      ['/login?redirect=%2Finvoices%2Fabc', 'https://app.example.test/invoices/abc'],
      ['/login?redirect=%2Fsettings%3Ftab%3Dkonto', 'https://app.example.test/settings?tab=konto'],
      ['/register?redirect=%2Fexpenses', 'https://app.example.test/expenses'],
    ])('%s', async (path, target) => {
      expect((await decideNow(path)).headers.get('location')).toBe(target);
    });

    it.each([
      '/login',
      '/login?redirect=',
      '/login?redirect=%2F%2Fevil.example.test',
      '/login?redirect=https%3A%2F%2Fevil.example.test%2Fx',
      '/login?redirect=%2F%5Cevil.example.test',
      '/login?redirect=%2Flogin',
      '/register?redirect=%2Fregister%3Fx%3D1',
    ])('%s: bez bezpiecznego celu na pulpit', async (path) => {
      expect((await decideNow(path)).headers.get('location')).toBe('https://app.example.test/dashboard');
    });
  });
});
