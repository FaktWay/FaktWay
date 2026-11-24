import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { PgBoss } from 'pg-boss';

import { getRlsTestDatabaseUrl, getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * FZ-024, paczka 3 (abonament FaktWay w Stripe): strażnicy w wyzwalaczach,
 * których żaden test na bazie nie sprawdzał komunikatem (lista
 * `BEZ_KOMUNIKATU` w `tests/filtr/niezmienniki/wyzwalacze.test.ts`, stan
 * `brak`). Każdy przypadek robi zabroniony zapis rolą, która do strażnika
 * dochodzi, i sprawdza jego komunikat.
 *
 * Fakturę abonamentu, subskrypcję, zwrot, sprawę finansową i jej przegląd
 * zapisuje w aplikacji tylko RPC albo właściciel bazy (strażnik tożsamości
 * faktury abonamentu odmawia także serwisowi, a do subskrypcji i zwrotów serwis
 * nie ma zapisu), więc cały plik potrzebuje połączenia z bazą
 * (`RLS_TEST_DATABASE_URL`, w CI jest). Przeglądów spraw finansowych nie usuwa
 * nikt, także właściciel bazy, więc identyfikatory Stripe mają losowy przyrostek
 * z każdego przebiegu; po przebiegu zostają zdarzenie webhooka, sprawa
 * finansowa i jej przegląd (bez płatności, więc niczego nie blokują), a konta
 * właściciela z tego pliku nie da się usunąć (autor przeglądu).
 *
 * Pokrycie liczy się na funkcję, więc część gałęzi zostaje bez testu:
 * UPDATE i DELETE faktury i pozycji abonamentu („Billing VAT document is
 * immutable”), zmiana i ciche zachowanie powiązania płatności z fakturą VAT
 * („Linked Stripe payment evidence is immutable”), Charge oraz „Paid Stripe
 * payment has no full reference” i „Failed Stripe payment reference needs
 * reconciliation”, przepięcie subskrypcji do innej firmy („cannot be rebound”),
 * zmiana firmy subskrypcji i ciche zignorowanie wznowienia anulowanej,
 * ciche odrzucenie starego stanu płatności po zwrocie, przegląd na
 * `stripe_financial_case_reopenings` i INSERT firmy z klientem Stripe przez klienta.
 *
 * Kolejność wyzwalaczy BEFORE (nazwy alfabetycznie): na `stripe_payments`
 * trigger_preserve_stripe_payment_refund_status (UPDATE OF status, tenant_id),
 * trigger_stripe_payment_subscription_tenant, trigger_stripe_payments_updated_at,
 * u_guard_stripe_payment_financial_refs, z_guard_stripe_payment_vat_invoice_link;
 * na `subscriptions` stripe_subscription_checkout_tenant_lock,
 * trigger_preserve_canceled_stripe_subscription, trigger_stripe_subscription_customer_tenant.
 */

const hasDatabase = Boolean(
  process.env.RLS_TEST_SUPABASE_URL?.trim() &&
    process.env.RLS_TEST_SUPABASE_ANON_KEY?.trim() &&
    process.env.RLS_TEST_SUPABASE_SERVICE_ROLE_KEY?.trim(),
);
const hasDirectDb = hasDatabase && Boolean(process.env.RLS_TEST_DATABASE_URL?.trim());
const environment = hasDatabase ? getRlsTestEnvironment() : null;
const admin: SupabaseClient = environment
  ? createClient(environment.url, environment.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : (null as unknown as SupabaseClient);

const ORG = '00024024-0000-4000-8000-000000000003';
/** Druga firma: subskrypcja innej firmy w teście płatności. */
const ORG_B = '00024024-0000-4000-8000-000000000005';
const OWNER_EMAIL = 'rls-fz024-abonament-owner@ksef-saas.test';
const PASS = 'RlsFz024AbonamentPass2026Aa!';
/** Fikcyjny NIP z poprawną sumą kontrolną, tylko w tym pliku. */
const NIP_FIRMY = '0002402429';
/** Przyrostek identyfikatorów Stripe z tego przebiegu (litery i cyfry, jak w Stripe). */
const RUN = randomBytes(6).toString('hex');

interface Db { executeSql(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> }
let boss: PgBoss;
const db = () => boss.getDb() as unknown as Db;

let ownerId = '';
let owner: SupabaseClient;
let counter = 0;

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

async function signedIn(email: string): Promise<SupabaseClient> {
  const c = createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-active-org': ORG } },
  });
  const { error } = await c.auth.signInWithPassword({ email, password: PASS });
  if (error) throw error;
  return c;
}

/** Unikalny identyfikator Stripe z tego przebiegu, np. `pi_fz024ab12…3`. */
const stripeId = (prefix: string) => {
  counter += 1;
  return `${prefix}_fz024${RUN}${counter}`;
};

/** Płatność Stripe firmy ORG zapisana serwisem (jak webhook); zwraca id. */
async function payment(patch: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await admin.from('stripe_payments').insert({
    tenant_id: ORG, amount_cents: 4900, currency: 'pln', status: 'succeeded', stripe_payment_intent_id: stripeId('pi'), ...patch,
  }).select('id').single();
  if (error) throw new Error(`insert stripe_payments: ${error.message}`);
  return data.id as string;
}

/** Wiersz faktury firmy ORG; `patch` nadpisuje pola. */
function invoiceRow(patch: Record<string, unknown> = {}): Record<string, unknown> {
  counter += 1;
  const number = `FZ024A/${RUN}/${counter}`;
  return {
    id: randomUUID(), tenant_id: ORG, direction: 'outgoing', internal_number: number, invoice_type: 'VAT',
    issue_date: '2026-11-01', seller_nip: NIP_FIRMY, buyer_nip: '1234567890', gross_total: 49, net_total: 39.84, vat_total: 9.16,
    ksef_status: 'draft', fa3_data: { internalNumber: number, type: 'VAT' }, seller_data: { nip: NIP_FIRMY }, buyer_data: { nip: '1234567890' },
    ...patch,
  };
}

/** Faktura abonamentu (z `stripe_invoice_id`) zapisana jak RPC, czyli przez właściciela bazy. */
async function billingInvoice(stripeInvoiceId: string): Promise<string> {
  const row = invoiceRow({ stripe_invoice_id: stripeInvoiceId });
  await db().executeSql(
    `INSERT INTO public.invoices (id, tenant_id, direction, internal_number, invoice_type, issue_date, seller_nip, buyer_nip,
       gross_total, net_total, vat_total, ksef_status, fa3_data, seller_data, buyer_data, stripe_invoice_id)
     VALUES ($1, $2, 'outgoing', $3, 'VAT', '2026-11-01', $4, '1234567890', 49, 39.84, 9.16, 'draft', $5::jsonb, $6::jsonb, $7::jsonb, $8)`,
    [row.id, ORG, row.internal_number, NIP_FIRMY, JSON.stringify(row.fa3_data), JSON.stringify(row.seller_data), JSON.stringify(row.buyer_data), stripeInvoiceId],
  );
  return row.id as string;
}

/** Subskrypcję zapisuje w aplikacji tylko RPC (serwis nie ma uprawnień do zapisu), więc tu właściciel bazy. */
const subskrypcja = (tenantId: string, klient: string) =>
  db().executeSql(
    `INSERT INTO public.subscriptions (tenant_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, plan, status)
     VALUES ($1, $2, $3, 'price_fz024', 'monthly', 'active') RETURNING id`,
    [tenantId, klient, stripeId('sub')],
  );

async function cleanup() {
  // Właściciel bazy: strażnicy abonamentu odmawiają usuwania faktur i pozycji abonamentu także serwisowi.
  await db().executeSql('DELETE FROM public.invoice_line_items WHERE invoice_id IN (SELECT id FROM public.invoices WHERE tenant_id = $1)', [ORG]);
  await db().executeSql('UPDATE public.stripe_payments SET vat_invoice_id = NULL WHERE tenant_id = $1 AND vat_invoice_id IS NOT NULL', [ORG]);
  await db().executeSql('DELETE FROM public.invoices WHERE tenant_id = $1', [ORG]);
  await db().executeSql('DELETE FROM public.stripe_refund_operations WHERE tenant_id = $1', [ORG]);
  await db().executeSql('DELETE FROM public.stripe_payments WHERE tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM public.stripe_financial_cases c WHERE c.payment_id = stripe_payments.id)', [ORG]);
  await db().executeSql('DELETE FROM public.subscriptions WHERE tenant_id = ANY($1::uuid[])', [[ORG, ORG_B]]);
  await db().executeSql('UPDATE public.tenants SET stripe_customer_id = NULL WHERE id = ANY($1::uuid[])', [[ORG, ORG_B]]);
}

describe.skipIf(!hasDirectDb)('FZ-024 paczka 3: strażnicy abonamentu (Stripe) mówią swoim komunikatem', () => {
  beforeAll(async () => {
    boss = new PgBoss({ connectionString: getRlsTestDatabaseUrl(), schema: 'pgboss', schedule: false, supervise: false });
    await boss.start();
    ownerId = await userId(OWNER_EMAIL);
    await admin.from('memberships').delete().eq('organization_id', ORG);
    const { error: tErr } = await admin.from('tenants').upsert([
      { id: ORG, nip: NIP_FIRMY, name: 'Firma FZ-024 Abonament' },
      { id: ORG_B, nip: NIP_FIRMY, name: 'Firma FZ-024 Abonament B' },
    ], { onConflict: 'id' });
    if (tErr) throw tErr;
    await cleanup();
    await admin.from('users').upsert([{ id: ownerId, name: 'Owner FZ-024 Abonament' }], { onConflict: 'id' });
    const { error: mErr } = await admin.from('memberships').insert([
      { organization_id: ORG, user_id: ownerId, role: 'owner', status: 'active' },
    ]);
    if (mErr) throw mErr;
    owner = await signedIn(OWNER_EMAIL);
  });

  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    if (!hasDirectDb) return;
    await cleanup();
    await admin.from('memberships').delete().eq('organization_id', ORG);
    await boss?.stop({ graceful: false, close: true });
  });

  describe('firma i subskrypcja', () => {
    it('guard_tenant_stripe_customer_id: właściciel firmy wpisuje klienta Stripe, odmowa', async () => {
      const { error } = await owner.from('tenants').update({ stripe_customer_id: stripeId('cus') }).eq('id', ORG).select('id');
      expect(error?.message).toBe('Stripe customer binding requires service role');
    });

    it('guard_tenant_stripe_customer_id: serwis przepina firmę do innego klienta Stripe, odmowa 23514', async () => {
      const pierwszy = stripeId('cus');
      expect((await admin.from('tenants').update({ stripe_customer_id: pierwszy }).eq('id', ORG)).error).toBeNull();
      const { error } = await admin.from('tenants').update({ stripe_customer_id: stripeId('cus') }).eq('id', ORG);
      expect(error?.code).toBe('23514');
      expect(error?.message).toBe('Stripe customer binding is immutable');
      expect((await admin.from('tenants').select('stripe_customer_id').eq('id', ORG).single()).data?.stripe_customer_id).toBe(pierwszy);
    });

    it('lock_stripe_subscription_tenant_for_checkout: subskrypcja firmy, której nie ma, odmowa 23503', async () => {
      // Ten wyzwalacz jest na subskrypcjach pierwszy, więc odmawia przed sprawdzeniem klienta Stripe.
      await expect(subskrypcja(randomUUID(), stripeId('cus'))).rejects.toMatchObject({ code: '23503', message: 'Stripe subscription tenant not found' });
    });

    it('enforce_stripe_subscription_customer_tenant: subskrypcja z klientem Stripe, który nie należy do firmy, odmowa 23514', async () => {
      await expect(subskrypcja(ORG, stripeId('cus'))).rejects.toMatchObject({ code: '23514', message: 'Stripe subscription customer tenant mismatch' });
    });

    it('preserve_canceled_stripe_subscription: zmiana klienta Stripe subskrypcji, odmowa 23514', async () => {
      // Blokada firmy (pierwszy wyzwalacz) przepuszcza, bo firma się nie zmienia; ten strażnik nie patrzy na rolę.
      const klient = stripeId('cus');
      expect((await admin.from('tenants').update({ stripe_customer_id: klient }).eq('id', ORG)).error).toBeNull();
      const id = (await subskrypcja(ORG, klient)).rows[0]!.id as string;
      await expect(db().executeSql('UPDATE public.subscriptions SET stripe_customer_id = $1 WHERE id = $2', [stripeId('cus'), id]))
        .rejects.toMatchObject({ code: '23514', message: 'Stripe subscription owner is immutable' });
    });
  });

  describe('płatności Stripe', () => {
    it('enforce_stripe_payment_subscription_tenant: płatność z subskrypcją innej firmy, odmowa 23514', async () => {
      // Subskrypcja istnieje (klucz obcy przepuszcza), więc odmawia tylko warunek firmy w strażniku.
      const klientB = stripeId('cus');
      expect((await admin.from('tenants').update({ stripe_customer_id: klientB }).eq('id', ORG_B)).error).toBeNull();
      const subskrypcjaB = (await subskrypcja(ORG_B, klientB)).rows[0]!.id as string;
      const { error } = await admin.from('stripe_payments').insert({
        tenant_id: ORG, amount_cents: 4900, currency: 'pln', status: 'succeeded', subscription_id: subskrypcjaB, stripe_payment_intent_id: stripeId('pi'),
      });
      expect(error?.code).toBe('23514');
      expect(error?.message).toBe('Stripe payment subscription tenant mismatch');
    });

    it('preserve_stripe_payment_refund_status: serwis przepisuje płatność na inną firmę, odmowa 23514', async () => {
      // Ten wyzwalacz jest na płatnościach pierwszy.
      const id = await payment();
      const { error } = await admin.from('stripe_payments').update({ tenant_id: ORG_B }).eq('id', id);
      expect(error?.code).toBe('23514');
      expect(error?.message).toBe('Stripe payment tenant is immutable');
    });

    it('guard_stripe_payment_financial_refs: serwis podmienia identyfikator płatności Stripe opłaconej płatności, odmowa 23514', async () => {
      const pierwszy = stripeId('pi');
      const id = await payment({ stripe_payment_intent_id: pierwszy });
      const { error } = await admin.from('stripe_payments').update({ stripe_payment_intent_id: stripeId('pi') }).eq('id', id);
      expect(error?.code).toBe('23514');
      expect(error?.message).toBe('Stripe payment intent identity is immutable');
      expect((await admin.from('stripe_payments').select('stripe_payment_intent_id').eq('id', id).single()).data?.stripe_payment_intent_id).toBe(pierwszy);
    });

    it('guard_stripe_payment_vat_invoice_link: serwis zapisuje płatność od razu z fakturą VAT, odmowa', async () => {
      // Powiązanie z fakturą VAT robi tylko RPC; wcześniejsze wyzwalacze przy INSERT przepuszczają (bez subskrypcji, wolne identyfikatory).
      const invoice = invoiceRow();
      expect((await admin.from('invoices').insert(invoice)).error).toBeNull();
      const { error } = await admin.from('stripe_payments').insert({
        tenant_id: ORG, amount_cents: 4900, currency: 'pln', status: 'succeeded', stripe_payment_intent_id: stripeId('pi'), vat_invoice_id: invoice.id,
      });
      expect(error?.message).toBe('VAT invoice link is server-managed');
    });
  });

  describe('faktura abonamentu', () => {
    it('guard_billing_invoice_identity: klient wstawia fakturę z identyfikatorem faktury Stripe, odmowa', async () => {
      // Ten wyzwalacz jest na fakturach pierwszy (a_guard_billing…), więc odmawia przed resztą strażników faktur.
      const row = invoiceRow({ stripe_invoice_id: stripeId('in') });
      const { error } = await owner.from('invoices').insert(row);
      expect(error?.message).toBe('Billing invoice identity is server-managed');
      // Także serwis: fakturę abonamentu zapisuje tylko RPC.
      const serwis = await admin.from('invoices').insert(invoiceRow({ stripe_invoice_id: stripeId('in') }));
      expect(serwis.error?.message).toBe('Billing invoice identity is server-managed');
    });

    it('guard_billing_invoice_financial_case: faktura abonamentu bez płatności Stripe, odmowa 23514 nawet dla właściciela bazy', async () => {
      await expect(billingInvoice(stripeId('in'))).rejects.toMatchObject({ code: '23514', message: 'Billing payment reference requires reconciliation' });
    });

    it('guard_billing_invoice_financial_case: płatność z blokadą finansową (niezweryfikowana), odmowa 23514', async () => {
      // stripe_payment_has_financial_hold: płatność bez potwierdzonych identyfikatorów Stripe ma blokadę.
      const stripeInvoiceId = stripeId('in');
      await payment({ stripe_invoice_id: stripeInvoiceId });
      await expect(billingInvoice(stripeInvoiceId)).rejects.toMatchObject({ code: '23514', message: 'Stripe financial case requires VAT reconciliation' });
    });

    it('guard_billing_invoice_line: pozycji faktury abonamentu nie dopisze serwis', async () => {
      const stripeInvoiceId = stripeId('in');
      // Płatność opłacona i zweryfikowana, inaczej strażnik spraw finansowych widzi blokadę i odmawia wcześniej.
      await payment({ stripe_invoice_id: stripeInvoiceId, stripe_charge_id: stripeId('ch'), stripe_payment_refs_verified: true });
      const id = await billingInvoice(stripeInvoiceId);
      const { error } = await admin.from('invoice_line_items').insert({
        invoice_id: id, ordinal: 1, name: 'Abonament FaktWay', quantity: 1, unit: 'szt', unit_price_net: 39.84, vat_rate: '23',
        net_amount: 39.84, vat_amount: 9.16, gross_amount: 49,
      });
      expect(error?.message).toBe('Billing VAT line is immutable');
    });
  });

  describe('sprawy finansowe', () => {
    const zwrot = (paymentId: string, reference: string | null) =>
      db().executeSql(
        `INSERT INTO public.stripe_refund_operations (tenant_id, payment_id, amount_cents, currency, idempotency_key, stripe_payment_reference)
         VALUES ($1, $2, 100, 'pln', $3, $4)`,
        [ORG, paymentId, `fz024-${RUN}-${randomUUID()}`, reference],
      );

    it('guard_admin_refund_financial_case: zwrot do płatności, której nie ma w firmie, odmowa 23514', async () => {
      await expect(zwrot(randomUUID(), null)).rejects.toMatchObject({ code: '23514', message: 'Refund payment identity requires reconciliation' });
    });

    it('guard_admin_refund_financial_case: zwrot płatności z blokadą finansową (niezweryfikowanej), odmowa 23514', async () => {
      // Odnośnik do płatności jest, więc CHECK zwrotu przepuszcza; odmawia blokada w strażniku.
      const intent = stripeId('pi');
      const id = await payment({ stripe_payment_intent_id: intent });
      await expect(zwrot(id, intent)).rejects.toMatchObject({ code: '23514', message: 'Stripe financial case requires refund reconciliation' });
    });

    it('prevent_financial_case_review_mutation: przeglądu sprawy finansowej nie zmieni ani nie usunie nawet właściciel bazy', async () => {
      const zdarzenie = stripeId('evt');
      const sprawa = stripeId('re');
      await db().executeSql("INSERT INTO public.stripe_webhook_events (id, type, payload) VALUES ($1, 'charge.refunded', '{}'::jsonb)", [zdarzenie]);
      await db().executeSql(
        `INSERT INTO public.stripe_financial_cases (stripe_object_id, kind, amount_cents, currency, stripe_status, last_observed_status, case_state, first_event_id, last_event_id)
         VALUES ($1, 'refund', 100, 'pln', 'succeeded', 'succeeded', 'open', $2, $2)`,
        [sprawa, zdarzenie],
      );
      await db().executeSql(
        `INSERT INTO public.stripe_financial_case_reviews (stripe_object_id, reviewer_user_id, previous_state, observed_stripe_status, last_event_id, candidate_count, evidence_reference, reason)
         VALUES ($1, $2, 'open', 'succeeded', $3, 0, 'dowod-fz024', 'Przegląd testowy FZ-024 bez kandydata')`,
        [sprawa, ownerId, zdarzenie],
      );
      await expect(db().executeSql("UPDATE public.stripe_financial_case_reviews SET reason = 'Zmieniony przegląd testowy FZ-024' WHERE stripe_object_id = $1", [sprawa]))
        .rejects.toMatchObject({ code: '42501', message: 'Financial case review history is append-only' });
      await expect(db().executeSql('DELETE FROM public.stripe_financial_case_reviews WHERE stripe_object_id = $1', [sprawa]))
        .rejects.toMatchObject({ code: '42501', message: 'Financial case review history is append-only' });
    });
  });
});
