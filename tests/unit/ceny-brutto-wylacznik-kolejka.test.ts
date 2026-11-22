import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wyłącznik faktury w cenach brutto (RP-FA-BRUTTO-01) w kolejce wysyłki do
 * KSeF (`enqueueKsefSubmitAfterDraft`): jedno miejsce każdego zlecenia klienta.
 *
 * Droga, która przed wyłącznikiem przepuszczała `pricesGross` bez formularza:
 * wysyłka szkicu („Wyślij” na stronie, `POST /api/mobile/v1/faktury/{id}/wysylka`
 * z telefonu) i „Wyślij ponownie” biorą fakturę wprost z zapisanego `fa3_data`.
 * Szkic z `pricesGross: true` (zapisany sesją klienta wprost przez PostgREST:
 * RLS przepuszcza zapis szkicu tej firmy, a `guard_invoice_pending_content`
 * mrozi treść dopiero od kolejki) przechodził bramkę wysyłki (`validateInvoice`
 * przyjmuje spójną fakturę w cenach brutto od #835) i trafiał do kolejki.
 *
 * Prawdziwe: `sendRegularDraft`, `sendDraftFromMobile`, `resendInvoice`,
 * `enqueueKsefSubmitAfterDraft` z hamulcami, 2FA i weryfikacją KSeF, odczyt
 * flag (`getGlobalFlagForExecution`), krok transakcji kolejki. Atrapy tylko
 * bazy: sesja klienta i klucz serwisowy (wiersze faktury, firmy i flag), zapis
 * zlecenia pg-boss, dziennik prób i audyt; do tego odszyfrowanie poświadczeń
 * z atrapy bazy.
 */

const T = '11111111-1111-4111-8111-111111111111';
const ID = '33333333-3333-4333-8333-333333333333';
const USER = '55555555-5555-4555-8555-555555555555';
const NIP = '5260001246';
const WYLACZONE_SZKIC = 'Faktura w cenach brutto nie jest jeszcze dostępna w FaktWay, więc tego szkicu nie wysłaliśmy do KSeF. Wystaw fakturę od nowa w cenach netto, a szkic usuń.';
const WYLACZONE_PONOWIENIE = 'Faktura w cenach brutto nie jest jeszcze dostępna w FaktWay, więc tej wysyłki nie wykonaliśmy i faktura zostaje z błędem wysyłki. Wystaw fakturę od nowa w cenach netto.';
const NIEZNANE_SZKIC = 'Nie udało się sprawdzić, czy faktura w cenach brutto jest dostępna w FaktWay, więc tego szkicu nie wysłaliśmy do KSeF. Spróbuj ponownie za chwilę.';

const st = vi.hoisted(() => ({
  /** Wiersz flagi `grossPricesEnabled` w bazie: brak (undefined), wartość albo błąd odczytu. */
  flaga: undefined as boolean | undefined | 'blad',
  odczytyFlag: [] as string[],
  /** Wiersz faktury, który widzi sesja klienta. */
  faktura: null as Record<string, unknown> | null,
  zlecenia: [] as Array<{ name: string; data: Record<string, unknown> }>,
  odmowy: [] as Array<Record<string, unknown>>,
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn(), logAuditWithResult: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), addBreadcrumb: vi.fn() }));
vi.mock('@/lib/supabase/server', () => {
  /** Sesja klienta (RLS): faktura, historia wysyłek, firma. */
  const sesja = {
    from(table: string) {
      const q = {
        select: () => q,
        eq: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: async () => {
          if (table === 'invoices') return { data: st.faktura, error: null };
          if (table === 'tenants') {
            return { data: { nip: NIP, ksef_verified_at: '2026-10-01T10:00:00Z', ksef_verified_environment: 'test' }, error: null };
          }
          return { data: null, error: null };
        },
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(ok, fail),
      };
      return q;
    },
  };
  /** Klucz serwisowy: flagi globalne, zaszyfrowane poświadczenia KSeF, dziennik prób. */
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
          if (table !== 'global_feature_flags') return { data: null, error: null };
          st.odczytyFlag.push(String(filtry.flag));
          if (filtry.flag !== 'grossPricesEnabled') return { data: null, error: null };
          if (st.flaga === 'blad') return { data: null, error: { message: 'connection refused' } };
          return { data: st.flaga === undefined ? null : { enabled: st.flaga }, error: null };
        },
        single: async () => ({ data: table === 'tenants' ? { ksef_credentials_encrypted: '\\x00' } : null, error: null }),
        insert: (wiersz: Record<string, unknown>) => {
          if (table === 'ksef_send_attempts') st.odmowy.push(wiersz);
          return { abortSignal: async () => ({ error: null }) };
        },
      };
      return q;
    },
  };
  return { createClient: async () => sesja, createAdminClient: () => admin };
});
vi.mock('@/lib/ksef/credentials-crypto', () => ({ decryptCredentials: () => ({ type: 'token', nip: NIP, token: 't' }) }));
vi.mock('@/lib/jobs/enqueue', () => ({
  sendJobEvent: async (
    event: { name: string; data: Record<string, unknown> },
    options?: { inTransaction?: (tx: { executeSql: (sql: string, values?: unknown[]) => Promise<unknown> }) => Promise<void> },
  ) => {
    await options?.inTransaction?.({ executeSql: async () => ({ rows: [{ id: 'x' }], rowCount: 1 }) });
    st.zlecenia.push(JSON.parse(JSON.stringify(event)) as (typeof st.zlecenia)[number]);
    return { ids: ['job-1'] };
  },
}));

