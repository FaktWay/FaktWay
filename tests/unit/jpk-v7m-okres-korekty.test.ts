import { describe, expect, it } from 'vitest';

import { JPK_DOCUMENT_REFUSAL_PREFIX, JpkDocumentNotSupportedError, type JpkInvoice } from '@/lib/exports/jpk-fa-generator';
import { generateJpkV7m, summarizeJpkV7m, type JpkV7mInputData } from '@/lib/exports/jpk-v7m-generator';

/**
 * D35 (docs/koordynacja/DECYZJE-2026-11-25.md), NZ-VAT-05: korekta ZWIĘKSZAJĄCA
 * z przyczyną istniejącą w dniu sprzedaży (błąd rachunkowy albo inny błąd
 * istniejący w dniu sprzedaży) idzie do okresu sprzedaży (art. 29a ust. 17
 * ustawy o VAT), a eksport bierze korekty według daty wystawienia. Plik za
 * miesiąc wystawienia byłby więc za późny: odmowa z nazwą dokumentu i wyjściem.
 * Korekta zmniejszająca (ust. 13 i 14) idzie do okresu wystawienia, a nowa
 * okoliczność po sprzedaży albo brak przyczyny zostają jak dotąd.
 */

const linia = (netAmount: number, vatAmount: number) => ({ position: 1, name: 'x', unit: 'szt.', quantity: 1, unitPriceNet: netAmount, netAmount, vatRate: '23', vatAmount });

function korekta(net: number, vat: number, o: Partial<JpkInvoice> = {}): JpkInvoice {
  return {
    invoiceNumber: 'FK/1/10',
    currency: 'PLN',
    invoiceType: 'correction',
    issueDate: '2026-10-12',
    saleDate: '2026-09-20',
    buyerName: 'Klient Sp. z o.o.',
    buyerNip: '5252241585',
    netTotal: net,
    vatTotal: vat,
    grossTotal: net + vat,
    ksefNumber: '5260001246-20261012-0100001AF629-AF',
    correctedInvoiceNumber: 'FV/1/09',
    lines: [linia(net, vat)],
    ...o,
  };
}

function dane(issuedInvoices: JpkInvoice[]): JpkV7mInputData {
  return {
    issuer: { nip: '5260001246', name: 'Moja Firma Sp. z o.o.', email: 'biuro@example.test', taxOfficeCode: '1433' },
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    generatedAt: new Date('2026-11-01T10:00:00Z'),
    issuedInvoices,
  };
}

function odmowa(inv: JpkInvoice): Error {
  try {
    generateJpkV7m(dane([inv]));
  } catch (e) {
    return e as Error;
  }
  throw new Error('plik powstał mimo korekty z innego okresu');
}

describe('JPK_V7M: okres korekty zwiększającej (D35, NZ-VAT-05)', () => {
  for (const przyczyna of ['blad_rachunkowy', 'blad_w_dniu_sprzedazy'] as const) {
    it(`korekta zwiększająca, przyczyna ${przyczyna}: odmowa z nazwą dokumentu i wyjściem`, () => {
      const e = odmowa(korekta(1000, 230, { correctionCause: przyczyna }));
      expect(e).toBeInstanceOf(JpkDocumentNotSupportedError);
      expect(e.message).toContain(JPK_DOCUMENT_REFUSAL_PREFIX);
      expect(e.message).toContain('FK/1/10');
      expect(e.message).toContain('FV/1/09');
      expect(e.message).toContain('art. 29a ust. 17');
      expect(e.message).toContain('poza FaktWay');
    });
  }

  it('odmowa obowiązuje też podsumowanie (rozliczenie w module VAT)', () => {
    expect(() => summarizeJpkV7m(dane([korekta(1000, 230, { correctionCause: 'blad_w_dniu_sprzedazy' })]))).toThrow(JpkDocumentNotSupportedError);
  });

  it('korekta zmniejszająca z tą samą przyczyną: okres wystawienia, plik powstaje', () => {
    const xml = generateJpkV7m(dane([korekta(-1000, -230, { correctionCause: 'blad_rachunkowy' })]));
    expect(xml).toContain('<DowodSprzedazy>FK/1/10</DowodSprzedazy>');
  });

  it('korekta zwiększająca z nową okolicznością albo bez przyczyny: jak dotąd', () => {
    expect(generateJpkV7m(dane([korekta(1000, 230, { correctionCause: 'nowa_okolicznosc' })]))).toContain('FK/1/10');
    expect(generateJpkV7m(dane([korekta(1000, 230)]))).toContain('FK/1/10');
    expect(generateJpkV7m(dane([korekta(1000, 230, { correctionCause: null })]))).toContain('FK/1/10');
  });
});
