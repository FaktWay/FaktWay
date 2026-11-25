import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';
import type { Invoice } from '@/types/invoice';

/**
 * WYS-01 (nocny zespół, 18.11.2026): KSeF przyjął plik faktury (POST zwrócił
 * numer referencyjny, wpis `sent` jest zapisany), a ODCZYT statusu tej
 * faktury dał błąd klienta HTTP (400, 404, …). Decyzję o treści KSeF podaje
 * w samym statusie (kod 400–499, `KsefInvoiceRejectedError`); błąd żądania
 * o status nią nie jest. Mimo to runner robił z niego
 * `NonRetriableError('KSeF odrzucił fakturę (HTTP 400)')`, a klasyfikator
 * `KSEF_REJECTED`: faktura kończyła jako `rejected` z mailem „odrzucona”,
 * choć KSeF mógł ją przyjąć. Powrót do szkicu blokował dowód kontaktu,
 * a uzgodnienie robił dopiero cron po 48 h (I5).
 *
 * To samo w dwóch innych odczytach stanu wysyłki: status po numerze
 * referencyjnym przy uzgadnianiu (wpis `sent`) i faktury sesji przy
 * rozstrzyganiu zamiaru (`intent`). 4xx z odczytu po wyczerpaniu prób dawało
 * `KSEF_REJECTED`, a ma być wynik niepewny (`RESULT_UNCERTAIN`, „do
 * uzgodnienia”), z prawdziwym statusem HTTP w łańcuchu przyczyn (dziennik prób).
 *
 * Prawdziwe: runner, `submitInvoiceFullFlow`, `submitInvoice`, generator FA(3),
 * `submission-log`, klasyfikator, obsługa po wyczerpaniu prób. Atrapy: HTTP do
 * KSeF (sesje, pliki, statusy) i baza w pamięci. NIP-y fikcyjne.
 */

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';
const NUMBER = 'FV 2026/11/001';

type Row = Record<string, unknown>;
type StoredInvoice = { referenceNumber: string; invoiceNumber: string; invoiceHash: string; ksefNumber: string };

const m = vi.hoisted(() => ({
  db: { ksef_submissions: [] as Row[] },
  ksef: {
    sessions: new Map<string, { open: boolean; invoices: StoredInvoice[] }>(),
    invoicePosts: 0,
    seq: 0,
    /** Odczyt statusu przyjętego pliku kończy się tym błędem HTTP (null: zwykła odpowiedź). */
    statusError: null as null | { status: number; body: unknown },
    /** Odczyt statusu kończy się 503 (KSeF chwilowo niedostępny). */
    statusUnavailable: false,
    /** Kod w treści statusu faktury (200 przyjęta, 450 odrzucona w statusie). */
    statusCode: 200,
    /** KSeF przyjmuje plik, ale odpowiedź na POST nie dociera (nasz timeout 408): zostaje zamiar `intent`. */
    loseInvoicePostResponse: false,
    /** Odczyt faktur sesji (rozstrzyganie zamiaru) kończy się tym błędem HTTP. */
    listError: null as null | { status: number; body: unknown },
  },
  invoiceUpdates: [] as Row[],
  updateStatus: vi.fn(),
  upload: vi.fn(),
}));

