import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';
import type { Invoice } from '@/types/invoice';
import { sellerPartyFromSellerData } from '@/lib/invoices/map-buyer-party';

import { jsonb, memoryDb, type MemoryDb, type Row } from './helpers/ponowienie-specjalne-baza';

/**
 * Wyłącznik cen brutto (#884, `grossPricesEnabled`) na PEŁNYM runnerze wysyłki:
 * niezmiennik „bez drugiej wysyłki i bez zgubienia numeru KSeF”. Faktura
 * w cenach brutto wysłana, gdy wyłącznik był włączony, ma otwarty wpis
 * wysyłki (`sent`) albo zamiar; po wyłączeniu job uzgadnia ją po referencji
 * (`resolve-submission-intents`, `reconcile-previous-submission`), zanim
 * dojdzie do kroku wysyłki, w którym siedzi bramka wyłącznika
 * (`submitInvoiceFullFlow`). Bramka przed uzgodnieniem zostawiłaby fakturę
 * z błędem wysyłki, choć KSeF ją przyjął. Testy `ceny-brutto-wylacznik-job`
 * wołają `submitInvoiceFullFlow` i `submitToKsef` osobno, więc tej kolejności
 * nie widzą (uwaga 2 czytelnika #884, punkt „przed pierwszym włączeniem”).
 * Odmowę bez otwartej wysyłki sprawdza `ceny-brutto-wylacznik-job.test.ts`.
 *
 * Prawdziwy `runSubmitInvoice`, prawdziwa granica referencji i odczyt
 * wyłącznika przez `odmowaCenBrutto` (atrapa tylko wiersza flagi). Atrapy:
 * baza (projekcja kolumn jak PostgREST), HTTP KSeF (status po referencji,
 * faktury sesji), pełny przepływ wysyłki (POST) i dziennik wysyłek.
 */

const ID = '11111111-1111-4111-8111-111111111111';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';
const NIP = '5260001246';

const m = vi.hoisted(() => ({
  fullFlow: vi.fn(),
  findOpen: vi.fn(),
  status: vi.fn(),
  markSubmission: vi.fn(),
  updateStatus: vi.fn(),
  intents: vi.fn(),
  promote: vi.fn(),
  sessionInvoices: vi.fn(),
  /** Odczyty flag wyłączników (nazwa flagi); `grossPricesEnabled` zawsze wyłączona. */
  flagi: [] as string[],
  db: null as unknown as MemoryDb,
}));

vi.mock('@/lib/xml/invoice-calculator', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/xml/invoice-calculator')>(),
  validateNipChecksum: () => true,
}));
vi.mock('@/lib/feature-flags/global-flags', () => ({
  getGlobalFlagForExecution: async (flag: string) => {
    m.flagi.push(flag);
    return false;
  },
}));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: vi.fn() }));
vi.mock('@/lib/auth/ksef-verification-guard', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/auth/ksef-verification-guard')>(),
  requireKsefVerificationForBackgroundJob: async () => undefined,
}));
vi.mock('@/lib/ksef/health-check', () => ({ shouldUseOfflineMode: async () => ({ offline: false }) }));
vi.mock('@/lib/ksef/offline-queue', () => ({ addToOfflineQueue: vi.fn() }));
vi.mock('@/lib/ksef/submit-invoice-full', () => ({ submitInvoiceFullFlow: m.fullFlow }));
vi.mock('@/lib/ksef/submit', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/ksef/submit')>(),
  checkInvoiceStatusByReference: m.status,
  listSessionInvoicesAfterClose: m.sessionInvoices,
}));
vi.mock('@/lib/ksef/submission-log', () => ({
  findOpenKsefSubmissionIntents: m.intents,
  promoteKsefSubmissionIntent: m.promote,
  abandonKsefSubmissionIntent: vi.fn(),
  recordKsefSubmissionIntent: vi.fn(),
  findKsefSessionRow: vi.fn(async () => null),
  findSubmissionPayloads: vi.fn(async () => []),
  findTenantInvoiceByKsefNumber: vi.fn(async () => null),
  closeKsefAttempt: vi.fn(),
  markKsefSubmissionsNumberTaken: vi.fn(),
  recordKsefDuplicateCheck: vi.fn(),
  recordKsefAcceptedSession: vi.fn(),
  markKsefAttemptDuplicatePending: vi.fn(),
  recordKsefSubmissionSent: vi.fn(),
  markKsefSubmission: m.markSubmission,
  findOpenKsefSubmission: m.findOpen,
  findOwnKsefSessionXmlPath: vi.fn(async () => null),
  isOwnKsefSession: vi.fn(async () => false),
  findSessionReferenceForKsefNumber: vi.fn(async () => null),
}));
vi.mock('@/lib/jobs/runners/tenant-boundary', () => ({ requireInvoiceTenant: vi.fn(), assertJobIdentity: vi.fn() }));
vi.mock('@/lib/supabase/admin-queries', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/supabase/admin-queries')>(),
  getTenantKsefCredentials: async () => ({ type: 'token', nip: NIP, token: 't' }),
  updateInvoiceStatus: m.updateStatus,
}));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => m.db }));
vi.mock('@/lib/storage/xml-documents', () => ({ recordXmlDocument: vi.fn() }));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), addBreadcrumb: vi.fn() }));

