import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan aplikacji mobilnej, M10c, część 2b: włączanie i wyłączanie 2FA (TOTP)
 * oraz wgranie certyfikatu KSeF z telefonu tymi samymi warunkami co strona.
 *
 * Prawdziwe: trasy, bramka `authenticateMobileRequest`, `confirmAccountPassword`
 * (wspólny limit prób), limit prób 2FA (`checkMfaRateLimit`), sprawdzenie nowej
 * sesji po kodzie (`verifyMobileToken`). Atrapy: HTTP (GoTrue, PostgREST), Redis,
 * dziennik zdarzeń i rdzeń wgrania certyfikatu (`uploadKsefCertificate`: jego
 * logikę, XAdES i RPC pokrywa `ksef-certificate-claim-action.test.ts` na tym
 * samym kodzie, którym woła go strona).
 */

const SUPABASE_URL = 'https://db.fixture.test';
const SERVICE_KEY = 'service-fixture-key';
const ANON = 'anon-fixture-key';
const ORG = 'aaaaaaaa-0000-4000-8000-000000000001';
const U_NO2FA = 'aaaaaaaa-1111-4111-8111-000000000001';
const U_2FA = 'aaaaaaaa-1111-4111-8111-000000000002';
const U_MEMBER = 'aaaaaaaa-1111-4111-8111-000000000003';
const U_GOOGLE = 'aaaaaaaa-1111-4111-8111-000000000004';
const U_DWA = 'aaaaaaaa-1111-4111-8111-000000000005';
const FACTOR_OLD = 'ffffffff-0000-4000-8000-000000000001';
const FACTOR_NEW = 'ffffffff-0000-4000-8000-000000000002';
const FACTOR_2FA = 'ffffffff-0000-4000-8000-000000000003';
const NOW = new Date('2026-11-20T09:00:00Z');
const HASLO = 'StareHaslo2026!x';
const KOD = '123456';

