import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { findActiveMembership, type MobileCaller } from '@/lib/api/mobile/auth';
import { createMobileDbClient } from '@/lib/api/mobile/db';
import { teamForMobile } from '@/lib/api/mobile/karty-wiecej';
import { ZESPOL_CZLONKOWIE_KOLUMNY, ZESPOL_PROSBY_KOLUMNY } from '@/lib/organizations/zespol-zapytania';

import { getRlsTestEnvironment } from './helpers/rls-environment';

vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn(async () => undefined) }));

/**
 * Obchód w symulatorze, U9: karta Więcej > Zespół pokazywała „Nie udało się
 * wczytać zespołu” (503), a strona Zespołu (`settings/team`) pustą listę.
 * Przyczyna: `memberships` ma dwa klucze obce do `users` (`user_id`,
 * `invited_by`), a `organization_join_requests` dwa (`requested_by_user_id`,
 * `decided_by`), więc osadzenie `users!inner(name)` kończy się w PostgREST
 * błędem PGRST201 („more than one relationship was found”). Atrapa PostgREST
 * z testów trasy tego nie łapie, dlatego test idzie na prawdziwą bazę:
 *  1. dowód przyczyny: samo `users!inner(name)` daje PGRST201 na obu tabelach;
 *  2. zapytania strony i telefonu (wspólne stałe `lib/organizations/zespol-zapytania.ts`)
 *     tokenem właściciela zwracają członków z nazwami (także zaproszonego
 *     przez kogoś: wtedy oba klucze do `users` mają wartość);
 *  3. trasa telefonu `teamForMobile` odpowiada 200 z członkami (z nazwami),
 *     zaproszeniami i prośbami o dołączenie (prośby bez `!inner`: RLS `users`
 *     ukrywa wnioskodawcę spoza firmy, więc złączenie wewnętrzne wycięłoby je);
 *  4. członek firmy dostaje 403 (rola z bazy), a firma obca nie widzi cudzego zespołu.
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
  owner: `rls-u9-wlasciciel-${RUN}@ksef-saas.test`,
  admin: `rls-u9-admin-${RUN}@ksef-saas.test`,
  member: `rls-u9-czlonek-${RUN}@ksef-saas.test`,
  requester: `rls-u9-wnioskodawca-${RUN}@ksef-saas.test`,
  stranger: `rls-u9-obcy-${RUN}@ksef-saas.test`,
};
const PASS = 'RlsZespolU9Pass2026Aa!';
const TENANT_NIP = '1234567890';

const ORG_A = '000d9000-0000-4000-8000-000000000001';
const ORG_B = '000d9000-0000-4000-8000-000000000002';

const NAMES = {
  owner: 'Właściciel U9',
  admin: 'Administrator U9',
  member: 'Członek U9',
  requester: 'Wnioskodawca U9',
  stranger: 'Obcy U9',
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
    requestId: `rls-u9-${RUN}`,
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

describe.skipIf(!hasDatabase)('U9: osadzenie users w Zespole na prawdziwym PostgREST (token użytkownika)', () => {
  const ids = { owner: '', admin: '', member: '', requester: '', stranger: '' };
  const tokens = { owner: '', admin: '', member: '', stranger: '' };

  beforeAll(async () => {
    ids.owner = await createUser(EMAILS.owner);
    ids.admin = await createUser(EMAILS.admin);
    ids.member = await createUser(EMAILS.member);
    ids.requester = await createUser(EMAILS.requester);
    ids.stranger = await createUser(EMAILS.stranger);
    const { error: tenantsError } = await admin.from('tenants').upsert([
      { id: ORG_A, nip: TENANT_NIP, name: 'Firma U9 A' },
      { id: ORG_B, nip: TENANT_NIP, name: 'Firma U9 B' },
    ], { onConflict: 'id' });
    if (tenantsError) throw tenantsError;
    const { error: usersError } = await admin.from('users').upsert(
      (Object.keys(NAMES) as Array<keyof typeof NAMES>).map((key) => ({ id: ids[key], name: NAMES[key] })),
      { onConflict: 'id' },
    );
    if (usersError) throw usersError;
    // `invited_by` wypełnione u członka i administratora: oba klucze do `users` mają wartość.
    const { error: membershipsError } = await admin.from('memberships').insert([
      { organization_id: ORG_A, user_id: ids.owner, role: 'owner', status: 'active' },
      { organization_id: ORG_A, user_id: ids.admin, role: 'admin', status: 'active', invited_by: ids.owner },
      { organization_id: ORG_A, user_id: ids.member, role: 'member', status: 'active', invited_by: ids.admin },
      { organization_id: ORG_B, user_id: ids.stranger, role: 'owner', status: 'active' },
    ]);
    if (membershipsError) throw membershipsError;
    const { error: invitationError } = await admin.from('organization_invitations').insert({
      organization_id: ORG_A,
      email: `rls-u9-zaproszony-${RUN}@ksef-saas.test`,
      role: 'member',
      token_hash: `rls-u9-token-${RUN}`,
      invited_by: ids.owner,
    });
    if (invitationError) throw invitationError;
    const { error: requestError } = await admin.from('organization_join_requests').insert({
      organization_id: ORG_A,
      requested_by_user_id: ids.requester,
      message: 'Proszę o dostęp (U9)',
    });
    if (requestError) throw requestError;
    [tokens.owner, tokens.admin, tokens.member, tokens.stranger] = await Promise.all([
      tokenOf(EMAILS.owner),
      tokenOf(EMAILS.admin),
      tokenOf(EMAILS.member),
      tokenOf(EMAILS.stranger),
    ]);
  });

  afterAll(async () => {
    await admin.from('organization_join_requests').delete().in('organization_id', [ORG_A, ORG_B]);
    await admin.from('organization_invitations').delete().in('organization_id', [ORG_A, ORG_B]);
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
    await admin.from('tenants').delete().in('id', [ORG_A, ORG_B]);
    await admin.from('users').delete().in('id', Object.values(ids).filter(Boolean));
    for (const id of Object.values(ids)) if (id) await admin.auth.admin.deleteUser(id).catch(() => null);
  });

  it('przyczyna: samo `users!inner(name)` daje PGRST201 na memberships i organization_join_requests', async () => {
    const db = createMobileDbClient(tokens.owner, { activeOrg: ORG_A, target });
    const czlonkowie = await db.from('memberships').select('id, users!inner(name)').eq('organization_id', ORG_A);
    expect(czlonkowie.error?.code).toBe('PGRST201');
    expect(czlonkowie.error?.message).toMatch(/more than one relationship/i);
    const prosby = await db.from('organization_join_requests').select('id, users!inner(name)').eq('organization_id', ORG_A);
    expect(prosby.error?.code).toBe('PGRST201');
    expect(prosby.error?.message).toMatch(/more than one relationship/i);
  });

  it('zapytanie strony i telefonu o członków (wspólne stałe) zwraca nazwy, także zaproszonych', async () => {
    const db = createMobileDbClient(tokens.owner, { activeOrg: ORG_A, target });
    const { data, error } = await db
      .from('memberships')
      .select(ZESPOL_CZLONKOWIE_KOLUMNY)
      .eq('organization_id', ORG_A)
      .order('joined_at', { ascending: true });
    expect(error).toBeNull();
    const nazwy = ((data ?? []) as unknown as Array<{ user_id: string; users: { name: string | null } | Array<{ name: string | null }> | null }>)
      .map((m) => [m.user_id, (Array.isArray(m.users) ? m.users[0] : m.users)?.name]);
    expect(Object.fromEntries(nazwy)).toEqual({
      [ids.owner]: NAMES.owner,
      [ids.admin]: NAMES.admin,
      [ids.member]: NAMES.member,
    });
  });

  it('zapytanie strony i telefonu o prośby o dołączenie (wspólne stałe) działa i zwraca wiersz prośby', async () => {
    const db = createMobileDbClient(tokens.owner, { activeOrg: ORG_A, target });
    const { data, error } = await db
      .from('organization_join_requests')
      .select(ZESPOL_PROSBY_KOLUMNY)
      .eq('organization_id', ORG_A)
      .eq('status', 'pending');
    expect(error).toBeNull();
    expect(((data ?? []) as unknown as Array<{ requested_by_user_id: string }>).map((r) => r.requested_by_user_id)).toEqual([ids.requester]);
  });

  it('prośby bez `!inner`: wnioskodawca spoza firmy ma ukryty wiersz w `users` (RLS), a złączenie wewnętrzne wycięłoby prośbę', async () => {
    const db = createMobileDbClient(tokens.owner, { activeOrg: ORG_A, target });
    const inner = await db
      .from('organization_join_requests')
      .select('id, users!organization_join_requests_requested_by_user_id_fkey!inner(name)')
      .eq('organization_id', ORG_A)
      .eq('status', 'pending');
    expect(inner.error).toBeNull();
    expect(inner.data).toEqual([]);
    // Znane ograniczenie (osobne ustalenie): imię wnioskodawcy jest puste, dopóki polityka
    // `users_select_self_or_org_member` nie obejmie próśb o dołączenie.
    const { data } = await db.from('organization_join_requests').select(ZESPOL_PROSBY_KOLUMNY).eq('organization_id', ORG_A);
    expect(data).toHaveLength(1);
  });

  it('GET /zespol (teamForMobile): 200, członkowie z nazwami, zaproszenie i prośba o dołączenie', async () => {
    const caller = await callerOf(ids.owner, tokens.owner, ORG_A);
    expect(caller?.org?.role).toBe('owner');
    const response = await teamForMobile(caller!);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.czlonkowie.map((c: { imie: string }) => c.imie).sort()).toEqual([NAMES.admin, NAMES.member, NAMES.owner].sort());
    expect(body.czlonkowie.find((c: { ty: boolean }) => c.ty)).toMatchObject({ imie: NAMES.owner, rola: 'owner' });
    expect(body.zaproszenia).toHaveLength(1);
    // Prośba zostaje na liście (bez `!inner`); imię wnioskodawcy ukrywa RLS `users` (zob. wyżej).
    expect(body.prosby).toEqual([expect.objectContaining({ wiadomosc: 'Proszę o dostęp (U9)' })]);
  });

  it('administrator też widzi Zespół; członek firmy dostaje 403 bez odczytu zespołu', async () => {
    const asAdmin = await callerOf(ids.admin, tokens.admin, ORG_A);
    expect((await teamForMobile(asAdmin!)).status).toBe(200);
    const asMember = await callerOf(ids.member, tokens.member, ORG_A);
    expect(asMember?.org?.role).toBe('member');
    expect((await teamForMobile(asMember!)).status).toBe(403);
  });

  it('konto z firmy B z nagłówkiem firmy A nie ma członkostwa i nie czyta jej zespołu', async () => {
    expect(await callerOf(ids.stranger, tokens.stranger, ORG_A)).toBeNull();
    const db = createMobileDbClient(tokens.stranger, { activeOrg: ORG_A, target });
    const { data, error } = await db.from('memberships').select(ZESPOL_CZLONKOWIE_KOLUMNY).eq('organization_id', ORG_A);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});
