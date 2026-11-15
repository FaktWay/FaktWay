import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

/**
 * Plan skalowania 3000, sesja 7, część R1 (REQ-V02, GTR-03, QAL-06). To samo
 * co w `blad-infrastruktury-sesja.test.ts` (#783), ale w trzech plikach R1
 * z mapy ryzyka, które #783 zostawił na osobny PR:
 *
 * | Plik (obszar) | Było przy awarii | Jest |
 * |---|---|---|
 * | `lib/uploads/server.ts` (`retencja`) | limit GoTrue i błąd członkostwa: 403 „brak dostępu”; tokenu nie da się potwierdzić: 503 bez końca | 503 „spróbuj ponownie”; 401 „zaloguj się” |
 * | `app/actions/organizations.ts` (`ustawienia.firma`) | „Brak dostępu”, „Tylko właściciel”, druga „Moja firma”, zaproszenie i prośba dla obecnego członka, „nie” w audycie | „spróbuj ponownie”, bez zapisu; w audycie „nie wiadomo” |
 * | `upo-actions.ts` (`ksef.offline-upo`) | awaria GoTrue: „Niezalogowany”; błąd bazy: „Faktura nie znaleziona” | „spróbuj ponownie” |
 *
 * Test używa PRAWDZIWYCH klientów z `lib/supabase/server` (`@supabase/ssr`
 * i `supabase-js`). Atrapa gra tylko ciasteczka (`next/headers`), GoTrue,
 * PostgREST, magazyn UPO, pocztę i kolejkę. Prawdziwa odmowa zostaje
 * odmową, a gdy usługi odpowiadają, wszystko działa jak dotąd.
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
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn(async () => ({ sent: true })) }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: vi.fn() }));
vi.mock('@/lib/ksef/upo-storage', () => ({
  downloadUpoPdf: async () => Buffer.from('%PDF-1.7 UPO'),
  downloadUpoXml: async () => '<UPO/>',
}));

import { getUpoPdfAction, getUpoXmlAction } from '@/app/(dashboard)/invoices/[id]/upo-actions';
import {
  completeCompanyNipAction,
  createOrganizationAction,
  inviteMemberAction,
  requestJoinAction,
  setActiveOrganizationAction,
  skipOnboardingWithoutNipAction,
} from '@/app/actions/organizations';
import { POST as postExpense } from '@/app/api/uploads/expense/route';
import { ACTIVE_ORG_COOKIE } from '@/lib/supabase/active-org';
import { authorizeUpload } from '@/lib/uploads/server';

const SUPABASE_URL = 'https://fixture.supabase.test';
const COOKIE_NAME = 'sb-fixture-auth-token';
const ORIGIN = 'https://faktway.test';
const userId = '22222222-2222-4222-8222-222222222222';
const org = '11111111-1111-4111-8111-111111111111';
const otherOrg = '33333333-3333-4333-8333-333333333333';
const newOrg = '44444444-4444-4444-8444-444444444444';
const invoiceId = '55555555-5555-4555-8555-555555555555';
const USER_EMAIL = 'fixture-user@example.test';
const NIP = '1234567890';

const SESSION_RETRY = 'Nie udało się zweryfikować sesji. Spróbuj ponownie za chwilę.';
const SESSION_REJECTED = 'Nie udało się zweryfikować sesji. Zaloguj się ponownie.';
const AUTH_BUSY = 'System logowania jest chwilowo przeciążony. Spróbuj ponownie za minutę.';
const MEMBERSHIP_RETRY = 'Nie udało się sprawdzić dostępu do firmy. Spróbuj ponownie za chwilę.';
const MEMBERS_RETRY = 'Nie można sprawdzić członków firmy. Spróbuj ponownie.';
const INVOICE_RETRY = 'Nie udało się odczytać faktury. Spróbuj ponownie za chwilę.';
const UPLOAD_SESSION_EXPIRED = 'Sesja wygasła. Zaloguj się ponownie i wgraj plik jeszcze raz.';
const MEMBERSHIP_LOG = '[auth] Zapytanie o członkostwo nie powiodło się';
const NIP_CHECK_LOG = '[firmy] Sprawdzenie NIP-u nowej firmy nie powiodło się';
const INVOICE_LOG = '[upo] Odczyt faktury nie powiódł się';

type Row = Record<string, unknown>;
type Respond = () => Response;
/** Ścieżka atrapy (i, gdy podane, dokładne `select`), która zamiast zwykłej odpowiedzi oddaje błąd. */
type Failure = { path: string; select?: string; respond: Respond };
type Write = { method: string; table: string; body: unknown };

