import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan aplikacji mobilnej, M10d część 3: zapisy ksiąg z telefonu (wpis ręczny w ewidencji
 * i KPiR, spis z natury, usunięcia).
 *
 * Prawdziwe: trasy `app/api/mobile/v1/ksiegowosc/ewidencja/{wpisy,spisy}/**`, bramka tokenu,
 * `lib/api/mobile/ksiegowosc-zapisy.ts`; w testach zgodności także `app/actions/ksiegowosc-ewidencja.ts`,
 * a w testach drogi zapisu prawdziwe `lib/ksiegowosc/ewidencja-zapis.ts` (schematy strony, ustawienia
 * podatkowe na dzień wpisu, zapis, audyt) na atrapie PostgREST. Atrapy: HTTP do GoTrue i PostgREST,
 * wyłączniki, audyt.
 */

const SUPABASE_URL = 'https://db.fixture.test';
const USER_OWNER = 'aaaaaaaa-1111-4111-8111-000000000001';
const USER_MEMBER = 'aaaaaaaa-1111-4111-8111-000000000002';
const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID = '99999999-9999-4999-8999-999999999999';

const fake = vi.hoisted(() => {
  const sets = new Map<string, Map<string, number>>();
  const zset = (key: string) => {
    let set = sets.get(key);
    if (!set) sets.set(key, (set = new Map()));
    return set;
  };
  const client = {
    pipeline() {
      const ops: Array<() => number> = [];
      const pipe = {
        zremrangebyscore: () => (ops.push(() => 0), pipe),
        zadd: (key: string, entry: { score: number; member: string }) => (ops.push(() => (zset(key).set(entry.member, entry.score), 1)), pipe),
        zcard: (key: string) => (ops.push(() => zset(key).size), pipe),
        expire: () => (ops.push(() => 1), pipe),
        exec: async () => ops.map((op) => op()),
      };
      return pipe;
    },
    zrange: async () => [],
    zrem: async () => 0,
  };
  return {
    client,
    sets,
    obszary: {} as Record<string, boolean>,
    kpirObszar: true,
    audit: vi.fn(),
    requireOrgRole: vi.fn(),
    forma: 'ryczalt' as 'ryczalt' | 'skala',
    wstawione: [] as unknown[],
    bladWstawienia: null as null | { code: string },
  };
});

vi.mock('@/lib/cache/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cache/redis')>();
  return { ...actual, isRedisConfigured: () => true, getRedis: () => fake.client };
});
vi.mock('@/lib/feature-flags/maintenance', () => ({ isMaintenanceMode: async () => false, MAINTENANCE_PATH: '/przerwa-techniczna' }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: fake.audit }));
vi.mock('@/lib/supabase/auth-context', async (orig) => ({ ...(await orig<typeof import('@/lib/supabase/auth-context')>()), requireOrgRole: fake.requireOrgRole }));
vi.mock('@/lib/ksiegowosc/wylacznik', () => ({
  czyKsiegowoscWlaczona: async (_c: unknown, _t: string, obszar: string) => ({ wlaczony: fake.obszary[obszar] === true }),
  statusObszaru: () => ({ wlaczony: fake.kpirObszar }),
}));

import { dodajSpisAction, dodajWpisKpirAction, dodajWpisRecznyAction, usunSpisAction, usunWpisRecznyAction } from '@/app/actions/ksiegowosc-ewidencja';
import { POST as wpisRoute } from '@/app/api/mobile/v1/ksiegowosc/ewidencja/wpisy/route';
import { POST as wpisUsunRoute } from '@/app/api/mobile/v1/ksiegowosc/ewidencja/wpisy/[id]/usuniecie/route';
import { POST as spisRoute } from '@/app/api/mobile/v1/ksiegowosc/ewidencja/spisy/route';
import { POST as spisUsunRoute } from '@/app/api/mobile/v1/ksiegowosc/ewidencja/spisy/[id]/usuniecie/route';

