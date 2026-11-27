import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KsefAuth } from '@/lib/ksef/auth';
import type { Invoice } from '@/types/invoice';

/**
 * Wyłącznik faktury w cenach brutto (RP-FA-BRUTTO-01, B4.0 zasada 2 planu
 * żelaznego filtra) w jobie wysyłki. `submitInvoiceFullFlow` to jedyna funkcja,
 * która buduje plik FA(3) i wysyła go do KSeF, dla każdej drogi: formularz,
 * wysyłka szkicu, API, telefon, „Wyślij ponownie”, cron cyklu życia i operator
 * (dwa ostatnie budują zdarzenie z `fa3_data` bez kolejki klienta). Przy
 * wyłączonym wyłączniku faktura w cenach brutto kończy się odmową przed plikiem,
 * archiwum i POST; klient widzi powód i wyjście (faktura w cenach netto).
 *
 * Prawdziwe: krok `submitToKsef` runnera, `submitInvoiceFullFlow`, generator
 * FA(3), walidator XSD MF, strażnik FA(3), odczyt flagi
 * (`getGlobalFlagForExecution`) i klasyfikacja porażki z tekstem dla klienta.
 * Atrapy tylko bazy i HTTP: wiersz flagi w `global_feature_flags` i wiersz
 * faktury (baza), poświadczenia i weryfikacja KSeF firmy oraz data wytworzenia
 * pliku (baza), archiwum R2 (HTTP), dziennik wysyłek (baza), wysyłka do KSeF
 * (HTTP) i Sentry.
 */

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '11111111-1111-4111-8111-111111111111';
const AUTH = { type: 'token', nip: '5260001246', token: 't' } as unknown as KsefAuth;
const BRUTTO_ZABLOKOWANE = /Faktura w cenach brutto nie jest jeszcze dostępna w FaktWay\. Wystaw fakturę od nowa w cenach netto\./;

const m = vi.hoisted(() => ({
  /** Wiersz flagi `grossPricesEnabled`: brak (undefined), wartość albo błąd odczytu bazy. */
  flaga: undefined as boolean | undefined | 'blad',
  odczytyFlag: [] as string[],
  /** Pliki, które poszły do KSeF (treść XML). */
  wyslane: [] as string[],
  upload: vi.fn(async () => ({ storagePath: 'x.xml', sha256Hash: 'h', sizeBytes: 1 })),
  /** Wiersz faktury w bazie (zapisana kopia = treść zdarzenia). */
  wiersz: null as Record<string, unknown> | null,
}));

vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn(), captureException: vi.fn(), addBreadcrumb: vi.fn() }));
vi.mock('@/lib/supabase/server', () => {
  const admin = {
    from(table: string) {
      const filtry: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq: (kolumna: string, wartosc: unknown) => {
          filtry[kolumna] = wartosc;
          return q;
        },
        maybeSingle: async () => {
          if (table === 'global_feature_flags') {
            m.odczytyFlag.push(String(filtry.flag));
            if (filtry.flag !== 'grossPricesEnabled') return { data: null, error: null };
            if (m.flaga === 'blad') return { data: null, error: { message: 'connection refused' } };
            return { data: m.flaga === undefined ? null : { enabled: m.flaga }, error: null };
          }
          if (table === 'invoices') return { data: m.wiersz, error: null };
          throw new Error(`nieoczekiwana tabela ${table}`);
        },
      };
      return q;
    },
  };
  return { createAdminClient: () => admin, createClient: async () => admin };
});
vi.mock('@/lib/supabase/admin-queries', () => ({
  getTenantKsefCredentials: vi.fn(async () => AUTH),
  KsefCredentialsError: class KsefCredentialsError extends Error {},
}));
vi.mock('@/lib/auth/ksef-verification-guard', () => ({
  requireKsefVerificationForBackgroundJob: vi.fn(async () => undefined),
  KsefNotVerifiedError: class KsefNotVerifiedError extends Error {},
}));
vi.mock('@/lib/ksef/xml-generated-at', () => ({ claimXmlGeneratedAt: vi.fn(async () => new Date('2026-11-17T10:00:00Z')) }));
vi.mock('@/lib/storage/r2', () => ({ uploadInvoiceXml: m.upload }));
vi.mock('@/lib/ksef/submission-log', () => ({
  recordKsefSubmissionIntent: vi.fn(),
  abandonKsefSubmissionIntent: vi.fn(),
  recordKsefSubmissionSent: vi.fn(),
  findOpenKsefSubmission: vi.fn(async () => null),
  markKsefSubmission: vi.fn(),
}));
vi.mock('@/lib/ksef/submit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ksef/submit')>()),
  submitInvoice: vi.fn(async (xml: string, _auth: unknown, _env: unknown, _audit: unknown, hooks?: {
    onSessionOpened?: (s: { sessionReferenceNumber: string }) => Promise<void>;
  }) => {
    await hooks?.onSessionOpened?.({ sessionReferenceNumber: 'S-1' });
    m.wyslane.push(xml);
    return { ksefNumber: 'K-1', sessionReferenceNumber: 'S-1', invoiceReferenceNumber: 'R-1' };
  }),
}));

