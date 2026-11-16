import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan aplikacji mobilnej, M10c: zapisy kart Firma, Przypomnienia
 * i Powiadomienia z telefonu.
 *
 * Prawdziwe: trasy, bramka `authenticateMobileRequest`, logika zapisu
 * `lib/settings/company-settings.ts` (ta sama co akcje strony), schematy strony
 * (dane firmy, rachunek, data rozpoczęcia, zwolnienie), odczyt kart po zapisie.
 * Atrapy: HTTP (GoTrue, PostgREST z tokenem klienta i z kluczem serwisowym),
 * Redis, dziennik zdarzeń, zapis zgody e-mail (`lib/legal/record`) i wypisów.
 */

const SUPABASE_URL = 'https://db.fixture.test';
const SERVICE_KEY = 'service-fixture-key';
const OWNER = 'aaaaaaaa-1111-4111-8111-000000000001';
const MEMBER = 'aaaaaaaa-1111-4111-8111-000000000002';
const ADMIN = 'aaaaaaaa-1111-4111-8111-000000000003';
const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const NOW = new Date('2026-11-16T09:00:00Z');

const fake = vi.hoisted(() => {
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
  };
  const audit = vi.fn(async (_entry: unknown) => undefined);
  const consent = vi.fn(async (_input: unknown) => ({ ok: true }));
  const prefs = {
    unsubscribed: [] as string[],
    consents: { product_updates: true, marketing: false } as Record<string, boolean>,
    unsubscribe: vi.fn(async (_input: unknown) => undefined),
    resubscribe: vi.fn(async (_userId: string, _category: string) => undefined),
  };
  return { client, audit, consent, prefs };
});

vi.mock('@/lib/cache/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cache/redis')>();
  return { ...actual, isRedisConfigured: () => true, getRedis: () => fake.client };
});
vi.mock('@/lib/feature-flags/maintenance', () => ({ isMaintenanceMode: async () => false, MAINTENANCE_PATH: '/przerwa-techniczna' }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: fake.audit }));
vi.mock('@/lib/legal/record', () => ({ setEmailConsent: fake.consent }));
vi.mock('@/lib/email/preferences', () => ({
  getUnsubscribedCategories: async () => fake.prefs.unsubscribed,
  getEmailConsents: async () => fake.prefs.consents,
  unsubscribe: fake.prefs.unsubscribe,
  resubscribe: fake.prefs.resubscribe,
}));

import { POST as firmaRoute } from '@/app/api/mobile/v1/ustawienia/firma/route';
import { GET as powiadomieniaGet, POST as powiadomieniaPost } from '@/app/api/mobile/v1/ustawienia/powiadomienia/route';
import { POST as przypomnieniaRoute } from '@/app/api/mobile/v1/ustawienia/przypomnienia/route';
import { PODSTAWY_ZWOLNIENIA_VAT } from '@/lib/api/mobile/kontrakt-ustawienia';
import { VAT_EXEMPTION_PRESETS } from '@/lib/invoices/vat-exemption';

const b64url = (value: string) => Buffer.from(value).toString('base64url');
function accessToken(sub: string, n: number): string {
  const now = Math.floor(NOW.getTime() / 1000);
  return [
    b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    b64url(JSON.stringify({ aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 3600, sub, aal: 'aal1', session_id: `cccccccc-2222-4222-8222-00000000000${n}`, amr: [{ method: 'password', timestamp: now - 60 }] })),
    b64url('fixture-signature'),
  ].join('.');
}
const TOKEN_OWNER = accessToken(OWNER, 1);
const TOKEN_MEMBER = accessToken(MEMBER, 2);
const TOKEN_ADMIN = accessToken(ADMIN, 3);
const issued = new Map([[TOKEN_OWNER, OWNER], [TOKEN_MEMBER, MEMBER], [TOKEN_ADMIN, ADMIN]]);
const memberships = [
  { user_id: OWNER, organization_id: ORG_A, role: 'owner', status: 'active' },
  { user_id: MEMBER, organization_id: ORG_A, role: 'member', status: 'active' },
  { user_id: ADMIN, organization_id: ORG_A, role: 'admin', status: 'active' },
];

type Zapis = { klucz: 'serwisowy' | 'klient'; metoda: string; sciezka: string; filtr: string | null; tresc: Record<string, unknown>; org: string | null; prefer: string | null };
let tenant: Record<string, unknown>;
let reminderRow: Record<string, unknown> | null;
let zapisy: Zapis[] = [];
let failAdminWrite = false;
let failReminderWrite = false;

