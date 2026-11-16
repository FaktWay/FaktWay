import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { createMobileDbClient } from '@/lib/api/mobile/db';
import type { KorektaTelefonu, ZaliczkaTelefonu } from '@/lib/api/mobile/kontrakt';
import { korektaDoFormularza, zaliczkaDoFormularza } from '@/lib/api/mobile/schematy-rodzaje';
import { deleteDraftInvoice } from '@/lib/invoices/delete-draft';
import { saveAdvance } from '@/lib/invoices/issue-advance';
import { getCorrectionParentContext, saveCorrectionDraft, type CorrectionIssueContext } from '@/lib/invoices/issue-correction';
import { readTenantSnapshot } from '@/lib/invoices/issue-regular';
import { resetInvoiceToDraft } from '@/lib/invoices/ksef-resend';
import { lookupBuyer } from '@/lib/invoices/lookup-buyer';
import type { CorrectionInvoiceSchemaIn } from '@/lib/validators/invoice-validators';

import { getRlsTestEnvironment } from './helpers/rls-environment';

const gus = vi.hoisted(() => vi.fn());
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn(), logAuditWithResult: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/gus/client', () => ({ lookupCompanyByNip: gus }));

/**
 * Plan aplikacji mobilnej, M8b, na prawdziwym GoTrue i PostgREST: zapisy z
 * telefonu tymi samymi funkcjami co trasy `/api/mobile/v1` (i akcje strony),
 * klientem z tokenem sesji i `x-active-org`, bez ciasteczek.
 *
 * 1. Zaliczka: wiersz w firmie z nagłówka; klucz żądania z tą samą trasą
 *    (`POST /api/mobile/v1/faktury`) przechodzi CHECK 00201/00202 także dla zaliczki.
 * 2. Korekta: faktura pierwotna tylko z firmy tokenu; szkic korekty wskazuje ją
 *    (wyzwalacze korekt 00133/00135 przepuszczają zapis klientem z tokenem).
 * 3. Usunięcie szkicu: konto innej firmy go nie usunie.
 * 4. „Wróć do szkicu”: RPC kluczem serwisowym z firmą z bramki; obca firma odmowa.
 * 5. GUS: podpowiedź w kontrahentach firmy z tokenu, niewidoczna dla innej firmy.
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
const A_EMAIL = `rls-m8b-a-${RUN}@ksef-saas.test`;
const B_EMAIL = `rls-m8b-b-${RUN}@ksef-saas.test`;
const PASS = 'RlsMobileM8bPass2026Aa!';

const ORG_A = '000a8b00-0000-4000-8000-000000000001';
const ORG_B = '000a8b00-0000-4000-8000-000000000002';
const PARENT_A = '000a8b00-1000-4000-8000-000000000001';
const FAILED_A = '000a8b00-1000-4000-8000-000000000002';
const KEY_ZAL = '000a8b00-2000-4000-8000-000000000001';
const KEY_KOR = '000a8b00-2000-4000-8000-000000000002';
const ENDPOINT = 'POST /api/mobile/v1/faktury';
// NIP-y z testów strony (fikcyjne firmy), z poprawną sumą kontrolną, której wymaga schemat sprzedawcy.
const NIP_A = '5260001246';
const NIP_NABYWCY = '5252241585';
const DZIS = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
const ADRES = { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' };
const NABYWCA = { nip: NIP_NABYWCY, name: 'Klient M8b', address: { countryCode: 'PL', addressLine1: 'ul. C 3', addressLine2: '00-003 Warszawa' } };

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

describe.skipIf(!hasDatabase)('M8b: zaliczka, korekta, szkic, powrót do szkicu i GUS z telefonu na bazie', () => {
  let aId = '';
  let bId = '';
  let dbA: SupabaseClient;
  let dbB: SupabaseClient;
  let ctxA: () => Promise<CorrectionIssueContext>;
  let ctxB: () => Promise<CorrectionIssueContext>;
  let advanceDraftId = '';
  const createdUsers: string[] = [];

  beforeAll(async () => {
    vi.stubEnv('KSEF_ENV', 'test');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', environment!.url);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', environment!.serviceRoleKey);
    aId = await createUser(A_EMAIL);
    bId = await createUser(B_EMAIL);
    createdUsers.push(aId, bId);

    const { error: tenantsError } = await admin.from('tenants').upsert([
      { id: ORG_A, nip: NIP_A, name: 'Firma M8b A', address_json: ADRES },
      { id: ORG_B, nip: NIP_A, name: 'Firma M8b B', address_json: { ...ADRES, addressLine1: 'ul. B 2' } },
    ], { onConflict: 'id' });
    if (tenantsError) throw tenantsError;
    await admin.from('users').upsert([{ id: aId, name: 'A' }, { id: bId, name: 'B' }], { onConflict: 'id' });
    const { error: membershipsError } = await admin.from('memberships').insert([
      { organization_id: ORG_A, user_id: aId, role: 'owner', status: 'active', joined_at: '2026-01-02T00:00:00Z' },
      { organization_id: ORG_B, user_id: bId, role: 'owner', status: 'active', joined_at: '2026-01-02T00:00:00Z' },
    ]);
    if (membershipsError) throw membershipsError;

    // Faktura przyjęta w KSeF TEST (do korekty) i faktura z błędem wysyłki (do „Wróć do szkicu”), obie w firmie A.
    const seller = { nip: NIP_A, name: 'Firma M8b A', address: ADRES };
    const { error: invoiceError } = await admin.from('invoices').insert([
      {
        id: PARENT_A, tenant_id: ORG_A, invoice_type: 'VAT', invoice_kind: 'regular', origin: 'app', seller_nip: NIP_A,
        buyer_nip: NIP_NABYWCY, internal_number: `FV/M8B/${RUN}`, payment_due_date: '2026-11-30', currency: 'PLN',
        direction: 'outgoing', issue_date: '2026-11-02', net_total: 1000, vat_total: 230, gross_total: 1230,
        ksef_status: 'accepted', ksef_environment: 'test', ksef_number: `${NIP_A}-20261102-0A1B2C3D4E5F-AB`,
        ksef_accepted_at: '2026-11-02T10:00:00Z', seller_data: seller, buyer_data: NABYWCA, fa3_data: {},
      },
      {
        id: FAILED_A, tenant_id: ORG_A, invoice_type: 'VAT', invoice_kind: 'regular', origin: 'app', seller_nip: NIP_A,
        buyer_nip: NIP_NABYWCY, internal_number: `FV/M8BF/${RUN}`, payment_due_date: '2026-11-30', currency: 'PLN',
        direction: 'outgoing', issue_date: '2026-11-02', net_total: 10, vat_total: 2.3, gross_total: 12.3,
        ksef_status: 'failed', seller_data: seller, buyer_data: NABYWCA, fa3_data: {},
      },
    ]);
    if (invoiceError) throw invoiceError;
    const { error: linesError } = await admin.from('invoice_line_items').insert({
      invoice_id: PARENT_A, ordinal: 1, name: 'Projekt', unit: 'szt', quantity: 2, unit_price_net: 500,
      net_amount: 1000, vat_rate: '23', vat_amount: 230, gross_amount: 1230,
    });
    if (linesError) throw linesError;

    const [tokenA, tokenB] = await Promise.all([tokenOf(A_EMAIL), tokenOf(B_EMAIL)]);
    dbA = createMobileDbClient(tokenA, { activeOrg: ORG_A, target });
    dbB = createMobileDbClient(tokenB, { activeOrg: ORG_B, target });
    const tenantA = await readTenantSnapshot(dbA as never, ORG_A);
    const tenantB = await readTenantSnapshot(dbB as never, ORG_B);
    ctxA = async () => ({ supabase: dbA, userId: aId, tenant: tenantA, tokenSession: { mfa: 'enrollment_required' } });
    ctxB = async () => ({ supabase: dbB, userId: bId, tenant: tenantB, tokenSession: { mfa: 'enrollment_required' } });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await admin.from('invoices').delete().in('tenant_id', [ORG_A, ORG_B]).eq('invoice_kind', 'correction');
    await admin.from('invoices').delete().in('tenant_id', [ORG_A, ORG_B]);
    await admin.from('contractors').delete().in('tenant_id', [ORG_A, ORG_B]);
    await admin.from('memberships').delete().in('organization_id', [ORG_A, ORG_B]);
    for (const id of createdUsers) await admin.auth.admin.deleteUser(id).catch(() => null);
  });

  it('zaliczka klientem z tokenem: wiersz w firmie A, klucz z trasą faktur przechodzi CHECK', async () => {
    const zal: ZaliczkaTelefonu = {
      internalNumber: `FZ/M8B/${RUN}`, issueDate: DZIS, paymentMethod: 'transfer', paymentDueDate: '2026-12-31',
      bankAccount: '61109010140000071219812874', notes: '', numberSeriesId: '', numberPreview: '', splitPayment: false,
      buyer: { nip: NIP_NABYWCY, name: 'Klient M8b', addressLine1: 'ul. C 3', addressLine2: '00-003 Warszawa', email: '' },
      advanceAmount: 1230, totalContractAmount: 2460, expectedDeliveryDate: '', advanceReceivedDate: '', vatRate: '23',
      description: 'Zaliczka na projekt M8b',
    };
    const result = await saveAdvance(ctxA, zaliczkaDoFormularza(zal, { nip: NIP_A, name: 'Firma M8b A', address: ADRES }, KEY_ZAL));
    expect(result).toMatchObject({ success: true });
    if (!result.success) return;
    advanceDraftId = result.invoiceId;

    const { data: row } = await admin.from('invoices').select('tenant_id, invoice_kind, ksef_status, gross_total, number_request_key').eq('id', advanceDraftId).single();
    expect(row).toEqual({ tenant_id: ORG_A, invoice_kind: 'advance', ksef_status: 'draft', gross_total: 1230, number_request_key: KEY_ZAL });

    const { error } = await dbA.from('mobile_idempotency_keys').insert({
      tenant_id: ORG_A, user_id: aId, idempotency_key: KEY_ZAL, request_hash: 'c'.repeat(64), endpoint: ENDPOINT, invoice_id: advanceDraftId,
    });
    expect(error).toBeNull();
  });

  it('korekta: kontekst tylko w firmie tokenu, szkic korekty klientem z tokenem wskazuje fakturę pierwotną', async () => {
    const obca = await getCorrectionParentContext(ctxB, PARENT_A);
    expect(obca.success).toBe(false);

    const ctx = await getCorrectionParentContext(ctxA, PARENT_A);
    expect(ctx).toMatchObject({ success: true, internalNumber: `FV/M8B/${RUN}`, linesBefore: [{ name: 'Projekt', quantity: 2, unitPriceNet: 500, vatRate: '23' }] });
    if (!ctx.success) return;
    const kor: KorektaTelefonu = {
      internalNumber: `KOR/M8B/${RUN}`, issueDate: DZIS, paymentMethod: 'transfer', paymentDueDate: '2026-12-31',
      bankAccount: '', notes: '', numberSeriesId: '', numberPreview: '', parentInvoiceId: PARENT_A,
      correctionType: 'amount_change', correctionReason: 'Rabat za opóźnienie', typKorekty: '2', linesAfter: [],
      amountChange: { netDelta: -100, vatDelta: -23, grossDelta: -123, description: 'Rabat' },
    };
    const saved = await saveCorrectionDraft(ctxA, korektaDoFormularza(kor, ctx, KEY_KOR) as CorrectionInvoiceSchemaIn);
    expect(saved).toMatchObject({ success: true });
    if (!saved.success) return;
    const { data: row } = await admin.from('invoices').select('tenant_id, invoice_kind, parent_invoice_id, gross_total').eq('id', saved.invoiceId).single();
    expect(row).toEqual({ tenant_id: ORG_A, invoice_kind: 'correction', parent_invoice_id: PARENT_A, gross_total: -123 });
  });

  it('usunięcie szkicu: konto firmy B go nie usunie, konto A tak (klucz znika z fakturą)', async () => {
    const obca = await deleteDraftInvoice(async () => ({ supabase: dbB as never, userId: bId, tenantId: ORG_B }), advanceDraftId);
    expect(obca.success).toBe(false);
    const { count: jest } = await admin.from('invoices').select('id', { count: 'exact', head: true }).eq('id', advanceDraftId);
    expect(jest).toBe(1);

    const own = await deleteDraftInvoice(async () => ({ supabase: dbA as never, userId: aId, tenantId: ORG_A }), advanceDraftId);
    expect(own).toEqual({ success: true });
    const { count: klucz } = await admin.from('mobile_idempotency_keys').select('id', { count: 'exact', head: true }).eq('idempotency_key', KEY_ZAL);
    expect(klucz).toBe(0);
  });

  it('„Wróć do szkicu”: RPC z firmą z bramki; firma B nie cofnie faktury A, firma A tak', async () => {
    const obca = await resetInvoiceToDraft(async () => ({ userId: bId, tenantId: ORG_B }), FAILED_A);
    expect(obca.success).toBe(false);
    const { data: przed } = await admin.from('invoices').select('ksef_status').eq('id', FAILED_A).single();
    expect(przed).toEqual({ ksef_status: 'failed' });

    const own = await resetInvoiceToDraft(async () => ({ userId: aId, tenantId: ORG_A }), FAILED_A);
    expect(own).toEqual({ success: true });
    const { data: po } = await admin.from('invoices').select('ksef_status').eq('id', FAILED_A).single();
    expect(po).toEqual({ ksef_status: 'draft' });
  });

  it('GUS: podpowiedź w kontrahentach firmy z tokenu, firma B jej nie widzi', async () => {
    gus.mockResolvedValue({
      kind: 'found',
      data: { nip: NIP_NABYWCY, name: 'Klient z GUS', street: 'ul. Kliencka', buildingNumber: '3', localNumber: '', postalCode: '00-003', city: 'Warszawa' },
    });
    const found = await lookupBuyer(async () => ({ supabase: dbA as never, tenantId: ORG_A }), NIP_NABYWCY);
    expect(found).toMatchObject({ success: true, source: 'gus' });
    const { data: wA } = await dbA.from('contractors').select('name').eq('nip', NIP_NABYWCY);
    expect(wA).toEqual([{ name: 'Klient z GUS' }]);
    const { data: wB } = await dbB.from('contractors').select('name').eq('nip', NIP_NABYWCY);
    expect(wB).toEqual([]);
  });
});
