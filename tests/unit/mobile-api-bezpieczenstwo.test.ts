import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan aplikacji mobilnej, M10c, część 2: hasło i klucze dostępu z telefonu
 * tymi samymi warunkami co strona.
 *
 * Prawdziwe: trasy, bramka `authenticateMobileRequest` (2FA jak strona),
 * `confirmAccountPassword` (wspólny limit prób, sesja tymczasowa zamykana),
 * `validatePassword`, limity z `lib/rate-limit`, mapowanie odmów GoTrue.
 * Atrapy: HTTP (GoTrue, PostgREST, HIBP), Redis, dziennik zdarzeń.
 */

const SUPABASE_URL = 'https://db.fixture.test';
const SERVICE_KEY = 'service-fixture-key';
const ANON = 'anon-fixture-key';
const USER = 'aaaaaaaa-1111-4111-8111-000000000001';
const GOOGLE = 'aaaaaaaa-1111-4111-8111-000000000002';
const TOTP = 'aaaaaaaa-1111-4111-8111-000000000003';
const KEY_ID = 'dddddddd-0000-4000-8000-000000000001';
const NOW = new Date('2026-11-16T09:00:00Z');
const OBECNE = 'StareHaslo2026!x';
const NOWE = 'NoweHaslo2026!Mocne';

const fake = vi.hoisted(() => {
  const state = { count: 1, redis: true };
  const client = {
    pipeline() {
      const pipe = {
        zremrangebyscore: () => pipe,
        zadd: () => pipe,
        zcard: () => pipe,
        expire: () => pipe,
        exec: async () => [0, 1, state.count, 1],
      };
      return pipe;
    },
    zrange: async () => [],
    zrem: async () => 0,
    // Skrypt limitu prób hasła (`lib/rate-limit/password.ts`): [dozwolone, licznik, ttl].
    eval: async (_skrypt: string, _klucze: string[], [limit, oknoMs]: number[]) =>
      state.count > limit! ? [0, limit, 60_000] : [1, Math.min(limit!, Math.max(1, state.count)), oknoMs! - 1],
  };
  const audit = vi.fn(async (_entry: unknown) => undefined);
  return { client, state, audit };
});

vi.mock('@/lib/cache/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cache/redis')>();
  return {
    ...actual,
    isRedisConfigured: () => fake.state.redis,
    getRedis: () => {
      if (!fake.state.redis) throw new Error('redis off');
      return fake.client;
    },
  };
});
vi.mock('@/lib/feature-flags/maintenance', () => ({ isMaintenanceMode: async () => false, MAINTENANCE_PATH: '/przerwa-techniczna' }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: fake.audit }));

import { POST as kodRoute } from '@/app/api/mobile/v1/ustawienia/haslo/kod/route';
import { POST as hasloRoute } from '@/app/api/mobile/v1/ustawienia/haslo/route';
import { POST as usuniecieRoute } from '@/app/api/mobile/v1/ustawienia/klucze/[id]/usuniecie/route';
import { GET as kluczeRoute } from '@/app/api/mobile/v1/ustawienia/klucze/route';

const b64url = (value: string) => Buffer.from(value).toString('base64url');
function accessToken(sub: string, n: number, aal: 'aal1' | 'aal2' = 'aal1'): string {
  const now = Math.floor(NOW.getTime() / 1000);
  return [
    b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    b64url(JSON.stringify({ aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 3600, sub, aal, session_id: `cccccccc-2222-4222-8222-00000000000${n}`, amr: [{ method: 'password', timestamp: now - 60 }] })),
    b64url('fixture-signature'),
  ].join('.');
}
const TOKEN = accessToken(USER, 1);
const TOKEN_GOOGLE = accessToken(GOOGLE, 2);
const TOKEN_TOTP_AAL1 = accessToken(TOTP, 3, 'aal1');
const TOKEN_TOTP_AAL2 = accessToken(TOTP, 4, 'aal2');
const TMP = accessToken(USER, 9);
const issued = new Map([[TOKEN, USER], [TOKEN_GOOGLE, GOOGLE], [TOKEN_TOTP_AAL1, TOTP], [TOKEN_TOTP_AAL2, TOTP], [TMP, USER]]);
const users: Record<string, { email: string; providers: string[]; password?: string; totp?: boolean }> = {
  [USER]: { email: 'jan@example.test', providers: ['email'], password: OBECNE },
  [GOOGLE]: { email: 'ola@example.test', providers: ['google'] },
  [TOTP]: { email: 'ewa@example.test', providers: ['email'], password: OBECNE, totp: true },
};