import { runSubmitInvoice } from '@/lib/jobs/runners/submit-invoice';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';

const address = { countryCode: 'PL', addressLine1: 'ul. Przykładowa 1/2', addressLine2: '00-001 Warszawa' };
const seller = { nip: NIP, name: 'ACME Software sp. z o.o.', address };
/** Przypadek z rejestru (RP-FA-BRUTTO-01): trzy pozycje po 1,00 zł brutto przy 23 %. */
const fakturaWCenachBrutto: Invoice = finalizeInvoice({
  internalNumber: 'FV 2026/11/001',
  type: 'VAT',
  issueDate: '2026-11-17',
  seller,
  buyer: { nip: '5252241585', name: 'Klient sp. z o.o.', address: { countryCode: 'PL', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa' } },
  payment: { currency: 'PLN', dueDate: '2026-12-01', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
  pricesGross: true,
  lines: ['Kawa', 'Herbata', 'Woda'].map((name, i) => ({ ordinal: i + 1, name, unit: 'szt.', quantity: 1, unitPriceNet: 0, unitPriceGross: 1, vatRate: '23' as const })),
});

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};
const event = (extra: Record<string, unknown> = {}) => jsonb({
  invoiceId: ID, tenantId: TENANT, nip: NIP, environment: 'test' as const, sendAttemptId: ATTEMPT,
  invoice: fakturaWCenachBrutto,
  ...extra,
});
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const sentRow = (attemptedAt: string) => ({ sessionReferenceNumber: 'SES-1', invoiceReferenceNumber: 'REF-1', attemptedAt });
const odczytyCenBrutto = () => m.flagi.filter((f) => f === 'grossPricesEnabled');

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  m.flagi = [];
  m.fullFlow.mockRejectedValue(new Error('POST do KSeF nie może się zdarzyć: faktura ma otwartą wysyłkę'));
  m.findOpen.mockResolvedValue(null);
  m.intents.mockResolvedValue([]);
  m.promote.mockResolvedValue(false);
  m.sessionInvoices.mockResolvedValue([]);
  const invoice: Row = jsonb({
    id: ID, tenant_id: TENANT, direction: 'outgoing',
    // Ponowiona (cron cyklu życia, operator albo „Wyślij ponownie” sprzed wyłączenia):
    // była failed po wysyłce, która mogła dojść do KSeF.
    ksef_status: 'queued', ksef_number: null, ksef_environment: null,
    invoice_kind: 'regular', invoice_type: 'VAT', internal_number: 'FV 2026/11/001', issue_date: '2026-11-17',
    parent_invoice_id: null, advance_invoice_ids: [],
    fa3_data: fakturaWCenachBrutto, seller_nip: NIP, seller_data: sellerPartyFromSellerData(seller), special_data: null,
  });
  m.db = memoryDb(
    { invoices: [invoice], tenants: [{ id: TENANT, nip: NIP, name: seller.name, address_json: address }] },
    (fn) => ({ data: fn === 'ksef_has_contact_evidence' ? true : '2026-11-17T12:00:00.000000+00:00', error: null }),
  );
});
afterEach(() => vi.unstubAllEnvs());

