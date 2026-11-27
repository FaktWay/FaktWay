import { randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * Plan kompletnej aplikacji, krok 1.6 część 2b, PR A (00221, D21 i D22):
 * faktura wystawiona w 2026 r. poza KSeF (`origin = 'outside_ksef'`) ma w bazie
 * jeden dozwolony kształt (sprzedaż, zwykła, przyjęta, bez numeru KSeF i XML,
 * PLN, ze środowiskiem), datę wystawienia z 2026 r., środowisko równe
 * środowisku firmy, a pochodzenia nie da się zmienić po zapisie. Strażnik cyklu
 * życia faktury (I3) takiej faktury nie zgłasza, a zwykła przyjęta faktura bez
 * numeru KSeF dalej tak (kontrola, że test nie przechodzi „z pustego”).
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

const ORG = '00221221-0000-4000-8000-00000000000a';
const ORG_B = '00221221-0000-4000-8000-00000000000b';

type Pola = Record<string, unknown>;

/** Poprawny wpis spoza KSeF; `pola` nadpisują pojedyncze kolumny. */
function wpis(org: string, pola: Pola = {}): Pola {
  return {
    id: randomUUID(), tenant_id: org, direction: 'outgoing', origin: 'outside_ksef', internal_number: `FV/${randomUUID().slice(0, 8)}/2026`,
    invoice_type: 'VAT', invoice_kind: 'regular', issue_date: '2026-03-10', seller_nip: '5260221001', buyer_nip: '1234567890',
    currency: 'PLN', net_total: 100, vat_total: 23, gross_total: 123, ksef_status: 'accepted', ksef_environment: 'test',
    ksef_number: null, xml_storage_path: null, fa3_data: { _source: 'outside-ksef' }, ...pola,
  };
}

async function wstaw(org: string, pola: Pola = {}) {
  return admin.from('invoices').insert(wpis(org, pola));
}

async function cleanup() {
  for (const org of [ORG, ORG_B]) {
    const { error } = await admin.from('invoices').delete().eq('tenant_id', org);
    if (error) throw new Error(`sprzątanie invoices: ${error.message}`);
  }
}

async function naruszenia(org: string): Promise<Array<{ invariant: string; invoice_id: string }>> {
  const { data, error } = await admin.rpc('ksef_lifecycle_violations');
  if (error) throw new Error(`ksef_lifecycle_violations: ${error.message}`);
  return (data as Array<{ invariant: string; invoice_id: string; tenant_id: string }>).filter((r) => r.tenant_id === org);
}

describe.skipIf(!hasDatabase)('00221: faktury spoza KSeF w bazie (D21, D22)', () => {
  beforeAll(async () => {
    const { error } = await admin.from('tenants').upsert(
      [
        { id: ORG, nip: '5260221001', name: 'Firma 00221 A', ksef_verified_environment: 'test' },
        { id: ORG_B, nip: '5260221002', name: 'Firma 00221 B' },
      ],
      { onConflict: 'id' },
    );
    if (error) throw error;
    await admin.from('tenants').update({ ksef_verified_environment: 'test' }).eq('id', ORG);
    await admin.from('tenants').update({ ksef_verified_environment: null }).eq('id', ORG_B);
  }, 60_000);

  beforeEach(cleanup);
  afterAll(async () => {
    if (hasDatabase) await cleanup();
  });

  it('poprawny wpis z 2026 r. zapisuje się, także na granicach zakresu dat', async () => {
    for (const data of ['2026-01-01', '2026-12-31']) {
      const { error } = await wstaw(ORG, { issue_date: data });
      expect(error, data).toBeNull();
    }
  });

  it('data wystawienia poza 2026 r. jest odrzucona (D21)', async () => {
    for (const data of ['2025-12-31', '2027-01-01']) {
      const { error } = await wstaw(ORG, { issue_date: data });
      expect(error?.message, data).toContain('invoices_outside_ksef_issue_date_2026');
    }
    // Inne pochodzenie nie ma tego ograniczenia.
    const { error } = await wstaw(ORG, { origin: 'app', ksef_status: 'draft', ksef_environment: null, issue_date: '2027-02-01' });
    expect(error).toBeNull();
  });

  it.each([
    ['numer KSeF', { ksef_number: '1234567890-20260310-ABCDEF-01' }],
    ['plik XML', { xml_storage_path: 'x.xml' }],
    ['status szkic', { ksef_status: 'draft' }],
    ['status w kolejce', { ksef_status: 'queued' }],
    ['faktura zakupu', { direction: 'incoming' }],
    ['korekta', { invoice_kind: 'correction' }],
    ['waluta EUR', { currency: 'EUR' }],
    ['brak środowiska', { ksef_environment: null }],
    ['ślad wysyłki', { submitted_to_ksef_at: '2026-03-10T10:00:00Z' }],
    ['brak numeru dokumentu', { internal_number: null }],
  ])('kształt: %s jest odrzucone', async (_nazwa, pola) => {
    const { error } = await wstaw(ORG, pola as Pola);
    expect(error?.message).toContain('invoices_outside_ksef_shape');
  });

  it('środowisko wpisu różne od środowiska firmy jest odrzucone; firma bez środowiska przyjmuje wpis', async () => {
    const zle = await wstaw(ORG, { ksef_environment: 'production' });
    expect(zle.error?.message).toContain('OUTSIDE_KSEF_ENVIRONMENT');
    expect(zle.error?.message).toContain('różni się od środowiska KSeF firmy');
    const dobre = await wstaw(ORG, { ksef_environment: 'test' });
    expect(dobre.error).toBeNull();
    const bezSrodowiska = await wstaw(ORG_B, { ksef_environment: 'production' });
    expect(bezSrodowiska.error).toBeNull();
  });

  it('pochodzenia nie da się nadać ani zdjąć po zapisie', async () => {
    const zwykla = wpis(ORG, { origin: 'app', ksef_status: 'draft', ksef_environment: null });
    expect((await admin.from('invoices').insert(zwykla)).error).toBeNull();
    const nadanie = await admin.from('invoices').update({ origin: 'outside_ksef' }).eq('id', zwykla.id as string);
    expect(nadanie.error?.message).toContain('OUTSIDE_KSEF_ORIGIN_IMMUTABLE');
    expect(nadanie.error?.message).toContain('pochodzenia faktury spoza KSeF nie da się nadać ani zdjąć po zapisie');

    const spoza = wpis(ORG);
    expect((await admin.from('invoices').insert(spoza)).error).toBeNull();
    const zdjecie = await admin.from('invoices').update({ origin: 'app' }).eq('id', spoza.id as string);
    expect(zdjecie.error?.message).toContain('OUTSIDE_KSEF_ORIGIN_IMMUTABLE');
    const { data } = await admin.from('invoices').select('origin').eq('id', spoza.id as string).single();
    expect(data?.origin).toBe('outside_ksef');
  });

  it('strażnik cyklu życia nie zgłasza I3 dla faktury spoza KSeF, a dla zwykłej przyjętej bez numeru zgłasza', async () => {
    const spoza = wpis(ORG);
    expect((await admin.from('invoices').insert(spoza)).error).toBeNull();
    const zwykla = wpis(ORG, { origin: 'app', ksef_environment: 'test', internal_number: `FV/zw/${randomUUID().slice(0, 6)}` });
    expect((await admin.from('invoices').insert(zwykla)).error).toBeNull();

    const wynik = await naruszenia(ORG);
    expect(wynik.filter((r) => r.invariant === 'I3' && r.invoice_id === spoza.id)).toEqual([]);
    expect(wynik.filter((r) => r.invariant === 'I3' && r.invoice_id === zwykla.id)).toHaveLength(1);
  });
});