type Wyjscie = { metoda: string; sciezka: string; token: string | null; apikey: string | null; tresc: unknown; zakres: string | null };
let wyjscia: Wyjscie[] = [];
let odpowiedzZapisu: { status: number; body: Record<string, unknown> } | null = null;
let klucze: Array<Record<string, unknown>> = [];

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin === 'https://api.pwnedpasswords.com') return new Response('0000000000000000000000000000000000A:1\n', { status: 200 });
  if (url.origin !== SUPABASE_URL) throw new Error(`nieoczekiwane wyjście do ${url.origin}`);
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? null;
  const tekst = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
  wyjscia.push({ metoda: request.method, sciezka: url.pathname, token, apikey: request.headers.get('apikey'), tresc: tekst ? JSON.parse(tekst) : null, zakres: url.searchParams.get('scope') });
  const sub = token ? issued.get(token) : undefined;

  if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
    const body = JSON.parse(tekst) as { email: string; password: string };
    const entry = Object.entries(users).find(([, u]) => u.email === body.email);
    if (!entry || entry[1].password !== body.password) return Response.json({ error: 'invalid_grant', error_description: 'Invalid login credentials', error_code: 'invalid_credentials' }, { status: 400 });
    return Response.json({ access_token: TMP, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, user: { id: entry[0], email: body.email, aud: 'authenticated' } });
  }
  if (url.pathname === '/auth/v1/logout') return new Response(null, { status: 204 });
  if (url.pathname === '/auth/v1/user') {
    if (!sub) return Response.json({ msg: 'invalid JWT', error_code: 'bad_jwt' }, { status: 401 });
    if (request.method === 'PUT') {
      if (odpowiedzZapisu) return Response.json(odpowiedzZapisu.body, { status: odpowiedzZapisu.status });
      return Response.json({ id: sub, email: users[sub]!.email });
    }
    const u = users[sub]!;
    const factors = u.totp ? [{ id: 'f-1', factor_type: 'totp', status: 'verified' }] : [];
    return Response.json({ id: sub, aud: 'authenticated', role: 'authenticated', email: u.email, factors, app_metadata: { provider: u.providers[0], providers: u.providers } });
  }
  if (url.pathname === '/auth/v1/reauthenticate') return sub ? Response.json({}) : Response.json({ error_code: 'bad_jwt' }, { status: 401 });
  if (!sub) return Response.json({ message: 'JWT invalid' }, { status: 401 });
  if (url.pathname === '/rest/v1/user_passkeys') {
    const id = url.searchParams.get('id')?.replace(/^eq\./, '');
    const mine = klucze.filter((k) => k.user_id === sub);
    if (request.method === 'DELETE') {
      const usuwane = mine.filter((k) => k.id === id);
      klucze = klucze.filter((k) => !usuwane.includes(k));
      return Response.json(usuwane.map((k) => ({ id: k.id, device_label: k.device_label })));
    }
    return Response.json(mine);
  }
  return Response.json({ message: `nieznana ścieżka ${url.pathname}` }, { status: 404 });
}

let ip = 0;
function req(path: string, options: { token?: string | null; body?: unknown; method?: string } = {}): Request {
  const headers: Record<string, string> = { 'x-real-ip': `198.51.100.${(ip += 1) % 250}` };
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN}`;
  const method = options.method ?? 'POST';
  if (method !== 'GET') headers['content-type'] = 'application/json';
  return new Request(`https://app.example.test/api/mobile/v1/ustawienia/${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const haslo = (body: unknown, token?: string) => hasloRoute(req('haslo', { body, token }));
const zapisyHasla = () => wyjscia.filter((w) => w.sciezka === '/auth/v1/user' && w.metoda === 'PUT');

