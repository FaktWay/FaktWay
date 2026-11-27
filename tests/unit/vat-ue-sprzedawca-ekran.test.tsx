// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { correctionEnvelopeVatRates, sellerIdentifier } from '@/lib/invoices/vat-ue';
import { BuyerInvoiceDocument } from '@/app/faktura/[token]/_components/buyer-invoice-document';

/**
 * Ustalenie 28 planu kompletnej aplikacji (W8 N1-N3 z #927): prefiks PL sprzedawcy przy
 * „np II” także na stronie dla nabywcy i w PDF korekty, który liczy go ze stanów przed i po.
 */

describe('lib/invoices/vat-ue: identyfikator sprzedawcy', () => {
  it('np II: numer VAT UE z prefiksem PL; bez np II: NIP', () => {
    expect(sellerIdentifier('5260001246', ['23', 'np_ii'])).toEqual({ label: 'VAT UE', value: 'PL5260001246' });
    expect(sellerIdentifier('5260001246', ['23'])).toEqual({ label: 'NIP', value: '5260001246' });
  });

  it('stawki stanów przed i po z koperty korekty', () => {
    const koperta = {
      correctionData: {
        linesBefore: [{ vatRate: 'np_ii' }, { vatRate: '23' }],
        linesAfter: [{ vatRate: '23' }, { nie: 'stawka' }],
      },
    };
    expect(correctionEnvelopeVatRates(koperta)).toEqual(['np_ii', '23', '23']);
    expect(correctionEnvelopeVatRates(null)).toEqual([]);
    expect(correctionEnvelopeVatRates({ correctionData: 'x' })).toEqual([]);
  });
});

describe('strona dla nabywcy', () => {
  const party = (nip: string | null) => ({
    name: 'Firma', nip, vatUeNumber: null, addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa',
  });
  const widok = (vatRate: string) => ({
    number: 'FV/1/11/2026', invoiceType: 'VAT', invoiceKind: 'vat', issueDate: '2026-11-02', saleDate: null,
    currency: 'PLN', netTotal: 100, vatTotal: 0, grossTotal: 100, amountDue: 100, notes: null,
    ksefNumber: 'KSEF-1', ksefAcceptedAt: null, splitPayment: false, qr: null, expiresAt: '2027-01-01T00:00:00Z',
    payment: { method: null, dueDate: null, bankAccount: null, bankName: null, swift: null },
    seller: party('5260001246'),
    buyer: { ...party(null), vatUeNumber: 'DE123456789' },
    lines: [{
      ordinal: 1, name: 'Usługa', unit: 'h', quantity: '1', unit_price_net: '100', vat_rate: vatRate,
      net_amount: '100', vat_amount: '0', gross_amount: '100',
    }],
  });
  const html = (vatRate: string) =>
    renderToStaticMarkup(
      // widok ma więcej pól niż ten test podaje
      BuyerInvoiceDocument({ view: widok(vatRate) as never, pdfHref: '/p', xmlHref: '/x' }) as never,
    );

  it('np II: sprzedawca z numerem „VAT UE: PL…”', () => {
    const t = html('np_ii');
    expect(t).toContain('VAT UE: PL5260001246');
    expect(t).not.toContain('NIP: 5260001246');
  });

  it('bez np II: NIP jak dotąd', () => {
    expect(html('23')).toContain('NIP: 5260001246');
  });
});