let failures: Failure[];
/** Wiersze tabel PostgREST oddawane na odczyt (filtry zapytania atrapa pomija). */
let tables: Record<string, Row[]>;
let userFactors: Row[];
/** Odczyty z PostgREST: `tabela?select=…`. */
let reads: string[];
/** Zapisy do PostgREST (POST, PATCH, DELETE) z treścią. */
let writes: Write[];
/** Żądania spoza atrapy. Błąd z atrapy auth-js wziąłby za awarię sieci, więc test sprawdza, że ich nie ma. */
let unexpected: string[];
let warn: MockInstance<typeof console.warn>;

const b64url = (value: string) => Buffer.from(value).toString('base64url');

/**
 * Ważna sesja HS256 (jak na produkcji) w formacie ciasteczka `@supabase/ssr`.
 * `aal` spoza `aal1`/`aal2`: tokenu nie da się potwierdzić (`mfa_assurance_invalid`).
 */
function sessionCookie({ aal = 'aal1' }: { aal?: string } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: userId, aal, role: 'authenticated', aud: 'authenticated',
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

function gotrueUser(id: string): Row {
  return {
    id, aud: 'authenticated', role: 'authenticated',
    email: id === userId ? USER_EMAIL : `inny-${id.slice(0, 4)}@example.test`,
    app_metadata: {}, user_metadata: {}, factors: id === userId ? userFactors : [],
  };
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

/** Zapis do PostgREST: zapamiętany, z odpowiedzią w kształcie, o który prosi klient. */
function write(method: string, table: string, init: RequestInit | undefined): Response {
  const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
  writes.push({ method, table, body });
  const headers = new Headers(init?.headers);
  if (!headers.get('prefer')?.includes('return=representation')) {
    return new Response(null, { status: method === 'POST' ? 201 : 204 });
  }
  const row = { id: table === 'tenants' ? newOrg : `fixture-${table}` };
  return headers.get('accept')?.includes('vnd.pgrst.object')
    ? Response.json(row, { status: 201 })
    : Response.json([row], { status: 201 });
}

function answer(method: string, url: URL, init: RequestInit | undefined): Response {
  const { pathname } = url;
  if (pathname === '/auth/v1/user') return Response.json(gotrueUser(userId));
  if (pathname.startsWith('/auth/v1/admin/users/')) {
    return Response.json(gotrueUser(pathname.slice('/auth/v1/admin/users/'.length)));
  }
  if (pathname.startsWith('/rest/v1/')) {
    const table = pathname.slice('/rest/v1/'.length);
    if (method !== 'GET' && method !== 'HEAD') return write(method, table, init);
    const rows = tables[table];
    if (rows) {
      reads.push(`${table}?select=${url.searchParams.get('select') ?? ''}`);
      if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-range': `*/${rows.length}` } });
      return Response.json(rows);
    }
  }
  unexpected.push(`${method} ${pathname}${url.search}`);
  throw new Error(`Nieoczekiwane żądanie w teście: ${method} ${url.href}`);
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : null;
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
  const select = url.searchParams.get('select') ?? undefined;
  const fail = failures.find((f) => f.path === url.pathname && (f.select === undefined || f.select === select));
  if (fail) return fail.respond();
  return answer(method, url, init);
}

/** Pierwsze argumenty wpisów `[auth] gotrue_…` w logu. */
const authLines = () => warn.mock.calls
  .map(([first]) => String(first))
  .filter((line) => line.startsWith('[auth] gotrue_'));

/** Drugie argumenty wpisów o danej treści. */
const logged = (line: string) => warn.mock.calls.filter(([first]) => first === line).map((call) => call[1] as unknown);

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

function auditMetadata(action: string): unknown {
  const entry = writes.find((w) => w.table === 'audit_logs' && (w.body as Row | null)?.action === action);
  return entry ? (entry.body as Row).metadata : undefined;
}

const company = {
  nip: NIP, name: 'Firma Testowa', postalCode: '00-001', city: 'Warszawa', street: 'Testowa', buildingNumber: '1',
};

const ownerMembership: Row = {
  id: 'fixture-membership', organization_id: org, user_id: userId, role: 'owner', status: 'active',
  tenants: { nip: NIP },
};

/** Żądanie wgrania jak z `fetch` w przeglądarce: multipart, `Content-Length`, `Origin` tej samej strony. */
async function uploadRequest(): Promise<NextRequest> {
  const form = new FormData();
  form.set('photo', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'paragon.jpg', { type: 'image/jpeg' }));
  const encoded = new Request(`${ORIGIN}/api/uploads/expense`, { method: 'POST', body: form });
  const body = await encoded.arrayBuffer();
  return new NextRequest(`${ORIGIN}/api/uploads/expense`, {
    method: 'POST',
    body,
    headers: {
      'content-type': encoded.headers.get('content-type')!,
      'content-length': String(body.byteLength),
      origin: ORIGIN,
      host: 'faktway.test',
    },
  });
}

beforeEach(() => {
  failures = [];
  reads = [];
  writes = [];
  unexpected = [];
  userFactors = [];
  tables = {
    memberships: [ownerMembership],
    global_feature_flags: [],
    tenants: [],
    invoices: [],
    upo_receipts: [],
    organization_invitations: [],
  };
  jar.clear();
  jar.set(COOKIE_NAME, sessionCookie());
  jar.set(ACTIVE_ORG_COOKIE, org);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'fixture-anon-key');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fixture-service-role-key-do-testow');
  vi.stubEnv('STRIPE_SECRET_KEY', '');
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => {
  expect(unexpected).toEqual([]);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('bramka wgrywania: awaria to 503 „spróbuj ponownie”, odmowa to 401 albo 403', () => {
  it.each(GOTRUE_DOWN)('%s: 503 auth_unavailable', async (_name, respond) => {
    failures.push({ path: '/auth/v1/user', respond });
    await expect(authorizeUpload({ maintenanceGate: false })).resolves.toMatchObject({
      ok: false, status: 503, reason: 'auth_unavailable', error: SESSION_RETRY,
    });
    expect(authLines()).toContain('[auth] gotrue_unavailable');
  });

  it('limit 429: 503 z komunikatem o przeciążeniu, a nie 403 „brak dostępu”', async () => {
    failures.push({ path: '/auth/v1/user', respond: rateLimited });
    await expect(authorizeUpload({ maintenanceGate: false })).resolves.toMatchObject({
      ok: false, status: 503, reason: 'auth_unavailable', error: AUTH_BUSY,
    });
    expect(authLines()).toContain('[auth] gotrue_rate_limited');
    expect(wholeLog()).not.toMatch(/eyJ|@example\.test/);
  });

  it('błąd zapytania o członkostwo: 503, a nie 403', async () => {
    failures.push({ path: '/rest/v1/memberships', respond: statementTimeout });
    await expect(authorizeUpload({ maintenanceGate: false })).resolves.toMatchObject({
      ok: false, status: 503, reason: 'auth_unavailable', error: MEMBERSHIP_RETRY,
    });
  });

  it('trasa oddaje przeglądarce 503 z komunikatem, a log ma powód', async () => {
    failures.push({ path: '/auth/v1/user', respond: rateLimited });
    const res = await postExpense(await uploadRequest());
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ success: false, error: AUTH_BUSY });
    expect(warn.mock.calls.map(([first]) => String(first))).toContain('[uploads] /api/uploads/expense: auth_unavailable (503)');
  });

  it('odrzucony token: 401 jak wygasła sesja', async () => {
    failures.push({ path: '/auth/v1/user', respond: tokenRejected });
    await expect(authorizeUpload({ maintenanceGate: false })).resolves.toMatchObject({
      ok: false, status: 401, reason: 'unauthenticated', error: UPLOAD_SESSION_EXPIRED,
    });
    expect(authLines()).toEqual([]);
  });

  it('tokenu nie da się potwierdzić: 401 „zaloguj się”, a nie 503 bez końca (jak API panelu)', async () => {
    jar.set(COOKIE_NAME, sessionCookie({ aal: 'aal9' }));
    await expect(authorizeUpload({ maintenanceGate: false })).resolves.toMatchObject({
      ok: false, status: 401, reason: 'unauthenticated', error: SESSION_REJECTED,
    });
    expect(authLines()).toEqual([]);
  });

  it('brak 2FA i brak członkostwa zostają 403', async () => {
    userFactors = [{ id: 'fixture-factor', factor_type: 'totp', status: 'verified' }];
    await expect(authorizeUpload({ maintenanceGate: false })).resolves.toMatchObject({
      ok: false, status: 403, reason: 'forbidden', error: 'Wymagana weryfikacja dwuetapowa',
    });
    userFactors = [];
    tables.memberships = [];
    await expect(authorizeUpload({ maintenanceGate: false })).resolves.toMatchObject({
      ok: false, status: 403, reason: 'forbidden', error: 'Brak dostępu do aktywnej organizacji',
    });
  });

  it('gdy usługi odpowiadają, bramka przepuszcza jak dotąd', async () => {
    await expect(authorizeUpload({ maintenanceGate: false })).resolves.toMatchObject({
      ok: true, ctx: { tenantId: org, role: 'owner', user: { id: userId } },
    });
  });
});

describe('akcje firm: błąd zapytania to „spróbuj ponownie” bez zapisu, a nie odmowa ani nowa firma', () => {
  it('przełączenie firmy: „spróbuj ponownie”, a nie „Brak dostępu do tej organizacji”', async () => {
    failures.push({ path: '/rest/v1/memberships', select: 'id', respond: statementTimeout });
    await expect(setActiveOrganizationAction(org)).resolves.toEqual({ success: false, error: MEMBERSHIP_RETRY });
    expect(writes).toEqual([]);
    expect(logged(MEMBERSHIP_LOG)).toEqual([{ flow: 'akcja', step: 'setActiveOrganization', code: '57014' }]);
  });

  it('przełączenie firmy: brak członkostwa zostaje odmową, a z członkostwem działa jak dotąd', async () => {
    tables.memberships = [];
    await expect(setActiveOrganizationAction(org)).resolves.toEqual({ success: false, error: 'Brak dostępu do tej organizacji' });
    tables.memberships = [ownerMembership];
    await expect(setActiveOrganizationAction(org)).resolves.toEqual({ success: true });
    expect(writes).toEqual([{ method: 'PATCH', table: 'users', body: { last_active_tenant_id: org } }]);
  });

  it('uzupełnienie NIP-u: „spróbuj ponownie”, a nie „Tylko właściciel”', async () => {
    failures.push({ path: '/rest/v1/memberships', select: 'role', respond: statementTimeout });
    await expect(completeCompanyNipAction(company)).resolves.toEqual({ success: false, error: MEMBERSHIP_RETRY });
    expect(writes).toEqual([]);
    expect(logged(MEMBERSHIP_LOG)).toEqual([{ flow: 'akcja', step: 'completeCompanyNip', code: '57014' }]);
  });

  it('uzupełnienie NIP-u: rola inna niż właściciel zostaje odmową', async () => {
    tables.memberships = [{ ...ownerMembership, role: 'member' }];
    await expect(completeCompanyNipAction(company)).resolves.toEqual({
      success: false, error: 'Tylko właściciel organizacji może uzupełnić NIP',
    });
    expect(writes).toEqual([]);
  });

  it('„Pomiń NIP”: błąd odczytu firm to „spróbuj ponownie”, a nie druga „Moja firma”', async () => {
    failures.push({ path: '/rest/v1/memberships', select: 'organization_id,tenants:organization_id(nip)', respond: statementTimeout });
    await expect(skipOnboardingWithoutNipAction()).resolves.toEqual({ success: false, error: MEMBERSHIP_RETRY });
    expect(writes).toEqual([]);
    expect(logged(MEMBERSHIP_LOG)).toEqual([{ flow: 'akcja', step: 'skipOnboardingWithoutNip', code: '57014' }]);
  });

  it('„Pomiń NIP”: istniejący szkic wraca bez nowej firmy, a bez szkicu powstaje jeden', async () => {
    tables.memberships = [{ organization_id: org, tenants: { nip: '' } }];
    await expect(skipOnboardingWithoutNipAction()).rejects.toMatchObject({ digest: expect.stringContaining(';/dashboard;') });
    expect(writes).toEqual([]);

    tables.memberships = [{ organization_id: org, tenants: { nip: NIP } }];
    await expect(skipOnboardingWithoutNipAction()).rejects.toMatchObject({ digest: expect.stringContaining(';/dashboard;') });
    expect(writes.filter((w) => w.table === 'tenants')).toEqual([
      { method: 'POST', table: 'tenants', body: expect.objectContaining({ name: 'Moja firma', nip: '' }) },
    ]);
  });

  it('nowa firma: błąd sprawdzenia NIP-u nie blokuje założenia, a audyt mówi „nie wiadomo”, nie „nie”', async () => {
    failures.push({ path: '/rest/v1/tenants', select: 'id,ksef_verified_at,ksef_verified_environment', respond: statementTimeout });
    await expect(createOrganizationAction(company)).rejects.toMatchObject({
      digest: expect.stringContaining(';/onboarding/import-source;'),
    });
    expect(auditMetadata('tenant.created')).toEqual({
      nip: NIP, name: 'Firma Testowa', nip_duplicate: null, ksef_verified_duplicate: null,
    });
    expect(logged(NIP_CHECK_LOG)).toEqual([{ code: '57014' }]);
  });

  it('nowa firma: gdy sprawdzenie działa, audyt ma prawdziwe flagi jak dotąd', async () => {
    tables.tenants = [{ id: otherOrg, ksef_verified_at: '2026-01-02T00:00:00Z', ksef_verified_environment: 'test' }];
    await expect(createOrganizationAction(company)).rejects.toMatchObject({
      digest: expect.stringContaining(';/onboarding/import-source;'),
    });
    expect(auditMetadata('tenant.created')).toEqual({
      nip: NIP, name: 'Firma Testowa', nip_duplicate: true, ksef_verified_duplicate: true,
    });
    expect(logged(NIP_CHECK_LOG)).toEqual([]);
  });

  it('zaproszenie: błąd odczytu członków to „spróbuj ponownie”, a nie zaproszenie dla obecnego członka', async () => {
    failures.push({ path: '/rest/v1/memberships', select: 'user_id', respond: statementTimeout });
    await expect(inviteMemberAction({ email: USER_EMAIL, role: 'member' })).resolves.toEqual({
      success: false, error: MEMBERS_RETRY,
    });
    expect(writes).toEqual([]);
    expect(logged(MEMBERSHIP_LOG)).toEqual([{ flow: 'akcja', step: 'inviteMember', code: '57014' }]);
  });

  it('zaproszenie: obecny członek dalej dostaje odmowę', async () => {
    await expect(inviteMemberAction({ email: USER_EMAIL.toUpperCase(), role: 'member' })).resolves.toEqual({
      success: false, error: 'Ten użytkownik jest już członkiem',
    });
    expect(writes).toEqual([]);
  });

  it('prośba o dołączenie: błąd odczytu członkostwa to „spróbuj ponownie”, a nie nowa prośba', async () => {
    failures.push({ path: '/rest/v1/memberships', select: 'status', respond: statementTimeout });
    await expect(requestJoinAction({ organizationId: otherOrg })).resolves.toEqual({
      success: false, error: MEMBERSHIP_RETRY,
    });
    expect(writes).toEqual([]);
    expect(logged(MEMBERSHIP_LOG)).toEqual([{ flow: 'akcja', step: 'requestJoin', code: '57014' }]);
  });

  it('prośba o dołączenie: obecny członek dalej dostaje odmowę', async () => {
    tables.memberships = [{ status: 'active' }];
    await expect(requestJoinAction({ organizationId: otherOrg })).resolves.toEqual({
      success: false, error: 'Jesteś już członkiem tej organizacji',
    });
    expect(writes).toEqual([]);
  });

  it('w logu nie ma tokenu ani adresu e-mail', async () => {
    failures.push({ path: '/rest/v1/memberships', select: 'user_id', respond: statementTimeout });
    await inviteMemberAction({ email: USER_EMAIL, role: 'member' });
    expect(wholeLog()).not.toMatch(/eyJ|@example\.test/);
  });
});

const UPO_ACTIONS: [string, (id: string) => Promise<{ success: boolean; error?: string }>][] = [
  ['PDF', getUpoPdfAction],
  ['XML', getUpoXmlAction],
];

describe.each(UPO_ACTIONS)('UPO %s: awaria to „spróbuj ponownie”, nie „Niezalogowany” ani „nie znaleziona”', (_kind, action) => {
  it.each(GOTRUE_DOWN)('%s', async (_name, respond) => {
    failures.push({ path: '/auth/v1/user', respond });
    await expect(action(invoiceId)).resolves.toEqual({ success: false, error: SESSION_RETRY });
    expect(authLines()).toContain('[auth] gotrue_unavailable');
    expect(reads).toEqual([]);
  });

  it('limit 429: osobny komunikat i wpis w logu bez tokenu i adresu', async () => {
    failures.push({ path: '/auth/v1/user', respond: rateLimited });
    await expect(action(invoiceId)).resolves.toEqual({ success: false, error: AUTH_BUSY });
    expect(authLines()).toContain('[auth] gotrue_rate_limited');
    expect(authLines()).not.toContain('[auth] gotrue_unavailable');
    expect(wholeLog()).not.toMatch(/eyJ|@example\.test/);
  });

  it('odrzucony token zostaje „Niezalogowany”', async () => {
    failures.push({ path: '/auth/v1/user', respond: tokenRejected });
    await expect(action(invoiceId)).resolves.toEqual({ success: false, error: 'Niezalogowany' });
    expect(authLines()).toEqual([]);
  });

  it('błąd odczytu faktury: „spróbuj ponownie”, a nie „Faktura nie znaleziona”', async () => {
    failures.push({ path: '/rest/v1/invoices', respond: statementTimeout });
    await expect(action(invoiceId)).resolves.toEqual({ success: false, error: INVOICE_RETRY });
    expect(logged(INVOICE_LOG)).toEqual([{ code: '57014' }]);
  });

  it('brak faktury zostaje „Faktura nie znaleziona”', async () => {
    await expect(action(invoiceId)).resolves.toEqual({ success: false, error: 'Faktura nie znaleziona' });
  });

  it('gdy usługi odpowiadają, UPO pobiera się jak dotąd', async () => {
    tables.invoices = [{
      id: invoiceId, tenant_id: org, internal_number: 'FV/1/2026', ksef_status: 'accepted',
      ksef_number: 'KSEF-FIXTURE-1', ksef_environment: 'test',
    }];
    tables.upo_receipts = [{ status: 'downloaded', tenant_id: org, ksef_number: 'KSEF-FIXTURE-1', ksef_environment: 'test' }];
    tables.tenants = [{ ksef_verified_at: '2026-01-02T00:00:00Z', ksef_verified_environment: 'test' }];
    await expect(action(invoiceId)).resolves.toMatchObject({ success: true });
  });
});
