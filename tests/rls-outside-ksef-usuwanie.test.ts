import { randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * Plan kompletnej aplikacji, krok 1.6 część 2b, zabezpieczenia (00224, D23):
 * właściciel firmy usuwa SESJĄ KLIENTA własny wpis `origin = 'outside_ksef'`
 * (polityka DELETE plus wyjątek w wyzwalaczach 00132), a tylko taki. Zwykła
 * faktura przyjęta w KSeF zostaje nieusuwalna, cudzy wpis też, a szkic usuwa się
 * jak dotąd. Czerwony przed 00224: baza odmawia usunięcia wpisu spoza KSeF.
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

const ORG = '00223223-0000-4000-8000-00000000000a';
const OTHER_ORG = '00223223-0000-4000-8000-00000000000b';
const PASS = 'RlsOutsideKsefPass2026Aa!';
const EMAILS = { owner: 'rls-outside-owner@ksef-saas.test', other: 'rls-outside-other@ksef-saas.test' } as const;
type Who = keyof typeof EMAILS;
const ids = {} as Record<Who, string>;

type Pola = Record<string, unknown>;

function wpis(org: string, pola: Pola = {}): Pola {
  return {
    id: randomUUID(), tenant_id: org, direction: 'outgoing', origin: 'outside_ksef', internal_number: `FV/${randomUUID().slice(0, 8)}/2026`,
    invoice_type: 'VAT', invoice_kind: 'regular', issue_date: '2026-03-10', seller_nip: '5260223001', buyer_nip: '1234567890',
    currency: 'PLN', net_total: 100, vat_total: 23, gross_total: 123, ksef_status: 'accepted', ksef_environment: 'test',
    ksef_number: null, xml_storage_path: null, fa3_data: { _source: 'outside-ksef' }, ...pola,
  };
}

async function wstaw(org: string, pola: Pola = {}): Promise<string> {
  const row = wpis(org, pola);
  const { error } = await admin.from('invoices').insert(row);
  if (error) throw new Error(`wstaw: ${error.message}`);
  return row.id as string;
}

async function zalogowany(who: Who, org: string): Promise<SupabaseClient> {
  const client = createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-active-org': org } },
  });
  const { error } = await client.auth.signInWithPassword({ email: EMAILS[who], password: PASS });
  if (error) throw error;
  return client;
}

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

async function jestWBazie(id: string): Promise<boolean> {
  const { data, error } = await admin.from('invoices').select('id').eq('id', id).maybeSingle();
  if (error) throw error;
  return data !== null;
}

/** Usunięcie sesją klienta: wynik to liczba usuniętych wierszy albo odmowa bazy. */
async function usunSesja(client: SupabaseClient, id: string): Promise<{ usuniete: number; odmowa: string | null }> {
  const { data, error } = await client.from('invoices').delete().eq('id', id).select('id');
  return { usuniete: data?.length ?? 0, odmowa: error?.message ?? null };
}

async function sprzataj() {
  for (const org of [ORG, OTHER_ORG]) {
    const { error } = await admin.from('invoices').delete().eq('tenant_id', org);
    if (error) throw new Error(`sprzątanie invoices: ${error.message}`);
  }
}

describe.skipIf(!hasDatabase)('00224: właściciel usuwa wpis spoza KSeF sesją klienta (D23)', () => {
  beforeAll(async () => {
    for (const who of Object.keys(EMAILS) as Who[]) ids[who] = await userId(EMAILS[who]);
    await sprzataj();
    await admin.from('memberships').delete().in('organization_id', [ORG, OTHER_ORG]);
    const tenants = await admin.from('tenants').upsert(
      [
        { id: ORG, nip: '5260223001', name: 'Firma 00224 A', ksef_verified_at: '2026-01-01T00:00:00Z', ksef_verified_environment: 'test' },
        { id: OTHER_ORG, nip: '5260223002', name: 'Firma 00224 B', ksef_verified_at: null, ksef_verified_environment: null },
      ],
      { onConflict: 'id' },
    );
    if (tenants.error) throw tenants.error;
    const profiles = await admin.from('users').upsert(
      [{ id: ids.owner, name: 'Olga Outside' }, { id: ids.other, name: 'Oskar Obcy' }],
      { onConflict: 'id' },
    );
    if (profiles.error) throw profiles.error;
    const members = await admin.from('memberships').insert([
      { organization_id: ORG, user_id: ids.owner, role: 'owner', status: 'active' },
      { organization_id: OTHER_ORG, user_id: ids.other, role: 'owner', status: 'active' },
    ]);
    if (members.error) throw members.error;
  }, 60_000);

  beforeEach(sprzataj);
  afterAll(async () => {
    if (!hasDatabase) return;
    await sprzataj();
    await admin.from('memberships').delete().in('organization_id', [ORG, OTHER_ORG]);
  });

  it('właściciel usuwa własny wpis spoza KSeF, pozycje znikają kaskadą', async () => {
    const id = await wstaw(ORG);
    const { error } = await admin.from('invoice_line_items').insert({
      invoice_id: id, ordinal: 1, name: 'Usługa', quantity: 1, unit: 'szt.', unit_price_net: 100, vat_rate: '23', net_amount: 100, vat_amount: 23, gross_amount: 123,
    });
    expect(error?.message ?? null).toBeNull();

    const wynik = await usunSesja(await zalogowany('owner', ORG), id);
    expect(wynik).toEqual({ usuniete: 1, odmowa: null });
    expect(await jestWBazie(id)).toBe(false);
    const { data: pozycje } = await admin.from('invoice_line_items').select('id').eq('invoice_id', id);
    expect(pozycje).toEqual([]);
  });

  it('cudzy wpis spoza KSeF zostaje (inna firma nie usuwa)', async () => {
    const id = await wstaw(ORG);
    const wynik = await usunSesja(await zalogowany('other', OTHER_ORG), id);
    expect(wynik.usuniete).toBe(0);
    expect(await jestWBazie(id)).toBe(true);
  });

  it('zwykła faktura przyjęta w KSeF zostaje nieusuwalna dla klienta', async () => {
    const id = await wstaw(ORG, {
      origin: 'app', ksef_number: `5260223001-20260310-${randomUUID().slice(0, 6).toUpperCase()}-01`, xml_storage_path: `${ORG}/${randomUUID()}.xml`,
      submitted_to_ksef_at: '2026-03-10T10:00:00Z', ksef_accepted_at: '2026-03-10T10:01:00Z',
    });
    const wynik = await usunSesja(await zalogowany('owner', ORG), id);
    expect(wynik.usuniete).toBe(0);
    expect(await jestWBazie(id)).toBe(true);
  });

  it('szkic usuwa się jak dotąd (polityka 00002 nietknięta)', async () => {
    const id = await wstaw(ORG, { origin: 'app', ksef_status: 'draft', ksef_environment: null });
    const wynik = await usunSesja(await zalogowany('owner', ORG), id);
    expect(wynik).toEqual({ usuniete: 1, odmowa: null });
  });

  it('operator (service_role) też usuwa wpis spoza KSeF: ścieżka awaryjna', async () => {
    const id = await wstaw(ORG);
    const { error } = await admin.from('invoices').delete().eq('id', id);
    expect(error).toBeNull();
    expect(await jestWBazie(id)).toBe(false);
  });
});
