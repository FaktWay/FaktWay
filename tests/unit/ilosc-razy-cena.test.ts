import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { sprawdzFa3 } from '@/lib/bezpieczniki/fa3';
import { parseFakturowniaCsv } from '@/lib/import/csv-parsers/fakturownia';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { calculateLineItem, validateInvoice, finalizeInvoice, type InvoiceInput } from '@/lib/xml/invoice-calculator';
import { validateFA3 } from '@/lib/xml/validator';
import type { Invoice, InvoiceLineItem, VatRate } from '@/types/invoice';

import { opcje } from '../filtr/generatory/ustawienia';

/**
 * Wartość pozycji = ilość × cena jednostkowa, a VAT = netto × stawka, oba
 * zaokrąglone do grosza: końcówki poniżej 0,5 grosza pomija się, od 0,5 grosza
 * w górę (art. 106e ust. 11 ustawy o VAT). Kalkulator mnożył liczby
 * zmiennoprzecinkowe (`roundToCents(ilość × cena)`, `roundToCents(netto ×
 * stawka / 100)`), więc iloczyn dokładnie na połówce grosza wychodził tuż pod
 * nią i zaokrąglał się w dół: 2,5 × 3,33 = 8,325 → 8,32 zamiast 8,33, a 23 % od
 * 35,50 = 8,165 → 8,16 zamiast 8,17. Dotyczy każdej faktury w cenach netto
 * (formularz, budowanie, bramka wysyłki, korekta, zaliczka, proforma, JPK) i
 * importu CSV z Fakturowni bez wartości netto pozycji.
 *
 * Wyrocznia: iloczyny na liczbach całkowitych (BigInt) z ilości i ceny zapisanych
 * jako liczba całkowita i liczba miejsc po przecinku, połówka od zera, niezależna
 * od kalkulatora.
 */

