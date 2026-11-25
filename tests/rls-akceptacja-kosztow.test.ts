import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00214 na prawdziwej bazie: akceptacja kosztu przez księgową (plan kompletnej
 * aplikacji, krok 6.2, część 5a; niezmienniki w opisie PR).
 *
 * Decyzję („accepted” albo „needs_changes” z powodem) zapisuje tylko aktywny
 * członek aktywnej firmy z rolą `accountant`, przez `expense_acceptance_decide`,
 * dla treści, którą widział (odcisk z `expense_acceptance_state`). Stan widzą ci,
 * którzy widzą koszt. Zmiana pola księgowego kosztu daje stan nieaktualny,
 * zmiana płatności albo notatki nie. Akceptacja nie zmienia kosztu.
 *
 * `audit_logs` jest tylko do dopisywania (00052): firmy przez upsert, testy
 * audytu porównują stan przed i po.
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

const ORG = '00214214-0000-4000-8000-000000000001';
const OTHER_ORG = '00214214-0000-4000-8000-000000000002';
const EXPENSE = '00214214-0000-4000-8000-0000000000e1';
const OTHER_EXPENSE = '00214214-0000-4000-8000-0000000000e2';
const PASS = 'RlsAkceptacjaPass2026Aa!';
const EMAILS = {
  owner: 'rls-akceptacja-owner@ksef-saas.test',
  admin: 'rls-akceptacja-admin@ksef-saas.test',
  member: 'rls-akceptacja-member@ksef-saas.test',
  accountant: 'rls-akceptacja-accountant@ksef-saas.test',
  suspended: 'rls-akceptacja-suspended@ksef-saas.test',
  other: 'rls-akceptacja-other@ksef-saas.test',
} as const;
type Who = keyof typeof EMAILS;
const NAMES: Record<Who, string> = {
  owner: 'Olga Właścicielka',
  admin: 'Adam Admin',
  member: 'Marek Członek',
  accountant: 'Anna Księgowa',
  suspended: 'Zenon Zawieszony',
  other: 'Oskar Obcy',
};
const ids = {} as Record<Who, string>;
const AUDIT_ACTIONS = ['expense.accepted', 'expense.needs_changes'];
const LINK = `/expenses/${EXPENSE}#akceptacja`;

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

type State = {
  current_fingerprint: string;
  decision: string | null;
  reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
  is_current: boolean;
} | null;

async function stan(client: SupabaseClient, expenseId = EXPENSE): Promise<State> {
  const { data, error } = await client.rpc('expense_acceptance_state', { p_expense_id: expenseId });
  if (error) throw error;
  return data as State;
}

async function decyzja(client: SupabaseClient, args: { decision: string; reason?: string | null; fingerprint: string; expenseId?: string }) {
  return client.rpc('expense_acceptance_decide', {
    p_expense_id: args.expenseId ?? EXPENSE,
    p_decision: args.decision,
    p_reason: args.reason ?? null,
    p_fingerprint: args.fingerprint,
  });
}

