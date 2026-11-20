import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { kpirTotals } from '@/lib/reports/kpir-totals';
import { kpirPrzykladowe } from '@/lib/demo/kpir-przykladowe';
import { startExportAction } from '@/app/actions/exports';
import { pobierzJpkEwpAction, pobierzJpkPkpirAction } from '@/app/actions/ksiegowosc-ewidencja';
import { brakiKpirOkresu, sumyKpir, wierszeKpirOkresu, type Kpir } from '@/lib/ksiegowosc/kpir';
import { brakiOkresu, sumyOkresu, type Ewidencja } from '@/lib/ksiegowosc/ewidencja';
import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';

/**
 * Plan aplikacji mobilnej, M10d część 2: KPiR raportu, ewidencja albo KPiR modułu,
 * pliki JPK_EWP i JPK_PKPIR oraz ręczny eksport z telefonu.
 *
 * Prawdziwe: trasy `app/api/mobile/v1/{ksiegowosc,raport-kpir,eksport}/**`, bramka tokenu,
 * `lib/api/mobile/ksiegowosc-{ksiegi,eksport}.ts` i funkcje liczące strony (modele
 * `kpir-model`, `kpirTotals`, `sumyOkresu`, `sumyKpir`, `brakiOkresu`, `includesFor`).
 * Atrapy: HTTP do GoTrue i PostgREST, wyłączniki, odczyty miesiąca (`getKpirData`,
 * `czytajEwidencje`, `czytajKpir`, `czytajWersjeProfilu`; własne testy na ścieżce strony),
 * funkcje zapisu i plików (`pobierzJpkEwp`, `pobierzJpkPkpir`, `startManualExport`,
 * `downloadExportFile`; testy akcji `ksiegowosc-ewidencja-*` i `eksport-*`).
 *
 * Zgodność ze stroną: telefon i akcja strony wołają te same funkcje z tymi samymi danymi,
 * a kwoty i sumy w odpowiedzi są równe wynikom funkcji strony na tych samych danych.
 */

const SUPABASE_URL = 'https://db.fixture.test';
const USER_OWNER = 'aaaaaaaa-1111-4111-8111-000000000001';
const USER_MEMBER = 'aaaaaaaa-1111-4111-8111-000000000002';
const USER_KSIEGOWA = 'aaaaaaaa-1111-4111-8111-000000000003';
const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const FILE_ID = '88888888-8888-4888-8888-888888888888';

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
    tryb: 'prawdziwe' as 'prawdziwe' | 'przyklad',
    getKpirData: vi.fn(),
    czytajEwidencje: vi.fn(),
    czytajKpir: vi.fn(),
    wersje: vi.fn(),
    odeslanie: vi.fn(),
    ewp: vi.fn(),
    pkpir: vi.fn(),
    start: vi.fn(),
    pobierz: vi.fn(),
    urzad: vi.fn(),
    requireOrgRole: vi.fn(),
    requireUserAndTenant: vi.fn(),
    historia: [] as unknown[],
  };
});

vi.mock('@/lib/cache/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cache/redis')>();
  return { ...actual, isRedisConfigured: () => true, getRedis: () => fake.client };
});
vi.mock('@/lib/feature-flags/maintenance', () => ({ isMaintenanceMode: async () => false, MAINTENANCE_PATH: '/przerwa-techniczna' }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth-context', async (orig) => ({
  ...(await orig<typeof import('@/lib/supabase/auth-context')>()),
  requireOrgRole: fake.requireOrgRole,
  requireUserAndTenant: fake.requireUserAndTenant,
}));
vi.mock('@/lib/ksiegowosc/wylacznik', () => ({
  czyKsiegowoscWlaczona: async (_c: unknown, _t: string, obszar: string) => ({ wlaczony: fake.obszary[obszar] === true }),
  statusObszaru: () => ({ wlaczony: fake.kpirObszar }),
}));
vi.mock('@/lib/demo/tryb-danych', async (orig) => ({
  ...(await orig<typeof import('@/lib/demo/tryb-danych')>()),
  trybDanych: async () => ({ tryb: fake.tryb, stan: 'C', verifiedAt: null, kosztyKsefOd: null }),
}));
vi.mock('@/lib/reports/kpir-data', async (orig) => ({ ...(await orig<typeof import('@/lib/reports/kpir-data')>()), getKpirData: fake.getKpirData }));
vi.mock('@/lib/ksiegowosc/ewidencja-dane', async (orig) => ({ ...(await orig<typeof import('@/lib/ksiegowosc/ewidencja-dane')>()), czytajEwidencje: fake.czytajEwidencje }));
vi.mock('@/lib/ksiegowosc/kpir-dane', async (orig) => ({ ...(await orig<typeof import('@/lib/ksiegowosc/kpir-dane')>()), czytajKpir: fake.czytajKpir }));
vi.mock('@/lib/ksiegowosc/profil', async (orig) => ({ ...(await orig<typeof import('@/lib/ksiegowosc/profil')>()), czytajWersjeProfilu: fake.wersje }));
vi.mock('@/lib/ksiegowosc/odeslanie', () => ({ odeslanieDoKsiegi: fake.odeslanie }));
vi.mock('@/lib/ksiegowosc/ewidencja-pliki', async (orig) => ({ ...(await orig<typeof import('@/lib/ksiegowosc/ewidencja-pliki')>()), pobierzJpkEwp: fake.ewp, pobierzJpkPkpir: fake.pkpir }));
vi.mock('@/lib/exports/eksport-reczny', async (orig) => ({ ...(await orig<typeof import('@/lib/exports/eksport-reczny')>()), startManualExport: fake.start, downloadExportFile: fake.pobierz }));
vi.mock('@/lib/exports/tax-office', async (orig) => ({ ...(await orig<typeof import('@/lib/exports/tax-office')>()), readTenantTaxOffice: fake.urzad }));

