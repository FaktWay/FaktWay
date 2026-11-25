import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NonRetriableError, RetryAfterError } from '@/lib/jobs/errors';
import type { JobContext } from '@/lib/jobs/registry';
import type { Invoice } from '@/types/invoice';

/**
 * U3 z obchodu aplikacji 20.11.2026: faktura, która nie przechodzi lokalnej
 * walidacji XSD FA(3), dostawała w `last_error` surowy tekst workera
 * („NonRetriableError: Faktura nie przeszła walidacji schematu FA(3): Linia 1:
 * Schemas validity error : Element '{http://crd.gov.pl/…}NIP': [facet
 * 'pattern'] …”), a `last_error_field` i `last_error_suggestion` były puste.
 * Stronę i telefon czyta ta sama kolumna, więc obie pokazywały nazwę klasy
 * błędu i komunikat libxml.
 *
 * Test idzie prawdziwą ścieżką: `runSubmitInvoice` (prawdziwy generator FA(3),
 * prawdziwy walidator XSD, prawdziwa klasyfikacja) i `onSubmitInvoiceExhausted`.
 * Mocki tylko dla bazy, magazynu plików i KSeF.
 *
 * Klient dostaje zdanie z nazwą pola i podpowiedzią; pełny tekst techniczny
 * zostaje dla operatora (błąd joba, log workera, audyt `invoice.submit_failed`),
 * a ponawianie i klasyfikacja nie zmieniają się.
 */

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';

const m = vi.hoisted(() => ({
  upload: vi.fn(),
  submit: vi.fn(),
  audit: vi.fn(),
  sendEvent: vi.fn(),
  invoiceUpdate: vi.fn(),
  captureMessage: vi.fn(),
  /** Wywołanie `submitInvoiceFullFlow`: domyślnie prawdziwe (ustawia fabryka mocka). */
  fullFlow: vi.fn(),
  invoice: {} as Record<string, unknown>,
}));

vi.mock('@/lib/storage/r2-client', () => ({ getR2Config: () => ({ bucketName: 'b' }), getR2Client: () => ({ send: vi.fn() }) }));
vi.mock('@/lib/storage/r2', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/storage/r2')>(),
  uploadInvoiceXml: m.upload,
}));
vi.mock('@/lib/storage/xml-documents', () => ({ recordXmlDocument: vi.fn() }));
vi.mock('@/lib/auth/ksef-verification-guard', () => ({
  requireKsefVerificationForBackgroundJob: vi.fn(async () => undefined),
  KsefNotVerifiedError: class KsefNotVerifiedError extends Error {},
}));
vi.mock('@/lib/ksef/submit', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/ksef/submit')>(),
  submitInvoice: m.submit,
}));
vi.mock('@/lib/ksef/submission-log', () => ({
  findOpenKsefSubmissionIntents: vi.fn(async () => []),
  promoteKsefSubmissionIntent: vi.fn(async () => false),
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
  markKsefSubmission: vi.fn(),
  findOpenKsefSubmission: vi.fn(async () => null),
  findOwnKsefSessionXmlPath: vi.fn(async () => null),
  isOwnKsefSession: vi.fn(async () => true),
  findSessionReferenceForKsefNumber: vi.fn(async () => null),
  findKsefNumberTaken: vi.fn(async () => null),
}));
vi.mock('@/lib/ksef/xml-generated-at', () => ({ claimXmlGeneratedAt: async () => new Date('2026-10-01T10:00:00.000Z') }));
// Walidator XSD zostaje PRAWDZIWY (xmllint-wasm): o to w tym teście chodzi.
vi.mock('@/lib/ksef/submit-invoice-full', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ksef/submit-invoice-full')>();
  m.fullFlow.mockImplementation(actual.submitInvoiceFullFlow);
  return { ...actual, submitInvoiceFullFlow: (...args: Parameters<typeof actual.submitInvoiceFullFlow>) => m.fullFlow(...args) };
});
vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlagForExecution: async () => false }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: m.audit }));
vi.mock('@/lib/ksef/health-check', () => ({ shouldUseOfflineMode: async () => ({ offline: false }) }));
vi.mock('@/lib/ksef/offline-queue', () => ({ addToOfflineQueue: vi.fn() }));
vi.mock('@/lib/ksef/submit-reference-boundary', () => ({ assertSubmitReferences: async () => 'regular' }));
vi.mock('@/lib/jobs/runners/tenant-boundary', () => ({ requireInvoiceTenant: vi.fn(), assertJobIdentity: vi.fn() }));
vi.mock('@/lib/supabase/admin-queries', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/supabase/admin-queries')>(),
  getTenantKsefCredentials: async () => ({ type: 'token', nip: '1234567890', token: 't' }),
  updateInvoiceStatus: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: async () => {
    let patch: Record<string, unknown> | null = null;
    const q = {
      select: () => q,
      eq: () => q,
      in: () => q,
      or: () => q,
      update: (p: Record<string, unknown>) => {
        patch = p;
        m.invoiceUpdate(p);
        return q;
      },
      maybeSingle: async () => ({ data: patch ? { id: ID } : { ...m.invoice }, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
    };
    return { from: () => q, rpc: async () => ({ data: '2026-10-03T12:00:00.000000+00:00', error: null }) };
  },
}));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: m.captureMessage, addBreadcrumb: vi.fn() }));

