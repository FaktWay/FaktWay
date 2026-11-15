import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan aplikacji mobilnej, M10e: karty Więcej do odczytu z prawdziwego konta:
 * Import danych, Księgowa, Zespół, Abonament i Dziennik zdarzeń.
 *
 * Prawdziwe: trasy, bramka `authenticateMobileRequest`, `lib/api/mobile/*`,
 * modele widoku strony (`components/import-danych/*-model.ts`), opis stanu
 * subskrypcji (`lib/billing/subscription-status.ts`), `getActiveSubscription`,
 * nazwy zdarzeń dziennika (`lib/audit/labels.ts`). Atrapy: HTTP (GoTrue,
 * PostgREST), Redis i `readKsefHistorySyncStatus` (sześć tabel historii KSeF,
 * własne testy na ścieżce strony; tu granica, której wynik trasa składa jak
 * karta strony).
 */

const SUPABASE_URL = 'https://db.fixture.test';
const OWNER = 'aaaaaaaa-1111-4111-8111-000000000001';
const ADMIN = 'aaaaaaaa-1111-4111-8111-000000000002';
const MEMBER = 'aaaaaaaa-1111-4111-8111-000000000003';
const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const NOW = new Date('2026-11-15T09:00:00Z');

const fake = vi.hoisted(() => {
  const client = {
    pipeline() {
      const pipe = { zremrangebyscore: () => pipe, zadd: () => pipe, zcard: () => pipe, expire: () => pipe, exec: async () => [0, 1, 1, 1] };
      return pipe;
    },
    zrange: async () => [],
    zrem: async () => 0,
  };
  return { client, history: vi.fn() };
});

vi.mock('@/lib/cache/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cache/redis')>();
  return { ...actual, isRedisConfigured: () => true, getRedis: () => fake.client };
});
vi.mock('@/lib/feature-flags/maintenance', () => ({ isMaintenanceMode: async () => false, MAINTENANCE_PATH: '/przerwa-techniczna' }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/ksef/history-sync/status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ksef/history-sync/status')>();
  return { ...actual, readKsefHistorySyncStatus: fake.history };
});

import { GET as abonamentRoute } from '@/app/api/mobile/v1/abonament/route';
import { GET as dziennikRoute } from '@/app/api/mobile/v1/dziennik/route';
import { GET as importRoute } from '@/app/api/mobile/v1/import/route';
import { GET as ksiegowaRoute } from '@/app/api/mobile/v1/ksiegowa/route';
import { GET as zespolRoute } from '@/app/api/mobile/v1/zespol/route';

const b64url = (value: string) => Buffer.from(value).toString('base64url');
function accessToken(sub: string, n: number): string {
  const now = Math.floor(NOW.getTime() / 1000);
  return [
    b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    b64url(JSON.stringify({ aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 3600, sub, aal: 'aal1', session_id: `cccccccc-2222-4222-8222-00000000000${n}`, amr: [{ method: 'password', timestamp: now - 60 }] })),
    b64url('fixture-signature'),
  ].join('.');
}
const TOKEN = { owner: accessToken(OWNER, 1), admin: accessToken(ADMIN, 2), member: accessToken(MEMBER, 3) };
const issued = new Map([[TOKEN.owner, OWNER], [TOKEN.admin, ADMIN], [TOKEN.member, MEMBER]]);
const memberships = [
  { user_id: OWNER, organization_id: ORG_A, role: 'owner', status: 'active' },
  { user_id: ADMIN, organization_id: ORG_A, role: 'admin', status: 'active' },
  { user_id: MEMBER, organization_id: ORG_A, role: 'member', status: 'active' },
];

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
let reads: Array<{ path: string; select: string | null; org: string | null }>;
let failing: string | null;