vi.mock('@/lib/ksef/client', async (orig) => {
  const real = await orig<typeof import('@/lib/ksef/client')>();
  const { KsefApiError } = real;
  const k = m.ksef;
  return {
    ...real,
    ksefFetch: async (path: string, opts: { method?: string; body?: { encryptedInvoiceContent?: string; invoiceHash?: string } } = {}) => {
      const method = opts.method ?? 'GET';
      const route = path.split('?')[0]!;
      if (route === '/sessions/online' && method === 'POST') {
        k.seq += 1;
        const ref = `S-${k.seq}`;
        k.sessions.set(ref, { open: true, invoices: [] });
        return { referenceNumber: ref };
      }
      let hit = /^\/sessions\/online\/([^/]+)\/invoices$/.exec(route);
      if (hit && method === 'POST') {
        k.invoicePosts += 1;
        const session = k.sessions.get(hit[1]!);
        if (!session?.open) throw new KsefApiError(400, 'Sesja zamknięta', 'Sesja zamknięta');
        const xml = String(opts.body?.encryptedInvoiceContent ?? '');
        k.seq += 1;
        const stored: StoredInvoice = {
          referenceNumber: `I-${k.seq}`,
          invoiceNumber: /<P_2>([^<]*)<\/P_2>/.exec(xml)?.[1] ?? '',
          invoiceHash: String(opts.body?.invoiceHash),
          ksefNumber: `K-${k.seq}`,
        };
        session.invoices.push(stored);
        if (k.loseInvoicePostResponse) throw new KsefApiError(408, 'Request timeout', 'timeout');
        return { referenceNumber: stored.referenceNumber };
      }
      hit = /^\/sessions\/online\/([^/]+)\/close$/.exec(route);
      if (hit && method === 'POST') {
        const session = k.sessions.get(hit[1]!);
        if (session) session.open = false;
        return {};
      }
      hit = /^\/sessions\/([^/]+)\/invoices$/.exec(route);
      if (hit && method === 'GET') {
        if (k.listError) {
          throw new KsefApiError(k.listError.status, k.listError.body as never, `KSeF API GET ${route} failed: ${k.listError.status}`);
        }
        const session = k.sessions.get(decodeURIComponent(hit[1]!));
        return {
          continuationToken: null,
          invoices: (session?.invoices ?? []).map((inv, n) => ({
            ordinalNumber: n + 1, invoicingDate: '2026-11-18T09:00:00Z', invoiceNumber: inv.invoiceNumber,
            referenceNumber: inv.referenceNumber, invoiceHash: inv.invoiceHash, ksefNumber: inv.ksefNumber,
            status: { code: 200, description: 'Sukces' },
          })),
        };
      }
      hit = /^\/sessions\/([^/]+)\/invoices\/([^/]+)$/.exec(route);
      if (hit && method === 'GET') {
        if (k.statusUnavailable) throw new KsefApiError(503, 'Service Unavailable', 'KSeF niedostępny');
        if (k.statusError) {
          throw new KsefApiError(k.statusError.status, k.statusError.body as never, `KSeF API GET ${route} failed: ${k.statusError.status}`);
        }
        const inv = k.sessions.get(decodeURIComponent(hit[1]!))?.invoices.find((i) => i.referenceNumber === decodeURIComponent(hit![2]!));
        if (!inv) throw new KsefApiError(404, 'Not found', 'Brak faktury');
        if (k.statusCode !== 200) {
          return { referenceNumber: inv.referenceNumber, invoiceHash: inv.invoiceHash,
            status: { code: k.statusCode, description: 'Błąd weryfikacji semantyki dokumentu faktury' } };
        }
        return {
          referenceNumber: inv.referenceNumber,
          invoiceHash: inv.invoiceHash,
          ksefNumber: inv.ksefNumber,
          acquisitionTimestamp: '2026-11-18T09:00:00Z',
          status: { code: 200, description: 'Sukces' },
        };
      }
      throw new Error(`Nieobsłużone żądanie KSeF w teście: ${method} ${path}`);
    },
  };
});
vi.mock('@/lib/ksef/encryption', () => ({
  generateSessionEncryption: async () => ({ encryptedSymmetricKey: 'k', initializationVector: 'iv' }),
  // „Szyfrowanie” zostawia XML jawny, żeby atrapa KSeF odczytała numer faktury (P_2).
  encryptInvoiceXml: (xml: string) => ({
    invoiceHash: createHash('sha256').update(xml).digest('base64'),
    invoiceSize: xml.length,
    encryptedInvoiceHash: 'eh',
    encryptedInvoiceSize: xml.length,
    encryptedInvoiceContent: xml,
  }),
}));
vi.mock('@/lib/ksef/session-cache', () => ({
  ksefSessionCache: { getSession: async () => ({ accessToken: 'token' }), invalidate: vi.fn() },
}));
vi.mock('@/lib/ksef/rate-limiter', () => ({
  ksefRateLimiter: { enqueue: (_nip: string, fn: () => unknown) => fn() },
}));