beforeEach(() => {
  wyjscia = [];
  odpowiedzZapisu = null;
  fake.state.count = 1;
  fake.state.redis = true;
  fake.audit.mockClear();
  klucze = [
    { id: KEY_ID, user_id: USER, device_label: 'iPhone Jana', backed_up: true, created_at: '2026-10-01T10:00:00Z', last_used_at: '2026-11-10T08:00:00Z' },
    { id: 'dddddddd-0000-4000-8000-000000000002', user_id: GOOGLE, device_label: 'Cudzy', backed_up: false, created_at: '2026-10-02T10:00:00Z', last_used_at: null },
  ];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', ANON);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.fixture.test');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'redis-fixture-token');
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('bramka tras Bezpieczeństwa', () => {
  const trasy = [
    ['haslo', (r: Request) => hasloRoute(r)],
    ['haslo/kod', (r: Request) => kodRoute(r)],
    ['klucze', (r: Request) => kluczeRoute(new Request(r.url, { method: 'GET', headers: r.headers }))],
    [`klucze/${KEY_ID}/usuniecie`, (r: Request) => usuniecieRoute(r, params(KEY_ID))],
  ] as const;

  it.each(trasy)('%s: bez tokenu 401 `missing_token`, zły token 401 `invalid_token`, nic się nie zmienia', async (sciezka, trasa) => {
    const bez = await trasa(req(sciezka, { token: null, body: { obecne: OBECNE, nowe: NOWE } }));
    expect(bez.status).toBe(401);
    expect((await bez.json()).error.code).toBe('missing_token');
    const zly = await trasa(req(sciezka, { token: accessToken('bbbbbbbb-9999-4999-8999-000000000009', 8), body: { obecne: OBECNE, nowe: NOWE } }));
    expect(zly.status).toBe(401);
    expect((await zly.json()).error.code).toBe('invalid_token');
    expect(zapisyHasla()).toEqual([]);
    expect(klucze).toHaveLength(2);
    expect(fake.audit).not.toHaveBeenCalled();
  });

  it('konto z 2FA bez kodu w tej sesji (AAL1): 403 `mfa_required`, jak strona; po kodzie (AAL2) przechodzi', async () => {
    const bezKodu = await haslo({ obecne: OBECNE, nowe: NOWE }, TOKEN_TOTP_AAL1);
    expect(bezKodu.status).toBe(403);
    expect((await bezKodu.json()).error.code).toBe('mfa_required');
    expect(zapisyHasla()).toEqual([]);
    expect((await haslo({ obecne: OBECNE, nowe: NOWE }, TOKEN_TOTP_AAL2)).status).toBe(200);
  });
});

