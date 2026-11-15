import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { createMobileDbClient } from '@/lib/api/mobile/db';
import { createContractor, deleteContractor, updateContractor } from '@/lib/contractors/manage';

import { getRlsTestEnvironment } from './helpers/rls-environment';

vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn(async () => undefined) }));

/**
 * Plan aplikacji mobilnej, M10e (bez migracji) na prawdziwym GoTrue i PostgREST.
 *
 * Telefon zapisuje kontrahentów tą samą logiką co strona
 * (`lib/contractors/manage.ts`), ale klientem z tokenem sesji i nagłówkiem
 * `x-active-org` (jak trasy `/api/mobile/v1/kontrahenci`), bez ciasteczek:
 *  1. członek firmy dodaje, poprawia i usuwa kontrahenta swojej firmy;
 *     ponowienie dodania oddaje istniejącego (`UNIQUE (tenant_id, nip)`),
 *     inne dane pod tym NIP to `exists`, bez nadpisania;
 *  2. nagłówek jednej firmy i zapis do drugiej: RLS 00004 odrzuca wiersz;
 *  3. konto spoza firmy z jej nagłówkiem nie widzi, nie dodaje, nie zmienia
 *     i nie usuwa jej kontrahentów, także gdyby trasa tego nie sprawdziła.
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
const target = environment ? { url: environment.url, anonKey: environment.anonKey } : {};

const RUN = Date.now().toString(36);
const EMAILS = {
  member: `rls-m10e-czlonek-${RUN}@ksef-saas.test`,
  stranger: `rls-m10e-obcy-${RUN}@ksef-saas.test`,
};
const PASS = 'RlsMobileM10ePass2026Aa!';
const TENANT_NIP = '1234567890';
// Fikcyjne NIP-y kontrahentów z poprawną sumą kontrolną.
const NIP_A = '5252241585';
const NIP_NEW = '1060000062';

const ORG_A = '000e1000-0000-4000-8000-000000000001';
const ORG_B = '000e1000-0000-4000-8000-000000000002';
const C_A = '000e1000-2000-4000-8000-000000000001';
const C_B = '000e1000-2000-4000-8000-000000000002';

const DANE = { name: 'Nowy Klient Sp. z o.o.', addressLine1: 'ul. Nowa 2', addressLine2: '00-002 Warszawa', email: 'faktury@klient.example' };

async function createUser(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASS, email_confirm: true });
  if (error || !data.user) throw error ?? new Error('createUser');
  return data.user.id;
}

async function tokenOf(email: string): Promise<string> {
  const client = createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password: PASS });
  if (error || !data.session) throw error ?? new Error('signIn');
  return data.session.access_token;
}

async function row(id: string) {
  const { data, error } = await admin.from('contractors').select('tenant_id, nip, name, email, manual_fields').eq('id', id).maybeSingle();
  if (error) throw error;
  return data as { tenant_id: string; nip: string; name: string; email: string | null; manual_fields: string[] } | null;
}

async function countIn(tenantId: string, nip: string): Promise<number> {
  const { count, error } = await admin.from('contractors').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('nip', nip);
  if (error) throw error;
  return count ?? 0;
}

describe.skipIf(!hasDatabase)('M10e: kontrahenci z telefonu na bazie (token i x-active-org)', () => {
  const ids = { member: '', stranger: '' };
  let member: SupabaseClient;
  let memberInB: SupabaseClient;
  let strangerInA: SupabaseClient;

  beforeAll(async () => {
    ids.member = await createUser(EMAILS.member);
    ids.stranger = await createUser(EMAILS.stranger);
    const { error: tenantsError } = await admin.from('tenants').upsert([
      { id: ORG_A, nip: TENANT_NIP, name: 'Firma M10e A', address_json: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
      { id: ORG_B, nip: TENANT_NIP, name: 'Firma M10e B', address_json: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '00-002 Warszawa' } },
    ], { onConflict: 'id' });
    if (tenantsError) throw tenantsError;
    await admin.from('users').upsert([{ id: ids.member, name: 'Członek' }, { id: ids.stranger, name: 'Obcy' }], { onConflict: 'id' });
    const { error: membershipsError } = await admin.from('memberships').insert([
      { organization_id: ORG_A, user_id: ids.member, role: 'member', status: 'active' },
      { organization_id: ORG_B, user_id: ids.stranger, role: 'owner', status: 'active' },
    ]);
    if (membershipsError) throw membershipsError;
    const { error: contractorsError } = await admin.from('contractors').insert([
      { id: C_A, tenant_id: ORG_A, nip: NIP_A, name: 'Klient A', address: { countryCode: 'PL', addressLine1: 'ul. Stara 1', addressLine2: '00-001 Warszawa' } },
      { id: C_B, tenant_id: ORG_B, nip: NIP_A, name: 'Klient B', address: { countryCode: 'PL', addressLine1: 'ul. Inna 1', addressLine2: '00-001 Warszawa' } },
    ]);
    if (contractorsError) throw contractorsError;

    const [tMember, tStranger] = await Promise.all([tokenOf(EMAILS.member), tokenOf(EMAILS.stranger)]);
    member = createMobileDbClient(tMember, { activeOrg: ORG_A, target });
    // Członek firmy A z nagłówkiem firmy B, do której nie należy: bramka da 403, baza też nie przepuści.
    memberInB = createMobileDbClient(tMember, { activeOrg: ORG_B, target });
    strangerInA = createMobileDbClient(tStranger, { activeOrg: ORG_A, target });
  });

  afterAll(async () => {
    await admin.from('contractors').delete().in('tenant_id', [ORG_A, ORG_B]);
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
    for (const id of Object.values(ids)) if (id) await admin.auth.admin.deleteUser(id).catch(() => null);
  });

  it('odczyt tokenem: tylko kontrahenci firmy z nagłówka', async () => {
    const { data, error } = await member.from('contractors').select('id').order('id');
    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id)).toEqual([C_A]);
    const obcy = await strangerInA.from('contractors').select('id').eq('tenant_id', ORG_A);
    expect(obcy.data ?? []).toEqual([]);
  });

  it('członek firmy: dodanie, ponowienie bez drugiego wiersza, inne dane pod tym NIP bez nadpisania', async () => {
    const ctx = { tenantId: ORG_A, userId: ids.member };
    const pierwszy = await createContractor(member, { ...DANE, nip: NIP_NEW }, ctx);
    expect(pierwszy).toMatchObject({ success: true, existed: false });
    const ponowienie = await createContractor(member, { ...DANE, nip: NIP_NEW }, ctx);
    expect(ponowienie).toMatchObject({ success: true, existed: true });
    if (pierwszy.success && ponowienie.success) expect(ponowienie.id).toBe(pierwszy.id);
    expect(await countIn(ORG_A, NIP_NEW)).toBe(1);

    const inne = await createContractor(member, { ...DANE, name: 'Ktoś Inny', nip: NIP_NEW }, ctx);
    expect(inne).toMatchObject({ success: false, reason: 'exists' });
    if (pierwszy.success) expect((await row(pierwszy.id))?.name).toBe(DANE.name);
  });

  it('członek firmy: poprawka zapisuje pola ręczne, usunięcie usuwa, drugie usunięcie nic nie znajduje', async () => {
    const ctx = { tenantId: ORG_A, userId: ids.member };
    const zmiana = await updateContractor(member, C_A, DANE, ctx);
    expect(zmiana).toEqual({ success: true, changed: ['name', 'address', 'email'] });
    expect(await row(C_A)).toMatchObject({ name: DANE.name, nip: NIP_A, manual_fields: ['name', 'address', 'email'] });

    expect(await deleteContractor(member, C_A, ctx)).toEqual({ success: true });
    expect(await row(C_A)).toBeNull();
    expect(await deleteContractor(member, C_A, ctx)).toMatchObject({ success: false, reason: 'not_found' });
  });

  it('nagłówek firmy A i zapis do firmy B: RLS odrzuca wiersz', async () => {
    const wynik = await createContractor(member, { ...DANE, nip: NIP_NEW }, { tenantId: ORG_B, userId: ids.member });
    expect(wynik).toMatchObject({ success: false, reason: 'failed' });
    expect(await countIn(ORG_B, NIP_NEW)).toBe(0);
  });

  it('nagłówek firmy, do której konto nie należy: nic nie widzi i nic nie zmienia', async () => {
    const ctx = { tenantId: ORG_B, userId: ids.member };
    expect(await updateContractor(memberInB, C_B, DANE, ctx)).toMatchObject({ success: false, reason: 'not_found' });
    expect(await deleteContractor(memberInB, C_B, ctx)).toMatchObject({ success: false, reason: 'not_found' });
    expect(await createContractor(memberInB, { ...DANE, nip: '7010012356' }, ctx)).toMatchObject({ success: false });
    expect(await countIn(ORG_B, '7010012356')).toBe(0);
    expect(await row(C_B)).toMatchObject({ tenant_id: ORG_B, name: 'Klient B' });
  });

  it('konto spoza firmy z jej nagłówkiem: nie dodaje i nie zmienia jej kontrahentów', async () => {
    const ctx = { tenantId: ORG_A, userId: ids.stranger };
    expect(await createContractor(strangerInA, { ...DANE, nip: '7010012356' }, ctx)).toMatchObject({ success: false });
    expect(await countIn(ORG_A, '7010012356')).toBe(0);
    const nowy = await admin.from('contractors').select('id').eq('tenant_id', ORG_A).eq('nip', NIP_NEW).single();
    expect(await updateContractor(strangerInA, nowy.data!.id as string, { ...DANE, name: 'Przejęty' }, ctx)).toMatchObject({ success: false, reason: 'not_found' });
    expect(await deleteContractor(strangerInA, nowy.data!.id as string, ctx)).toMatchObject({ success: false, reason: 'not_found' });
    expect((await row(nowy.data!.id as string))?.name).toBe(DANE.name);
  });
});