import { onSubmitInvoiceExhausted, runSubmitInvoice } from '@/lib/jobs/runners/submit-invoice';
import { classifySendError } from '@/lib/ksef/send-error-codes';
import { InvoiceValidationError } from '@/lib/xml/fa3-generator';
import { InvoiceXmlSchemaError } from '@/lib/xml/validator';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';
import { fakturaZBazy } from '../../mobile/src/lib/dane/mapowanie';

const adres = (l1: string, l2: string) => ({ countryCode: 'PL', addressLine1: l1, addressLine2: l2 });

/**
 * NIP `1000000012` ma poprawną sumę kontrolną (lokalna walidacja go przepuszcza),
 * ale schemat FA(3) odrzuca go wzorcem: drugi i trzeci znak nie mogą być oba zerami.
 * Dokładnie ten przypadek wyszedł w obchodzie telefonu.
 */
const NIP_Z_BLEDEM_XSD = '1000000012';

function faktura(zmiany: { sprzedawcaNip?: string; nabywcaNip?: string } = {}): Invoice {
  return finalizeInvoice({
    internalNumber: 'FV 2026/10/001',
    type: 'VAT',
    issueDate: '2026-10-01',
    saleDate: '2026-10-01',
    seller: { nip: zmiany.sprzedawcaNip ?? '5260001246', name: 'ACME', address: adres('ul. A 1', '00-001 Warszawa') },
    buyer: { nip: zmiany.nabywcaNip ?? '5252241585', name: 'Klient', address: adres('ul. B 2', '02-001 Warszawa') },
    lines: [{ ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
    payment: { currency: 'PLN', dueDate: '2026-10-15', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
  }) as Invoice;
}

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: m.sendEvent, scheduleAfter: vi.fn() },
};

const event = (invoice: Invoice) => ({
  invoiceId: ID,
  tenantId: T,
  nip: '1234567890',
  environment: 'test' as const,
  invoice,
  sendAttemptId: ATTEMPT,
});

type Patch = Record<string, unknown>;

/** Cała ścieżka: wykonanie joba, które pada, potem obsługa po wyczerpaniu prób. */
async function failAndExhaust(invoice: Invoice): Promise<{ error: Error; patch: Patch }> {
  const error = await runSubmitInvoice(event(invoice), ctx).then(
    () => { throw new Error('oczekiwano błędu, runner zakończył się sukcesem'); },
    (e: unknown) => e as Error,
  );
  await onSubmitInvoiceExhausted(error, event(invoice), ctx);
  const patch = m.invoiceUpdate.mock.calls.map((c) => c[0] as Patch).filter((p) => 'ksef_status' in p).at(-1);
  if (!patch) throw new Error('faktura nie dostała zapisu wyniku');
  return { error, patch };
}

/** Teksty techniczne, których klient nie ma widzieć ani na stronie, ani w telefonie. */
const TECHNICZNE = ['NonRetriableError', 'Schemas validity', 'facet', 'crd.gov.pl', 'pattern', 'atomic type'];

function czystyDlaKlienta(tekst: unknown): void {
  const text = String(tekst);
  for (const fragment of TECHNICZNE) expect(text.includes(fragment), fragment).toBe(false);
  expect(text, 'numer linii libxml').not.toMatch(/Linia \d+:/);
}

beforeEach(() => {
  vi.clearAllMocks();
  // B2a: job wysyłki wysyła zwykłą fakturę tylko do końca następnego dnia roboczego po
  // dacie wystawienia (`lib/ksef/special-issue-date.ts`), a runner sprawdza to przed
  // generatorem i walidatorem XSD (`lib/jobs/runners/submit-invoice/send.ts`). Zegar stoi
  // więc w dniu wystawienia faktury z testu (2026-10-01, jak `claimXmlGeneratedAt` wyżej).
  // Na prawdziwym zegarze każdy test przez `failAndExhaust` dostawałby ISSUE_DATE_PASSED
  // zamiast odmowy XSD albo walidacji, którą sprawdza.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T10:00:00.000Z'));
  m.upload.mockReset();
  m.submit.mockReset();
  vi.stubEnv('KSEF_ENV', 'test');
  m.invoice = { id: ID, direction: 'outgoing', ksef_status: 'queued', ksef_number: null, ksef_environment: 'test', invoice_type: 'VAT', invoice_kind: 'regular', fa3_data: {} };
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('U3: XSD FA(3) odrzuca fakturę, klient dostaje pole i podpowiedź zamiast tekstu libxml', () => {
  it('NIP nabywcy: zdanie z nazwą pola, pole i podpowiedź w kolumnach, bez nazwy klasy i tekstu libxml', async () => {
    const { patch } = await failAndExhaust(faktura({ nabywcaNip: NIP_Z_BLEDEM_XSD }));

    expect(patch).toMatchObject({ ksef_status: 'rejected', last_error_code: 'XSD_INVALID', ksef_send_owner: null });
    czystyDlaKlienta(patch.last_error);
    expect(String(patch.last_error)).toContain('NIP nabywcy');
    expect(patch.last_error_field).toBe('NIP nabywcy');
    expect(typeof patch.last_error_suggestion).toBe('string');
    expect(String(patch.last_error_suggestion).length).toBeGreaterThan(10);
    czystyDlaKlienta(patch.last_error_suggestion);
  });

  it('ten sam element NIP u sprzedawcy to „NIP sprzedawcy”: pole wynika ze ścieżki w pliku, nie z zgadywania po nazwie elementu', async () => {
    const { patch } = await failAndExhaust(faktura({ sprzedawcaNip: NIP_Z_BLEDEM_XSD }));

    expect(patch).toMatchObject({ ksef_status: 'rejected', last_error_code: 'XSD_INVALID' });
    expect(patch.last_error_field).toBe('NIP sprzedawcy');
    expect(String(patch.last_error)).toContain('NIP sprzedawcy');
    expect(String(patch.last_error)).not.toContain('NIP nabywcy');
    // Dane sprzedawcy klient poprawia w Ustawieniach firmy, nie w szkicu faktury.
    expect(String(patch.last_error_suggestion)).toContain('Ustawieniach firmy');
  });

  it('strona i telefon czytają te same kolumny: karta telefonu dostaje zdanie, pole i podpowiedź bez zmiany kontraktu', async () => {
    const { patch } = await failAndExhaust(faktura({ nabywcaNip: NIP_Z_BLEDEM_XSD }));

    // Wiersz tak, jak zwraca go baza po zapisie wyniku (kolumny `last_error*` bez zmian).
    const f = fakturaZBazy({
      id: ID, internal_number: 'FV 2026/10/001', invoice_kind: 'regular', ksef_status: patch.ksef_status,
      last_error: patch.last_error, last_error_field: patch.last_error_field, last_error_suggestion: patch.last_error_suggestion,
      invoice_line_items: [],
    } as never);

    expect(f.statusKsef).toBe('odrzucona');
    expect(f.blad).toEqual({
      komunikat: patch.last_error,
      pole: 'NIP nabywcy',
      podpowiedz: patch.last_error_suggestion,
    });
    czystyDlaKlienta(f.blad?.komunikat);
  });

  it('ścieżka operatora zostaje: błąd joba, log workera i audyt niosą pełny tekst techniczny', async () => {
    const { error } = await failAndExhaust(faktura({ nabywcaNip: NIP_Z_BLEDEM_XSD }));

    expect(error.message).toContain('Schemas validity error');
    expect(error.message).toContain(NIP_Z_BLEDEM_XSD);
    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('klasyfikacja błędu'),
      expect.objectContaining({ errorName: 'NonRetriableError', errorMessage: expect.stringContaining('Schemas validity error'), code: 'XSD_INVALID' }),
    );
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'invoice.submit_failed',
      metadata: expect.objectContaining({ errorCode: 'XSD_INVALID', error: expect.stringContaining('Schemas validity error') }),
    }));
  });

  it('kanały klienta dostają to samo zdanie co faktura: zdarzenie dla e-maila i dzwonka bez nazwy klasy', async () => {
    const { patch } = await failAndExhaust(faktura({ nabywcaNip: NIP_Z_BLEDEM_XSD }));

    const emitted = m.sendEvent.mock.calls.find((c) => c[0] === 'emit-failure')?.[1] as { data: { error: string; errorCode: string } };
    expect(emitted.data.errorCode).toBe('XSD_INVALID');
    expect(emitted.data.error).toBe(patch.last_error);
    czystyDlaKlienta(emitted.data.error);
  });

  it('ponawianie i klasyfikacja bez zmian: NonRetriableError z przyczyną InvoiceXmlSchemaError, kod XSD_INVALID (terminal)', async () => {
    const { error } = await failAndExhaust(faktura({ nabywcaNip: NIP_Z_BLEDEM_XSD }));

    expect(error).toBeInstanceOf(NonRetriableError);
    expect(error.cause).toBeInstanceOf(InvoiceXmlSchemaError);
    expect(classifySendError(error)).toEqual({ code: 'XSD_INVALID', class: 'terminal' });
    expect(m.upload).not.toHaveBeenCalled();
    expect(m.submit).not.toHaveBeenCalled();
  });

  it('element, którego nie umiemy nazwać: ogólne zdanie bez surowego tekstu i bez zgadywania pola', async () => {
    m.fullFlow.mockRejectedValueOnce(new InvoiceXmlSchemaError([
      "Linia 1: Schemas validity error : Element '{http://crd.gov.pl/wzor/2025/06/25/13775/}Nieznany': [facet 'pattern'] The value 'x' is not accepted by the pattern '[0-9]'.",
    ]));
    const { patch } = await failAndExhaust(faktura());

    expect(patch).toMatchObject({ ksef_status: 'rejected', last_error_code: 'XSD_INVALID', last_error_field: null });
    czystyDlaKlienta(patch.last_error);
    expect(String(patch.last_error)).toContain('nie trafiła do KSeF');
    expect(String(patch.last_error_suggestion)).toContain('pomoc@faktway.pl');
  });
});