const eq = (url: URL, column: string) => {
  const value = url.searchParams.get(column);
  return value?.startsWith('eq.') ? decodeURIComponent(value.slice(3)) : null;
};

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== SUPABASE_URL) throw new Error(`nieoczekiwane wyjście do ${url.origin}`);
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? null;
  const serwisowy = token === SERVICE_KEY;
  const sub = token && !serwisowy ? issued.get(token) : undefined;

  if (url.pathname === '/auth/v1/user') {
    if (!sub) return Response.json({ msg: 'invalid JWT' }, { status: 401 });
    return Response.json({ id: sub, aud: 'authenticated', role: 'authenticated', email: `${sub}@example.test`, factors: [], app_metadata: { provider: 'email', providers: ['email'] } });
  }
  if (!sub && !serwisowy) return Response.json({ message: 'JWT invalid' }, { status: 401 });
  const asObject = request.headers.get('accept')?.includes('vnd.pgrst.object');
  const one = (row: unknown) => (row ? Response.json(row) : asObject ? Response.json({ code: 'PGRST116' }, { status: 406 }) : Response.json([]));

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const tresc = (await request.json()) as Record<string, unknown>;
    zapisy.push({
      klucz: serwisowy ? 'serwisowy' : 'klient',
      metoda: request.method,
      sciezka: url.pathname,
      filtr: eq(url, 'id') ?? url.searchParams.get('on_conflict'),
      tresc,
      org: request.headers.get('x-active-org'),
      prefer: request.headers.get('prefer'),
    });
    if (url.pathname === '/rest/v1/tenants') {
      if (failAdminWrite) return Response.json({ message: 'boom', code: '08006' }, { status: 500 });
      if (serwisowy && eq(url, 'id') === ORG_A) Object.assign(tenant, tresc);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/rest/v1/reminder_settings') {
      if (failReminderWrite) return Response.json({ message: 'boom' }, { status: 500 });
      reminderRow = { ...(reminderRow ?? {}), ...tresc };
      return new Response(null, { status: 201 });
    }
    return Response.json({ message: `nieznany zapis ${url.pathname}` }, { status: 404 });
  }

  if (url.pathname === '/rest/v1/memberships') {
    const rows = memberships.filter((m) => m.user_id === sub && (eq(url, 'organization_id') === null || m.organization_id === eq(url, 'organization_id')));
    return asObject ? one(rows[0]) : Response.json(rows);
  }
  if (url.pathname === '/rest/v1/tenants') return one(eq(url, 'id') === ORG_A ? tenant : null);
  if (url.pathname === '/rest/v1/reminder_settings') {
    return reminderRow && eq(url, 'tenant_id') === ORG_A ? Response.json(reminderRow) : Response.json(null);
  }
  return Response.json({ message: `nieznana ścieżka ${url.pathname}` }, { status: 404 });
}

let ip = 0;
function req(path: string, options: { token?: string | null; org?: string | null; body?: unknown; method?: string } = {}): Request {
  const headers: Record<string, string> = { 'x-real-ip': `198.51.100.${(ip += 1) % 250}` };
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN_OWNER}`;
  if (options.org !== null) headers['x-active-org'] = options.org ?? ORG_A;
  const method = options.method ?? 'POST';
  if (method !== 'GET') headers['content-type'] = 'application/json';
  return new Request(`https://app.example.test/api/mobile/v1/ustawienia/${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}),
  });
}

const firma = (body: unknown, options: { token?: string | null; org?: string | null } = {}) => firmaRoute(req('firma', { ...options, body }));
const zapisyFirmy = () => zapisy.filter((z) => z.sciezka === '/rest/v1/tenants');

const PRZYPOMNIENIA = {
  wlaczone: true,
  etapy: [
    { etap: 1, wlaczony: true, dniPoTerminie: 5 },
    { etap: 2, wlaczony: false, dniPoTerminie: 10 },
    { etap: 3, wlaczony: true, dniPoTerminie: 30 },
  ],
  godzina: 10,
  tylkoDniRobocze: false,
  najwiecej: 4,
  nadawca: '  Pracownia   Testowa ',
  odpowiedzNa: ' biuro@example.test ',
  wstrzymajPoOdpowiedzi: true,
  wstrzymajPoCzesciowej: false,
};

