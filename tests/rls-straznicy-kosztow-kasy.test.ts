import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { PgBoss } from 'pg-boss';

import { getRlsTestDatabaseUrl, getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * FZ-024, paczka 2 (koszty, wpłaty, wyciąg z banku, kasa): strażnicy
 * w wyzwalaczach, których test na bazie nie sprawdzał komunikatem (lista
 * `BEZ_KOMUNIKATU` w `tests/filtr/niezmienniki/wyzwalacze.test.ts`: stan
 * `brak` albo `kod`, czyli test sprawdzał tylko kod błędu, sam błąd albo
 * wzorzec wspólny z innymi strażnikami). Każdy przypadek robi zabroniony
 * zapis rolą, która do strażnika dochodzi, i sprawdza jego komunikat.
 *
 * Wyzwalacze BEFORE tej samej tabeli działają w kolejności nazw. Na
 * `expenses`: a_guard_expense_payment (UPDATE), a_guard_expense_provenance
 * (INSERT, UPDATE), a_guard_ksef_expense_provenance (UPDATE, DELETE); strażnicy
 * kosztów działają tylko dla klienta, a klient nie ma uprawnienia INSERT na
 * kosztach (zapisuje je przez RPC), więc sprawdzamy ich gałęzie UPDATE i DELETE. Strażnicy wpłat, wyciągu i kasy działają
 * dla każdej roli, a dowodu kasowego i kasy klient nie zmienia wcale (granty),
 * więc tam zapis robi serwis albo właściciel bazy.
 */

const hasDatabase = Boolean(
  process.env.RLS_TEST_SUPABASE_URL?.trim() &&
    process.env.RLS_TEST_SUPABASE_ANON_KEY?.trim() &&
    process.env.RLS_TEST_SUPABASE_SERVICE_ROLE_KEY?.trim(),
);
const hasDirectDb = hasDatabase && Boolean(process.env.RLS_TEST_DATABASE_URL?.trim());
const environment = hasDatabase ? getRlsTestEnvironment() : null;
const admin: SupabaseClient = environment
  ? createClient(environment.url, environment.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : (null as unknown as SupabaseClient);

const ORG = '00024024-0000-4000-8000-000000000002';
const OWNER_EMAIL = 'rls-fz024-koszty-owner@ksef-saas.test';
const PASS = 'RlsFz024KosztyPass2026Aa!';
/** Fikcyjny NIP z poprawną sumą kontrolną, tylko w tym pliku. */
const NIP_FIRMY = '0002402412';
const ADDRESS = { countryCode: 'PL', addressLine1: 'ul. Przykładowa 1', addressLine2: '00-001 Warszawa' };

let ownerId = '';
let owner: SupabaseClient;
let counter = 0;

async function userId(email: string): Promise<string> {
  for (let page = 1; page < 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < 1000) break;
  }
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASS, email_confirm: true });
  if (error || !data.user) throw error ?? new Error('createUser');
  return data.user.id;
}

async function signedIn(email: string): Promise<SupabaseClient> {
  const c = createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-active-org': ORG } },
  });
  const { error } = await c.auth.signInWithPassword({ email, password: PASS });
  if (error) throw error;
  return c;
}

const nextId = () => {
  counter += 1;
  return `00024024-bbbb-4000-8000-${String(counter).padStart(12, '0')}`;
};

/** Koszt firmy ORG; `patch` nadpisuje pola. */
function expenseRow(patch: Record<string, unknown> = {}): Record<string, unknown> {
  const id = nextId();
  return {
    id, tenant_id: ORG, created_by: ownerId, source: 'manual', seller_name: `Dostawca ${counter}`, seller_nip: '1234567890',
    document_number: `FV/FZ024/${counter}`, document_type: 'invoice', issue_date: '2026-11-01',
    net_amount: 1000, vat_amount: 230, gross_amount: 1230, ...patch,
  };
}

async function expense(patch: Record<string, unknown> = {}): Promise<string> {
  const row = expenseRow(patch);
  const { error } = await admin.from('expenses').insert(row);
  if (error) throw new Error(`insert expenses: ${error.message}`);
  return row.id as string;
}

/** Faktura sprzedaży przyjęta w KSeF (jak w `tests/rls-kasa.test.ts`). */
async function invoice(): Promise<string> {
  const id = nextId();
  const number = `FZ024K/${counter}`;
  const { error } = await admin.from('invoices').insert({
    id, tenant_id: ORG, direction: 'outgoing', origin: 'app', internal_number: number, invoice_type: 'VAT', invoice_kind: 'regular',
    issue_date: '2026-11-01', payment_due_date: '2026-11-15', seller_nip: NIP_FIRMY, buyer_nip: '1234567890',
    gross_total: 1230, net_total: 1000, vat_total: 230, currency: 'PLN',
    fa3_data: { internalNumber: number, type: 'VAT' }, seller_data: { nip: NIP_FIRMY }, buyer_data: { nip: '1234567890', name: 'Nabywca Testowy', address: ADDRESS },
    ksef_status: 'accepted', ksef_environment: 'test', xml_storage_path: 'x.xml', ksef_number: `${NIP_FIRMY}-20261101-${String(counter).padStart(12, '0')}-24`,
  });
  if (error) throw new Error(`insert invoices: ${error.message}`);
  return id;
}

