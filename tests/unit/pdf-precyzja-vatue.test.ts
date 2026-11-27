import PDFDocument from 'pdfkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderInvoicePdf } from '@/lib/pdf/invoice-renderer';
import { finalizeInvoice, type InvoiceInput } from '@/lib/xml/invoice-calculator';

/**
 * F-069 (audyt bloku 1):
 *  - PDF zaokrąglał ilość i cenę jednostkową do 2 miejsc, choć baza i XML
 *    trzymają 4 (NUMERIC(14,4), P_8B/P_9A). Cena 100,1234 drukowała się jako
 *    100,12 obok wartości 150,19 — klient nie mógł przeliczyć pozycji.
 *  - Numer VAT UE nabywcy zagranicznego był opisany jako „NIP”.
 */

function faktura(buyer: InvoiceInput['buyer'], quantity: number, unitPriceNet: number) {
  const input: InvoiceInput = {
    internalNumber: 'FV/7/10/2026',
    type: 'VAT',
    issueDate: '2026-10-01',
    saleDate: '2026-10-01',
    seller: {
      nip: '5260001246',
      name: 'Moja Firma Sp. z o.o.',
      address: { countryCode: 'PL', addressLine1: 'ul. Przykładowa 1', addressLine2: '00-001 Warszawa' },
    },
    buyer,
    lines: [{ ordinal: 1, name: 'Usługa', unit: 'h', quantity, unitPriceNet, vatRate: '23' }],
    payment: { currency: 'PLN', dueDate: '2026-10-15', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
  };
  return finalizeInvoice(input);
}

const krajowy: InvoiceInput['buyer'] = {
  nip: '5252241585',
  name: 'Klient Sp. z o.o.',
  address: { countryCode: 'PL', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa' },
};

async function napisy(invoice: ReturnType<typeof finalizeInvoice>): Promise<string[]> {
  const text = vi.spyOn(PDFDocument.prototype, 'text');
  await renderInvoicePdf(invoice);
  return text.mock.calls.map((c) => String(c[0]));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PDF — precyzja ilości i ceny (F-069)', () => {
  it('cena 100,1234 i ilość 1,5 wypisane w całości', async () => {
    const t = await napisy(faktura(krajowy, 1.5, 100.1234));
    expect(t).toContain('100,1234');
    expect(t).toContain('1,50');
    expect(t).toContain('150,19');
  });

  it('ilość 0,125 bez obcięcia; zwykła cena nadal z dwoma miejscami', async () => {
    const t = await napisy(faktura(krajowy, 0.125, 80));
    expect(t).toContain('0,125');
    expect(t).toContain('80,00');
  });
});

describe('PDF — identyfikator nabywcy (F-069)', () => {
  it('numer VAT UE z etykietą „VAT UE”, nie „NIP”', async () => {
    const t = await napisy(
      faktura(
        {
          vatUeNumber: 'DE123456789',
          name: 'Kunde GmbH',
          address: { countryCode: 'DE', addressLine1: 'Hauptstr. 1', addressLine2: '10115 Berlin' },
        },
        1,
        100,
      ),
    );
    expect(t).toContain('VAT UE: DE123456789');
    expect(t).not.toContain('NIP: DE123456789');
  });

  it('nabywca krajowy nadal z etykietą „NIP”', async () => {
    const t = await napisy(faktura(krajowy, 1, 100));
    expect(t).toContain('NIP: 5252241585');
  });
});

describe('PDF — numer VAT UE sprzedawcy przy usłudze np II (plan zero C2, W8)', () => {
  const firmaDe: InvoiceInput['buyer'] = {
    vatUeNumber: 'DE123456789',
    name: 'Kunde GmbH',
    address: { countryCode: 'DE', addressLine1: 'Hauptstr. 1', addressLine2: '10115 Berlin' },
  };

  it('usługa np II: sprzedawca z numerem „VAT UE: PL…”, jak PrefiksPodatnika w pliku FA(3)', async () => {
    const zwykla = faktura(firmaDe, 1, 100);
    const t = await napisy(finalizeInvoice({ ...zwykla, lines: [{ ...zwykla.lines[0]!, vatRate: 'np_ii' }] }));
    expect(t).toContain('VAT UE: PL5260001246');
    expect(t).not.toContain('NIP: 5260001246');
  });

  it('faktura bez np II: sprzedawca z NIP-em jak dotąd', async () => {
    const t = await napisy(faktura(firmaDe, 1, 100));
    expect(t).toContain('NIP: 5260001246');
    expect(t).not.toContain('PL5260001246');
  });
});
