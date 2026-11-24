import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { PgBoss } from 'pg-boss';

import { getRlsTestDatabaseUrl, getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * FZ-024, paczka 1 (faktury i KSeF): strażnicy w wyzwalaczach, których żaden
 * test na bazie nie sprawdzał komunikatem (lista `BEZ_KOMUNIKATU`
 * w `tests/filtr/niezmienniki/wyzwalacze.test.ts`). Każdy przypadek robi
 * zabroniony zapis rolą, która do tego strażnika dochodzi, i sprawdza jego
 * komunikat: sam kod 42501 daje też odmowa RLS i brak uprawnień, więc nie
 * odróżnia strażnika od polityki.
 *
 * Wyzwalacze BEFORE tej samej tabeli działają w kolejności nazw, więc przy
 * każdym przypadku stoi, dlaczego wcześniejszy strażnik go nie zatrzymuje.
 * Rola serwisu (`service_role`) omija strażników „tylko klient”
 * (`a_guard_invoice_delivery_history`, `a_guard_historical_ksef_invoice_lines`),
 * a właściciel bazy (`postgres`) także gałęzie z `current_user <> 'postgres'`.
 *
 * Pokrycie liczy się na funkcję, więc niektóre gałęzie, do których dochodzi serwis,
 * zostają bez testu: wejście w `accepted` bez środowiska przez UPDATE (00117),
 * „KSeF verification cannot be cleared” i „KSeF proof environment cannot be cleared”
 * (23514), „Accepted KSeF invoice cannot re-enter Offline24 queue” i „Downloaded UPO
 * requires accepted invoice provenance”. Gałąź „Accepted invoice legal references are
 * immutable” (00118) zasłaniają dla klienta wcześniejsze porównania treści
 * (`a_guard_invoice_delivery_history`, `b_guard_invoice_pending_content`).
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

const ORG = '00024024-0000-4000-8000-000000000001';
const OWNER_EMAIL = 'rls-fz024-owner@ksef-saas.test';
const PASS = 'RlsFz024StraznicyPass2026Aa!';
/** Fikcyjny NIP z poprawną sumą kontrolną, tylko w tym pliku (unikalny jest tylko NIP firmy zweryfikowanej w KSeF, 00117). */
const NIP_FIRMY = '0002402406';

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
  return `00024024-aaaa-4000-8000-${String(counter).padStart(12, '0')}`;
};

/** Faktura sprzedaży firmy ORG (wiersz jak z formularza); `patch` nadpisuje pola. */
function invoiceRow(patch: Record<string, unknown> = {}): Record<string, unknown> {
  const id = nextId();
  const number = `FZ024/${counter}`;
  return {
    id, tenant_id: ORG, direction: 'outgoing', internal_number: number, invoice_type: 'VAT',
    issue_date: '2026-10-01', seller_nip: NIP_FIRMY, buyer_nip: '1234567890',
    gross_total: 123, net_total: 100, vat_total: 23, ksef_status: 'draft',
    fa3_data: { internalNumber: number, type: 'VAT' }, seller_data: { nip: NIP_FIRMY }, buyer_data: { nip: '1234567890' },
    ...patch,
  };
}

/** Faktura wstawiona serwisem; zwraca id. */
async function invoice(patch: Record<string, unknown> = {}): Promise<string> {
  const row = invoiceRow(patch);
  const { error } = await admin.from('invoices').insert(row);
  if (error) throw new Error(`insert invoices: ${error.message}`);
  return row.id as string;
}

/** Faktura przyjęta w KSeF w środowisku testowym (wstawiana serwisem, ze środowiskiem). */
const accepted = (patch: Record<string, unknown> = {}) =>
  invoice({
    ksef_status: 'accepted', ksef_environment: 'test', ksef_number: `${NIP_FIRMY}-20261001-${String(counter + 1).padStart(12, '0')}-AB`,
    ksef_accepted_at: '2026-10-01T10:00:00Z', ...patch,
  });

async function line(invoiceId: string, patch: Record<string, unknown> = {}): Promise<string> {
  const id = nextId();
  const { error } = await admin.from('invoice_line_items').insert({
    id, invoice_id: invoiceId, ordinal: 1, name: 'Usługa', quantity: 1, unit: 'szt',
    unit_price_net: 100, vat_rate: '23', net_amount: 100, vat_amount: 23, gross_amount: 123, ...patch,
  });
  if (error) throw new Error(`insert invoice_line_items: ${error.message}`);
  return id;
}

async function exists(table: string, id: string): Promise<boolean> {
  const { data, error } = await admin.from(table).select('id').eq('id', id).maybeSingle();
  if (error) throw error;
  return data !== null;
}