const b64url = (value: string) => Buffer.from(value).toString('base64url');
function accessToken(sub: string, n: number): string {
  const now = Math.floor(Date.now() / 1000);
  return [b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), b64url(JSON.stringify({ aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 3600, sub, aal: 'aal1', session_id: `cccccccc-2222-4222-8222-00000000000${n}` })), b64url('sig')].join('.');
}
const TOKEN_OWNER = accessToken(USER_OWNER, 1);
const TOKEN_MEMBER = accessToken(USER_MEMBER, 2);
const TOKEN_OBCY = accessToken('aaaaaaaa-1111-4111-8111-00000000000f', 4);
const issued = new Map([[TOKEN_OWNER, USER_OWNER], [TOKEN_MEMBER, USER_MEMBER]]);
const memberships = [
  { user_id: USER_OWNER, organization_id: ORG_A, role: 'owner', status: 'active' },
  { user_id: USER_MEMBER, organization_id: ORG_A, role: 'member', status: 'active' },
];

/** Atrapa PostgREST: członkostwa, ustawienia podatkowe (forma od 1.01.2026), zapis wpisu i spisu, usunięcia. */
async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? null;
  const sub = token ? issued.get(token) : undefined;
  if (url.pathname === '/auth/v1/user') {
    return sub ? Response.json({ id: sub, aud: 'authenticated', role: 'authenticated', email: 'jan@example.test', factors: [] }) : Response.json({}, { status: 401 });
  }
  if (!sub) return Response.json({}, { status: 401 });
  const asObject = request.headers.get('accept')?.includes('vnd.pgrst.object');
  if (url.pathname === '/rest/v1/memberships') {
    const rows = memberships.filter((m) => m.user_id === sub && m.organization_id === url.searchParams.get('organization_id')?.slice(3));
    return asObject ? (rows[0] ? Response.json(rows[0]) : Response.json({}, { status: 406 })) : Response.json(rows);
  }
  if (url.pathname === '/rest/v1/tax_profiles') {
    return Response.json([{ id: 'p1', valid_from: '2026-01-01', forma: fake.forma, stawka_domyslna: 850, zus_etap: 'pelny', zus_od: null, chorobowe: false, nrs_zus: null, najem: false }]);
  }
  if (url.pathname === '/rest/v1/ledger_manual_entries' && request.method === 'POST') {
    const body = (await request.json()) as Record<string, unknown>;
    fake.wstawione.push(body);
    return Response.json({ id: ID, rodzaj: body.rodzaj, data_przychodu: body.data_przychodu, data_wpisu: '2026-11-14', dokument: body.dokument, kwota_gr: body.kwota_gr, stawka_pb: body.stawka_pb, kolumna: body.kolumna, opis: body.opis }, { status: 201 });
  }
  if (url.pathname === '/rest/v1/ledger_inventory_counts' && request.method === 'POST') {
    const body = (await request.json()) as Record<string, unknown>;
    fake.wstawione.push(body);
    if (fake.bladWstawienia) return Response.json({ code: fake.bladWstawienia.code, message: 'duplicate' }, { status: 409 });
    return Response.json({ id: ID, data: body.data, kwota_gr: body.kwota_gr, opis: body.opis }, { status: 201 });
  }
  if (request.method === 'DELETE' && (url.pathname === '/rest/v1/ledger_manual_entries' || url.pathname === '/rest/v1/ledger_inventory_counts')) {
    return Response.json(url.searchParams.get('id') === `eq.${ID}` ? [{ id: ID, rodzaj: 'inny', data_przychodu: '2026-10-05', data_wpisu: '2026-10-06', dokument: 'RK/1', kwota_gr: 1000, stawka_pb: 850, opis: null, data: '2026-12-31' }] : []);
  }
  return Response.json({ message: url.pathname }, { status: 404 });
}

