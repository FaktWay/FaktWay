import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * Krok 3.8, część 1 (koszt wpisany ręcznie) na prawdziwej bazie. Od 00127 rola
 * authenticated nie ma INSERT na `expenses`, więc zapis klientem sesji idzie
 * funkcją `expense_create_manual` (00212, SECURITY DEFINER): firma z sesji,
 * `created_by = auth.uid()`, `source = 'manual'` na sztywno, wiersz bez zdjęcia i
 * bez zadania odczytu. Bezpośredni INSERT dalej jest odrzucony (42501), cudza
 * firma nie ma wstępu, a funkcja odrzuca kształt, którego nie ufa klientowi.
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

/** Argumenty funkcji expense_create_manual (00212). */
const rpcArgs = (o: Record<string, unknown> = {}) => ({
  p_seller_name: 'Urząd Miasta',
  p_seller_nip: null,
  p_document_type: 'other',
  p_document_number: null,
  p_issue_date: '2026-11-10',
  p_net_amount: 100,
  p_vat_amount: 0,
  p_gross_amount: 100,
  p_vat_deductible_amount: 0,
  p_kpir_column: 'col_13',
  p_category_label: 'Pozostałe wydatki',
  p_notes: null,
  p_is_deductible: true,
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

  it('członek zapisuje koszt ręczny w swojej firmie przez funkcję, bez zdjęcia i bez zadania odczytu', async () => {
    const member = await signedIn('member', ORG);
    const r = await member.rpc('expense_create_manual', rpcArgs());
    expect(r.error).toBeNull();
    expect(typeof r.data).toBe('string');
    const row = await admin
      .from('expenses')
      .select('tenant_id, created_by, source, ocr_job_id, ksef_invoice_id, source_file_path, ocr_extracted_data, is_reviewed, categorization_method')
      .eq('id', r.data as string)
      .single();
    expect(row.error).toBeNull();
    expect(row.data).toMatchObject({
      tenant_id: ORG,
      created_by: ids.member,
      source: 'manual',
      ocr_job_id: null,
      ksef_invoice_id: null,
      source_file_path: null,
      ocr_extracted_data: null,
      is_reviewed: true,
      categorization_method: 'manual',
    });
  });

  it('członek innej firmy nie zapisze kosztu w cudzej: funkcja bierze firmę z sesji, nie z argumentów', async () => {
    const other = await signedIn('other', OTHER_ORG);
    const r = await other.rpc('expense_create_manual', rpcArgs({ p_seller_name: 'Tylko w mojej firmie' }));
    expect(r.error).toBeNull();
    const row = await admin.from('expenses').select('tenant_id').eq('id', r.data as string).single();
    expect(row.data?.tenant_id).toBe(OTHER_ORG);
    // aktywna firma wskazana nagłówkiem, w której nie ma członkostwa: odmowa, nic nie powstaje
    const obca = await signedIn('other', ORG);
    const odmowa = await obca.rpc('expense_create_manual', rpcArgs({ p_seller_name: 'Cudza firma' }));
    expect(odmowa.error?.code).toBe('42501');
    const wCudzej = await admin.from('expenses').select('id').eq('tenant_id', ORG).eq('seller_name', 'Cudza firma');
    expect(wCudzej.data ?? []).toEqual([]);
  });

  it('bezpośredni INSERT klientem sesji dalej jest odrzucony (00127)', async () => {
    const member = await signedIn('member', ORG);
    expect((await member.from('expenses').insert(koszt(ORG, ids.member))).error?.code).toBe('42501');
    expect((await member.from('expenses').insert(koszt(ORG, ids.other))).error).not.toBeNull();
    expect((await member.from('expenses').insert(koszt(OTHER_ORG, ids.member))).error).not.toBeNull();
    expect((await member.from('expenses').insert(koszt(ORG, ids.member, { source: 'ksef_inbox' }))).error).not.toBeNull();
  });

  it('funkcji nie wywoła rola anon ani klient bez sesji', async () => {
    const anon = anonClient(ORG);
    const r = await anon.rpc('expense_create_manual', rpcArgs());
    expect(r.error).not.toBeNull();
  });

  it('nie da się podać źródła, firmy ani osoby: funkcja nie ma takich argumentów', async () => {
    const member = await signedIn('member', ORG);
    for (const nadmiar of [{ p_source: 'ksef_inbox' }, { p_tenant_id: OTHER_ORG }, { p_created_by: ids.other }]) {
      const r = await member.rpc('expense_create_manual', { ...rpcArgs(), ...nadmiar });
      expect(r.error, JSON.stringify(nadmiar)).not.toBeNull();
    }
    const zle = await admin.from('expenses').select('id').eq('tenant_id', ORG).neq('source', 'manual');
    expect(zle.data ?? []).toEqual([]);
  });

  it.each([
    ['brutto różne od netto + VAT', { p_net_amount: 100, p_vat_amount: 23, p_gross_amount: 124 }],
    ['kwota ujemna', { p_net_amount: -10, p_vat_amount: 0, p_gross_amount: -10 }],
    ['kwota z trzema miejscami', { p_net_amount: 10.004, p_vat_amount: 2.004, p_gross_amount: 12.008 }],
    ['kolumna przychodowa col_7', { p_kpir_column: 'col_7' }],
    ['kolumna spoza enumu', { p_kpir_column: 'col_99' }],
    ['rodzaj dokumentu spoza listy', { p_document_type: 'simplified_invoice' }],
    ['VAT do odliczenia inny niż 0 i cały VAT', { p_document_type: 'invoice', p_net_amount: 100, p_vat_amount: 23, p_gross_amount: 123, p_vat_deductible_amount: 10 }],
    ['VAT do odliczenia z paragonu', { p_document_type: 'receipt', p_net_amount: 100, p_vat_amount: 23, p_gross_amount: 123, p_vat_deductible_amount: 23 }],
    ['data z przyszłości', { p_issue_date: '2099-01-01' }],
    ['pusty sprzedawca', { p_seller_name: '  ' }],
  ])('funkcja odrzuca kształt: %s', async (_nazwa, zmiana) => {
    const member = await signedIn('member', ORG);
    const r = await member.rpc('expense_create_manual', rpcArgs(zmiana));
    expect(r.error?.code).toBe('23514');
  });

  it('faktura z pełnym odliczeniem VAT przechodzi (kształt poprawny)', async () => {
    const member = await signedIn('member', ORG);
    const r = await member.rpc(
      'expense_create_manual',
      rpcArgs({ p_document_type: 'invoice', p_document_number: 'FV/1/2026', p_net_amount: 100, p_vat_amount: 23, p_gross_amount: 123, p_vat_deductible_amount: 23 }),
    );
    expect(r.error).toBeNull();
  });

  it('obca firma nie widzi kosztu', async () => {
    const other = await signedIn('other', OTHER_ORG);
    const r = await other.from('expenses').select('id').eq('tenant_id', ORG);
    expect(r.data ?? []).toEqual([]);
  });
});
