import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

/**
 * Plan skalowania 3000, sesja 7 (REQ-V02, GTR-03, QAL-06): to samo co
 * w `blad-infrastruktury-bramka.test.ts`, ale za proxy, czyli w akcjach
 * serwera, API i stronach panelu.
 *
 * Tu awaria też udawała odmowę. 503, 429 albo brak sieci przy `getUser`
 * dawały „Niezalogowany” w akcji, 401 `not_authenticated` w API
 * i przekierowanie na `/login` na stronie. Błąd zapytania o członkostwo
 * dawał „Brak dostępu do aktywnej organizacji”. (Formularze zaliczki
 * i rozliczenia, `lib/invoices/load-tenant-seller.ts`, to plik R1: osobny PR.)
 *
 * Test używa PRAWDZIWYCH klientów z `lib/supabase/server` (`@supabase/ssr`
 * i `supabase-js`). Atrapa gra tylko ciasteczka (`next/headers`), GoTrue
 * i PostgREST. Prawdziwa odmowa zostaje odmową (fail-closed bez zmian).
 */

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock('next/headers', () => ({
  cookies: async () => ({
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    has: (name: string) => jar.has(name),
    set: () => {},
  }),
  headers: async () => new Headers(),
}));

import { getVerifiedUserContext } from '@/lib/auth/verified-user';
import { getDashboardSessionUser } from '@/lib/dashboard-shell-data';
import { ACTIVE_ORG_COOKIE } from '@/lib/supabase/active-org';
import {
  requireUserAndActiveOrg, requireVerifiedUser, resolveApiUserAndActiveOrg,
} from '@/lib/supabase/auth-context';
import { getPageContext } from '@/lib/supabase/page-context';

const SUPABASE_URL = 'https://fixture.supabase.test';
const COOKIE_NAME = 'sb-fixture-auth-token';
const userId = '22222222-2222-4222-8222-222222222222';
const org = '11111111-1111-4111-8111-111111111111';
const SELLER_NIP = '1234563218';
const SESSION_RETRY = 'Nie udało się zweryfikować sesji. Spróbuj ponownie za chwilę.';
const AUTH_BUSY = 'System logowania jest chwilowo przeciążony. Spróbuj ponownie za minutę.';
const MEMBERSHIP_RETRY = 'Nie udało się sprawdzić dostępu do firmy. Spróbuj ponownie za chwilę.';

type Respond = () => Response;

/** Ścieżki atrapy, które zamiast zwykłej odpowiedzi oddają błąd (albo rzucają, jak padnięta sieć). */
let failures: Map<string, Respond>;
let membershipRows: unknown[];
/** Żądania spoza atrapy. Błąd z atrapy auth-js wziąłby za awarię sieci, więc test sprawdza, że ich nie ma. */
let unexpected: string[];
let warn: MockInstance<typeof console.warn>;

const b64url = (value: string) => Buffer.from(value).toString('base64url');

/** Ważna sesja HS256 (jak na produkcji) w formacie ciasteczka `@supabase/ssr`. */
function sessionCookie(): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: userId, aal: 'aal1', role: 'authenticated', aud: 'authenticated',
    iat: now, exp: now + 3600, session_id: 'fixture-session-id',
  };
  const token = [b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), b64url(JSON.stringify(payload)), b64url('fixture-signature')].join('.');
  const session = {
    access_token: token, refresh_token: 'fixture-refresh-1', token_type: 'bearer',
    expires_in: 3600, expires_at: now + 3600,
    user: { id: userId, aud: 'authenticated', role: 'authenticated' },
  };
  return `base64-${b64url(JSON.stringify(session))}`;
}

function gotrueError(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status, headers: { 'x-supabase-api-version': '2024-01-01' } });
}

const networkDown: Respond = () => {
  throw new TypeError('fetch failed');
};

/**
 * Błąd zapytania, który PostgREST oddaje od razu. Brak sieci i 503 postgrest-js
 * ponawia sam (1 s, 2 s, 4 s), a tu chodzi o to, co kod robi z błędem.
 */
const statementTimeout: Respond = () => Response.json(
  { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null },
  { status: 500 },
);

