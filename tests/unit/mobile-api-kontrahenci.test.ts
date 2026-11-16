import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan aplikacji mobilnej, M10e: kontrahenci z telefonu (lista, szczegół,
 * dodanie, poprawka, usunięcie).
 *
 * Prawdziwe: trasy `app/api/mobile/v1/kontrahenci/**`, bramka
 * `authenticateMobileRequest`, `lib/api/mobile/kontrahenci.ts`,
 * `lib/contractors/manage.ts` (ta sama logika co akcje strony) i kafle
 * z `lib/contractors/overview.ts` aż do zapytań PostgREST. Atrapy: HTTP
 * (GoTrue, PostgREST przez `fetch`, z izolacją firm jak RLS 00004), Redis,
 * zapis audytu (klucz serwisowy) i `getReceivables` (ma własne testy na ścieżce
 * strony; tu granica, przez którą trasa rozkłada należności po NIP).
 * Prawdziwa baza z RLS: `tests/rls-mobile-kontrahenci.test.ts`.
 */

const SUPABASE_URL = 'https://db.fixture.test';
const OWNER = 'aaaaaaaa-1111-4111-8111-000000000001';
const ACCOUNTANT = 'aaaaaaaa-1111-4111-8111-000000000002';
const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C1 = 'cccccccc-0000-4000-8000-000000000001';
const C2 = 'cccccccc-0000-4000-8000-000000000002';
const C_B = 'cccccccc-0000-4000-8000-0000000000b1';
// Fikcyjne NIP-y z poprawną sumą kontrolną.
const NIP_1 = '5252241585';
const NIP_2 = '7010012345';
const NIP_NEW = '1060000062';
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
  return { client, audit: vi.fn(async () => undefined), receivables: vi.fn() };
});

vi.mock('@/lib/cache/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cache/redis')>();
  return { ...actual, isRedisConfigured: () => true, getRedis: () => fake.client };
});
vi.mock('@/lib/feature-flags/maintenance', () => ({ isMaintenanceMode: async () => false, MAINTENANCE_PATH: '/przerwa-techniczna' }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: fake.audit }));
vi.mock('@/lib/dashboard/receivables', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dashboard/receivables')>();
  return { ...actual, getReceivables: fake.receivables };
});

import { GET as listaRoute, POST as dodajRoute } from '@/app/api/mobile/v1/kontrahenci/route';
import { GET as jedenRoute, POST as zmienRoute } from '@/app/api/mobile/v1/kontrahenci/[id]/route';
import { POST as usunRoute } from '@/app/api/mobile/v1/kontrahenci/[id]/usuniecie/route';

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
const TOKEN_ACCOUNTANT = accessToken(ACCOUNTANT, 2);
const issued = new Map([[TOKEN_OWNER, OWNER], [TOKEN_ACCOUNTANT, ACCOUNTANT]]);
const memberships = [
  { user_id: OWNER, organization_id: ORG_A, role: 'owner', status: 'active' },
  { user_id: ACCOUNTANT, organization_id: ORG_A, role: 'accountant', status: 'active' },
  { user_id: OWNER, organization_id: ORG_B, role: 'owner', status: 'active' },
];

type Row = Record<string, unknown>;
let contractors: Row[] = [];
let writes: Array<{ method: string; org: string | null }> = [];
let failList = false;

function contractor(o: Row): Row {
  return {
    tenant_id: ORG_A, nip: NIP_1, name: 'Klient Sp. z o.o.', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' },
    email: null, phone: null, vat_status: 'active', validation_warning: null, last_validation_at: '2026-11-01T10:00:00Z',
    reminder_excluded: false, reminder_exclusion_reason: null, last_used_at: '2026-11-10T10:00:00Z', manual_fields: [], ...o,
  };
}

/** Warunki `kolumna=eq.wartość` z adresu PostgREST. */
function eqs(url: URL): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of url.searchParams) if (v.startsWith('eq.')) out.push([k, decodeURIComponent(v.slice(3))]);
  return out;
}