// Baza w pamięci dla `ksef_submissions` (klient serwisowy z `@/lib/supabase/admin`).
vi.mock('@/lib/supabase/admin', () => {
  function from(table: string) {
    const rows = (m.db as Record<string, Row[]>)[table] ??= [];
    const filters: Array<(r: Row) => boolean> = [];
    let op: 'select' | 'insert' | 'update' = 'select';
    let payload: Row = {};
    let order: { key: string; ascending: boolean } | null = null;
    let limit: number | null = null;
    const exec = () => {
      if (op === 'insert') {
        rows.push({ id: `row-${rows.length + 1}`, attempted_at: new Date(Date.now() + rows.length).toISOString(), ...payload });
        return { data: null, error: null };
      }
      let hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === 'update') {
        hit.forEach((r) => Object.assign(r, payload));
        return { data: hit, error: null };
      }
      if (order) {
        const { key, ascending } = order;
        hit = [...hit].sort((a, b) => String(a[key]).localeCompare(String(b[key])) * (ascending ? 1 : -1));
      }
      if (limit !== null) hit = hit.slice(0, limit);
      return { data: hit, error: null };
    };
    const q = {
      select: () => q,
      insert: (p: Row) => { op = 'insert'; payload = p; return q; },
      update: (p: Row) => { op = 'update'; payload = p; return q; },
      eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
      in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return q; },
      is: (k: string, v: unknown) => { filters.push((r) => (r[k] ?? null) === v); return q; },
      not: (k: string, _op: string, v: unknown) => { filters.push((r) => (r[k] ?? null) !== v); return q; },
      order: (key: string, o?: { ascending?: boolean }) => { order = { key, ascending: o?.ascending ?? true }; return q; },
      limit: (n: number) => { limit = n; return q; },
      maybeSingle: async () => { const r = exec(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; },
      single: async () => { const r = exec(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; },
      then: <A, B>(ok: (v: ReturnType<typeof exec>) => A, fail?: (e: unknown) => B) => Promise.resolve(exec()).then(ok, fail),
    };
    return q;
  }
  return { createAdminClient: () => ({ from }) };
});