const GOTRUE_DOWN: [string, Respond][] = [
  ['503 z GoTrue', () => gotrueError(503, 'unexpected_failure', 'Service Unavailable')],
  ['brak sieci', networkDown],
];
const rateLimited: Respond = () => gotrueError(429, 'over_request_rate_limit', 'Request rate limit reached');
const tokenRejected: Respond = () => gotrueError(403, 'bad_jwt', 'invalid JWT');
const GOTRUE_FAILING: [string, Respond][] = [...GOTRUE_DOWN, ['limit 429', rateLimited]];

function answer(url: URL): Response {
  if (url.pathname === '/auth/v1/user') {
    return Response.json({
      id: userId, aud: 'authenticated', role: 'authenticated', email: 'fixture-user@example.test',
      app_metadata: {}, user_metadata: {}, factors: [],
    });
  }
  if (url.pathname === '/rest/v1/memberships') return Response.json(membershipRows);
  unexpected.push(url.href);
  throw new Error(`Nieoczekiwane żądanie w teście: ${url.href}`);
}

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const fail = failures.get(url.pathname);
  if (fail) return fail();
  return answer(url);
}

/** Pierwsze argumenty wpisów `[auth]` w logu. */
const authLines = () => warn.mock.calls
  .map(([first]) => String(first))
  .filter((line) => line.startsWith('[auth]'));

