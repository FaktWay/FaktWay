import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * FZ-024, paczka 4 (ostatnia): strażnicy faktur i firmy, których testy na
 * bazie sprawdzały tylko kod błędu (lista `BEZ_KOMUNIKATU`
 * w `tests/filtr/niezmienniki/wyzwalacze.test.ts`, stan `kod`). 42501 daje
 * też odmowa RLS i brak uprawnień, a 23505 indeks unikalny, więc tu każdy
 * przypadek sprawdza komunikat strażnika. Identyfikator zbiorczy i uprawnienie
 * KSeF dostały komunikat w swoich testach (`tests/rls-identyfikator-zbiorczy.test.ts`,
 * `tests/rls-uprawnienia-ksef.test.ts`), bo tam jest już przygotowanie wierszy.
 *
 * Kolejność wyzwalaczy BEFORE na `invoices` (nazwy alfabetycznie):
 * a_guard_billing_invoice_identity, a_guard_invoice_delivery_history,
 * a_guard_invoice_payment_evidence, a_guard_invoice_send_owner,
 * b_guard_invoice_pending_content, c_*, d_guard_invoice_recurring_link,
 * d_guard_invoice_sales_quote_*, e_guard_invoice_number_series_update, …,
 * guard_roz_advance_single_settlement. Szkic bez historii dostawy przechodzi
 * przez strażników a_* i b_* bez zmian treści i stanu, więc zmiana jednej
 * kolumny dochodzi do strażnika tej kolumny.
 */