async function wiersz(expenseId = EXPENSE) {
  const { data, error } = await admin
    .from('expense_acceptances')
    .select('expense_id, tenant_id, decision, reason, fingerprint, decided_by, decided_at')
    .eq('expense_id', expenseId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function koszt(expenseId = EXPENSE) {
  const { data, error } = await admin
    .from('expenses')
    .select('net_amount, vat_amount, gross_amount, kpir_column, is_reviewed, is_deductible, vat_deductible_amount, category_label')
    .eq('id', expenseId)
    .single();
  if (error) throw error;
  return data;
}

async function wpisyDzwonka() {
  const { data, error } = await admin
    .from('app_notifications')
    .select('tenant_id, user_id, kind, object_key, title, body, link')
    .eq('tenant_id', ORG)
    .eq('kind', 'expense_needs_changes')
    .order('user_id', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function audyt() {
  const { data, error } = await admin
    .from('audit_logs')
    .select('tenant_id, user_id, action, entity_type, entity_id, metadata, created_at')
    .in('entity_id', [EXPENSE, OTHER_EXPENSE])
    .in('action', AUDIT_ACTIONS)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function nowyAudyt(wywolanie: () => Promise<void>) {
  const przed = (await audyt()).length;
  await wywolanie();
  return (await audyt()).slice(przed);
}

async function sprzataj() {
  for (const org of [ORG, OTHER_ORG]) {
    await admin.from('app_notifications').delete().eq('tenant_id', org);
    await admin.from('expense_acceptances').delete().eq('tenant_id', org);
    await admin.from('expenses').delete().eq('tenant_id', org);
    await admin.from('memberships').delete().eq('organization_id', org);
  }
}

async function nowyKoszt() {
  await admin.from('expense_acceptances').delete().eq('tenant_id', ORG);
  await admin.from('app_notifications').delete().eq('tenant_id', ORG);
  await admin.from('expenses').delete().eq('id', EXPENSE);
  const { error } = await admin.from('expenses').insert({
    id: EXPENSE, tenant_id: ORG, created_by: ids.owner, source: 'manual', seller_name: 'Dostawca Testowy sp. z o.o.',
    document_number: 'FV 7/2026', issue_date: '2026-11-02', net_amount: 100, vat_amount: 23, gross_amount: 123,
    kpir_column: 'col_13', category_label: 'Usługi', notes: 'Pierwsza notatka',
  });
  if (error) throw error;
}

describe.skipIf(!hasDatabase)('00214: akceptacja kosztu przez księgową na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    for (const who of Object.keys(EMAILS) as Who[]) ids[who] = await userId(EMAILS[who]);
    await sprzataj();
    const tenants = await admin.from('tenants').upsert(
      [
        { id: ORG, nip: '9480000216', name: 'Firma Akceptacja 00214' },
        { id: OTHER_ORG, nip: '9480000222', name: 'Inna firma 00214' },
      ],
      { onConflict: 'id' },
    );
    if (tenants.error) throw tenants.error;
    const profiles = await admin.from('users').upsert(
      (Object.keys(ids) as Who[]).map((who) => ({ id: ids[who], name: NAMES[who] })),
      { onConflict: 'id' },
    );
    if (profiles.error) throw profiles.error;
    // Wszystkie wiersze z tymi samymi kluczami: masowy insert PostgREST wpisuje NULL w brakujące kolumny.
    const members = await admin.from('memberships').insert([
      { organization_id: ORG, user_id: ids.owner, role: 'owner', status: 'active' },
      { organization_id: ORG, user_id: ids.admin, role: 'admin', status: 'active' },
      { organization_id: ORG, user_id: ids.member, role: 'member', status: 'active' },
      { organization_id: ORG, user_id: ids.accountant, role: 'accountant', status: 'active' },
      { organization_id: ORG, user_id: ids.suspended, role: 'accountant', status: 'suspended' },
      { organization_id: OTHER_ORG, user_id: ids.other, role: 'owner', status: 'active' },
      // Księgowa obsługuje też drugą firmę: decyduje tylko w aktywnej.
      { organization_id: OTHER_ORG, user_id: ids.accountant, role: 'accountant', status: 'active' },
    ]);
    if (members.error) throw members.error;
    const other = await admin.from('expenses').insert({
      id: OTHER_EXPENSE, tenant_id: OTHER_ORG, created_by: ids.other, source: 'manual', seller_name: 'Nieznany',
      document_number: null, issue_date: '2026-11-03', net_amount: 10, vat_amount: 2.3, gross_amount: 12.3,
      kpir_column: 'col_13', category_label: 'Usługi', notes: null,
    });
    if (other.error) throw other.error;
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await sprzataj();
  });

  it('księgowa akceptuje treść, którą widziała: wiersz, audyt, bez dzwonka; koszt bez zmian; ponowienie bez dubla', async () => {
    await nowyKoszt();
    const ksiegowa = await signedIn('accountant', ORG);
    const przed = await stan(ksiegowa);
    expect(przed).toMatchObject({ decision: null, is_current: false });
    expect(przed!.current_fingerprint).toMatch(/^[0-9a-f]{32}$/);
    const kosztPrzed = await koszt();

    const nowe = await nowyAudyt(async () => {
      const { data, error } = await decyzja(ksiegowa, { decision: 'accepted', fingerprint: przed!.current_fingerprint });
      expect(error).toBeNull();
      expect(data).toMatchObject({ status: 'decided', decision: 'accepted' });
    });
    expect(nowe).toHaveLength(1);
    expect(nowe[0]).toMatchObject({ tenant_id: ORG, user_id: ids.accountant, action: 'expense.accepted', entity_type: 'expense', entity_id: EXPENSE });
    expect(await wiersz()).toMatchObject({ tenant_id: ORG, decision: 'accepted', reason: null, decided_by: ids.accountant, fingerprint: przed!.current_fingerprint });
    expect(await wpisyDzwonka()).toEqual([]);
    expect(await koszt()).toEqual(kosztPrzed);

    // Stan widzi każdy, kto widzi koszt.
    for (const who of ['owner', 'admin', 'member'] as const) {
      expect(await stan(await signedIn(who, ORG)), who).toMatchObject({ decision: 'accepted', is_current: true, decided_by: ids.accountant });
    }

    const powtorka = await nowyAudyt(async () => {
      const { data, error } = await decyzja(ksiegowa, { decision: 'accepted', fingerprint: przed!.current_fingerprint });
      expect(error).toBeNull();
      expect(data).toMatchObject({ status: 'exists', decision: 'accepted' });
    });
    expect(powtorka).toEqual([]);
  });

  it('zmiana pola księgowego po akceptacji: stan nieaktualny; zmiana płatności i notatki nie zmienia stanu', async () => {
    await nowyKoszt();
    const ksiegowa = await signedIn('accountant', ORG);
    const fp = (await stan(ksiegowa))!.current_fingerprint;
    expect((await decyzja(ksiegowa, { decision: 'accepted', fingerprint: fp })).error).toBeNull();

    const platnosc = await admin.from('expenses').update({ paid_at: '2026-11-20', notes: 'Inna notatka' }).eq('id', EXPENSE);
    expect(platnosc.error).toBeNull();
    expect(await stan(await signedIn('owner', ORG))).toMatchObject({ decision: 'accepted', is_current: true, current_fingerprint: fp });

    const kwota = await admin.from('expenses').update({ net_amount: 90, vat_amount: 20.7, gross_amount: 110.7 }).eq('id', EXPENSE);
    expect(kwota.error).toBeNull();
    const poZmianie = await stan(await signedIn('owner', ORG));
    expect(poZmianie).toMatchObject({ decision: 'accepted', is_current: false });
    expect(poZmianie!.current_fingerprint).not.toBe(fp);

    // Decyzja na starej treści: odmowa „changed”, nic nie zapisane.
    const stara = await decyzja(ksiegowa, { decision: 'accepted', fingerprint: fp });
    expect(stara.error).toBeNull();
    expect(stara.data).toMatchObject({ status: 'refused', code: 'changed' });
    expect(await wiersz()).toMatchObject({ fingerprint: fp });
  });

  it('„do poprawy”: powód wymagany; wpis w dzwonku aktywnych członków bez księgowej, z linkiem do akceptacji; audyt', async () => {
    await nowyKoszt();
    const ksiegowa = await signedIn('accountant', ORG);
    const fp = (await stan(ksiegowa))!.current_fingerprint;

    for (const reason of [null, '   \n ']) {
      const { data, error } = await decyzja(ksiegowa, { decision: 'needs_changes', reason, fingerprint: fp });
      expect(error).toBeNull();
      expect(data).toMatchObject({ status: 'refused', code: 'empty_reason' });
    }
    const zaDlugi = await decyzja(ksiegowa, { decision: 'needs_changes', reason: 'x'.repeat(2001), fingerprint: fp });
    expect(zaDlugi.data).toMatchObject({ status: 'refused', code: 'reason_too_long' });
    expect(await wiersz()).toBeNull();

    const nowe = await nowyAudyt(async () => {
      const { data, error } = await decyzja(ksiegowa, { decision: 'needs_changes', reason: '  Brak faktury, jest tylko paragon.  ', fingerprint: fp });
      expect(error).toBeNull();
      expect(data).toMatchObject({ status: 'decided', decision: 'needs_changes', notified: 3 });
    });
    expect(nowe.map((w) => w.action)).toEqual(['expense.needs_changes']);
    expect(await wiersz()).toMatchObject({ decision: 'needs_changes', reason: 'Brak faktury, jest tylko paragon.' });

    const dzwonek = await wpisyDzwonka();
    expect(dzwonek.map((w) => w.user_id).sort()).toEqual([ids.owner, ids.admin, ids.member].sort());
    for (const w of dzwonek) {
      expect(w).toMatchObject({ kind: 'expense_needs_changes', link: LINK, title: 'Koszt do poprawy' });
      expect(w.body).toContain('FV 7/2026 od Dostawca Testowy sp. z o.o.');
      expect(w.body).toContain('Brak faktury, jest tylko paragon.');
    }
    expect(await stan(await signedIn('member', ORG))).toMatchObject({ decision: 'needs_changes', reason: 'Brak faktury, jest tylko paragon.', is_current: true });

    // Po poprawie kosztu księgowa akceptuje nową treść: decyzja zastępuje poprzednią.
    await admin.from('expenses').update({ document_number: 'FV 7/2026/K' }).eq('id', EXPENSE);
    const fp2 = (await stan(ksiegowa))!.current_fingerprint;
    const ok = await decyzja(ksiegowa, { decision: 'accepted', reason: 'pomijany', fingerprint: fp2 });
    expect(ok.data).toMatchObject({ status: 'decided', decision: 'accepted' });
    expect(await wiersz()).toMatchObject({ decision: 'accepted', reason: null, fingerprint: fp2 });
  });

  it('tylko księgowa aktywnej firmy: inne role dostają odmowę „role”, zawieszona i obca firma nie zapisują', async () => {
    await nowyKoszt();
    const fp = (await stan(await signedIn('accountant', ORG)))!.current_fingerprint;
    for (const who of ['owner', 'admin', 'member'] as const) {
      const { data, error } = await decyzja(await signedIn(who, ORG), { decision: 'accepted', fingerprint: fp });
      expect(error, who).toBeNull();
      expect(data, who).toMatchObject({ status: 'refused', code: 'role' });
    }
    const zawieszona = await decyzja(await signedIn('suspended', ORG), { decision: 'accepted', fingerprint: fp });
    expect(zawieszona.error?.code).toBe('42501');
    const obcy = await decyzja(await signedIn('other', ORG), { decision: 'accepted', fingerprint: fp });
    expect(obcy.error?.code).toBe('42501');
    // Księgowa z aktywną drugą firmą: koszt pierwszej wygląda jak brak kosztu.
    const zDrugiej = await decyzja(await signedIn('accountant', OTHER_ORG), { decision: 'accepted', fingerprint: fp });
    expect(zDrugiej.data).toMatchObject({ status: 'refused', code: 'not_found' });
    expect(await stan(await signedIn('accountant', OTHER_ORG))).toBeNull();
    expect(await wiersz()).toBeNull();

    const zlaDecyzja = await decyzja(await signedIn('accountant', ORG), { decision: 'approved', fingerprint: fp });
    expect(zlaDecyzja.data).toMatchObject({ status: 'refused', code: 'invalid_decision' });
  });

  it('tabela tylko do odczytu kluczem użytkownika i tylko w firmie kosztu; usunięcie kosztu usuwa akceptację', async () => {
    await nowyKoszt();
    const ksiegowa = await signedIn('accountant', ORG);
    const fp = (await stan(ksiegowa))!.current_fingerprint;
    expect((await decyzja(ksiegowa, { decision: 'accepted', fingerprint: fp })).error).toBeNull();

    const insert = await ksiegowa.from('expense_acceptances').insert({ expense_id: OTHER_EXPENSE, tenant_id: OTHER_ORG, decision: 'accepted', fingerprint: fp });
    expect(insert.error).not.toBeNull();
    const update = await ksiegowa.from('expense_acceptances').update({ decision: 'needs_changes', reason: 'x' }).eq('expense_id', EXPENSE).select();
    expect(update.error ?? (update.data?.length === 0 ? null : 'zmienił')).not.toBe('zmienił');
    const del = await ksiegowa.from('expense_acceptances').delete().eq('expense_id', EXPENSE).select();
    expect(del.error ?? (del.data?.length === 0 ? null : 'usunął')).not.toBe('usunął');
    expect(await wiersz()).toMatchObject({ decision: 'accepted' });

    const { data: widzi } = await ksiegowa.from('expense_acceptances').select('expense_id');
    expect(widzi).toEqual([{ expense_id: EXPENSE }]);
    const { data: obcy } = await (await signedIn('other', OTHER_ORG)).from('expense_acceptances').select('expense_id');
    expect(obcy).toEqual([]);

    await admin.from('expenses').delete().eq('id', EXPENSE);
    expect(await wiersz()).toBeNull();
  });
});