vi.mock('@/lib/storage/r2-client', () => ({ getR2Config: () => ({ bucketName: 'b' }), getR2Client: () => ({ send: vi.fn() }) }));
vi.mock('@/lib/storage/r2', async (orig) => ({
  ...await orig<typeof import('@/lib/storage/r2')>(),
  uploadInvoiceXml: m.upload,
}));
vi.mock('@/lib/auth/ksef-verification-guard', () => ({
  requireKsefVerificationForBackgroundJob: vi.fn(async () => undefined),
  KsefNotVerifiedError: class KsefNotVerifiedError extends Error {},
}));
vi.mock('@/lib/ksef/xml-generated-at', () => ({ claimXmlGeneratedAt: async () => new Date('2026-11-18T09:00:00.000Z') }));
vi.mock('@/lib/xml/validator', () => ({ validateInvoiceXml: async () => ({ valid: true, errors: [] }), InvoiceXmlSchemaError: class extends Error {} }));
vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlagForExecution: async () => false }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: vi.fn() }));
vi.mock('@/lib/ksef/health-check', () => ({ shouldUseOfflineMode: async () => ({ offline: false }) }));
vi.mock('@/lib/ksef/health-status', () => ({ isKsefHealthy: async () => true }));
vi.mock('@/lib/ksef/offline-queue', () => ({ addToOfflineQueue: vi.fn() }));
vi.mock('@/lib/ksef/submit-reference-boundary', () => ({ assertSubmitReferences: async () => 'regular' }));
vi.mock('@/lib/jobs/runners/tenant-boundary', () => ({ requireInvoiceTenant: vi.fn(), assertJobIdentity: vi.fn() }));
vi.mock('@/lib/supabase/admin-queries', async (orig) => ({
  ...await orig<typeof import('@/lib/supabase/admin-queries')>(),
  getTenantKsefCredentials: async () => ({ type: 'token', nip: '1234563218', token: 't' }),
  updateInvoiceStatus: m.updateStatus,
}));
// Wiersz faktury i przejęcie wysyłki (00124) — runner czyta je klientem z `@/lib/supabase/server`;
// zapisy wiersza faktury (np. wynik po wyczerpaniu prób) trafiają do `m.invoiceUpdates`.
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: async () => {
    const q = {
      select: () => q, eq: () => q, in: () => q, or: () => q,
      update: (p: Row) => { m.invoiceUpdates.push(p); return q; },
      maybeSingle: async () => ({
        data: { id: ID, direction: 'outgoing', ksef_status: 'sending', ksef_number: null, ksef_environment: 'test',
          invoice_type: 'VAT', invoice_kind: 'regular', internal_number: NUMBER, fa3_data: {} },
        error: null,
      }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
    };
    return {
      from: () => q,
      rpc: async (fn: string) => fn === 'ksef_has_contact_evidence'
        // Jak 00136: intent, sent, accepted, duplicate są dowodem kontaktu.
        ? { data: m.db.ksef_submissions.some((r) => ['intent', 'sent', 'accepted', 'duplicate'].includes(String(r.status))), error: null }
        : { data: '2026-11-18T09:00:00.000000+00:00', error: null },
    };
  },
}));
vi.mock('@/lib/storage/xml-documents', () => ({ recordXmlDocument: vi.fn() }));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), addBreadcrumb: vi.fn() }));

import { KsefApiError } from '@/lib/ksef/client';
import { RetryAfterError } from '@/lib/jobs/errors';
import { classifySendError, SEND_ERROR_CODES } from '@/lib/ksef/send-error-codes';
import { onSubmitInvoiceExhausted } from '@/lib/jobs/runners/submit-invoice/exhausted';
import { runSubmitInvoice } from '@/lib/jobs/runners/submit-invoice';
import { invoiceXmlKeyFor } from '@/lib/storage/r2';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';