const hasDatabase = Boolean(
  process.env.RLS_TEST_SUPABASE_URL?.trim() &&
    process.env.RLS_TEST_SUPABASE_ANON_KEY?.trim() &&
    process.env.RLS_TEST_SUPABASE_SERVICE_ROLE_KEY?.trim(),
);
const environment = hasDatabase ? getRlsTestEnvironment() : null;
const admin: SupabaseClient = environment
  ? createClient(environment.url, environment.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : (null as unknown as SupabaseClient);

const ORG = '00024024-0000-4000-8000-000000000004';
const OWNER_EMAIL = 'rls-fz024-firma-owner@ksef-saas.test';
const PASS = 'RlsFz024FirmaPass2026Aa!';
/** Fikcyjny NIP z poprawną sumą kontrolną, tylko w tym pliku. */
const NIP_FIRMY = '0002402435';

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

/** Wiersz faktury firmy ORG; `patch` nadpisuje pola. */
function invoiceRow(patch: Record<string, unknown> = {}): Record<string, unknown> {
  counter += 1;
  const number = `FZ024F/${counter}`;
  return {
    id: `00024024-dddd-4000-8000-${String(counter).padStart(12, '0')}`, tenant_id: ORG, direction: 'outgoing', internal_number: number,
    invoice_type: 'VAT', issue_date: '2026-11-01', seller_nip: NIP_FIRMY, buyer_nip: '1234567890',
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

async function stan(id: string, kolumny: string): Promise<Record<string, unknown>> {
  const { data, error } = await admin.from('invoices').select(kolumny).eq('id', id).single();
  if (error) throw error;
  return data as unknown as Record<string, unknown>;
}

async function cleanup() {
  await admin.from('invoices').update({ ksef_status: 'draft', ksef_send_owner: null })
    .eq('tenant_id', ORG).in('ksef_status', ['queued', 'offline_queued', 'sending']);
  await admin.from('invoices').delete().eq('tenant_id', ORG).eq('invoice_kind', 'final');
  await admin.from('invoices').delete().eq('tenant_id', ORG);
  // Firma jest dopisywana, nie odtwarzana: pola z przypadków firmy wracają do pustych (strażnicy działają tylko dla klienta).
  await admin.from('tenants').update({ first_invoice_accepted_at: null, logo_storage_key: null }).eq('id', ORG);
}

describe.skipIf(!hasDatabase)('FZ-024 paczka 4: strażnicy faktur i firmy mówią swoim komunikatem', () => {
  beforeAll(async () => {
    ownerId = await userId(OWNER_EMAIL);
    await cleanup();
    await admin.from('memberships').delete().eq('organization_id', ORG);
    const { error: tErr } = await admin.from('tenants').upsert([{ id: ORG, nip: NIP_FIRMY, name: 'Firma FZ-024 Firma' }], { onConflict: 'id' });
    if (tErr) throw tErr;
    await admin.from('users').upsert([{ id: ownerId, name: 'Owner FZ-024 Firma' }], { onConflict: 'id' });
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

  describe('guard_invoice_delivery_history (historia dostawy do KSeF)', () => {
    it('klient przestawia stan szkicu: odmowa, szkic zostaje szkicem', async () => {
      const id = await invoice();
      const { error } = await owner.from('invoices').update({ ksef_status: 'queued' }).eq('id', id).select('id');
      expect(error?.message).toBe('KSeF delivery transition is server-managed');
      expect(await stan(id, 'ksef_status')).toMatchObject({ ksef_status: 'draft' });
    });

    it('klient zmienia treść faktury odrzuconej przez KSeF: odmowa', async () => {
      const id = await invoice({ ksef_status: 'failed', notes: 'przed' });
      const { error } = await owner.from('invoices').update({ notes: 'po' }).eq('id', id).select('id');
      expect(error?.message).toBe('KSeF legal content with delivery history is immutable');
      expect(await stan(id, 'notes')).toMatchObject({ notes: 'przed' });
    });

    it('klient wpisuje diagnostykę wysyłki: odmowa', async () => {
      const id = await invoice();
      const { error } = await owner.from('invoices').update({ last_error: 'podrobione' }).eq('id', id).select('id');
      expect(error?.message).toBe('KSeF delivery diagnostics are server-managed');
    });
  });

  it('guard_invoice_payment_evidence: klient wpisuje zapłaconą kwotę wprost, odmowa', async () => {
    // Szkic bez historii: strażnik historii dostawy przepuszcza (treść, stan i diagnostyka bez zmian).
    const id = await invoice();
    const { error } = await owner.from('invoices').update({ paid_amount: 123 }).eq('id', id).select('id');
    expect(error?.message).toBe('Payment state is server-managed');
    expect(await stan(id, 'paid_amount')).toMatchObject({ paid_amount: 0 });
  });

  it('guard_invoice_send_owner: klient wpisuje właściciela wysyłki, odmowa', async () => {
    const id = await invoice();
    const { error } = await owner.from('invoices').update({ ksef_send_owner: randomUUID() }).eq('id', id).select('id');
    expect(error?.message).toBe('KSeF send claim is server-managed');
    expect(await stan(id, 'ksef_send_owner')).toMatchObject({ ksef_send_owner: null });
  });

  it('guard_invoice_recurring_link: klient przepina szkic do okresu faktury cyklicznej, odmowa', async () => {
    const id = await invoice();
    const { error } = await owner.from('invoices').update({ recurring_period: '2026-11' }).eq('id', id).select('id');
    expect(error?.message).toBe('Recurring invoice link is set only when the invoice is created');
  });

  it('guard_invoice_sales_quote_update: klient dopisuje szkicowi numer proformy, odmowa', async () => {
    const id = await invoice();
    const { error } = await owner.from('invoices').update({ sales_quote_seq: 1 }).eq('id', id).select('id');
    expect(error?.message).toBe('Sales quote link is set only when the invoice is created');
  });

  it('guard_invoice_number_series_update: klient zmienia licznik numeracji szkicu, odmowa', async () => {
    const id = await invoice();
    const { error } = await owner.from('invoices').update({ number_counter: 99 }).eq('id', id).select('id');
    expect(error?.message).toBe('invoice_number_series_locked');
    expect(error?.details).toBe('Seria, okres, licznik i klucz zapisu ustawia tylko zapis faktury.');
  });

  it('guard_roz_advance_single_settlement: faktura rozliczeniowa z tą samą zaliczką dwa razy, odmowa 23505 także dla serwisu', async () => {
    // Przy INSERT serwisu strażnicy a_* i b_* przepuszczają, więc pierwszy odmawia ten strażnik (przed indeksami unikalnymi).
    const zaliczka = await invoice({ invoice_kind: 'advance', invoice_type: 'ZAL', advance_amount: 123 });
    const row = invoiceRow({ invoice_kind: 'final', invoice_type: 'ROZ', advance_invoice_ids: [zaliczka, zaliczka] });
    const { error } = await admin.from('invoices').insert(row);
    expect(error?.code).toBe('23505');
    expect(error?.message).toBe('Final invoice lists the same advance invoice twice');
  });

  describe('firma', () => {
    it('guard_tenant_first_invoice_accepted_at: właściciel firmy wpisuje datę pierwszej przyjętej faktury, odmowa', async () => {
      const { error } = await owner.from('tenants').update({ first_invoice_accepted_at: '2026-11-01T10:00:00Z' }).eq('id', ORG).select('id');
      expect(error?.message).toBe('first_invoice_accepted_at requires a trusted server');
    });

    it('guard_tenant_logo_storage_key: właściciel firmy wpisuje klucz logo wprost, odmowa', async () => {
      const { error } = await owner.from('tenants').update({ logo_storage_key: `${ORG}/logo/podrobione.png` }).eq('id', ORG).select('id');
      expect(error?.message).toBe('tenant_logo_requires_trusted_server');
    });
  });
});
