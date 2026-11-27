import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { PgBoss } from 'pg-boss';

import { normalizeNip, receivablesByNip } from '@/lib/contractors/overview';
import { getReceivables } from '@/lib/dashboard/receivables';

import { getRlsTestDatabaseUrl, getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00216 na prawdziwym Postgresie i PostgREST: potwierdzenie salda
 * z kontrahentem (plan kompletnej aplikacji, krok 2.9, część 2, PR A;
 * decyzje D26-D28).
 *
 * - saldo liczy baza tym samym warunkiem co Pulpit i tabela Kontrahenci
 *   (`getReceivables` rozłożone po NIP przez `receivablesByNip`): ta sama lista
 *   faktur i ta sama kwota co do grosza, ROZ resztą po zaliczkach;
 * - zestawienie nie milczy o fakturach, których nie umie policzyć (korekta,
 *   korekta do zapłaty, zaliczka z rozliczeniem poza KSeF albo już rozliczona w KSeF (D57), faktura bez numeru KSeF (D57),
 *   import, waluta obca);
 *   wystawienie z nimi tylko świadomie;
 * - numer PS/n/rok nadaje baza, seria na firmę i rok, bez dubli przy kilku
 *   wystawieniach naraz; ta sama treść drugi raz to ten sam dokument;
 * - dokument powstaje tylko z treści, którą klient widział (odcisk), a po
 *   wystawieniu nie zmienia go nikt, także klucz serwisowy;
 * - firma i rola z sesji, wyłącznik w global_feature_flags, historia wysyłek
 *   raz na klucz idempotencji.
 */

const hasDatabase = Boolean(
  process.env.RLS_TEST_SUPABASE_URL?.trim() &&
    process.env.RLS_TEST_SUPABASE_ANON_KEY?.trim() &&
    process.env.RLS_TEST_SUPABASE_SERVICE_ROLE_KEY?.trim(),
);
const hasDirectDb = hasDatabase && Boolean(process.env.RLS_TEST_DATABASE_URL?.trim());
const environment = hasDatabase ? getRlsTestEnvironment() : null;
const admin: SupabaseClient = environment
  ? createClient(environment.url, environment.serviceRoleKey)
  : (null as unknown as SupabaseClient);

const ORG_A = '00216216-0000-4000-8000-00000000000a';
const ORG_B = '00216216-0000-4000-8000-00000000000b';
const KONTRAHENT_A = '00216216-1111-4000-8000-00000000000a';
const KONTRAHENT_INNY = '00216216-1111-4000-8000-0000000000a2';
const KONTRAHENT_B = '00216216-1111-4000-8000-00000000000b';
const EMAILS = {
  owner: 'rls-saldo-owner@ksef-saas.test',
  member: 'rls-saldo-member@ksef-saas.test',
  accountant: 'rls-saldo-ksiegowa@ksef-saas.test',
  zawieszony: 'rls-saldo-zawieszony@ksef-saas.test',
  obcy: 'rls-saldo-obcy@ksef-saas.test',
} as const;
type Kto = keyof typeof EMAILS;
const PASS = 'RlsSaldo2026Aa!';
const NIP = '1234567890';
const NIP_INNY = '1234567891';
const FLAGA = 'balanceConfirmationsEnabled';
const ADRES_A = { countryCode: 'PL', addressLine1: 'ul. Przykładowa 1', addressLine2: '00-001 Warszawa' };
const DELETE_GUARD_TEXT = 'cannot be deleted; issue a new balance confirmation instead';
const GUARD_TEXT = 'is final; issue a new balance confirmation instead of editing it';

const users: Record<Kto, string> = { owner: '', member: '', accountant: '', zawieszony: '', obcy: '' };
let counter = 0;

interface Pozycja {
  invoiceId: string;
  number: string;
  ksefNumber: string | null;
  issueDate: string;
  dueDate: string | null;
  kind: string;
  type: string;
  gross: number;
  amountDue: number;
  paid: number;
  outstanding: number;
}

interface Pominieta {
  invoiceId: string;
  number: string;
  ksefNumber: string | null;
  issueDate: string;
  kind: string;
  type: string | null;
  currency: string;
  gross: number;
  reason: string;
}

interface Podglad {
  status: string;
  code?: string;
  contractor_id: string;
  as_of: string;
  environment: string;
  currency: string;
  counterparty: Record<string, unknown>;
  issuer: Record<string, unknown>;
  items: Pozycja[];
  omitted: Pominieta[];
  total: number;
  fingerprint: string;
}

function warsawToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
}

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function numer(seq: number, year: number = Number(warsawToday().slice(0, 4))): string {
  return `PS/${seq}/${year}`;
}