const eq = (url: URL, column: string) => {
  const value = url.searchParams.get(column);
  return value?.startsWith('eq.') ? decodeURIComponent(value.slice(3)) : null;
};

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== SUPABASE_URL) throw new Error(`nieoczekiwane wyjście do ${url.origin}`);
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? null;
  const sub = token ? issued.get(token) : undefined;
  if (url.pathname === '/auth/v1/user') {
    if (!sub) return Response.json({ msg: 'invalid JWT' }, { status: 401 });
    return Response.json({ id: sub, aud: 'authenticated', role: 'authenticated', email: `${sub}@example.test`, factors: [], app_metadata: { provider: 'email', providers: ['email'] } });
  }
  if (!sub) return Response.json({ message: 'JWT invalid' }, { status: 401 });
  // Klucz serwisowy nie ma prawa się tu pojawić: każda trasa pyta tokenem telefonu.
  if (request.headers.get('apikey') !== 'anon-fixture-key') throw new Error('zapytanie bez klucza publicznego');
  const asObject = request.headers.get('accept')?.includes('vnd.pgrst.object');
  if (url.pathname === '/rest/v1/memberships' && url.searchParams.get('select')?.includes('users!inner')) {
    reads.push({ path: url.pathname, select: url.searchParams.get('select'), org: request.headers.get('x-active-org') });
    return Response.json(tables.team ?? []);
  }
  if (url.pathname === '/rest/v1/memberships') {
    const rows = memberships.filter((m) => m.user_id === sub && (eq(url, 'organization_id') === null || m.organization_id === eq(url, 'organization_id')));
    return asObject ? (rows[0] ? Response.json(rows[0]) : Response.json({ code: 'PGRST116' }, { status: 406 })) : Response.json(rows);
  }
  const name = url.pathname.replace('/rest/v1/', '');
  reads.push({ path: url.pathname, select: url.searchParams.get('select'), org: request.headers.get('x-active-org') });
  if (failing === name) return Response.json({ message: 'boom' }, { status: 500 });
  const rows = tables[name] ?? [];
  if (asObject) return rows[0] ? Response.json(rows[0]) : Response.json({ code: 'PGRST116', message: 'no rows' }, { status: 406 });
  return Response.json(rows);
}