beforeEach(() => {
  zapisy = [];
  failAdminWrite = false;
  failReminderWrite = false;
  reminderRow = null;
  fake.audit.mockClear();
  fake.consent.mockClear();
  fake.consent.mockImplementation(async () => ({ ok: true }));
  fake.prefs.unsubscribe.mockClear();
  fake.prefs.resubscribe.mockClear();
  fake.prefs.unsubscribed = [];
  fake.prefs.consents = { product_updates: true, marketing: false };
  tenant = {
    name: 'Pracownia Testowa',
    nip: '1234567890',
    address_json: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' },
    bank_account: null,
    business_started_on: '2024-07-01',
    vat_exemption_basis: null,
    vat_cash_method: false,
    has_ksef_credentials: false,
    ksef_certificate_expiry: null,
    ksef_verified_at: null,
    ksef_verified_environment: null,
  };
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-fixture-key');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
  vi.stubEnv('KSEF_ENV', 'test');
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('bramka tras zapisu ustawień', () => {
  const trasy = [
    ['firma', (r: Request) => firmaRoute(r)],
    ['przypomnienia', (r: Request) => przypomnieniaRoute(r)],
    ['powiadomienia', (r: Request) => powiadomieniaPost(r)],
  ] as const;

  it.each(trasy)('%s: bez tokenu 401 `missing_token`, zły token 401 `invalid_token`, nic się nie zapisuje', async (sciezka, trasa) => {
    const bez = await trasa(req(sciezka, { token: null, body: { zmiana: 'metodaKasowa', wlaczona: true } }));
    expect(bez.status).toBe(401);
    expect((await bez.json()).error.code).toBe('missing_token');

    const zly = await trasa(req(sciezka, { token: accessToken('bbbbbbbb-9999-4999-8999-000000000009', 9), body: { zmiana: 'metodaKasowa', wlaczona: true } }));
    expect(zly.status).toBe(401);
    expect((await zly.json()).error.code).toBe('invalid_token');
    expect(zapisy).toEqual([]);
    expect(fake.consent).not.toHaveBeenCalled();
  });

  it('firma i przypomnienia bez `X-Active-Org`: 400 `missing_org`', async () => {
    expect((await firma({ zmiana: 'metodaKasowa', wlaczona: true }, { org: null })).status).toBe(400);
    expect((await przypomnieniaRoute(req('przypomnienia', { org: null, body: PRZYPOMNIENIA }))).status).toBe(400);
    expect(zapisy).toEqual([]);
  });
});

describe('POST /api/mobile/v1/ustawienia/firma', () => {
  it('dane firmy jak na stronie: zapis kluczem serwisowym po sprawdzeniu roli, dziennik z `client: mobile`, karty po zapisie', async () => {
    const response = await firma({ zmiana: 'dane', nazwa: '  Nowa   Pracownia ', adres1: 'ul. Nowa 2', adres2: '00-950 Warszawa' });
    expect(response.status).toBe(200);
    expect(zapisyFirmy()).toEqual([
      expect.objectContaining({
        klucz: 'serwisowy',
        metoda: 'PATCH',
        filtr: ORG_A,
        tresc: { name: 'Nowa Pracownia', address_json: { countryCode: 'PL', addressLine1: 'ul. Nowa 2', addressLine2: '00-950 Warszawa' } },
      }),
    ]);
    expect(fake.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tenant.updated',
        tenantId: ORG_A,
        userId: OWNER,
        metadata: expect.objectContaining({ field: 'company_profile', client: 'mobile', after: { name: 'Nowa Pracownia', address: { addressLine1: 'ul. Nowa 2', addressLine2: '00-950 Warszawa' } } }),
      }),
    );
    const body = await response.json();
    expect(body.firma).toMatchObject({ nazwa: 'Nowa Pracownia', nip: '1234567890', adres: { linia1: 'ul. Nowa 2', linia2: '00-950 Warszawa' } });
  });

  it('administrator też zmienia dane firmy (jak `requireOrgRole([owner, admin])`)', async () => {
    const response = await firma({ zmiana: 'metodaKasowa', wlaczona: true }, { token: TOKEN_ADMIN });
    expect(response.status).toBe(200);
    expect(zapisyFirmy()[0]?.tresc).toEqual({ vat_cash_method: true });
    expect((await response.json()).firma.metodaKasowa).toBe(true);
  });

  it('członek firmy: 403 `forbidden` ze zdaniem strony, bez zapisu i wpisu', async () => {
    const response = await firma({ zmiana: 'dane', nazwa: 'Obca', adres1: 'ul. X 1', adres2: '00-001 Warszawa' }, { token: TOKEN_MEMBER });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatchObject({ code: 'forbidden', message: 'Dane firmy zmienia właściciel albo administrator firmy.' });
    expect(zapisy).toEqual([]);
    expect(fake.audit).not.toHaveBeenCalled();
  });

  it('zły adres: 422 `settings_invalid` ze zdaniem schematu strony pod polem `adres2`, bez zapisu', async () => {
    const response = await firma({ zmiana: 'dane', nazwa: 'Pracownia', adres1: 'ul. Nowa 2', adres2: 'Warszawa' });
    expect(response.status).toBe(422);
    expect((await response.json()).error).toEqual({ code: 'settings_invalid', message: 'Kod pocztowy i miejscowość, np. „00-001 Warszawa”', field: 'adres2' });
    expect(zapisy).toEqual([]);
  });

  it('pusta nazwa: pole `nazwa`', async () => {
    const body = await (await firma({ zmiana: 'dane', nazwa: '   ', adres1: 'ul. Nowa 2', adres2: '00-950 Warszawa' })).json();
    expect(body.error).toMatchObject({ code: 'settings_invalid', field: 'nazwa', message: 'Podaj nazwę firmy' });
  });

  it('rachunek: zły numer to 422 pod polem `rachunek`; pusty tekst czyści rachunek', async () => {
    const zly = await firma({ zmiana: 'rachunek', rachunek: '12 3456' });
    expect(zly.status).toBe(422);
    expect((await zly.json()).error).toMatchObject({ code: 'settings_invalid', field: 'rachunek' });
    expect(zapisyFirmy()).toEqual([]);

    tenant.bank_account = '11111111111111111111111111';
    const pusty = await firma({ zmiana: 'rachunek', rachunek: '' });
    expect(pusty.status).toBe(200);
    expect(zapisyFirmy()[0]?.tresc).toEqual({ bank_account: null });
    expect(fake.audit).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ field: 'bank_account', to: null, client: 'mobile' }) }));
  });

  it('data rozpoczęcia z przyszłości: 422 pod polem `data` (dzień Warszawy jak strona)', async () => {
    const response = await firma({ zmiana: 'rozpoczecie', data: '2026-11-17' });
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatchObject({ code: 'settings_invalid', field: 'data' });
    expect(zapisyFirmy()).toEqual([]);

    expect((await firma({ zmiana: 'rozpoczecie', data: '2026-11-16' })).status).toBe(200);
    expect(zapisyFirmy()[0]?.tresc).toEqual({ business_started_on: '2026-11-16' });
  });

  it('zwolnienie z VAT: podstawa po oczyszczeniu; pusty tekst to czynny podatnik VAT', async () => {
    const response = await firma({ zmiana: 'zwolnienie', podstawa: '  art. 113 ust. 1   ustawy o VAT ' });
    expect(response.status).toBe(200);
    expect(zapisyFirmy()[0]?.tresc).toEqual({ vat_exemption_basis: 'art. 113 ust. 1 ustawy o VAT' });
    expect((await response.json()).firma).toMatchObject({ zwolnienie: 'art. 113 ust. 1 ustawy o VAT', zwolnieniePodmiotowe: true });

    zapisy = [];
    expect((await firma({ zmiana: 'zwolnienie', podstawa: '' })).status).toBe(200);
    expect(zapisyFirmy()[0]?.tresc).toEqual({ vat_exemption_basis: null });

    const krotka = await firma({ zmiana: 'zwolnienie', podstawa: 'ab' });
    expect((await krotka.json()).error).toMatchObject({ code: 'settings_invalid', field: 'podstawa', message: 'Podstawa zwolnienia musi mieć od 3 do 256 znaków.' });
  });

  it.each([
    ['nieznana zmiana', { zmiana: 'nip', nip: '5252241585' }],
    ['dodatkowe pole (np. NIP przy danych)', { zmiana: 'dane', nazwa: 'A', adres1: 'B', adres2: '00-001 C', nip: '5252241585' }],
    ['metoda kasowa jako tekst', { zmiana: 'metodaKasowa', wlaczona: 'tak' }],
    ['brak treści', null],
  ])('%s: 400 `invalid_request`, bez zapisu', async (_opis, body) => {
    const response = await firma(body);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('invalid_request');
    expect(zapisy).toEqual([]);
  });

  it('błąd zapisu w bazie: 503 ze zdaniem strony, bez wpisu w dzienniku', async () => {
    failAdminWrite = true;
    const response = await firma({ zmiana: 'metodaKasowa', wlaczona: true });
    expect(response.status).toBe(503);
    expect((await response.json()).error).toEqual({ code: 'service_unavailable', message: 'Nie udało się zapisać metody rozliczania VAT.' });
    expect(fake.audit).not.toHaveBeenCalled();
  });
});