import { submitToKsef } from '@/lib/jobs/runners/submit-invoice/send';
import type { SubmitRunContext } from '@/lib/jobs/runners/submit-invoice/shared';
import { validationFailureIn } from '@/lib/jobs/runners/submit-invoice/komunikat-klienta';
import { submitInvoiceFullFlow } from '@/lib/ksef/submit-invoice-full';
import { classifySendError } from '@/lib/ksef/send-error-codes';
import { finalizeInvoice, type InvoiceInput } from '@/lib/xml/invoice-calculator';

const NOW = new Date('2026-11-17T10:00:00Z');

function faktura(extra: Partial<InvoiceInput> = {}): Invoice {
  return finalizeInvoice({
    internalNumber: 'FV 2026/11/001',
    type: 'VAT',
    issueDate: '2026-11-17',
    seller: { nip: '5260001246', name: 'ACME Software sp. z o.o.', address: { countryCode: 'PL', addressLine1: 'ul. Przykładowa 1/2', addressLine2: '00-001 Warszawa' } },
    buyer: { nip: '5252241585', name: 'Klient sp. z o.o.', address: { countryCode: 'PL', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa' } },
    payment: { currency: 'PLN', dueDate: '2026-12-01', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
    lines: [{ ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
    ...extra,
  });
}

/** Przypadek z rejestru (RP-FA-BRUTTO-01): trzy pozycje po 1,00 zł brutto przy 23 %. */
const brutto = (): Invoice =>
  faktura({
    pricesGross: true,
    lines: ['Kawa', 'Herbata', 'Woda'].map((name, i) => ({ ordinal: i + 1, name, unit: 'szt.', quantity: 1, unitPriceNet: 0, unitPriceGross: 1, vatRate: '23' as const })),
  });

const wyslij = (invoice: Invoice) => submitInvoiceFullFlow(T, ID, invoice, AUTH, 'test', null, null, null, 'a-1');

beforeEach(() => {
  vi.clearAllMocks();
  m.flaga = undefined;
  m.odczytyFlag = [];
  m.wyslane = [];
  m.wiersz = null;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('KSEF_ENV', 'test');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('wyłącznik cen brutto w jobie wysyłki (submitInvoiceFullFlow)', () => {
  it('brak wiersza flagi (domyślnie wyłączony): odmowa przed plikiem, archiwum i POST', async () => {
    await expect(wyslij(brutto())).rejects.toMatchObject({
      name: 'InvoiceValidationError',
      errors: [expect.stringMatching(BRUTTO_ZABLOKOWANE)],
    });
    expect(m.upload).not.toHaveBeenCalled();
    expect(m.wyslane).toEqual([]);
    expect(m.odczytyFlag).toEqual(['grossPricesEnabled']);
  });

  it('wiersz z enabled = false: ta sama odmowa', async () => {
    m.flaga = false;
    await expect(wyslij(brutto())).rejects.toMatchObject({ name: 'InvoiceValidationError' });
    expect(m.upload).not.toHaveBeenCalled();
    expect(m.wyslane).toEqual([]);
  });

  it('włączony: plik z P_9B i P_11A (VAT stawki 0,56 od 3,00) idzie do KSeF', async () => {
    m.flaga = true;
    await expect(wyslij(brutto())).resolves.toMatchObject({ ksefNumber: 'K-1' });
    expect(m.upload).toHaveBeenCalledTimes(1);
    expect(m.wyslane).toHaveLength(1);
    const xml = m.wyslane[0]!;
    expect(xml).toContain('<P_9B>1.0000</P_9B>');
    expect(xml).toContain('<P_11A>1.00</P_11A>');
    expect(xml).toContain('<P_14_1>0.56</P_14_1>');
    expect(xml).not.toContain('<P_9A>');
  });

  it('błąd odczytu flagi: bez pliku i bez POST, a błąd nie jest odmową treści (job ponowi próbę)', async () => {
    m.flaga = 'blad';
    const blad = await wyslij(brutto()).then(() => null, (e: unknown) => e);
    expect(blad).toBeInstanceOf(Error);
    expect((blad as Error).name).not.toBe('InvoiceValidationError');
    expect(m.upload).not.toHaveBeenCalled();
    expect(m.wyslane).toEqual([]);
  });

  it('faktura w cenach netto: bez odczytu flagi, idzie do KSeF jak dotąd', async () => {
    await expect(wyslij(faktura())).resolves.toMatchObject({ ksefNumber: 'K-1' });
    expect(m.odczytyFlag).not.toContain('grossPricesEnabled');
    expect(m.wyslane).toHaveLength(1);
    expect(m.wyslane[0]).toContain('<P_9A>100.0000</P_9A>');
  });

  it('flaga z napisem „true” zamiast wartości logicznej nie jest fakturą w cenach brutto: plik w cenach netto, bez odczytu flagi', async () => {
    const dziwna = { ...faktura(), pricesGross: 'true' } as unknown as Invoice;
    await expect(wyslij(dziwna)).resolves.toMatchObject({ ksefNumber: 'K-1' });
    expect(m.odczytyFlag).not.toContain('grossPricesEnabled');
    expect(m.wyslane[0]).not.toContain('<P_9B>');
  });
});

describe('krok submitToKsef runnera: klient widzi powód i wyjście', () => {
  function kontekst(invoice: Invoice): SubmitRunContext {
    m.wiersz = {
      id: ID,
      direction: 'outgoing',
      ksef_status: 'sending',
      ksef_number: null,
      ksef_environment: null,
      invoice_type: 'VAT',
      invoice_kind: 'regular',
      internal_number: invoice.internalNumber,
      parent_invoice_id: null,
      advance_invoice_ids: null,
      seller_nip: invoice.seller.nip,
      seller_data: invoice.seller,
      fa3_data: JSON.parse(JSON.stringify(invoice)),
      special_data: null,
    };
    const data = { tenantId: T, invoiceId: ID, invoice, nip: '5260001246', environment: 'test' as const, sendAttemptId: '22222222-2222-4222-8222-222222222222' };
    return {
      parsed: { data },
      tenantId: T,
      invoiceId: ID,
      invoice,
      nip: '5260001246',
      env: 'test',
      attempt: 0,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as SubmitRunContext;
  }

  it('wyłączony: bez ponawiania, INVALID_DOCUMENT (terminal, powrót do szkicu) i tekst o cenach brutto z wyjściem', async () => {
    const blad = await submitToKsef(kontekst(brutto())).then(() => null, (e: unknown) => e as Error);
    expect(blad?.name).toBe('NonRetriableError');
    expect(classifySendError(blad)).toEqual({ code: 'INVALID_DOCUMENT', class: 'terminal' });
    const dlaKlienta = validationFailureIn(blad);
    expect(dlaKlienta?.message).toMatch(/^Faktura nie trafiła do KSeF\. /);
    expect(dlaKlienta?.message).toMatch(BRUTTO_ZABLOKOWANE);
    expect(m.wyslane).toEqual([]);
  });

  it('odmowa z własnym wyjściem nie dostaje „Popraw wskazane dane.” (nic w danych faktury do poprawy)', async () => {
    const blad = await submitToKsef(kontekst(brutto())).then(() => null, (e: unknown) => e as Error);
    const dlaKlienta = validationFailureIn(blad);
    expect(dlaKlienta?.message).toMatch(BRUTTO_ZABLOKOWANE);
    expect(dlaKlienta?.suggestion).toBeNull();
  });

  it('włączony: faktura w cenach brutto przechodzi przez krok do KSeF', async () => {
    m.flaga = true;
    await expect(submitToKsef(kontekst(brutto()))).resolves.toMatchObject({ ksefNumber: 'K-1', via: 'submit' });
    expect(m.wyslane).toHaveLength(1);
  });
});
