import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00207 na prawdziwej bazie: autozapis formularza zwykłej faktury (plan
 * kompletnej aplikacji, krok 2.8). Tabela `invoice_form_drafts` to kopia
 * robocza surowych wartości formularza, jeden wiersz na otwarcie formularza
 * i osobę (PK: firma + osoba + klucz).
 *
 * Niezmienniki: osoba widzi i zmienia tylko własne wiersze w aktywnej firmie
 * (nie widzi ich ani członek tej samej firmy, ani obca firma), ponowny zapis
 * z tym samym kluczem nadpisuje ten sam wiersz (upsert), a wartości muszą być
 * obiektem JSON w granicy rozmiaru.
 */

const hasDatabase = Boolean(
  process.env.RLS_TEST_SUPABASE_URL?.trim() &&
    process.env.RLS_TEST_SUPABASE_ANON_KEY?.trim() &&
    process.env.RLS_TEST_SUPABASE_SERVICE_ROLE_KEY?.trim(),
);
const environment = hasDatabase ? getRlsTestEnvironment() : null;
const admin: SupabaseClient = environment
  ? createClient(environment.url, environment.serviceRoleKey)
  : (null as unknown as SupabaseClient);

const ORG = '00207207-0000-4000-8000-000000000001';
const OTHER_ORG = '00207207-0000-4000-8000-000000000002';
const KEY = '00207207-0000-4000-8000-0000000000a1';
const KEY2 = '00207207-0000-4000-8000-0000000000a2';
const PASS = 'RlsAutozapisPass2026Aa!';
const EMAILS = {
  owner: 'rls-autozapis-owner@ksef-saas.test',
  member: 'rls-autozapis-member@ksef-saas.test',
  other: 'rls-autozapis-other@ksef-saas.test',
} as const;
type Who = keyof typeof EMAILS;
const ids = {} as Record<Who, string>;

function anonClient(activeOrg?: string) {
  return createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: activeOrg ? { headers: { 'x-active-org': activeOrg } } : undefined,
  });
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

async function signedIn(who: Who, org?: string): Promise<SupabaseClient> {
  const client = anonClient(org);
  const { error } = await client.auth.signInWithPassword({ email: EMAILS[who], password: PASS });
  if (error) throw error;
  return client;
}

const wiersz = (tenant: string, user: string, key: string, values: Record<string, unknown> = { buyerName: 'Acme' }) => ({
  tenant_id: tenant,
  user_id: user,
  request_key: key,
  form_values: values,
  updated_at: new Date().toISOString(),
});

