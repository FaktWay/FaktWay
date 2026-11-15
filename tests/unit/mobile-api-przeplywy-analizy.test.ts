import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan aplikacji mobilnej, M10e (część 2): Przepływy i Analizy z prawdziwego
 * konta (`GET /api/mobile/v1/przeplywy`, `GET /api/mobile/v1/analizy`).
 *
 * Prawdziwe: trasy, bramka, `lib/api/mobile/{przeplywy,analizy}.ts`, czyste
 * funkcje strony (`lib/dashboard/cash-movements.ts`, `lib/analytics-finance/*`,
 * adaptery pierścienia i analiz). Atrapy: HTTP (GoTrue, członkostwo), Redis
 * i odczyty z bazy, które mają własne testy na ścieżce strony (`kontekstDanych`,
 * `getInflows`, `getCostsWithKsefPurchases`, `getSalesInvoices`,
 * `fetchProductLines`, `getReceivables`, zwolnienie z VAT, szacunek podatku).
 */

const SUPABASE_URL = 'https://db.fixture.test';
const OWNER = 'aaaaaaaa-1111-4111-8111-000000000001';
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
  return {
    client,
    kontekst: vi.fn(),
    inflows: vi.fn(),
    costs: vi.fn(),
    sales: vi.fn(),
    lines: vi.fn(),
    receivables: vi.fn(),
    exemption: vi.fn(),
    cashFlow: vi.fn(),
  };
});