describe('POST /api/mobile/v1/ustawienia/przypomnienia', () => {
  it('właściciel: upsert klientem z tokenem i firmą (RLS), wartości formularza strony, dziennik; karta po zapisie „zapisane, włączone”', async () => {
    const response = await przypomnieniaRoute(req('przypomnienia', { body: PRZYPOMNIENIA }));
    expect(response.status).toBe(200);
    const zapis = zapisy.find((z) => z.sciezka === '/rest/v1/reminder_settings');
    expect(zapis).toMatchObject({ klucz: 'klient', metoda: 'POST', filtr: 'tenant_id', org: ORG_A });
    expect(zapis?.prefer).toContain('resolution=merge-duplicates');
    expect(zapis?.tresc).toEqual({
      tenant_id: ORG_A,
      enabled: true,
      stage_1_enabled: true,
      stage_1_days_after_due: 5,
      stage_2_enabled: false,
      stage_2_days_after_due: 10,
      stage_3_enabled: true,
      stage_3_days_after_due: 30,
      sender_name: 'Pracownia Testowa',
      reply_to_email: 'biuro@example.test',
      pause_on_reply: true,
      pause_on_partial_payment: false,
      send_on_weekdays_only: false,
      send_hour: 10,
      max_reminders_per_invoice: 4,
    });
    expect(zapis?.tresc).not.toHaveProperty('sender_email');
    expect(fake.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'tenant.updated', tenantId: ORG_A, metadata: expect.objectContaining({ field: 'reminder_settings', client: 'mobile' }) }));
    const body = await response.json();
    expect(body.przypomnienia).toMatchObject({ zapisane: true, wlaczone: true, godzina: 10, najwiecej: 4, odpowiedzNa: 'biuro@example.test' });
  });

  it('administrator i członek: 403 `forbidden` (zakładka strony tylko dla właściciela), bez zapisu', async () => {
    for (const token of [TOKEN_ADMIN, TOKEN_MEMBER]) {
      const response = await przypomnieniaRoute(req('przypomnienia', { token, body: PRZYPOMNIENIA }));
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('forbidden');
    }
    expect(zapisy).toEqual([]);
  });

  it.each([
    ['godzina poza 6 do 18', { godzina: 19 }, 'godzina'],
    ['etap 2 po 91 dniach', { etapy: [PRZYPOMNIENIA.etapy[0], { etap: 2, wlaczony: true, dniPoTerminie: 91 }, PRZYPOMNIENIA.etapy[2]] }, 'etapy.1.dniPoTerminie'],
    ['zero przypomnień na fakturę', { najwiecej: 0 }, 'najwiecej'],
    ['zły adres do odpowiedzi', { odpowiedzNa: 'biuro@' }, 'odpowiedzNa'],
    ['nadawca ze znakiem <', { nadawca: 'Firma <script>' }, 'nadawca'],
  ])('%s: 422 `settings_invalid` pod polem, bez zapisu', async (_opis, zmiana, pole) => {
    const response = await przypomnieniaRoute(req('przypomnienia', { body: { ...PRZYPOMNIENIA, ...zmiana } }));
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatchObject({ code: 'settings_invalid', field: pole });
    expect(zapisy).toEqual([]);
  });

  it.each([
    ['dwa etapy', { etapy: PRZYPOMNIENIA.etapy.slice(0, 2) }],
    ['etapy w złej kolejności', { etapy: [PRZYPOMNIENIA.etapy[1], PRZYPOMNIENIA.etapy[0], PRZYPOMNIENIA.etapy[2]] }],
    ['godzina z ułamkiem', { godzina: 9.5 }],
    ['dodatkowe pole tenant_id', { tenant_id: 'bbbbbbbb-0000-4000-8000-000000000002' }],
  ])('%s: 400 `invalid_request`, bez zapisu', async (_opis, zmiana) => {
    const response = await przypomnieniaRoute(req('przypomnienia', { body: { ...PRZYPOMNIENIA, ...zmiana } }));
    expect([400, 422]).toContain(response.status);
    if (response.status === 422) expect((await response.json()).error.code).toBe('settings_invalid');
    expect(zapisy).toEqual([]);
  });

  it('błąd bazy: 503, bez wpisu w dzienniku', async () => {
    failReminderWrite = true;
    const response = await przypomnieniaRoute(req('przypomnienia', { body: PRZYPOMNIENIA }));
    expect(response.status).toBe(503);
    expect(fake.audit).not.toHaveBeenCalled();
  });
});

