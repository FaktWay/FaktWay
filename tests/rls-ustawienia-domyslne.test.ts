import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00209 na prawdziwej bazie: własny domyślne ustawienia nowej faktury (plan kompletnej
 * aplikacji, krok 2.8). Tabela `tenant_invoice_defaults`, jeden wiersz na firmę.
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

const ORG = '00209208-0000-4000-8000-000000000001';
const OTHER_ORG = '00209208-0000-4000-8000-000000000002';
const PASS = 'RlsUstawieniaPass2026Aa!';
const EMAILS = {
  owner: 'rls-ustawienia-owner@ksef-saas.test',
  admin: 'rls-ustawienia-admin@ksef-saas.test',
  member: 'rls-ustawienia-member@ksef-saas.test',
  accountant: 'rls-ustawienia-accountant@ksef-saas.test',
  other: 'rls-ustawienia-other@ksef-saas.test',
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
  payment_method: 'cash',
  payment_days: 30,
  accountant_copy_email: 'ksiegowa@example.test',
  ...o,
});

async function ustawienia(org: string) {
  const { data, error } = await admin.from('tenant_invoice_defaults').select('tenant_id, payment_method, payment_days, accountant_copy_email, updated_by').eq('tenant_id', org);
  if (error) throw error;
  return data ?? [];
}

async function sprzataj() {
  for (const org of [ORG, OTHER_ORG]) {
    await admin.from('tenant_invoice_defaults').delete().eq('tenant_id', org);
    await admin.from('memberships').delete().eq('organization_id', org);
  }
}

describe.skipIf(!hasDatabase)('00209: domyślne ustawienia nowej faktury na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    for (const who of Object.keys(EMAILS) as Who[]) ids[who] = await userId(EMAILS[who]);
    await sprzataj();
    const tenants = await admin.from('tenants').upsert(
      [
        { id: ORG, nip: '9480000236', name: 'Firma Ustawienia 00209' },
        { id: OTHER_ORG, nip: '9480000242', name: 'Inna firma 00209' },
      ],
      { onConflict: 'id' },
    );
    if (tenants.error) throw tenants.error;
    const profiles = await admin.from('users').upsert(
      (Object.keys(ids) as Who[]).map((who) => ({ id: ids[who], name: `Ustawienia ${who}` })),
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
    expect((await owner.from('tenant_invoice_defaults').upsert({ ...wiersz(ORG), updated_by: ids.owner }, opcje)).error).toBeNull();
    expect((await owner.from('tenant_invoice_defaults').upsert({ ...wiersz(ORG, { payment_days: 14 }), updated_by: ids.owner }, opcje)).error).toBeNull();
    const wiersze = await ustawienia(ORG);
    expect(wiersze).toHaveLength(1);
    expect(wiersze[0]).toMatchObject({ payment_days: 14, updated_by: ids.owner });
  });

  it('administrator zmienia szablon', async () => {
    const adm = await signedIn('admin', ORG);
    const r = await adm.from('tenant_invoice_defaults').update({ payment_days: 45 }).eq('tenant_id', ORG).select('payment_days');
    expect(r.error).toBeNull();
    expect(r.data).toEqual([{ payment_days: 45 }]);
  });

  it('każdy aktywny członek firmy czyta szablon (mail wysyła też członek i księgowa)', async () => {
    for (const who of ['owner', 'admin', 'member', 'accountant'] as Who[]) {
      const klient = await signedIn(who, ORG);
      const r = await klient.from('tenant_invoice_defaults').select('payment_days');
      expect(r.error).toBeNull();
      expect(r.data).toEqual([{ payment_days: 45 }]);
    }
  });

  it('członek i księgowa nie zmieniają, nie dopisują i nie usuwają szablonu', async () => {
    for (const who of ['member', 'accountant'] as Who[]) {
      const klient = await signedIn(who, ORG);
      const zmiana = await klient.from('tenant_invoice_defaults').update({ payment_days: 1 }).eq('tenant_id', ORG).select('payment_days');
      expect(zmiana.data ?? []).toEqual([]);
      await klient.from('tenant_invoice_defaults').delete().eq('tenant_id', ORG);
      expect((await klient.from('tenant_invoice_defaults').upsert(wiersz(ORG, { payment_days: 1 }), { onConflict: 'tenant_id' })).error).not.toBeNull();
    }
    expect((await ustawienia(ORG)).map((r) => r.payment_days)).toEqual([45]);
  });

  it('obca firma nie widzi ani nie zmienia szablonu tej firmy', async () => {
    const other = await signedIn('other', OTHER_ORG);
    expect((await other.from('tenant_invoice_defaults').select('payment_days')).data).toEqual([]);
    expect((await other.from('tenant_invoice_defaults').insert(wiersz(ORG, { payment_days: 2 }))).error).not.toBeNull();
    // Nagłówek firmy, w której osoba nie jest członkiem, nie otwiera dostępu.
    const podszyt = await signedIn('other', ORG);
    expect((await podszyt.from('tenant_invoice_defaults').select('payment_days')).data ?? []).toEqual([]);
    expect((await podszyt.from('tenant_invoice_defaults').upsert(wiersz(ORG, { payment_days: 2 }), { onConflict: 'tenant_id' })).error).not.toBeNull();
  });

  it('forma płatności z listy, termin 0 do 90 dni, adres w prawidłowym formacie', async () => {
    const owner = await signedIn('owner', ORG);
    const zle: Array<Record<string, unknown>> = [
      { payment_method: 'barter' },
      { payment_days: -1 },
      { payment_days: 91 },
      { accountant_copy_email: 'bez-malpy' },
      { accountant_copy_email: 'dwa@x.pl, trzy@x.pl' },
      { accountant_copy_email: `${'a'.repeat(250)}@x.pl` },
    ];
    for (const zmiana of zle) {
      expect((await owner.from('tenant_invoice_defaults').upsert(wiersz(ORG, zmiana), { onConflict: 'tenant_id' })).error).not.toBeNull();
    }
    // Puste pola są dozwolone (puste znaczy „jak dotąd”).
    expect(
      (await owner.from('tenant_invoice_defaults').upsert(wiersz(ORG, { payment_method: null, payment_days: null, accountant_copy_email: null }), { onConflict: 'tenant_id' })).error,
    ).toBeNull();
    await owner.from('tenant_invoice_defaults').update({ payment_days: 45, payment_method: 'cash' }).eq('tenant_id', ORG);
    expect((await ustawienia(ORG)).map((r) => r.payment_days)).toEqual([45]);
  });

  it('powrót do domyślnego: właściciel usuwa wiersz', async () => {
    const owner = await signedIn('owner', ORG);
    expect((await owner.from('tenant_invoice_defaults').delete().eq('tenant_id', ORG)).error).toBeNull();
    expect(await ustawienia(ORG)).toEqual([]);
  });

  it('bez logowania tabela jest zamknięta', async () => {
    const anon = anonClient(ORG);
    expect((await anon.from('tenant_invoice_defaults').select('payment_days')).data ?? []).toEqual([]);
    expect((await anon.from('tenant_invoice_defaults').insert(wiersz(ORG))).error).not.toBeNull();
  });
});