import { sendDraftFromMobile } from '@/lib/api/mobile/faktury';
import type { MobileCaller } from '@/lib/api/mobile/auth';
import { parseInvoiceCreateBody } from '@/lib/api/v1/invoice-create';
import { fakturaTelefonuSchema } from '@/lib/api/mobile/schematy';
import { resendInvoice } from '@/lib/invoices/ksef-resend';
import { enqueueKsefSubmitAfterDraft } from '@/lib/invoices/ksef-submit-enqueue';
import { sendRegularDraft } from '@/lib/invoices/send-draft';
import type { createClient } from '@/lib/supabase/server';
import { finalizeInvoice, type InvoiceInput } from '@/lib/xml/invoice-calculator';
import type { Invoice } from '@/types/invoice';

type Sesja = Awaited<ReturnType<typeof createClient>>;

// 17.11.2026 11:00 w Polsce: wysyłka tylko z dzisiejszą datą (A1).
const NOW = new Date('2026-11-17T10:00:00Z');
const DZIS = '2026-11-17';

function faktura(extra: Partial<InvoiceInput> = {}): Invoice {
  return finalizeInvoice({
    internalNumber: 'FV 2026/11/001',
    type: 'VAT',
    issueDate: DZIS,
    seller: { nip: NIP, name: 'ACME Software sp. z o.o.', address: { countryCode: 'PL', addressLine1: 'ul. Przykładowa 1/2', addressLine2: '00-001 Warszawa' } },
    buyer: { nip: '5252241585', name: 'Klient sp. z o.o.', address: { countryCode: 'PL', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa' } },
    payment: { currency: 'PLN', dueDate: '2026-12-01', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
    lines: [{ ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
    ...extra,
  });
}

/** Przypadek z rejestru (RP-FA-BRUTTO-01): dwie stawki jak na paragonie z kasy. */
const brutto = (): Invoice =>
  faktura({
    pricesGross: true,
    lines: [
      { ordinal: 1, name: 'Kanapka', unit: 'szt.', quantity: 2, unitPriceNet: 0, unitPriceGross: 20.99, vatRate: '8' },
      { ordinal: 2, name: 'Sałatka', unit: 'szt.', quantity: 1, unitPriceNet: 0, unitPriceGross: 12.5, vatRate: '8' },
      { ordinal: 3, name: 'Sok', unit: 'szt.', quantity: 3, unitPriceNet: 0, unitPriceGross: 5.49, vatRate: '23' },
    ],
  });

function szkic(invoice: Invoice): Record<string, unknown> {
  return {
    id: ID,
    ksef_status: 'draft',
    direction: 'outgoing',
    invoice_kind: 'regular',
    invoice_type: 'VAT',
    internal_number: invoice.internalNumber,
    issue_date: invoice.issueDate,
    fa3_data: JSON.parse(JSON.stringify(invoice)),
    special_data: null,
  };
}

const sesja = async (): Promise<Sesja> => (await import('@/lib/supabase/server')).createClient();
const wyslijSzkic = async () => sendRegularDraft({ supabase: await sesja(), userId: USER, tenantId: T }, ID);

beforeEach(() => {
  vi.clearAllMocks();
  st.flaga = undefined;
  st.odczytyFlag = [];
  st.faktura = null;
  st.zlecenia = [];
  st.odmowy = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('KSEF_ENV', 'test');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('„Wyślij” przy szkicu w cenach brutto (strona)', () => {
  it('przy wyłączonym wyłączniku (brak wiersza flagi): odmowa z wyjściem, szkic zostaje, bez zlecenia', async () => {
    st.faktura = szkic(brutto());
    await expect(wyslijSzkic()).resolves.toEqual({ success: false, error: WYLACZONE_SZKIC, reason: 'refused' });
    expect(st.zlecenia).toEqual([]);
    expect(st.odmowy).toEqual([expect.objectContaining({ status: 'refused', stage: 'enqueue', error_code: 'INVALID_DOCUMENT', invoice_id: ID })]);
  });

  it('wiersz flagi z false: ta sama odmowa', async () => {
    st.flaga = false;
    st.faktura = szkic(brutto());
    await expect(wyslijSzkic()).resolves.toMatchObject({ success: false, error: WYLACZONE_SZKIC });
    expect(st.zlecenia).toEqual([]);
  });

  it('błąd odczytu flagi: odmowa „spróbuj ponownie”, bez zlecenia („nie wiem” to nie „tak”)', async () => {
    st.flaga = 'blad';
    st.faktura = szkic(brutto());
    await expect(wyslijSzkic()).resolves.toMatchObject({ success: false, error: NIEZNANE_SZKIC });
    expect(st.zlecenia).toEqual([]);
    expect(st.odmowy).toEqual([expect.objectContaining({ error_code: 'INFRA' })]);
  });

  it('przy włączonym: faktura w cenach brutto idzie do kolejki z zapisaną treścią', async () => {
    st.flaga = true;
    st.faktura = szkic(brutto());
    await expect(wyslijSzkic()).resolves.toEqual({ success: true, offline: false });
    expect(st.zlecenia).toHaveLength(1);
    expect(st.zlecenia[0]).toMatchObject({ name: 'invoice/submit.requested', data: { invoiceId: ID, invoice: { pricesGross: true } } });
  });

  it('szkic w cenach netto: bez odczytu flagi, kolejka jak dotąd', async () => {
    st.faktura = szkic(faktura());
    await expect(wyslijSzkic()).resolves.toEqual({ success: true, offline: false });
    expect(st.odczytyFlag).not.toContain('grossPricesEnabled');
    expect(st.zlecenia).toHaveLength(1);
  });
});

describe('telefon: POST /api/mobile/v1/faktury/{id}/wysylka', () => {
  const caller = async (): Promise<MobileCaller> => ({
    requestId: 'req-1',
    headers: {},
    user: { id: USER, email: 'jan@example.test', providers: ['email'] },
    mfaEnabled: true,
    accessToken: null,
    totpFactorId: null,
    session: {} as MobileCaller['session'],
    org: { tenantId: T, role: 'owner' },
    db: (await sesja()) as unknown as MobileCaller['db'],
  } as MobileCaller);

  it('wyłączony: 422 z tym samym tekstem co strona, bez zlecenia', async () => {
    st.faktura = szkic(brutto());
    const odp = await sendDraftFromMobile(await caller(), ID);
    expect(odp.status).toBe(422);
    await expect(odp.json()).resolves.toEqual({ error: { code: 'ksef_send_refused', message: WYLACZONE_SZKIC } });
    expect(st.zlecenia).toEqual([]);
  });

  it('włączony: wysyłka zlecona', async () => {
    st.flaga = true;
    st.faktura = szkic(brutto());
    const odp = await sendDraftFromMobile(await caller(), ID);
    expect(odp.status).toBe(200);
    expect(st.zlecenia).toHaveLength(1);
  });

  it('wystawienie z telefonu nie przyjmuje ceny brutto: treść spoza kontraktu (400), zanim powstanie szkic', () => {
    const tresc = {
      internalNumber: 'FV/1', issueDate: DZIS, saleDate: '', buyerNip: '5252241585', buyerName: 'K', buyerAddressLine1: 'a',
      buyerAddressLine2: 'b', buyerEmail: '', buyerIsConsumer: false, paymentMethod: 'transfer', paymentDueDate: DZIS,
      bankAccount: '', notes: '', splitPayment: false, numberSeriesId: '', numberPreview: '',
      lines: [{ name: 'X', unit: 'szt', quantity: 1, unitPriceNet: 0, vatRate: '23' }],
    };
    expect(fakturaTelefonuSchema.safeParse(tresc).success).toBe(true);
    expect(fakturaTelefonuSchema.safeParse({ ...tresc, pricesGross: true }).success).toBe(false);
    expect(fakturaTelefonuSchema.safeParse({ ...tresc, lines: [{ ...tresc.lines[0], unitPriceGross: 1 }] }).success).toBe(false);
  });
});

describe('„Wyślij ponownie” z zapisanej kopii', () => {
  const kontekst = async () => ({ supabase: await sesja(), userId: USER, tenantId: T, role: 'owner' as const });

  it('wyłączony: odmowa, faktura zostaje z błędem wysyłki, bez zlecenia', async () => {
    st.faktura = { ...szkic(brutto()), ksef_status: 'failed', last_error_code: 'KSEF_UNAVAILABLE' };
    await expect(resendInvoice(kontekst, ID)).resolves.toEqual({ success: false, error: WYLACZONE_PONOWIENIE });
    expect(st.zlecenia).toEqual([]);
  });

  it('włączony: ponowna wysyłka zlecona', async () => {
    st.flaga = true;
    st.faktura = { ...szkic(brutto()), ksef_status: 'failed', last_error_code: 'KSEF_UNAVAILABLE' };
    await expect(resendInvoice(kontekst, ID)).resolves.toEqual({ success: true });
    expect(st.zlecenia).toHaveLength(1);
  });
});

describe('„Sprawdź ponownie” (tylko uzgodnienie) nic nie wysyła, więc wyłącznik go nie zatrzymuje', () => {
  it('faktura w cenach brutto wysłana przy włączonym: uzgodnienie po wyłączeniu idzie do kolejki', async () => {
    const wynik = await enqueueKsefSubmitAfterDraft({
      supabase: (await sesja()) as never,
      tenantId: T,
      userId: USER,
      invoiceId: ID,
      nip: NIP,
      invoice: brutto(),
      auditKind: 'regular',
      mode: { kind: 'requeue', actorUserId: USER, reconcileOnly: true },
    });
    expect(wynik).toMatchObject({ ok: true, mode: 'online_queued' });
    expect(st.odczytyFlag).not.toContain('grossPricesEnabled');
    expect(st.zlecenia[0]).toMatchObject({ data: { reconcileOnly: true } });
  });
});

describe('API v1 nie przyjmuje ceny brutto (treść żądania bez takich pól)', () => {
  it('prices_gross i unit_price_gross: 422 „Nieznane pole” z czytania treści, przed budową faktury i zapisem', () => {
    const tresc = {
      buyer: { type: 'company', nip: '5252241585', name: 'K', address_line1: 'a', address_line2: 'b' },
      items: [{ name: 'X', unit: 'szt', quantity: '1', unit_price_net: '10', vat_rate: '23' }],
    };
    expect(parseInvoiceCreateBody(tresc)).toMatchObject({ ok: true });
    expect(parseInvoiceCreateBody({ ...tresc, prices_gross: true })).toMatchObject({
      ok: false,
      status: 422,
      code: 'validation_failed',
      fields: [{ field: 'prices_gross', message: 'Nieznane pole prices_gross.' }],
    });
    expect(parseInvoiceCreateBody({ ...tresc, items: [{ ...tresc.items[0], unit_price_gross: '12.3' }] })).toMatchObject({
      ok: false,
      status: 422,
      fields: [{ field: 'items[0].unit_price_gross', message: 'Nieznane pole unit_price_gross.' }],
    });
  });
});
