import PDFDocument from 'pdfkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderInvoicePdf } from '@/lib/pdf/invoice-renderer';
import { finalizeInvoice, type InvoiceInput } from '@/lib/xml/invoice-calculator';

/** Ustalenie 28 (W8 N3 z #927): PDF korekty liczy prefiks PL także ze stanu przed. */
afterEach(() => vi.restoreAllMocks());

describe('PDF korekty: stawki stanu przed', () => {
  async function napisy(opts: { correctionVatRates?: string[] }): Promise<string> {
    const wejscie: InvoiceInput = {
      internalNumber: 'FK/1/11/2026', type: 'KOR', issueDate: '2026-11-02', saleDate: '2026-11-02',
      seller: { nip: '5260001246', name: 'Moja Firma', address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
      buyer: { nip: '5252241585', name: 'Klient', address: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '02-001 Warszawa' } },
      lines: [{ ordinal: 1, name: 'Usługa', unit: 'h', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
      payment: { currency: 'PLN', dueDate: '2026-11-16', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
    };
    const text = vi.spyOn(PDFDocument.prototype, 'text');
    try {
      await renderInvoicePdf(finalizeInvoice(wejscie), opts);
      return text.mock.calls.map((c) => String(c[0])).join('\n');
    } finally {
      text.mockRestore();
    }
  }

  it('stan przed z „np II”, po bez: sprzedawca z „VAT UE: PL…”, jak w pliku FA(3)', async () => {
    const t = await napisy({ correctionVatRates: ['np_ii', '23'] });
    expect(t).toContain('VAT UE: PL5260001246');
  });

  it('bez stanów z koperty: NIP', async () => {
    const t = await napisy({});
    expect(t).toContain('NIP: 5260001246');
  });
});
