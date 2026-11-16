import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { findActiveMembership, type MobileCaller } from '@/lib/api/mobile/auth';
import { createMobileDbClient } from '@/lib/api/mobile/db';
import { saveCompanyFromMobile, saveRemindersFromMobile } from '@/lib/api/mobile/ustawienia-zapis';

import { getRlsTestEnvironment } from './helpers/rls-environment';

vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn(async () => undefined) }));

/**
 * Plan aplikacji mobilnej, M10c (bez migracji) na prawdziwym GoTrue i PostgREST.
 *
 * Telefon zapisuje ustawienia firmy logiką strony, z rolą odczytaną tokenem
 * telefonu (`findActiveMembership`, jak bramka) i nagłówkiem `x-active-org`:
 *  1. właściciel zmienia dane firmy swojej firmy (klucz serwisowy po
 *     sprawdzeniu roli, jak akcja strony); druga firma bez zmian;
 *  2. członek firmy dostaje 403 i nic się nie zmienia;
 *  3. przypomnienia: upsert tokenem właściciela trafia do jego firmy (RLS
 *     `reminder_settings_tenant_isolation`); nagłówek cudzej firmy i konto
 *     spoza firmy nie zapiszą ani nie nadpiszą wiersza, także gdyby trasa
 *     tego nie sprawdziła.
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
  owner: `rls-m10c-wlasciciel-${RUN}@ksef-saas.test`,
  member: `rls-m10c-czlonek-${RUN}@ksef-saas.test`,
  stranger: `rls-m10c-obcy-${RUN}@ksef-saas.test`,
};
const PASS = 'RlsMobileM10cPass2026Aa!';
const TENANT_NIP = '1234567890';

const ORG_A = '000c1000-0000-4000-8000-000000000001';
const ORG_B = '000c1000-0000-4000-8000-000000000002';
const ADRES_A = { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' };
const ADRES_B = { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '00-002 Warszawa' };

const PRZYPOMNIENIA = {
  wlaczone: true,
  etapy: [
    { etap: 1, wlaczony: true, dniPoTerminie: 4 },
    { etap: 2, wlaczony: true, dniPoTerminie: 9 },
    { etap: 3, wlaczony: false, dniPoTerminie: 20 },
  ],
  godzina: 11,
  tylkoDniRobocze: true,
  najwiecej: 2,
  nadawca: 'Firma M10c A',
  odpowiedzNa: '',
  wstrzymajPoOdpowiedzi: true,
  wstrzymajPoCzesciowej: true,
};

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

/** Wywołujący jak po bramce: rola z członkostwa czytanego tokenem telefonu, klient z tokenem i firmą. */
async function callerOf(userId: string, token: string, org: string): Promise<MobileCaller | null> {
  const db = createMobileDbClient(token, { activeOrg: org, target });
  const membership = await findActiveMembership(db, userId, org);
  if (!membership) return null;
  return {
    requestId: `rls-m10c-${RUN}`,
    headers: {},
    user: { id: userId, email: null, providers: ['email'] },
    mfaEnabled: false,
    accessToken: null,
    totpFactorId: null,
    session: { sessionId: null, aal: 'aal1', metoda: 'password', potwierdzonoO: null },
    org: { tenantId: org, role: membership.role },
    db,
  } as unknown as MobileCaller;
}

const post = (body: unknown) =>
  new Request('https://app.example.test/api/mobile/v1/ustawienia/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function tenantRow(id: string) {
  const { data, error } = await admin.from('tenants').select('name, address_json, vat_cash_method').eq('id', id).single();
  if (error) throw error;
  return data as { name: string; address_json: unknown; vat_cash_method: boolean };
}

async function remindersOf(tenantId: string) {
  const { data, error } = await admin.from('reminder_settings').select('tenant_id, enabled, send_hour, stage_1_days_after_due, sender_name').eq('tenant_id', tenantId).maybeSingle();
  if (error) throw error;
  return data as { tenant_id: string; enabled: boolean; send_hour: number; stage_1_days_after_due: number; sender_name: string | null } | null;
}