describe('U3: walidacja biznesowa faktury (InvoiceValidationError)', () => {
  it('klient dostaje komunikat walidacji bez nazwy klasy i bez „Faktura zawiera N błędów walidacji”', async () => {
    // Suma kontrolna NIP nabywcy się nie zgadza: tę odmowę zgłasza generator, zanim zbuduje XML.
    const { error, patch } = await failAndExhaust(faktura({ nabywcaNip: '1234567890' }));

    expect(error.cause).toBeInstanceOf(InvoiceValidationError);
    expect(patch).toMatchObject({ ksef_status: 'failed', last_error_code: 'INVALID_DOCUMENT' });
    czystyDlaKlienta(patch.last_error);
    expect(String(patch.last_error)).toContain('NIP nabywcy');
    expect(String(patch.last_error)).not.toMatch(/Faktura zawiera \d+/);
    expect(String(patch.last_error)).not.toMatch(/walidacji:\s*Faktura/);
    // Pełny komunikat generatora zostaje dla operatora.
    expect(error.message).toContain('Faktura zawiera 1 błąd walidacji');
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ error: expect.stringContaining('Faktura zawiera 1 błąd walidacji') }),
    }));
  });
});

describe('U3: nazwa klasy błędu nie trafia do klienta na żadnej ścieżce porażki', () => {
  it.each([
    ['błąd sterujący bez ponawiania', new NonRetriableError('Organizacja nie ma zweryfikowanego certyfikatu KSeF (Ustawienia → KSeF). Wysyłka do KSeF jest zablokowana.')],
    ['zwykły błąd po naszej stronie', new Error('Nie można zapisać wyniku wysyłki faktury')],
    // `send.ts` składa treść ponowienia jako `${error.name}: ${error.message}`.
    ['ponowienie z nazwą klasy w treści (padła sieć)', new RetryAfterError('TypeError: fetch failed', '30s')],
    ['ponowienie z nazwą klasy w treści (błąd bez klasy z listy)', new RetryAfterError('Error: KSeF przerwał przetwarzanie faktury', '30s')],
  ])('%s', async (_nazwa, blad) => {
    await onSubmitInvoiceExhausted(blad, event(faktura()), ctx);
    const patch = m.invoiceUpdate.mock.calls.map((c) => c[0] as Patch).filter((p) => 'ksef_status' in p).at(-1);

    expect(patch).toBeDefined();
    expect(String(patch?.last_error)).not.toMatch(/^[A-Za-z]*Error: /);
    czystyDlaKlienta(patch?.last_error);
    expect(String(patch?.last_error)).toContain(blad.message.replace(/^[A-Za-z]*Error: /, ''));
  });
});
