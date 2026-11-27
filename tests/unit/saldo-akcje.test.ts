import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, memoryDb, type MemoryDb, type Row } from '../helpers/fake-supabase-memory';

/**
 * Akcje potwierdzenia salda (krok 2.9, część 2, PR B) na prawdziwej ścieżce:
 * wyłącznik, rola, podgląd z bazy w ścisłym kształcie, porównanie
 * z należnościami Pulpitu, wystawienie tylko odcisku z podglądu, PDF i wysyłka
 * przez `sendEmail` i Resend z kluczem idempotencji. Atrapy tylko dla sesji,
 * bazy (w pamięci, z RPC), wyłącznika, należności i HTTP do Resend. Funkcje
 * 00216 na prawdziwym Postgresie: tests/rls-saldo.test.ts.
 */

const TENANT = 'ten-1';
const KONTRAHENT = '00215215-1111-4000-8000-00000000000a';
const F1 = '00215215-2222-4000-8000-000000000001';
const DOK = '00215215-3333-4000-8000-000000000001';
const ODCISK = 'a'.repeat(32);
const ODBIORCA = 'ksiegowosc@kontrahent.test';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  revalidate: vi.fn(),
  resendSend: vi.fn(),
  canSendTo: vi.fn(),
  rpc: vi.fn(),
  flag: vi.fn(),
  receivables: vi.fn(),
  sentryException: vi.fn(),
  sentryMessage: vi.fn(),
}));

vi.mock('@/lib/supabase/auth-context', () => ({
  requireUserAndActiveOrg: mocks.auth,
  ActionAuthError: class ActionAuthError extends Error {},
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('resend', () => ({ Resend: class { emails = { send: mocks.resendSend }; } }));
vi.mock('@/lib/email/preferences', () => ({ canSendTo: mocks.canSendTo }));
vi.mock('@/lib/saldo/wylacznik', () => ({ czyPotwierdzenieSaldaWlaczone: mocks.flag }));
vi.mock('@/lib/dashboard/receivables', () => ({ getReceivables: mocks.receivables }));
vi.mock('@/lib/pdf/logo-odczyt', () => ({ loadCompanyPdfLogo: vi.fn().mockResolvedValue({ logo: null, key: null }) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }) }));
vi.mock('@sentry/nextjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sentry/nextjs')>()),
  captureException: mocks.sentryException,
  captureMessage: mocks.sentryMessage,
}));

import {
  issueBalanceConfirmationAction,
  previewBalanceConfirmationAction,
  sendBalanceConfirmationEmailAction,
} from '@/app/actions/saldo';
import { balanceEmailIdempotencyKey } from '@/lib/saldo/mail';
import { BALANCE_REFUSALS, BALANCE_TEXTS } from '@/lib/saldo/teksty';

let db: MemoryDb;

