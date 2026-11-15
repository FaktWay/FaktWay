import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { z } from 'zod';

/**
 * Plan aplikacji mobilnej, M8b: zaliczka, rozliczenie i korekta z telefonu,
 * wyliczenie kwot przez serwer, faktura pierwotna korekty, zaliczki do
 * rozliczenia, „Wyślij ponownie”, „Wróć do szkicu”, usunięcie szkicu, GUS
 * oraz zwykła faktura dla firmy z UE i osoby z PESEL.
 *
 * Prawdziwe: trasy `app/api/mobile/v1/*`, bramka `authenticateMobileRequest`,
 * `lib/api/mobile/faktury-rodzaje.ts`, schematy, `lib/invoices/issue-*.ts`,
 * `ksef-resend.ts`, `delete-draft.ts`, `lookup-buyer.ts` (te same funkcje co
 * akcje strony). Atrapy tylko dla HTTP i baz: GoTrue i PostgREST przez `fetch`
 * (tabele, unikalne indeksy i RLS firmy w uproszczeniu), kolejka KSeF (granica
 * pg-boss), audyt, Redis i klient GUS. Prawdziwe tabele z RLS sprawdza
 * `tests/rls-mobile-faktury-rodzaje.test.ts` na bazie.
 */

const SUPABASE_URL = 'https://db.fixture.test';
const ANON_KEY = 'anon-fixture-key';
const SERVICE_ROLE_KEY = 'service-fixture-key';

const USER_A = 'aaaaaaaa-1111-4111-8111-000000000001';
const USER_KSIEGOWA = 'aaaaaaaa-1111-4111-8111-000000000002';
const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const KEY_1 = '0c4e5f1a-7b2d-4c3e-9f10-111111111111';
const KEY_2 = '0c4e5f1a-7b2d-4c3e-9f10-222222222222';
const PARENT = '11111111-2222-4333-8444-000000000001';
const ADVANCE = '11111111-2222-4333-8444-000000000002';
const ADVANCE_OTHER = '11111111-2222-4333-8444-000000000003';
const FAILED = '11111111-2222-4333-8444-000000000004';
const DRAFT = '11111111-2222-4333-8444-000000000005';
const TENANT_NIP = '5260001246';
const BUYER_NIP = '5252241585';

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
  return { client, sets, enqueue: vi.fn(), audit: vi.fn(), revalidate: vi.fn(), gus: vi.fn() };
});

vi.mock('@/lib/cache/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cache/redis')>();
  return { ...actual, isRedisConfigured: () => true, getRedis: () => fake.client };
});
vi.mock('@/lib/feature-flags/maintenance', () => ({ isMaintenanceMode: async () => false, MAINTENANCE_PATH: '/przerwa-techniczna' }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: fake.revalidate }));
vi.mock('@/lib/audit/log', () => ({ logAudit: fake.audit, logAuditWithResult: fake.audit }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: fake.enqueue }));
vi.mock('@/lib/gus/client', () => ({ lookupCompanyByNip: fake.gus }));

import { GET as korektaRoute } from '@/app/api/mobile/v1/faktury/[id]/korekta/route';
import { POST as ponowienieRoute } from '@/app/api/mobile/v1/faktury/[id]/ponowienie/route';
import { POST as szkicRoute } from '@/app/api/mobile/v1/faktury/[id]/szkic/route';
import { POST as usuniecieRoute } from '@/app/api/mobile/v1/faktury/[id]/usuniecie/route';
import { GET as podpowiedzRoute } from '@/app/api/mobile/v1/faktury/podpowiedz/route';
import { POST as fakturyRoute } from '@/app/api/mobile/v1/faktury/route';
import { POST as wyliczenieRoute } from '@/app/api/mobile/v1/faktury/wyliczenie/route';
import { GET as zaliczkiRoute } from '@/app/api/mobile/v1/faktury/zaliczki/route';
import { GET as gusRoute } from '@/app/api/mobile/v1/gus/[nip]/route';
import {
  KRAJE_UE_TELEFONU,
  type FakturaTelefonu,
  type KorektaTelefonu,
  type RozliczenieTelefonu,
  type WyliczenieZadanie,
  type WystawienieRodzajuZadanie,
  type ZaliczkaTelefonu,
} from '@/lib/api/mobile/kontrakt';
import {
  korektaTelefonuSchema,
  rozliczenieTelefonuSchema,
  wyliczenieSchema,
  wystawienieRodzajuSchema,
  zaliczkaTelefonuSchema,
} from '@/lib/api/mobile/schematy-rodzaje';
import { generateAdvanceInvoiceXml, generateFinalInvoiceXml, type AdvanceInvoiceSettlementRow } from '@/lib/ksef/fa3-advance-generator';
import { generateCorrectionInvoiceXml } from '@/lib/ksef/fa3-correction-generator';
import { EU_BUYER_COUNTRIES } from '@/lib/schemas/invoice-form';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { validateFA3 } from '@/lib/xml/validator';
import type { Invoice } from '@/types/invoice';
import type { AdvanceInvoiceData, CorrectionInvoiceData, FinalInvoiceData } from '@/types/invoice-types';

// ─── Tokeny ───────────────────────────────────────────────────────────

const b64url = (value: string) => Buffer.from(value).toString('base64url');
function accessToken(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    b64url(JSON.stringify({ aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 3600, ...claims })),
    b64url('fixture-signature'),
  ].join('.');
}
const TOKEN_A = accessToken({ sub: USER_A, aal: 'aal1', session_id: 'cccccccc-2222-4222-8222-000000000001' });
const TOKEN_KSIEGOWA = accessToken({ sub: USER_KSIEGOWA, aal: 'aal1', session_id: 'cccccccc-2222-4222-8222-000000000002' });
const issued = new Map([[TOKEN_A, USER_A], [TOKEN_KSIEGOWA, USER_KSIEGOWA]]);

// ─── Atrapa bazy (PostgREST w uproszczeniu) ───────────────────────────

type Row = Record<string, unknown>;
let invoices: Row[] = [];
let lines: Row[] = [];
let keys: Row[] = [];
let contractors: Row[] = [];
let idCounter = 0;
const writes: Array<{ table: string; method: string }> = [];
const resetCalls: Row[] = [];