describe('/api/mobile/v1/ustawienia/powiadomienia', () => {
  it('GET: przełącznik włączony tylko przy zgodzie i bez wypisu (jak strona), bez nagłówka firmy', async () => {
    fake.prefs.unsubscribed = ['product_updates'];
    fake.prefs.consents = { product_updates: true, marketing: true };
    const response = await powiadomieniaGet(req('powiadomienia', { method: 'GET', org: null }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: { porady: false, oferty: true } });
  });

  it('GET: błąd odczytu zgód to `email: null`, nie „wyłączone”', async () => {
    fake.prefs.consents = null as unknown as Record<string, boolean>;
    const response = await powiadomieniaGet(req('powiadomienia', { method: 'GET', org: null }));
    expect(await response.json()).toEqual({ email: null });
  });

  it('POST włączenie: wypis zdjęty, zgoda z `method: mobile_settings`', async () => {
    const response = await powiadomieniaPost(req('powiadomienia', { org: null, body: { kategoria: 'oferty', wlaczone: true } }));
    expect(response.status).toBe(200);
    expect(fake.prefs.resubscribe).toHaveBeenCalledWith(OWNER, 'marketing');
    expect(fake.consent).toHaveBeenCalledWith({ userId: OWNER, category: 'marketing', granted: true, method: 'mobile_settings' });
  });

  it('POST wyłączenie: najpierw wypis (blokuje wysyłkę od razu), potem wycofanie zgody', async () => {
    const response = await powiadomieniaPost(req('powiadomienia', { org: null, body: { kategoria: 'porady', wlaczone: false } }));
    expect(response.status).toBe(200);
    expect(fake.prefs.unsubscribe).toHaveBeenCalledWith({ userId: OWNER, category: 'product_updates', source: 'settings_ui' });
    expect(fake.consent).toHaveBeenCalledWith({ userId: OWNER, category: 'product_updates', granted: false, method: 'mobile_settings' });
    expect(fake.prefs.unsubscribe.mock.invocationCallOrder[0]!).toBeLessThan(fake.consent.mock.invocationCallOrder[0]!);
  });

  it('POST: e-maili transakcyjnych nie da się wyłączyć (400), zapis zgody nieudany to 503', async () => {
    const transakcyjne = await powiadomieniaPost(req('powiadomienia', { org: null, body: { kategoria: 'transactional', wlaczone: false } }));
    expect(transakcyjne.status).toBe(400);
    expect(fake.prefs.unsubscribe).not.toHaveBeenCalled();

    fake.consent.mockImplementation(async () => ({ ok: false }));
    const blad = await powiadomieniaPost(req('powiadomienia', { org: null, body: { kategoria: 'porady', wlaczone: true } }));
    expect(blad.status).toBe(503);
  });
});

describe('kontrakt zapisów ustawień', () => {
  it('plik kontraktu nie ma importów (czyta go Metro)', () => {
    const source = readFileSync(resolve(__dirname, '../../lib/api/mobile/kontrakt-ustawienia.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bimport\s*\(/);
  });

  it('podstawy zwolnienia telefonu to te same wartości co podpowiedzi strony, etykiety bez długich myślników', () => {
    expect(PODSTAWY_ZWOLNIENIA_VAT.map((p) => p.podstawa)).toEqual(VAT_EXEMPTION_PRESETS.map((p) => p.value));
    for (const p of PODSTAWY_ZWOLNIENIA_VAT) expect(p.etykieta).not.toMatch(/[—–]/);
  });
});
