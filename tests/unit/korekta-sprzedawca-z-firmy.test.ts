import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoryTables } from './helpers/baza-w-pamieci';

const db = vi.hoisted(() => ({ tables: {} as MemoryTables }));
const TENANT = '11111111-1111-4111-8111-111111111111';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: vi.fn(async () => ({ ok: true })) }));
// Fikcyjny NIP 1234567890 (AGENTS.md) nie ma sumy kontrolnej; reszta kalkulatora prawdziwa.
vi.mock('@/lib/xml/invoice-calculator', async (orig) => ({
  ...(await orig<typeof import('@/lib/xml/invoice-calculator')>()),
  validateNipChecksum: () => true,
}));
vi.mock('@/lib/supabase/admin', async () => {
  const { memoryClient } = await import('./helpers/baza-w-pamieci');
  return { createAdminClient: () => memoryClient(db.tables) };
});
vi.mock('@/lib/supabase/auth-context', async () => {
  const { memoryClient } = await import('./helpers/baza-w-pamieci');
  return {
    requireUserAndActiveOrg: async () => ({ supabase: memoryClient(db.tables), user: { id: 'uzytkownik' }, tenantId: TENANT, role: 'owner' }),
    ActionAuthError: class ActionAuthError extends Error {},
  };
});

import { getCorrectionParentContextAction, saveCorrectionDraftAction } from '@/components/invoices/correction-actions';

/**
 * Plan „zero zgubionych faktur”, karta C2, punkt S6: sprzedawca korekty
 * z danych firmy (`sellerFromTenantProfile`), jak w zaliczce i fakturze
 * rozliczającej, a nie z przeglądarki. Dotąd zapis korekty sprawdzał tylko NIP
 * sprzedawcy, a nazwę i adres do pliku FA(3) (`Podmiot1`) brał z żądania, więc
 * żądanie spoza formularza mogło wpisać do korekty dowolną nazwę i adres z tym
 * samym NIP. Formularz dostawał też dane sprzedawcy z faktury pierwotnej, czyli
 * stary adres po przeprowadzce firmy.
 *
 * Prawdziwa ścieżka: akcje strony korekty na bazie w pamięci. Atrapy: sesja,
 * kolejka KSeF, dziennik.
 */

const PARENT = '00000000-0000-4000-8000-000000000001';
const KSEF_RODZICA = '1234567890-20261102-0100001AF601-B1';
/** Dane firmy dziś (po przeprowadzce). */
const ADRES_FIRMY = { countryCode: 'PL', addressLine1: 'ul. Nowa 5', addressLine2: '00-950 Warszawa' };
const SPRZEDAWCA_FIRMY = { nip: '1234567890', name: 'Firma testowa', address: ADRES_FIRMY };
/** Dane sprzedawcy zapisane na fakturze pierwotnej (stary adres). */
const SPRZEDAWCA_RODZICA = { nip: '1234567890', name: 'Firma testowa', address: { countryCode: 'PL', addressLine1: 'ul. Stara 1', addressLine2: '00-001 Warszawa' } };
const NABYWCA = { nip: '1234567890', name: 'Klient testowy', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' } };

function fakturaPierwotna() {
  db.tables.invoices!.push({
    id: PARENT, tenant_id: TENANT, direction: 'outgoing', invoice_kind: 'regular', invoice_type: 'VAT', origin: 'app',
    ksef_status: 'accepted', ksef_environment: 'test', ksef_number: KSEF_RODZICA, currency: 'PLN',
    internal_number: 'FV 7/11/2026', issue_date: '2026-11-02',
    net_total: 100, vat_total: 23, gross_total: 123,
    seller_nip: '1234567890', seller_data: SPRZEDAWCA_RODZICA, buyer_data: NABYWCA,
    fa3_data: { internalNumber: 'FV 7/11/2026' },
  });
  db.tables.invoice_line_items!.push({
    id: `${PARENT}-1`, invoice_id: PARENT, ordinal: 1, name: 'Usługa', unit: 'szt.', quantity: 1,
    unit_price_net: 100, net_amount: 100, vat_rate: '23', vat_amount: 23, gross_amount: 123,
  });
}

const PRZED = [{ name: 'Usługa', unit: 'szt.', quantity: 1, unitPriceNet: 100, vatRate: '23' }];

function anulowanie(seller: unknown) {
  return {
    invoiceType: 'correction', internalNumber: 'FK/1/11/2026', issueDate: '2026-11-16', paymentMethod: 'transfer', paymentDueDate: '2026-11-30',
    parentInvoiceId: PARENT, parentInvoiceNumber: 'FV 7/11/2026', parentInvoiceIssueDate: '2026-11-02', parentKsefNumber: KSEF_RODZICA,
    correctionReason: 'Zwrot', typKorekty: '2', correctionType: 'cancellation',
    seller, buyer: { type: 'b2b', idType: 'nip', ...NABYWCA },
    linesBefore: PRZED, linesAfter: PRZED,
  } as never;
}

const korekty = () => db.tables.invoices!.filter((row) => row.invoice_kind === 'correction');

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
  db.tables = {
    tenants: [{ id: TENANT, nip: '1234567890', name: 'Firma testowa', address_json: ADRES_FIRMY }],
    invoices: [],
    invoice_line_items: [],
  };
});

describe('sprzedawca korekty z danych firmy, nie z przeglądarki (C2, S6)', () => {
  it('formularz dostaje dzisiejsze dane firmy, nie adres z faktury pierwotnej', async () => {
    fakturaPierwotna();
    const ctx = await getCorrectionParentContextAction(PARENT);
    expect(ctx.success).toBe(true);
    if (ctx.success) expect(ctx.seller).toEqual(SPRZEDAWCA_FIRMY);
  });

  it('zapis korekty z danymi firmy: w korekcie sprzedawca z danych firmy', async () => {
    fakturaPierwotna();
    const r = await saveCorrectionDraftAction(anulowanie(SPRZEDAWCA_FIRMY), TENANT);
    expect(r).toMatchObject({ success: true });
    expect(korekty()).toHaveLength(1);
    expect(korekty()[0]!.seller_data).toMatchObject(SPRZEDAWCA_FIRMY);
  });

  it('żądanie z inną nazwą albo adresem sprzedawcy przy tym samym NIP: odmowa z wyjściem, nic nie zapisane', async () => {
    fakturaPierwotna();
    for (const seller of [
      { ...SPRZEDAWCA_FIRMY, name: 'Ktoś inny sp. z o.o.' },
      SPRZEDAWCA_RODZICA,
    ]) {
      const r = await saveCorrectionDraftAction(anulowanie(seller), TENANT);
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error).toBe('Dane sprzedawcy zmieniły się lub nie należą do tej firmy. Odśwież formularz.');
    }
    expect(korekty()).toHaveLength(0);
  });

  it('firma bez pełnych danych (adres): korekty nie przygotujemy, komunikat wskazuje ustawienia firmy', async () => {
    db.tables.tenants![0]!.address_json = null;
    fakturaPierwotna();
    const ctx = await getCorrectionParentContextAction(PARENT);
    expect(ctx.success).toBe(false);
    if (!ctx.success) expect(ctx.error).toBe('Uzupełnij poprawne dane sprzedawcy w ustawieniach firmy przed wystawieniem korekty.');
    const r = await saveCorrectionDraftAction(anulowanie(SPRZEDAWCA_RODZICA), TENANT);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toBe('Uzupełnij poprawne dane sprzedawcy w ustawieniach firmy przed wystawieniem korekty.');
    expect(korekty()).toHaveLength(0);
  });
});