const memberships = [
  { user_id: USER_A, organization_id: ORG_A, role: 'owner', status: 'active' },
  { user_id: USER_KSIEGOWA, organization_id: ORG_A, role: 'accountant', status: 'active' },
];
const tenant = {
  id: ORG_A,
  nip: TENANT_NIP,
  name: 'Firma A',
  address_json: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' },
  vat_exemption_basis: null,
  vat_cash_method: false,
};

/** Filtry PostgREST z adresu: `eq.`, `neq.`, `in.()`, `ov.{}`, `is.null` (bez `or`, `select`, `order`). */
function filtered(url: URL, rows: Row[]): Row[] {
  let out = rows;
  for (const [column, raw] of url.searchParams) {
    if (['select', 'order', 'limit', 'offset', 'or', 'on_conflict', 'columns'].includes(column)) continue;
    const value = decodeURIComponent(raw);
    if (value.startsWith('eq.')) out = out.filter((r) => String(r[column]) === value.slice(3));
    else if (value.startsWith('neq.')) out = out.filter((r) => String(r[column]) !== value.slice(4));
    else if (value.startsWith('in.(')) {
      const list = value.slice(4, -1).split(',').map((v) => v.replace(/^"|"$/g, ''));
      out = out.filter((r) => list.includes(String(r[column])));
    } else if (value.startsWith('ov.{')) {
      const list = value.slice(4, -1).split(',');
      out = out.filter((r) => Array.isArray(r[column]) && (r[column] as string[]).some((v) => list.includes(v)));
    } else if (value === 'is.null') out = out.filter((r) => r[column] == null);
  }
  const limit = url.searchParams.get('limit');
  return limit ? out.slice(0, Number(limit)) : out;
}

/** Odpowiedź jak PostgREST: obiekt przy `.single()`/`.maybeSingle()` (Accept object), inaczej lista. */
function reply(request: Request, rows: Row[], status = 200): Response {
  const asObject = request.headers.get('accept')?.includes('vnd.pgrst.object');
  if (asObject) return rows[0] ? Response.json(rows[0], { status }) : Response.json({ code: 'PGRST116', message: '0 rows' }, { status: 406 });
  return Response.json(rows, { status });
}
const conflict = (constraint: string) =>
  Response.json({ code: '23505', message: `duplicate key value violates unique constraint "${constraint}"` }, { status: 409 });

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== SUPABASE_URL) throw new Error(`nieoczekiwane wyjście do ${url.origin}`);
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? null;

  if (url.pathname === '/auth/v1/user') {
    const sub = token ? issued.get(token) : undefined;
    if (!sub) return Response.json({ msg: 'invalid JWT' }, { status: 401 });
    return Response.json({ id: sub, aud: 'authenticated', role: 'authenticated', email: `${sub}@x.test`, factors: [] });
  }

  const table = url.pathname.replace('/rest/v1/', '');
  const method = request.method;
  // „Wróć do szkicu” idzie kluczem serwisowym jak na stronie (RPC przepuszcza tylko service_role).
  if (token === SERVICE_ROLE_KEY) {
    if (table !== 'rpc/reset_ksef_send') return Response.json({ message: 'API aplikacji nie używa klucza serwisowego' }, { status: 418 });
    const args = JSON.parse(await request.text()) as Row;
    resetCalls.push(args);
    const row = invoices.find((i) => i.id === args.p_invoice_id && i.tenant_id === args.p_tenant_id);
    if (!row || (row.ksef_status !== 'failed' && row.ksef_status !== 'rejected')) {
      return Response.json({ code: 'P0001', message: 'reset_ksef_send: invoice not resettable' }, { status: 400 });
    }
    row.ksef_status = 'draft';
    return new Response(null, { status: 204 });
  }
  const sub = token ? issued.get(token) : undefined;
  if (!sub) return Response.json({ message: 'JWT invalid' }, { status: 401 });
  // RLS firmy w uproszczeniu: `get_current_tenant_id()` z nagłówka i członkostwa.
  const org = request.headers.get('x-active-org');
  const current = memberships.some((m) => m.user_id === sub && m.organization_id === org && m.status === 'active') ? org : null;
  if (method !== 'GET') writes.push({ table, method });

  if (table === 'memberships') return reply(request, filtered(url, memberships.filter((m) => m.user_id === sub)));
  if (table === 'tenants') return reply(request, current && url.searchParams.get('id') === `eq.${current}` ? [tenant] : []);
  if (table === 'ksef_submissions') return reply(request, []);
  if (table === 'rpc/invoice_number_series_overview') return Response.json({ series: [] });

  if (table === 'mobile_idempotency_keys') {
    if (method === 'POST') {
      const row = JSON.parse(await request.text()) as Row;
      if (row.user_id !== sub || row.tenant_id !== current) return Response.json({ code: '42501', message: 'RLS' }, { status: 403 });
      // CHECK 00201/00202: dla faktur tylko ta trasa.
      if (row.endpoint !== 'POST /api/mobile/v1/faktury') return Response.json({ code: '23514', message: 'mobile_idempotency_keys_endpoint_check' }, { status: 400 });
      if (keys.some((k) => k.tenant_id === row.tenant_id && k.user_id === row.user_id && k.idempotency_key === row.idempotency_key)) {
        return conflict('uq_mobile_idempotency_keys_key');
      }
      keys.push(row);
      return new Response(null, { status: 201 });
    }
    return reply(request, filtered(url, keys.filter((k) => k.user_id === sub && k.tenant_id === current)));
  }

  if (table === 'contractors') {
    if (method === 'POST') {
      const row = JSON.parse(await request.text()) as Row;
      if (row.tenant_id !== current) return Response.json({ code: '42501', message: 'RLS' }, { status: 403 });
      contractors = [...contractors.filter((c) => !(c.tenant_id === row.tenant_id && c.nip === row.nip)), row];
      return new Response(null, { status: 201 });
    }
    if (method === 'PATCH') return new Response(null, { status: 204 });
    return reply(request, filtered(url, contractors.filter((c) => c.tenant_id === current)));
  }

  if (table === 'invoices') {
    const visible = invoices.filter((i) => i.tenant_id === current);
    if (method === 'POST') {
      const row = JSON.parse(await request.text()) as Row;
      if (row.tenant_id !== current) return Response.json({ code: '42501', message: 'RLS' }, { status: 403 });
      // Wyzwalacz 00199: drugi zapis z tym samym kluczem zapisu.
      if (row.number_request_key && invoices.some((i) => i.tenant_id === row.tenant_id && i.number_request_key === row.number_request_key)) {
        return Response.json({ code: 'P0001', message: 'invoice_number_request_done' }, { status: 400 });
      }
      if (invoices.some((i) => i.tenant_id === row.tenant_id && i.internal_number === row.internal_number)) {
        return conflict('uq_invoices_tenant_outgoing_internal_number');
      }
      // Domyślne kolumn jak w bazie (00001: `invoice_kind` regular, `special_data` i kod błędu NULL).
      const saved = { invoice_kind: 'regular', special_data: null, last_error_code: null, ...row, id: `00000000-0000-4000-8000-${String((idCounter += 1)).padStart(12, '0')}`, ksef_status: 'draft' };
      invoices.push(saved);
      return reply(request, [{ id: saved.id }], 201);
    }
    if (method === 'DELETE') {
      const gone = filtered(url, visible);
      invoices = invoices.filter((i) => !gone.includes(i));
      return Response.json(gone.map((g) => ({ id: g.id, internal_number: g.internal_number })), { status: 200 });
    }
    return reply(request, filtered(url, visible));
  }
  if (table === 'invoice_line_items') {
    if (method === 'POST') {
      lines.push(...(JSON.parse(await request.text()) as Row[]));
      return new Response(null, { status: 201 });
    }
    return reply(request, filtered(url, lines).sort((a, b) => Number(a.ordinal) - Number(b.ordinal)));
  }
  return Response.json({ message: `nieznana tabela ${table}` }, { status: 404 });
}