let ip = 0;
function req(path: string, options: { token?: string | null; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { 'x-real-ip': `203.0.113.${(ip += 1) % 250}`, 'x-active-org': ORG_A };
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN_OWNER}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`https://app.example.test/api/mobile/v1/${path}`, { method: 'POST', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
}
const blad = async (r: Response) => ((await r.json()) as { error: { code: string; field?: string; message: string } }).error;
const ctxId = (id: string) => ({ params: Promise.resolve({ id }) });

const WPIS = { typ: 'ewidencja', rodzaj: 'raport_kasy', dataPrzychodu: '2026-10-20', dokument: 'RK/10', kwota: '123,45', stawkaPb: 850, opis: null } as const;
const WPIS_KPIR = { typ: 'kpir', rodzaj: 'inny', dataPrzychodu: '2026-10-20', dokument: 'KO/1', kwota: '200,00', kolumna: 'k13', opis: 'Opłata' } as const;
const SPIS = { data: '2025-12-31', kwota: '4500,00', opis: 'Na początek roku' };

beforeEach(() => {
  vi.clearAllMocks();
  fake.sets.clear();
  fake.obszary = { ewidencja: true };
  fake.kpirObszar = true;
  fake.forma = 'ryczalt';
  fake.wstawione = [];
  fake.bladWstawienia = null;
  fake.requireOrgRole.mockImplementation(async () => ({ supabase: fakeSupabaseStrony(), user: { id: USER_OWNER, email: 'jan@example.test' }, tenantId: ORG_A, role: 'owner' }));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-14T09:00:00Z'));
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Klient „sesji strony” dla akcji: to samo PostgREST co telefon (token właściciela). */
function fakeSupabaseStrony() {
  // Akcje strony dostają klienta z `lib/supabase/server`; tu ten sam typ zapytań przez atrapę fetch.
  return createClient(SUPABASE_URL, 'anon', { global: { headers: { authorization: `Bearer ${TOKEN_OWNER}`, 'x-active-org': ORG_A } }, auth: { persistSession: false } });
}

describe('brak i zły token', () => {
  const trasy: Array<[string, (r: Request) => Promise<Response>, string, unknown]> = [
    ['POST /ewidencja/wpisy', wpisRoute, 'ksiegowosc/ewidencja/wpisy', WPIS],
    ['POST /ewidencja/wpisy/{id}/usuniecie', (r) => wpisUsunRoute(r, ctxId(ID)), `ksiegowosc/ewidencja/wpisy/${ID}/usuniecie`, undefined],
    ['POST /ewidencja/spisy', spisRoute, 'ksiegowosc/ewidencja/spisy', SPIS],
    ['POST /ewidencja/spisy/{id}/usuniecie', (r) => spisUsunRoute(r, ctxId(ID)), `ksiegowosc/ewidencja/spisy/${ID}/usuniecie`, undefined],
  ];
  it.each(trasy)('%s: bez tokenu i z tokenem spoza GoTrue 401, bez zapisu i audytu', async (_n, trasa, sciezka, body) => {
    for (const token of [null, 'nie-jwt', TOKEN_OBCY]) expect((await trasa(req(sciezka, { token, body }))).status).toBe(401);
    expect(fake.wstawione).toEqual([]);
    expect(fake.audit).not.toHaveBeenCalled();
  });
});

describe('zapis wpisu ręcznego: ta sama droga co strona', () => {
  it('ewidencja ryczałtu: wiersz do bazy i audyt takie same jak z akcji strony (grosze, stawka, firma)', async () => {
    const { typ: _typ, ...wejscie } = WPIS;
    expect(await dodajWpisRecznyAction(wejscie)).toEqual({ success: true });
    const response = await wpisRoute(req('ksiegowosc/ewidencja/wpisy', { body: WPIS }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ zapisano: true });
    const [wStrony, wTelefonu] = fake.wstawione;
    expect(wTelefonu).toEqual(wStrony);
    expect(wTelefonu).toMatchObject({ tenant_id: ORG_A, rodzaj: 'raport_kasy', data_przychodu: '2026-10-20', dokument: 'RK/10', kwota_gr: 12345, stawka_pb: 850 });
    expect(fake.audit).toHaveBeenCalledTimes(2);
    const [[auditStrony], [auditTelefonu]] = fake.audit.mock.calls as [[Record<string, unknown>], [Record<string, unknown>]];
    expect(auditTelefonu).toEqual(auditStrony);
    expect(auditTelefonu).toMatchObject({ action: 'ledger_entry.created', tenantId: ORG_A, userId: USER_OWNER });
  });

  it('KPiR: kolumna zamiast stawki, audyt `ledger_entry.kpir_created`; forma ryczałt odmawia zdaniem strony z polem', async () => {
    fake.forma = 'skala';
    const { typ: _typ, ...wejscie } = WPIS_KPIR;
    expect(await dodajWpisKpirAction(wejscie)).toEqual({ success: true });
    expect((await wpisRoute(req('ksiegowosc/ewidencja/wpisy', { body: WPIS_KPIR }))).status).toBe(201);
    expect(fake.wstawione[1]).toEqual(fake.wstawione[0]);
    expect(fake.wstawione[1]).toMatchObject({ kolumna: 'k13', kwota_gr: 20000, rodzaj: 'inny', opis: 'Opłata' });
    expect(fake.audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'ledger_entry.kpir_created' }));
    fake.forma = 'ryczalt';
    fake.wstawione = [];
    const odmowa = await wpisRoute(req('ksiegowosc/ewidencja/wpisy', { body: WPIS_KPIR }));
    expect(odmowa.status).toBe(422);
    expect(await blad(odmowa)).toMatchObject({ code: 'ledger_refused', field: 'dataPrzychodu', message: expect.stringContaining('forma opodatkowania to ryczałt') });
    expect(fake.wstawione).toEqual([]);
  });

  it('odmowy schematu strony z polem: zła kwota, zła stawka, data z przyszłości, wyłączony obszar; nic się nie zapisuje', async () => {
    const zapytaj = async (zmiana: Record<string, unknown>) => wpisRoute(req('ksiegowosc/ewidencja/wpisy', { body: { ...WPIS, ...zmiana } }));
    const kwota = await zapytaj({ kwota: 'abc' });
    expect(kwota.status).toBe(422);
    expect(await blad(kwota)).toMatchObject({ code: 'ledger_refused', field: 'kwota' });
    expect(await blad(await zapytaj({ stawkaPb: 777 }))).toMatchObject({ field: 'stawkaPb' });
    expect(await blad(await zapytaj({ dataPrzychodu: '2026-11-20' }))).toMatchObject({ field: 'dataPrzychodu', message: 'Data przychodu nie może być późniejsza niż dziś.' });
    fake.obszary = {};
    const wylaczony = await zapytaj({});
    expect(wylaczony.status).toBe(422);
    expect((await blad(wylaczony)).message).toBe('Ewidencja przychodów nie jest jeszcze dostępna dla tej firmy.');
    expect(fake.wstawione).toEqual([]);
    expect(fake.audit).not.toHaveBeenCalled();
  });

  it('członek firmy: 403 bez zapisu; treść spoza kontraktu (nieznany typ, obce pole, zły typ pola): 400', async () => {
    expect((await wpisRoute(req('ksiegowosc/ewidencja/wpisy', { token: TOKEN_MEMBER, body: WPIS }))).status).toBe(403);
    for (const zle of [{ ...WPIS, typ: 'inne' }, { ...WPIS, pesel: '1' }, { ...WPIS, stawkaPb: '850' }, { ...WPIS_KPIR, stawkaPb: 850 }]) {
      expect((await wpisRoute(req('ksiegowosc/ewidencja/wpisy', { body: zle }))).status).toBe(400);
    }
    expect(fake.wstawione).toEqual([]);
  });
});

describe('usunięcie wpisu i spisu, spis z natury', () => {
  it('usunięcie wpisu: audyt jak z akcji strony; drugi raz 422 „już nie ma”; zły identyfikator 404; członek 403', async () => {
    expect(await usunWpisRecznyAction(ID)).toEqual({ success: true });
    const ok = await wpisUsunRoute(req(`ksiegowosc/ewidencja/wpisy/${ID}/usuniecie`), ctxId(ID));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ usunieto: true });
    const [[auditStrony], [auditTelefonu]] = fake.audit.mock.calls as [[Record<string, unknown>], [Record<string, unknown>]];
    expect(auditTelefonu).toEqual(auditStrony);
    expect(auditTelefonu).toMatchObject({ action: 'ledger_entry.deleted', entityId: ID });
    const inny = '11111111-1111-4111-8111-111111111111';
    const brak = await wpisUsunRoute(req(`ksiegowosc/ewidencja/wpisy/${inny}/usuniecie`), ctxId(inny));
    expect(brak.status).toBe(422);
    expect(await blad(brak)).toMatchObject({ code: 'ledger_refused', message: 'Tego wpisu już nie ma na liście.' });
    expect((await wpisUsunRoute(req('ksiegowosc/ewidencja/wpisy/x/usuniecie'), ctxId('x'))).status).toBe(404);
    expect((await wpisUsunRoute(req(`ksiegowosc/ewidencja/wpisy/${ID}/usuniecie`, { token: TOKEN_MEMBER }), ctxId(ID))).status).toBe(403);
  });

  it('spis: zapis jak z akcji strony, KPiR wyłączona odmawia, spis z tego samego dnia zdanie z polem, usunięcie jak z akcji', async () => {
    fake.forma = 'skala';
    expect(await dodajSpisAction(SPIS)).toEqual({ success: true });
    const ok = await spisRoute(req('ksiegowosc/ewidencja/spisy', { body: SPIS }));
    expect(ok.status).toBe(201);
    expect(fake.wstawione[1]).toEqual(fake.wstawione[0]);
    expect(fake.wstawione[1]).toMatchObject({ tenant_id: ORG_A, data: '2025-12-31', kwota_gr: 450000, opis: 'Na początek roku' });
    expect(fake.audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'ledger_inventory.created', tenantId: ORG_A, userId: USER_OWNER }));
    // Data spisu z przyszłości odmawia, spis z tego samego dnia zatrzymuje UNIQUE, KPiR wyłączona odmawia.
    const przyszlosc = await spisRoute(req('ksiegowosc/ewidencja/spisy', { body: { ...SPIS, data: '2026-12-31' } }));
    expect(przyszlosc.status).toBe(422);
    expect(await blad(przyszlosc)).toMatchObject({ code: 'ledger_refused', field: 'data', message: 'Data spisu nie może być późniejsza niż dziś.' });
    fake.bladWstawienia = { code: '23505' };
    const duplikat = await spisRoute(req('ksiegowosc/ewidencja/spisy', { body: SPIS }));
    expect(await blad(duplikat)).toMatchObject({ code: 'ledger_refused', field: 'data', message: 'Spis z tego dnia już jest; poprawka to usunięcie spisu i dodanie nowego.' });
    fake.bladWstawienia = null;
    fake.kpirObszar = false;
    const wylaczona = await spisRoute(req('ksiegowosc/ewidencja/spisy', { body: SPIS }));
    expect((await blad(wylaczona)).message).toBe('KPiR w module księgowości jest chwilowo niedostępna dla tej firmy.');
    expect((await spisRoute(req('ksiegowosc/ewidencja/spisy', { token: TOKEN_MEMBER, body: SPIS }))).status).toBe(403);
    expect((await spisRoute(req('ksiegowosc/ewidencja/spisy', { body: { ...SPIS, x: 1 } }))).status).toBe(400);
    // Usunięcie spisu: audyt jak z akcji strony.
    fake.kpirObszar = true;
    fake.audit.mockClear();
    expect(await usunSpisAction(ID)).toEqual({ success: true });
    const usuniety = await spisUsunRoute(req(`ksiegowosc/ewidencja/spisy/${ID}/usuniecie`), ctxId(ID));
    expect(usuniety.status).toBe(200);
    const [[auditStrony], [auditTelefonu]] = fake.audit.mock.calls as [[Record<string, unknown>], [Record<string, unknown>]];
    expect(auditTelefonu).toEqual(auditStrony);
    expect(auditTelefonu).toMatchObject({ action: 'ledger_inventory.deleted', entityId: ID });
    expect((await spisUsunRoute(req(`ksiegowosc/ewidencja/spisy/${ID}/usuniecie`, { token: TOKEN_MEMBER }), ctxId(ID))).status).toBe(403);
    expect((await spisUsunRoute(req('ksiegowosc/ewidencja/spisy/x/usuniecie'), ctxId('x'))).status).toBe(404);
  });
});