const STRONA = { name: 'Kontrahent Testowy', nip: '123-456-78-90', countryCode: 'PL', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa', email: ODBIORCA };
const FIRMA = { name: 'Moja Firma', nip: '1234567890', countryCode: 'PL', addressLine1: 'ul. Przykładowa 1', addressLine2: '00-001 Warszawa' };
const POZYCJA = {
  invoiceId: F1, number: 'FV/1/2026', ksefNumber: null, issueDate: '2026-10-01', dueDate: '2026-10-15',
  kind: 'regular', type: 'VAT', gross: 1230, amountDue: 1230, paid: 230, outstanding: 1000,
};

function podgladBazy(zmiany: Row = {}): Row {
  return {
    status: 'ok', contractor_id: KONTRAHENT, as_of: '2026-11-25', environment: 'test', currency: 'PLN',
    counterparty: STRONA, issuer: FIRMA, items: [POZYCJA], omitted: [], total: 1000, fingerprint: ODCISK, ...zmiany,
  };
}

function dokument(zmiany: Row = {}): Row {
  return {
    id: DOK, tenant_id: TENANT, contractor_id: KONTRAHENT, number: 'PS/1/2026', as_of: '2026-11-25', currency: 'PLN',
    counterparty: STRONA, issuer: FIRMA, items: [POZYCJA], omitted: [], total: 1000, issued_at: '2026-11-25T09:30:00.000Z', ...zmiany,
  };
}

/** Należności Pulpitu tego kontrahenta: ta sama faktura i kwota co w podglądzie. */
function pulpit(outstanding = 1000) {
  return { byInvoice: [{ id: F1, internalNumber: 'FV/1/2026', buyerName: null, buyerNip: '1234567890', paymentDueDate: null, outstanding, daysOverdue: 0 }] };
}

let podglad: Row = podgladBazy();
let wystawienie: { data: unknown; error: unknown } = { data: { status: 'issued', id: DOK, number: 'PS/1/2026' }, error: null };

/** Zapis historii jak RPC `record_balance_confirmation_email` (00216): raz na klucz w firmie. */
function zapisHistorii(args: Record<string, unknown>) {
  const emails = (db.tables.balance_confirmation_emails ??= []);
  if (emails.some((e) => e.idempotency_key === args.p_idempotency_key)) return { data: { status: 'already_recorded' }, error: null };
  emails.push({
    id: `mail-${emails.length + 1}`, tenant_id: TENANT, confirmation_id: args.p_confirmation_id, recipient: args.p_recipient,
    idempotency_key: args.p_idempotency_key, sent_at: '2026-11-25T10:00:00.000Z',
  });
  return { data: { status: 'recorded' }, error: null };
}

function sesja(role = 'member') {
  return { supabase: { ...fakeSupabase(db), rpc: mocks.rpc }, user: { id: 'user-1' }, tenantId: TENANT, role };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('RESEND_API_KEY', 'a'.repeat(24));
  db = memoryDb({ balance_confirmations: [dokument()], balance_confirmation_emails: [] });
  podglad = podgladBazy();
  wystawienie = { data: { status: 'issued', id: DOK, number: 'PS/1/2026' }, error: null };
  mocks.auth.mockResolvedValue(sesja());
  mocks.flag.mockResolvedValue(true);
  mocks.receivables.mockResolvedValue(pulpit());
  mocks.canSendTo.mockResolvedValue({ ok: true });
  mocks.resendSend.mockResolvedValue({ data: { id: 'msg-1' }, error: null });
  mocks.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    if (fn === 'balance_confirmation_preview') return { data: podglad, error: null };
    if (fn === 'issue_balance_confirmation') return wystawienie;
    if (fn === 'record_balance_confirmation_email') return zapisHistorii(args);
    return { data: null, error: { code: 'PGRST202', message: `brak funkcji ${fn}` } };
  });
});

