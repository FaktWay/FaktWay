import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ row: null as Record<string, unknown> | null, select: vi.fn() }));

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: (cols: string) => {
        mocks.select(cols);
        const query = {
          eq: () => query,
          maybeSingle: async () => ({ data: mocks.row, error: null }),
        };
        return query;
      },
    }),
  }),
}));

import { loadInvoiceForPdf } from '@/lib/pdf/invoice-data';

/**
 * FZ-021, odczyt: `loadInvoiceForPdf` czyta walutę faktury (wcześniej jej nie
 * znał, a wydruk ma dopisek PLN na sztywno). Odmowę wydruku przy innej
 * walucie sprawdza `tests/unit/fz-021-pdf-waluta-generator.test.ts`.
 */

const wiersz = (o: Record<string, unknown> = {}) => ({
  id: 'inv-1', tenant_id: 'ten-1', internal_number: 'FZ/7/2026', invoice_type: 'VAT',
  issue_date: '2026-10-01', sale_date: null, ksef_number: '1234567890-20261001-0100A0B0C0D1-AF', ksef_status: 'accepted',
  net_total: 100, vat_total: 23, gross_total: 123, notes: null, updated_at: '2026-10-01T10:00:00Z',
  pdf_storage_path: 'ten-1/2026/10/inv-1.pdf', pdf_generated_at: '2026-10-02T10:00:00Z',
  seller_data: { nip: '1234567890', name: 'Sprzedawca', address: { countryCode: 'DE', addressLine1: 'Hauptstr. 1' } },
  buyer_data: { nip: '1234567890', name: 'Nabywca', address: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '00-002 Warszawa' } },
  payment_data: { method: 'transfer' },
  invoice_line_items: [{ ordinal: 1, name: 'Usługa', unit: 'szt', quantity: 1, unit_price_net: 100, net_amount: 100, vat_rate: '23', vat_amount: 23, gross_amount: 123 }],
  ...o,
});

beforeEach(() => vi.clearAllMocks());

describe('FZ-021: PDF faktury w walucie innej niż PLN', () => {
  it('odczyt czyta walutę faktury wielkimi literami; brak waluty, pusta i małe litery PLN to złote (domyślna kolumny)', async () => {
    mocks.row = wiersz({ currency: ' eur ' });
    expect((await loadInvoiceForPdf('inv-1', 'ten-1'))?.currency).toBe('EUR');
    expect(mocks.select.mock.calls[0]?.[0]).toMatch(/\bcurrency\b/);
    for (const currency of [null, '', ' ', 'pln', 'PLN']) {
      mocks.row = wiersz({ currency });
      expect((await loadInvoiceForPdf('inv-1', 'ten-1'))?.currency, String(currency)).toBe('PLN');
    }
  });
});
