import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { JpkInvoice } from '@/lib/exports/jpk-fa-generator';
import { vatMiesiaca } from '@/lib/ksiegowosc/vat';

/**
 * Plan aplikacji mobilnej, M10d: VAT z plikiem JPK_V7M, nadwyżka VAT i zapłaty spoza
 * wyliczenia z telefonu.
 *
 * Prawdziwe: trasy `app/api/mobile/v1/ksiegowosc/**`, bramka tokenu,
 * `lib/api/mobile/ksiegowosc{,-vat}.ts`, plik (`lib/ksiegowosc/vat-plik.ts`: generator,
 * XSD, strażnik), wyliczenie VAT (`vatMiesiaca`), dane do przelewu i termin. Atrapy:
 * HTTP do GoTrue i PostgREST, wyłącznik, odczyt miesiąca (`czytajVat`, `czytajTenMiesiac`,
 * własne testy na ścieżce strony), urząd skarbowy, audyt, zapis zapłaty spoza wyliczenia
 * (`dodajZaplateReczna`, test akcji `ksiegowosc-ten-miesiac-akcje`).
 *
 * Zgodność ze stroną: telefon i akcja strony dostają ten sam plik (bajt w bajt), te same
 * kwoty deklaracji i te same wywołania funkcji zapisu.
 */

const SUPABASE_URL = 'https://db.fixture.test';
const USER_OWNER = 'aaaaaaaa-1111-4111-8111-000000000001';
const USER_MEMBER = 'aaaaaaaa-1111-4111-8111-000000000002';
const USER_KSIEGOWA = 'aaaaaaaa-1111-4111-8111-000000000003';
const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const WYS_ID = '00170170-0000-4000-8000-000000000001';
const REC_ID = '77777777-7777-4777-8777-777777777777';

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
    czytajVat: vi.fn(),
    czytaj: vi.fn(),
    zatwierdz: vi.fn(),
    reczna: vi.fn(),
    audit: vi.fn(),
    requireOrgRole: vi.fn(),
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
vi.mock('@/lib/supabase/auth-context', async (orig) => ({
  ...(await orig<typeof import('@/lib/supabase/auth-context')>()),
  requireOrgRole: fake.requireOrgRole,
}));
vi.mock('@/lib/ksiegowosc/wylacznik', () => ({
  czyKsiegowoscWlaczona: async (_c: unknown, _t: string, obszar: string) => ({ wlaczony: fake.obszary[obszar] === true }),
}));
vi.mock('@/lib/ksiegowosc/vat-dane', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/vat-dane')>()),
  czytajVat: fake.czytajVat,
}));
vi.mock('@/lib/exports/tax-office', async (orig) => ({
  ...(await orig<typeof import('@/lib/exports/tax-office')>()),
  readTenantTaxOffice: async () => '1433',
}));
vi.mock('@/lib/ksiegowosc/ten-miesiac-dane', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ksiegowosc/ten-miesiac-dane')>();
  return { ...actual, czytajTenMiesiac: fake.czytaj };
});
vi.mock('@/lib/ksiegowosc/ten-miesiac-zapis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ksiegowosc/ten-miesiac-zapis')>();
  return { ...actual, zatwierdzMiesiac: fake.zatwierdz, dodajZaplateReczna: fake.reczna };
});

import { pobierzJpkV7mAction } from '@/app/actions/ksiegowosc-vat';
import { dodajZaplateRecznaAction } from '@/app/actions/ksiegowosc-ten-miesiac';
import { GET as miesiacRoute } from '@/app/api/mobile/v1/ksiegowosc/route';
import { GET as vatRoute } from '@/app/api/mobile/v1/ksiegowosc/vat/route';
import { POST as plikRoute } from '@/app/api/mobile/v1/ksiegowosc/vat/plik/route';
import { POST as zatwierdzRoute } from '@/app/api/mobile/v1/ksiegowosc/zatwierdz/route';
import { POST as recznaRoute } from '@/app/api/mobile/v1/ksiegowosc/zaplaty-reczne/route';
import type { TenMiesiacOdpowiedz } from '@/lib/api/mobile/kontrakt';
import type { PlikVatOdpowiedz, TenMiesiacDodatki, VatTelefonuOdpowiedz, ZrodloNadwyzkiTelefonu } from '@/lib/api/mobile/kontrakt-ksiegowosc';
import { terminDla } from '@/lib/ksiegowosc/kalendarz';
import { mikrorachunekZNip } from '@/lib/ksiegowosc/mikrorachunek';
import { daneDoPrzelewu } from '@/lib/ksiegowosc/przelew';
import { brakNadwyzki, type ZrodloNadwyzki } from '@/lib/ksiegowosc/vat-dane';

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
const NIP = '1234567890';
const NAZWA = 'Jan Testowy';

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
  if (url.pathname === '/rest/v1/tenants') return asObject ? Response.json({ nip: NIP, name: NAZWA }) : Response.json([{ nip: NIP, name: NAZWA }]);
  return Response.json({ message: url.pathname }, { status: 404 });
}