import { GET as kpirRoute } from '@/app/api/mobile/v1/raport-kpir/route';
import { GET as ewidencjaRoute } from '@/app/api/mobile/v1/ksiegowosc/ewidencja/route';
import { POST as plikRoute } from '@/app/api/mobile/v1/ksiegowosc/ewidencja/plik/route';
import { GET as eksportRoute, POST as startRoute } from '@/app/api/mobile/v1/eksport/route';
import { GET as plikEksportuRoute } from '@/app/api/mobile/v1/eksport/pliki/[id]/route';
import type { EksportTelefonuOdpowiedz, KpirRaportOdpowiedz, KsiegaTelefonuOdpowiedz } from '@/lib/api/mobile/kontrakt-ksiegi';

const b64url = (value: string) => Buffer.from(value).toString('base64url');
function accessToken(sub: string, n: number): string {
  const now = Math.floor(Date.now() / 1000);
  return [b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), b64url(JSON.stringify({ aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 3600, sub, aal: 'aal1', session_id: `cccccccc-2222-4222-8222-00000000000${n}` })), b64url('sig')].join('.');
}
const TOKEN_OWNER = accessToken(USER_OWNER, 1);
const TOKEN_MEMBER = accessToken(USER_MEMBER, 2);
const TOKEN_KSIEGOWA = accessToken(USER_KSIEGOWA, 3);
const TOKEN_OBCY = accessToken('aaaaaaaa-1111-4111-8111-00000000000f', 4);
const issued = new Map([[TOKEN_OWNER, USER_OWNER], [TOKEN_MEMBER, USER_MEMBER], [TOKEN_KSIEGOWA, USER_KSIEGOWA]]);
const memberships = [
  { user_id: USER_OWNER, organization_id: ORG_A, role: 'owner', status: 'active' },
  { user_id: USER_MEMBER, organization_id: ORG_A, role: 'member', status: 'active' },
  { user_id: USER_KSIEGOWA, organization_id: ORG_A, role: 'accountant', status: 'active' },
];

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
  if (url.pathname === '/rest/v1/export_jobs') return Response.json(fake.historia);
  return Response.json({ message: url.pathname }, { status: 404 });
}