// ─── Dane ─────────────────────────────────────────────────────────────

const DZIS = '2026-11-13';
const SELLER_PARTY = { nip: TENANT_NIP, name: 'Firma A', address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } };
const BUYER_PARTY = { nip: BUYER_NIP, name: 'Klient Sp. z o.o.', address: { countryCode: 'PL', addressLine1: 'ul. Kliencka 3', addressLine2: '00-003 Warszawa' } };

/** Faktura przyjęta w KSeF TEST: 2 × 500 zł netto, 23% (1000 + 230 = 1230). */
function parentInvoice(): Row {
  return {
    id: PARENT,
    tenant_id: ORG_A,
    direction: 'outgoing',
    invoice_kind: 'regular',
    invoice_type: 'VAT',
    ksef_status: 'accepted',
    ksef_environment: 'test',
    ksef_number: `${TENANT_NIP}-20261110-0A1B2C3D4E5F-AB`,
    internal_number: 'FV/1/11/2026',
    issue_date: '2026-11-10',
    net_total: 1000,
    vat_total: 230,
    gross_total: 1230,
    seller_data: SELLER_PARTY,
    buyer_data: BUYER_PARTY,
    fa3_data: { annotations: { cashMethod: 2, splitPayment: 2 } },
  };
}

function advanceInvoice(id: string, buyer: { nip: string; name: string }, number: string): Row {
  return {
    id,
    tenant_id: ORG_A,
    direction: 'outgoing',
    invoice_kind: 'advance',
    invoice_type: 'ZAL',
    ksef_status: 'accepted',
    ksef_number: `${TENANT_NIP}-20261105-${id.slice(-12).toUpperCase()}-AB`,
    internal_number: number,
    issue_date: '2026-11-05',
    advance_amount: 1230,
    net_total: 1000,
    vat_total: 230,
    gross_total: 1230,
    buyer_nip: buyer.nip,
    buyer_data: { nip: buyer.nip, name: buyer.name, address: { countryCode: 'PL', addressLine1: 'ul. Kliencka 3', addressLine2: '00-003 Warszawa' } },
    fa3_data: { lines: [{ vatRate: '23', netAmount: 1000, vatAmount: 230, grossAmount: 1230 }] },
  };
}

const nabywca = { nip: BUYER_NIP, name: 'Klient Sp. z o.o.', addressLine1: 'ul. Kliencka 3', addressLine2: '00-003 Warszawa', email: '' };
const dokument = {
  issueDate: DZIS,
  paymentMethod: 'transfer' as const,
  paymentDueDate: '2026-11-27',
  bankAccount: '61109010140000071219812874',
  notes: '',
  numberSeriesId: '',
  numberPreview: '',
};

const zaliczka = (extra: Partial<ZaliczkaTelefonu> = {}): ZaliczkaTelefonu => ({
  ...dokument,
  internalNumber: 'FZ/1/11/2026',
  splitPayment: false,
  buyer: nabywca,
  advanceAmount: 1230,
  totalContractAmount: 4920,
  expectedDeliveryDate: '',
  advanceReceivedDate: '',
  vatRate: '23',
  description: 'Zaliczka na projekt strony',
  ...extra,
});

const rozliczenie = (extra: Partial<RozliczenieTelefonu> = {}): RozliczenieTelefonu => ({
  ...dokument,
  internalNumber: 'FR/1/11/2026',
  splitPayment: false,
  buyer: nabywca,
  advanceInvoiceIds: [ADVANCE],
  lines: [{ name: 'Projekt strony', unit: 'szt', quantity: 1, unitPriceNet: 4000, vatRate: '23' }],
  ...extra,
});

const korekta = (extra: Partial<KorektaTelefonu> = {}): KorektaTelefonu => ({
  ...dokument,
  internalNumber: 'KOR/1/11/2026',
  parentInvoiceId: PARENT,
  correctionType: 'amount_change',
  correctionReason: 'Rabat za opóźnienie',
  typKorekty: '2',
  linesAfter: [],
  amountChange: { netDelta: -100, vatDelta: -23, grossDelta: -123, description: 'Rabat' },
  ...extra,
});

const faktura = (extra: Partial<FakturaTelefonu> = {}): FakturaTelefonu => ({
  internalNumber: 'FV/2/11/2026',
  issueDate: DZIS,
  saleDate: '',
  buyerNip: BUYER_NIP,
  buyerName: 'Klient Sp. z o.o.',
  buyerAddressLine1: 'ul. Kliencka 3',
  buyerAddressLine2: '00-003 Warszawa',
  buyerEmail: '',
  buyerIsConsumer: false,
  lines: [{ name: 'Projekt graficzny', unit: 'szt', quantity: 1, unitPriceNet: 1500, vatRate: '23' }],
  paymentMethod: 'transfer',
  paymentDueDate: '2026-11-27',
  bankAccount: '61109010140000071219812874',
  notes: '',
  splitPayment: false,
  numberSeriesId: '',
  numberPreview: '',
  ...extra,
});