/** Wpływ z wyciągu (plik banku), bez danych osób trzecich, gdy `redacted`. */
async function bankOperation(redacted = false): Promise<string> {
  const id = nextId();
  const { error } = await admin.from('payment_imports').insert({
    id, tenant_id: ORG, provider: 'bank_file', transaction_id: `fz024-${randomUUID()}`, account_iban: 'PL61109010140000071219812874',
    account_currency: 'PLN', transaction_date: '2026-11-02', booking_date: '2026-11-02', amount: 1230, currency: 'PLN',
    file_format: 'camt053', import_batch_id: '00024024-cccc-4000-8000-000000000001', is_matched: false, ignored: false,
    ...(redacted
      ? { redacted_at: new Date().toISOString(), title: null, counterparty_name: null, counterparty_account: null, reference: null }
      : { title: 'FV/FZ024', counterparty_name: 'Nabywca Testowy', counterparty_account: 'PL27114020040000300201355387' }),
  });
  if (error) throw new Error(`insert payment_imports: ${error.message}`);
  return id;
}

async function cleanup() {
  await admin.from('cash_documents').delete().eq('tenant_id', ORG);
  await admin.from('cash_registers').delete().eq('tenant_id', ORG);
  await admin.from('payment_imports').delete().eq('tenant_id', ORG);
  await admin.from('payments').delete().eq('tenant_id', ORG);
  await admin.from('expenses').delete().eq('tenant_id', ORG);
  await admin.from('invoices').delete().eq('tenant_id', ORG);
}