/** `or=(name.ilike.%x%,nip.ilike.%1%)`: wystarczy dla `contractorSearchFilter`. */
function orMatch(url: URL, row: Row): boolean {
  const or = url.searchParams.get('or');
  if (!or) return true;
  return or.replace(/^\(|\)$/g, '').split(',').some((part) => {
    const [col, , ...rest] = part.split('.');
    const term = rest.join('.').replace(/^%|%$/g, '').replace(/^\*|\*$/g, '').toLowerCase();
    return String(row[col!] ?? '').toLowerCase().includes(term);
  });
}

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
  const asObject = request.headers.get('accept')?.includes('vnd.pgrst.object');
  const org = request.headers.get('x-active-org');

  if (url.pathname === '/rest/v1/memberships') {
    const filters = eqs(url);
    const rows = memberships.filter((m) => m.user_id === sub && filters.every(([k, v]) => k === 'user_id' || String((m as Row)[k]) === v));
    return asObject ? (rows[0] ? Response.json(rows[0]) : Response.json({ code: 'PGRST116' }, { status: 406 })) : Response.json(rows);
  }
  // Faktury dla kafla „Aktywni (90 dni)”: brak przyjętych w oknie.
  if (url.pathname === '/rest/v1/invoices') return new Response('[]', { status: 200, headers: { 'content-type': 'application/json', 'content-range': '*/0' } });

  if (url.pathname === '/rest/v1/contractors') {
    // RLS 00004: wiersz widać i zmienia się tylko w firmie z `x-active-org`, do której konto należy.
    const member = memberships.some((m) => m.user_id === sub && m.organization_id === org);
    const visible = () => contractors.filter((r) => member && r.tenant_id === org && eqs(url).every(([k, v]) => String(r[k]) === v) && orMatch(url, r));
    if (request.method === 'GET') {
      if (failList) return Response.json({ message: 'boom' }, { status: 500 });
      const rows = visible();
      if (asObject) return rows[0] ? Response.json(rows[0]) : Response.json({ code: 'PGRST116', message: 'no rows' }, { status: 406 });
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json', 'content-range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}` } });
    }
    writes.push({ method: request.method, org });
    if (request.method === 'POST') {
      const body = (await request.json()) as Row;
      if (!member || body.tenant_id !== org) return Response.json({ code: '42501', message: 'new row violates row-level security policy' }, { status: 403 });
      if (contractors.some((r) => r.tenant_id === body.tenant_id && r.nip === body.nip)) {
        return Response.json({ code: '23505', message: 'duplicate key value violates unique constraint "contractors_tenant_id_nip_key"' }, { status: 409 });
      }
      const row = contractor({ vat_status: null, last_validation_at: null, last_used_at: null, ...body, id: `cccccccc-0000-4000-8000-${String(contractors.length + 100).padStart(12, '0')}` });
      contractors.push(row);
      return asObject ? Response.json({ id: row.id }, { status: 201 }) : Response.json([{ id: row.id }], { status: 201 });
    }
    if (request.method === 'PATCH') {
      const patch = (await request.json()) as Row;
      const rows = visible();
      rows.forEach((r) => Object.assign(r, patch));
      return Response.json(rows.map((r) => ({ id: r.id })));
    }
    if (request.method === 'DELETE') {
      const rows = visible();
      contractors = contractors.filter((r) => !rows.includes(r));
      return Response.json(rows.map((r) => ({ id: r.id, nip: r.nip })));
    }
  }
  return Response.json({ message: `nieznana ścieżka ${url.pathname}` }, { status: 404 });
}

let ip = 0;
function req(path: string, options: { method?: string; token?: string | null; org?: string | null; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { 'x-real-ip': `198.51.100.${(ip += 1) % 250}` };
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN_OWNER}`;
  if (options.org !== null) headers['x-active-org'] = options.org ?? ORG_A;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`https://app.example.test/api/mobile/v1/${path}`, {
    method: options.method ?? 'POST',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
async function errorOf(response: Response) {
  return ((await response.json()) as { error: { code: string; message: string; field?: string } }).error;
}

const DANE = { nazwa: 'Nowy Klient Sp. z o.o.', adres1: 'ul. Nowa 2', adres2: '00-002 Warszawa', email: 'faktury@klient.example' };

beforeEach(() => {
  vi.clearAllMocks();
  writes = [];
  failList = false;
  contractors = [
    contractor({ id: C1 }),
    contractor({ id: C2, nip: NIP_2, name: 'Drugi Klient', vat_status: 'active', validation_warning: 'Rachunek spoza białej listy', last_used_at: '2026-11-01T10:00:00Z' }),
    contractor({ id: C_B, tenant_id: ORG_B, nip: NIP_1, name: 'Klient firmy B' }),
  ];
  fake.receivables.mockResolvedValue({
    total: 1500, overdue: 1000, notDue: 500, count: 2, overdueCount: 1, oldestOverdueDays: 12, foreignCurrencyCount: 1,
    byInvoice: [
      { id: 'i1', buyerNip: '525-224-15-85', outstanding: 1000, daysOverdue: 12 },
      { id: 'i2', buyerNip: NIP_1, outstanding: 500, daysOverdue: 0 },
    ],
  });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-fixture-key');
  vi.stubEnv('KSEF_ENV', 'test');
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('każda trasa kontrahentów za bramką', () => {
  it.each([
    ['GET /kontrahenci', (o: Parameters<typeof req>[1]) => listaRoute(req('kontrahenci', { method: 'GET', ...o }))],
    ['POST /kontrahenci', (o: Parameters<typeof req>[1]) => dodajRoute(req('kontrahenci', { body: { ...DANE, nip: NIP_NEW }, ...o }))],
    ['GET /kontrahenci/{id}', (o: Parameters<typeof req>[1]) => jedenRoute(req(`kontrahenci/${C1}`, { method: 'GET', ...o }), params(C1))],
    ['POST /kontrahenci/{id}', (o: Parameters<typeof req>[1]) => zmienRoute(req(`kontrahenci/${C1}`, { body: DANE, ...o }), params(C1))],
    ['POST /kontrahenci/{id}/usuniecie', (o: Parameters<typeof req>[1]) => usunRoute(req(`kontrahenci/${C1}/usuniecie`, o), params(C1))],
  ])('%s: bez tokenu 401, zły token 401, bez firmy 400, cudza firma 403; nic nie dotyka danych', async (_nazwa, wywolaj) => {
    const bezTokenu = await wywolaj({ token: null });
    expect(bezTokenu.status).toBe(401);
    expect((await errorOf(bezTokenu)).code).toBe('missing_token');
    const zlyToken = await wywolaj({ token: accessToken('aaaaaaaa-1111-4111-8111-00000000dead', 9) });
    expect(zlyToken.status).toBe(401);
    expect((await errorOf(zlyToken)).code).toBe('invalid_token');
    const bezFirmy = await wywolaj({ org: null });
    expect(bezFirmy.status).toBe(400);
    expect((await errorOf(bezFirmy)).code).toBe('missing_org');
    const cudza = await wywolaj({ org: 'dddddddd-0000-4000-8000-000000000009' });
    expect(cudza.status).toBe(403);
    expect((await errorOf(cudza)).code).toBe('no_active_org');
    expect(writes).toEqual([]);
    expect(fake.audit).not.toHaveBeenCalled();
    expect(contractors).toHaveLength(3);
  });
});

describe('GET /api/mobile/v1/kontrahenci', () => {
  it('lista firmy z nagłówka, od ostatnio użytych; należności po NIP (też z kreskami); kafle strony', async () => {
    const response = await listaRoute(req('kontrahenci', { method: 'GET' }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.lista.map((k: { id: string }) => k.id)).toEqual([C1, C2]);
    expect(body.lista[0]).toMatchObject({
      nip: NIP_1, nazwa: 'Klient Sp. z o.o.', adres: { linia1: 'ul. Testowa 1', linia2: '00-001 Warszawa' },
      statusVat: 'active', statusVatEtykieta: 'Czynny VAT', vatDoSprawdzenia: false,
      naleznosci: { doZaplaty: 1500, poTerminie: 1 },
    });
    // Czynny z ostrzeżeniem: „Wymaga uwagi” i do sprawdzenia, jak plakietka i kafel strony; bez należności to zero, nie brak.
    expect(body.lista[1]).toMatchObject({ statusVatEtykieta: 'Wymaga uwagi', vatDoSprawdzenia: true, naleznosci: { doZaplaty: 0, poTerminie: 0 } });
    expect(body.kafle).toEqual({
      wszyscy: { ok: true, dane: { wartosc: 2 } },
      aktywni: { ok: true, dane: { wartosc: 0, nota: 'z fakturą przyjętą w KSeF' } },
      zZaleglosciami: { ok: true, dane: { wartosc: 1, nota: 'Bez importów i faktur skorygowanych. Pominięto 1 fakturę w walucie obcej' } },
      vatDoSprawdzenia: { ok: true, dane: { wartosc: 1, nota: 'niezweryfikowani, wykreśleni i z ostrzeżeniem' } },
    });
    expect(body.nota).toContain('Pominięto 1 fakturę w walucie obcej');
    expect(body.mozeEdytowac).toBe(true);
    expect(JSON.stringify(body)).not.toContain('Klient firmy B');
  });

  it('szukanie w bazie po nazwie i NIP, bez kafli; fraza oczyszczona jak na stronie', async () => {
    const poNazwie = await (await listaRoute(req('kontrahenci?q=drugi', { method: 'GET' }))).json();
    expect(poNazwie.lista.map((k: { id: string }) => k.id)).toEqual([C2]);
    expect(poNazwie.kafle).toBeNull();
    const poNip = await (await listaRoute(req('kontrahenci?q=525-224', { method: 'GET' }))).json();
    expect(poNip.lista.map((k: { id: string }) => k.id)).toEqual([C1]);
    const zeZnakami = await (await listaRoute(req(`kontrahenci?q=${encodeURIComponent('a,(b)')}`, { method: 'GET' }))).json();
    expect(zeZnakami.fraza).toBe('a b');
  });

  it('należności się nie liczą: lista zostaje, kolumny `null`, zdanie strażnika strony; kafel zaległości z błędem', async () => {
    fake.receivables.mockRejectedValue(new Error('Nie można policzyć należności: faktura bez środowiska KSeF'));
    const body = await (await listaRoute(req('kontrahenci', { method: 'GET' }))).json();
    expect(body.lista).toHaveLength(2);
    expect(body.lista[0].naleznosci).toBeNull();
    expect(body.bladNaleznosci).toBe('Nie można policzyć należności');
    expect(body.kafle.zZaleglosciami).toEqual({ ok: false, blad: 'Nie można policzyć należności' });
    expect(body.kafle.wszyscy).toEqual({ ok: true, dane: { wartosc: 2 } });
  });

  it('błąd techniczny należności: zdanie ogólne bez szczegółów bazy', async () => {
    fake.receivables.mockRejectedValue(new Error('PGRST connection reset'));
    const body = await (await listaRoute(req('kontrahenci', { method: 'GET' }))).json();
    expect(body.bladNaleznosci).toBe('Nie udało się policzyć. Spróbuj ponownie za chwilę.');
  });

  it('błąd odczytu listy: 503, nie pusta lista', async () => {
    failList = true;
    const response = await listaRoute(req('kontrahenci', { method: 'GET' }));
    expect(response.status).toBe(503);
  });

  it('księgowa widzi listę, ale `mozeEdytowac: false`', async () => {
    const body = await (await listaRoute(req('kontrahenci', { method: 'GET', token: TOKEN_ACCOUNTANT }))).json();
    expect(body.lista).toHaveLength(2);
    expect(body.mozeEdytowac).toBe(false);
  });
});

describe('GET /api/mobile/v1/kontrahenci/{id}', () => {
  it('kontrahent firmy z nagłówka; cudzy albo nie UUID to 404', async () => {
    const body = await (await jedenRoute(req(`kontrahenci/${C1}`, { method: 'GET' }), params(C1))).json();
    expect(body.kontrahent).toMatchObject({ id: C1, naleznosci: { doZaplaty: 1500, poTerminie: 1 } });
    const cudzy = await jedenRoute(req(`kontrahenci/${C_B}`, { method: 'GET' }), params(C_B));
    expect(cudzy.status).toBe(404);
    expect((await errorOf(cudzy)).code).toBe('not_found');
    const zly = await jedenRoute(req('kontrahenci/x', { method: 'GET' }), params('x'));
    expect(zly.status).toBe(404);
  });
});

describe('POST /api/mobile/v1/kontrahenci (dodanie)', () => {
  it('201 z kontrahentem i wpisem audytu z `client: mobile`; NIP bez kresek', async () => {
    const response = await dodajRoute(req('kontrahenci', { body: { ...DANE, nip: '106-000-00-62' } }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.juzBylo).toBe(false);
    expect(body.kontrahent).toMatchObject({ nip: NIP_NEW, nazwa: 'Nowy Klient Sp. z o.o.', email: 'faktury@klient.example', statusVatEtykieta: 'Niezweryfikowany', vatDoSprawdzenia: true });
    const zapisany = contractors.find((r) => r.nip === NIP_NEW)!;
    expect(zapisany).toMatchObject({ tenant_id: ORG_A, address: { countryCode: 'PL', addressLine1: 'ul. Nowa 2', addressLine2: '00-002 Warszawa' }, last_used_at: NOW.toISOString() });
    expect(fake.audit).toHaveBeenCalledTimes(1);
    expect(fake.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'contractor.created', tenantId: ORG_A, userId: OWNER, metadata: { nip: NIP_NEW, client: 'mobile' } }));
  });

  it('ponowienie z tymi samymi danymi: 200 `juzBylo`, ten sam kontrahent, bez drugiego wpisu', async () => {
    const pierwszy = await (await dodajRoute(req('kontrahenci', { body: { ...DANE, nip: NIP_NEW } }))).json();
    const drugi = await dodajRoute(req('kontrahenci', { body: { ...DANE, nip: NIP_NEW } }));
    expect(drugi.status).toBe(200);
    const body = await drugi.json();
    expect(body).toMatchObject({ juzBylo: true, kontrahent: { id: pierwszy.kontrahent.id } });
    expect(contractors.filter((r) => r.nip === NIP_NEW)).toHaveLength(1);
    expect(fake.audit).toHaveBeenCalledTimes(1);
  });

  it('ten NIP z innymi danymi: 409 `contractor_exists` pod polem NIP, bez nadpisania', async () => {
    const response = await dodajRoute(req('kontrahenci', { body: { ...DANE, nip: NIP_1 } }));
    expect(response.status).toBe(409);
    const error = await errorOf(response);
    expect(error).toMatchObject({ code: 'contractor_exists', field: 'nip' });
    expect(error.message).toContain('Klient Sp. z o.o.');
    expect(contractors.find((r) => r.id === C1)!.name).toBe('Klient Sp. z o.o.');
  });

  it.each([
    ['zła suma kontrolna NIP', { ...DANE, nip: '1234567890' }, 'nip'],
    ['pusta nazwa', { ...DANE, nazwa: '  ', nip: NIP_NEW }, 'nazwa'],
    ['zły e-mail', { ...DANE, email: 'nie-mail', nip: NIP_NEW }, 'email'],
    ['znak sterujący w adresie', { ...DANE, adres1: 'ul.\u0007 Zła', nip: NIP_NEW }, 'adres1'],
  ])('%s: 422 `contractor_invalid` z polem telefonu, bez zapisu', async (_n, body, pole) => {
    const response = await dodajRoute(req('kontrahenci', { body }));
    expect(response.status).toBe(422);
    expect(await errorOf(response)).toMatchObject({ code: 'contractor_invalid', field: pole });
    expect(writes).toEqual([]);
  });

  it('treść spoza kontraktu: 400 `invalid_request`', async () => {
    const response = await dodajRoute(req('kontrahenci', { body: { ...DANE, nip: NIP_NEW, tenant_id: ORG_B } }));
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
    expect(writes).toEqual([]);
  });

  it('księgowa: 403 `forbidden` bez zapisu', async () => {
    const response = await dodajRoute(req('kontrahenci', { token: TOKEN_ACCOUNTANT, body: { ...DANE, nip: NIP_NEW } }));
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe('forbidden');
    expect(writes).toEqual([]);
  });
});

describe('POST /api/mobile/v1/kontrahenci/{id} (poprawka)', () => {
  it('zapis jak akcja strony: pola ręczne w `manual_fields`, NIP bez zmian, audyt z `client: mobile`', async () => {
    const response = await zmienRoute(req(`kontrahenci/${C1}`, { body: DANE }), params(C1));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.zmienione).toEqual(['nazwa', 'adres', 'email']);
    expect(body.kontrahent).toMatchObject({ nazwa: 'Nowy Klient Sp. z o.o.', nip: NIP_1 });
    expect(contractors.find((r) => r.id === C1)).toMatchObject({ manual_fields: ['name', 'address', 'email'], nip: NIP_1 });
    expect(fake.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'contractor.updated', entityId: C1, metadata: { fields: ['name', 'address', 'email'], client: 'mobile' } }));
  });

  it('ponowienie tych samych danych: `zmienione: []`, bez zapisu i bez drugiego wpisu', async () => {
    await zmienRoute(req(`kontrahenci/${C1}`, { body: DANE }), params(C1));
    writes = [];
    fake.audit.mockClear();
    const body = await (await zmienRoute(req(`kontrahenci/${C1}`, { body: DANE }), params(C1))).json();
    expect(body.zmienione).toEqual([]);
    expect(writes).toEqual([]);
    expect(fake.audit).not.toHaveBeenCalled();
  });

  it('kontrahent innej firmy: 404, bez zmiany', async () => {
    const response = await zmienRoute(req(`kontrahenci/${C_B}`, { body: DANE }), params(C_B));
    expect(response.status).toBe(404);
    expect(contractors.find((r) => r.id === C_B)!.name).toBe('Klient firmy B');
  });

  it('pusta nazwa: 422 pod polem `nazwa`; księgowa: 403', async () => {
    const zla = await zmienRoute(req(`kontrahenci/${C1}`, { body: { ...DANE, nazwa: '' } }), params(C1));
    expect(await errorOf(zla)).toMatchObject({ code: 'contractor_invalid', field: 'nazwa' });
    const ksiegowa = await zmienRoute(req(`kontrahenci/${C1}`, { token: TOKEN_ACCOUNTANT, body: DANE }), params(C1));
    expect(ksiegowa.status).toBe(403);
    expect(writes).toEqual([]);
  });
});

describe('POST /api/mobile/v1/kontrahenci/{id}/usuniecie', () => {
  it('usuwa w firmie z nagłówka z audytem; drugie usunięcie to 404', async () => {
    const response = await usunRoute(req(`kontrahenci/${C1}/usuniecie`), params(C1));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ usuniety: true });
    expect(contractors.some((r) => r.id === C1)).toBe(false);
    expect(fake.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'contractor.deleted', metadata: { nip: NIP_1, client: 'mobile' } }));
    const drugi = await usunRoute(req(`kontrahenci/${C1}/usuniecie`), params(C1));
    expect(drugi.status).toBe(404);
  });

  it('cudzy kontrahent zostaje; księgowa: 403', async () => {
    expect((await usunRoute(req(`kontrahenci/${C_B}/usuniecie`), params(C_B))).status).toBe(404);
    expect(contractors.some((r) => r.id === C_B)).toBe(true);
    expect((await usunRoute(req(`kontrahenci/${C1}/usuniecie`, { token: TOKEN_ACCOUNTANT }), params(C1))).status).toBe(403);
    expect(contractors.some((r) => r.id === C1)).toBe(true);
  });
});