describe('previewBalanceConfirmationAction', () => {
  it('podgląd z bazy (firma formularza sprawdzona, środowisko KSeF aplikacji) zgodny z Pulpitem', async () => {
    const r = await previewBalanceConfirmationAction(KONTRAHENT, TENANT);

    expect(r).toMatchObject({ success: true, preview: { total: 1000, fingerprint: ODCISK, items: [{ invoiceId: F1, outstanding: 1000 }] } });
    expect(mocks.auth).toHaveBeenCalledWith({ expectedTenantId: TENANT });
    expect(mocks.rpc).toHaveBeenCalledWith('balance_confirmation_preview', { p_contractor_id: KONTRAHENT, p_ksef_environment: 'test' });
    expect(mocks.receivables).toHaveBeenCalledWith(expect.anything(), TENANT);
  });

  it('wyłącznik zdjęty albo nieczytelny: odmowa przed bazą', async () => {
    mocks.flag.mockResolvedValueOnce(false);
    expect(await previewBalanceConfirmationAction(KONTRAHENT, TENANT)).toEqual({ success: false, error: BALANCE_REFUSALS.disabled });
    mocks.flag.mockRejectedValueOnce(new Error('db down'));
    expect(await previewBalanceConfirmationAction(KONTRAHENT, TENANT)).toEqual({ success: false, error: BALANCE_TEXTS.flagUnknown });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('rola spoza listy i zły identyfikator kontrahenta: odmowa bez bazy', async () => {
    mocks.auth.mockResolvedValueOnce(sesja('viewer'));
    expect(await previewBalanceConfirmationAction(KONTRAHENT, TENANT)).toEqual({ success: false, error: BALANCE_TEXTS.role });
    expect(await previewBalanceConfirmationAction('nie-uuid', TENANT)).toEqual({ success: false, error: BALANCE_REFUSALS.contractor_not_found });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('odmowa bazy z kodem: tekst z przyczyną i wyjściem', async () => {
    podglad = { status: 'refused', code: 'issuer_incomplete' };
    expect(await previewBalanceConfirmationAction(KONTRAHENT, TENANT)).toEqual({ success: false, error: BALANCE_REFUSALS.issuer_incomplete });
  });

  it('saldo z bazy różne od Pulpitu o grosz: odmowa z wyjściem (Pomoc) i alarm, bez podglądu', async () => {
    mocks.receivables.mockResolvedValueOnce(pulpit(999.99));
    expect(await previewBalanceConfirmationAction(KONTRAHENT, TENANT)).toEqual({ success: false, error: BALANCE_TEXTS.pulpitMismatch });
    expect(mocks.sentryMessage).toHaveBeenCalledTimes(1);
  });

  it('nieznany kształt wyniku bazy: błąd odczytu, nie dokument', async () => {
    podglad = { status: 'ok' };
    expect(await previewBalanceConfirmationAction(KONTRAHENT, TENANT)).toEqual({ success: false, error: BALANCE_TEXTS.readFailed });
    expect(mocks.sentryException).toHaveBeenCalledTimes(1);
  });
});

describe('issueBalanceConfirmationAction', () => {
  const wejscie = { contractorId: KONTRAHENT, fingerprint: ODCISK, withoutOmitted: false };

  it('wystawia tylko odcisk z podglądu: RPC z odciskiem i zgodą na pominięte, numer z bazy', async () => {
    const r = await issueBalanceConfirmationAction({ ...wejscie, withoutOmitted: true }, TENANT);

    expect(r).toEqual({ success: true, id: DOK, number: 'PS/1/2026', alreadyIssued: false });
    expect(mocks.rpc).toHaveBeenCalledWith('issue_balance_confirmation', {
      p_contractor_id: KONTRAHENT, p_ksef_environment: 'test', p_fingerprint: ODCISK, p_without_omitted: true,
    });
    expect(mocks.revalidate).toHaveBeenCalledWith('/noty');
  });

  it('ta sama treść drugi raz: ten sam numer z „już wystawione”', async () => {
    wystawienie = { data: { status: 'already_issued', id: DOK, number: 'PS/1/2026' }, error: null };
    expect(await issueBalanceConfirmationAction(wejscie, TENANT)).toEqual({ success: true, id: DOK, number: 'PS/1/2026', alreadyIssued: true });
  });

  it('dane zmienione od podglądu (inny odcisk) albo zły odcisk: odmowa changed bez RPC wystawienia', async () => {
    podglad = podgladBazy({ fingerprint: 'b'.repeat(32) });
    expect(await issueBalanceConfirmationAction(wejscie, TENANT)).toEqual({ success: false, error: BALANCE_REFUSALS.changed });
    expect(await issueBalanceConfirmationAction({ ...wejscie, fingerprint: 'xyz' }, TENANT)).toEqual({ success: false, error: BALANCE_REFUSALS.changed });
    expect(mocks.rpc.mock.calls.map((c) => c[0])).not.toContain('issue_balance_confirmation');
  });

  it('niezgodność z Pulpitem zatrzymuje wystawienie', async () => {
    mocks.receivables.mockResolvedValueOnce({ byInvoice: [] });
    expect(await issueBalanceConfirmationAction(wejscie, TENANT)).toEqual({ success: false, error: BALANCE_TEXTS.pulpitMismatch });
    expect(mocks.rpc.mock.calls.map((c) => c[0])).not.toContain('issue_balance_confirmation');
  });

  it('odmowa bazy przy wystawieniu (pominięte bez zgody) i błąd uprawnień: teksty z wyjściem', async () => {
    wystawienie = { data: { status: 'refused', code: 'omitted_not_confirmed', omitted_count: 1 }, error: null };
    expect(await issueBalanceConfirmationAction(wejscie, TENANT)).toEqual({ success: false, error: BALANCE_REFUSALS.omitted_not_confirmed });
    wystawienie = { data: null, error: { code: '42501', message: 'No active organization' } };
    expect(await issueBalanceConfirmationAction(wejscie, TENANT)).toEqual({ success: false, error: BALANCE_TEXTS.role });
  });
});

describe('sendBalanceConfirmationEmailAction', () => {
  it('wysyła dokument z PDF i kluczem idempotencji; historię zapisuje baza tym samym kluczem', async () => {
    const r = await sendBalanceConfirmationEmailAction(DOK, '  KsiegowoSC@Kontrahent.test ');

    expect(r).toEqual({ success: true, recipient: ODBIORCA });
    const klucz = balanceEmailIdempotencyKey(DOK, ODBIORCA, 0);
    expect(mocks.resendSend).toHaveBeenCalledTimes(1);
    const [wiadomosc, opcje] = mocks.resendSend.mock.calls[0]!;
    expect(opcje).toEqual({ idempotencyKey: klucz });
    expect(wiadomosc).toMatchObject({ to: [ODBIORCA], subject: 'Potwierdzenie salda PS/1/2026 od Moja Firma' });
    const [zalacznik] = (wiadomosc as { attachments: Array<{ filename: string; content: Buffer }> }).attachments;
    expect(zalacznik!.filename).toBe('potwierdzenie-salda-PS-1-2026.pdf');
    expect(zalacznik!.content.subarray(0, 5).toString()).toBe('%PDF-');
    expect(mocks.rpc).toHaveBeenCalledWith('record_balance_confirmation_email', {
      p_confirmation_id: DOK, p_recipient: ODBIORCA, p_idempotency_key: klucz, p_provider_message_id: 'msg-1',
    });
    expect(db.tables.balance_confirmation_emails).toHaveLength(1);
  });

  it('ponowienie po wysyłce bez zapisu historii: ten sam klucz (Resend nie wyśle drugi raz); po zapisie nowy klucz', async () => {
    mocks.rpc.mockImplementationOnce(async () => ({ data: null, error: { code: '57014', message: 'timeout' } }));
    expect(await sendBalanceConfirmationEmailAction(DOK, ODBIORCA)).toEqual({ success: false, error: BALANCE_TEXTS.emailNotRecorded });
    expect(await sendBalanceConfirmationEmailAction(DOK, ODBIORCA)).toEqual({ success: true, recipient: ODBIORCA });
    await sendBalanceConfirmationEmailAction(DOK, ODBIORCA);
    expect(mocks.resendSend.mock.calls.map((c) => c[1])).toEqual([
      { idempotencyKey: balanceEmailIdempotencyKey(DOK, ODBIORCA, 0) },
      { idempotencyKey: balanceEmailIdempotencyKey(DOK, ODBIORCA, 0) },
      { idempotencyKey: balanceEmailIdempotencyKey(DOK, ODBIORCA, 1) },
    ]);
  });

  it('zły adres, dokument innej firmy i zdjęty wyłącznik: odmowa bez wysyłki', async () => {
    expect(await sendBalanceConfirmationEmailAction(DOK, 'to-nie-adres')).toEqual({ success: false, error: BALANCE_TEXTS.emailInvalid });
    db.tables.balance_confirmations = [dokument({ tenant_id: 'ten-2' })];
    expect(await sendBalanceConfirmationEmailAction(DOK, ODBIORCA)).toEqual({ success: false, error: BALANCE_TEXTS.notFound });
    mocks.flag.mockResolvedValueOnce(false);
    expect(await sendBalanceConfirmationEmailAction(DOK, ODBIORCA)).toEqual({ success: false, error: BALANCE_TEXTS.emailDisabled });
    expect(mocks.resendSend).not.toHaveBeenCalled();
  });
});