// ─── Żądania ──────────────────────────────────────────────────────────

let ip = 0;
type Opcje = { token?: string | null; org?: string | null; key?: string | null; method?: 'GET' | 'POST' };
function request(path: string, body: unknown, options: Opcje = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-real-ip': `198.51.100.${(ip += 1) % 250}` };
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN_A}`;
  if (options.org !== null) headers['x-active-org'] = options.org ?? ORG_A;
  if (options.key !== null && options.key !== undefined) headers['idempotency-key'] = options.key;
  const method = options.method ?? 'POST';
  return new Request(`https://app.example.test${path}`, { method, headers, body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body) });
}
const params = <K extends string>(key: K, value: string) => ({ params: Promise.resolve({ [key]: value } as Record<K, string>) });

const wystaw = (body: unknown, options: Opcje = {}) => fakturyRoute(request('/api/mobile/v1/faktury', body, { key: KEY_1, ...options }));
const wylicz = (body: WyliczenieZadanie, options: Opcje = {}) => wyliczenieRoute(request('/api/mobile/v1/faktury/wyliczenie', body, options));
const kontekstKorekty = (id: string, options: Opcje = {}) => korektaRoute(request(`/api/mobile/v1/faktury/${id}/korekta`, undefined, { method: 'GET', ...options }), params('id', id));
const ponow = (id: string, options: Opcje = {}) => ponowienieRoute(request(`/api/mobile/v1/faktury/${id}/ponowienie`, undefined, options), params('id', id));
const doSzkicu = (id: string, options: Opcje = {}) => szkicRoute(request(`/api/mobile/v1/faktury/${id}/szkic`, undefined, options), params('id', id));
const usun = (id: string, options: Opcje = {}) => usuniecieRoute(request(`/api/mobile/v1/faktury/${id}/usuniecie`, undefined, options), params('id', id));
const gus = (nip: string, options: Opcje = {}) => gusRoute(request(`/api/mobile/v1/gus/${nip}`, undefined, { method: 'GET', ...options }), params('nip', nip));
const zaliczki = (options: Opcje = {}) => zaliczkiRoute(request('/api/mobile/v1/faktury/zaliczki', undefined, { method: 'GET', ...options }));

async function errorOf(response: Response) {
  return ((await response.json()) as { error: { code: string; message: string; field?: string } }).error;
}