describe.skipIf(!hasDatabase)('M10c: zapisy ustawień z telefonu na bazie (token i x-active-org)', () => {
  const ids = { owner: '', member: '', stranger: '' };
  const tokens = { owner: '', member: '', stranger: '' };

  beforeAll(async () => {
    ids.owner = await createUser(EMAILS.owner);
    ids.member = await createUser(EMAILS.member);
    ids.stranger = await createUser(EMAILS.stranger);
    const { error: tenantsError } = await admin.from('tenants').upsert([
      { id: ORG_A, nip: TENANT_NIP, name: 'Firma M10c A', address_json: ADRES_A, vat_cash_method: false },
      { id: ORG_B, nip: TENANT_NIP, name: 'Firma M10c B', address_json: ADRES_B, vat_cash_method: false },
    ], { onConflict: 'id' });
    if (tenantsError) throw tenantsError;
    await admin.from('users').upsert([
      { id: ids.owner, name: 'Właściciel' },
      { id: ids.member, name: 'Członek' },
      { id: ids.stranger, name: 'Obcy' },
    ], { onConflict: 'id' });
    const { error: membershipsError } = await admin.from('memberships').insert([
      { organization_id: ORG_A, user_id: ids.owner, role: 'owner', status: 'active' },
      { organization_id: ORG_A, user_id: ids.member, role: 'member', status: 'active' },
      { organization_id: ORG_B, user_id: ids.stranger, role: 'owner', status: 'active' },
    ]);
    if (membershipsError) throw membershipsError;
    [tokens.owner, tokens.member, tokens.stranger] = await Promise.all([tokenOf(EMAILS.owner), tokenOf(EMAILS.member), tokenOf(EMAILS.stranger)]);
  });

  beforeEach(() => {
    // Klient serwisowy logiki strony (`createAdminClient`) celuje w bazę testu.
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', environment!.url);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', environment!.anonKey);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', environment!.serviceRoleKey);
  });
  afterEach(() => vi.unstubAllEnvs());

  afterAll(async () => {
    await admin.from('reminder_settings').delete().in('tenant_id', [ORG_A, ORG_B]);
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
    await admin.from('tenants').delete().in('id', [ORG_A, ORG_B]);
    await admin.from('users').delete().in('id', Object.values(ids).filter(Boolean));
    for (const id of Object.values(ids)) if (id) await admin.auth.admin.deleteUser(id).catch(() => null);
  });

  it('właściciel zmienia dane i metodę kasową swojej firmy; druga firma bez zmian', async () => {
    const caller = await callerOf(ids.owner, tokens.owner, ORG_A);
    expect(caller?.org?.role).toBe('owner');
    const dane = await saveCompanyFromMobile(caller!, post({ zmiana: 'dane', nazwa: 'Firma M10c A po zmianie', adres1: 'ul. Nowa 3', adres2: '00-003 Warszawa' }));
    expect(dane.status).toBe(200);
    expect((await dane.json()).firma).toMatchObject({ nazwa: 'Firma M10c A po zmianie', adres: { linia1: 'ul. Nowa 3', linia2: '00-003 Warszawa' } });
    expect((await saveCompanyFromMobile(caller!, post({ zmiana: 'metodaKasowa', wlaczona: true }))).status).toBe(200);

    expect(await tenantRow(ORG_A)).toMatchObject({ name: 'Firma M10c A po zmianie', vat_cash_method: true, address_json: { countryCode: 'PL', addressLine1: 'ul. Nowa 3', addressLine2: '00-003 Warszawa' } });
    expect(await tenantRow(ORG_B)).toMatchObject({ name: 'Firma M10c B', vat_cash_method: false, address_json: ADRES_B });
  });

  it('członek firmy (rola z bazy): 403, dane firmy bez zmian', async () => {
    const before = await tenantRow(ORG_A);
    const caller = await callerOf(ids.member, tokens.member, ORG_A);
    expect(caller?.org?.role).toBe('member');
    const response = await saveCompanyFromMobile(caller!, post({ zmiana: 'dane', nazwa: 'Przejęta', adres1: 'ul. X 1', adres2: '00-001 Warszawa' }));
    expect(response.status).toBe(403);
    expect(await tenantRow(ORG_A)).toEqual(before);
  });

  it('konto spoza firmy z jej nagłówkiem nie ma członkostwa (bramka: 403) i jego token nie zmieni firmy wprost', async () => {
    expect(await callerOf(ids.stranger, tokens.stranger, ORG_A)).toBeNull();
    const before = await tenantRow(ORG_A);
    const strangerInA = createMobileDbClient(tokens.stranger, { activeOrg: ORG_A, target });
    await strangerInA.from('tenants').update({ name: 'Przejęta' }).eq('id', ORG_A);
    expect(await tenantRow(ORG_A)).toEqual(before);
  });

  it('przypomnienia właściciela trafiają do jego firmy; karta po zapisie „zapisane, włączone”', async () => {
    const caller = await callerOf(ids.owner, tokens.owner, ORG_A);
    const response = await saveRemindersFromMobile(caller!, post(PRZYPOMNIENIA));
    expect(response.status).toBe(200);
    expect((await response.json()).przypomnienia).toMatchObject({ zapisane: true, wlaczone: true, godzina: 11 });
    expect(await remindersOf(ORG_A)).toMatchObject({ tenant_id: ORG_A, enabled: true, send_hour: 11, stage_1_days_after_due: 4, sender_name: 'Firma M10c A' });
    expect(await remindersOf(ORG_B)).toBeNull();

    // Ponowienie zapisuje to samo w tym samym wierszu (UNIQUE tenant_id), bez drugiego.
    expect((await saveRemindersFromMobile(caller!, post(PRZYPOMNIENIA))).status).toBe(200);
    const { count } = await admin.from('reminder_settings').select('id', { count: 'exact', head: true }).eq('tenant_id', ORG_A);
    expect(count).toBe(1);
  });

  it('token właściciela A z nagłówkiem B i token obcego z nagłówkiem A: RLS nie zapisze ani nie nadpisze przypomnień', async () => {
    const ownerInB = createMobileDbClient(tokens.owner, { activeOrg: ORG_B, target });
    const doB = await ownerInB.from('reminder_settings').upsert({ tenant_id: ORG_B, enabled: true }, { onConflict: 'tenant_id' });
    expect(doB.error).not.toBeNull();
    expect(await remindersOf(ORG_B)).toBeNull();

    const before = await remindersOf(ORG_A);
    const strangerInA = createMobileDbClient(tokens.stranger, { activeOrg: ORG_A, target });
    const doA = await strangerInA.from('reminder_settings').upsert({ tenant_id: ORG_A, enabled: false, send_hour: 6 }, { onConflict: 'tenant_id' });
    expect(doA.error).not.toBeNull();
    expect(await remindersOf(ORG_A)).toEqual(before);
  });
});
