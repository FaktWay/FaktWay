import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00208 na prawdziwej bazie: własny szablon maila z fakturą (plan kompletnej
 * aplikacji, krok 2.8). Tabela `invoice_email_templates`, jeden wiersz na firmę.
 *
 * Niezmienniki: odczyt ma każdy aktywny członek aktywnej firmy (mail wysyła też
 * członek), zapis, zmianę i usunięcie tylko właściciel i administrator; obca
 * firma nie widzi i nie zmienia; temat w jednym wierszu i w granicach długości.
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

const ORG = '00208208-0000-4000-8000-000000000001';
const OTHER_ORG = '00208208-0000-4000-8000-000000000002';
const PASS = 'RlsSzablonMailaPass2026Aa!';
const EMAILS = {
  owner: 'rls-szablon-owner@ksef-saas.test',
  admin: 'rls-szablon-admin@ksef-saas.test',
  member: 'rls-szablon-member@ksef-saas.test',
  accountant: 'rls-szablon-accountant@ksef-saas.test',
  other: 'rls-szablon-other@ksef-saas.test',
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

const wiersz = (tenant: string, o: Record<string, unknown> = {}) => ({
  tenant_id: tenant,
  subject: 'Faktura {numer}',
  body: 'Dzień dobry,\n\nW załączniku faktura {numer} na {kwota}.',
  ...o,
});

async function szablony(org: string) {
  const { data, error } = await admin.from('invoice_email_templates').select('tenant_id, subject, body, updated_by').eq('tenant_id', org);
  if (error) throw error;
  return data ?? [];
}

async function sprzataj() {
  for (const org of [ORG, OTHER_ORG]) {
    await admin.from('invoice_email_templates').delete().eq('tenant_id', org);
    await admin.from('memberships').delete().eq('organization_id', org);
  }
}

describe.skipIf(!hasDatabase)('00208: szablon maila z fakturą na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    for (const who of Object.keys(EMAILS) as Who[]) ids[who] = await userId(EMAILS[who]);
    await sprzataj();
    const tenants = await admin.from('tenants').upsert(
      [
        { id: ORG, nip: '9480000224', name: 'Firma Szablon 00208' },
        { id: OTHER_ORG, nip: '9480000230', name: 'Inna firma 00208' },
      ],
      { onConflict: 'id' },
    );
    if (tenants.error) throw tenants.error;
    const profiles = await admin.from('users').upsert(
      (Object.keys(ids) as Who[]).map((who) => ({ id: ids[who], name: `Szablon ${who}` })),
      { onConflict: 'id' },
    );
    if (profiles.error) throw profiles.error;
    const members = await admin.from('memberships').insert([
      { organization_id: ORG, user_id: ids.owner, role: 'owner', status: 'active' },
      { organization_id: ORG, user_id: ids.admin, role: 'admin', status: 'active' },
      { organization_id: ORG, user_id: ids.member, role: 'member', status: 'active' },
      { organization_id: ORG, user_id: ids.accountant, role: 'accountant', status: 'active' },
      { organization_id: OTHER_ORG, user_id: ids.other, role: 'owner', status: 'active' },
    ]);
    if (members.error) throw members.error;
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await sprzataj();
  });

  it('właściciel zapisuje szablon, a ponowny zapis nadpisuje ten sam wiersz', async () => {
    const owner = await signedIn('owner', ORG);
    const opcje = { onConflict: 'tenant_id' };
    expect((await owner.from('invoice_email_templates').upsert({ ...wiersz(ORG), updated_by: ids.owner }, opcje)).error).toBeNull();
    expect((await owner.from('invoice_email_templates').upsert({ ...wiersz(ORG, { subject: 'Inny {numer}' }), updated_by: ids.owner }, opcje)).error).toBeNull();
    const wiersze = await szablony(ORG);
    expect(wiersze).toHaveLength(1);
    expect(wiersze[0]).toMatchObject({ subject: 'Inny {numer}', updated_by: ids.owner });
  });

  it('administrator zmienia szablon', async () => {
    const adm = await signedIn('admin', ORG);
    const r = await adm.from('invoice_email_templates').update({ subject: 'Od administratora {numer}' }).eq('tenant_id', ORG).select('subject');
    expect(r.error).toBeNull();
    expect(r.data).toEqual([{ subject: 'Od administratora {numer}' }]);
  });

  it('każdy aktywny członek firmy czyta szablon (mail wysyła też członek i księgowa)', async () => {
    for (const who of ['owner', 'admin', 'member', 'accountant'] as Who[]) {
      const klient = await signedIn(who, ORG);
      const r = await klient.from('invoice_email_templates').select('subject');
      expect(r.error).toBeNull();
      expect(r.data).toEqual([{ subject: 'Od administratora {numer}' }]);
    }
  });

  it('członek i księgowa nie zmieniają, nie dopisują i nie usuwają szablonu', async () => {
    for (const who of ['member', 'accountant'] as Who[]) {
      const klient = await signedIn(who, ORG);
      const zmiana = await klient.from('invoice_email_templates').update({ subject: 'Podmiana' }).eq('tenant_id', ORG).select('subject');
      expect(zmiana.data ?? []).toEqual([]);
      await klient.from('invoice_email_templates').delete().eq('tenant_id', ORG);
      expect((await klient.from('invoice_email_templates').upsert(wiersz(ORG, { subject: 'Podmiana' }), { onConflict: 'tenant_id' })).error).not.toBeNull();
    }
    expect((await szablony(ORG)).map((r) => r.subject)).toEqual(['Od administratora {numer}']);
  });

  it('obca firma nie widzi ani nie zmienia szablonu tej firmy', async () => {
    const other = await signedIn('other', OTHER_ORG);
    expect((await other.from('invoice_email_templates').select('subject')).data).toEqual([]);
    expect((await other.from('invoice_email_templates').insert(wiersz(ORG, { subject: 'Obcy' }))).error).not.toBeNull();
    // Nagłówek firmy, w której osoba nie jest członkiem, nie otwiera dostępu.
    const podszyt = await signedIn('other', ORG);
    expect((await podszyt.from('invoice_email_templates').select('subject')).data ?? []).toEqual([]);
    expect((await podszyt.from('invoice_email_templates').upsert(wiersz(ORG, { subject: 'Obcy' }), { onConflict: 'tenant_id' })).error).not.toBeNull();
  });

  it('temat w jednym wierszu, treść niepusta, długości w granicach', async () => {
    const owner = await signedIn('owner', ORG);
    const zleTematy = ['', 'Dwa\nwiersze', 'x'.repeat(121), '   '];
    for (const subject of zleTematy) {
      expect((await owner.from('invoice_email_templates').upsert(wiersz(ORG, { subject }), { onConflict: 'tenant_id' })).error).not.toBeNull();
    }
    for (const body of ['', '   ', 'x'.repeat(2001)]) {
      expect((await owner.from('invoice_email_templates').upsert(wiersz(ORG, { body }), { onConflict: 'tenant_id' })).error).not.toBeNull();
    }
    expect((await szablony(ORG)).map((r) => r.subject)).toEqual(['Od administratora {numer}']);
  });

  it('powrót do domyślnego: właściciel usuwa wiersz', async () => {
    const owner = await signedIn('owner', ORG);
    expect((await owner.from('invoice_email_templates').delete().eq('tenant_id', ORG)).error).toBeNull();
    expect(await szablony(ORG)).toEqual([]);
  });

  it('bez logowania tabela jest zamknięta', async () => {
    const anon = anonClient(ORG);
    expect((await anon.from('invoice_email_templates').select('subject')).data ?? []).toEqual([]);
    expect((await anon.from('invoice_email_templates').insert(wiersz(ORG))).error).not.toBeNull();
  });
});