const faktura = () => finalizeInvoice({
  internalNumber: NUMBER,
  type: 'VAT',
  issueDate: '2026-11-18',
  saleDate: '2026-11-18',
  seller: { nip: '1234563218', name: 'Firma Testowa', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } },
  buyer: { nip: '1111111111', name: 'Nabywca Testowy', address: { countryCode: 'PL', addressLine1: 'ul. Próbna 2', addressLine2: '00-002 Warszawa' } },
  lines: [{ ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
  payment: { currency: 'PLN', dueDate: '2026-12-02', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
});

const event = () => ({
  invoiceId: ID, tenantId: T, nip: '1234563218', environment: 'test' as const,
  invoice: faktura() as Invoice, sendAttemptId: ATTEMPT,
});

const ctx = (attempt: number): JobContext => ({
  attempt,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
});

const accepted = () => m.updateStatus.mock.calls.find(([, patch]) => (patch as Row).ksef_status === 'accepted')?.[1] as Row | undefined;
/** Pierwszy `KsefApiError` w łańcuchu przyczyn: z niego dziennik prób bierze status HTTP. */
const httpErrorIn = (error: unknown): KsefApiError | null => {
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 8; e = (e as { cause?: unknown }).cause, depth += 1) {
    if (e instanceof KsefApiError) return e;
  }
  return null;
};
const submissions = () => m.db.ksef_submissions;

/** 400 z kodem 21184 „Sesja tymczasowo niedostępna” (KSeF API 2.8.0) i inne błędy klienta HTTP odczytu statusu. */
const STATUS_ERRORS: Array<[string, { status: number; body: unknown }]> = [
  ['HTTP 400, kod 21184 (sesja tymczasowo niedostępna)', {
    status: 400,
    body: { title: 'Bad Request', status: 400, errors: [{ code: 21184, description: 'Sesja tymczasowo niedostępna.' }] },
  }],
  ['HTTP 400 bez kodu', { status: 400, body: 'Bad Request' }],
  ['HTTP 404', { status: 404, body: 'Not Found' }],
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  m.db.ksef_submissions = [];
  m.invoiceUpdates = [];
  Object.assign(m.ksef, {
    sessions: new Map(), invoicePosts: 0, seq: 0, statusError: null, statusUnavailable: false, statusCode: 200,
    loseInvoicePostResponse: false, listError: null,
  });
  m.upload.mockImplementation(async (_t: string, _i: string, _d: string, _xml: string, o?: { attemptId?: string | null }) => ({
    storagePath: invoiceXmlKeyFor({ tenantId: T, invoiceId: ID, issueDate: '2026-11-18', attemptId: o?.attemptId }),
    sha256Hash: 'a'.repeat(64), sizeBytes: 10, etag: '"e"',
  }));
});
afterEach(() => vi.unstubAllEnvs());