/** Kolejka jak RPC `enqueue_ksef_send` / `requeue_ksef_send`: przejmuje szkic albo nieudaną wysyłkę. */
function kolejkaPrzyjmuje() {
  fake.enqueue.mockImplementation(async (p: { invoiceId: string; mode?: { kind: string } }) => {
    const row = invoices.find((i) => i.id === p.invoiceId);
    const from = p.mode?.kind === 'requeue' ? 'failed' : 'draft';
    if (!row || row.ksef_status !== from) return { ok: false, error: 'Faktura jest już wysyłana do KSeF.' };
    row.ksef_status = 'queued';
    return { ok: true, mode: 'online_queued' };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.sets.clear();
  invoices = [parentInvoice(), advanceInvoice(ADVANCE, { nip: BUYER_NIP, name: 'Klient Sp. z o.o.' }, 'FZ/9/11/2026')];
  lines = [{ invoice_id: PARENT, ordinal: 1, name: 'Projekt', unit: 'szt', quantity: 2, unit_price_net: 500, vat_rate: '23', net_amount: 1000, vat_amount: 230, gross_amount: 1230 }];
  keys = [];
  contractors = [];
  idCounter = 0;
  writes.length = 0;
  resetCalls.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-13T09:00:00Z'));
  kolejkaPrzyjmuje();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', ANON_KEY);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE_KEY);
  vi.stubEnv('KSEF_ENV', 'test');
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ─── Kontrakt ─────────────────────────────────────────────────────────

describe('kontrakt M8b', () => {
  it('schematy telefonu dają dokładnie typy kontraktu', () => {
    expectTypeOf<z.output<typeof zaliczkaTelefonuSchema>>().toEqualTypeOf<ZaliczkaTelefonu>();
    expectTypeOf<z.output<typeof rozliczenieTelefonuSchema>>().toEqualTypeOf<RozliczenieTelefonu>();
    expectTypeOf<z.output<typeof korektaTelefonuSchema>>().toEqualTypeOf<KorektaTelefonu>();
    expectTypeOf<z.output<typeof wystawienieRodzajuSchema>>().toEqualTypeOf<WystawienieRodzajuZadanie>();
    expectTypeOf<z.output<typeof wyliczenieSchema>>().toEqualTypeOf<WyliczenieZadanie>();
  });

  it('kraje firmy z UE w telefonie to lista formularza strony (kody i nazwy, ta sama kolejność)', () => {
    expect(KRAJE_UE_TELEFONU.map((k) => ({ code: k.kod, name: k.nazwa }))).toEqual(EU_BUYER_COUNTRIES);
  });
});

// ─── Bramka na każdej nowej trasie ────────────────────────────────────

const TRASY: Array<[string, (o: Opcje) => Promise<Response>]> = [
  ['POST /faktury (zaliczka)', (o) => wystaw({ wyslij: false, zaliczka: zaliczka() }, o)],
  ['POST /faktury/wyliczenie', (o) => wylicz({ zaliczka: zaliczka() }, o)],
  ['GET /faktury/zaliczki', (o) => zaliczki(o)],
  ['GET /faktury/{id}/korekta', (o) => kontekstKorekty(PARENT, o)],
  ['POST /faktury/{id}/ponowienie', (o) => ponow(FAILED, o)],
  ['POST /faktury/{id}/szkic', (o) => doSzkicu(FAILED, o)],
  ['POST /faktury/{id}/usuniecie', (o) => usun(DRAFT, o)],
  ['GET /gus/{nip}', (o) => gus(BUYER_NIP, o)],
];

describe('bramka tras M8b', () => {
  it.each(TRASY)('%s: brak tokenu 401 missing_token, zły token 401 invalid_token, bez firmy 400, nic nie zapisuje', async (_n, call) => {
    const brak = await call({ token: null });
    expect(brak.status).toBe(401);
    expect((await errorOf(brak)).code).toBe('missing_token');

    const zly = await call({ token: accessToken({ sub: USER_A, session_id: 'cccccccc-2222-4222-8222-00000000dead' }) });
    expect(zly.status).toBe(401);
    expect((await errorOf(zly)).code).toBe('invalid_token');

    const bezFirmy = await call({ org: null });
    expect(bezFirmy.status).toBe(400);
    expect((await errorOf(bezFirmy)).code).toBe('missing_org');

    expect(writes).toEqual([]);
    expect(fake.enqueue).not.toHaveBeenCalled();
    expect(fake.gus).not.toHaveBeenCalled();
  });
});

// ─── Zaliczka ─────────────────────────────────────────────────────────

describe('zaliczka z telefonu', () => {
  it('szkic: 201, kwoty liczy serwer (1230 brutto przy 23% to 1000 + 230), klucz zapisany', async () => {
    const response = await wystaw({ wyslij: false, zaliczka: zaliczka() });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { faktura: { id: string; ksefStatus: string }; wysylka: unknown; powtorzenie: boolean };
    expect(body).toMatchObject({ faktura: { ksefStatus: 'draft', numer: 'FZ/1/11/2026' }, wysylka: null, powtorzenie: false });
    const row = invoices.find((i) => i.id === body.faktura.id)!;
    expect(row).toMatchObject({ invoice_kind: 'advance', invoice_type: 'ZAL', net_total: 1000, vat_total: 230, gross_total: 1230, number_request_key: KEY_1 });
    expect(row.seller_data).toMatchObject({ nip: TENANT_NIP });
    expect(keys).toEqual([expect.objectContaining({ idempotency_key: KEY_1, invoice_id: body.faktura.id, endpoint: 'POST /api/mobile/v1/faktury' })]);
    expect(fake.enqueue).not.toHaveBeenCalled();
  });

  it('wyślij: klucz przed kolejką, kolejka z 2FA z tokenu i kopertą zaliczki; ponowienie nie zleca drugi raz', async () => {
    const order: string[] = [];
    fake.enqueue.mockImplementationOnce(async (p: { invoiceId: string }) => {
      order.push(keys.length ? 'kolejka po kluczu' : 'kolejka przed kluczem');
      invoices.find((i) => i.id === p.invoiceId)!.ksef_status = 'queued';
      return { ok: true };
    });
    const first = await wystaw({ wyslij: true, zaliczka: zaliczka() });
    expect(first.status).toBe(201);
    expect(((await first.json()) as { wysylka: unknown }).wysylka).toEqual({ zlecona: true, blad: null });
    expect(order).toEqual(['kolejka po kluczu']);
    expect(fake.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ auditKind: 'advance', tokenSession: { mfa: 'enrollment_required' }, advanceData: expect.objectContaining({ advanceAmount: 1230, vatRate: '23' }) }),
    );

    const again = await wystaw({ wyslij: true, zaliczka: zaliczka() });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ powtorzenie: true, faktura: { ksefStatus: 'queued' }, wysylka: { zlecona: true } });
    expect(fake.enqueue).toHaveBeenCalledTimes(1);
    expect(invoices.filter((i) => i.invoice_kind === 'advance' && i.tenant_id === ORG_A)).toHaveLength(2);
  });

  it('ponowienie w trakcie pierwszego żądania (klucz już jest, kolejka jeszcze trwa): oba mówią „zlecona”, jedna wysyłka', async () => {
    let pusc: () => void = () => undefined;
    fake.enqueue.mockImplementationOnce(
      (p: { invoiceId: string }) =>
        new Promise((resolve) => {
          pusc = () => {
            invoices.find((i) => i.id === p.invoiceId)!.ksef_status = 'queued';
            resolve({ ok: true });
          };
        }),
    );
    const first = wystaw({ wyslij: true, zaliczka: zaliczka() });
    // Pierwsze żądanie czeka w kolejce KSeF (klucz zapisany); telefon po limicie czasu ponawia.
    await vi.waitFor(() => expect(fake.enqueue).toHaveBeenCalledTimes(1));
    const again = wystaw({ wyslij: true, zaliczka: zaliczka() });
    setTimeout(() => pusc(), 300);
    const [r1, r2] = await Promise.all([first, again]);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({ powtorzenie: true, wysylka: { zlecona: true, blad: null } });
    expect(fake.enqueue).toHaveBeenCalledTimes(1);
  });

  it('ten sam klucz z inną treścią: 409 idempotency_conflict bez drugiego zapisu', async () => {
    await wystaw({ wyslij: false, zaliczka: zaliczka() });
    const other = await wystaw({ wyslij: false, zaliczka: zaliczka({ advanceAmount: 2460 }) });
    expect(other.status).toBe(409);
    expect((await errorOf(other)).code).toBe('idempotency_conflict');
  });

  it('błąd z formularza strony: 422 invoice_invalid z polem i zdaniem strony, bez zapisu', async () => {
    const response = await wystaw({ wyslij: true, zaliczka: zaliczka({ advanceAmount: 6000 }) });
    expect(response.status).toBe(422);
    expect(await errorOf(response)).toEqual({ code: 'invoice_invalid', message: 'Zaliczka nie może być większa niż wartość umowy', field: 'advanceAmount' });
    // Domyślne zdanie Zod po angielsku nie trafia do klienta.
    const krotki = await wystaw({ wyslij: false, zaliczka: zaliczka({ description: 'abc' }) }, { key: KEY_2 });
    expect(await errorOf(krotki)).toEqual({ code: 'invoice_invalid', message: 'Sprawdź pole „Opis zaliczki”.', field: 'description' });
    expect(writes.filter((w) => w.table === 'invoices')).toEqual([]);
  });

  it('treść spoza kontraktu (dwa rodzaje naraz, pole spoza): 400 invalid_request', async () => {
    for (const body of [
      { wyslij: false, zaliczka: zaliczka(), korekta: korekta() },
      { wyslij: false, zaliczka: { ...zaliczka(), currency: 'EUR' } },
    ]) {
      const response = await wystaw(body);
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
  });

  it('wyliczenie: kwoty zaliczki z serwera, nic nie zapisuje', async () => {
    const response = await wylicz({ zaliczka: zaliczka({ vatRate: '8', advanceAmount: 1080 }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ netto: 1000, vat: 80, brutto: 1080, doZaplaty: 1080, pozycje: [{ nazwa: 'Zaliczka: Zaliczka na projekt strony', brutto: 1080 }] });
    expect(writes).toEqual([]);
  });
});

// ─── Rozliczenie ──────────────────────────────────────────────────────

describe('rozliczenie zaliczek z telefonu', () => {
  it('lista zaliczek: przyjęte, nierozliczone, z nabywcą', async () => {
    invoices.push({ ...advanceInvoice(ADVANCE_OTHER, { nip: '7272445205', name: 'Inna Firma' }, 'FZ/8/11/2026') });
    invoices.push({ id: 'roz-1', tenant_id: ORG_A, direction: 'outgoing', invoice_kind: 'final', ksef_status: 'draft', internal_number: 'FR/7/11/2026', advance_invoice_ids: [ADVANCE_OTHER] });
    const response = await zaliczki();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { zaliczki: Array<{ id: string; brutto: number; nabywca: { nip: string | null } }> };
    expect(body.zaliczki).toEqual([expect.objectContaining({ id: ADVANCE, numer: 'FZ/9/11/2026', brutto: 1230, nabywca: expect.objectContaining({ nip: BUYER_NIP, nazwa: 'Klient Sp. z o.o.' }) })]);
  });

  it('wyliczenie: suma pozycji i kwota do zapłaty po odjęciu zaliczki (serwer)', async () => {
    const response = await wylicz({ rozliczenie: rozliczenie() });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ netto: 4000, vat: 920, brutto: 4920, doZaplaty: 3690, zaliczki: [{ id: ADVANCE, numer: 'FZ/9/11/2026', brutto: 1230 }] });
  });

  it('szkic: 201 z zaliczką; wyślij: 422 ze zdaniem strony o wstrzymanej wysyłce, bez zapisu', async () => {
    const send = await wystaw({ wyslij: true, rozliczenie: rozliczenie() });
    expect(send.status).toBe(422);
    expect(await errorOf(send)).toMatchObject({ code: 'ksef_send_refused', message: expect.stringContaining('tymczasowo wstrzymana') });
    expect(writes.filter((w) => w.table === 'invoices')).toEqual([]);

    const draft = await wystaw({ wyslij: false, rozliczenie: rozliczenie() }, { key: KEY_2 });
    expect(draft.status).toBe(201);
    const id = ((await draft.json()) as { faktura: { id: string } }).faktura.id;
    expect(invoices.find((i) => i.id === id)).toMatchObject({ invoice_kind: 'final', advance_invoice_ids: [ADVANCE], gross_total: 4920 });
    expect(fake.enqueue).not.toHaveBeenCalled();
  });

  it('zaliczka innego nabywcy: 422 ze zdaniem strony (art. 106f ust. 3)', async () => {
    invoices.push(advanceInvoice(ADVANCE_OTHER, { nip: '7272445205', name: 'Inna Firma' }, 'FZ/8/11/2026'));
    const response = await wystaw({ wyslij: false, rozliczenie: rozliczenie({ advanceInvoiceIds: [ADVANCE_OTHER] }) });
    expect(response.status).toBe(422);
    expect((await errorOf(response)).message).toContain('art. 106f ust. 3');
  });

  it('podpowiedź z rodzajem: dziś i numer z numeracji faktury końcowej; nieznany rodzaj 400', async () => {
    const ok = await podpowiedzRoute(request('/api/mobile/v1/faktury/podpowiedz?rodzaj=rozliczenie', undefined, { method: 'GET' }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ dzis: DZIS, wysylkaWstrzymana: expect.stringContaining('tymczasowo wstrzymana') });
    const kor = await podpowiedzRoute(request('/api/mobile/v1/faktury/podpowiedz?rodzaj=korekta', undefined, { method: 'GET' }));
    expect(await kor.json()).toMatchObject({ wysylkaWstrzymana: null });
    const zly = await podpowiedzRoute(request('/api/mobile/v1/faktury/podpowiedz?rodzaj=paragon', undefined, { method: 'GET' }));
    expect(zly.status).toBe(400);
  });
});

