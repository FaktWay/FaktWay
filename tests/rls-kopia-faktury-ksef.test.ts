import { randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * FZ-022, decyzja D29 (00215, RP-KOSZT-01): kopia faktury z KSeF spoza KSeF
 * (zdjęcie, wpis ręczny, import) łączy się w bazie z kosztem z KSeF tego
 * samego dokumentu (`link_ksef_expense_copy`), gdy jest dokładnie jedna,
 * oba koszty liczą się w KPiR, a miesiące obu nie są złożone; wtedy kopia
 * wypada z KPiR (`public.expenses.is_deductible = false`), a kategoria nadana
 * jej ręcznie przechodzi na koszt z KSeF. Kilka kopii, dwa koszty z KSeF
 * z tym samym numerem albo miesiąc złożony (rozliczenie w module, wysyłka
 * JPK_V7M na produkcję, eksport KPiR albo JPK): bez łączenia, zadanie dla
 * klienta. Ponowienie niczego nie zmienia, „Rozłącz” przywraca kopię
 * i zostaje decyzją, a strażnik `guard_linked_ksef_copy_expense` na
 * 'expenses' nie pozwala klientowi wliczyć połączonej kopii.
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

const ORG = '00215215-0000-4000-8000-00000000000a';
const ORG_B = '00215215-0000-4000-8000-00000000000b';
const OWNER_EMAIL = 'rls-kopia-ksef-owner@ksef-saas.test';
const PASS = 'RlsKopiaKsef2026Aa!';
const NIP = '5260001246';
const NUMER = 'FV/7/02/2027';
const STRAZNIK =
  'Ten koszt to kopia faktury z KSeF, więc koszt i VAT liczą się z faktury z KSeF. Żeby wliczyć kopię, najpierw trzeba rozłączyć koszty przyciskiem „Rozłącz”.';

const OTHER_EMAIL = 'rls-kopia-ksef-inna-firma@ksef-saas.test';
const NBSP = String.fromCharCode(0xa0);

let ownerId = '';
let otherId = '';
let owner: SupabaseClient;
let counter = 0;
// Losowe identyfikatory: `audit_logs` nie da się kasować (00052), więc drugi przebieg na tej samej bazie liczy tylko swoje wpisy.
const nextId = () => randomUUID();

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

async function signedIn(email: string, org: string): Promise<SupabaseClient> {
  const c = createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-active-org': org } },
  });
  const { error } = await c.auth.signInWithPassword({ email, password: PASS });
  if (error) throw error;
  return c;
}

/** Koszt z KSeF: faktura zakupu przyjęta w KSeF i koszt ze Skrzynki, jak zapisuje je runner. */
async function zKsef(org: string, numer = NUMER, data = '2027-02-05', pola: Record<string, unknown> = {}, srodowisko = 'test'): Promise<string> {
  const invoiceId = nextId();
  counter += 1;
  const invoice = await admin.from('invoices').insert({
    id: invoiceId, tenant_id: org, direction: 'incoming', origin: 'ksef_inbox', internal_number: numer,
    invoice_type: 'VAT', invoice_kind: 'regular', issue_date: data, seller_nip: NIP, buyer_nip: '1234567890',
    gross_total: 123, net_total: 100, vat_total: 23, currency: 'PLN', ksef_status: 'accepted', ksef_environment: srodowisko,
    ksef_number: `${NIP}-${data.replace(/-/g, '')}-${String(counter).padStart(12, '0')}-00`, xml_storage_path: 'x.xml',
    fa3_data: { _source: 'inbox-metadata', _pendingFullFetch: false },
  });
  if (invoice.error) throw new Error(`faktura ${numer}: ${invoice.error.message}`);
  return koszt(org, numer, data, { source: 'ksef_inbox', ksef_invoice_id: invoiceId, categorization_method: 'rule_keyword', ...pola });
}

/** Koszt spoza KSeF (domyślnie zdjęcie); zwraca id. */
async function koszt(org: string, numer: string, data: string, pola: Record<string, unknown> = {}): Promise<string> {
  const id = nextId();
  const { error } = await admin.from('expenses').insert({
    id, tenant_id: org, created_by: ownerId, source: 'ocr_photo', ksef_invoice_id: null, seller_name: 'Dostawca',
    seller_nip: NIP, document_number: numer, document_type: 'invoice', issue_date: data, net_amount: 100, vat_amount: 23,
    gross_amount: 123, vat_deductible_amount: 23, kpir_column: 'col_13', category_label: 'Usługi', categorization_method: 'ai_claude',
    is_deductible: true, is_reviewed: true, ...pola,
  });
  if (error) throw new Error(`koszt ${numer}: ${error.message}`);
  return id;
}