describe('WYS-01: błąd klienta HTTP przy odczycie statusu przyjętego pliku to nie odrzucenie faktury', () => {
  it.each(STATUS_ERRORS)('%s po przyjęciu pliku → ponowienie, nie „KSeF odrzucił fakturę”; druga próba uzgadnia bez drugiego POST', async (_label, statusError) => {
    m.ksef.statusError = statusError;
    const first = await runSubmitInvoice(event(), ctx(0)).then(() => null, (e: unknown) => e);

    // KSeF ma plik (wpis `sent` z numerami), a wynik pierwszej próby nie jest decyzją o treści.
    expect(m.ksef.invoicePosts).toBe(1);
    expect(submissions()).toEqual([expect.objectContaining({ status: 'sent', session_reference_number: 'S-1', invoice_reference_number: 'I-2' })]);
    expect(first).toBeInstanceOf(RetryAfterError);
    expect(classifySendError(first)).toEqual({ code: SEND_ERROR_CODES.RESULT_UNCERTAIN, class: 'reconcile' });
    expect((first as Error).message).toContain(`HTTP ${statusError.status}`);
    expect(httpErrorIn(first)?.status).toBe(statusError.status);

    // Druga próba: status czytelny, uzgodnienie po numerze referencyjnym — ten sam plik, bez drugiego POST.
    m.ksef.statusError = null;
    await runSubmitInvoice(event(), ctx(1));
    expect(m.ksef.invoicePosts).toBe(1);
    expect(accepted()).toMatchObject({ ksef_status: 'accepted', ksef_number: 'K-2' });
  });

  it.each(STATUS_ERRORS)('uzgadnianie po numerze referencyjnym: %s aż do końca prób → „do uzgodnienia” (RESULT_UNCERTAIN), nie `rejected`', async (_label, statusError) => {
    // Pierwsza próba: plik przyjęty, odczyt statusu 503 — wpis `sent` zostaje, ponowienie.
    m.ksef.statusUnavailable = true;
    await expect(runSubmitInvoice(event(), ctx(0))).rejects.toBeInstanceOf(RetryAfterError);
    expect(submissions()).toEqual([expect.objectContaining({ status: 'sent', invoice_reference_number: 'I-2' })]);

    // Kolejna próba uzgadnia tamtą wysyłkę, a odczyt statusu daje błąd klienta HTTP.
    m.ksef.statusUnavailable = false;
    m.ksef.statusError = statusError;
    const last = await runSubmitInvoice(event(), ctx(5)).then(() => null, (e: unknown) => e);
    expect(m.ksef.invoicePosts).toBe(1);
    expect(last).toBeInstanceOf(RetryAfterError);
    expect(classifySendError(last)).toEqual({ code: SEND_ERROR_CODES.RESULT_UNCERTAIN, class: 'reconcile' });
    expect(httpErrorIn(last)?.status).toBe(statusError.status);

    // Po wyczerpaniu prób z tym błędem faktura czeka na uzgodnienie, nie jest „odrzucona”.
    await onSubmitInvoiceExhausted(last as Error, event(), ctx(5));
    const outcome = m.invoiceUpdates.find((p) => 'last_error_code' in p);
    expect(outcome).toMatchObject({ ksef_status: 'failed', last_error_code: SEND_ERROR_CODES.RESULT_UNCERTAIN });
    expect(m.invoiceUpdates.some((p) => p.ksef_status === 'rejected')).toBe(false);
  });

  it.each(STATUS_ERRORS)('rozstrzyganie zamiaru wysyłki: %s przy odczycie faktur sesji → „do uzgodnienia”, nie `rejected`, bez drugiego POST', async (_label, statusError) => {
    // Pierwsza próba: KSeF przyjął plik, ale odpowiedź na POST zginęła — zostaje zamiar `intent`.
    m.ksef.loseInvoicePostResponse = true;
    await expect(runSubmitInvoice(event(), ctx(0))).rejects.toBeInstanceOf(RetryAfterError);
    expect(submissions()).toEqual([expect.objectContaining({ status: 'intent', session_reference_number: 'S-1' })]);

    // Kolejna próba rozstrzyga zamiar, a odczyt faktur sesji daje błąd klienta HTTP.
    m.ksef.loseInvoicePostResponse = false;
    m.ksef.listError = statusError;
    const last = await runSubmitInvoice(event(), ctx(5)).then(() => null, (e: unknown) => e);
    expect(m.ksef.invoicePosts).toBe(1);
    expect(last).toBeInstanceOf(RetryAfterError);
    expect(classifySendError(last)).toEqual({ code: SEND_ERROR_CODES.RESULT_UNCERTAIN, class: 'reconcile' });
    expect(httpErrorIn(last)?.status).toBe(statusError.status);

    await onSubmitInvoiceExhausted(last as Error, event(), ctx(5));
    const outcome = m.invoiceUpdates.find((p) => 'last_error_code' in p);
    expect(outcome).toMatchObject({ ksef_status: 'failed', last_error_code: SEND_ERROR_CODES.RESULT_UNCERTAIN });
    expect(m.invoiceUpdates.some((p) => p.ksef_status === 'rejected')).toBe(false);

    // Gdy odczyt wróci, ponowienie znajduje plik w sesji i uzgadnia go: dalej jeden POST.
    m.ksef.listError = null;
    await runSubmitInvoice(event(), ctx(1));
    expect(m.ksef.invoicePosts).toBe(1);
    expect(accepted()).toMatchObject({ ksef_status: 'accepted', ksef_number: 'K-2' });
  });

  it('odrzucenie w STATUSIE (kod 450 w treści odpowiedzi) nadal kończy jako odrzucenie treści', async () => {
    // Kontrola granicy: zmiana dotyczy tylko błędu żądania o status, nie decyzji KSeF o treści.
    m.ksef.statusCode = 450;
    const err = await runSubmitInvoice(event(), ctx(0)).then(() => null, (e: unknown) => e);
    expect(m.ksef.invoicePosts).toBe(1);
    expect((err as Error | null)?.name).toBe('NonRetriableError');
    expect(classifySendError(err)).toEqual({ code: SEND_ERROR_CODES.KSEF_REJECTED, class: 'terminal' });
  });
});