const fake = vi.hoisted(() => {
  const state = { count: 1, redis: true };
  const client = {
    pipeline() {
      const pipe = {
        zremrangebyscore: () => pipe,
        zadd: () => pipe,
        zcard: () => pipe,
        expire: () => pipe,
        exec: async () => [0, 1, 1, 1],
      };
      return pipe;
    },
    zrange: async () => [],
    zrem: async () => 0,
    // Skrypty limitów (`lib/rate-limit/password.ts`, `mfa.ts`): [dozwolone, licznik, ttl].
    eval: async (_skrypt: string, _klucze: string[], [limit, oknoMs]: number[]) =>
      state.count > limit! ? [0, limit, 60_000] : [1, Math.min(limit!, Math.max(1, state.count)), oknoMs! - 1],
  };
  const audit = vi.fn(async (_entry: unknown) => undefined);
  const upload = vi.fn();
  const recovery = vi.fn(async () => undefined);
  return { client, state, audit, upload, recovery };
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
vi.mock('@/lib/ksef/upload-certificate', () => ({ uploadKsefCertificate: fake.upload }));
vi.mock('@/lib/auth/mfa-recovery', () => ({ deleteAllRecoveryCodes: fake.recovery }));

import { POST as ksefRoute } from '@/app/api/mobile/v1/ustawienia/ksef/route';
import { POST as potwierdzenieRoute } from '@/app/api/mobile/v1/ustawienia/2fa/potwierdzenie/route';
import { POST as startRoute } from '@/app/api/mobile/v1/ustawienia/2fa/start/route';
import { POST as wylaczenieRoute } from '@/app/api/mobile/v1/ustawienia/2fa/wylaczenie/route';

const b64url = (value: string) => Buffer.from(value).toString('base64url');
let tokenN = 0;
function accessToken(sub: string, aal: 'aal1' | 'aal2'): string {
  tokenN += 1;
  const now = Math.floor(NOW.getTime() / 1000);
  return [
    b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    b64url(JSON.stringify({ aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 3600, sub, aal, session_id: `cccccccc-2222-4222-8222-0000000000${String(tokenN).padStart(2, '0')}`, amr: [{ method: 'password', timestamp: now - 60 }] })),
    b64url('fixture-signature'),
  ].join('.');
}
const issued = new Map<string, string>();
function token(sub: string, aal: 'aal1' | 'aal2'): string {
  const t = accessToken(sub, aal);
  issued.set(t, sub);
  return t;
}

type Faktor = { id: string; factor_type: string; status: string };
const users: Record<string, { email: string; providers: string[]; password?: string; factors: Faktor[] }> = {};
const memberships = [
  { user_id: U_NO2FA, organization_id: ORG, role: 'owner', status: 'active' },
  { user_id: U_2FA, organization_id: ORG, role: 'owner', status: 'active' },
  { user_id: U_MEMBER, organization_id: ORG, role: 'member', status: 'active' },
];

type Wyjscie = { metoda: string; sciezka: string; token: string | null; tresc: unknown };
let wyjscia: Wyjscie[] = [];
let kodPoprawny = KOD;
let awariaUsuwania: string | null = null;
/** Atrapa GoTrue przy kodzie: sesja po kodzie jest AAL1 (błąd po stronie GoTrue), nie AAL2. */
let weryfikacjaAal1 = false;

const eq = (url: URL, column: string) => {
  const value = url.searchParams.get(column);
  return value?.startsWith('eq.') ? decodeURIComponent(value.slice(3)) : null;
};

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== SUPABASE_URL) throw new Error(`nieoczekiwane wyjście do ${url.origin}`);
  const tok = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? null;
  const tekst = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
  wyjscia.push({ metoda: request.method, sciezka: url.pathname, token: tok, tresc: tekst ? JSON.parse(tekst) : null });
  const sub = tok ? issued.get(tok) : undefined;

  if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
    const body = JSON.parse(tekst) as { email: string; password: string };
    const entry = Object.entries(users).find(([, u]) => u.email === body.email);
    if (!entry || entry[1].password !== body.password) return Response.json({ error: 'invalid_grant', error_code: 'invalid_credentials' }, { status: 400 });
    const tmp = token(entry[0], 'aal1');
    return Response.json({ access_token: tmp, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, user: { id: entry[0], email: body.email, aud: 'authenticated' } });
  }
  if (url.pathname === '/auth/v1/logout') return new Response(null, { status: 204 });
  if (!sub) return Response.json({ msg: 'invalid JWT', error_code: 'bad_jwt', message: 'JWT invalid' }, { status: 401 });
  const u = users[sub]!;

  if (url.pathname === '/auth/v1/user') {
    return Response.json({ id: sub, aud: 'authenticated', role: 'authenticated', email: u.email, factors: u.factors, app_metadata: { provider: u.providers[0], providers: u.providers } });
  }
  if (url.pathname === '/auth/v1/factors' && request.method === 'POST') {
    u.factors.push({ id: FACTOR_NEW, factor_type: 'totp', status: 'unverified' });
    return Response.json({ id: FACTOR_NEW, type: 'totp', totp: { qr_code: '<svg/>', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/FaktWay:jan?secret=JBSWY3DPEHPK3PXP&issuer=FaktWay' } });
  }
  const faktor = /^\/auth\/v1\/factors\/([^/]+)(?:\/(challenge|verify))?$/.exec(url.pathname);
  if (faktor) {
    const [, id, akcja] = faktor;
    if (request.method === 'DELETE') {
      if (awariaUsuwania === id) return Response.json({ msg: 'boom' }, { status: 500 });
      u.factors = u.factors.filter((f) => f.id !== id);
      return Response.json({ id });
    }
    if (akcja === 'challenge') return Response.json({ id: 'chal-1' });
    if (akcja === 'verify') {
      const body = JSON.parse(tekst) as { code: string };
      if (body.code !== kodPoprawny) return Response.json({ error_code: 'mfa_verification_failed', msg: 'Invalid TOTP code entered' }, { status: 422 });
      u.factors = u.factors.map((f) => (f.id === id ? { ...f, status: 'verified' } : f));
      return Response.json({ access_token: token(sub, weryfikacjaAal1 ? 'aal1' : 'aal2'), refresh_token: 'nowy-refresh', token_type: 'bearer', expires_in: 3600 });
    }
  }
  if (url.pathname === '/rest/v1/memberships') {
    const asObject = request.headers.get('accept')?.includes('vnd.pgrst.object');
    const rows = memberships.filter((m) => m.user_id === sub && (eq(url, 'organization_id') === null || m.organization_id === eq(url, 'organization_id')));
    return asObject ? (rows[0] ? Response.json(rows[0]) : Response.json({ code: 'PGRST116' }, { status: 406 })) : Response.json(rows);
  }
  return Response.json({ message: `nieznana ścieżka ${url.pathname}` }, { status: 404 });
}

let ip = 0;
function req(path: string, options: { token?: string | null; body?: unknown; org?: boolean } = {}): Request {
  const headers: Record<string, string> = { 'x-real-ip': `198.51.100.${(ip += 1) % 250}`, 'content-type': 'application/json' };
  if (options.token !== null) headers.authorization = `Bearer ${options.token}`;
  if (options.org) headers['x-active-org'] = ORG;
  return new Request(`https://app.example.test/api/mobile/v1/ustawienia/${path}`, { method: 'POST', headers, body: JSON.stringify(options.body ?? {}) });
}
let T_NO2FA = '';
let T_2FA = '';
let T_2FA_AAL1 = '';
let T_MEMBER = '';
let T_GOOGLE = '';
let T_DWA = '';

beforeEach(() => {
  wyjscia = [];
  kodPoprawny = KOD;
  awariaUsuwania = null;
  weryfikacjaAal1 = false;
  fake.state.count = 1;
  fake.state.redis = true;
  fake.audit.mockClear();
  fake.upload.mockReset();
  fake.recovery.mockReset();
  fake.recovery.mockImplementation(async () => undefined);
  issued.clear();
  users[U_NO2FA] = { email: 'jan@example.test', providers: ['email'], password: HASLO, factors: [{ id: FACTOR_OLD, factor_type: 'totp', status: 'unverified' }] };
  users[U_2FA] = { email: 'ewa@example.test', providers: ['email'], password: HASLO, factors: [{ id: FACTOR_2FA, factor_type: 'totp', status: 'verified' }] };
  users[U_MEMBER] = { email: 'kasia@example.test', providers: ['email'], password: HASLO, factors: [{ id: 'ffffffff-0000-4000-8000-000000000009', factor_type: 'totp', status: 'verified' }] };
  users[U_GOOGLE] = { email: 'ola@example.test', providers: ['google'], factors: [{ id: 'ffffffff-0000-4000-8000-00000000000a', factor_type: 'totp', status: 'verified' }] };
  users[U_DWA] = {
    email: 'dwa@example.test',
    providers: ['email'],
    password: HASLO,
    factors: [
      { id: 'ffffffff-0000-4000-8000-00000000000b', factor_type: 'totp', status: 'verified' },
      { id: 'ffffffff-0000-4000-8000-00000000000c', factor_type: 'totp', status: 'verified' },
    ],
  };
  T_GOOGLE = token(U_GOOGLE, 'aal2');
  T_DWA = token(U_DWA, 'aal2');
  T_NO2FA = token(U_NO2FA, 'aal1');
  T_2FA = token(U_2FA, 'aal2');
  T_2FA_AAL1 = token(U_2FA, 'aal1');
  T_MEMBER = token(U_MEMBER, 'aal2');
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

const zapisyGoTrue = (metoda: string, sciezka: RegExp) => wyjscia.filter((w) => w.metoda === metoda && sciezka.test(w.sciezka));

describe('bramka tras 2FA i certyfikatu KSeF', () => {
  const trasy = [
    ['2fa/start', (r: Request) => startRoute(r), false],
    ['2fa/potwierdzenie', (r: Request) => potwierdzenieRoute(r), false],
    ['2fa/wylaczenie', (r: Request) => wylaczenieRoute(r), false],
    ['ksef', (r: Request) => ksefRoute(r), true],
  ] as const;

  it.each(trasy)('%s: bez tokenu 401 `missing_token`, zły token 401 `invalid_token`, nic się nie zmienia', async (sciezka, trasa, org) => {
    const bez = await trasa(req(sciezka, { token: null, org, body: {} }));
    expect(bez.status).toBe(401);
    expect((await bez.json()).error.code).toBe('missing_token');
    const zly = await trasa(req(sciezka, { token: accessToken('bbbbbbbb-9999-4999-8999-000000000009', 'aal1'), org, body: {} }));
    expect(zly.status).toBe(401);
    expect((await zly.json()).error.code).toBe('invalid_token');
    expect(wyjscia.filter((w) => w.metoda !== 'GET')).toEqual([]);
    expect(fake.audit).not.toHaveBeenCalled();
    expect(fake.upload).not.toHaveBeenCalled();
  });

  it('konto z 2FA bez kodu w tej sesji (AAL1): 403 `mfa_required` na wyłączeniu i na certyfikacie', async () => {
    const wylaczenie = await wylaczenieRoute(req('2fa/wylaczenie', { token: T_2FA_AAL1, body: { haslo: HASLO } }));
    expect(wylaczenie.status).toBe(403);
    expect((await wylaczenie.json()).error.code).toBe('mfa_required');
    const ksef = await ksefRoute(req('ksef', { token: T_2FA_AAL1, org: true, body: { certyfikat: 'AAAA', klucz: 'BBBB' } }));
    expect(ksef.status).toBe(403);
    expect((await ksef.json()).error.code).toBe('mfa_required');
    expect(fake.upload).not.toHaveBeenCalled();
    expect(zapisyGoTrue('DELETE', /factors/)).toEqual([]);
  });
});

describe('POST /ustawienia/2fa/start', () => {
  it('zakłada czynnik tokenem telefonu, najpierw usuwa stary niepotwierdzony, oddaje sekret i adres otpauth', async () => {
    const response = await startRoute(req('2fa/start', { token: T_NO2FA }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ idFaktora: FACTOR_NEW, sekret: 'JBSWY3DPEHPK3PXP', uri: expect.stringMatching(/^otpauth:\/\/totp\//) });
    const usuniecie = zapisyGoTrue('DELETE', /factors/);
    expect(usuniecie).toEqual([expect.objectContaining({ sciezka: `/auth/v1/factors/${FACTOR_OLD}`, token: T_NO2FA })]);
    const zalozenie = zapisyGoTrue('POST', /^\/auth\/v1\/factors$/);
    expect(zalozenie[0]).toMatchObject({ token: T_NO2FA, tresc: { factor_type: 'totp', friendly_name: 'FaktWay 2026-11-20' } });
    expect(wyjscia.indexOf(usuniecie[0]!)).toBeLessThan(wyjscia.indexOf(zalozenie[0]!));
    expect(fake.audit).not.toHaveBeenCalled();
  });

  it('konto z włączonym 2FA: 422, nic nie zakłada', async () => {
    const response = await startRoute(req('2fa/start', { token: T_2FA }));
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatchObject({ code: 'settings_invalid', message: 'Weryfikacja dwuetapowa jest już włączona.' });
    expect(zapisyGoTrue('POST', /^\/auth\/v1\/factors$/)).toEqual([]);
  });

  it('bez Redisa limit prób 2FA odmawia (fail-closed): 503, czynnik nie powstaje', async () => {
    fake.state.redis = false;
    const response = await startRoute(req('2fa/start', { token: T_NO2FA }));
    expect(response.status).toBe(503);
    expect(zapisyGoTrue('POST', /^\/auth\/v1\/factors$/)).toEqual([]);
  });

  it('limit prób wyczerpany: 429 z `Retry-After`', async () => {
    fake.state.count = 100;
    const response = await startRoute(req('2fa/start', { token: T_NO2FA }));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBeTruthy();
  });
});

describe('POST /ustawienia/2fa/potwierdzenie', () => {
  const potwierdz = (body: unknown, tok = T_NO2FA) => potwierdzenieRoute(req('2fa/potwierdzenie', { token: tok, body }));

  beforeEach(() => {
    users[U_NO2FA]!.factors = [{ id: FACTOR_NEW, factor_type: 'totp', status: 'unverified' }];
  });

  it('dobry kod: wyzwanie i kod w GoTrue tokenem telefonu, nowa sesja sprawdzona, wpis w dzienniku, tokenów nie oddaje', async () => {
    const response = await potwierdz({ idFaktora: FACTOR_NEW, kod: KOD });
    expect(response.status).toBe(200);
    // Nowa sesja po kodzie (AAL2) dla `setSession`: GoTrue unieważnia stary refresh token, więc telefon nie może odświeżać starym.
    const body = await response.json();
    expect(body).toEqual({ wlaczone: true, sesja: { accessToken: expect.any(String), refreshToken: 'nowy-refresh' } });
    expect(JSON.parse(Buffer.from(body.sesja.accessToken.split('.')[1], 'base64url').toString())).toMatchObject({ sub: U_NO2FA, aal: 'aal2' });
    expect(zapisyGoTrue('POST', /challenge$/)[0]).toMatchObject({ token: T_NO2FA });
    expect(zapisyGoTrue('POST', /verify$/)[0]).toMatchObject({ token: T_NO2FA, tresc: { challenge_id: 'chal-1', code: KOD } });
    expect(users[U_NO2FA]!.factors[0]!.status).toBe('verified');
    expect(fake.audit).toHaveBeenCalledWith({ action: 'auth.mfa_enrolled', tenantId: null, userId: U_NO2FA, metadata: { factor_id: FACTOR_NEW, client: 'mobile' } });
  });

  it('zły kod: 422 pod polem `kod`, bez wpisu o włączeniu', async () => {
    const response = await potwierdz({ idFaktora: FACTOR_NEW, kod: '654321' });
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatchObject({ code: 'settings_invalid', field: 'kod' });
    expect(users[U_NO2FA]!.factors[0]!.status).toBe('unverified');
    expect(fake.audit).not.toHaveBeenCalled();
  });

  it('kod nie z sześciu cyfr: 422 bez GoTrue i bez zużycia próby', async () => {
    const response = await potwierdz({ idFaktora: FACTOR_NEW, kod: '12ab' });
    expect((await response.json()).error).toMatchObject({ code: 'settings_invalid', field: 'kod' });
    expect(zapisyGoTrue('POST', /challenge$/)).toEqual([]);
  });

  it('cudzy albo nieistniejący czynnik oraz identyfikator nie z UUID: 422 „wygasło”, bez wyzwania', async () => {
    for (const idFaktora of ['ffffffff-0000-4000-8000-0000000000aa', 'abc']) {
      const response = await potwierdz({ idFaktora, kod: KOD });
      expect(response.status).toBe(422);
      expect((await response.json()).error.message).toContain('wygasło');
    }
    expect(zapisyGoTrue('POST', /challenge$/)).toEqual([]);
  });

  it('konto z włączonym 2FA: 422, bez wyzwania', async () => {
    const response = await potwierdz({ idFaktora: FACTOR_2FA, kod: KOD }, T_2FA);
    expect(response.status).toBe(422);
    expect(zapisyGoTrue('POST', /challenge$/)).toEqual([]);
  });

  it('bez Redisa: 503 (fail-closed), kod nie jest sprawdzany', async () => {
    fake.state.redis = false;
    const response = await potwierdz({ idFaktora: FACTOR_NEW, kod: KOD });
    expect(response.status).toBe(503);
    expect(zapisyGoTrue('POST', /challenge$/)).toEqual([]);
  });

  it('treść spoza kontraktu: 400 `invalid_request`', async () => {
    expect((await potwierdz({ idFaktora: FACTOR_NEW, kod: KOD, sekret: 'x' })).status).toBe(400);
  });

  it('GoTrue przyjął kod, ale nowa sesja nie jest AAL2: 503, zero wpisów w dzienniku, bez tokenów w odpowiedzi', async () => {
    weryfikacjaAal1 = true;
    const response = await potwierdz({ idFaktora: FACTOR_NEW, kod: KOD });
    expect(response.status).toBe(503);
    const tekst = await response.text();
    expect(tekst).not.toContain('nowy-refresh');
    expect(fake.audit).not.toHaveBeenCalled();
  });

  it('sekret TOTP, kod i hasło nie trafiają do console.error', async () => {
    const blad = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await startRoute(req('2fa/start', { token: T_NO2FA }));
    await potwierdz({ idFaktora: FACTOR_NEW, kod: '654321' });
    await wylaczenieRoute(req('2fa/wylaczenie', { token: T_2FA, body: { haslo: 'Zle-haslo-123!' } }));
    const wszystko = JSON.stringify(blad.mock.calls);
    for (const poufne of ['JBSWY3DPEHPK3PXP', '654321', 'Zle-haslo-123!', HASLO]) expect(wszystko).not.toContain(poufne);
    blad.mockRestore();
  });
});

describe('POST /ustawienia/2fa/wylaczenie', () => {
  const wylacz = (body: unknown, tok = T_2FA) => wylaczenieRoute(req('2fa/wylaczenie', { token: tok, body }));

  it('po haśle: kody ratunkowe usunięte przed czynnikami, czynnik TOTP usunięty tokenem telefonu, wpis w dzienniku', async () => {
    const response = await wylacz({ haslo: HASLO });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ wylaczone: true });
    expect(fake.recovery).toHaveBeenCalledWith(U_2FA);
    expect(zapisyGoTrue('DELETE', /factors/)).toEqual([expect.objectContaining({ sciezka: `/auth/v1/factors/${FACTOR_2FA}`, token: T_2FA })]);
    // Kody ratunkowe przed czynnikami: nieudane sprzątanie zatrzymuje operację (test niżej).
    expect(users[U_2FA]!.factors).toEqual([]);
    expect(fake.audit).toHaveBeenCalledWith({ action: 'auth.mfa_unenrolled', tenantId: null, userId: U_2FA, metadata: { factor_type: 'totp', removed_count: 1, client: 'mobile' } });
  });

  it('częściowa porażka (dwa czynniki, drugi nie schodzi): 503 do ponowienia, bez wpisu w dzienniku; ponowienie dokańcza', async () => {
    awariaUsuwania = 'ffffffff-0000-4000-8000-00000000000c';
    const response = await wylacz({ haslo: HASLO }, T_DWA);
    expect(response.status).toBe(503);
    expect((await response.json()).error.message).toContain('Spróbuj ponownie');
    expect(users[U_DWA]!.factors.map((f) => f.id)).toEqual(['ffffffff-0000-4000-8000-00000000000c']);
    expect(fake.audit).not.toHaveBeenCalled();
    awariaUsuwania = null;
    expect((await wylacz({ haslo: HASLO }, T_DWA)).status).toBe(200);
    expect(users[U_DWA]!.factors).toEqual([]);
  });

  it('konto tylko z Google (bez hasła): 403 `forbidden` z drogą na stronie, bez logowania hasłem', async () => {
    const response = await wylacz({ haslo: HASLO }, T_GOOGLE);
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('forbidden');
    expect(wyjscia.some((w) => w.sciezka === '/auth/v1/token')).toBe(false);
  });

  it('złe hasło: 422 pod polem `obecne`, 2FA zostaje', async () => {
    const response = await wylacz({ haslo: 'Zle-haslo-123!' });
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatchObject({ code: 'settings_invalid', field: 'obecne' });
    expect(users[U_2FA]!.factors).toHaveLength(1);
    expect(fake.recovery).not.toHaveBeenCalled();
  });

  it('konto bez 2FA: 422, bez sprawdzania hasła', async () => {
    const response = await wylacz({ haslo: HASLO }, T_NO2FA);
    expect(response.status).toBe(422);
    expect(wyjscia.some((w) => w.sciezka === '/auth/v1/token')).toBe(false);
  });

  it('nieudane sprzątanie kodów ratunkowych zatrzymuje wyłączanie: 503, czynnik zostaje', async () => {
    fake.recovery.mockImplementation(async () => {
      throw new Error('recovery_codes_cleanup_failed');
    });
    const response = await wylacz({ haslo: HASLO });
    expect(response.status).toBe(503);
    expect(users[U_2FA]!.factors).toHaveLength(1);
    expect(fake.audit).not.toHaveBeenCalled();
  });

  it('awaria usuwania czynnika w GoTrue: 503, bez wpisu w dzienniku', async () => {
    awariaUsuwania = FACTOR_2FA;
    expect((await wylacz({ haslo: HASLO })).status).toBe(503);
    expect(fake.audit).not.toHaveBeenCalled();
  });

  it('bez Redisa limit prób hasła odmawia (fail-closed): 503, 2FA zostaje', async () => {
    fake.state.redis = false;
    expect((await wylacz({ haslo: HASLO })).status).toBe(503);
    expect(users[U_2FA]!.factors).toHaveLength(1);
  });
});

describe('POST /ustawienia/ksef', () => {
  const PLIKI = { certyfikat: Buffer.from('-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----').toString('base64'), klucz: Buffer.from('-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----').toString('base64') };
  const wgraj = (body: unknown, tok = T_2FA) => ksefRoute(req('ksef', { token: tok, org: true, body }));

  it('właściciel z 2FA po kodzie: rdzeń dostaje firmę i konto z bramki oraz pliki, odpowiedź z datą ważności', async () => {
    fake.upload.mockResolvedValue({ success: true, wasFirstClaim: true, message: 'Połączono z KSeF.', validTo: '2027-10-14T00:00:00.000Z' });
    const response = await wgraj({ ...PLIKI, haslo: 'tajne' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ polaczono: true, pierwszePolaczenie: true, wazneDo: '2027-10-14', komunikat: 'Połączono z KSeF.' });
    expect(fake.upload).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: ORG, userId: U_2FA, supabase: expect.anything() }),
      { certificate: PLIKI.certyfikat, privateKey: PLIKI.klucz, password: 'tajne' },
    );
  });

  it('członek firmy: 403 `forbidden`, rdzeń nie jest wołany', async () => {
    const response = await wgraj(PLIKI, T_MEMBER);
    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatchObject({ code: 'forbidden', message: 'Certyfikat KSeF zmienia właściciel firmy.' });
    expect(fake.upload).not.toHaveBeenCalled();
  });

  it('konto bez 2FA: 403 z drogą do Bezpieczeństwa, rdzeń nie jest wołany', async () => {
    const response = await wgraj(PLIKI, T_NO2FA);
    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toContain('weryfikację dwuetapową');
    expect(fake.upload).not.toHaveBeenCalled();
  });

  it.each([
    ['cert_expired', 'Certyfikat wygasł.', 'certyfikat'],
    ['key_mismatch', 'Klucz nie pasuje do certyfikatu.', 'klucz'],
    ['password_wrong', 'Hasło do klucza jest nieprawidłowe.', 'haslo'],
  ] as const)('%s: 422 `settings_invalid` ze zdaniem strony pod polem „%s”', async (reason, error, pole) => {
    fake.upload.mockResolvedValue({ success: false, reason, error });
    const response = await wgraj(PLIKI);
    expect(response.status).toBe(422);
    expect((await response.json()).error).toEqual({ code: 'settings_invalid', message: error, field: pole });
  });

  it.each(['not_owner', 'nip_taken', 'no_nip', 'invalid_input'] as const)('%s: 422 ze zdaniem strony, bez pola', async (reason) => {
    fake.upload.mockResolvedValue({ success: false, reason, error: 'Zdanie strony.' });
    const response = await wgraj(PLIKI);
    expect(response.status).toBe(422);
    const { error } = await response.json();
    expect(error).toMatchObject({ code: 'settings_invalid', message: 'Zdanie strony.' });
    expect(error.field).toBeUndefined();
  });

  it('limit 5 prób na godzinę: 429 z `Retry-After` z czasu podanego przez rdzeń', async () => {
    fake.upload.mockResolvedValue({ success: false, reason: 'rate_limited', error: 'Zbyt wiele prób połączenia z KSeF w ciągu godziny. Spróbuj ponownie za około 42 min.', retryAfter: 2490 });
    const response = await wgraj(PLIKI);
    expect(response.status).toBe(429);
    // Czas z rdzenia, nie wyciągnięty ze zdania.
    expect(response.headers.get('retry-after')).toBe('2490');
  });

  it.each(['unavailable', 'save_failed', 'internal_error'] as const)('%s: 503 do ponowienia ze zdaniem strony', async (reason) => {
    fake.upload.mockResolvedValue({ success: false, reason, error: 'KSeF chwilowo nie odpowiada.' });
    const response = await wgraj(PLIKI);
    expect(response.status).toBe(503);
    expect((await response.json()).error).toEqual({ code: 'service_unavailable', message: 'KSeF chwilowo nie odpowiada.' });
  });

  it('treść spoza kontraktu albo bez plików: 400, rdzeń nie jest wołany; klucz nie wraca w odpowiedzi', async () => {
    expect((await wgraj({ ...PLIKI, nip: '1234567890' })).status).toBe(400);
    expect((await wgraj({ certyfikat: PLIKI.certyfikat })).status).toBe(400);
    expect(fake.upload).not.toHaveBeenCalled();
    fake.upload.mockResolvedValue({ success: false, reason: 'key_unreadable', error: 'Nie da się odczytać klucza.' });
    expect(await (await wgraj(PLIKI)).text()).not.toContain(PLIKI.klucz);
  });
});

describe('kontrakt 2FA i certyfikatu', () => {
  it('plik kontraktu nie ma importów (czyta go Metro)', () => {
    const source = readFileSync(resolve(__dirname, '../../lib/api/mobile/kontrakt-bezpieczenstwo.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
  });
});
