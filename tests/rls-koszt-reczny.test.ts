import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * Krok 3.8, część 1 (koszt wpisany ręcznie) na prawdziwej bazie: zapis klientem
 * sesji ze źródłem `manual` przechodzi przez RLS `expenses_insert_own_tenant`
 * (firma aktywna, `created_by = auth.uid()`) i strażnik pochodzenia (00123),
 * a wiersz bez zdjęcia i bez zadania odczytu jest poprawny. Cudza firma, cudzy
 * `created_by` i pochodzenie z KSeF są odrzucone. Migracja nie jest potrzebna.
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

const ORG = '00380380-0000-4000-8000-000000000001';
const OTHER_ORG = '00380380-0000-4000-8000-000000000002';
const PASS = 'RlsKosztReczny2026Aa!';
const EMAILS = {
  member: 'rls-koszt-reczny-member@ksef-saas.test',
  other: 'rls-koszt-reczny-other@ksef-saas.test',
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

async function signedIn(who: Who, org: string): Promise<SupabaseClient> {
  const client = anonClient(org);
  const { error } = await client.auth.signInWithPassword({ email: EMAILS[who], password: PASS });
  if (error) throw error;
  return client;
}

const koszt = (tenant: string, createdBy: string, o: Record<string, unknown> = {}) => ({
  tenant_id: tenant,
  created_by: createdBy,
  source: 'manual',
  seller_name: 'Urząd Miasta',
  document_type: 'other',
  issue_date: '2026-11-10',
  net_amount: 100,
  vat_amount: 0,
  gross_amount: 100,
  kpir_column: 'col_13',
  categorization_method: 'manual',
  is_reviewed: true,
  ...o,
});

async function sprzataj() {
  for (const org of [ORG, OTHER_ORG]) {
    await admin.from('expenses').delete().eq('tenant_id', org);
    await admin.from('memberships').delete().eq('organization_id', org);
  }
}

describe.skipIf(!hasDatabase)('koszt wpisany ręcznie na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    for (const who of Object.keys(EMAILS) as Who[]) ids[who] = await userId(EMAILS[who]);
    await sprzataj();
    const tenants = await admin.from('tenants').upsert(
      [
        { id: ORG, nip: '9480000248', name: 'Firma Koszt Ręczny 1' },
        { id: OTHER_ORG, nip: '9480000254', name: 'Firma Koszt Ręczny 2' },
      ],
      { onConflict: 'id' },
    );
    if (tenants.error) throw tenants.error;
    const profiles = await admin.from('users').upsert(
      (Object.keys(ids) as Who[]).map((who) => ({ id: ids[who], name: `Koszt ${who}` })),
      { onConflict: 'id' },
    );
    if (profiles.error) throw profiles.error;
    const members = await admin.from('memberships').insert([
      { organization_id: ORG, user_id: ids.member, role: 'member', status: 'active' },
      { organization_id: OTHER_ORG, user_id: ids.other, role: 'owner', status: 'active' },
    ]);
    if (members.error) throw members.error;
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await sprzataj();
  });

  it('członek zapisuje koszt ręczny w swojej firmie bez zdjęcia i bez zadania odczytu', async () => {
    const member = await signedIn('member', ORG);
    const r = await member.from('expenses').insert(koszt(ORG, ids.member)).select('id, source, ocr_job_id, source_file_path').single();
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ source: 'manual', ocr_job_id: null, source_file_path: null });
  });

  it('cudzy created_by albo cudza firma są odrzucone', async () => {
    const member = await signedIn('member', ORG);
    expect((await member.from('expenses').insert(koszt(ORG, ids.other))).error).not.toBeNull();
    expect((await member.from('expenses').insert(koszt(OTHER_ORG, ids.member))).error).not.toBeNull();
  });

  it('pochodzenie z KSeF zostaje zarezerwowane dla zaufanego serwera', async () => {
    const member = await signedIn('member', ORG);
    expect((await member.from('expenses').insert(koszt(ORG, ids.member, { source: 'ksef_inbox' }))).error).not.toBeNull();
  });

  it('obca firma nie widzi kosztu', async () => {
    const other = await signedIn('other', OTHER_ORG);
    const r = await other.from('expenses').select('id').eq('tenant_id', ORG);
    expect(r.data ?? []).toEqual([]);
  });
});