let ip = 0;
function req(path: string, options: { method?: string; token?: string | null; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { 'x-real-ip': `203.0.113.${(ip += 1) % 250}`, 'x-active-org': ORG_A };
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN_OWNER}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`https://app.example.test/api/mobile/v1/${path}`, { method: options.method ?? 'GET', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
}
const blad = async (r: Response) => ((await r.json()) as { error: { code: string; field?: string; message: string } }).error;
const OSOBA = { imie: 'Jan', nazwisko: 'Testowy', dataUrodzenia: '1980-01-01' };

const wersja = (forma: 'ryczalt' | 'skala' | 'liniowy'): WersjaProfilu =>
  ({ id: 'w1', validFrom: '2026-01-01', forma, stawkaDomyslna: 850, zusEtap: 'pelny', zusOd: null, chorobowe: false, najem: false, nrsZus: null }) as WersjaProfilu;

const ewidencja = (): Ewidencja => ({
  rok: 2026,
  ryczaltWRoku: true,
  braki: [],
  pominiete: [{ numer: 'FS/9/10', dzien: '2026-10-09', powod: 'Faktura zaliczkowa nie wchodzi do ewidencji.' }],
  wiersze: [
    { lp: 1, dataWpisu: '2026-10-06', dataPrzychodu: '2026-10-05', dowod: 'FS/1/10', numerKsef: '5260001246-20261005-AAAAAA-BB', krajKontrahenta: 'PL', idKontrahenta: '5252248481', kwotaGr: 1_000_000, stawkaPb: 850, uwagi: null, zrodlo: { typ: 'faktura', id: 'f1' } },
    { lp: 2, dataWpisu: '2026-10-20', dataPrzychodu: '2026-10-20', dowod: 'RK/10', numerKsef: null, krajKontrahenta: null, idKontrahenta: null, kwotaGr: 250_050, stawkaPb: 1200, uwagi: 'Raport kasy', zrodlo: { typ: 'wpis', id: 'w1' } },
  ],
});

const kpirModulu = (): Kpir => ({
  rok: 2026,
  braki: [],
  pominiete: [],
  wiersze: [
    { lp: 1, data: '2026-10-05', dowod: 'FS/1/10', numerKsef: null, krajKontrahenta: null, idKontrahenta: '5252248481', nazwaKontrahenta: 'Klient', adresKontrahenta: 'ul. A 1', opis: 'Usługa', kwoty: { k7: 1_000_000, k8: 0, k10: 0, k11: 0, k12: 0, k13: 0 }, br: null, uwagi: null, zrodlo: { typ: 'faktura', id: 'f1' } },
    { lp: 2, data: '2026-10-08', dowod: 'FZ/7', numerKsef: null, krajKontrahenta: null, idKontrahenta: null, nazwaKontrahenta: 'Dostawca', adresKontrahenta: 'ul. B 2', opis: 'Materiały', kwoty: { k7: 0, k8: 0, k10: 0, k11: 0, k12: 0, k13: 300_000 }, br: { opis: 'B+R', kwotaGr: 50_000 }, uwagi: 'Faktura kosztowa', zrodlo: { typ: 'koszt', id: 'k1' } },
  ],
} as Kpir);

beforeEach(() => {
  vi.clearAllMocks();
  fake.sets.clear();
  fake.obszary = { ewidencja: true };
  fake.kpirObszar = true;
  fake.tryb = 'prawdziwe';
  fake.historia = [];
  fake.odeslanie.mockResolvedValue(null);
  fake.wersje.mockResolvedValue([wersja('ryczalt')]);
  fake.czytajEwidencje.mockResolvedValue({ ok: true, ewidencja: ewidencja(), wpisy: [], wersje: [wersja('ryczalt')] });
  fake.czytajKpir.mockResolvedValue({ ok: true, kpir: kpirModulu(), wpisy: [], wersje: [wersja('skala')], spisy: [] });
  fake.ewp.mockResolvedValue({ success: true, xml: '<JPK/>', nazwa: 'JPK_EWP_1234567890.xml' });
  fake.pkpir.mockResolvedValue({ success: true, xml: '<JPK/>', nazwa: 'JPK_PKPIR_1234567890.xml' });
  fake.start.mockResolvedValue({ success: true, jobId: 'job-1' });
  fake.urzad.mockResolvedValue('1433');
  fake.requireOrgRole.mockResolvedValue({ supabase: {}, user: { id: USER_OWNER, email: 'jan@example.test' }, tenantId: ORG_A, role: 'owner' });
  fake.requireUserAndTenant.mockResolvedValue({ supabase: {}, user: { id: USER_OWNER, email: 'jan@example.test' }, tenantId: ORG_A });
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

describe('kontrakt ksiąg telefonu', () => {
  it('nie ma importów (czyta go Metro)', () => {
    const zrodlo = readFileSync(resolve(__dirname, '../../lib/api/mobile/kontrakt-ksiegi.ts'), 'utf8');
    expect(zrodlo).not.toMatch(/^\s*import\s/m);
    expect(zrodlo).not.toMatch(/\brequire\s*\(|\bimport\s*\(/);
  });
});

describe('brak i zły token', () => {
  const trasy: Array<[string, (r: Request, c?: { params: Promise<{ id: string }> }) => Promise<Response>, string, unknown]> = [
    ['GET /raport-kpir', kpirRoute, 'raport-kpir', undefined],
    ['GET /ksiegowosc/ewidencja', ewidencjaRoute, 'ksiegowosc/ewidencja', undefined],
    ['POST /ksiegowosc/ewidencja/plik', plikRoute, 'ksiegowosc/ewidencja/plik', { plik: 'JPK_EWP', rok: 2026, doMiesiaca: 10, ...OSOBA }],
    ['GET /eksport', eksportRoute, 'eksport', undefined],
    ['POST /eksport', startRoute, 'eksport', { format: 'kpir_excel', miesiac: '2026-10' }],
    ['GET /eksport/pliki/{id}', (r) => plikEksportuRoute(r, { params: Promise.resolve({ id: FILE_ID }) }), `eksport/pliki/${FILE_ID}`, undefined],
  ];
  it.each(trasy)('%s: bez tokenu i z tokenem spoza GoTrue 401, bez odczytu i zapisu', async (_n, trasa, sciezka, body) => {
    for (const token of [null, 'nie-jwt', TOKEN_OBCY]) {
      const response = await trasa(req(sciezka, { method: body === undefined ? 'GET' : 'POST', token, body }));
      expect(response.status).toBe(401);
    }
    for (const f of [fake.getKpirData, fake.czytajEwidencje, fake.czytajKpir, fake.ewp, fake.pkpir, fake.start, fake.pobierz]) expect(f).not.toHaveBeenCalled();
  });
});

describe('GET /api/mobile/v1/raport-kpir', () => {
  it('sumy, marża, kolumny i seria równe funkcjom strony na tych samych danych; wpisy w kolejności Lp. z kolumnami', async () => {
    const dane = kpirPrzykladowe(10, 2026);
    fake.getKpirData.mockResolvedValue({ month: 10, year: 2026, periodStart: '2026-10-01', periodEnd: '2026-10-31', ...dane, currencyBlocked: null, settledError: null });
    const response = await kpirRoute(req('raport-kpir?miesiac=2026-10'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as KpirRaportOdpowiedz;
    // Strona: `getKpirData(supabase, tenantId, { month, year })`.
    expect(fake.getKpirData).toHaveBeenCalledWith(expect.anything(), ORG_A, { month: '10', year: '2026' });
    const wzor = kpirTotals(dane.expenses, dane.invoices);
    expect(body.sumy).toMatchObject({ przychod: wzor.totalRevenue, koszty: wzor.totalExpenses, dochod: wzor.profit });
    expect(body.seria.at(-1)).toMatchObject({ przychod: wzor.totalRevenue });
    expect(body.wpisy.length).toBe(dane.expenses.length + dane.invoices.length);
    expect(body.wpisy.map((w) => w.lp)).toEqual(body.wpisy.map((_, i) => i + 1));
    expect(body).toMatchObject({ miesiac: '2026-10', tryb: 'dane', blokada: null, dzis: '2026-11-14' });
    expect(body.kolumny.every((k) => ['10', '11', '12', '13', '15'].includes(k.kolumna))).toBe(true);
  });

  it('raport wstrzymany (waluta): zdanie strony, numery blokujących faktur, bez kwot; przed weryfikacją KSeF dane przykładowe z plakietką', async () => {
    fake.getKpirData.mockResolvedValue({ month: 10, year: 2026, periodStart: '2026-10-01', periodEnd: '2026-10-31', expenses: [], invoices: [], currencyBlocked: 'Faktura w walucie obcej wstrzymuje raport.', settledError: null });
    const wstrzymany = (await (await kpirRoute(req('raport-kpir?miesiac=2026-10'))).json()) as KpirRaportOdpowiedz;
    expect(wstrzymany).toMatchObject({ blokada: 'Faktura w walucie obcej wstrzymuje raport.', sumy: null, wpisy: [], kolumny: [] });
    fake.getKpirData.mockClear();
    fake.tryb = 'przyklad';
    const przyklad = (await (await kpirRoute(req('raport-kpir?miesiac=2026-10'))).json()) as KpirRaportOdpowiedz;
    expect(przyklad.tryb).toBe('przyklad');
    expect(fake.getKpirData).not.toHaveBeenCalled();
    expect(przyklad.sumy?.przychod).toBe(kpirTotals(kpirPrzykladowe(10, 2026).expenses, kpirPrzykladowe(10, 2026).invoices).totalRevenue);
  });

  it('zły miesiąc albo przyszłość: 400 bez odczytu', async () => {
    for (const m of ['2026-13', 'abc', '2026-12']) expect((await kpirRoute(req(`raport-kpir?miesiac=${m}`))).status).toBe(400);
    expect(fake.getKpirData).not.toHaveBeenCalled();
  });
});

describe('GET /api/mobile/v1/ksiegowosc/ewidencja', () => {
  it('ryczałt: wiersze okresu, sumy według stawek i razem równe `sumyOkresu`, zdanie o pominiętych, plik do pobrania z zdaniem strony', async () => {
    const response = await ewidencjaRoute(req('ksiegowosc/ewidencja?miesiac=2026-10'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as KsiegaTelefonuOdpowiedz;
    const e = ewidencja();
    const sumy = sumyOkresu(e.wiersze);
    expect(brakiOkresu(e, '2026-10-01', '2026-10-31')).toEqual([]);
    expect(body).toMatchObject({ wlaczona: true, rodzaj: 'ewidencja', komunikat: null, braki: [], mozeEdytowac: true });
    expect(body.sumy).toEqual([
      ...[...sumy.stawki].map(([pb, gr]) => ({ podpis: `Przychód ze stawką ${pb === 850 ? '8,5 %' : '12 %'}`, kwotaGr: gr })),
      { podpis: 'Razem', kwotaGr: sumy.razemGr },
    ]);
    expect(body.sumy?.at(-1)?.kwotaGr).toBe(1_250_050);
    expect(body.wiersze.map((w) => [w.lp, w.dowod, w.kwotaGr, w.kolumna])).toEqual([[1, 'FS/1/10', 1_000_000, '8,5 %'], [2, 'RK/10', 250_050, '12 %']]);
    expect(body.pominiete).toBe('Poza ewidencją: FS/9/10. Faktura zaliczkowa nie wchodzi do ewidencji.');
    expect(body.plik).toMatchObject({ plik: 'JPK_EWP', rok: 2026, doMiesiaca: 10, mozna: true, powod: null });
    expect(body.plik?.opis).toMatch(/^Plik od 01\.01\.2026 do 31\.10\.2026: wiersze 2, przychód razem 12\s?500,50 zł\./);
  });

  it('skala albo liniowy: KPiR modułu z numerem z roku, sumami z `sumyKpir`, B+R w uwagach i plikiem JPK_PKPIR', async () => {
    fake.wersje.mockResolvedValue([wersja('skala')]);
    const body = (await (await ewidencjaRoute(req('ksiegowosc/ewidencja?miesiac=2026-10'))).json()) as KsiegaTelefonuOdpowiedz;
    const k = kpirModulu();
    const sumy = sumyKpir(wierszeKpirOkresu(k, '2026-10-01', '2026-10-31'));
    expect(brakiKpirOkresu(k, '2026-10-01', '2026-10-31')).toEqual([]);
    expect(body.rodzaj).toBe('kpir');
    expect(body.sumy).toEqual([
      { podpis: 'Przychód w miesiącu', kwotaGr: sumy.przychodGr },
      { podpis: 'Koszty w miesiącu', kwotaGr: sumy.kosztyGr },
      { podpis: 'Dochód w miesiącu (przychód minus koszty)', kwotaGr: sumy.przychodGr - sumy.kosztyGr },
    ]);
    expect(body.sumy?.map((s) => s.kwotaGr)).toEqual([1_000_000, 300_000, 700_000]);
    expect(body.wiersze[1]).toMatchObject({ lp: 2, przychod: false, kwotaGr: 300_000, uwagi: expect.stringMatching(/^Faktura kosztowa; B\+R: 500,00 zł$/) });
    expect(body.plik).toMatchObject({ plik: 'JPK_PKPIR', mozna: true });
    fake.kpirObszar = false;
    const wylaczona = (await (await ewidencjaRoute(req('ksiegowosc/ewidencja?miesiac=2026-10'))).json()) as KsiegaTelefonuOdpowiedz;
    expect(wylaczona.komunikat).toMatch(/^KPiR w module księgowości jest chwilowo wyłączona\./);
  });

  it('braki: zdania strony, bez sum i bez pliku (z miesiącami braków); okres przed 2026, obszar wyłączony i błąd odczytu ustawień', async () => {
    const z = ewidencja();
    z.braki = [{ dzien: '2026-10-05', dokument: 'FS/1/10', komunikat: 'Brak stawki ryczałtu dla faktury FS/1/10.' }];
    fake.czytajEwidencje.mockResolvedValue({ ok: true, ewidencja: z, wpisy: [], wersje: [wersja('ryczalt')] });
    const braki = (await (await ewidencjaRoute(req('ksiegowosc/ewidencja?miesiac=2026-10'))).json()) as KsiegaTelefonuOdpowiedz;
    expect(braki).toMatchObject({ braki: ['Brak stawki ryczałtu dla faktury FS/1/10.'], sumy: null, podpisSum: null });
    expect(braki.plik).toMatchObject({ mozna: false, opis: expect.stringContaining('Braki są w miesiącach: październik 2026.') });
    const stary = (await (await ewidencjaRoute(req('ksiegowosc/ewidencja?miesiac=2025-12'))).json()) as KsiegaTelefonuOdpowiedz;
    expect(stary.komunikat).toBe('Ewidencja przychodów w FaktWay obejmuje przychody od 1 stycznia 2026 r.');
    fake.wersje.mockRejectedValue(new Error('baza'));
    const odczyt = (await (await ewidencjaRoute(req('ksiegowosc/ewidencja?miesiac=2026-10'))).json()) as KsiegaTelefonuOdpowiedz;
    expect(odczyt.komunikat).toBeTruthy();
    expect(odczyt.wiersze).toEqual([]);
    fake.obszary = {};
    fake.czytajEwidencje.mockClear();
    const wylaczony = (await (await ewidencjaRoute(req('ksiegowosc/ewidencja'))).json()) as KsiegaTelefonuOdpowiedz;
    expect(wylaczony.wlaczona).toBe(false);
    expect(fake.czytajEwidencje).not.toHaveBeenCalled();
  });

  it('wyjątek odczytu wyłącznika to 5xx do ponowienia, nie pusta księga; wiersze niosą datę wpisu i identyfikator kontrahenta', async () => {
    const zbudowane = (await (await ewidencjaRoute(req('ksiegowosc/ewidencja?miesiac=2026-10'))).json()) as KsiegaTelefonuOdpowiedz;
    expect(zbudowane.wiersze[0]).toMatchObject({ dataWpisu: '2026-10-06', identyfikator: null, kontrahent: 'PL 5252248481' });
    fake.wersje.mockResolvedValue([wersja('skala')]);
    const kpir = (await (await ewidencjaRoute(req('ksiegowosc/ewidencja?miesiac=2026-10'))).json()) as KsiegaTelefonuOdpowiedz;
    expect(kpir.wiersze[0]).toMatchObject({ dataWpisu: null, identyfikator: '5252248481' });
    fake.czytajEwidencje.mockClear();
    fake.obszary = new Proxy({}, { get: () => { throw new Error('wyłącznik niedostępny'); } }) as Record<string, boolean>;
    const wyjatek = await ewidencjaRoute(req('ksiegowosc/ewidencja?miesiac=2026-10'));
    expect(wyjatek.status).toBe(503);
    expect(fake.czytajEwidencje).not.toHaveBeenCalled();
  });

  it('członek firmy widzi księgę, pliku nie pobiera (zdanie z rolą), księgowa pobiera', async () => {
    const czlonek = (await (await ewidencjaRoute(req('ksiegowosc/ewidencja?miesiac=2026-10', { token: TOKEN_MEMBER }))).json()) as KsiegaTelefonuOdpowiedz;
    expect(czlonek.plik).toMatchObject({ mozna: false, powod: 'Plik pobiera właściciel, administrator albo księgowa firmy.' });
    expect(czlonek.mozeEdytowac).toBe(false);
    const ksiegowa = (await (await ewidencjaRoute(req('ksiegowosc/ewidencja?miesiac=2026-10', { token: TOKEN_KSIEGOWA }))).json()) as KsiegaTelefonuOdpowiedz;
    expect(ksiegowa.plik?.mozna).toBe(true);
    expect(ksiegowa.mozeEdytowac).toBe(false);
  });
});

describe('POST /api/mobile/v1/ksiegowosc/ewidencja/plik', () => {
  it('JPK_EWP i JPK_PKPIR: ta sama funkcja i te same dane co „Pobierz” na stronie', async () => {
    const wejscie = { rok: 2026, doMiesiaca: 10, ...OSOBA };
    await pobierzJpkEwpAction(wejscie);
    await pobierzJpkPkpirAction(wejscie);
    const response = await plikRoute(req('ksiegowosc/ewidencja/plik', { method: 'POST', body: { plik: 'JPK_EWP', ...wejscie } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ nazwa: 'JPK_EWP_1234567890.xml', xml: '<JPK/>' });
    const pk = await plikRoute(req('ksiegowosc/ewidencja/plik', { method: 'POST', body: { plik: 'JPK_PKPIR', ...wejscie } }));
    expect(((await pk.json()) as { nazwa: string }).nazwa).toBe('JPK_PKPIR_1234567890.xml');
    // Strona woła ją z kontekstem akcji, telefon z kontekstem tokenu: ta sama firma i ten sam użytkownik, te same pola.
    const [[ctxStrony, wejscieStrony], [ctxTelefonu, wejscieTelefonu]] = fake.ewp.mock.calls as [[Record<string, unknown>, unknown], [Record<string, unknown>, unknown]];
    expect(wejscieTelefonu).toEqual(wejscieStrony);
    expect({ tenantId: ctxTelefonu.tenantId, userId: ctxTelefonu.userId }).toEqual({ tenantId: ctxStrony.tenantId, userId: ctxStrony.userId });
    expect(fake.pkpir.mock.calls[1]?.[1]).toEqual(fake.pkpir.mock.calls[0]?.[1]);
  });

  it('członek firmy: 403; księgowa: plik; odmowa pliku: 422 `settlement_refused` z polem; treść spoza kontraktu: 400', async () => {
    const body = { plik: 'JPK_EWP', rok: 2026, doMiesiaca: 10, ...OSOBA };
    expect((await plikRoute(req('ksiegowosc/ewidencja/plik', { method: 'POST', token: TOKEN_MEMBER, body }))).status).toBe(403);
    expect(fake.ewp).not.toHaveBeenCalled();
    expect((await plikRoute(req('ksiegowosc/ewidencja/plik', { method: 'POST', token: TOKEN_KSIEGOWA, body }))).status).toBe(200);
    fake.ewp.mockResolvedValue({ success: false, error: 'To nie jest poprawna data urodzenia.', pole: 'dataUrodzenia' });
    const odmowa = await plikRoute(req('ksiegowosc/ewidencja/plik', { method: 'POST', body }));
    expect(odmowa.status).toBe(422);
    expect(await blad(odmowa)).toMatchObject({ code: 'settlement_refused', field: 'dataUrodzenia', message: 'To nie jest poprawna data urodzenia.' });
    for (const zle of [{ ...body, plik: 'JPK_V7M' }, { ...body, pesel: '1' }, { ...body, rok: '2026' }]) {
      expect((await plikRoute(req('ksiegowosc/ewidencja/plik', { method: 'POST', body: zle }))).status).toBe(400);
    }
  });
});

describe('eksport', () => {
  const job = (z: Record<string, unknown> = {}) => ({
    id: 'job-1', format: 'kpir_excel', status: 'completed', period_start: '2026-10-01', period_end: '2026-10-31', created_at: '2026-11-13T22:30:00Z',
    invoices_count: 12, error_message: null, progress_message: null, export_files: [{ id: FILE_ID, filename: 'KPiR_2026-10.xlsx', size_bytes: 14_540 }], ...z,
  });

  it('GET: formaty i historia z tych samych reguł co strona (stan „Pusty”, podsumowanie, notatka błędu); urząd skarbowy', async () => {
    fake.historia = [
      job(),
      job({ id: 'job-2', format: 'jpk_fa', status: 'completed', export_files: [], progress_message: null }),
      job({ id: 'job-3', format: 'csv_universal', status: 'failed', error_message: 'JPK wstrzymany: faktura FS/1/10 wymaga poprawy.', export_files: [] }),
    ];
    const body = (await (await eksportRoute(req('eksport'))).json()) as EksportTelefonuOdpowiedz;
    expect(body.formaty.map((f) => f.format)).toEqual(['kpir_excel', 'csv_universal', 'jpk_fa']);
    expect(body).toMatchObject({ miesiac: '2026-10', urzadUstawiony: true });
    expect(body.miesiace[0]).toBe('2026-11');
    expect(body.miesiace).toHaveLength(12);
    const [gotowy, pusty, blad3] = body.historia;
    expect(gotowy).toMatchObject({ stanNazwa: 'Gotowe', okres: 'Październik 2026', nazwaFormatu: 'KPiR Excel', podsumowanie: '14,2 KB', plik: { id: FILE_ID, nazwa: 'KPiR_2026-10.xlsx' }, notatka: null });
    expect(pusty).toMatchObject({ stan: 'empty', stanNazwa: 'Pusty', plik: null, notatka: { tekst: 'Brak dokumentów w tym okresie', blad: false } });
    expect(blad3).toMatchObject({ stanNazwa: 'Błąd', plik: null, notatka: { tekst: 'JPK wstrzymany: faktura FS/1/10 wymaga poprawy.', blad: true } });
    fake.urzad.mockResolvedValue(null);
    expect(((await (await eksportRoute(req('eksport'))).json()) as EksportTelefonuOdpowiedz).urzadUstawiony).toBe(false);
  });

  it('POST: ta sama funkcja i ten sam zakres co `startExportAction` strony dla formularza z domyślnymi polami', async () => {
    for (const format of ['kpir_excel', 'csv_universal', 'jpk_fa'] as const) {
      fake.start.mockClear();
      // Formularz strony: miesiąc, `includesFor(format, { csv: { issued: true, received: false, corrections: true }, jpkCorrections: true })`.
      const { includesFor } = await import('@/components/exports/export-formats');
      await startExportAction({ format, periodStart: '2026-10-01', periodEnd: '2026-10-31', ...includesFor(format, { csv: { issued: true, received: false, corrections: true }, jpkCorrections: true }) });
      const response = await startRoute(req('eksport', { method: 'POST', body: { format, miesiac: '2026-10' } }));
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ jobId: 'job-1' });
      const [[ctxStrony, paramStrony], [ctxTelefonu, paramTelefonu]] = fake.start.mock.calls as [[Record<string, unknown>, unknown], [Record<string, unknown>, unknown]];
      expect(paramTelefonu).toEqual(paramStrony);
      expect({ tenantId: ctxTelefonu.tenantId, userId: ctxTelefonu.userId }).toEqual({ tenantId: ctxStrony.tenantId, userId: ctxStrony.userId });
    }
  });

  it('POST: JPK_FA bez urzędu skarbowego 422 bez zlecenia; odmowa strony ze zdaniem; treść spoza kontraktu 400; członek firmy zleca (jak strona)', async () => {
    fake.urzad.mockResolvedValue(null);
    const brak = await startRoute(req('eksport', { method: 'POST', body: { format: 'jpk_fa', miesiac: '2026-10' } }));
    expect(brak.status).toBe(422);
    expect(await blad(brak)).toMatchObject({ code: 'export_refused', message: expect.stringContaining('Najpierw ustaw urząd skarbowy.') });
    expect(fake.start).not.toHaveBeenCalled();
    // Odczyt urzędu, który się nie udał, niczego nie blokuje (jak strona).
    fake.urzad.mockRejectedValue(new Error('baza'));
    expect((await startRoute(req('eksport', { method: 'POST', body: { format: 'jpk_fa', miesiac: '2026-10' } }))).status).toBe(201);
    // Porażka techniczna (zapis joba, zdarzenie dla workera) to 5xx do ponowienia, nie „odmowa”.
    fake.start.mockResolvedValue({ success: false, error: 'cokolwiek technicznego' });
    const techniczna = await startRoute(req('eksport', { method: 'POST', body: { format: 'kpir_excel', miesiac: '2026-10' } }));
    expect(techniczna.status).toBe(503);
    // Odmowa merytoryczna (zdanie strony) zostaje 422.
    fake.start.mockResolvedValue({ success: false, error: 'Data końcowa < początkowa' });
    const odmowa = await startRoute(req('eksport', { method: 'POST', body: { format: 'kpir_excel', miesiac: '2026-10' } }));
    expect(odmowa.status).toBe(422);
    expect(await blad(odmowa)).toMatchObject({ code: 'export_refused' });
    fake.start.mockClear();
    for (const zle of [{ format: 'symfonia', miesiac: '2026-10' }, { format: 'kpir_excel', miesiac: '10-2026' }, { format: 'kpir_excel', miesiac: '2026-12' }, { format: 'kpir_excel', miesiac: '2026-10', x: 1 }]) {
      expect((await startRoute(req('eksport', { method: 'POST', body: zle }))).status).toBe(400);
    }
    expect(fake.start).not.toHaveBeenCalled();
    fake.start.mockResolvedValue({ success: true, jobId: 'job-9' });
    expect((await startRoute(req('eksport', { method: 'POST', token: TOKEN_MEMBER, body: { format: 'kpir_excel', miesiac: '2026-10' } }))).status).toBe(201);
  });

  it('pobranie pliku: Base64 z funkcji strony; nie znaleziono 404; niegotowy 422; zły identyfikator 404; błąd magazynu do ponowienia', async () => {
    const wolaj = (id: string) => plikEksportuRoute(req(`eksport/pliki/${id}`), { params: Promise.resolve({ id }) });
    fake.pobierz.mockResolvedValue({ success: true, base64: 'AAAA', filename: 'KPiR_2026-10.xlsx', mimeType: 'application/vnd.ms-excel' });
    const ok = await wolaj(FILE_ID);
    expect(await ok.json()).toEqual({ nazwa: 'KPiR_2026-10.xlsx', mimeType: 'application/vnd.ms-excel', base64: 'AAAA' });
    expect(fake.pobierz).toHaveBeenCalledWith({ client: expect.anything(), tenantId: ORG_A, userId: USER_OWNER }, FILE_ID);
    fake.pobierz.mockResolvedValue({ success: false, error: 'Plik nie znaleziony' });
    expect((await wolaj(FILE_ID)).status).toBe(404);
    fake.pobierz.mockResolvedValue({ success: false, error: 'Plik nie jest gotowy' });
    const niegotowy = await wolaj(FILE_ID);
    expect(niegotowy.status).toBe(422);
    expect((await blad(niegotowy)).code).toBe('export_refused');
    fake.pobierz.mockResolvedValue({ success: false, error: 'Błąd pobierania z storage' });
    expect((await wolaj(FILE_ID)).status).toBe(503);
    fake.pobierz.mockClear();
    expect((await wolaj('nie-uuid')).status).toBe(404);
    expect(fake.pobierz).not.toHaveBeenCalled();
  });
});
