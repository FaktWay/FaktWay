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
 * Krok 1.6, część 2b, PR B (D22, D48): do faktury dopisanej spoza KSeF FaktWay
 * nie przygotowuje korekty. Wpis nie ma numeru KSeF, więc dotąd klient dostawał
 * ogólne „Faktura pierwotna nie ma potwierdzonego numeru KSeF” bez wyjścia. Teraz
 * odmowa nazywa fakturę i mówi, co zrobić (Aplikacja Podatnika KSeF albo
 * usunięcie wpisu i dodanie od nowa). Prawdziwa ścieżka: akcje strony korekty na
 * bazie w pamięci; atrapy: sesja, kolejka KSeF, dziennik.
 */

const PARENT = '00000000-0000-4000-8000-000000000001';
const SPRZEDAWCA = { nip: '1234567890', name: 'Firma testowa', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } };
const NABYWCA = { nip: '1234567890', name: 'Klient testowy', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' } };

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
  db.tables = { tenants: [{ id: TENANT, nip: '1234567890', name: 'Firma testowa', address_json: SPRZEDAWCA.address }], invoices: [], invoice_line_items: [] };
  db.tables.invoices!.push({
    id: PARENT, tenant_id: TENANT, direction: 'outgoing', invoice_kind: 'regular', invoice_type: 'VAT', origin: 'outside_ksef',
    ksef_status: 'accepted', ksef_environment: 'test', ksef_number: null, currency: 'PLN',
    internal_number: 'FV/12/2026', issue_date: '2026-03-10', net_total: 100, vat_total: 23, gross_total: 123,
    seller_data: SPRZEDAWCA, buyer_data: NABYWCA, fa3_data: { _source: 'outside-ksef' },
  });
});

describe('korekta do faktury spoza KSeF', () => {
  it('formularz korekty: odmowa z numerem faktury i wyjściem, nie ogólny komunikat o numerze KSeF', async () => {
    const ctx = await getCorrectionParentContextAction(PARENT);
    expect(ctx.success).toBe(false);
    if (!ctx.success) {
      expect(ctx.error).toContain('FV/12/2026');
      expect(ctx.error).toContain('wystawiona poza KSeF');
      expect(ctx.error).toContain('Aplikacji Podatnika KSeF');
      expect(ctx.error).not.toContain('nie ma potwierdzonego numeru KSeF');
    }
  });

  it('zapis szkicu korekty: ta sama odmowa, nic się nie zapisuje', async () => {
    const w = await saveCorrectionDraftAction({
      invoiceType: 'correction', internalNumber: 'FK/1/2026', issueDate: '2026-11-16', paymentMethod: 'transfer', paymentDueDate: '2026-11-30',
      parentInvoiceId: PARENT, parentInvoiceNumber: 'FV/12/2026', parentInvoiceIssueDate: '2026-03-10', parentKsefNumber: '1234567890-20260310-0100001AF601-B1',
      correctionReason: 'Zwrot', correctionType: 'cancellation', seller: SPRZEDAWCA, buyer: { type: 'b2b', idType: 'nip', ...NABYWCA },
    } as never, TENANT);
    expect(w.success).toBe(false);
    expect(JSON.stringify(w)).toContain('Aplikacji Podatnika KSeF');
    expect(db.tables.invoices).toHaveLength(1);
  });
});