// ─── Korekta ──────────────────────────────────────────────────────────

describe('korekta z telefonu', () => {
  it('kontekst: faktura pierwotna, nabywca i pozycje „przed” z bazy', async () => {
    const response = await kontekstKorekty(PARENT);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      faktura: { id: PARENT, numer: 'FV/1/11/2026', numerKsef: `${TENANT_NIP}-20261110-0A1B2C3D4E5F-AB`, dataWystawienia: '2026-11-10', brutto: 1230 },
      nabywca: { nazwa: 'Klient Sp. z o.o.', nip: BUYER_NIP, vatUe: null, osoba: false, adres1: 'ul. Kliencka 3', adres2: '00-003 Warszawa' },
      dozwolone: 'all',
      poprzedniaKorekta: null,
      stawkaBezVat: null,
      npIiDozwolone: false,
      pozycje: [{ name: 'Projekt', unit: 'szt', quantity: 2, unitPriceNet: 500, vatRate: '23' }],
    });
  });

  it('korekta w toku blokuje kolejną: 422 invoice_change_refused ze zdaniem strony', async () => {
    invoices.push({ id: 'kor-1', tenant_id: ORG_A, parent_invoice_id: PARENT, invoice_kind: 'correction', ksef_status: 'queued', internal_number: 'KOR/0/11/2026' });
    const response = await kontekstKorekty(PARENT);
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe('invoice_change_refused');
  });

  it('korekta kwotowa: wyliczenie różnicy, szkic, potem „wyślij” innym kluczem z kopertą korekty', async () => {
    const w = await wylicz({ korekta: korekta() });
    expect(w.status).toBe(200);
    expect(await w.json()).toMatchObject({ netto: -100, vat: -23, brutto: -123 });

    const draft = await wystaw({ wyslij: false, korekta: korekta() });
    expect(draft.status).toBe(201);
    const id = ((await draft.json()) as { faktura: { id: string } }).faktura.id;
    expect(invoices.find((i) => i.id === id)).toMatchObject({ invoice_kind: 'correction', parent_invoice_id: PARENT, gross_total: -123 });
    expect(fake.enqueue).not.toHaveBeenCalled();
  });

  it('wyślij korektę „przed / po”: pozycje „przed” z bazy, nie z telefonu; kolejka z kopertą', async () => {
    const response = await wystaw({
      wyslij: true,
      korekta: korekta({ correctionType: 'before_after', amountChange: null, linesAfter: [{ name: 'Projekt', unit: 'szt', quantity: 1, unitPriceNet: 500, vatRate: '23' }] }),
    });
    expect(response.status).toBe(201);
    expect(((await response.json()) as { wysylka: unknown }).wysylka).toEqual({ zlecona: true, blad: null });
    expect(fake.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        auditKind: 'correction',
        tokenSession: { mfa: 'enrollment_required' },
        correctionData: expect.objectContaining({
          parentInvoiceId: PARENT,
          parentInvoiceNumber: 'FV/1/11/2026',
          linesBefore: [expect.objectContaining({ quantity: 2, unitPriceNet: 500 })],
        }),
      }),
    );
  });

  it('obca albo nieprzyjęta faktura: 422 bez zapisu; zły identyfikator: 404', async () => {
    invoices[0]!.ksef_status = 'rejected';
    const response = await wystaw({ wyslij: false, korekta: korekta() });
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe('invoice_change_refused');
    const zly = await kontekstKorekty('nie-uuid');
    expect(zly.status).toBe(404);
    expect(writes.filter((w) => w.table === 'invoices')).toEqual([]);
  });
});