/** Cały log jako tekst: nie może nieść tokenu (JWT zaczyna się od `eyJ`) ani adresu e-mail. */
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
  failures = new Map();
  unexpected = [];
  membershipRows = [{
    id: 'fixture-membership', organization_id: org, role: 'owner', status: 'active',
    tenants: { name: 'Firma Testowa', nip: SELLER_NIP, ksef_verified_at: null, ksef_verified_environment: null },
  }];
  jar.clear();
  jar.set(COOKIE_NAME, sessionCookie());
  jar.set(ACTIVE_ORG_COOKIE, org);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'fixture-anon-key');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fixture-service-role-key-do-testow');
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => {
  expect(unexpected).toEqual([]);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('strona panelu: awaria GoTrue to strona błędu z ponowieniem, nie logowanie', () => {
  it.each(GOTRUE_FAILING)('użytkownik sesji, %s: błąd, a nie „brak sesji”', async (_name, respond) => {
    failures.set('/auth/v1/user', respond);
    await expect(getDashboardSessionUser()).rejects.toMatchObject({ name: 'AuthServiceUnavailableError' });
    expect(wholeLog()).not.toMatch(/eyJ|@example\.test/);
  });

  it('kontekst strony przy 503: błąd, a nie przekierowanie na /login', async () => {
    failures.set('/auth/v1/user', GOTRUE_DOWN[0]![1]);
    await expect(getPageContext()).rejects.toMatchObject({ name: 'AuthServiceUnavailableError' });
    expect(authLines()).toContain('[auth] gotrue_unavailable');
  });

  it('limit 429: osobny wpis w logu', async () => {
    failures.set('/auth/v1/user', rateLimited);
    await expect(getDashboardSessionUser()).rejects.toMatchObject({ rateLimited: true });
    expect(authLines()).toContain('[auth] gotrue_rate_limited');
    expect(authLines()).not.toContain('[auth] gotrue_unavailable');
  });

  it('token odrzucony: dalej brak sesji i przekierowanie na /login', async () => {
    failures.set('/auth/v1/user', tokenRejected);
    await expect(getDashboardSessionUser()).resolves.toBeNull();
    await expect(getPageContext()).rejects.toMatchObject({ digest: expect.stringContaining(';/login;') });
    expect(authLines()).toEqual([]);
  });

  it('gdy GoTrue odpowiada, działa jak dotąd', async () => {
    await expect(getDashboardSessionUser()).resolves.toMatchObject({ id: userId });
    await expect(getPageContext()).resolves.toMatchObject({ tenantId: org, role: 'owner' });
  });
});

describe('akcja serwera: awaria to „spróbuj ponownie”, nie „Niezalogowany”', () => {
  it.each(GOTRUE_DOWN)('%s', async (_name, respond) => {
    failures.set('/auth/v1/user', respond);
    await expect(requireUserAndActiveOrg()).rejects.toMatchObject({ name: 'ActionAuthError', message: SESSION_RETRY });
    await expect(requireVerifiedUser()).rejects.toMatchObject({ name: 'ActionAuthError', message: SESSION_RETRY });
    expect(authLines()).toContain('[auth] gotrue_unavailable');
  });

  it('limit 429: osobny komunikat i wpis w logu bez tokenu i adresu', async () => {
    failures.set('/auth/v1/user', rateLimited);
    await expect(requireUserAndActiveOrg()).rejects.toMatchObject({ name: 'ActionAuthError', message: AUTH_BUSY });
    await expect(requireVerifiedUser()).rejects.toMatchObject({ name: 'ActionAuthError', message: AUTH_BUSY });
    expect(authLines()).toContain('[auth] gotrue_rate_limited');
    expect(authLines()).not.toContain('[auth] gotrue_unavailable');
    expect(wholeLog()).not.toMatch(/eyJ|@example\.test/);
  });

  it('błąd zapytania o członkostwo: „spróbuj ponownie”, nie „Brak dostępu”', async () => {
    failures.set('/rest/v1/memberships', statementTimeout);
    await expect(requireUserAndActiveOrg()).rejects.toMatchObject({ name: 'ActionAuthError', message: MEMBERSHIP_RETRY });
  });

  it('prawdziwa odmowa zostaje odmową', async () => {
    failures.set('/auth/v1/user', tokenRejected);
    await expect(requireUserAndActiveOrg()).rejects.toMatchObject({ message: 'Niezalogowany' });
    await expect(requireVerifiedUser()).rejects.toMatchObject({ message: 'Niezalogowany' });
    expect(authLines()).toEqual([]);
  });

  it('brak członkostwa zostaje odmową', async () => {
    membershipRows = [];
    await expect(requireUserAndActiveOrg()).rejects.toMatchObject({ message: 'Brak dostępu do aktywnej organizacji' });
  });

  it('gdy usługi odpowiadają, działa jak dotąd', async () => {
    await expect(requireUserAndActiveOrg()).resolves.toMatchObject({ tenantId: org, role: 'owner', user: { id: userId } });
    await expect(requireVerifiedUser()).resolves.toMatchObject({ user: { id: userId } });
  });
});

describe('API panelu: awaria to 503, nie 401 ani 403', () => {
  it.each(GOTRUE_FAILING)('%s', async (_name, respond) => {
    failures.set('/auth/v1/user', respond);
    await expect(resolveApiUserAndActiveOrg()).resolves.toEqual({
      ok: false, status: 503, error: 'session_verification_failed',
    });
  });

  it('błąd zapytania o członkostwo: 503 membership_check_failed', async () => {
    failures.set('/rest/v1/memberships', statementTimeout);
    await expect(resolveApiUserAndActiveOrg()).resolves.toEqual({
      ok: false, status: 503, error: 'membership_check_failed',
    });
  });

  it('prawdziwa odmowa zostaje 401, brak członkostwa 403', async () => {
    failures.set('/auth/v1/user', tokenRejected);
    await expect(resolveApiUserAndActiveOrg()).resolves.toEqual({ ok: false, status: 401, error: 'not_authenticated' });
    failures.clear();
    membershipRows = [];
    await expect(resolveApiUserAndActiveOrg()).resolves.toEqual({ ok: false, status: 403, error: 'no_active_org' });
  });

  it('gdy usługi odpowiadają, działa jak dotąd', async () => {
    await expect(resolveApiUserAndActiveOrg()).resolves.toEqual({ ok: true, userId, tenantId: org, role: 'owner' });
  });
});

describe('konto bez firmy (zaproszenia, eksport danych konta): awaria to „spróbuj ponownie”', () => {
  it.each(GOTRUE_DOWN)('%s', async (_name, respond) => {
    failures.set('/auth/v1/user', respond);
    const expected = { ok: false, reason: 'verification_failed', error: SESSION_RETRY };
    await expect(getVerifiedUserContext()).resolves.toEqual(expected);
    await expect(getVerifiedUserContext({ fullMfa: true })).resolves.toEqual(expected);
  });

  it('limit 429: osobny komunikat', async () => {
    failures.set('/auth/v1/user', rateLimited);
    await expect(getVerifiedUserContext()).resolves.toEqual({ ok: false, reason: 'verification_failed', error: AUTH_BUSY });
  });

  it('prawdziwa odmowa zostaje odmową', async () => {
    failures.set('/auth/v1/user', tokenRejected);
    await expect(getVerifiedUserContext()).resolves.toMatchObject({ ok: false, reason: 'unauthenticated' });
  });
});
