import { describe, expect, it } from 'vitest';

import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';
import type { Invoice } from '@/types/invoice';

/**
 * FZ-040 (decyzja D1, `docs/koordynacja/DECYZJE-2026-11-25.md`): faktura
 * w cenach netto liczy VAT od każdej pozycji i sumuje go po stawkach, a plik
 * FA(3) nie ma `P_11Vat` przy pozycjach. Przy kilku pozycjach suma VAT pozycji
 * różni się od podatku od sumy netto, więc faktura nie spełnia ani art. 106e
 * ust. 1 pkt 14 ustawy o VAT (podatek od sumy netto stawki), ani warunku
 * ust. 10 (kwoty podatku przy pozycjach). Naprawa w planie kompletnej aplikacji
 * (`P_11Vat` w generatorach i kolumna VAT w PDF); do tego czasu `.fails`.
 */

function faktura(): Invoice {
  return finalizeInvoice({
    internalNumber: 'FV/FZ040/1', type: 'VAT', issueDate: '2026-11-25', saleDate: '2026-11-25',
    seller: { nip: '1234567890', name: 'Firma testowa', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } },
    buyer: { nip: '1234567890', name: 'Nabywca testowy', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' } },
    lines: [1, 2, 3].map((ordinal) => ({ ordinal, name: `Usługa ${ordinal}`, unit: 'usł.', quantity: 1, unitPriceNet: 0.1, vatRate: '23' })),
    payment: { currency: 'PLN', dueDate: '2026-12-09', method: 'transfer', bankAccount: '61109010140000071219812874' },
  } as Invoice);
}
const gen = (inv: Invoice) => generateFA3Xml(inv, { validate: false, generatedAt: new Date('2026-11-25T08:00:00Z') });

describe('FZ-040: VAT pozycji w fakturze w cenach netto', () => {
  it('dziś VAT od każdej pozycji: 3 × 0,10 zł przy 23 % daje P_14_1 = 0,06, a podatek od sumy netto byłby 0,07', () => {
    const xml = gen(faktura());
    expect(xml).toContain('<P_13_1>0.30</P_13_1>');
    expect(xml).toContain('<P_14_1>0.06</P_14_1>');
  });

  it.fails('FZ-040: plik ma P_11Vat przy każdej pozycji, więc suma VAT pozycji spełnia art. 106e ust. 10', () => {
    const xml = gen(faktura());
    expect(xml.match(/<P_11Vat>0\.02<\/P_11Vat>/g) ?? []).toHaveLength(3);
  });
});