async function wszystkie(org: string) {
  const { data, error } = await admin
    .from('invoice_form_drafts')
    .select('tenant_id, user_id, request_key, form_values')
    .eq('tenant_id', org)
    .order('request_key', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function sprzataj() {
  for (const org of [ORG, OTHER_ORG]) {
    await admin.from('invoice_form_drafts').delete().eq('tenant_id', org);
    await admin.from('memberships').delete().eq('organization_id', org);
  }
}

describe.skipIf(!hasDatabase)('00207: autozapis formularza faktury na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    for (const who of Object.keys(EMAILS) as Who[]) ids[who] = await userId(EMAILS[who]);
    await sprzataj();
    const tenants = await admin.from('tenants').upsert(
      [
        { id: ORG, nip: '9480000207', name: 'Firma Autozapis 00207' },
        { id: OTHER_ORG, nip: '9480000213', name: 'Inna firma 00207' },
      ],
      { onConflict: 'id' },
    );
    if (tenants.error) throw tenants.error;
    const profiles = await admin.from('users').upsert(
      (Object.keys(ids) as Who[]).map((who) => ({ id: ids[who], name: `Autozapis ${who}` })),
      { onConflict: 'id' },
    );
    if (profiles.error) throw profiles.error;
    const members = await admin.from('memberships').insert([
      { organization_id: ORG, user_id: ids.owner, role: 'owner', status: 'active' },
      { organization_id: ORG, user_id: ids.member, role: 'member', status: 'active' },
      { organization_id: OTHER_ORG, user_id: ids.other, role: 'owner', status: 'active' },
    ]);
    if (members.error) throw members.error;
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await sprzataj();
  });

  it('osoba zapisuje własną kopię, a ponowny zapis z tym samym kluczem nadpisuje ten sam wiersz', async () => {
    const owner = await signedIn('owner', ORG);
    const opcje = { onConflict: 'tenant_id,user_id,request_key' };
    const pierwszy = await owner.from('invoice_form_drafts').upsert(wiersz(ORG, ids.owner, KEY, { buyerName: 'Acme' }), opcje);
    expect(pierwszy.error).toBeNull();
    const drugi = await owner.from('invoice_form_drafts').upsert(wiersz(ORG, ids.owner, KEY, { buyerName: 'Acme sp. z o.o.' }), opcje);
    expect(drugi.error).toBeNull();
    const wiersze = await wszystkie(ORG);
    expect(wiersze).toHaveLength(1);
    expect(wiersze[0]).toMatchObject({ user_id: ids.owner, request_key: KEY, form_values: { buyerName: 'Acme sp. z o.o.' } });
  });

  it('osoba widzi własną kopię, a członek tej samej firmy cudzej nie widzi', async () => {
    const owner = await signedIn('owner', ORG);
    const member = await signedIn('member', ORG);
    const swoje = await owner.from('invoice_form_drafts').select('request_key');
    expect(swoje.error).toBeNull();
    expect(swoje.data?.map((r) => r.request_key)).toEqual([KEY]);
    const cudze = await member.from('invoice_form_drafts').select('request_key');
    expect(cudze.error).toBeNull();
    expect(cudze.data).toEqual([]);
  });

  it('członek nie zapisze kopii na cudze nazwisko ani nie skasuje cudzej', async () => {
    const member = await signedIn('member', ORG);
    const wpis = await member.from('invoice_form_drafts').insert(wiersz(ORG, ids.owner, KEY2));
    expect(wpis.error).not.toBeNull();
    await member.from('invoice_form_drafts').delete().eq('request_key', KEY);
    expect((await wszystkie(ORG)).map((r) => r.request_key)).toEqual([KEY]);
  });

  it('osoba spoza firmy nie zapisze kopii w tej firmie i nie zobaczy cudzych', async () => {
    const other = await signedIn('other', OTHER_ORG);
    const wpis = await other.from('invoice_form_drafts').insert(wiersz(ORG, ids.other, KEY2));
    expect(wpis.error).not.toBeNull();
    const odczyt = await other.from('invoice_form_drafts').select('request_key');
    expect(odczyt.data).toEqual([]);
    // Nagłówek firmy, w której osoba nie jest członkiem, nie otwiera dostępu.
    const podszyt = await signedIn('other', ORG);
    expect((await podszyt.from('invoice_form_drafts').select('request_key')).data ?? []).toEqual([]);
    expect((await podszyt.from('invoice_form_drafts').insert(wiersz(ORG, ids.other, KEY2))).error).not.toBeNull();
  });

  it('wartości muszą być obiektem JSON w granicy rozmiaru', async () => {
    const owner = await signedIn('owner', ORG);
    const tablica = await owner.from('invoice_form_drafts').insert({ ...wiersz(ORG, ids.owner, KEY2), form_values: [1, 2] });
    expect(tablica.error).not.toBeNull();
    const duzy = await owner.from('invoice_form_drafts').insert(wiersz(ORG, ids.owner, KEY2, { notes: 'x'.repeat(200_001) }));
    expect(duzy.error).not.toBeNull();
    expect((await wszystkie(ORG)).map((r) => r.request_key)).toEqual([KEY]);
  });

  it('osoba kasuje własną kopię', async () => {
    const owner = await signedIn('owner', ORG);
    const skasowano = await owner.from('invoice_form_drafts').delete().eq('request_key', KEY);
    expect(skasowano.error).toBeNull();
    expect(await wszystkie(ORG)).toEqual([]);
  });

  it('bez logowania tabela jest zamknięta', async () => {
    const anon = anonClient(ORG);
    const odczyt = await anon.from('invoice_form_drafts').select('request_key');
    expect(odczyt.data ?? []).toEqual([]);
    const wpis = await anon.from('invoice_form_drafts').insert(wiersz(ORG, ids.owner, KEY2));
    expect(wpis.error).not.toBeNull();
  });
});