let ip = 0;
function req(path: string, options: { method?: string; token?: string | null; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { 'x-real-ip': `203.0.113.${(ip += 1) % 250}`, 'x-active-org': ORG_A };
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN_OWNER}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`https://app.example.test/api/mobile/v1/${path}`, { method: options.method ?? 'GET', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
}
const kod = async (r: Response) => ((await r.json()) as { error: { code: string; field?: string; message: string } }).error;

/** Stub klienta strony (akcja): ta sama firma co w PostgREST telefonu. */
function lancuch(wynik: unknown) {
  const l: Record<string, unknown> = {};
  for (const m of ['eq', 'in', 'order', 'limit']) l[m] = () => l;
  l.select = () => l;
  l.maybeSingle = async () => wynik;
  l.single = async () => wynik;
  return l;
}
const supabaseStrony = { from: (t: string) => (t === 'tenants' ? lancuch({ data: { nip: NIP, name: NAZWA }, error: null }) : lancuch({ data: null, error: null })) };

const sprzedaz = {
  invoiceNumber: 'FS/1/10',
  currency: 'PLN',
  invoiceType: 'regular',
  issueDate: '2026-10-05',
  buyerName: 'Klient',
  netTotal: 1000,
  vatTotal: 230,
  grossTotal: 1230,
  lines: [{ position: 1, name: 'Usługa', unit: 'szt.', quantity: 1, unitPriceNet: 1000, netAmount: 1000, vatRate: '23' }],
} as JpkInvoice;

function daneVat(nadwyzka: { zl: number; zrodlo: ZrodloNadwyzki } | null = { zl: 50, zrodlo: 'klient' }) {
  return {
    ok: true,
    miesiac: '2026-10',
    dane: { issuer: { nip: NIP, name: NAZWA }, issuedInvoices: [sprzedaz], receivedInvoices: [], expenses: [] },
    nadwyzka,
    wynik: nadwyzka ? vatMiesiaca({ sprzedaz: [sprzedaz], koszty: [] }, nadwyzka.zl) : null,
    wysylki: [
      {
        id: WYS_ID, okres: '2026-10-01', cel: 1, srodowisko: 'test', skrotPliku: 'x', deklaracja: { P_38: 230, P_39: 50, P_48: 50, P_51: 180, P_62: 0 },
        stan: 'odrzucona', numerReferencyjny: 'b7a0', statusKod: 401, statusOpis: 'Weryfikacja negatywna', upoSciezka: null, blad: null,
        utworzonoO: '2026-11-07T10:00:00Z', wyslanoO: null, zakonczonoO: null,
      },
    ],
  };
}

const OSOBA = { imie: 'Jan', nazwisko: 'Testowy', dataUrodzenia: '1980-01-01', email: 'jan@example.test' };

function daneMiesiaca() {
  return {
    ok: true,
    wynik: {
      miesiac: '2026-10', profil: { forma: 'ryczalt', nrsZus: null }, przychodGr: 1_000_000, kosztyGr: null, pozycje: [],
      vat: { wynik: null, nadwyzka: null, nadwyzkaNieznana: true },
    },
    pozycje: [{ ok: false, rodzaj: 'vat', termin: null, brak: 'Do wyliczenia VAT potrzebna jest nadwyżka.' }],
    parametryWersja: 'p',
    rozliczenia: [],
    zaplatyReczne: [
      { id: REC_ID, miesiac: '2025-12', rodzaj: 'zus_spoleczne', wersja: 1, kwotaGr: 150_000, termin: '2026-01-20', status: 'zaplacone', wejsciaHash: 'h', zatwierdzoneO: '2026-11-03T10:00:00Z', zaplaconeO: '2026-10-15', spoleczneBezFpGr: 140_000, reczna: true },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.sets.clear();
  fake.obszary = { vat: true, ten_miesiac: true };
  fake.czytajVat.mockResolvedValue(daneVat());
  fake.czytaj.mockResolvedValue(daneMiesiaca());
  fake.requireOrgRole.mockResolvedValue({ supabase: supabaseStrony, user: { id: USER_OWNER, email: 'jan@example.test' }, tenantId: ORG_A, role: 'owner' });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-14T09:00:00Z'));
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
  vi.stubEnv('JPK_MF_ENV', 'test');
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('kontrakt księgowości telefonu', () => {
  it('nie ma importów (czyta go Metro) i źródła nadwyżki to źródła strony', () => {
    const zrodlo = readFileSync(resolve(__dirname, '../../lib/api/mobile/kontrakt-ksiegowosc.ts'), 'utf8');
    expect(zrodlo).not.toMatch(/^\s*import\s/m);
    expect(zrodlo).not.toMatch(/\brequire\s*\(|\bimport\s*\(/);
    expectTypeOf<ZrodloNadwyzkiTelefonu>().toEqualTypeOf<ZrodloNadwyzki>();
  });
});

describe('brak i zły token', () => {
  const trasy: Array<[string, (r: Request) => Promise<Response>, string, unknown]> = [
    ['GET /ksiegowosc/vat', vatRoute, 'ksiegowosc/vat', undefined],
    ['POST /ksiegowosc/vat/plik', plikRoute, 'ksiegowosc/vat/plik', { miesiac: '2026-10', nadwyzka: 50, ...OSOBA }],
    ['POST /ksiegowosc/zaplaty-reczne', recznaRoute, 'ksiegowosc/zaplaty-reczne', { zaMiesiac: '2025-12', rodzaj: 'zdrowotna', kwota: '100', bezFp: '', dataZaplaty: '2026-01-10' }],
  ];
  it.each(trasy)('%s: bez tokenu i z tokenem spoza GoTrue 401, bez odczytu i zapisu', async (_n, trasa, sciezka, body) => {
    const metoda = body === undefined ? 'GET' : 'POST';
    for (const token of [null, 'nie-jwt', TOKEN_OBCY]) {
      const response = await trasa(req(sciezka, { method: metoda, token, body }));
      expect(response.status).toBe(401);
    }
    expect(fake.czytajVat).not.toHaveBeenCalled();
    expect(fake.reczna).not.toHaveBeenCalled();
    expect(fake.audit).not.toHaveBeenCalled();
  });
});

describe('GET /api/mobile/v1/ksiegowosc/vat', () => {
  it('domyślnie poprzedni miesiąc; kwoty, termin i przelew z tych samych funkcji co strona', async () => {
    const response = await vatRoute(req('ksiegowosc/vat?nadwyzka=50'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as VatTelefonuOdpowiedz;
    // Strona: `czytajVat(ctx.supabase, ctx.tenantId, miesiac, nadwyzkaZAdresu(sp.nadwyzka))`.
    expect(fake.czytajVat).toHaveBeenCalledWith(expect.anything(), ORG_A, '2026-10', 50);
    const wynik = vatMiesiaca({ sprzedaz: [sprzedaz], koszty: [] }, 50);
    if (!wynik.ok) throw new Error('wyliczenie wzorcowe');
    expect(body.kwoty).toEqual({
      naleznyGr: wynik.naleznyGr,
      naliczonyGr: wynik.naliczonyGr,
      nadwyzkaPoprzedniaGr: wynik.nadwyzkaPoprzedniaGr,
      doZaplatyGr: wynik.doZaplatyGr,
      nadwyzkaNaNastepnyGr: wynik.nadwyzkaNaNastepnyGr,
    });
    // P_38 230 zł, P_48 z nadwyżką 50 zł, P_51 180 zł (pełne złote, art. 99 ust. 1 i 12 ustawy o VAT).
    expect(body.kwoty).toMatchObject({ naleznyGr: 23_000, naliczonyGr: 5_000, doZaplatyGr: 18_000, nadwyzkaNaNastepnyGr: 0 });
    expect(body.termin).toEqual((({ faktyczny, nominalny, przesuniety }) => ({ faktyczny, nominalny, przesuniety }))(terminDla({ rodzaj: 'vatJpk', rok: 2026, miesiac: 10 })!));
    expect(body.przelew).toBe(daneDoPrzelewu('vat', '2026-10', NIP, mikrorachunekZNip(NIP), null, 'ryczalt'));
    expect(body).toMatchObject({ wlaczona: true, miesiac: '2026-10', dzis: '2026-11-14', komunikat: null, zwolniona: false, zakonczony: true });
    expect(body.nadwyzka).toMatchObject({ nadwyzka: { zl: 50, zrodlo: 'klient' }, pole: true, wpisana: 50, poprzedni: 'wrzesień 2026' });
    expect(body.podpis).toContain('1 faktura sprzedaży');
    expect(body.plik).toEqual({ mozna: true, powod: null, email: 'jan@example.test' });
    expect(body.wysylki).toEqual([
      expect.objectContaining({ id: WYS_ID, stan: 'Odrzucony', przyjeta: false, testowe: true, numer: 'b7a0', doWplatyGr: 18_000, odmowa: expect.stringContaining('Kod MF 401: Weryfikacja negatywna.') }),
    ]);
    expect(body.miesiace[0]).toBe('2026-11');
  });

  it('nieznana nadwyżka: bez kwot, zdanie strony i pole; nadwyżka z MF: bez pola', async () => {
    fake.czytajVat.mockResolvedValue(daneVat(null));
    const brak = (await (await vatRoute(req('ksiegowosc/vat?miesiac=2026-10'))).json()) as VatTelefonuOdpowiedz;
    expect(brak.kwoty).toBeNull();
    expect(brak.nadwyzka).toMatchObject({ nadwyzka: null, pole: true, wpisana: null, opis: brakNadwyzki('2026-10') });
    expect(brak.plik.mozna).toBe(false);
    fake.czytajVat.mockResolvedValue(daneVat({ zl: 0, zrodlo: 'mf' }));
    const mf = (await (await vatRoute(req('ksiegowosc/vat?miesiac=2026-10'))).json()) as VatTelefonuOdpowiedz;
    expect(mf.nadwyzka).toMatchObject({ pole: false, wpisana: null });
    expect(mf.nadwyzka?.opis).toMatch(/z deklaracji przyjętej przez MF\.$/);
  });

  it('kwot nie liczymy (zwolnienie, odczyt): zdanie strony bez kwot; obszar wyłączony: `wlaczona: false` bez odczytu', async () => {
    fake.czytajVat.mockResolvedValue({ ok: false, komunikat: 'Firma korzysta ze zwolnienia z VAT (art. 113), więc nie składa JPK_V7M.', zwolniona: true });
    const zw = (await (await vatRoute(req('ksiegowosc/vat'))).json()) as VatTelefonuOdpowiedz;
    expect(zw).toMatchObject({ zwolniona: true, kwoty: null, nadwyzka: null, komunikat: expect.stringContaining('art. 113') });
    fake.czytajVat.mockClear();
    fake.obszary = { ten_miesiac: true };
    const wyl = (await (await vatRoute(req('ksiegowosc/vat'))).json()) as VatTelefonuOdpowiedz;
    expect(wyl.wlaczona).toBe(false);
    expect(fake.czytajVat).not.toHaveBeenCalled();
  });

  it('członek firmy widzi kwoty, pliku nie pobiera; księgowa pobiera; zły miesiąc albo nadwyżka: 400', async () => {
    const czlonek = (await (await vatRoute(req('ksiegowosc/vat', { token: TOKEN_MEMBER }))).json()) as VatTelefonuOdpowiedz;
    expect(czlonek.plik.mozna).toBe(false);
    expect(czlonek.plik.powod).toMatch(/księgowa/);
    const ksiegowa = (await (await vatRoute(req('ksiegowosc/vat', { token: TOKEN_KSIEGOWA }))).json()) as VatTelefonuOdpowiedz;
    expect(ksiegowa.plik.mozna).toBe(true);
    fake.czytajVat.mockClear();
    for (const q of ['miesiac=2026-13', 'miesiac=2026-12', 'nadwyzka=-5', 'nadwyzka=1,5']) {
      expect((await vatRoute(req(`ksiegowosc/vat?${q}`))).status).toBe(400);
    }
    expect(fake.czytajVat).not.toHaveBeenCalled();
  });
});

describe('POST /api/mobile/v1/ksiegowosc/vat/plik', () => {
  it('ten sam plik JPK_V7M co „Pobierz” na stronie (bajt w bajt) i ten sam wpis audytu', async () => {
    const wejscie = { miesiac: '2026-10', nadwyzka: 50, ...OSOBA };
    const strona = await pobierzJpkV7mAction(wejscie);
    if (!strona.success) throw new Error(strona.error);
    const response = await plikRoute(req('ksiegowosc/vat/plik', { method: 'POST', body: wejscie }));
    expect(response.status).toBe(200);
    const telefon = (await response.json()) as PlikVatOdpowiedz;
    expect(telefon).toEqual({ nazwa: strona.nazwa, xml: strona.xml });
    expect(telefon.nazwa).toBe(`JPK_V7M_${NIP}_2026-10.xml`);
    expect(telefon.xml).toContain('<P_51>180</P_51>');
    expect(fake.audit).toHaveBeenCalledTimes(2);
    const [[wpisStrony], [wpisTelefonu]] = fake.audit.mock.calls as [[Record<string, unknown>], [Record<string, unknown>]];
    expect(wpisTelefonu).toEqual(wpisStrony);
    expect(wpisTelefonu).toMatchObject({ action: 'jpk_v7m.downloaded', tenantId: ORG_A, userId: USER_OWNER });
    // D9: dane osoby nie trafiają do audytu.
    expect(JSON.stringify(wpisTelefonu)).not.toMatch(/Testowy|1980-01-01/);
  });

  it('członek firmy: 403 bez pliku; zły e-mail: 422 `settlement_refused` z polem; miesiąc w trakcie: 422 ze zdaniem strony', async () => {
    const czlonek = await plikRoute(req('ksiegowosc/vat/plik', { method: 'POST', token: TOKEN_MEMBER, body: { miesiac: '2026-10', nadwyzka: 50, ...OSOBA } }));
    expect(czlonek.status).toBe(403);
    const email = await plikRoute(req('ksiegowosc/vat/plik', { method: 'POST', body: { miesiac: '2026-10', nadwyzka: 50, ...OSOBA, email: 'nie-adres' } }));
    expect(email.status).toBe(422);
    expect(await kod(email)).toMatchObject({ code: 'settlement_refused', field: 'email', message: 'To nie jest adres e-mail.' });
    const trwa = await plikRoute(req('ksiegowosc/vat/plik', { method: 'POST', body: { miesiac: '2026-11', nadwyzka: 50, ...OSOBA } }));
    expect(trwa.status).toBe(422);
    expect((await kod(trwa)).message).toBe('Plik za listopad 2026 powstaje po zakończeniu miesiąca.');
    const obce = await plikRoute(req('ksiegowosc/vat/plik', { method: 'POST', body: { miesiac: '2026-10', nadwyzka: 50, ...OSOBA, pesel: '1' } }));
    expect(obce.status).toBe(400);
    expect(fake.audit).not.toHaveBeenCalled();
  });
});

describe('„Ten miesiąc”: nadwyżka VAT i zapłaty spoza wyliczenia', () => {
  it('nadwyżka z adresu jak `?nadwyzka=` strony; pole przy VAT, lista zapłat i formularz dla właściciela', async () => {
    const response = await miesiacRoute(req('ksiegowosc?miesiac=2026-10&nadwyzka=120'));
    expect(response.status).toBe(200);
    expect(fake.czytaj).toHaveBeenCalledWith(expect.anything(), ORG_A, '2026-10', { nadwyzkaVat: 120 });
    const body = (await response.json()) as TenMiesiacOdpowiedz & TenMiesiacDodatki;
    expect(body.nadwyzkaVat).toMatchObject({ nadwyzka: null, pole: true, wpisana: null, poprzedni: 'wrzesień 2026' });
    expect(body.zaplatyReczne).toEqual([
      { id: REC_ID, rodzaj: 'zus_spoleczne', zaplacone: true, najwczesniej: '2025-12-01', opis: expect.stringMatching(/^Składki społeczne za grudzień 2025: 1\s?500,00 zł, w tym bez Funduszu Pracy i FS 1\s?400,00 zł\. Zapłacone 15\.10\.2026\.$/) },
    ]);
    expect(body.zaplataReczna).toEqual({ od: '2025-01', doMiesiaca: '2026-10', domyslnyMiesiac: '2026-09', domyslnaData: '2026-10-31' });
    const czlonek = (await (await miesiacRoute(req('ksiegowosc', { token: TOKEN_MEMBER }))).json()) as TenMiesiacDodatki;
    expect(czlonek.zaplataReczna).toBeNull();
    expect((await miesiacRoute(req('ksiegowosc?nadwyzka=abc'))).status).toBe(400);
  });

  it('zatwierdzenie z wpisaną nadwyżką: ta sama kwota idzie do funkcji strony', async () => {
    fake.zatwierdz.mockResolvedValue({ success: true, nowe: 1 });
    const response = await zatwierdzRoute(req('ksiegowosc/zatwierdz', { method: 'POST', body: { miesiac: '2026-10', skroty: {}, nadwyzkaVat: 120 } }));
    expect(response.status).toBe(200);
    expect(fake.zatwierdz).toHaveBeenCalledWith({ client: expect.anything(), tenantId: ORG_A, userId: USER_OWNER }, { miesiac: '2026-10', skroty: {}, nadwyzkaVat: 120 });
  });

  it('zapłata spoza wyliczenia: ta sama funkcja i te same dane co akcja strony; członek 403; odmowa z polem', async () => {
    const wejscie = { zaMiesiac: '2025-12', rodzaj: 'zus_spoleczne' as const, kwota: '1500,00', bezFp: '1400,00', dataZaplaty: '2026-10-15' };
    fake.reczna.mockResolvedValue({ success: true });
    await dodajZaplateRecznaAction(wejscie);
    const response = await recznaRoute(req('ksiegowosc/zaplaty-reczne', { method: 'POST', body: wejscie }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ zapisano: true });
    expect(fake.reczna).toHaveBeenCalledTimes(2);
    const [[ctxStrony, wejscieStrony], [ctxTelefonu, wejscieTelefonu]] = fake.reczna.mock.calls as [[Record<string, unknown>, unknown], [Record<string, unknown>, unknown]];
    expect(wejscieTelefonu).toEqual(wejscieStrony);
    expect({ tenantId: ctxTelefonu.tenantId, userId: ctxTelefonu.userId }).toEqual({ tenantId: ctxStrony.tenantId, userId: ctxStrony.userId });

    const czlonek = await recznaRoute(req('ksiegowosc/zaplaty-reczne', { method: 'POST', token: TOKEN_MEMBER, body: wejscie }));
    expect(czlonek.status).toBe(403);
    fake.reczna.mockResolvedValue({ success: false, error: 'Data zapłaty nie może być późniejsza niż dziś.', pole: 'dataZaplaty' });
    const odmowa = await recznaRoute(req('ksiegowosc/zaplaty-reczne', { method: 'POST', body: wejscie }));
    expect(odmowa.status).toBe(422);
    expect(await kod(odmowa)).toMatchObject({ code: 'settlement_refused', field: 'dataZaplaty' });
    const obca = await recznaRoute(req('ksiegowosc/zaplaty-reczne', { method: 'POST', body: { ...wejscie, kwotaGr: 1 } }));
    expect(obca.status).toBe(400);
    expect(fake.reczna).toHaveBeenCalledTimes(3);
  });
});

describe('odmowa w telefonie', () => {
  it('`settlement_refused` z `field`: zdanie serwera pod polem formularza', async () => {
    const { bladApi } = await import('../../mobile/src/lib/api/bledy');
    const b = bladApi(422, { error: { code: 'settlement_refused', message: 'To nie jest adres e-mail.', field: 'email' } });
    expect(b).toMatchObject({ rodzaj: 'odmowa', kod: 'settlement_refused', pole: 'email', komunikat: 'To nie jest adres e-mail.' });
    expect(bladApi(422, { error: { code: 'settlement_refused', message: 'Dane miesiąca zmieniły się od otwarcia.' } }).pole).toBeUndefined();
  });
});

describe('miesiące formularza zapłaty spoza wyliczenia', () => {
  it('od ostatniego dozwolonego wstecz do stycznia 2025, przez przełom roku', async () => {
    const { miesiaceWstecz } = await import('../../mobile/src/lib/miesiace');
    const m = miesiaceWstecz('2025-01', '2026-02');
    expect(m.slice(0, 3)).toEqual(['2026-02', '2026-01', '2025-12']);
    expect(m.at(-1)).toBe('2025-01');
    expect(m).toHaveLength(14);
  });
});