vi.mock('@/lib/cache/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cache/redis')>();
  return { ...actual, isRedisConfigured: () => true, getRedis: () => fake.client };
});
vi.mock('@/lib/feature-flags/maintenance', () => ({ isMaintenanceMode: async () => false, MAINTENANCE_PATH: '/przerwa-techniczna' }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/demo/tryb-danych', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/demo/tryb-danych')>()), kontekstDanych: fake.kontekst }));
vi.mock('@/lib/dashboard/inflows', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/dashboard/inflows')>()), getInflows: fake.inflows }));
vi.mock('@/lib/dashboard/costs', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/dashboard/costs')>()), getCostsWithKsefPurchases: fake.costs }));
vi.mock('@/lib/analytics-finance/sales', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/analytics-finance/sales')>()), getSalesInvoices: fake.sales }));
vi.mock('@/lib/dashboard/rankings', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/dashboard/rankings')>()), fetchProductLines: fake.lines }));
vi.mock('@/lib/dashboard/receivables', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/dashboard/receivables')>()), getReceivables: fake.receivables }));
vi.mock('@/lib/invoices/vat-exemption', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/invoices/vat-exemption')>()), readTenantVatExemption: fake.exemption }));
vi.mock('@/lib/dashboard/cash-flow', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/dashboard/cash-flow')>()), getCashFlowData: fake.cashFlow }));
vi.mock('@/lib/ksiegowosc/wylacznik', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/ksiegowosc/wylacznik')>()), czyKsiegowoscWlaczona: async () => ({ wlaczony: false }) }));

import { GET as analizyRoute } from '@/app/api/mobile/v1/analizy/route';
import { GET as przeplywyRoute } from '@/app/api/mobile/v1/przeplywy/route';

const b64url = (value: string) => Buffer.from(value).toString('base64url');
function accessToken(sub: string, n: number): string {
  const now = Math.floor(NOW.getTime() / 1000);
  return [
    b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    b64url(JSON.stringify({ aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 3600, sub, aal: 'aal1', session_id: `cccccccc-2222-4222-8222-00000000000${n}`, amr: [{ method: 'password', timestamp: now - 60 }] })),
    b64url('fixture-signature'),
  ].join('.');
}
const TOKEN = accessToken(OWNER, 1);

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== SUPABASE_URL) throw new Error(`nieoczekiwane wyjście do ${url.origin}`);
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? null;
  if (url.pathname === '/auth/v1/user') {
    if (token !== TOKEN) return Response.json({ msg: 'invalid JWT' }, { status: 401 });
    return Response.json({ id: OWNER, aud: 'authenticated', role: 'authenticated', email: 'o@example.test', factors: [], app_metadata: { provider: 'email', providers: ['email'] } });
  }
  if (token !== TOKEN) return Response.json({ message: 'JWT invalid' }, { status: 401 });
  if (url.pathname === '/rest/v1/memberships') {
    const org = url.searchParams.get('organization_id')?.slice(3);
    const row = { user_id: OWNER, organization_id: ORG_A, role: 'owner', status: 'active' };
    const rows = !org || org === ORG_A ? [row] : [];
    return request.headers.get('accept')?.includes('vnd.pgrst.object') ? (rows[0] ? Response.json(rows[0]) : Response.json({ code: 'PGRST116' }, { status: 406 })) : Response.json(rows);
  }
  return Response.json({ message: `nieznana ścieżka ${url.pathname}` }, { status: 404 });
}

let ip = 0;
function req(path: string, options: { token?: string | null; org?: string | null } = {}): Request {
  const headers: Record<string, string> = { 'x-real-ip': `198.51.100.${(ip += 1) % 250}` };
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN}`;
  if (options.org !== null) headers['x-active-org'] = options.org ?? ORG_A;
  return new Request(`https://app.example.test/api/mobile/v1/${path}`, { method: 'GET', headers });
}

const inflow = (o: Record<string, unknown>) => ({
  id: 'i1', date: '2026-11-10', basis: 'paid', amount: 1230, outstanding: 0, dueDate: '2026-11-20', invoiceKind: 'regular',
  internalNumber: 'FV/1/11/2026', buyerKey: 'nip:5252241585', buyerName: 'Klient Sp. z o.o.', buyerNip: '5252241585', consumers: false, ...o,
});
const cost = (o: Record<string, unknown>) => ({
  id: 'c1', issueDate: '2026-11-05', source: 'manual', sellerNip: '7010012356', sellerName: 'Drukarnia', cost: 400, outflow: 492, vatDeductible: 92,
  categoryLabel: 'Materiały', vat: 92, documentNumber: 'R/1', isReviewed: true, ...o,
});
const sale = (o: Record<string, unknown>) => ({
  id: 's1', issueDate: '2026-11-10', number: 'FV/1/11/2026', kind: 'regular', net: 1000, documentGross: 1230, buyer_nip: '5252241585',
  buyer_data: { name: 'Klient Sp. z o.o.', nip: '5252241585' }, is_b2c: false, ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  fake.kontekst.mockImplementation(async (ctx: { supabase: unknown; tenantId: string }) => ({ tryb: 'prawdziwe', demo: false, supabase: ctx.supabase, tenantId: ctx.tenantId, nowIso: NOW.toISOString(), verifiedAt: '2026-10-01T00:00:00Z', kosztyKsefOd: null }));
  fake.inflows.mockResolvedValue([inflow({}), inflow({ id: 'i2', date: '2026-11-25', basis: 'due', amount: 615, outstanding: 615, dueDate: '2026-11-25', internalNumber: 'FV/2/11/2026' })]);
  fake.costs.mockResolvedValue([cost({})]);
  fake.sales.mockResolvedValue([sale({}), sale({ id: 's2', issueDate: '2026-10-08', net: 500, documentGross: 615 })]);
  fake.lines.mockResolvedValue([]);
  fake.receivables.mockResolvedValue({ total: 615, overdue: 0, notDue: 615, count: 1, overdueCount: 0, oldestOverdueDays: null, byInvoice: [], foreignCurrencyCount: 0 });
  fake.exemption.mockResolvedValue(null);
  fake.cashFlow.mockResolvedValue({ taxEstimate: { amount: 1900, label: 'Szac. podatek od 1 stycznia', subtitle: '', fullYear: true } });
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

describe('Przepływy i Analizy za bramką', () => {
  it.each([
    ['GET /przeplywy', (o: Parameters<typeof req>[1]) => przeplywyRoute(req('przeplywy', o))],
    ['GET /analizy', (o: Parameters<typeof req>[1]) => analizyRoute(req('analizy', o))],
  ])('%s: bez tokenu 401, zły token 401, bez firmy 400, cudza firma 403; bez odczytu danych', async (_n, wywolaj) => {
    expect((await wywolaj({ token: null })).status).toBe(401);
    expect((await wywolaj({ token: accessToken('aaaaaaaa-1111-4111-8111-00000000dead', 9) })).status).toBe(401);
    expect((await wywolaj({ org: null })).status).toBe(400);
    expect((await wywolaj({ org: 'dddddddd-0000-4000-8000-000000000009' })).status).toBe(403);
    expect(fake.kontekst).not.toHaveBeenCalled();
    expect(fake.inflows).not.toHaveBeenCalled();
  });
});

describe('GET /api/mobile/v1/przeplywy', () => {
  it('karty strony z firmy tokenu: wykres, miesiąc, pierścień liniowy, źródła, spodziewane, operacje', async () => {
    const response = await przeplywyRoute(req('przeplywy'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(fake.kontekst).toHaveBeenCalledWith(expect.objectContaining({ tenantId: ORG_A, user: { id: OWNER } }), expect.any(Date));
    expect(body.tryb).toBe('prawdziwe');
    expect(body.wykres.ok).toBe(true);
    expect(body.wykres.dane.miesiac.kubelki.at(-1)).toMatchObject({ wplywy: 1230, koszty: 492, saldo: 738 });
    expect(body.wykres.dane.miesiac).toMatchObject({ sumaWplywow: 1230, sumaKosztow: 492 });
    expect(body.miesiac.dane.wplywy).toMatchObject({ kwota: 1230, liczba: 1 });
    expect(body.pierscien.dane).toMatchObject({ tytul: 'Odłóż na podatek', procent: 19, podpis: 'Szacunek: liniowy, bez ZUS' });
    expect(body.zrodla.dane.map((z: { nazwa: string }) => z.nazwa)).toEqual(expect.arrayContaining(['Klient Sp. z o.o.', 'Drukarnia']));
    expect(body.spodziewane.dane).toMatchObject({ liczba: 1, suma: 615, pozycje: [expect.objectContaining({ numer: 'FV/2/11/2026', dniDoTerminu: 10 })] });
    expect(body.operacje.dane[0]).toMatchObject({ kierunek: 'in', kwota: 1230, status: 'paid' });
  });

  it('firma zwolniona podmiotowo: pierścień limitu zwolnienia z VAT, nie „Odłóż na podatek”', async () => {
    fake.exemption.mockResolvedValue('art. 113 ust. 1 ustawy o VAT');
    const body = await (await przeplywyRoute(req('przeplywy'))).json();
    expect(body.pierscien.ok === false || body.pierscien.dane.tytul === 'Limit zwolnienia z VAT').toBe(true);
    expect(fake.cashFlow).not.toHaveBeenCalled();
  });

  it('błąd odczytu kosztów: karty z ostatnich 12 miesięcy dostają zdanie strażnika, reszta zostaje', async () => {
    fake.costs.mockRejectedValue(new Error('Koszty ze skrzynki KSeF w walucie obcej: dokument X: szczegóły'));
    const body = await (await przeplywyRoute(req('przeplywy'))).json();
    expect(body.miesiac).toEqual({ ok: false, blad: 'Koszty ze skrzynki KSeF w walucie obcej' });
    expect(body.pierscien.ok).toBe(true);
  });
});

describe('GET /api/mobile/v1/analizy', () => {
  it('sprzedaż wybranego miesiąca: kafle, trend 6 miesięcy, należności, wynik, kalendarz 180 dni', async () => {
    const body = await (await analizyRoute(req('analizy?widok=sprzedaz&miesiac=2026-11'))).json();
    expect(body).toMatchObject({ widok: 'sprzedaz', miesiac: '2026-11', tryb: 'prawdziwe', vat: null });
    expect(body.miesiace).toHaveLength(6);
    expect(body.kafle.dane).toMatchObject({ suma: 1000, najlepszy: 'Klient Sp. z o.o.', zmianaPct: 100 });
    expect(body.trend.dane).toHaveLength(6);
    expect(body.trend.dane.at(-1)).toMatchObject({ klucz: '2026-11', kwota: 1000 });
    expect(body.naleznosci.dane).toMatchObject({ doZaplaty: 615, liczba: 1 });
    expect(body.wynik.dane).toEqual({ przychody: 1000, koszty: 400, wynik: 600 });
    expect(body.kalendarz.dane).toHaveLength(180);
    expect(body.kalendarz.dane.find((d: { dzien: string }) => d.dzien === '2026-11-10')).toEqual({ dzien: '2026-11-10', kwota: 1000, poziom: 4 });
    expect(body.kalendarz.dane.find((d: { dzien: string }) => d.dzien === '2026-11-11')).toMatchObject({ kwota: 0, poziom: 0 });
    expect(body.ostatnie.dane[0]).toMatchObject({ nazwa: 'Klient Sp. z o.o.', kwota: 1230 });
  });

  it('koszty: kategorie z procentem od serwera, VAT z wydatków, bez należności; miesiąc spoza listy to bieżący', async () => {
    const body = await (await analizyRoute(req('analizy?widok=koszty&miesiac=2020-01'))).json();
    expect(body).toMatchObject({ widok: 'koszty', naleznosci: null });
    expect(body.miesiac).toBe(body.miesiace[0].klucz);
    expect(body.podzial.dane[0]).toMatchObject({ etykieta: 'Materiały', procent: 100 });
    expect(body.vat.dane).toEqual({ vat: 92, doOdliczenia: 92, doOpisania: 0 });
  });

  it('dane przykładowe przed potwierdzeniem KSeF: tryb `przyklad`, należności nie udają prawdziwych', async () => {
    fake.kontekst.mockImplementation(async () => ({ tryb: 'przyklad', demo: true, supabase: {}, tenantId: 'demo', nowIso: NOW.toISOString(), verifiedAt: null, kosztyKsefOd: null }));
    const body = await (await analizyRoute(req('analizy'))).json();
    expect(body.tryb).toBe('przyklad');
    expect(body.naleznosci.ok).toBe(false);
    expect(fake.receivables).not.toHaveBeenCalled();
  });
});