describe('POST /api/mobile/v1/ustawienia/haslo', () => {
  it('zmiana hasła: aktualne sprawdzone w sesji tymczasowej (zamkniętej), zapis tokenem telefonu z `current_password`, wpis w dzienniku', async () => {
    const response = await haslo({ obecne: OBECNE, nowe: NOWE });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ zmienione: true });
    const logowanie = wyjscia.find((w) => w.sciezka === '/auth/v1/token');
    expect(logowanie?.apikey).toBe(SERVICE_KEY);
    expect(wyjscia.some((w) => w.sciezka === '/auth/v1/logout' && w.token === TMP && w.zakres === 'local')).toBe(true);
    expect(zapisyHasla()).toEqual([expect.objectContaining({ token: TOKEN, apikey: ANON, tresc: { password: NOWE, current_password: OBECNE } })]);
    expect(fake.audit).toHaveBeenCalledWith({ action: 'auth.password_changed', tenantId: null, userId: USER, metadata: { client: 'mobile' } });
  });

  it('złe aktualne hasło: 422 pod polem `obecne`, bez zapisu', async () => {
    const response = await haslo({ obecne: 'Zle-haslo-123!', nowe: NOWE });
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatchObject({ code: 'settings_invalid', field: 'obecne' });
    expect(zapisyHasla()).toEqual([]);
  });

  it('słabe nowe hasło: 422 pod polem `nowe` (po sprawdzeniu aktualnego, jak strona), bez zapisu', async () => {
    const response = await haslo({ obecne: OBECNE, nowe: 'krotkie' });
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatchObject({ code: 'settings_invalid', field: 'nowe' });
    expect(zapisyHasla()).toEqual([]);
  });

  it('GoTrue żąda kodu z e-maila: 409 `password_code_required`; z kodem zapis niesie `nonce`', async () => {
    odpowiedzZapisu = { status: 400, body: { error_code: 'reauthentication_needed', msg: 'Password update requires reauthentication' } };
    const bezKodu = await haslo({ obecne: OBECNE, nowe: NOWE });
    expect(bezKodu.status).toBe(409);
    expect((await bezKodu.json()).error.code).toBe('password_code_required');
    expect(fake.audit).not.toHaveBeenCalled();

    odpowiedzZapisu = null;
    expect((await haslo({ obecne: OBECNE, nowe: NOWE, kod: '123456' })).status).toBe(200);
    expect(zapisyHasla().at(-1)?.tresc).toEqual({ password: NOWE, current_password: OBECNE, nonce: '123456' });
  });

  it.each([
    ['zły kod z e-maila', { error_code: 'reauthentication_not_valid' }, 'kod'],
    ['to samo hasło', { error_code: 'same_password' }, 'nowe'],
  ])('%s: 422 pod polem', async (_opis, body, pole) => {
    odpowiedzZapisu = { status: 422, body };
    const response = await haslo({ obecne: OBECNE, nowe: NOWE, kod: '123456' });
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatchObject({ code: 'settings_invalid', field: pole });
  });

  it('kod nie z cyfr: 422 pod polem `kod`, bez sprawdzania hasła', async () => {
    const response = await haslo({ obecne: OBECNE, nowe: NOWE, kod: 'abc' });
    expect((await response.json()).error).toMatchObject({ code: 'settings_invalid', field: 'kod' });
    expect(wyjscia.some((w) => w.sciezka === '/auth/v1/token')).toBe(false);
  });

  it('konto tylko z Google: 403 `forbidden` z drogą na stronie, bez logowania hasłem', async () => {
    const response = await haslo({ obecne: OBECNE, nowe: NOWE }, TOKEN_GOOGLE);
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('forbidden');
    expect(wyjscia.some((w) => w.sciezka === '/auth/v1/token')).toBe(false);
  });

  it('bez Redisa limit prób hasła odmawia (fail-closed): 503, bez logowania i zapisu', async () => {
    fake.state.redis = false;
    const response = await haslo({ obecne: OBECNE, nowe: NOWE });
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('service_unavailable');
    expect(wyjscia.some((w) => w.sciezka === '/auth/v1/token')).toBe(false);
    expect(zapisyHasla()).toEqual([]);
  });

  it('GoTrue odrzuca token po bramce (sesja wygasła w międzyczasie): 401 `invalid_token`, telefon odświeży sesję', async () => {
    odpowiedzZapisu = { status: 401, body: { error_code: 'bad_jwt', msg: 'invalid JWT' } };
    const response = await haslo({ obecne: OBECNE, nowe: NOWE });
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('invalid_token');
    expect(fake.audit).not.toHaveBeenCalled();
  });

  it('awaria GoTrue przy zapisie: 503, bez wpisu w dzienniku', async () => {
    odpowiedzZapisu = { status: 500, body: { msg: 'boom' } };
    expect((await haslo({ obecne: OBECNE, nowe: NOWE })).status).toBe(503);
    expect(fake.audit).not.toHaveBeenCalled();
  });

  it('treść spoza kontraktu: 400 `invalid_request`', async () => {
    expect((await haslo({ obecne: OBECNE, nowe: NOWE, email: 'x@example.test' })).status).toBe(400);
    expect(zapisyHasla()).toEqual([]);
  });
});

