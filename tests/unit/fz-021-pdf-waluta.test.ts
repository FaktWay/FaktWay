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
import { generateInvoicePdf } from '@/lib/pdf/invoice-pdf';

/**
 * FZ-021: PDF faktury drukuje kwoty z dopiskiem „PLN” na sztywno, a odczyt
 * nie znał waluty faktury. Faktura w innej walucie (np. faktura zakupu z KSeF
 * w EUR w paczce archiwum albo pobrana po adresie) dostawała wydruk z kwotami
 * w walucie i dopiskiem PLN. Teraz odmowa z numerem, walutą i wyjściem,
 * zanim powstanie wydruk albo zostanie wydany zapisany wcześniej plik.
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
  it('odczyt czyta walutę faktury; brak waluty w wierszu to złote (domyślna kolumny)', async () => {
    mocks.row = wiersz({ currency: ' eur ' });
    expect((await loadInvoiceForPdf('inv-1', 'ten-1'))?.currency).toBe('EUR');
    expect(mocks.select.mock.calls[0]?.[0]).toMatch(/\bcurrency\b/);
    mocks.row = wiersz({ currency: null });
    expect((await loadInvoiceForPdf('inv-1', 'ten-1'))?.currency).toBe('PLN');
  });

  it('faktura w EUR: odmowa z numerem, walutą i wyjściem, bez wydruku i bez zapisanego wcześniej pliku', async () => {
    mocks.row = wiersz({ currency: 'EUR' });
    const wynik = await generateInvoicePdf('inv-1', 'ten-1');
    expect(wynik).toMatchObject({ success: false, code: 'CURRENCY_NOT_SUPPORTED' });
    if (wynik.success) return;
    expect(wynik.error).toContain('FZ/7/2026');
    expect(wynik.error).toContain('EUR');
    expect(wynik.error).toContain('KSeF');
  });
});