// ─── Ponowienie, szkic, usunięcie ─────────────────────────────────────

/** Zwykła faktura z błędem wysyłki: zapisana przez POST /faktury (prawdziwe fa3_data), potem `failed`. */
async function nieudanaWysylka(): Promise<string> {
  const response = await wystaw({ wyslij: false, faktura: faktura() }, { key: KEY_2 });
  const id = ((await response.json()) as { faktura: { id: string } }).faktura.id;
  const row = invoices.find((i) => i.id === id)!;
  row.ksef_status = 'failed';
  row.last_error_code = null;
  writes.length = 0;
  return id;
}

describe('„Wyślij ponownie” i „Wróć do szkicu”', () => {
  it('ponowienie: kolejka w trybie ponowienia z 2FA z tokenu; drugie dotknięcie 200 bez drugiej wysyłki', async () => {
    const id = await nieudanaWysylka();
    const first = await ponow(id);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ faktura: { id, numer: 'FV/2/11/2026', ksefStatus: 'queued' } });
    expect(fake.enqueue).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: id, mode: { kind: 'requeue', actorUserId: USER_A }, tokenSession: { mfa: 'enrollment_required' } }));

    const again = await ponow(id);
    expect(again.status).toBe(200);
    expect(fake.enqueue).toHaveBeenCalledTimes(1);
  });

  it('ponowienie: księgowa 403 forbidden; odrzuconej nie (zdanie strony: wróć do szkicu); obca 404', async () => {
    const id = await nieudanaWysylka();
    const ksiegowa = await ponow(id, { token: TOKEN_KSIEGOWA });
    expect(ksiegowa.status).toBe(403);
    expect((await errorOf(ksiegowa)).code).toBe('forbidden');

    invoices.find((i) => i.id === id)!.ksef_status = 'rejected';
    const odrzucona = await ponow(id);
    expect(odrzucona.status).toBe(422);
    expect((await errorOf(odrzucona)).code).toBe('invoice_change_refused');

    const obca = await ponow('99999999-2222-4333-8444-000000000009');
    expect(obca.status).toBe(404);
    expect(fake.enqueue).not.toHaveBeenCalled();
  });

  it('wróć do szkicu: RPC z firmą i osobą z tokenu, potem szkic; drugie dotknięcie 200 bez RPC; księgowa 403', async () => {
    const id = await nieudanaWysylka();
    invoices.find((i) => i.id === id)!.ksef_status = 'rejected';
    const response = await doSzkicu(id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ faktura: { id, ksefStatus: 'draft' } });
    expect(resetCalls).toEqual([{ p_invoice_id: id, p_tenant_id: ORG_A, p_actor_user_id: USER_A }]);

    expect((await doSzkicu(id)).status).toBe(200);
    expect(resetCalls).toHaveLength(1);

    const ksiegowa = await doSzkicu(id, { token: TOKEN_KSIEGOWA });
    expect(ksiegowa.status).toBe(403);
  });
});

describe('usunięcie szkicu', () => {
  it('szkic: 200 i faktury nie ma; ponowienie 200; faktura po KSeF: 422 bez usunięcia', async () => {
    const draft = await wystaw({ wyslij: false, faktura: faktura() });
    const id = ((await draft.json()) as { faktura: { id: string } }).faktura.id;
    const first = await usun(id);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ usuniety: true });
    expect(invoices.some((i) => i.id === id)).toBe(false);
    expect(fake.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'invoice.draft_deleted', entityId: id, userId: USER_A }));

    expect((await usun(id)).status).toBe(200);

    const sent = await usun(PARENT);
    expect(sent.status).toBe(422);
    expect((await errorOf(sent)).code).toBe('invoice_change_refused');
    expect(invoices.some((i) => i.id === PARENT)).toBe(true);
  });
});

// ─── GUS ──────────────────────────────────────────────────────────────

describe('nabywca z GUS', () => {
  it('NIP spoza kontrahentów: GUS, zapis podpowiedzi w kontrahentach firmy', async () => {
    fake.gus.mockResolvedValue({
      kind: 'found',
      data: { nip: BUYER_NIP, name: 'Klient Sp. z o.o.', street: 'ul. Kliencka', buildingNumber: '3', localNumber: '', postalCode: '00-003', city: 'Warszawa' },
    });
    const response = await gus(BUYER_NIP);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ zrodlo: 'gus', nabywca: { nip: BUYER_NIP, nazwa: 'Klient Sp. z o.o.', adres1: 'ul. Kliencka 3', adres2: '00-003 Warszawa' } });
    expect(contractors).toEqual([expect.objectContaining({ tenant_id: ORG_A, nip: BUYER_NIP })]);

    // Drugie pytanie: z kontrahentów, bez GUS.
    const again = await gus(BUYER_NIP);
    expect(await again.json()).toMatchObject({ zrodlo: 'kontrahenci' });
    expect(fake.gus).toHaveBeenCalledTimes(1);
  });

  it('zły NIP 422 z polem, brak w GUS 404, GUS niedostępny 503 z Retry-After', async () => {
    const zly = await gus('1234567891');
    expect(await errorOf(zly)).toEqual({ code: 'invoice_invalid', message: 'Nieprawidłowa suma kontrolna NIP', field: 'buyerNip' });
    fake.gus.mockResolvedValueOnce({ kind: 'not-found' });
    expect((await gus(BUYER_NIP)).status).toBe(404);
    fake.gus.mockResolvedValueOnce({ kind: 'error', message: 'timeout' });
    const down = await gus(BUYER_NIP);
    expect(down.status).toBe(503);
    expect(down.headers.get('retry-after')).toBe('30');
    expect((await errorOf(down)).code).toBe('service_unavailable');
  });
});