describe.skipIf(!hasDatabase)('FZ-024 paczka 2: strażnicy kosztów, wpłat, wyciągu i kasy mówią swoim komunikatem', () => {
  beforeAll(async () => {
    ownerId = await userId(OWNER_EMAIL);
    await cleanup();
    await admin.from('memberships').delete().eq('organization_id', ORG);
    // Wpisy audytu (kasa) zostają po przebiegu, więc firmę dopisujemy, a nie odtwarzamy.
    const { error: tErr } = await admin.from('tenants').upsert([{ id: ORG, nip: NIP_FIRMY, name: 'Firma FZ-024 Koszty', address_json: ADDRESS }], { onConflict: 'id' });
    if (tErr) throw tErr;
    await admin.from('users').upsert([{ id: ownerId, name: 'Owner FZ-024 Koszty' }], { onConflict: 'id' });
    const { error: mErr } = await admin.from('memberships').insert([
      { organization_id: ORG, user_id: ownerId, role: 'owner', status: 'active' },
    ]);
    if (mErr) throw mErr;
    owner = await signedIn(OWNER_EMAIL);
  });

  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await cleanup();
    await admin.from('memberships').delete().eq('organization_id', ORG);
  });

  describe('koszty (strażnicy tylko dla klienta)', () => {
    it('guard_expense_provenance: klient zmienia źródło zwykłego kosztu, odmowa', async () => {
      // Gałąź INSERT („KSeF expense provenance requires a trusted server”) zasłania brak uprawnienia INSERT
      // dla klienta („permission denied for table expenses”): koszty klient zapisuje przez RPC.
      const id = await expense();
      const { error } = await owner.from('expenses').update({ source: 'ocr_photo' }).eq('id', id).select('id');
      expect(error?.message).toBe('Expense provenance cannot be changed by client');
      expect((await admin.from('expenses').select('source').eq('id', id).single()).data?.source).toBe('manual');
    });

    it('guard_ksef_expense_provenance: klient poprawia koszt ze Skrzynki KSeF, odmowa', async () => {
      // Źródło i firma bez zmian, więc a_guard_expense_provenance przepuszcza; płatności nie ruszamy.
      const id = await expense({ source: 'ksef_inbox' });
      const { error } = await owner.from('expenses').update({ seller_name: 'Inny dostawca' }).eq('id', id).select('id');
      expect(error?.message).toBe('KSeF expense review is server-managed');
    });

    it('guard_ksef_expense_provenance: klient usuwa koszt ze Skrzynki KSeF, odmowa i koszt zostaje', async () => {
      const id = await expense({ source: 'ksef_inbox' });
      const { error } = await owner.from('expenses').delete().eq('id', id).select('id');
      expect(error?.message).toBe('KSeF expense evidence is server-managed');
      expect((await admin.from('expenses').select('id').eq('id', id)).data).toHaveLength(1);
    });

    it('guard_expense_payment_columns: klient wpisuje datę zapłaty kosztu wprost, odmowa', async () => {
      const id = await expense();
      const { error } = await owner.from('expenses').update({ paid_at: '2026-11-05T10:00:00Z' }).eq('id', id).select('id');
      expect(error?.message).toBe('Expense payment fields are server-managed');
      expect((await admin.from('expenses').select('paid_at').eq('id', id).single()).data?.paid_at).toBeNull();
    });
  });

  describe('guard_payment_voided (wpłata do faktury)', () => {
    it('cofniętej wpłaty nie zmieni nawet serwis', async () => {
      const id = await invoice();
      const { data, error: insertError } = await admin.from('payments').insert({
        tenant_id: ORG, invoice_id: id, amount: 500, payment_date: '2026-11-05', is_confirmed: true, match_method: 'manual_entry',
        voided_at: new Date().toISOString(),
      }).select('id').single();
      expect(insertError).toBeNull();
      const { error } = await admin.from('payments').update({ amount: 1 }).eq('id', data!.id as string);
      expect(error?.message).toBe('Voided payment is read-only');
    });

    it('klucza i autora wpłaty nie zmieni nawet serwis', async () => {
      const id = await invoice();
      const { data, error: insertError } = await admin.from('payments').insert({
        tenant_id: ORG, invoice_id: id, amount: 500, payment_date: '2026-11-05', is_confirmed: true, match_method: 'manual_entry',
        idempotency_key: randomUUID(), created_by: ownerId,
      }).select('id').single();
      expect(insertError).toBeNull();
      const { error } = await admin.from('payments').update({ idempotency_key: randomUUID() }).eq('id', data!.id as string);
      expect(error?.message).toBe('Payment key and author are immutable');
    });
  });

  describe('guard_payment_import_update (operacja z wyciągu)', () => {
    it('kwoty operacji z wyciągu nie zmieni nawet serwis', async () => {
      const id = await bankOperation();
      const { error } = await admin.from('payment_imports').update({ amount: 1 }).eq('id', id);
      expect(error?.message).toBe('Bank operation evidence is immutable');
      expect((await admin.from('payment_imports').select('amount').eq('id', id).single()).data?.amount).toBe(1230);
    });

    it('zamaskowana operacja zostaje zamaskowana', async () => {
      const id = await bankOperation(true);
      const { error } = await admin.from('payment_imports').update({ redacted_at: null }).eq('id', id);
      expect(error?.message).toBe('Redacted bank operation stays redacted');
    });
  });

  describe.skipIf(!hasDirectDb)('kasa: dowód i stan początkowy (właściciel bazy, wyzwalacz działa dla każdej roli)', () => {
    interface Db { executeSql(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> }
    let boss: PgBoss;
    const db = () => boss.getDb() as unknown as Db;

    beforeAll(async () => {
      boss = new PgBoss({ connectionString: getRlsTestDatabaseUrl(), schema: 'pgboss', schedule: false, supervise: false });
      await boss.start();
    });

    afterAll(async () => {
      await boss?.stop({ graceful: false, close: true });
    });

    /** Kasa otwarta i jeden KP wystawiony przez właściciela firmy (RPC jak w `tests/rls-kasa.test.ts`). */
    async function kasaZDowodem(): Promise<{ documentId: string; number: string }> {
      const opened = await owner.rpc('open_cash_register', { p_opening_date: '2026-10-01', p_opening_balance: 500 });
      if (opened.error) throw new Error(`open_cash_register: ${opened.error.message}`);
      const issued = await owner.rpc('issue_cash_document', {
        p_kind: 'KP', p_idempotency_key: randomUUID(), p_operation_date: '2026-11-02', p_amount: 100, p_title: 'Wpłata gotówki',
        p_counterparty: { name: 'Jan Kowalski', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa' },
        p_related_document: null, p_invoice_id: null, p_payment_id: null,
      });
      if (issued.error) throw new Error(`issue_cash_document: ${issued.error.message}`);
      const wynik = issued.data as { document_id?: string; number?: string };
      if (!wynik.document_id || !wynik.number) throw new Error(`issue_cash_document: ${JSON.stringify(issued.data)}`);
      return { documentId: wynik.document_id, number: wynik.number };
    }

    it('guard_cash_document_update: wystawionego dowodu nie zmieni nawet właściciel bazy; komunikat z numerem dowodu', async () => {
      const { documentId, number } = await kasaZDowodem();
      await expect(db().executeSql("UPDATE public.cash_documents SET title = 'Inny tytuł' WHERE id = $1", [documentId]))
        .rejects.toThrow(`Cash document ${number} is issued and cannot be changed; issue a correction instead`);
    });

    it('guard_cash_register_update: stan początkowy zablokowany po pierwszym dowodzie, tożsamość kasy bez zmian', async () => {
      await kasaZDowodem();
      await expect(db().executeSql('UPDATE public.cash_registers SET opening_balance = 1 WHERE tenant_id = $1', [ORG]))
        .rejects.toThrow('Cash register opening balance is locked after the first document');
      await expect(db().executeSql("UPDATE public.cash_registers SET currency = 'EUR' WHERE tenant_id = $1", [ORG]))
        .rejects.toThrow('Cash register identity cannot be changed');
    });
  });
});
