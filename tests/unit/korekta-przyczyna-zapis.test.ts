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

import { saveCorrectionDraftAction } from '@/components/invoices/correction-actions';

/**
 * D35 (00222): przyczyna korekty zapisuje się w `invoices.correction_cause`;
 * brak wyboru (stara aplikacja, mobilna) zapisuje null. Prawdziwa akcja strony
 * na bazie w pamięci.
 */

const PARENT = '00000000-0000-4000-8000-000000000001';
const KSEF_RODZICA = '1234567890-20261102-0100001AF601-B1';
const SPRZEDAWCA = { nip: '1234567890', name: 'Firma testowa', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } };
const NABYWCA = { nip: '1234567890', name: 'Klient testowy', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' } };


function faktura() {
  const lines = [{ ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 100, vatRate: '23', netAmount: 100, vatAmount: 23, grossAmount: 123 }];
  db.tables.invoices!.push({
    id: PARENT, tenant_id: TENANT, direction: 'outgoing', invoice_kind: 'regular', invoice_type: 'VAT', origin: 'app',
    ksef_status: 'accepted', ksef_environment: 'test', ksef_number: KSEF_RODZICA, currency: 'PLN',
    internal_number: 'FV 1/11/2026', issue_date: '2026-11-02', net_total: 100, vat_total: 23, gross_total: 123,
    seller_data: SPRZEDAWCA, buyer_data: NABYWCA, fa3_data: { internalNumber: 'FV 1/11/2026', lines },
  });
  db.tables.invoice_line_items!.push({
    id: `${PARENT}-1`, invoice_id: PARENT, ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1,
    unit_price_net: 100, net_amount: 100, vat_rate: '23', vat_amount: 23, gross_amount: 123,
  });
}

function payload(o: Record<string, unknown>) {
  return {
    invoiceType: 'correction', internalNumber: 'FK/1/11/2026', issueDate: '2026-11-16', paymentMethod: 'transfer', paymentDueDate: '2026-11-30',
    parentInvoiceId: PARENT, parentInvoiceNumber: 'FV 1/11/2026', parentInvoiceIssueDate: '2026-11-02', parentKsefNumber: KSEF_RODZICA,
    correctionReason: 'Zmiana ilości', typKorekty: '2',
    seller: SPRZEDAWCA, buyer: { type: 'b2b', idType: 'nip', ...NABYWCA },
    ...o,
  } as never;
}

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
  db.tables = { tenants: [{ id: TENANT, nip: '1234567890', name: 'Firma testowa', address_json: SPRZEDAWCA.address }], invoices: [], invoice_line_items: [] };
});

const zapisana = () => db.tables.invoices!.find((r) => r.invoice_kind === 'correction')!;

describe('przyczyna korekty zapisana w kolumnie', () => {
  it.each(['blad_rachunkowy', 'blad_w_dniu_sprzedazy', 'nowa_okolicznosc'])('zapisuje %s', async (przyczyna) => {
    faktura();
    const r = await saveCorrectionDraftAction(payload({ correctionType: 'cancellation', correctionCause: przyczyna }), TENANT);
    if (!r.success) throw new Error(r.error);
    expect(zapisana().correction_cause).toBe(przyczyna);
  });

  it('brak wyboru zapisuje null, a nieznana wartość jest odrzucona', async () => {
    faktura();
    const zle = await saveCorrectionDraftAction(payload({ correctionType: 'cancellation', correctionCause: 'cokolwiek' }), TENANT);
    expect(zle.success).toBe(false);
    const r = await saveCorrectionDraftAction(payload({ correctionType: 'cancellation' }), TENANT);
    if (!r.success) throw new Error(r.error);
    expect(zapisana().correction_cause).toBeNull();
  });
});