// ─── Zwykła faktura: firma z UE i osoba z PESEL ───────────────────────

describe('zwykła faktura dla firmy z UE i osoby z PESEL (M8b)', () => {
  it('firma z UE ze stawką np II: 201, nabywca z numerem VAT-UE i krajem', async () => {
    const response = await wystaw({
      wyslij: false,
      faktura: faktura({
        buyerNip: '',
        buyerIsEu: true,
        buyerVatUe: 'DE123456789',
        buyerCountryCode: 'DE',
        buyerName: 'Kunde GmbH',
        buyerAddressLine1: 'Hauptstr. 1',
        buyerAddressLine2: '10115 Berlin',
        lines: [{ name: 'Usługa programistyczna', unit: 'szt', quantity: 1, unitPriceNet: 1000, vatRate: 'np_ii' }],
      }),
    });
    expect(response.status).toBe(201);
    const id = ((await response.json()) as { faktura: { id: string } }).faktura.id;
    expect(invoices.find((i) => i.id === id)?.buyer_data).toMatchObject({ vatUeNumber: 'DE123456789', address: expect.objectContaining({ countryCode: 'DE' }) });
  });

  it('np II bez nabywcy z UE i zły PESEL: 422 z polem, zdania strony', async () => {
    const npii = await wystaw({ wyslij: false, faktura: faktura({ lines: [{ name: 'Usługa', unit: 'szt', quantity: 1, unitPriceNet: 1, vatRate: 'np_ii' }] }) });
    expect(npii.status).toBe(422);
    expect((await errorOf(npii)).field).toMatch(/^lines\.0/);

    const pesel = await wystaw(
      { wyslij: false, faktura: faktura({ buyerNip: '', buyerIsConsumer: true, buyerConsumerIdType: 'pesel', buyerPesel: '44051401358', buyerName: 'Jan Kowalski' }) },
      { key: KEY_2 },
    );
    expect(await errorOf(pesel)).toEqual({ code: 'invoice_invalid', message: 'Nieprawidłowy PESEL (11 cyfr, suma kontrolna)', field: 'buyerPesel' });
  });

  it('osoba z PESEL: 201, PESEL w danych nabywcy (nie „bez numeru”)', async () => {
    const response = await wystaw({
      wyslij: false,
      faktura: faktura({ buyerNip: '', buyerIsConsumer: true, buyerConsumerIdType: 'pesel', buyerPesel: '44051401359', buyerName: 'Jan Kowalski' }),
    });
    expect(response.status).toBe(201);
    const id = ((await response.json()) as { faktura: { id: string } }).faktura.id;
    expect(JSON.stringify(invoices.find((i) => i.id === id)?.buyer_data)).toContain('44051401359');
  });
});

// ─── FA(3): prawdziwy generator i XSD MF na treści z telefonu ─────────

/**
 * Gotowe, gdy (zadanie M8b): korekta, zaliczka, rozliczenie i ponowna wysyłka
 * przechodzą KSeF TEST z telefonu albo test trasy z prawdziwym generatorem.
 * Tu to drugie: koperty, które trasy telefonu oddają kolejce KSeF (te same,
 * z których worker generuje XML), idą przez generator FA(3) i schemat XSD MF
 * (`validateFA3`, ten sam co `pnpm verify:fa3`). Rozliczenie: dane wysyłki
 * zapisane na szkicu (`special_data`), bo wysyłka ROZ jest wstrzymana.
 */
describe('FA(3) z treści telefonu: generator i XSD MF', () => {
  const xsdOk = async (xml: string) => expect((await validateFA3(xml)).errors ?? []).toEqual([]);

  it('zaliczka wysłana z telefonu: XML ZAL przechodzi XSD', async () => {
    await wystaw({ wyslij: true, zaliczka: zaliczka() });
    const call = fake.enqueue.mock.calls[0]![0] as { advanceData: AdvanceInvoiceData };
    await xsdOk(generateAdvanceInvoiceXml(call.advanceData));
  });

  it('korekta kwotowa z telefonu: XML KOR przechodzi XSD; druga korekta w toku: odmowa (K4)', async () => {
    expect((await wystaw({ wyslij: true, korekta: korekta() })).status).toBe(201);
    const druga = await wystaw({ wyslij: true, korekta: korekta({ internalNumber: 'KOR/2/11/2026' }) }, { key: KEY_2 });
    expect(druga.status).toBe(422);
    expect(fake.enqueue).toHaveBeenCalledTimes(1);
    await xsdOk(generateCorrectionInvoiceXml((fake.enqueue.mock.calls[0]![0] as { correctionData: CorrectionInvoiceData }).correctionData));
  });

  it('korekta „przed / po” z telefonu (bez korekty w toku): XML KOR przechodzi XSD', async () => {
    await wystaw({
      wyslij: true,
      korekta: korekta({ correctionType: 'before_after', amountChange: null, linesAfter: [{ name: 'Projekt', unit: 'szt', quantity: 1, unitPriceNet: 500, vatRate: '23' }] }),
    });
    const data = (fake.enqueue.mock.calls[0]![0] as { correctionData: CorrectionInvoiceData }).correctionData;
    expect(data.linesBefore).toEqual([expect.objectContaining({ quantity: 2 })]);
    await xsdOk(generateCorrectionInvoiceXml(data));
  });

  it('rozliczenie zapisane z telefonu: XML ROZ z danych szkicu przechodzi XSD', async () => {
    const draft = await wystaw({ wyslij: false, rozliczenie: rozliczenie() });
    const id = ((await draft.json()) as { faktura: { id: string } }).faktura.id;
    const special = invoices.find((i) => i.id === id)!.special_data as { finalData: FinalInvoiceData; finalAdvanceSettlementRows: AdvanceInvoiceSettlementRow[] };
    await xsdOk(generateFinalInvoiceXml(special.finalData, special.finalAdvanceSettlementRows));
  });

  it('„Wyślij ponownie” z telefonu: XML zwykłej faktury z kopii przechodzi XSD', async () => {
    const id = await nieudanaWysylka();
    await ponow(id);
    const call = fake.enqueue.mock.calls[0]![0] as { invoice: Invoice };
    await xsdOk(generateFA3Xml(call.invoice));
  });
});