async function cleanup() {
  await admin.from('upo_receipts').delete().eq('tenant_id', ORG);
  await admin.from('ksef_offline_queue').delete().eq('tenant_id', ORG);
  const { data: invoices } = await admin.from('invoices').select('id').eq('tenant_id', ORG);
  const ids = (invoices ?? []).map((i) => i.id as string);
  if (ids.length > 0) await admin.from('invoice_line_items').delete().in('invoice_id', ids);
  // Faktura w drodze (queued, sending) jest nieusuwalna dla każdej roli: najpierw wraca do szkicu.
  await admin.from('invoices').update({ ksef_status: 'draft', ksef_send_owner: null })
    .eq('tenant_id', ORG).in('ksef_status', ['queued', 'offline_queued', 'sending']);
  await admin.from('invoices').delete().eq('tenant_id', ORG).eq('invoice_kind', 'correction');
  await admin.from('invoices').delete().eq('tenant_id', ORG);
}

describe.skipIf(!hasDatabase)('FZ-024 paczka 1: strażnicy faktur i KSeF mówią swoim komunikatem', () => {
  beforeAll(async () => {
    ownerId = await userId(OWNER_EMAIL);
    await cleanup();
    await admin.from('memberships').delete().eq('organization_id', ORG);
    await admin.from('tenants').delete().eq('id', ORG);
    const { error: tErr } = await admin.from('tenants').insert({ id: ORG, nip: NIP_FIRMY, name: 'Firma FZ-024' });
    if (tErr) throw tErr;
    await admin.from('users').upsert([{ id: ownerId, name: 'Owner FZ-024' }], { onConflict: 'id' });
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
    await admin.from('tenants').delete().eq('id', ORG);
  });

  describe('guard_invoice_pending_content (faktura w drodze do KSeF)', () => {
    it('klient wstawia fakturę od razu w kolejce: odmowa, faktury nie ma', async () => {
      // a_guard_invoice_delivery_history przy INSERT patrzy tylko na diagnostykę, a_guard_invoice_payment_evidence
      // na płatność i stan accepted, więc pierwszy odmawia strażnik treści w drodze.
      const row = invoiceRow({ ksef_status: 'queued' });
      const { error } = await owner.from('invoices').insert(row);
      expect(error?.message).toBe('Client invoice must start as a draft without KSeF delivery evidence');
      expect(await exists('invoices', row.id as string)).toBe(false);
    });

    it('klient zmienia treść faktury w kolejce: odmowa, treść bez zmian', async () => {
      // Faktura queued bez pól wysyłki nie ma historii dostawy, więc a_guard_invoice_delivery_history przepuszcza zmianę treści.
      const id = await invoice({ ksef_status: 'queued', notes: 'przed' });
      const { error } = await owner.from('invoices').update({ notes: 'po' }).eq('id', id).select('id');
      expect(error?.message).toBe('KSeF document content is immutable for this role');
      expect((await admin.from('invoices').select('notes').eq('id', id).single()).data?.notes).toBe('przed');
    });

    it('klient wpisuje pole wysyłki na szkicu: odmowa', async () => {
      const id = await invoice();
      const { error } = await owner.from('invoices').update({ xml_storage_path: `${ORG}/xml/podrobiony.xml` }).eq('id', id).select('id');
      expect(error?.message).toBe('KSeF delivery state is server-managed');
    });

    it('serwis usuwa fakturę w kolejce: odmowa, faktura zostaje', async () => {
      // Strażnik historii dostawy działa tylko dla klienta, więc usunięcie przez serwis dochodzi tutaj.
      const id = await invoice({ ksef_status: 'queued' });
      const { error } = await admin.from('invoices').delete().eq('id', id);
      expect(error?.message).toBe('KSeF document cannot be deleted by this role');
      expect(await exists('invoices', id)).toBe(true);
    });
  });

  describe('guard_invoice_correction_parent (rodzaj i rodzic korekty)', () => {
    it('klient przepina szkic pod inną fakturę: odmowa', async () => {
      // Dla zwykłej faktury guard_single_open_correction kończy od razu, a szkic nie ma historii dostawy.
      const parent = await accepted();
      const id = await invoice();
      const { error } = await owner.from('invoices').update({ parent_invoice_id: parent }).eq('id', id).select('id');
      expect(error?.message).toBe('Invoice kind and parent are immutable after creation');
    });

    it('serwis wstawia korektę do szkicu (rodzic bez przyjęcia w KSeF): odmowa 23514', async () => {
      // guard_single_open_correction działa wcześniej i przepuszcza: każdy test ma nowego rodzica bez korekty w toku.
      const parent = await invoice();
      const row = invoiceRow({ invoice_kind: 'correction', invoice_type: 'KOR', parent_invoice_id: parent, correction_reason: 'Zmiana ceny', correction_type: 'amount_change' });
      const { error } = await admin.from('invoices').insert(row);
      expect(error?.code).toBe('23514');
      expect(error?.message).toBe('Correction parent requires same-tenant accepted KSeF invoice with provenance');
      expect(await exists('invoices', row.id as string)).toBe(false);
    });
  });

  describe('guard_invoice_ksef_environment (środowisko przyjętej faktury)', () => {
    it('serwis zapisuje fakturę przyjętą bez środowiska: odmowa', async () => {
      // Gałęzie dla klienta zasłaniają wcześniejsi strażnicy: wstawienie przyjętej faktury a_guard_invoice_payment_evidence,
      // wstawienie ze środowiskiem b_guard_invoice_pending_content („Client invoice must start as a draft…”), zmianę stanu
      // przyjętej faktury a_guard_invoice_delivery_history, a zmianę środowiska i czasu przyjęcia znowu b_guard_invoice_pending_content.
      const row = invoiceRow({ ksef_status: 'accepted', ksef_number: `${NIP_FIRMY}-20261001-000000000099-AB`, ksef_accepted_at: '2026-10-01T10:00:00Z' });
      const { error } = await admin.from('invoices').insert(row);
      expect(error?.message).toBe('Accepted KSeF invoice requires environment provenance');
      expect(await exists('invoices', row.id as string)).toBe(false);
    });

    it('serwis cofa przyjętą fakturę do szkicu: odmowa, faktura dalej przyjęta', async () => {
      // Szkic byłby znowu usuwalny i dałby się wysłać drugi raz. b_guard_invoice_pending_content przepuszcza serwis,
      // c_guard_ksef_retired_draft działa tylko przy OLD = szkic, a strażnik rodzica korekty nie patrzy na ksef_status.
      const id = await accepted();
      const { error } = await admin.from('invoices').update({ ksef_status: 'draft' }).eq('id', id);
      expect(error?.message).toBe('Accepted KSeF invoice status is immutable');
      expect((await admin.from('invoices').select('ksef_status').eq('id', id).single()).data?.ksef_status).toBe('accepted');
    });

    it('serwis zmienia środowisko przyjętej faktury: odmowa', async () => {
      const id = await accepted();
      const { error } = await admin.from('invoices').update({ ksef_environment: 'production' }).eq('id', id);
      expect(error?.message).toBe('KSeF invoice environment cannot be changed');
      expect((await admin.from('invoices').select('ksef_environment').eq('id', id).single()).data?.ksef_environment).toBe('test');
    });
  });

  describe('pozycje faktury', () => {
    it('guard_historical_ksef_invoice_lines: klient zmienia pozycję faktury z historią dostawy (failed)', async () => {
      const id = await invoice({ ksef_status: 'failed' });
      const pozycja = await line(id);
      const { error } = await owner.from('invoice_line_items').update({ name: 'Inna usługa' }).eq('id', pozycja).select('id');
      expect(error?.message).toBe('KSeF invoice lines with delivery history are immutable');
    });

    it('guard_pending_invoice_lines: pozycji faktury w kolejce nie dopisze nawet serwis', async () => {
      // Ten strażnik działa dla każdej roli; strażnik historii (tylko klient) i strażnik abonamentu (bez stripe_invoice_id) przepuszczają.
      const id = await invoice({ ksef_status: 'queued' });
      const { error } = await admin.from('invoice_line_items').insert({ invoice_id: id, ordinal: 2, name: 'Dopisana', quantity: 1, net_amount: 1, vat_amount: 0, gross_amount: 1 });
      expect(error?.message).toBe('Pending KSeF invoice lines are immutable');
    });

    describe.skipIf(!hasDirectDb)('guard_accepted_ksef_invoice_line (faktura przyjęta bez żadnego pola wysyłki)', () => {
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

      it('klient zmienia pozycję faktury przyjętej: odmowa tego strażnika', async () => {
        // Każda inna przyjęta faktura ma numer KSeF, środowisko, czas przyjęcia albo XML (także stara sprzed 00117:
        // ma numer), więc najpierw odmawia a_guard_historical_ksef_invoice_lines. Do tej drugiej zapory dochodzi tylko
        // wiersz przyjęty bez żadnego pola wysyłki; dziś żadna ścieżka aplikacji go nie robi, zapisać go może tylko
        // właściciel bazy (np. ręczne uzgodnienie).
        const row = invoiceRow({ ksef_status: 'accepted' });
        await db().executeSql(
          `INSERT INTO public.invoices (id, tenant_id, direction, internal_number, invoice_type, issue_date, seller_nip, buyer_nip,
             gross_total, net_total, vat_total, ksef_status, fa3_data, seller_data, buyer_data)
           VALUES ($1, $2, 'outgoing', $3, 'VAT', '2026-10-01', $4, '1234567890', 123, 100, 23, 'accepted', $5::jsonb, $6::jsonb, $7::jsonb)`,
          [row.id, ORG, row.internal_number, NIP_FIRMY, JSON.stringify(row.fa3_data), JSON.stringify(row.seller_data), JSON.stringify(row.buyer_data)],
        );
        const pozycja = await line(row.id as string);
        const { error } = await owner.from('invoice_line_items').update({ name: 'Inna usługa' }).eq('id', pozycja).select('id');
        expect(error?.message).toBe('Accepted KSeF invoice lines are server-managed');
      });
    });
  });

  describe('guard_upo_ksef_environment (UPO z KSeF)', () => {
    const upo = (invoiceId: string, patch: Record<string, unknown> = {}) => ({
      tenant_id: ORG, invoice_id: invoiceId, ksef_number: `${NIP_FIRMY}-20261001-000000000001-AB`,
      ksef_acceptance_timestamp: '2026-10-01T10:00:00Z', ...patch,
    });

    it('serwis zapisuje UPO ze środowiskiem innym niż faktura: odmowa', async () => {
      // Klient nie ma uprawnień do zapisu UPO (00117), więc gałęzie dla klienta zatrzymuje wcześniej brak uprawnień.
      const id = await accepted();
      const { error } = await admin.from('upo_receipts').insert(upo(id, { ksef_environment: 'production' }));
      expect(error?.message).toBe('UPO requires an accepted invoice in the same environment');
    });

    it('serwis zmienia środowisko zapisanego UPO: odmowa', async () => {
      const id = await accepted();
      const { data, error: insertError } = await admin.from('upo_receipts').insert(upo(id, { ksef_environment: 'test' })).select('id').single();
      expect(insertError).toBeNull();
      const { error } = await admin.from('upo_receipts').update({ ksef_environment: 'production' }).eq('id', data!.id as string);
      expect(error?.message).toBe('UPO environment is immutable');
    });
  });

  describe('guard_ksef_offline_queue_environment (kolejka Offline24)', () => {
    const wpis = (invoiceId: string, patch: Record<string, unknown> = {}) => ({
      tenant_id: ORG, invoice_id: invoiceId, idempotency_key: `fz024-${nextId()}`, deadline: '2026-10-02T23:59:59Z', ...patch,
    });

    it('serwis wpisuje do kolejki fakturę już przyjętą: odmowa', async () => {
      // Klient nie ma uprawnień do zapisu w kolejce (00117), więc jej gałęzie dla klienta zatrzymuje brak uprawnień.
      const id = await accepted();
      const { error } = await admin.from('ksef_offline_queue').insert(wpis(id, { status: 'queued' }));
      expect(error?.message).toBe('Accepted KSeF invoice cannot enter Offline24 queue');
    });

    it('serwis zmienia środowisko wpisu: odmowa', async () => {
      const id = await invoice();
      const { data, error: insertError } = await admin.from('ksef_offline_queue').insert(wpis(id, { status: 'queued', ksef_environment: 'test' })).select('id').single();
      expect(insertError).toBeNull();
      const { error } = await admin.from('ksef_offline_queue').update({ ksef_environment: 'production' }).eq('id', data!.id as string);
      expect(error?.message).toBe('KSeF offline environment is immutable');
    });
  });

  describe('guard_tenant_ksef_claim_fields (pola KSeF firmy)', () => {
    afterAll(async () => {
      if (!hasDatabase) return;
      await admin.from('tenants').update({ ksef_credentials_encrypted: null }).eq('id', ORG);
    });

    it('właściciel firmy wpisuje sobie weryfikację KSeF: odmowa', async () => {
      const { error } = await owner.from('tenants').update({ ksef_verified_at: '2026-10-01T10:00:00Z' }).eq('id', ORG).select('id');
      expect(error?.message).toBe('KSeF claim fields require a trusted server');
    });

    it('serwis zmienia NIP firmy, która ma poświadczenia KSeF: odmowa 23514', async () => {
      const { error: setError } = await admin.from('tenants').update({ ksef_credentials_encrypted: 'zaszyfrowane-testowe' }).eq('id', ORG);
      expect(setError).toBeNull();
      const { error } = await admin.from('tenants').update({ nip: '1234567890' }).eq('id', ORG);
      expect(error?.code).toBe('23514');
      expect(error?.message).toBe('KSeF NIP with proof or credentials cannot be changed');
    });
  });
});