async function polacz(org: string, expenseId: string): Promise<unknown> {
  const { data, error } = await admin.rpc('link_ksef_expense_copy', {
    p_tenant_id: org, p_expense_id: expenseId, p_ksef_environment: 'test', p_auto_link: true,
  });
  if (error) throw new Error(`link_ksef_expense_copy: ${error.message}`);
  return data;
}

async function decyzja(ksefId: string, copyId: string | null, aktor = ownerId, srodowisko = 'test'): Promise<unknown> {
  const { data, error } = await admin.rpc('decide_ksef_expense_copy', {
    p_tenant_id: ORG, p_ksef_expense_id: ksefId, p_actor_user_id: aktor, p_ksef_environment: srodowisko, p_copy_expense_id: copyId,
  });
  if (error) throw new Error(`decide_ksef_expense_copy: ${error.message}`);
  return data;
}

async function stan(id: string): Promise<Record<string, unknown>> {
  const { data, error } = await admin
    .from('expenses')
    .select('is_deductible, is_reviewed, kpir_column, category_label, categorization_method')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data as Record<string, unknown>;
}

async function polaczenia(org = ORG): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await admin
    .from('expense_ksef_copies')
    .select('ksef_expense_id, copy_expense_id, status, copy_was_deductible')
    .eq('tenant_id', org)
    .order('copy_expense_id');
  if (error) throw error;
  return data ?? [];
}

async function metadaneAudytu(akcja: string, ksefId: string): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await admin.from('audit_logs').select('metadata').eq('tenant_id', ORG).eq('action', akcja).eq('entity_id', ksefId);
  if (error) throw error;
  return (data ?? []).map((r) => r.metadata as Record<string, unknown>);
}

async function audyt(akcja: string, ksefId: string): Promise<number> {
  const { count, error } = await admin
    .from('audit_logs')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', ORG)
    .eq('action', akcja)
    .eq('entity_id', ksefId);
  if (error) throw error;
  return count ?? 0;
}

async function cleanup() {
  for (const org of [ORG, ORG_B]) {
    for (const tabela of ['expense_ksef_copies', 'expense_receipt_matches', 'export_jobs', 'jpk_submissions', 'tax_settlements', 'expenses', 'invoices']) {
      const { error } = await admin.from(tabela).delete().eq('tenant_id', org);
      if (error) throw new Error(`sprzątanie ${tabela}: ${error.message}`);
    }
  }
}