function anonClient(activeOrg: string) {
  return createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-active-org': activeOrg } },
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

async function signedIn(who: Kto, activeOrg: string = ORG_A): Promise<SupabaseClient> {
  const c = anonClient(activeOrg);
  const { error } = await c.auth.signInWithPassword({ email: EMAILS[who], password: PASS });
  if (error) throw error;
  return c;
}

async function ustawFlage(enabled: boolean) {
  const { error } = await admin.from('global_feature_flags').upsert({ flag: FLAGA, enabled }, { onConflict: 'flag' });
  if (error) throw error;
}

type Pola = Record<string, unknown>;

/** Faktura sprzedaży przyjęta w KSeF TEST, termin minął 5 dni temu: 1230 zł brutto, nic nie wpłacono. */
async function faktura(fields: Pola = {}, org: string = ORG_A): Promise<string> {
  counter += 1;
  const id = `00216216-2222-4000-8000-${String(counter).padStart(12, '0')}`;
  const number = `FV/216/${counter}`;
  const { error } = await admin.from('invoices').insert({
    id,
    tenant_id: org,
    direction: 'outgoing',
    origin: 'app',
    internal_number: number,
    invoice_type: 'VAT',
    invoice_kind: 'regular',
    issue_date: '2026-10-01',
    payment_due_date: shiftDays(warsawToday(), -5),
    seller_nip: NIP,
    buyer_nip: NIP,
    gross_total: 1230,
    net_total: 1000,
    vat_total: 230,
    fa3_data: { internalNumber: number, type: 'VAT' },
    seller_data: { nip: NIP },
    buyer_data: { nip: NIP, name: 'Kontrahent Testowy' },
    ksef_status: 'accepted',
    ksef_environment: 'test',
    xml_storage_path: 'x.xml',
    ksef_number: `${NIP}-20261001-${String(counter).padStart(12, '0')}-15`,
    ...fields,
  });
  if (error) throw new Error(`insert ${number}: ${error.message}`);
  return id;
}

const SZKIC: Pola = { ksef_status: 'draft', ksef_environment: null, xml_storage_path: null, ksef_number: null };

async function wplata(invoiceId: string, amount: number, org: string = ORG_A) {
  const { error } = await admin.from('payments').insert({
    tenant_id: org, invoice_id: invoiceId, amount, payment_date: '2026-10-05', is_confirmed: true, match_method: 'bank_import',
  });
  if (error) throw new Error(`wpłata ${invoiceId}: ${error.message}`);
}

async function kontrahent(id: string, nip: string, extra: Pola = {}, org: string = ORG_A) {
  const { error } = await admin.from('contractors').insert({
    id, tenant_id: org, nip, name: `Kontrahent ${nip}`,
    address: { countryCode: 'PL', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa' },
    email: 'ksiegowosc@kontrahent.test',
    ...extra,
  });
  if (error) throw new Error(`kontrahent ${nip}: ${error.message}`);
}

async function podglad(c: SupabaseClient, contractorId: string = KONTRAHENT_A, env = 'test'): Promise<Podglad> {
  const { data, error } = await c.rpc('balance_confirmation_preview', { p_contractor_id: contractorId, p_ksef_environment: env });
  if (error) throw new Error(`podgląd: ${error.message}`);
  return data as Podglad;
}

function wystaw(c: SupabaseClient, fingerprint: string | null, opts: { contractorId?: string; bezPominietych?: boolean; env?: string } = {}) {
  return c.rpc('issue_balance_confirmation', {
    p_contractor_id: opts.contractorId ?? KONTRAHENT_A,
    p_ksef_environment: opts.env ?? 'test',
    p_fingerprint: fingerprint,
    p_without_omitted: opts.bezPominietych ?? false,
  });
}

async function dokumenty(org: string = ORG_A): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await admin.from('balance_confirmations').select('*').eq('tenant_id', org).order('number_seq', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Array<Record<string, unknown>>;
}

async function audyt(id: string, action: string) {
  const { data, error } = await admin
    .from('audit_logs')
    .select('tenant_id, user_id, action, entity_type, entity_id, metadata')
    .eq('entity_id', id)
    .eq('action', action);
  if (error) throw error;
  return data ?? [];
}

/** Pięciu kontrahentów do serii naraz; NIP-y inne niż NIP i NIP_INNY (UNIQUE tenant_id, nip). */
const KONTRAHENCI_SERII = [1, 2, 3, 4, 5].map((n) => ({
  id: `00216216-1111-4000-8000-0000000000c${n}`,
  nip: `98765432${10 + n}`,
}));

/**
 * 00218 (N1): wystawionego dokumentu nie usuwa nikt, także klucz serwisowy. Sprzątanie testu robi sesja
 * operatora (postgres z flagą app.allow_balance_confirmation_delete w jednej transakcji), jak opisuje runbook.
 * Bez RLS_TEST_DATABASE_URL (sam PostgREST) dokumenty zostają, a numeracja zaczyna się od kolejnego numeru.
 */
async function usunDokumenty() {
  if (!process.env.RLS_TEST_DATABASE_URL?.trim()) return;
  const boss = new PgBoss({ connectionString: getRlsTestDatabaseUrl(), schema: 'pgboss', schedule: false, supervise: false });
  await boss.start();
  try {
    await (boss.getDb() as unknown as { executeSql: (q: string) => Promise<unknown> }).executeSql(
      `BEGIN;
       SET LOCAL app.allow_balance_confirmation_delete = 'on';
       DELETE FROM public.balance_confirmation_emails WHERE tenant_id IN ('${ORG_A}', '${ORG_B}');
       DELETE FROM public.balance_confirmations WHERE tenant_id IN ('${ORG_A}', '${ORG_B}');
       COMMIT;`,
    );
  } finally {
    await boss.stop({ graceful: false, close: true });
  }
}

async function cleanup() {
  await usunDokumenty();
  for (const org of [ORG_A, ORG_B]) {
    await admin.from('balance_confirmation_emails').delete().eq('tenant_id', org);
    await admin.from('payments').delete().eq('tenant_id', org);
    await admin.from('invoices').delete().eq('tenant_id', org).eq('invoice_kind', 'correction');
    await admin.from('invoices').delete().eq('tenant_id', org).eq('invoice_kind', 'final');
    await admin.from('invoices').delete().eq('tenant_id', org);
  }
  await admin.from('contractors').delete().in('tenant_id', [ORG_A, ORG_B]);
  await kontrahent(KONTRAHENT_A, NIP);
  await kontrahent(KONTRAHENT_INNY, NIP_INNY);
  await kontrahent(KONTRAHENT_B, NIP, {}, ORG_B);
}

describe.skipIf(!hasDatabase)('00216: potwierdzenie salda na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    for (const who of Object.keys(EMAILS) as Kto[]) users[who] = await userId(EMAILS[who]);
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
    // Wpisy audytu firmy testowej zostają po przebiegu (00052), więc firmy nie kasujemy, tylko nadpisujemy.
    const tenants = await admin.from('tenants').upsert(
      [
        { id: ORG_A, nip: NIP, name: 'Firma A Saldo', address_json: ADRES_A },
        { id: ORG_B, nip: NIP, name: 'Firma B Saldo', address_json: { countryCode: 'PL', addressLine1: 'ul. Inna 2', addressLine2: '00-002 Warszawa' } },
      ],
      { onConflict: 'id' },
    );
    if (tenants.error) throw tenants.error;
    const profiles = await admin.from('users').upsert(
      (Object.keys(users) as Kto[]).map((who) => ({ id: users[who], name: who })),
      { onConflict: 'id' },
    );
    if (profiles.error) throw profiles.error;
    const memberships = await admin.from('memberships').insert([
      { organization_id: ORG_A, user_id: users.owner, role: 'owner', status: 'active' },
      { organization_id: ORG_A, user_id: users.member, role: 'member', status: 'active' },
      { organization_id: ORG_A, user_id: users.accountant, role: 'accountant', status: 'active' },
      { organization_id: ORG_A, user_id: users.zawieszony, role: 'member', status: 'suspended' },
      { organization_id: ORG_B, user_id: users.obcy, role: 'owner', status: 'active' },
    ]);
    if (memberships.error) throw memberships.error;
    await ustawFlage(true);
  });

  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await ustawFlage(false);
    await usunDokumenty();
    for (const org of [ORG_A, ORG_B]) {
      await admin.from('balance_confirmation_emails').delete().eq('tenant_id', org);
      await admin.from('payments').delete().eq('tenant_id', org);
      await admin.from('invoices').delete().eq('tenant_id', org).eq('invoice_kind', 'correction');
      await admin.from('invoices').delete().eq('tenant_id', org).eq('invoice_kind', 'final');
      await admin.from('invoices').delete().eq('tenant_id', org);
    }
    await admin.from('contractors').delete().in('tenant_id', [ORG_A, ORG_B]);
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
  });

  describe('saldo liczy baza tym samym warunkiem co Pulpit', () => {
    it('pozycje i kwota co do grosza jak getReceivables po NIP kontrahenta; pominięte z powodem; reszta nie wchodzi', async () => {
      // Wchodzą: zwykła, częściowo zapłacona (NIP z myślnikami w danych nabywcy: kolumna buyer_nip to
      // varchar(10), więc zapis z myślnikami bywa tylko w buyer_data), uproszczona z NIP ze spacjami
      // w danych nabywcy (0,30 − 0,10), zaliczka bez rozliczenia, ROZ (reszta po zaliczkach z payment_data.amountDue).
      const f1 = await faktura({ issue_date: '2026-09-01' });
      const f2 = await faktura({
        issue_date: '2026-09-02', gross_total: 500, net_total: 406.5, vat_total: 93.5,
        buyer_nip: null, buyer_data: { nip: '123-456-78-90', name: 'Kontrahent Testowy' },
      });
      await wplata(f2, 200);
      const f3 = await faktura({
        issue_date: '2026-09-03', invoice_type: 'UPR', gross_total: 0.3, net_total: 0.24, vat_total: 0.06,
        buyer_nip: null, buyer_data: { nip: ' 1234567890 ', name: 'Kontrahent Testowy' },
      });
      await wplata(f3, 0.1);
      const z1 = await faktura({ issue_date: '2026-09-04', invoice_type: 'ZAL', invoice_kind: 'advance', advance_amount: 1000, gross_total: 1000, net_total: 813.01, vat_total: 186.99 });
      const z2 = await faktura({ issue_date: '2026-09-05', invoice_type: 'ZAL', invoice_kind: 'advance', advance_amount: 3000, gross_total: 3000, net_total: 2439.02, vat_total: 560.98 });
      const r2 = await faktura({
        issue_date: '2026-09-06', invoice_type: 'ROZ', invoice_kind: 'final', advance_invoice_ids: [z2],
        gross_total: 10000, net_total: 8130.08, vat_total: 1869.92, payment_data: { amountDue: 7000 },
      });
      // Pominięte: zaliczka z ROZ, której nie ma w KSeF; faktura z korektą; korekta in plus do zapłaty;
      // import bez daty zapłaty; waluta obca.
      const z3 = await faktura({ issue_date: '2026-09-07', invoice_type: 'ZAL', invoice_kind: 'advance', advance_amount: 400, gross_total: 400, net_total: 325.2, vat_total: 74.8 });
      await faktura({ ...SZKIC, invoice_type: 'ROZ', invoice_kind: 'final', advance_invoice_ids: [z3], gross_total: 2000, net_total: 1626.02, vat_total: 373.98, payment_data: { amountDue: 1600 } });
      const k1 = await faktura({ issue_date: '2026-09-08', gross_total: 2000, net_total: 1626.02, vat_total: 373.98 });
      await faktura({
        invoice_type: 'KOR', invoice_kind: 'correction', parent_invoice_id: k1, correction_reason: 'rabat', correction_type: 'before_after',
        gross_total: -200, net_total: -162.6, vat_total: -37.4,
      });
      const k2 = await faktura({ issue_date: '2026-09-09', gross_total: 800, net_total: 650.41, vat_total: 149.59 });
      await wplata(k2, 800);
      const kor2 = await faktura({
        issue_date: '2026-09-10', invoice_type: 'KOR', invoice_kind: 'correction', parent_invoice_id: k2, correction_reason: 'dopłata',
        correction_type: 'before_after', gross_total: 100, net_total: 81.3, vat_total: 18.7,
      });
      const imp1 = await faktura({ issue_date: '2026-09-11', origin: 'ksef_import', gross_total: 400, net_total: 325.2, vat_total: 74.8 });
      const fx1 = await faktura({ issue_date: '2026-09-12', currency: 'EUR', gross_total: 100, net_total: 81.3, vat_total: 18.7 });
      // Nie wchodzą wcale: import zapłacony według FA(3), faktura do paragonu, zapłacona, inne środowisko,
      // inny NIP (także gdy dane nabywcy mają NIP kontrahenta: buyer_nip ma pierwszeństwo, jak buyerNipOf),
      // szkic, faktura zakupu, faktura innej firmy.
      await faktura({ origin: 'file_import', fa3_data: { parsed: { paidDate: '2026-09-20' } } });
      await faktura({ fa3_data: { internalNumber: 'FP/1', type: 'VAT', receipt: { receiptNumber: 'P/1', receiptDate: '2026-09-30', cashRegisterNumber: 'ABC1234567890' } } });
      const zaplacona = await faktura({ gross_total: 50, net_total: 40.65, vat_total: 9.35 });
      await wplata(zaplacona, 50);
      await faktura({ ksef_environment: 'production' });
      await faktura({ buyer_nip: NIP_INNY, buyer_data: { nip: NIP_INNY, name: 'Inny kontrahent' } });
      await faktura({ buyer_nip: NIP_INNY, buyer_data: { nip: NIP, name: 'Kontrahent Testowy' } });
      await faktura(SZKIC);
      await faktura({ direction: 'incoming', origin: 'ksef_inbox', ksef_status: 'received', xml_storage_path: null });
      await faktura({}, ORG_B);
      const owner = await signedIn('owner');

      const p = await podglad(owner);

      expect(p.status).toBe('ok');
      expect(p.items.map((i) => i.invoiceId)).toEqual([f1, f2, f3, z1, r2]);
      // D57: z2 ma przyjętą fakturę rozliczającą (r2), więc nie jest należnością, ale zestawienie o niej nie milczy.
      expect(p.items.map((i) => i.outstanding)).toEqual([1230, 300, 0.2, 1000, 7000]);
      expect(p.items.find((i) => i.invoiceId === r2)).toMatchObject({ kind: 'final', type: 'ROZ', gross: 10000, amountDue: 7000, paid: 0, outstanding: 7000 });
      expect(p.items.find((i) => i.invoiceId === f2)).toMatchObject({ gross: 500, amountDue: 500, paid: 200, outstanding: 300 });
      expect(p.items.find((i) => i.invoiceId === f1)).toMatchObject({
        number: expect.stringMatching(/^FV\/216\/\d+$/), ksefNumber: expect.stringMatching(/^1234567890-20261001-\d{12}-15$/),
        issueDate: '2026-09-01', dueDate: shiftDays(warsawToday(), -5), kind: 'regular', type: 'VAT',
      });
      expect(p.total).toBe(9530.2);
      expect(p.omitted.map((o) => [o.invoiceId, o.reason])).toEqual([
        [z2, 'advance_settled'],
        [z3, 'advance_settlement'],
        [k1, 'corrected'],
        [kor2, 'correction_due'],
        [imp1, 'imported'],
        [fx1, 'foreign_currency'],
      ]);
      expect(p.omitted.find((o) => o.invoiceId === fx1)).toMatchObject({ currency: 'EUR', gross: 100 });
      expect(p).toMatchObject({
        contractor_id: KONTRAHENT_A,
        as_of: warsawToday(),
        environment: 'test',
        currency: 'PLN',
        counterparty: { name: `Kontrahent ${NIP}`, nip: NIP, countryCode: 'PL', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa', email: 'ksiegowosc@kontrahent.test' },
        issuer: { name: 'Firma A Saldo', nip: NIP, ...ADRES_A },
      });
      expect(p.fingerprint).toMatch(/^[0-9a-f]{32}$/);

      // Ta sama sesja i te same faktury, liczone przez Pulpit i tabelę Kontrahenci.
      const pulpit = await getReceivables(owner as unknown as Parameters<typeof getReceivables>[0], ORG_A);
      const tegoKontrahenta = pulpit.byInvoice.filter((inv) => normalizeNip(inv.buyerNip) === NIP);
      expect(tegoKontrahenta.map((inv) => inv.id).sort()).toEqual(p.items.map((i) => i.invoiceId).sort());
      for (const inv of tegoKontrahenta) {
        expect(p.items.find((i) => i.invoiceId === inv.id)?.outstanding, inv.id).toBe(inv.outstanding);
      }
      expect(receivablesByNip(pulpit).get(NIP)?.outstanding).toBe(p.total);
      expect(pulpit.foreignCurrencyCount).toBe(1);
    }, 30_000);

    it('podgląd innego kontrahenta tej firmy liczy tylko jego NIP; obca firma widzi tylko swoje faktury', async () => {
      await faktura();
      const inna = await faktura({ buyer_nip: NIP_INNY, buyer_data: { nip: NIP_INNY, name: 'Inny kontrahent' }, gross_total: 90, net_total: 73.17, vat_total: 16.83 });
      const obcaFaktura = await faktura({ gross_total: 999, net_total: 812.2, vat_total: 186.8 }, ORG_B);
      const owner = await signedIn('owner');
      const obcy = await signedIn('obcy', ORG_B);

      expect((await podglad(owner, KONTRAHENT_INNY)).items.map((i) => i.invoiceId)).toEqual([inna]);
      const b = await podglad(obcy, KONTRAHENT_B);
      expect(b.items.map((i) => i.invoiceId)).toEqual([obcaFaktura]);
      expect(b.total).toBe(999);
    });

    it('D57: faktura w kolejce, w wysyłce albo offline (bez numeru KSeF) to pominięta awaiting_ksef_number, nie saldo; szkic i inne środowisko nie', async () => {
      const BEZ_NUMERU: Pola = { ksef_environment: null, ksef_number: null };
      const kolejka = await faktura({ ...BEZ_NUMERU, ksef_status: 'queued', issue_date: '2026-09-01' });
      const wysylka = await faktura({ ...BEZ_NUMERU, ksef_status: 'sending', issue_date: '2026-09-02' });
      const offline = await faktura({ ...BEZ_NUMERU, ksef_status: 'offline_queued', issue_date: '2026-09-03' });
      const zaliczkaWKolejce = await faktura({ ...BEZ_NUMERU, ksef_status: 'queued', invoice_type: 'ZAL', invoice_kind: 'advance', advance_amount: 100, issue_date: '2026-09-04' });
      const przyjeta = await faktura({ issue_date: '2026-09-05' });
      // Nie wchodzą wcale: szkic, nieudana wysyłka, zapłacona w kolejce, cudza firma.
      await faktura(SZKIC);
      await faktura({ ...BEZ_NUMERU, ksef_status: 'failed' });
      const zaplaconaWKolejce = await faktura({ ...BEZ_NUMERU, ksef_status: 'queued', gross_total: 50, net_total: 40.65, vat_total: 9.35 });
      await wplata(zaplaconaWKolejce, 50);
      await faktura({ ...BEZ_NUMERU, ksef_status: 'queued' }, ORG_B);
      const owner = await signedIn('owner');

      const p = await podglad(owner);

      expect(p.items.map((i) => i.invoiceId)).toEqual([przyjeta]);
      expect(p.total).toBe(1230);
      expect(p.omitted.map((o) => [o.invoiceId, o.reason])).toEqual([
        [kolejka, 'awaiting_ksef_number'],
        [wysylka, 'awaiting_ksef_number'],
        [offline, 'awaiting_ksef_number'],
        [zaliczkaWKolejce, 'awaiting_ksef_number'],
      ]);
      expect(p.omitted[0]).toMatchObject({ ksefNumber: null, kind: 'regular', gross: 1230 });
      // Wystawienie z nimi tylko świadomie (D57), a dokument zachowuje powód.
      expect((await wystaw(owner, p.fingerprint)).data).toEqual({ status: 'refused', code: 'omitted_not_confirmed' });
      const { data, error } = await wystaw(owner, p.fingerprint, { bezPominietych: true });
      expect(error).toBeNull();
      expect((data as { status: string }).status).toBe('issued');
      const [doc] = await dokumenty();
      expect((doc!.omitted as Pominieta[]).map((o) => o.reason)).toEqual(Array(4).fill('awaiting_ksef_number'));
    }, 30_000);

    it('kontrahent bez należności: podgląd z pustą listą, wystawienie to odmowa nothing_due bez dokumentu', async () => {
      const zaplacona = await faktura();
      await wplata(zaplacona, 1230);
      const owner = await signedIn('owner');

      const p = await podglad(owner);

      expect(p).toMatchObject({ status: 'ok', items: [], omitted: [], total: 0 });
      expect((await wystaw(owner, p.fingerprint)).data).toEqual({ status: 'refused', code: 'nothing_due' });
      expect(await dokumenty()).toEqual([]);
    });
  });

  describe('wystawienie', () => {
    it('numer PS/1/rok, dokument to migawka podglądu, audyt wystawienia', async () => {
      await faktura();
      const owner = await signedIn('owner');
      const p = await podglad(owner);

      const { data, error } = await wystaw(owner, p.fingerprint);

      expect(error).toBeNull();
      expect(data).toMatchObject({ status: 'issued', number: numer(1) });
      const [doc] = await dokumenty();
      expect(doc).toMatchObject({
        id: (data as { id: string }).id,
        tenant_id: ORG_A,
        contractor_id: KONTRAHENT_A,
        number: numer(1),
        number_seq: 1,
        number_year: Number(warsawToday().slice(0, 4)),
        as_of: warsawToday(),
        ksef_environment: 'test',
        currency: 'PLN',
        counterparty: p.counterparty,
        issuer: p.issuer,
        items: p.items,
        omitted: [],
        fingerprint: p.fingerprint,
        issued_by: users.owner,
      });
      expect(Number(doc!.total)).toBe(1230);
      expect(await audyt(doc!.id as string, 'balance_confirmation.issued')).toEqual([
        expect.objectContaining({
          tenant_id: ORG_A, user_id: users.owner, entity_type: 'balance_confirmation',
          metadata: expect.objectContaining({ number: numer(1), items: 1, omitted: 0, environment: 'test' }),
        }),
      ]);
    });

    it.each(['member', 'accountant'] as const)('%s też wystawia (każdy aktywny członek, jak przy notach)', async (who) => {
      await faktura();
      const c = await signedIn(who);
      const p = await podglad(c);

      expect((await wystaw(c, p.fingerprint)).data).toMatchObject({ status: 'issued', number: numer(1) });
      expect((await dokumenty())[0]).toMatchObject({ issued_by: users[who] });
    });

    it('ta sama treść drugi raz: ten sam dokument i numer, jeden wpis audytu', async () => {
      await faktura();
      const owner = await signedIn('owner');
      const p = await podglad(owner);
      const pierwszy = await wystaw(owner, p.fingerprint);

      const drugi = await wystaw(owner, p.fingerprint);

      expect(drugi.data).toEqual({ status: 'already_issued', id: (pierwszy.data as { id: string }).id, number: numer(1) });
      expect(await dokumenty()).toHaveLength(1);
      expect(await audyt((pierwszy.data as { id: string }).id, 'balance_confirmation.issued')).toHaveLength(1);
    });

    it('dwa wystawienia tej samej treści naraz: jeden numer, drugi wynik „już wystawione”', async () => {
      await faktura();
      const owner = await signedIn('owner');
      const p = await podglad(owner);

      const wyniki = await Promise.all([wystaw(owner, p.fingerprint), wystaw(owner, p.fingerprint)]);

      expect(wyniki.map((w) => w.error)).toEqual([null, null]);
      expect(wyniki.map((w) => (w.data as { status: string }).status).sort()).toEqual(['already_issued', 'issued']);
      expect(new Set(wyniki.map((w) => (w.data as { number: string }).number))).toEqual(new Set([numer(1)]));
      expect(await dokumenty()).toHaveLength(1);
    });

    it('pięć wystawień naraz dla pięciu kontrahentów: numery 1-5 bez dubli i bez luk; obca firma ma własną serię', async () => {
      for (const k of KONTRAHENCI_SERII) {
        await kontrahent(k.id, k.nip);
        await faktura({ buyer_nip: k.nip, buyer_data: { nip: k.nip, name: `Kontrahent ${k.nip}` } });
      }
      await faktura({}, ORG_B);
      const owner = await signedIn('owner');
      const podglady = await Promise.all(KONTRAHENCI_SERII.map((k) => podglad(owner, k.id)));

      const wyniki = await Promise.all(KONTRAHENCI_SERII.map((k, i) => wystaw(owner, podglady[i]!.fingerprint, { contractorId: k.id })));

      expect(wyniki.map((w) => w.error)).toEqual([null, null, null, null, null]);
      expect(wyniki.map((w) => (w.data as { number: string }).number).sort()).toEqual([1, 2, 3, 4, 5].map((n) => numer(n)).sort());
      const obcy = await signedIn('obcy', ORG_B);
      const b = await podglad(obcy, KONTRAHENT_B);
      expect((await wystaw(obcy, b.fingerprint, { contractorId: KONTRAHENT_B })).data).toMatchObject({ status: 'issued', number: numer(1) });
    }, 30_000);

    it('treść zmieniona po podglądzie (wpłata, dane kontrahenta): odmowa changed bez dokumentu', async () => {
      const f = await faktura();
      const owner = await signedIn('owner');
      const przedWplata = await podglad(owner);
      await wplata(f, 100);

      expect((await wystaw(owner, przedWplata.fingerprint)).data).toEqual({ status: 'refused', code: 'changed' });

      const przedZmiana = await podglad(owner);
      expect(przedZmiana.items[0]?.outstanding).toBe(1130);
      const zmiana = await admin.from('contractors').update({ name: 'Nowa nazwa kontrahenta' }).eq('id', KONTRAHENT_A);
      if (zmiana.error) throw zmiana.error;

      expect((await wystaw(owner, przedZmiana.fingerprint)).data).toEqual({ status: 'refused', code: 'changed' });
      expect((await wystaw(owner, null)).data).toEqual({ status: 'refused', code: 'changed' });
      expect(await dokumenty()).toEqual([]);
    });

    it('pominięte dokumenty: bez świadomego „Wystaw bez tych dokumentów” odmowa, z nim dokument z listą pominiętych', async () => {
      await faktura();
      const fx = await faktura({ currency: 'EUR', gross_total: 100, net_total: 81.3, vat_total: 18.7 });
      const owner = await signedIn('owner');
      const p = await podglad(owner);
      expect(p.omitted.map((o) => [o.invoiceId, o.reason])).toEqual([[fx, 'foreign_currency']]);

      expect((await wystaw(owner, p.fingerprint)).data).toEqual({ status: 'refused', code: 'omitted_not_confirmed', omitted_count: 1 });
      expect(await dokumenty()).toEqual([]);

      const { data } = await wystaw(owner, p.fingerprint, { bezPominietych: true });

      expect(data).toMatchObject({ status: 'issued', number: numer(1) });
      const [doc] = await dokumenty();
      expect(doc).toMatchObject({ omitted: p.omitted, items: p.items });
      expect(await audyt(doc!.id as string, 'balance_confirmation.issued')).toEqual([
        expect.objectContaining({ metadata: expect.objectContaining({ omitted: 1 }) }),
      ]);
    });
  });

  describe('odmowy z kodem (aplikacja robi z nich komunikat z wyjściem)', () => {
    it('wyłącznik zdjęty: podgląd i wystawienie odmawiają disabled', async () => {
      await faktura();
      const owner = await signedIn('owner');
      const p = await podglad(owner);
      await ustawFlage(false);
      try {
        expect(await podglad(owner)).toEqual({ status: 'refused', code: 'disabled' });
        expect((await wystaw(owner, p.fingerprint)).data).toEqual({ status: 'refused', code: 'disabled' });
        expect(await dokumenty()).toEqual([]);
      } finally {
        await ustawFlage(true);
      }
    });

    it('kontrahent innej firmy wygląda jak brak kontrahenta; kontrahent bez NIP: odmowa', async () => {
      const owner = await signedIn('owner');
      expect(await podglad(owner, KONTRAHENT_B)).toEqual({ status: 'refused', code: 'contractor_not_found' });
      const bezNip = '00216216-1111-4000-8000-0000000000d1';
      await kontrahent(bezNip, ' - ');
      expect(await podglad(owner, bezNip)).toEqual({ status: 'refused', code: 'contractor_nip_missing' });
      expect((await wystaw(owner, 'a'.repeat(32), { contractorId: bezNip })).data).toEqual({ status: 'refused', code: 'contractor_nip_missing' });
    });

    it('niepełne dane firmy: odmowa issuer_incomplete', async () => {
      await faktura();
      const owner = await signedIn('owner');
      const bezAdresu = await admin.from('tenants').update({ address_json: null }).eq('id', ORG_A);
      if (bezAdresu.error) throw bezAdresu.error;
      try {
        expect(await podglad(owner)).toEqual({ status: 'refused', code: 'issuer_incomplete' });
      } finally {
        await admin.from('tenants').update({ address_json: ADRES_A }).eq('id', ORG_A);
      }
    });

    it('nieznane środowisko KSeF w wywołaniu to błąd wywołania 22023, nie puste saldo', async () => {
      const owner = await signedIn('owner');
      const { error } = await owner.rpc('balance_confirmation_preview', { p_contractor_id: KONTRAHENT_A, p_ksef_environment: 'staging' });
      expect(error?.code).toBe('22023');
      expect((await wystaw(owner, 'a'.repeat(32), { env: 'staging' })).error?.code).toBe('22023');
    });

    describe.skipIf(!hasDirectDb)('dane sprzed środowisk KSeF (postgres bez RLS)', () => {
      interface Db { executeSql(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> }
      let boss: PgBoss;
      const db = () => boss.getDb() as unknown as Db;

      beforeAll(async () => {
        boss = new PgBoss({ connectionString: getRlsTestDatabaseUrl(), schema: 'pgboss', schedule: false, supervise: false });
        await boss.start();
      }, 60_000);

      afterAll(async () => {
        await boss?.stop({ graceful: false, close: true });
      });

      it('przyjęta faktura kontrahenta bez środowiska: odmowa environment_unknown, nie saldo bez niej', async () => {
        await faktura();
        const id = '00216216-2222-4000-8000-0000000000e1';
        await db().executeSql(
          `INSERT INTO public.invoices (id, tenant_id, direction, origin, internal_number, invoice_type, invoice_kind, issue_date,
             payment_due_date, seller_nip, buyer_nip, gross_total, net_total, vat_total, fa3_data, seller_data, buyer_data,
             ksef_status, ksef_environment, xml_storage_path, ksef_number)
           VALUES ($1, $2, 'outgoing', 'app', 'FV/216/STARA', 'VAT', 'regular', '2026-01-10', '2026-01-24', $3, $3,
             100, 81.3, 18.7, $4::jsonb, $5::jsonb, $6::jsonb, 'accepted', NULL, 'x.xml', $7)`,
          [
            id, ORG_A, NIP,
            JSON.stringify({ internalNumber: 'FV/216/STARA', type: 'VAT' }),
            JSON.stringify({ nip: NIP }),
            JSON.stringify({ nip: NIP, name: 'Kontrahent Testowy' }),
            `${NIP}-20260110-000000021599-15`,
          ],
        );
        const owner = await signedIn('owner');

        expect(await podglad(owner)).toEqual({ status: 'refused', code: 'environment_unknown', count: 1 });
        expect(await dokumenty()).toEqual([]);
      });

      it('postgres: DELETE odrzucony także właścicielowi bazy; flaga operatora w transakcji pozwala, bez niej znów nie', async () => {
        await faktura();
        const owner = await signedIn('owner');
        const p = await podglad(owner);
        const { data } = await wystaw(owner, p.fingerprint);
        const id = (data as { id: string }).id;

        await expect(db().executeSql('DELETE FROM public.balance_confirmations WHERE id = $1', [id])).rejects.toThrow(DELETE_GUARD_TEXT);
        await db().executeSql(
          `BEGIN; SET LOCAL app.allow_balance_confirmation_delete = 'on'; DELETE FROM public.balance_confirmation_emails WHERE confirmation_id = '${id}'; DELETE FROM public.balance_confirmations WHERE id = '${id}'; COMMIT;`,
        );
        expect(await dokumenty()).toEqual([]);
      });

      it('postgres: usunięcie firmy (RODO) kaskadą kasuje wystawione potwierdzenie i wysyłki bez flagi operatora; bezpośredni DELETE nadal pada', async () => {
        const ORG_C = '00216216-0000-4000-8000-00000000000c';
        const KONTRAHENT_C = '00216216-1111-4000-8000-00000000000c';
        const tenantRows = async () => (await db().executeSql(
          `SELECT (SELECT count(*) FROM public.balance_confirmations WHERE tenant_id = '${ORG_C}')::int AS dokumenty,
                  (SELECT count(*) FROM public.balance_confirmation_emails WHERE tenant_id = '${ORG_C}')::int AS maile,
                  (SELECT count(*) FROM public.tenants WHERE id = '${ORG_C}')::int AS firmy`,
        )).rows[0];
        // Wpisy audytu firmy kasuje kaskada tylko z flagą czyszczenia audytu (00052); flagi strażnika potwierdzeń NIE ustawiamy.
        const usunFirme = () => db().executeSql(
          `BEGIN; SET LOCAL app.allow_audit_purge = 'true'; DELETE FROM public.tenants WHERE id = '${ORG_C}'; COMMIT;`,
        );
        await usunFirme();
        try {
          const t = await admin.from('tenants').insert({ id: ORG_C, nip: NIP, name: 'Firma C Saldo', address_json: ADRES_A });
          if (t.error) throw t.error;
          const m = await admin.from('memberships').insert({ organization_id: ORG_C, user_id: users.owner, role: 'owner', status: 'active' });
          if (m.error) throw m.error;
          await kontrahent(KONTRAHENT_C, NIP, {}, ORG_C);
          await faktura({}, ORG_C);
          const owner = await signedIn('owner', ORG_C);
          const p = await podglad(owner, KONTRAHENT_C);
          const { data } = await wystaw(owner, p.fingerprint, { contractorId: KONTRAHENT_C });
          const id = (data as { id: string }).id;
          const mail = await owner.rpc('record_balance_confirmation_email', {
            p_confirmation_id: id, p_recipient: 'ksiegowosc@kontrahent.test', p_idempotency_key: `saldo/${id}/c/0`, p_provider_message_id: 'msg-c',
          });
          expect(mail.data).toMatchObject({ status: 'recorded' });
          expect(await tenantRows()).toEqual({ dokumenty: 1, maile: 1, firmy: 1 });

          // Bez flagi operatora bezpośredni DELETE dokumentu pada (strażnik działa na poziomie 1)...
          await expect(db().executeSql('DELETE FROM public.balance_confirmations WHERE id = $1', [id])).rejects.toThrow(DELETE_GUARD_TEXT);
          expect(await tenantRows()).toEqual({ dokumenty: 1, maile: 1, firmy: 1 });

          // ...a usunięcie firmy (kaskada z tenants przez wysyłki i potwierdzenia) przechodzi i nie zostawia wierszy.
          await usunFirme();
          expect(await tenantRows()).toEqual({ dokumenty: 0, maile: 0, firmy: 0 });
        } finally {
          await usunFirme();
        }
      });

      it('postgres: wyzwalacz odrzuca zmianę treści wystawionego dokumentu także właścicielowi bazy', async () => {
        await faktura();
        const owner = await signedIn('owner');
        const p = await podglad(owner);
        const { data } = await wystaw(owner, p.fingerprint);
        const id = (data as { id: string }).id;

        await expect(db().executeSql('UPDATE public.balance_confirmations SET as_of = as_of - 1 WHERE id = $1', [id])).rejects.toThrow(GUARD_TEXT);
      });
    });
  });

  describe('firma, rola i osoba z sesji', () => {
    it('zawieszony członek nie czyta, nie liczy i nie wystawia', async () => {
      await faktura();
      const owner = await signedIn('owner');
      const p = await podglad(owner);
      await wystaw(owner, p.fingerprint);
      const z = await signedIn('zawieszony');

      expect((await z.from('balance_confirmations').select('id')).data).toEqual([]);
      expect((await z.rpc('balance_confirmation_preview', { p_contractor_id: KONTRAHENT_A, p_ksef_environment: 'test' })).error?.code).toBe('42501');
      expect((await wystaw(z, p.fingerprint)).error?.code).toBe('42501');
    });

    it('obca firma nie widzi dokumentów ani historii wysyłek i nie liczy salda kontrahenta firmy A, także z nagłówkiem firmy A', async () => {
      await faktura();
      const owner = await signedIn('owner');
      const p = await podglad(owner);
      const { data } = await wystaw(owner, p.fingerprint);
      const id = (data as { id: string }).id;
      await owner.rpc('record_balance_confirmation_email', {
        p_confirmation_id: id, p_recipient: 'a@b.pl', p_idempotency_key: `saldo/${id}/x/0`, p_provider_message_id: null,
      });
      const obcy = await signedIn('obcy', ORG_B);

      expect((await obcy.from('balance_confirmations').select('id').eq('id', id)).data).toEqual([]);
      expect((await obcy.from('balance_confirmation_emails').select('id').eq('confirmation_id', id)).data).toEqual([]);
      expect(await podglad(obcy, KONTRAHENT_A)).toEqual({ status: 'refused', code: 'contractor_not_found' });
      const podszyty = await signedIn('obcy', ORG_A);
      expect((await podszyty.rpc('balance_confirmation_preview', { p_contractor_id: KONTRAHENT_A, p_ksef_environment: 'test' })).error?.code).toBe('42501');
      expect((await podszyty.from('balance_confirmations').select('id')).data).toEqual([]);
    });

    it('bez sesji (anon) nie ma dostępu do tabel ani funkcji', async () => {
      const anon = anonClient(ORG_A);
      expect((await anon.from('balance_confirmations').select('id')).error).not.toBeNull();
      expect((await anon.from('balance_confirmation_emails').select('id')).error).not.toBeNull();
      expect((await anon.rpc('balance_confirmation_preview', { p_contractor_id: KONTRAHENT_A, p_ksef_environment: 'test' })).error).not.toBeNull();
      expect((await wystaw(anon, 'a'.repeat(32))).error).not.toBeNull();
    });

    it('funkcje wewnętrzne z firmą w argumencie są niedostępne dla sesji', async () => {
      const owner = await signedIn('owner');
      expect((await owner.rpc('balance_confirmation_build', { p_tenant_id: ORG_B, p_contractor_id: KONTRAHENT_B, p_ksef_environment: 'test' })).error).not.toBeNull();
      expect((await owner.rpc('balance_confirmation_lines', { p_tenant_id: ORG_B, p_nip: NIP, p_ksef_environment: 'test' })).error).not.toBeNull();
    });
  });

  describe('wystawionego dokumentu nie zmienia nikt', () => {
    async function wystawiony(): Promise<{ owner: SupabaseClient; id: string }> {
      await faktura();
      const owner = await signedIn('owner');
      const p = await podglad(owner);
      const { data, error } = await wystaw(owner, p.fingerprint);
      if (error) throw error;
      return { owner, id: (data as { id: string }).id };
    }

    it('klient nie wstawi, nie zmieni i nie usunie dokumentu z pominięciem RPC', async () => {
      const { owner, id } = await wystawiony();
      const [doc] = await dokumenty();

      expect((await owner.from('balance_confirmations').insert({ ...doc, id: undefined, number_seq: 2, number: numer(2) })).error?.message).toMatch(/permission denied/);
      expect((await owner.from('balance_confirmations').update({ total: 1 }).eq('id', id)).error?.message).toMatch(/permission denied/);
      expect((await owner.from('balance_confirmations').delete().eq('id', id)).error?.message).toMatch(/permission denied/);
      expect(await dokumenty()).toEqual([doc]);
    });

    it('klucz serwisowy: wyzwalacz odrzuca zmianę treści, numeru i przepięcie kontrahenta', async () => {
      const { id } = await wystawiony();
      for (const zmiana of [{ items: [] }, { total: 1 }, { number: numer(9), number_seq: 9 }, { as_of: '2026-01-02' }, { contractor_id: KONTRAHENT_INNY }]) {
        const { error } = await admin.from('balance_confirmations').update(zmiana).eq('id', id).select('id');
        expect(error?.message, JSON.stringify(zmiana)).toContain(GUARD_TEXT);
      }
    });

    it('N1: klucz serwisowy nie usunie dokumentu, numer zostaje w serii', async () => {
      const { id } = await wystawiony();

      const { error } = await admin.from('balance_confirmations').delete().eq('id', id).select('id');

      expect(error?.message).toContain(DELETE_GUARD_TEXT);
      expect((await dokumenty()).map((d) => d.number)).toEqual([numer(1)]);
    });

    it('usunięcie kontrahenta z bazy: dokument zostaje z migawką, bez wskazania kontrahenta', async () => {
      const { id } = await wystawiony();
      const [przed] = await dokumenty();

      const { error } = await admin.from('contractors').delete().eq('id', KONTRAHENT_A);

      expect(error).toBeNull();
      const [po] = await dokumenty();
      expect(po).toMatchObject({ id, contractor_id: null, counterparty: przed!.counterparty, items: przed!.items, number: przed!.number });
    });
  });

  describe('treść dokumentu pilnowana w bazie (CHECK)', () => {
    const POZYCJA = {
      invoiceId: '00216216-2222-4000-8000-0000000000f1', number: 'FV/1', ksefNumber: null, issueDate: '2026-10-01', dueDate: null,
      kind: 'regular', type: 'VAT', gross: 100, amountDue: 100, paid: 40, outstanding: 60,
    };
    const STRONA = { name: 'Firma', nip: NIP, countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' };

    function wiersz(extra: Pola = {}): Pola {
      return {
        tenant_id: ORG_A, contractor_id: KONTRAHENT_A, number: numer(1, 2026), number_year: 2026, number_seq: 1, as_of: '2026-11-25',
        ksef_environment: 'test', currency: 'PLN', counterparty: STRONA, issuer: STRONA, items: [POZYCJA], total: 60, omitted: [],
        fingerprint: 'b'.repeat(32), ...extra,
      };
    }

    it('poprawny wiersz przechodzi (punkt odniesienia dla odmów niżej)', async () => {
      const { error } = await admin.from('balance_confirmations').insert(wiersz()).select('id');
      expect(error).toBeNull();
    });

    it.each(['advance_settled', 'awaiting_ksef_number'])('powód pominięcia %s przechodzi CHECK (D57)', async (reason) => {
      const omitted = [{ invoiceId: POZYCJA.invoiceId, number: 'FV/2', ksefNumber: null, issueDate: '2026-10-01', kind: 'advance', type: 'ZAL', currency: 'PLN', gross: 10, reason }];
      const { error } = await admin.from('balance_confirmations').insert(wiersz({ omitted })).select('id');
      expect(error).toBeNull();
    });

    it.each([
      ['numer niezgodny z serią', { number: 'PS/2/2026' }, /balance_confirmations_number_check/],
      ['rok numeru inny niż rok dnia salda', { number: 'PS/1/2025', number_year: 2025 }, /balance_confirmations_number_check/],
      ['suma różna od pozycji', { total: 61 }, /balance_confirmations_total_check/],
      ['do zapłaty różne od kwoty minus wpłaty', { items: [{ ...POZYCJA, outstanding: 61 }], total: 61 }, /balance_confirmations_items_check/],
      ['zwykła faktura z kwotą do zapłaty inną niż brutto', { items: [{ ...POZYCJA, amountDue: 90, outstanding: 50 }], total: 50 }, /balance_confirmations_items_check/],
      ['pozycja z trzema miejscami po przecinku', { items: [{ ...POZYCJA, paid: 40.005, outstanding: 59.995 }], total: 59.995 }, /balance_confirmations_(items|total)_check/],
      ['kwota tekstem', { items: [{ ...POZYCJA, outstanding: '60' }] }, /balance_confirmations_(items|total)_check/],
      ['korekta jako pozycja', { items: [{ ...POZYCJA, kind: 'correction', type: 'KOR' }] }, /balance_confirmations_items_check/],
      ['brak pozycji', { items: [], total: 0 }, /balance_confirmations_(items|total)_check/],
      ['pominięta z nieznanym powodem', { omitted: [{ invoiceId: POZYCJA.invoiceId, number: 'FV/2', ksefNumber: null, issueDate: '2026-10-01', kind: 'regular', type: 'VAT', currency: 'PLN', gross: 10, reason: 'inny' }] }, /balance_confirmations_omitted_check/],
      ['waluta inna niż PLN', { currency: 'EUR' }, /balance_confirmations_currency_check/],
      ['kontrahent bez nazwy', { counterparty: { ...STRONA, name: ' ' } }, /balance_confirmations_counterparty_check/],
      ['zły odcisk', { fingerprint: 'xyz' }, /balance_confirmations_fingerprint_check/],
    ])('odmowa: %s', async (_nazwa, zmiana, ograniczenie) => {
      const { error } = await admin.from('balance_confirmations').insert(wiersz(zmiana)).select('id');
      expect(error?.message).toMatch(ograniczenie);
    });
  });

  describe('historia wysyłek mailem', () => {
    async function wystawiony(): Promise<{ owner: SupabaseClient; id: string }> {
      await faktura();
      const owner = await signedIn('owner');
      const p = await podglad(owner);
      const { data } = await wystaw(owner, p.fingerprint);
      return { owner, id: (data as { id: string }).id };
    }

    it('zapis raz na klucz idempotencji (ponowienie nie dubluje), audyt raz', async () => {
      const { owner, id } = await wystawiony();
      const args = { p_confirmation_id: id, p_recipient: 'Ksiegowosc@Kontrahent.test', p_idempotency_key: `saldo/${id}/abc/0`, p_provider_message_id: 'msg-1' };

      const pierwszy = await owner.rpc('record_balance_confirmation_email', args);
      const drugi = await owner.rpc('record_balance_confirmation_email', args);

      expect(pierwszy.data).toMatchObject({ status: 'recorded' });
      expect(drugi.data).toEqual({ status: 'already_recorded' });
      const { data } = await owner.from('balance_confirmation_emails').select('recipient').eq('confirmation_id', id);
      expect(data).toEqual([{ recipient: 'ksiegowosc@kontrahent.test' }]);
      expect(await audyt(id, 'balance_confirmation.emailed')).toEqual([
        expect.objectContaining({ tenant_id: ORG_A, user_id: users.owner, entity_type: 'balance_confirmation', metadata: expect.objectContaining({ number: numer(1), recipient: 'ksiegowosc@kontrahent.test' }) }),
      ]);
    });

    it('klucz innego dokumentu i cudzy dokument: odmowa bez zapisu', async () => {
      const { owner, id } = await wystawiony();
      const inny = '00216216-3333-4000-8000-000000000001';
      expect((await owner.rpc('record_balance_confirmation_email', {
        p_confirmation_id: id, p_recipient: 'a@b.pl', p_idempotency_key: `saldo/${inny}/x/0`, p_provider_message_id: null,
      })).data).toEqual({ status: 'refused', code: 'invalid_key' });
      const obcy = await signedIn('obcy', ORG_B);
      expect((await obcy.rpc('record_balance_confirmation_email', {
        p_confirmation_id: id, p_recipient: 'a@b.pl', p_idempotency_key: `saldo/${id}/x/0`, p_provider_message_id: null,
      })).data).toEqual({ status: 'refused', code: 'not_found' });
      expect((await admin.from('balance_confirmation_emails').select('id').eq('confirmation_id', id)).data).toEqual([]);
    });

    it('klient nie dopisze historii z pominięciem RPC', async () => {
      const { owner, id } = await wystawiony();
      const { error } = await owner.from('balance_confirmation_emails').insert({
        tenant_id: ORG_A, confirmation_id: id, recipient: 'a@b.pl', idempotency_key: `saldo/${id}/x/0`,
      });
      expect(error?.message).toMatch(/permission denied/);
    });
  });
});