let ip = 0;
function req(path: string, options: { token?: string | null; org?: string | null } = {}): Request {
  const headers: Record<string, string> = { 'x-real-ip': `198.51.100.${(ip += 1) % 250}` };
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN.owner}`;
  if (options.org !== null) headers['x-active-org'] = options.org ?? ORG_A;
  return new Request(`https://app.example.test/api/mobile/v1/${path}`, { method: 'GET', headers });
}
async function errorOf(response: Response) {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

function stream(direction: 'outgoing' | 'incoming', o: Row = {}) {
  return {
    direction, phase: 'live', enabledAt: '2026-10-01T10:00:00Z', historyFloor: '2026-02-01', coveredFrom: '2026-02-01',
    backfillCompletedAt: '2026-10-05T10:00:00Z', capacityReached: false, stuck: false, lastSuccessAt: '2026-11-15T08:30:00Z',
    counts: { pending: 0, imported: direction === 'outgoing' ? 120 : 45, repaired: 0, skipped: 0, retiredDraft: 0, deferred: 0, blocked: 0 },
    measuredPerHour: null, estimatedFinishAt: null, ...o,
  };
}
function historyStatus(o: Row = {}) {
  return {
    environment: 'test', outgoing: stream('outgoing'), incoming: stream('incoming'), rateLimitedUntil: null, clientPausedAt: null, error: null,
    blocked: [], blockedTotal: 0, deferred: [], deferredTotal: 0, periodsChangedAfterExport: [], ...o,
  };
}

beforeEach(() => {
  reads = [];
  failing = null;
  tables = {
    tenants: [{ has_ksef_credentials: true, ksef_verified_at: '2026-10-01T10:00:00Z', ksef_verified_environment: 'test', tax_office_code: '1471' }],
    import_jobs: [
      { id: 'j1', source: 'infakt_csv', direction: 'issued', date_from: null, date_to: null, status: 'completed', progress_percent: 100, progress_message: null, invoices_imported: 124, contractors_created: 18, contractors_updated: 0, products_created: 0, warnings: [], source_filename: 'faktury.csv', created_at: '2026-11-10T10:00:00Z', completed_at: '2026-11-10T10:05:00Z' },
      { id: 'j2', source: 'wfirma_csv', direction: 'issued', date_from: null, date_to: null, status: 'failed', progress_percent: 40, progress_message: 'Plik nie ma kolumny NIP.', invoices_imported: 3, contractors_created: 0, contractors_updated: 0, products_created: 0, warnings: [], source_filename: 'wfirma.csv', created_at: '2026-11-09T10:00:00Z', completed_at: null },
    ],
    accountant_settings: [{ co_pilot_enabled: true, accountant_name: 'Anna Księgowa', accountant_company: 'Biuro Sowa', accountant_email: 'biuro@example.test', cc_emails: ['dw@example.test'], preferred_formats: ['jpk_fa', 'kpir_excel'], send_day_of_month: 5, include_issued_invoices: true, include_received_invoices: true, include_corrections: false, last_sent_at: '2026-11-05T07:00:00Z' }],
    export_jobs: [{ id: 'e1', format: 'jpk_fa', status: 'completed', period_start: '2026-10-01', period_end: '2026-10-31', created_at: '2026-11-05T07:00:00Z', invoices_count: 12, emailed_at: '2026-11-05T07:01:00Z' }],
    accountant_access: [
      { id: 'a1', accountant_name: 'Anna', accountant_email: 'anna@example.test', access_level: 'download', expires_at: '2026-12-31T00:00:00Z', use_count: 3, created_at: '2026-11-01T00:00:00Z', revoked_at: null, last_used_at: '2026-11-12T00:00:00Z', token_hash: 'NIE-WOLNO' },
      { id: 'a2', accountant_name: 'Stary', accountant_email: 'stary@example.test', access_level: 'view', expires_at: '2026-10-01T00:00:00Z', use_count: 0, created_at: '2026-09-01T00:00:00Z', revoked_at: null, last_used_at: null, token_hash: 'NIE-WOLNO' },
    ],
    team: [
      { id: 'm1', user_id: OWNER, role: 'owner', status: 'active', joined_at: '2026-01-01T00:00:00Z', users: { name: 'Bartek' } },
      { id: 'm2', user_id: MEMBER, role: 'member', status: 'active', joined_at: '2026-02-01T00:00:00Z', users: [{ name: null }] },
    ],
    organization_invitations: [{ id: 'i1', email: 'nowy@example.test', role: 'member', invited_at: '2026-11-10T00:00:00Z', expires_at: '2026-11-17T00:00:00Z' }],
    organization_join_requests: [{ id: 'r1', requested_by_user_id: 'u9', message: ' Proszę o dostęp ', created_at: '2026-11-11T00:00:00Z', users: { name: 'Igor' } }],
    subscriptions: [{ id: 's1', tenant_id: ORG_A, stripe_subscription_id: 'sub_NIE-WOLNO', stripe_customer_id: 'cus_NIE-WOLNO', stripe_price_id: 'price_NIE-WOLNO', status: 'trialing', plan: 'monthly', current_period_start: '2026-11-01T10:00:00Z', current_period_end: '2026-11-30T23:30:00Z', trial_start: '2026-11-01T10:00:00Z', trial_end: '2026-11-25T09:00:00Z', cancel_at_period_end: false, canceled_at: null, last_webhook_at: null }],
    audit_logs: [
      { id: 7, action: 'auth.login', entity_type: null, entity_id: null, ip_address: '203.0.113.5', created_at: '2026-11-15T08:00:00Z' },
      { id: 6, action: 'contractor.updated', entity_type: 'contractor', entity_id: 'cccccccc-0000-4000-8000-000000000001', ip_address: null, created_at: '2026-11-14T08:00:00Z' },
    ],
  };
  fake.history.mockResolvedValue({ ok: true, status: historyStatus() });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-fixture-key');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-fixture-key');
  vi.stubEnv('KSEF_ENV', 'test');
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_fixture_real');
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('każda trasa M10e za bramką', () => {
  it.each([
    ['GET /import', (o: Parameters<typeof req>[1]) => importRoute(req('import', o))],
    ['GET /ksiegowa', (o: Parameters<typeof req>[1]) => ksiegowaRoute(req('ksiegowa', o))],
    ['GET /zespol', (o: Parameters<typeof req>[1]) => zespolRoute(req('zespol', o))],
    ['GET /abonament', (o: Parameters<typeof req>[1]) => abonamentRoute(req('abonament', o))],
    ['GET /dziennik', (o: Parameters<typeof req>[1]) => dziennikRoute(req('dziennik', o))],
  ])('%s: bez tokenu 401, zły token 401, bez firmy 400, cudza firma 403; bez odczytu danych', async (_nazwa, wywolaj) => {
    expect((await errorOf(await wywolaj({ token: null }))).code).toBe('missing_token');
    const zly = await wywolaj({ token: accessToken('aaaaaaaa-1111-4111-8111-00000000dead', 9) });
    expect(zly.status).toBe(401);
    expect((await errorOf(zly)).code).toBe('invalid_token');
    const bezFirmy = await wywolaj({ org: null });
    expect(bezFirmy.status).toBe(400);
    expect((await errorOf(bezFirmy)).code).toBe('missing_org');
    const cudza = await wywolaj({ org: 'dddddddd-0000-4000-8000-000000000009' });
    expect(cudza.status).toBe(403);
    expect((await errorOf(cudza)).code).toBe('no_active_org');
    expect(reads).toEqual([]);
    expect(fake.history).not.toHaveBeenCalled();
  });
});

describe('GET /api/mobile/v1/import', () => {
  it('kafle, karta „Historia z KSeF” i historia importów zdaniami strony', async () => {
    const response = await importRoute(req('import'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.kafle).toEqual([
      { podpis: 'Historia z KSeF', wartosc: '165', nota: 'sprzedaż 120 · zakupy 45' },
      { podpis: 'Zaimportowane z plików', wartosc: '127', nota: null },
      { podpis: 'Nowi kontrahenci', wartosc: '18', nota: 'z importów plików' },
      { podpis: 'Ostatnie pobranie z KSeF', wartosc: expect.stringContaining('15.11.2026'), nota: null },
    ]);
    expect(body.historiaKsef).toMatchObject({ certyfikat: 'gotowy', odznaka: { etykieta: 'Automatycznie', odcien: 'ok' }, blad: null });
    expect(body.historiaKsef.sekcje.map((s: { tytul: string }) => s.tytul)).toHaveLength(2);
    expect(body.historiaKsef.sekcje[0].linie.length).toBeGreaterThan(0);
    expect(body.importy).toEqual([
      { id: 'j1', zrodlo: 'inFakt', szczegol: 'faktury.csv', status: 'completed', statusEtykieta: 'Gotowe', data: '10.11.2026', opis: '124 faktury · 18 kontrahentów', procent: null },
      { id: 'j2', zrodlo: 'wFirma', szczegol: 'wfirma.csv', status: 'failed', statusEtykieta: 'Błąd', data: '09.11.2026', opis: 'Plik nie ma kolumny NIP. Zapisano 3 faktury.', procent: null },
    ]);
    expect(body.programy).toEqual(['Fakturownia', 'inFakt', 'wFirma', 'iFirma']);
    const tenantRead = reads.find((r) => r.path === '/rest/v1/tenants');
    expect(tenantRead?.select).not.toContain('ksef_credentials_encrypted');
    expect(fake.history).toHaveBeenCalledWith(expect.anything(), ORG_A);
  });

  it('bez certyfikatu: zdanie strony, bez sekcji; wstrzymane i do rozstrzygnięcia: komunikaty', async () => {
    tables.tenants = [{ has_ksef_credentials: false, ksef_verified_at: null, ksef_verified_environment: null }];
    const bez = await (await importRoute(req('import'))).json();
    expect(bez.historiaKsef).toMatchObject({ certyfikat: 'brak', odznaka: { etykieta: 'Wymaga certyfikatu' }, sekcje: [] });
    expect(bez.historiaKsef.komunikaty[0].tekst).toContain('Wgraj certyfikat KSeF');

    tables.tenants = [{ has_ksef_credentials: true, ksef_verified_at: '2026-10-01T10:00:00Z', ksef_verified_environment: 'test' }];
    fake.history.mockResolvedValue({ ok: true, status: historyStatus({ clientPausedAt: '2026-11-14T10:00:00Z', deferredTotal: 2 }) });
    const stoi = await (await importRoute(req('import'))).json();
    expect(stoi.historiaKsef.odznaka.etykieta).toBe('Wstrzymane');
    expect(stoi.historiaKsef.komunikaty.map((k: { tekst: string }) => k.tekst).join(' ')).toContain('Czekają na rozstrzygnięcie: 2 faktury');
  });

  it('stan historii nieczytelny: kafel „—” i zdanie strony; historia importów nieczytelna: `importy: null`', async () => {
    fake.history.mockResolvedValue({ ok: false });
    const body = await (await importRoute(req('import'))).json();
    expect(body.historiaKsef.blad).toBe('Nie udało się wczytać stanu pobierania z KSeF.');
    expect(body.kafle[0]).toEqual({ podpis: 'Historia z KSeF', wartosc: null, nota: 'nie udało się wczytać' });
    failing = 'import_jobs';
    const bezListy = await (await importRoute(req('import'))).json();
    expect(bezListy.importy).toBeNull();
    expect(bezListy.kafle).toBeNull();
  });
});

describe('GET /api/mobile/v1/ksiegowa', () => {
  it('właściciel: urząd, Co-Pilot, paczki i dostępy; bez skrótu tokenu', async () => {
    const response = await ksiegowaRoute(req('ksiegowa'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.urzad).toMatchObject({ kod: '1471' });
    expect(body.coPilot).toMatchObject({ wlaczony: true, ksiegowa: 'Anna Księgowa', formaty: ['JPK_FA(4)', 'KPiR Excel'], dzienWysylki: 5, zakres: { wystawione: true, otrzymane: true, korekty: false } });
    expect(body.paczki).toEqual([expect.objectContaining({ format: 'JPK_FA(4)', statusEtykieta: 'Wysłane' })]);
    expect(body.dostepy).toEqual([
      expect.objectContaining({ id: 'a1', poziom: 'Pobieranie', stan: 'aktywny', uzycia: 3 }),
      expect.objectContaining({ id: 'a2', poziom: 'Podgląd', stan: 'wygasl' }),
    ]);
    expect(JSON.stringify(body)).not.toContain('NIE-WOLNO');
    expect(reads.find((r) => r.path === '/rest/v1/accountant_access')?.select).not.toContain('token');
  });

  it('administrator i członek: 403, jak zakładka strony tylko dla właściciela, bez odczytu', async () => {
    for (const token of [TOKEN.admin, TOKEN.member]) {
      const response = await ksiegowaRoute(req('ksiegowa', { token }));
      expect(response.status).toBe(403);
      expect((await errorOf(response)).code).toBe('forbidden');
    }
    expect(reads.filter((r) => r.path !== '/rest/v1/memberships')).toEqual([]);
  });
});

describe('GET /api/mobile/v1/zespol', () => {
  it('administrator: członkowie bez adresów e-mail, zaproszenia i prośby; „Ty” z tokenu', async () => {
    const body = await (await zespolRoute(req('zespol', { token: TOKEN.admin }))).json();
    expect(body.czlonkowie).toEqual([
      { id: 'm1', imie: 'Bartek', rola: 'owner', status: 'active', dolaczyl: '2026-01-01T00:00:00Z', ty: false },
      { id: 'm2', imie: '(bez nazwy)', rola: 'member', status: 'active', dolaczyl: '2026-02-01T00:00:00Z', ty: false },
    ]);
    expect(body.zaproszenia).toEqual([{ id: 'i1', email: 'nowy@example.test', rola: 'member', zaproszono: '2026-11-10T00:00:00Z', wygasa: '2026-11-17T00:00:00Z' }]);
    expect(body.prosby).toEqual([{ id: 'r1', imie: 'Igor', wiadomosc: 'Proszę o dostęp', utworzono: '2026-11-11T00:00:00Z' }]);
    const own = await (await zespolRoute(req('zespol'))).json();
    expect(own.czlonkowie[0].ty).toBe(true);
  });

  it('członek: 403', async () => {
    const response = await zespolRoute(req('zespol', { token: TOKEN.member }));
    expect(response.status).toBe(403);
  });
});

describe('GET /api/mobile/v1/abonament', () => {
  it('okres próbny: stan, plan bez ceny, dni próby, dni w Warszawie; bez identyfikatorów Stripe (D5)', async () => {
    const body = await (await abonamentRoute(req('abonament'))).json();
    expect(body.subskrypcja).toEqual({
      status: 'trialing', statusEtykieta: 'Trial', odcien: 'ok', plan: 'Miesięczny',
      okresOd: '2026-11-01', okresDo: '2026-12-01', dniProby: 10, probaDo: '2026-11-25', konczySiePoOkresie: false,
    });
    const tekst = JSON.stringify(body);
    expect(tekst).not.toContain('NIE-WOLNO');
    expect(tekst).not.toMatch(/zł|PLN|\d+,\d{2}/);
  });

  it('opóźniona płatność: odcień ostrzeżenia; brak subskrypcji albo płatności bez konfiguracji: `null`', async () => {
    tables.subscriptions = [{ ...tables.subscriptions![0], status: 'past_due', trial_end: null }];
    expect((await (await abonamentRoute(req('abonament'))).json()).subskrypcja).toMatchObject({ statusEtykieta: 'Płatność opóźniona', odcien: 'ostrzezenie', dniProby: null, probaDo: null });
    tables.subscriptions = [];
    expect(await (await abonamentRoute(req('abonament'))).json()).toEqual({ subskrypcja: null });
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    reads = [];
    expect(await (await abonamentRoute(req('abonament'))).json()).toEqual({ subskrypcja: null });
    expect(reads.some((r) => r.path === '/rest/v1/subscriptions')).toBe(false);
  });

  it('członek: 403; błąd odczytu: 503', async () => {
    expect((await abonamentRoute(req('abonament', { token: TOKEN.member }))).status).toBe(403);
    failing = 'subscriptions';
    expect((await abonamentRoute(req('abonament'))).status).toBe(503);
  });
});

describe('GET /api/mobile/v1/dziennik', () => {
  it('wpisy jak zakładka strony: nazwa zdarzenia, zasób, adres; kolumny jawnie', async () => {
    const body = await (await dziennikRoute(req('dziennik', { token: TOKEN.member }))).json();
    expect(body.wpisy).toEqual([
      { id: '7', kiedy: expect.stringContaining('15.11.2026'), akcja: 'Zalogowanie', zasob: null, ip: '203.0.113.5' },
      { id: '6', kiedy: expect.stringContaining('14.11.2026'), akcja: 'contractor.updated', zasob: 'contractor:cccccccc…', ip: null },
    ]);
    const read = reads.find((r) => r.path === '/rest/v1/audit_logs');
    expect(read?.select).toBe('id,action,entity_type,entity_id,ip_address,created_at');
    expect(read?.org).toBe(ORG_A);
  });

  it('błąd odczytu: 503, nie pusty dziennik', async () => {
    failing = 'audit_logs';
    expect((await dziennikRoute(req('dziennik'))).status).toBe(503);
  });
});