function faktura(lines: InvoiceInput['lines']): InvoiceInput {
  return {
    internalNumber: 'FV/1/11/2026', type: 'VAT', issueDate: '2026-11-17',
    seller: { nip: '5260001246', name: 'ACME', address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
    buyer: { nip: '5252241585', name: 'Klient', address: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '00-002 Warszawa' } },
    lines,
    payment: { currency: 'PLN', dueDate: '2026-12-01', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
  };
}

describe('ilość × cena dokładnie, do grosza (art. 106e ust. 11)', () => {
  it.each([
    [2.5, 3.33, 8.33],
    [6.75, 4216.86, 28463.81],
    [3, 1.005, 3.02],
  ])('%s × %s = %s', (quantity, unitPriceNet, net) => {
    expect(calculateLineItem({ quantity, unitPriceNet, vatRate: '23' }).netAmount).toBe(net);
  });

  it('ilość ujemna (anulowanie): symetrycznie, −2,5 × 3,33 = −8,33', () => {
    expect(calculateLineItem({ quantity: -2.5, unitPriceNet: 3.33, vatRate: '23' }).netAmount).toBe(-8.33);
  });

  it('faktura 2,5 × 3,33 przechodzi bramkę wysyłki z wartością 8,33 (bramka liczy tym samym wzorem)', () => {
    const invoice = finalizeInvoice(faktura([{ ordinal: 1, name: 'Usługa', unit: 'godz.', quantity: 2.5, unitPriceNet: 3.33, vatRate: '23' }]));
    expect(invoice.lines[0]).toMatchObject({ netAmount: 8.33, vatAmount: 1.92, grossAmount: 10.25 });
    expect(validateInvoice(invoice, new Date('2026-11-17T10:00:00Z')).filter((e) => e.startsWith('Pozycja 1'))).toEqual([]);
  });

  it('import CSV z Fakturowni bez wartości netto pozycji: wartość z ilość × cena dokładnie (2,5 × 3,33 = 8,33)', () => {
    const pozycje = JSON.stringify([{ nazwa: 'Usługa', ilosc: 2.5, cena_netto: 3.33, vat: '23' }]).replace(/"/g, '""');
    const csv = [
      'Numer;Data wystawienia;Netto;VAT;Brutto;Stawka VAT;NIP sprzedawcy;Pozycje',
      `FV/1/2026;2026-11-10;8,33;1,92;10,25;23;5260001246;"${pozycje}"`,
    ].join('\n');
    const { invoices } = parseFakturowniaCsv(csv);
    expect(invoices[0]?.lines[0]?.netAmount).toBe(8.33);
  });
});

describe('VAT od netto dokładnie, do grosza (art. 106e ust. 11)', () => {
  it.each([
    [35.5, '23', 8.17, 43.67],
    [42.7, '5', 2.14, 44.84],
    [1114.5, '23', 256.34, 1370.84],
  ] as const)('netto %s przy stawce %s: VAT %s, brutto %s', (unitPriceNet, vatRate, vat, gross) => {
    expect(calculateLineItem({ quantity: 1, unitPriceNet, vatRate })).toEqual({
      netAmount: unitPriceNet, vatAmount: vat, grossAmount: gross,
    });
  });

  it('netto ujemne (anulowanie): symetrycznie, −35,50 przy 23 % daje VAT −8,17', () => {
    expect(calculateLineItem({ quantity: -1, unitPriceNet: 35.5, vatRate: '23' })).toEqual({
      netAmount: -35.5, vatAmount: -8.17, grossAmount: -43.67,
    });
  });
});

describe('niezmiennik: pozycja = iloczyny na liczbach całkowitych, połówka od zera', () => {
  /** Liczba całkowita i liczba miejsc po przecinku: ilość albo cena = liczba / 10^miejsca. */
  const kwota = (miejsca: number, max: number) => fc.record({ liczba: fc.integer({ min: 0, max }), miejsca: fc.constant(miejsca) });
  // Różne skale ilości i ceny, tak żeby iloczyn często wypadał dokładnie na połówce grosza.
  const para = fc.oneof(
    fc.tuple(kwota(1, 1_000_000), kwota(2, 100_000_000)),
    fc.tuple(kwota(2, 1_000_000), kwota(2, 100_000_000)),
    fc.tuple(kwota(0, 100_000), kwota(3, 100_000_000)),
    fc.tuple(kwota(4, 100_000_000), kwota(4, 100_000_000)),
    fc.tuple(kwota(3, 10_000_000), kwota(1, 10_000_000)),
    // Ilość 1 i cena w groszach: VAT od netto z połówką grosza (np. 35,50 przy 23 %).
    fc.tuple(kwota(0, 1), kwota(2, 1_000_000_000)),
  );
  const STAWKI: ReadonlyArray<readonly [VatRate, number]> = [['23', 23], ['8', 8], ['5', 5], ['0', 0], ['zw', 0], ['np_ii', 0]];

  const zero = BigInt(0);
  const dwa = BigInt(2);
  /** licznik / mianownik do liczby całkowitej, połówka od zera (mianownik > 0). */
  const podziel = (licznik: bigint, mianownik: bigint) => {
    const modul = licznik < zero ? -licznik : licznik;
    const wynik = (modul * dwa + mianownik) / (mianownik * dwa);
    return licznik < zero ? -wynik : wynik;
  };

  it('ilość i cena do 4 miejsc po przecinku, każda stawka, także ilość ujemna (anulowanie): netto, VAT i brutto = wyrocznia BigInt', () => {
    fc.assert(
      fc.property(para, fc.constantFrom(...STAWKI), fc.boolean(), ([ilosc, cena], [vatRate, procent], ujemna) => {
        if (ilosc.liczba === 0) return;
        const iloczyn = BigInt(ujemna ? -ilosc.liczba : ilosc.liczba) * BigInt(cena.liczba);
        const skala = ilosc.miejsca + cena.miejsca;
        // Do groszy: skala 10^-skala → 10^-2, połówka od zera.
        const netto = skala <= 2 ? iloczyn * BigInt(10) ** BigInt(2 - skala) : podziel(iloczyn, BigInt(10) ** BigInt(skala - 2));
        const vat = podziel(netto * BigInt(procent), BigInt(100));
        const quantity = (ujemna ? -ilosc.liczba : ilosc.liczba) / 10 ** ilosc.miejsca;
        const unitPriceNet = cena.liczba / 10 ** cena.miejsca;
        const wynik = calculateLineItem({ quantity, unitPriceNet, vatRate });
        expect({ netto: wynik.netAmount + 0, vat: wynik.vatAmount + 0, brutto: wynik.grossAmount + 0 }).toEqual({
          netto: Number(netto) / 100 + 0,
          vat: Number(vat) / 100 + 0,
          brutto: Number(netto + vat) / 100 + 0,
        });
      }),
      opcje(2_000),
    );
  });
});

describe('stara faktura z kwotami z dawnego liczenia (wystawiona przed naprawą)', () => {
  /**
   * Zapis w `fa3_data` sprzed naprawy: 35,50 × 23 % z VAT 8,16 (dziś 8,17)
   * i 2,5 × 3,33 z netto 8,32 (dziś 8,33). Ponowna wysyłka (`resendInvoice`,
   * `send-draft`) bierze fakturę z zapisu, sprawdza ją `validateInvoice`
   * i buduje plik `generateFA3Xml` z kwot pozycji, bez liczenia od nowa.
   */
  const stara = (): Invoice => {
    const lines: InvoiceLineItem[] = [
      { ordinal: 1, name: 'Usługa A', unit: 'szt.', quantity: 1, unitPriceNet: 35.5, vatRate: '23', netAmount: 35.5, vatAmount: 8.16, grossAmount: 43.66 },
      { ordinal: 2, name: 'Usługa B', unit: 'godz.', quantity: 2.5, unitPriceNet: 3.33, vatRate: '23', netAmount: 8.32, vatAmount: 1.91, grossAmount: 10.23 },
    ];
    const nowa = finalizeInvoice(faktura(lines.map(({ ordinal, name, unit, quantity, unitPriceNet, vatRate }) => ({ ordinal, name, unit, quantity, unitPriceNet, vatRate }))));
    return { ...nowa, lines, netTotal: 43.82, vatTotal: 10.07, grossTotal: 53.89, payment: { ...nowa.payment, amountDue: 53.89 } };
  };

  it('dziś te pozycje liczą się inaczej (8,17 i 8,33): zapis różni się od kalkulatora', () => {
    const nowa = finalizeInvoice(faktura(stara().lines));
    expect(nowa.lines.map((l) => [l.netAmount, l.vatAmount])).toEqual([[35.5, 8.17], [8.33, 1.92]]);
  });

  it('bramka ponownej wysyłki przyjmuje ją bez błędów (netto ±1 grosz, VAT 8,16 jako VAT od brutto 43,66)', () => {
    expect(validateInvoice(stara(), new Date('2026-11-17T10:00:00Z'))).toEqual([]);
  });

  it('plik z zapisu ma kwoty z zapisu (P_11 35,50 i 8,32, P_13_1 43,82, P_14_1 10,07, P_15 53,89), przechodzi XSD i strażnika', async () => {
    const xml = generateFA3Xml(stara(), { generatedAt: new Date('2026-11-17T10:00:00Z') });
    expect([...xml.matchAll(/<P_11>([^<]+)<\/P_11>/g)].map((m) => m[1])).toEqual(['35.50', '8.32']);
    expect(xml).toContain('<P_13_1>43.82</P_13_1>');
    expect(xml).toContain('<P_14_1>10.07</P_14_1>');
    expect(xml).toContain('<P_15>53.89</P_15>');
    expect((await validateFA3(xml)).errors.map((b) => b.message)).toEqual([]);
    expect(sprawdzFa3(xml)).toEqual([]);
  });
});
