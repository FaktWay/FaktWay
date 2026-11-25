import { describe, expect, it } from 'vitest';

import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { finalizeInvoice, validateInvoice, vatInPln, type InvoiceInput } from '@/lib/xml/invoice-calculator';
import { validateFA3 } from '@/lib/xml/validator';

/**
 * Zwykła faktura w walucie obcej w pliku FA(3) (plan kompletnej aplikacji,
 * krok 2.1, decyzja D56): `KodWaluty`, kwoty w walucie, `P_14_xW` (podatek
 * stawki w złotych, art. 106e ust. 11 ustawy o VAT) i kurs w
 * `FaWiersz/KursWaluty` każdej pozycji. Pierwsza wersja: jedna data obowiązku
 * i jeden kurs na fakturę, tylko faktura VAT w cenach netto, bez faktury do
 * paragonu. Niezmiennik na losowych danych: `tests/filtr/xsd/fa3-waluta.test.ts`.
 */

type Line = InvoiceInput['lines'][number];

function input(over: Partial<InvoiceInput> = {}, lines: Line[] = [{ ordinal: 1, name: 'Usługa programistyczna', unit: 'usł.', quantity: 1, unitPriceNet: 13560, vatRate: '23' }]): InvoiceInput {
  return {
    internalNumber: 'FV 2026/11/101',
    type: 'VAT',
    issueDate: '2026-11-25',
    saleDate: '2026-11-24',
    seller: {
      nip: '5260001246',
      name: 'ACME Software sp. z o.o.',
      address: { countryCode: 'PL', addressLine1: 'ul. Przykładowa 1/2', addressLine2: '00-001 Warszawa' },
    },
    buyer: {
      vatUeNumber: 'DE123456789',
      name: 'Kunde GmbH',
      address: { countryCode: 'DE', addressLine1: 'Hauptstraße 1', addressLine2: '10115 Berlin' },
    },
    lines,
    payment: { currency: 'EUR', dueDate: '2026-12-09', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
    exchangeRate: { rate: 4.5005, tableNo: '228/A/NBP/2026', tableDate: '2026-11-23' },
    ...over,
  };
}
const at = { generatedAt: new Date('2026-11-25T10:00:00Z') };

describe('FA(3) w walucie obcej (D56)', () => {
  it('przykład MF nr 20: 3118,80 EUR podatku razy kurs 4,5005 to P_14_1W 14 036,16 zł; kurs w pozycji; XSD', async () => {
    const xml = generateFA3Xml(finalizeInvoice(input()), at);
    expect(xml).toContain('<KodWaluty>EUR</KodWaluty>');
    expect(xml).toContain('<P_13_1>13560.00</P_13_1><P_14_1>3118.80</P_14_1><P_14_1W>14036.16</P_14_1W>');
    expect(xml).toContain('<P_15>16678.80</P_15>');
    // Jedna pozycja bez GTU: kurs zaraz po stawce, na końcu wiersza (XSD: …, P_12, …, GTU, Procedura, KursWaluty).
    expect(xml.match(/<P_12>23<\/P_12><KursWaluty>4\.5005<\/KursWaluty><\/FaWiersz>/g)).toHaveLength(1);
    expect((await validateFA3(xml)).errors).toEqual([]);
  });

  it('kilka stawek: P_14_xW dla każdej stawki z podatkiem, bez pola w złotych dla stawki bez podatku; kurs w każdej pozycji', async () => {
    const xml = generateFA3Xml(
      { ...finalizeInvoice(input({ exchangeRate: { rate: 4.2534, tableNo: '228/A/NBP/2026', tableDate: '2026-11-23' } }, [
        { ordinal: 1, name: 'Licencja', unit: 'szt.', quantity: 3, unitPriceNet: 99.99, vatRate: '23' },
        { ordinal: 2, name: 'Książka', unit: 'szt.', quantity: 2, unitPriceNet: 45.5, vatRate: '5' },
        { ordinal: 3, name: 'Catering', unit: 'usł.', quantity: 1, unitPriceNet: 120, vatRate: '8' },
        { ordinal: 4, name: 'Szkolenie', unit: 'godz.', quantity: 4, unitPriceNet: 50, vatRate: 'zw' },
      ])), annotations: { vatExemptionBasis: 'art. 43 ust. 1 pkt 29 ustawy o VAT' } },
      at,
    );
    // 299.97 × 23 % = 68.99 EUR → 68.99 × 4.2534 = 293.442066 → 293.44 zł
    expect(xml).toContain('<P_14_1>68.99</P_14_1><P_14_1W>293.44</P_14_1W>');
    // 120 × 8 % = 9.60 EUR → 40.83264 → 40.83 zł
    expect(xml).toContain('<P_14_2>9.60</P_14_2><P_14_2W>40.83</P_14_2W>');
    // 91 × 5 % = 4.55 EUR → 19.35297 → 19.35 zł
    expect(xml).toContain('<P_14_3>4.55</P_14_3><P_14_3W>19.35</P_14_3W>');
    expect(xml).not.toMatch(/P_13_7W/);
    expect(xml.match(/<KursWaluty>4\.2534<\/KursWaluty>/g)).toHaveLength(4);
    expect((await validateFA3(xml)).errors).toEqual([]);
  });

  it('zaokrąglenie podatku w złotych: do grosza, końcówka od 0,5 grosza w górę, bez błędu liczb zmiennoprzecinkowych', () => {
    expect(vatInPln(3118.8, 4.5005)).toBe(14036.16);
    expect(vatInPln(0.01, 0.5)).toBe(0.01); // 0,5 grosza w górę
    expect(vatInPln(0.03, 0.5)).toBe(0.02); // 1,5 grosza w górę
    expect(vatInPln(0.01, 0.4999)).toBe(0); // 0,4999 grosza w dół
    expect(vatInPln(-0.03, 0.5)).toBe(-0.02); // symetrycznie od zera
    expect(vatInPln(1.15, 1)).toBe(1.15); // 1,15 × 100 w liczbach zmiennoprzecinkowych to 114,99999…
    expect(vatInPln(123456789.12, 4.123456)).toBe(509068637.84); // duże kwoty na liczbach całkowitych
  });

  it('pierwsza wersja odmawia z przyczyną i wyjściem: brak kursu, zły kurs, inny rodzaj faktury, faktura do paragonu, ceny brutto, kurs przy złotych, zły kod', () => {
    const bledy = (over: Partial<InvoiceInput>) => validateInvoice(finalizeInvoice(input(over)), new Date('2026-11-25T10:00:00Z'));
    expect(bledy({ exchangeRate: undefined }).join(' ')).toMatch(/Faktura w EUR potrzebuje kursu NBP/);
    expect(bledy({ exchangeRate: { rate: 0, tableNo: 'x', tableDate: '2026-11-23' } }).join(' ')).toMatch(/kursu NBP większego od zera/);
    expect(bledy({ exchangeRate: { rate: 4.1234567, tableNo: 'x', tableDate: '2026-11-23' } }).join(' ')).toMatch(/najwyżej z 6 miejscami po przecinku/);
    expect(bledy({ type: 'ZAL' }).join(' ')).toMatch(/w walucie obcej tylko zwykłą fakturę VAT/);
    expect(bledy({ receipt: { receiptNumber: '1/2026', cashRegisterNumber: 'ABC12345678', receiptDate: '2026-11-24' } as InvoiceInput['receipt'] }).join(' ')).toMatch(/paragon jest w złotych/);
    expect(bledy({ payment: { currency: 'PLN', dueDate: '2026-12-09', method: 'transfer' } }).join(' ')).toMatch(/Faktura w złotych nie ma kursu waluty/);
    expect(bledy({ payment: { currency: 'EURO', dueDate: '2026-12-09', method: 'transfer' } }).join(' ')).toMatch(/nie jest kodem waluty ISO 4217/);
    expect(bledy({})).toEqual([]);
    for (const b of [...bledy({ exchangeRate: undefined }), ...bledy({ type: 'ZAL' })]) expect(b).not.toMatch(/[—–]/);
  });

  it('bez walidacji generator i tak nie pisze faktury w walucie bez kursu (ostatnia linia obrony)', () => {
    const bezKursu = finalizeInvoice(input({ exchangeRate: undefined }));
    expect(() => generateFA3Xml(bezKursu, { ...at, validate: false })).toThrow(/FA\(3\): faktura w EUR bez kursu/);
  });
});