describe.skipIf(!hasDatabase)('FZ-022, D29 (00215): kopia faktury z KSeF łączy się z kosztem z KSeF', () => {
  beforeAll(async () => {
    ownerId = await userId(OWNER_EMAIL);
    otherId = await userId(OTHER_EMAIL);
    await cleanup();
    await admin.from('memberships').delete().in('organization_id', [ORG, ORG_B]);
    const { error: tErr } = await admin.from('tenants').upsert(
      [
        { id: ORG, nip: '1234567890', name: 'Firma FZ-022 D29 A' },
        { id: ORG_B, nip: '1234567890', name: 'Firma FZ-022 D29 B' },
      ],
      { onConflict: 'id' },
    );
    if (tErr) throw tErr;
    await admin.from('users').upsert([{ id: ownerId, name: 'Owner FZ-022 D29' }, { id: otherId, name: 'Inna firma FZ-022 D29' }], { onConflict: 'id' });
    const { error: mErr } = await admin.from('memberships').insert([
      { organization_id: ORG, user_id: ownerId, role: 'owner', status: 'active' },
      { organization_id: ORG_B, user_id: otherId, role: 'owner', status: 'active' },
    ]);
    if (mErr) throw mErr;
    owner = await signedIn(OWNER_EMAIL, ORG);
  }, 120_000);

  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await cleanup();
    await admin.from('memberships').delete().in('organization_id', [ORG, ORG_B]);
  });

  it('jedna kopia (numer małymi literami ze spacją): łączy się, kopia poza KPiR, audyt; ponowienie niczego nie zmienia', async () => {
    const ksef = await zKsef(ORG);
    const kopia = await koszt(ORG, 'fv/7/02/2027 ', '2027-02-05');
    expect(await polacz(ORG, ksef)).toBe('linked');
    expect(await stan(kopia)).toMatchObject({ is_deductible: false });
    expect(await stan(ksef)).toMatchObject({ is_deductible: true });
    expect(await polaczenia()).toEqual([{ ksef_expense_id: ksef, copy_expense_id: kopia, status: 'linked', copy_was_deductible: true }]);
    expect(await audyt('expense.ksef_copy_linked', ksef)).toBe(1);

    expect(await polacz(ORG, ksef)).toBe('already_linked');
    expect(await polacz(ORG, kopia)).toBe('already_linked');
    expect(await polaczenia()).toHaveLength(1);
    expect(await audyt('expense.ksef_copy_linked', ksef)).toBe(1);
  });

  it('zdjęcie po koszcie z KSeF (wołanie z kopii, jak runner OCR): to samo połączenie', async () => {
    const ksef = await zKsef(ORG);
    const kopia = await koszt(ORG, NUMER, '2027-02-05');
    expect(await polacz(ORG, kopia)).toBe('linked');
    expect(await polaczenia()).toMatchObject([{ ksef_expense_id: ksef, copy_expense_id: kopia, status: 'linked' }]);
  });

  it('kategoria nadana kopii ręcznie przechodzi na koszt z KSeF; ręczna kategoria kosztu z KSeF zostaje', async () => {
    const ksef = await zKsef(ORG);
    await koszt(ORG, NUMER, '2027-02-05', { kpir_column: 'col_11', category_label: 'Transport', categorization_method: 'manual' });
    expect(await polacz(ORG, ksef)).toBe('linked');
    expect(await stan(ksef)).toMatchObject({ kpir_column: 'col_11', category_label: 'Transport', categorization_method: 'manual' });
    // Kategoria sprzed przejęcia zostaje w audycie (po „Rozłącz” kosztowi z KSeF zostaje kategoria kopii).
    expect((await metadaneAudytu('expense.ksef_copy_linked', ksef))[0]).toMatchObject({
      categoryFromCopy: true, ksefCategoryBefore: { kpirColumn: 'col_13', categoryLabel: 'Usługi', method: 'rule_keyword' },
    });

    await cleanup();
    const ksefReczny = await zKsef(ORG, NUMER, '2027-02-05', { kpir_column: 'col_10', category_label: 'Towary', categorization_method: 'manual' });
    await koszt(ORG, NUMER, '2027-02-05', { kpir_column: 'col_11', category_label: 'Transport', categorization_method: 'manual' });
    expect(await polacz(ORG, ksefReczny)).toBe('linked');
    expect(await stan(ksefReczny)).toMatchObject({ kpir_column: 'col_10', category_label: 'Towary', categorization_method: 'manual' });
  });

  describe('bezpiecznik D29: miesiąc złożony daje zadanie, nie połączenie', () => {
    const zadanie = async (ksef: string, kopia: string) => {
      expect(await polacz(ORG, ksef)).toBe('candidates');
      expect(await stan(kopia)).toMatchObject({ is_deductible: true });
      expect(await polaczenia()).toEqual([{ ksef_expense_id: ksef, copy_expense_id: kopia, status: 'candidate', copy_was_deductible: null }]);
      // Zadanie nie zmienia kosztu z KSeF (`is_reviewed` pilnuje też przeglądu waluty).
      expect(await stan(ksef)).toMatchObject({ is_deductible: true, is_reviewed: true });
      expect(await audyt('expense.ksef_copy_candidates', ksef)).toBe(1);
      expect((await metadaneAudytu('expense.ksef_copy_candidates', ksef))[0]).toMatchObject({ reason: 'filed_period' });
      // Ponowienie nie dubluje zadania ani wpisu w audycie.
      expect(await polacz(ORG, ksef)).toBe('candidates');
      expect(await polaczenia()).toHaveLength(1);
      expect(await audyt('expense.ksef_copy_candidates', ksef)).toBe(1);
    };

    it('udany eksport KPiR za luty', async () => {
      const ksef = await zKsef(ORG);
      const kopia = await koszt(ORG, NUMER, '2027-02-05');
      const { error } = await admin.from('export_jobs').insert({
        tenant_id: ORG, format: 'kpir_excel', period_start: '2027-02-01', period_end: '2027-02-28', status: 'completed',
        completed_at: '2027-03-02T10:00:00Z', include_issued: true, include_received: true,
      });
      if (error) throw new Error(`export_jobs: ${error.message}`);
      await zadanie(ksef, kopia);
    });

    it('wysyłka JPK_V7M za luty na bramkę produkcyjną (wysyłka na bramkę testową nie blokuje)', async () => {
      const jpk = (srodowisko: string) =>
        admin.from('jpk_submissions').insert({
          tenant_id: ORG, okres: '2027-02-01', rodzaj: 'JPK_V7M', cel: 1, srodowisko,
          skrot_pliku: 'AM/SlQpito+9Ctp5oFY8PT+eS1PXNokUptIKKh3xMCw=', deklaracja: {},
        });
      const testowa = await jpk('test');
      if (testowa.error) throw new Error(`jpk_submissions: ${testowa.error.message}`);
      const ksefTest = await zKsef(ORG);
      await koszt(ORG, NUMER, '2027-02-05');
      expect(await polacz(ORG, ksefTest)).toBe('linked');

      await cleanup();
      const produkcyjna = await jpk('produkcja');
      if (produkcyjna.error) throw new Error(`jpk_submissions: ${produkcyjna.error.message}`);
      const ksef = await zKsef(ORG);
      const kopia = await koszt(ORG, NUMER, '2027-02-05');
      await zadanie(ksef, kopia);
    });

    it('rozliczenie w module zależne od kosztów za miesiąc kopii (kopia ze stycznia, faktura z KSeF z lutego); ryczałt nie blokuje', async () => {
      const rozliczenie = (rodzaj: string) =>
        admin.from('tax_settlements').insert({
          tenant_id: ORG, okres: '2027-01-01', rodzaj, wersja: 1, kwota_gr: 10000, termin: '2027-02-20',
          migawka: { wejscia: { lancuch: [] }, spoleczneBezFpGr: 0 }, parametry_wersja: 'abcd1234abcd1234', wejscia_hash: 'a'.repeat(64),
        });
      for (const rodzaj of ['ryczalt', 'zus_spoleczne']) {
        await cleanup();
        const r = await rozliczenie(rodzaj);
        if (r.error) throw new Error(`tax_settlements ${rodzaj}: ${r.error.message}`);
        const ksefBez = await zKsef(ORG, NUMER, '2027-02-05');
        await koszt(ORG, NUMER, '2027-01-31');
        expect(await polacz(ORG, ksefBez), rodzaj).toBe('linked');
      }
      for (const rodzaj of ['pit', 'vat', 'zdrowotna']) {
        await cleanup();
        const r = await rozliczenie(rodzaj);
        if (r.error) throw new Error(`tax_settlements ${rodzaj}: ${r.error.message}`);
        const ksef = await zKsef(ORG, NUMER, '2027-02-05');
        const kopia = await koszt(ORG, NUMER, '2027-01-31');
        await zadanie(ksef, kopia);
        expect((await metadaneAudytu('expense.ksef_copy_candidates', ksef))[0]).toMatchObject({ months: ['2027-01', '2027-02'] });
      }
    });

    it('D65 (00220): zgłoszenie za późniejszy miesiąc składa też miesiące wcześniejsze, każde z trzech źródeł; miesiąc wcześniejszy nie składa późniejszego', async () => {
      const rozliczenie = () =>
        admin.from('tax_settlements').insert({
          tenant_id: ORG, okres: '2027-04-01', rodzaj: 'pit', wersja: 1, kwota_gr: 10000, termin: '2027-05-20',
          migawka: { wejscia: { lancuch: [] }, spoleczneBezFpGr: 0 }, parametry_wersja: 'abcd1234abcd1234', wejscia_hash: 'a'.repeat(64),
        });
      const wysylka = () =>
        admin.from('jpk_submissions').insert({
          tenant_id: ORG, okres: '2027-04-01', rodzaj: 'JPK_V7M', cel: 1, srodowisko: 'produkcja',
          skrot_pliku: 'AM/SlQpito+9Ctp5oFY8PT+eS1PXNokUptIKKh3xMCw=', deklaracja: {},
        });
      const eksport = (format: string) =>
        admin.from('export_jobs').insert({
          tenant_id: ORG, format, period_start: '2027-04-01', period_end: '2027-04-30', status: 'completed',
          completed_at: '2027-05-02T10:00:00Z', include_issued: true, include_received: true,
        });
      const zrodla: Array<[string, () => PromiseLike<{ error: { message: string } | null }>]> = [
        ['rozliczenie PIT', rozliczenie], ['wysyłka JPK_V7M', wysylka], ['eksport KPiR', () => eksport('kpir_excel')], ['eksport JPK_V7M', () => eksport('jpk_v7m')],
      ];
      for (const [nazwa, wstaw] of zrodla) {
        await cleanup();
        const r = await wstaw();
        if (r.error) throw new Error(`${nazwa}: ${r.error.message}`);
        // Koszty z lutego i marca, zgłoszenie za kwiecień: złożone.
        const ksef = await zKsef(ORG, NUMER, '2027-02-05');
        const kopia = await koszt(ORG, NUMER, '2027-03-05');
        await zadanie(ksef, kopia);
      }
      // Zgłoszenie za wcześniejszy miesiąc (luty) nie składa marca.
      await cleanup();
      const wczesniejszy = await admin.from('jpk_submissions').insert({
        tenant_id: ORG, okres: '2027-02-01', rodzaj: 'JPK_V7M', cel: 1, srodowisko: 'produkcja',
        skrot_pliku: 'AM/SlQpito+9Ctp5oFY8PT+eS1PXNokUptIKKh3xMCw=', deklaracja: {},
      });
      if (wczesniejszy.error) throw new Error(`jpk_submissions: ${wczesniejszy.error.message}`);
      const ksefMarzec = await zKsef(ORG, NUMER, '2027-03-05');
      await koszt(ORG, NUMER, '2027-03-06');
      expect(await polacz(ORG, ksefMarzec)).toBe('linked');
    });

    it('złożony miesiąc kosztu z KSeF (kopia z niezłożonego miesiąca)', async () => {
      const { error } = await admin.from('export_jobs').insert({
        tenant_id: ORG, format: 'kpir_excel', period_start: '2027-02-01', period_end: '2027-02-28', status: 'completed',
        completed_at: '2027-03-02T10:00:00Z', include_issued: true, include_received: true,
      });
      if (error) throw new Error(`export_jobs: ${error.message}`);
      const ksef = await zKsef(ORG, NUMER, '2027-02-05');
      const kopia = await koszt(ORG, NUMER, '2027-01-31');
      await zadanie(ksef, kopia);
    });
  });

  it('dwie kopie: zadanie dla obu bez łączenia; wybór klienta łączy jedną, druga zostaje osobnym kosztem', async () => {
    const ksef = await zKsef(ORG);
    const a = await koszt(ORG, NUMER, '2027-02-05');
    const b = await koszt(ORG, NUMER, '2027-02-05', { source: 'manual' });
    expect(await polacz(ORG, ksef)).toBe('candidates');
    expect((await polaczenia()).map((m) => m.status)).toEqual(['candidate', 'candidate']);
    expect((await metadaneAudytu('expense.ksef_copy_candidates', ksef))[0]).toMatchObject({ reason: 'several_copies' });
    // Klient wyłącza jedną kopię: druga zostaje jedyną, ale czeka już na decyzję, więc nie łączy się sama.
    const wylacz = await admin.from('expenses').update({ is_deductible: false }).eq('id', b);
    if (wylacz.error) throw wylacz.error;
    expect(await polacz(ORG, ksef)).toBe('candidates');
    expect(await stan(a)).toMatchObject({ is_deductible: true });
    const przywroc = await admin.from('expenses').update({ is_deductible: true }).eq('id', b);
    if (przywroc.error) throw przywroc.error;

    expect(await decyzja(ksef, a)).toBe('linked');
    expect(await stan(a)).toMatchObject({ is_deductible: false });
    expect(await stan(b)).toMatchObject({ is_deductible: true });
    const stany = new Map((await polaczenia()).map((m) => [m.copy_expense_id, m.status]));
    expect([stany.get(a), stany.get(b)]).toEqual(['linked', 'dismissed']);
    expect(await decyzja(ksef, b)).toBe('stale');
  });

  it('dwa koszty z KSeF z tym samym numerem (np. faktura i korekta): bez łączenia', async () => {
    await zKsef(ORG);
    await zKsef(ORG, NUMER, '2027-02-20');
    const kopia = await koszt(ORG, NUMER, '2027-02-05');
    expect(await polacz(ORG, kopia)).toBe('ambiguous_ksef');
    expect(await polaczenia()).toEqual([]);
  });

  it('kopia wyłączona już przez klienta albo koszt z KSeF poza KPiR (przegląd waluty): bez łączenia', async () => {
    const ksef = await zKsef(ORG);
    await koszt(ORG, NUMER, '2027-02-05', { is_deductible: false });
    expect(await polacz(ORG, ksef)).toBe('no_candidates');

    await cleanup();
    const ksefPoza = await zKsef(ORG, NUMER, '2027-02-05', { is_deductible: false });
    const kopia = await koszt(ORG, NUMER, '2027-02-05');
    expect(await polacz(ORG, ksefPoza)).toBe('not_deductible');
    expect(await stan(kopia)).toMatchObject({ is_deductible: true });
    expect(await polaczenia()).toEqual([]);
  });

  it('ten sam numer w innym roku albo w innej firmie to inny dokument; koszt bez NIP-u nie ma klucza', async () => {
    const ksef = await zKsef(ORG);
    await koszt(ORG, NUMER, '2026-12-30');
    await koszt(ORG_B, NUMER, '2027-02-05');
    expect(await polacz(ORG, ksef)).toBe('no_candidates');
    const bezNipu = await koszt(ORG, NUMER, '2027-02-05', { seller_nip: null });
    expect(await polacz(ORG, bezNipu)).toBe('not_applicable');
    expect(await polaczenia()).toEqual([]);
  });

  it('eksport nieudany albo za wcześniejszy miesiąc i wysyłka JPK odrzucona nie blokują łączenia', async () => {
    const eksport = (status: string, od: string, doDnia: string) =>
      admin.from('export_jobs').insert({
        tenant_id: ORG, format: 'jpk_v7m', period_start: od, period_end: doDnia, status,
        completed_at: status === 'completed' ? '2027-04-02T10:00:00Z' : null, include_issued: true, include_received: true,
      });
    for (const r of [await eksport('failed', '2027-02-01', '2027-02-28'), await eksport('completed', '2027-01-01', '2027-01-31')]) {
      if (r.error) throw new Error(`export_jobs: ${r.error.message}`);
    }
    const jpk = await admin.from('jpk_submissions').insert({
      tenant_id: ORG, okres: '2027-02-01', rodzaj: 'JPK_V7M', cel: 1, srodowisko: 'produkcja',
      skrot_pliku: 'AM/SlQpito+9Ctp5oFY8PT+eS1PXNokUptIKKh3xMCw=', deklaracja: {},
    }).select('id').single();
    if (jpk.error) throw new Error(`jpk_submissions: ${jpk.error.message}`);
    const odrzucona = await admin.from('jpk_submissions').update({ stan: 'odrzucona', blad: 'odrzucona przez MF' }).eq('id', jpk.data.id);
    if (odrzucona.error) throw new Error(`jpk_submissions odrzucona: ${odrzucona.error.message}`);
    const druga = await admin.from('jpk_submissions').insert({
      tenant_id: ORG, okres: '2027-02-01', rodzaj: 'JPK_V7M', cel: 1, srodowisko: 'produkcja',
      skrot_pliku: 'BM/SlQpito+9Ctp5oFY8PT+eS1PXNokUptIKKh3xMCw=', deklaracja: {},
    }).select('id').single();
    if (druga.error) throw new Error(`jpk_submissions: ${druga.error.message}`);
    const przerwana = await admin.from('jpk_submissions').update({ stan: 'przerwana' }).eq('id', druga.data.id);
    if (przerwana.error) throw new Error(`jpk_submissions przerwana: ${przerwana.error.message}`);
    const ksef = await zKsef(ORG);
    await koszt(ORG, NUMER, '2027-02-05');
    expect(await polacz(ORG, ksef)).toBe('linked');
  });

  it('koszt z faktury z innego środowiska KSeF niż aplikacja: nie jest oryginałem, kopia liczy się dalej', async () => {
    await zKsef(ORG, NUMER, '2027-02-05', {}, 'demo');
    const kopia = await koszt(ORG, NUMER, '2027-02-05');
    expect(await polacz(ORG, kopia)).toBe('no_ksef_original');
    expect(await stan(kopia)).toMatchObject({ is_deductible: true });
    expect(await polaczenia()).toEqual([]);
  });

  it('klucz jak w odczycie: twarda spacja w numerze, NIP z „PL” i kreskami to ten sam dokument', async () => {
    const ksef = await zKsef(ORG);
    const kopia = await koszt(ORG, `FV/7/${String.fromCharCode(0x202f)}02/2027${NBSP}`, '2027-02-05', { seller_nip: 'PL 526-000-12-46' });
    expect(await polacz(ORG, ksef)).toBe('linked');
    expect(await stan(kopia)).toMatchObject({ is_deductible: false });
  });

  it('inne brutto kopii (źle odczytana kwota albo numer innej faktury): zadanie z przyczyną, bez łączenia', async () => {
    const ksef = await zKsef(ORG);
    const kopia = await koszt(ORG, NUMER, '2027-02-05', { net_amount: 1000, vat_amount: 230, gross_amount: 1230, vat_deductible_amount: 230 });
    expect(await polacz(ORG, ksef)).toBe('candidates');
    expect(await stan(kopia)).toMatchObject({ is_deductible: true });
    expect((await metadaneAudytu('expense.ksef_copy_candidates', ksef))[0]).toMatchObject({ reason: 'amount_differs', months: ['2027-02'] });
  });

  it('kopia połączona już jako paragon z fakturą do paragonu (00175) nie jest kandydatką', async () => {
    const ksef = await zKsef(ORG);
    const fp = await zKsef(ORG, 'FP/1/02/2027');
    const kopia = await koszt(ORG, NUMER, '2027-02-05');
    const { error } = await admin.from('expense_receipt_matches').insert({
      tenant_id: ORG, invoice_expense_id: fp, receipt_expense_id: kopia, status: 'linked', receipt_was_deductible: true,
    });
    if (error) throw new Error(`expense_receipt_matches: ${error.message}`);
    expect(await polacz(ORG, ksef)).toBe('no_candidates');
  });

  it('RLS: członek firmy czyta połączenia swojej firmy, inna firma nic nie widzi, a klient sesji nic nie zapisuje', async () => {
    const ksef = await zKsef(ORG);
    const kopia = await koszt(ORG, NUMER, '2027-02-05');
    expect(await polacz(ORG, ksef)).toBe('linked');
    const swoje = await owner.from('expense_ksef_copies').select('copy_expense_id');
    expect(swoje.error).toBeNull();
    expect(swoje.data).toEqual([{ copy_expense_id: kopia }]);
    const other = await signedIn(OTHER_EMAIL, ORG_B);
    expect((await other.from('expense_ksef_copies').select('id')).data).toEqual([]);
    const zapis = await owner.from('expense_ksef_copies').update({ status: 'dismissed' }).eq('copy_expense_id', kopia).select('id');
    expect(zapis.error !== null || (zapis.data ?? []).length === 0).toBe(true);
    expect(await polaczenia()).toMatchObject([{ status: 'linked' }]);
  });

  it('decyzja: łączenie tylko w środowisku faktury, rozłączenie także po zmianie środowiska aplikacji (para sprzed zmiany KSEF_ENV)', async () => {
    const ksef = await zKsef(ORG);
    const a = await koszt(ORG, NUMER, '2027-02-05');
    await koszt(ORG, NUMER, '2027-02-05', { source: 'manual' });
    expect(await polacz(ORG, ksef)).toBe('candidates');
    // Aplikacja już na innym środowisku: wybór kopii do faktury z KSeF TEST jest nieaktualny.
    expect(await decyzja(ksef, a, ownerId, 'production')).toBe('stale');
    expect(await decyzja(ksef, a)).toBe('linked');
    // Rozłączenie po zmianie środowiska: kopia wraca do KPiR (bez tego zostałaby poza KPiR, a odczyt pomija koszt z TEST).
    expect(await decyzja(ksef, null, ownerId, 'production')).toBe('separated');
    expect(await stan(a)).toMatchObject({ is_deductible: true });
  });

  it('00217: decyzja nie łączy przy koszcie z KSeF poza KPiR (not_deductible, bez zmian), a „to osobne dokumenty” działa', async () => {
    const ksef = await zKsef(ORG);
    const a = await koszt(ORG, NUMER, '2027-02-05');
    await koszt(ORG, NUMER, '2027-02-05', { source: 'manual' });
    expect(await polacz(ORG, ksef)).toBe('candidates');
    // Klient zgodnie z wyjściem z odmowy wyłącza koszt z KSeF, a potem wybiera kopię.
    const wylacz = await admin.from('expenses').update({ is_deductible: false }).eq('id', ksef);
    if (wylacz.error) throw wylacz.error;
    expect(await decyzja(ksef, a)).toBe('not_deductible');
    expect(await stan(a)).toMatchObject({ is_deductible: true });
    expect((await polaczenia()).map((m) => m.status)).toEqual(['candidate', 'candidate']);
    expect(await decyzja(ksef, null)).toBe('separated');
    // Po włączeniu kosztu z KSeF łączenie wraca.
    await cleanup();
    const ksef2 = await zKsef(ORG);
    const a2 = await koszt(ORG, NUMER, '2027-02-05');
    await koszt(ORG, NUMER, '2027-02-05', { source: 'manual' });
    expect(await polacz(ORG, ksef2)).toBe('candidates');
    expect(await decyzja(ksef2, a2)).toBe('linked');
  });

  it('decyzja osoby spoza firmy: odmowa 42501, bez zmian', async () => {
    const ksef = await zKsef(ORG);
    await koszt(ORG, NUMER, '2027-02-05');
    expect(await polacz(ORG, ksef)).toBe('linked');
    const { error } = await admin.rpc('decide_ksef_expense_copy', {
      p_tenant_id: ORG, p_ksef_expense_id: ksef, p_actor_user_id: otherId, p_ksef_environment: 'test', p_copy_expense_id: null,
    });
    expect(error?.code).toBe('42501');
    expect(await polaczenia()).toMatchObject([{ status: 'linked' }]);
  });

  it("guard_linked_ksef_copy_expense: klient wlicza połączoną kopię do KPiR na 'expenses', odmowa", async () => {
    const ksef = await zKsef(ORG);
    const kopia = await koszt(ORG, NUMER, '2027-02-05');
    expect(await polacz(ORG, ksef)).toBe('linked');
    const { error } = await owner.from('expenses').update({ is_deductible: true }).eq('id', kopia).select('id');
    expect(error?.message).toBe(STRAZNIK);
    expect(await stan(kopia)).toMatchObject({ is_deductible: false });
  });

  it('„Rozłącz”: kopia wraca do KPiR z wartością sprzed połączenia, a ponowienie runnera nie łączy jej znowu', async () => {
    const ksef = await zKsef(ORG);
    const kopia = await koszt(ORG, NUMER, '2027-02-05');
    expect(await polacz(ORG, ksef)).toBe('linked');
    expect(await decyzja(ksef, null)).toBe('separated');
    expect(await stan(kopia)).toMatchObject({ is_deductible: true });
    expect(await polaczenia()).toMatchObject([{ status: 'dismissed' }]);
    expect(await audyt('expense.ksef_copy_separated', ksef)).toBe(1);
    expect(await polacz(ORG, ksef)).toBe('dismissed');
    expect(await polacz(ORG, kopia)).toBe('dismissed');
    expect(await stan(kopia)).toMatchObject({ is_deductible: true });
    expect(await decyzja(ksef, null)).toBe('stale');
  });

  it('tylko serwis: klient sesji nie woła łączenia ani decyzji', async () => {
    const ksef = await zKsef(ORG);
    await koszt(ORG, NUMER, '2027-02-05');
    const link = await owner.rpc('link_ksef_expense_copy', { p_tenant_id: ORG, p_expense_id: ksef, p_ksef_environment: 'test', p_auto_link: true });
    expect(link.error).not.toBeNull();
    const decide = await owner.rpc('decide_ksef_expense_copy', {
      p_tenant_id: ORG, p_ksef_expense_id: ksef, p_actor_user_id: ownerId, p_ksef_environment: 'test',
    });
    expect(decide.error).not.toBeNull();
    expect(await polaczenia()).toEqual([]);
  });
});