describe('wyłącznik cen brutto na pełnym runnerze: najpierw uzgodnienie, bez drugiej wysyłki', () => {
  it('pełne zdarzenie z otwartym wpisem sent przy wyłączonym: uzgodnione po referencji, przyjęta z numerem KSeF, bez POST i bez odczytu wyłącznika', async () => {
    m.findOpen.mockResolvedValue(sentRow(hoursAgo(1)));
    m.status.mockResolvedValue({ state: 'accepted', ksefNumber: 'K-BRUTTO', acquisitionTimestamp: '2026-11-17T10:00:00Z' });

    await expect(runSubmitInvoice(event(), ctx)).resolves.toMatchObject({ success: true, ksefNumber: 'K-BRUTTO' });

    expect(m.status).toHaveBeenCalledTimes(1);
    expect(m.updateStatus).toHaveBeenCalledWith(ID, expect.objectContaining({ ksef_status: 'accepted', ksef_number: 'K-BRUTTO' }), TENANT);
    expect(m.fullFlow).not.toHaveBeenCalled();
    expect(odczytyCenBrutto()).toEqual([]);
  });

  it('„Tylko uzgodnij” z otwartym wpisem sent przy wyłączonym: to samo', async () => {
    m.findOpen.mockResolvedValue(sentRow(hoursAgo(5)));
    m.status.mockResolvedValue({ state: 'accepted', ksefNumber: 'K-UZG', acquisitionTimestamp: '2026-11-17T10:00:00Z' });

    await expect(runSubmitInvoice(event({ reconcileOnly: true }), ctx)).resolves.toMatchObject({ success: true, ksefNumber: 'K-UZG' });

    expect(m.updateStatus).toHaveBeenCalledWith(ID, expect.objectContaining({ ksef_status: 'accepted', ksef_number: 'K-UZG' }), TENANT);
    expect(m.fullFlow).not.toHaveBeenCalled();
    expect(odczytyCenBrutto()).toEqual([]);
  });

  it('otwarty zamiar wysyłki (intent) przy wyłączonym: zamiar rozstrzygnięty, uzgodnione, bez POST i bez odczytu wyłącznika', async () => {
    m.intents.mockResolvedValue([{ sessionReferenceNumber: 'SES-I', payloadHash: null, attemptedAt: hoursAgo(1) }]);
    m.sessionInvoices.mockResolvedValue([{ referenceNumber: 'REF-I', invoiceNumber: 'FV 2026/11/001', invoiceHash: 'x', statusCode: 200 }]);
    m.promote.mockImplementation(async () => {
      m.findOpen.mockResolvedValue({ sessionReferenceNumber: 'SES-I', invoiceReferenceNumber: 'REF-I', attemptedAt: hoursAgo(1) });
      return true;
    });
    m.status.mockResolvedValue({ state: 'accepted', ksefNumber: 'K-INT', acquisitionTimestamp: '2026-11-17T10:00:00Z' });

    await expect(runSubmitInvoice(event(), ctx)).resolves.toMatchObject({ success: true, ksefNumber: 'K-INT' });

    expect(m.promote).toHaveBeenCalledWith(expect.objectContaining({ invoiceReferenceNumber: 'REF-I' }));
    expect(m.fullFlow).not.toHaveBeenCalled();
    expect(odczytyCenBrutto()).toEqual([]);
  });
});