describe('POST /api/mobile/v1/ustawienia/haslo/kod', () => {
  it('wysyła kod tokenem telefonu po sprawdzeniu aktualnego hasła', async () => {
    const response = await kodRoute(req('haslo/kod', { body: { obecne: OBECNE } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ wyslany: true });
    expect(wyjscia.find((w) => w.sciezka === '/auth/v1/reauthenticate')).toMatchObject({ metoda: 'GET', token: TOKEN });
  });

  it('złe hasło: 422, kod nie wychodzi', async () => {
    const response = await kodRoute(req('haslo/kod', { body: { obecne: 'Zle-haslo-123!' } }));
    expect((await response.json()).error).toMatchObject({ code: 'settings_invalid', field: 'obecne' });
    expect(wyjscia.some((w) => w.sciezka === '/auth/v1/reauthenticate')).toBe(false);
  });

  it('bez Redisa limit wysyłek odmawia (fail-closed): 503, kod nie wychodzi', async () => {
    fake.state.redis = false;
    const response = await kodRoute(req('haslo/kod', { body: { obecne: OBECNE } }));
    expect(response.status).toBe(503);
    expect(wyjscia.some((w) => w.sciezka === '/auth/v1/token' || w.sciezka === '/auth/v1/reauthenticate')).toBe(false);
  });

  it('limit wysyłek strony wyczerpany: 429 z `Retry-After`, bez sprawdzania hasła i wysyłki', async () => {
    fake.state.count = 100;
    const response = await kodRoute(req('haslo/kod', { body: { obecne: OBECNE } }));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBeTruthy();
    expect(wyjscia.some((w) => w.sciezka === '/auth/v1/token' || w.sciezka === '/auth/v1/reauthenticate')).toBe(false);
  });
});

describe('klucze dostępu', () => {
  it('GET: tylko klucze tego konta, tokenem telefonu', async () => {
    const response = await kluczeRoute(req('klucze', { method: 'GET' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      klucze: [{ id: KEY_ID, nazwa: 'iPhone Jana', kopiaWChmurze: true, dodany: '2026-10-01T10:00:00Z', ostatnio: '2026-11-10T08:00:00Z' }],
    });
    const odczyt = wyjscia.find((w) => w.sciezka === '/rest/v1/user_passkeys');
    expect(odczyt?.token).toBe(TOKEN);
  });

  it('usunięcie: klucz znika, pozostałe sesje wylogowane tokenem telefonu (`scope=others`), wpis w dzienniku', async () => {
    const response = await usuniecieRoute(req(`klucze/${KEY_ID}/usuniecie`), params(KEY_ID));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ usuniety: true, inneWylogowane: true });
    expect(klucze.map((k) => k.id)).not.toContain(KEY_ID);
    expect(wyjscia.some((w) => w.sciezka === '/auth/v1/logout' && w.zakres === 'others' && w.token === TOKEN)).toBe(true);
    expect(fake.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.passkey_removed', userId: USER, metadata: expect.objectContaining({ passkey_id: KEY_ID, others_signed_out: true, client: 'mobile' }) }));
  });

  it('cudzy klucz i ponowienie: 404, nic nie znika, bez wylogowania', async () => {
    const cudzy = 'dddddddd-0000-4000-8000-000000000002';
    const response = await usuniecieRoute(req(`klucze/${cudzy}/usuniecie`), params(cudzy));
    expect(response.status).toBe(404);
    expect(klucze.map((k) => k.id)).toContain(cudzy);
    expect(wyjscia.some((w) => w.zakres === 'others')).toBe(false);
  });

  it('identyfikator nie UUID: 404 bez zapytania do bazy', async () => {
    const response = await usuniecieRoute(req('klucze/abc/usuniecie'), params('abc'));
    expect(response.status).toBe(404);
    expect(wyjscia.some((w) => w.sciezka === '/rest/v1/user_passkeys')).toBe(false);
  });

  it('limit zmian kluczy wyczerpany: 429, klucz zostaje', async () => {
    fake.state.count = 100;
    const response = await usuniecieRoute(req(`klucze/${KEY_ID}/usuniecie`), params(KEY_ID));
    expect(response.status).toBe(429);
    expect(klucze.map((k) => k.id)).toContain(KEY_ID);
  });
});

describe('kontrakt Bezpieczeństwa', () => {
  it('plik kontraktu nie ma importów (czyta go Metro)', () => {
    const source = readFileSync(resolve(__dirname, '../../lib/api/mobile/kontrakt-bezpieczenstwo.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
  });
});
