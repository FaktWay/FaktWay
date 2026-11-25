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
 * Plan cen brutto, PR (e), część 1: korekta faktury w cenach brutto. Taka
 * faktura ma w bazie pustą cenę netto pozycji (`invoice_line_items.unit_price_net`
 * NULL), a cenę brutto w dokumencie: faktura FaktWay (`fa3_data.pricesGross`,
 * `fa3_data.lines[].unitPriceGross`) albo plik importu (`fa3_data.ksefLineFields[].P_9B`).
 * Kształtu pliku korekty z `P_9B` nie rozstrzygnął jeszcze rejestr
 * (RP-FA-BRUTTO-01, pytanie do księgowej), więc aplikacja takiej korekty nie
 * przygotowuje. Odmowa ma mówić, że chodzi o fakturę w cenach brutto, i dawać
 * wyjście (pomoc FaktWay), a nie „pozycję bez pełnej ilości lub ceny”, bo
 * klient widzi na fakturze pełne ceny. Pozycja bez ceny netto i bez ceny
 * brutto w dokumencie zostaje przy dotychczasowym komunikacie.
 *
 * Prawdziwa ścieżka: akcje strony korekty na bazie w pamięci. Atrapy: sesja,
 * kolejka KSeF, dziennik.
 */

const PARENT = '00000000-0000-4000-8000-000000000001';
const KSEF_RODZICA = '1234567890-20261102-0100001AF601-B1';
const SPRZEDAWCA = { nip: '1234567890', name: 'Firma testowa', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } };
const NABYWCA = { nip: '1234567890', name: 'Klient testowy', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' } };

/** 3 × 1,00 zł brutto przy 23 %: VAT stawki 0,56 od 3,00, netto pozycji 0,81 / 0,81 / 0,82 (#835). */
const POZYCJE = [
  { net: 0.81, vat: 0.19, gross: 1 },
  { net: 0.81, vat: 0.19, gross: 1 },
  { net: 0.82, vat: 0.18, gross: 1 },
];

function fakturaWCenachBrutto(fa3: Record<string, unknown>, cenaNetto: number | null = null) {
  db.tables.invoices!.push({
    id: PARENT, tenant_id: TENANT, direction: 'outgoing', invoice_kind: 'regular', invoice_type: 'VAT', origin: 'app',
    ksef_status: 'accepted', ksef_environment: 'test', ksef_number: KSEF_RODZICA, currency: 'PLN',
    internal_number: 'FV 7/11/2026', issue_date: '2026-11-02',
    net_total: 2.44, vat_total: 0.56, gross_total: 3,
    seller_data: SPRZEDAWCA, buyer_data: NABYWCA,
    fa3_data: { internalNumber: 'FV 7/11/2026', ...fa3 },
  });
  db.tables.invoice_line_items!.push(...POZYCJE.map((p, i) => ({
    id: `${PARENT}-${i + 1}`, invoice_id: PARENT, ordinal: i + 1, name: `Kawa ${i + 1}`, unit: 'szt.', quantity: 1,
    unit_price_net: cenaNetto, net_amount: p.net, vat_rate: '23', vat_amount: p.vat, gross_amount: p.gross,
  })));
}

const LINIE_FAKTURY = POZYCJE.map((p, i) => ({
  ordinal: i + 1, name: `Kawa ${i + 1}`, unit: 'szt.', quantity: 1, unitPriceGross: 1, vatRate: '23',
  netAmount: p.net, vatAmount: p.vat, grossAmount: p.gross,
}));

function payload(o: Record<string, unknown>) {
  return {
    invoiceType: 'correction', internalNumber: 'FK/1/11/2026', issueDate: '2026-11-16', paymentMethod: 'transfer', paymentDueDate: '2026-11-30',
    parentInvoiceId: PARENT, parentInvoiceNumber: 'FV 7/11/2026', parentInvoiceIssueDate: '2026-11-02', parentKsefNumber: KSEF_RODZICA,
    correctionReason: 'Zwrot', typKorekty: '2',
    seller: SPRZEDAWCA, buyer: { type: 'b2b', idType: 'nip', ...NABYWCA },
    ...o,
  } as never;
}

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
  db.tables = { tenants: [{ id: TENANT, nip: '1234567890', name: 'Firma testowa', address_json: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } }], invoices: [], invoice_line_items: [] };
});

describe('korekta faktury w cenach brutto: odmowa z nazwą przyczyny i wyjściem', () => {
  it('faktura FaktWay w cenach brutto: formularz korekty dostaje odmowę „w cenach brutto” z pomocą FaktWay, nie „bez pełnej ilości lub ceny”', async () => {
    fakturaWCenachBrutto({ pricesGross: true, lines: LINIE_FAKTURY });
    const ctx = await getCorrectionParentContextAction(PARENT);
    expect(ctx.success).toBe(false);
    if (!ctx.success) {
      expect(ctx.error).toContain('FV 7/11/2026');
      expect(ctx.error).toMatch(/w cenach brutto/);
      expect(ctx.error).toMatch(/Napisz do nas/);
      expect(ctx.error).not.toMatch(/bez pełnej ilości lub ceny/);
    }
  });

  it('plik importu w cenach brutto (P_9B, cena netto pusta): ta sama odmowa', async () => {
    fakturaWCenachBrutto({ ksefLineFields: POZYCJE.map((_, i) => ({ ordinal: i + 1, P_9B: 1 })) });
    const ctx = await getCorrectionParentContextAction(PARENT);
    expect(ctx.success).toBe(false);
    if (!ctx.success) {
      expect(ctx.error).toMatch(/w cenach brutto/);
      expect(ctx.error).not.toMatch(/bez pełnej ilości lub ceny/);
    }
  });

  it('zapis korekty (anulowanie) faktury w cenach brutto: ta sama odmowa, nic nie zapisane', async () => {
    fakturaWCenachBrutto({ pricesGross: true, lines: LINIE_FAKTURY });
    const przed = POZYCJE.map((poz, i) => ({ name: `Kawa ${i + 1}`, unit: 'szt.', quantity: 1, unitPriceNet: poz.net, vatRate: '23' }));
    const r = await saveCorrectionDraftAction(payload({ correctionType: 'cancellation', linesBefore: przed, linesAfter: przed }), TENANT);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/w cenach brutto/);
    expect(db.tables.invoices!.filter((row) => row.invoice_kind === 'correction')).toHaveLength(0);
  });

  it('pozycja bez ceny netto i bez ceny brutto w dokumencie: dotychczasowy komunikat (bez zmian)', async () => {
    fakturaWCenachBrutto({ lines: LINIE_FAKTURY.map(({ unitPriceGross: _cena, ...l }) => l) });
    const ctx = await getCorrectionParentContextAction(PARENT);
    expect(ctx.success).toBe(false);
    if (!ctx.success) {
      expect(ctx.error).toMatch(/bez pełnej ilości lub ceny/);
      expect(ctx.error).not.toMatch(/w cenach brutto/);
    }
  });

  it('faktura w cenach netto z ceną netto w pozycjach: kontekst korekty bez odmowy (bez zmian)', async () => {
    fakturaWCenachBrutto({ lines: LINIE_FAKTURY }, 0.81);
    db.tables.invoice_line_items![2]!.unit_price_net = 0.82;
    const ctx = await getCorrectionParentContextAction(PARENT);
    expect(ctx.success).toBe(true);
    if (ctx.success) expect(ctx.linesBefore.map((l) => l.unitPriceNet)).toEqual([0.81, 0.81, 0.82]);
  });
});
