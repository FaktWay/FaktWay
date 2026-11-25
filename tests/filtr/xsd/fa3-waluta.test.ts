import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { sprawdzFa3 } from '@/lib/bezpieczniki/fa3';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { finalizeInvoice, type InvoiceInput } from '@/lib/xml/invoice-calculator';
import { validateFA3 } from '@/lib/xml/validator';
import type { Invoice } from '@/types/invoice';

import { PRZYPADKI, ZIARNO } from '../generatory/ustawienia';

/**
 * NZ-FA-06 (żelazny filtr, waluty; plan kompletnej aplikacji, krok 2.1, decyzja
 * D56), część „VAT na fakturze w walucie wykazany także w złotych”: zwykła
 * faktura w walucie obcej ma `P_13_x` i `P_14_x` w walucie, kurs w
 * `FaWiersz/KursWaluty` każdej pozycji, a `P_14_xW` to podatek stawki
 * przeliczony na złote tym kursem, do grosza, końcówka od 0,5 grosza w górę
 * (art. 106e ust. 11 ustawy o VAT; przykład MF nr 20). `P_15` dalej sumuje tylko
 * `P_13_x` i `P_14_x` (w walucie). Wyrocznia liczy na tekstach liczb z pliku,
 * bez kodu generatora. Część o dniu kursu (art. 31a) ma osobny test.
 */
const ILE = PRZYPADKI > 1_000 ? 200 : 20;
const opcje = ZIARNO === undefined ? { numRuns: ILE } : { numRuns: ILE, seed: ZIARNO };

const pozycja = fc.record({
  name: fc.constantFrom('Usługa programistyczna', 'Licencja', 'Szkolenie', 'Konsultacje'),
  unit: fc.constantFrom('szt.', 'usł.', 'godz.'),
  quantity: fc.oneof(fc.integer({ min: 1, max: 500 }), fc.integer({ min: 1, max: 99_999 }).map((n) => n / 1000)),
  unitPriceNet: fc.integer({ min: 1, max: 5_000_000 }).map((g) => g / 100),
  vatRate: fc.constantFrom('23', '8', '5', '0', 'zw') as fc.Arbitrary<'23' | '8' | '5' | '0' | 'zw'>,
});
type Linia = { name: string; unit: string; quantity: number; unitPriceNet: number; vatRate: '23' | '8' | '5' | '0' | 'zw' };
/** Kurs z najwyżej 6 miejscami po przecinku (XSD TIlosci); NBP podaje 4. */
const kurs = fc.integer({ min: 1, max: 99_999_999 }).map((mikro) => mikro / 1_000_000);
const waluta = fc.constantFrom('EUR', 'USD', 'GBP', 'CHF', 'CZK', 'SEK', 'NOK', 'DKK', 'HUF', 'JPY');

function wejscie(linie: Linia[], currency: string, rate?: number): InvoiceInput {
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
    lines: linie.map((l, i) => ({ ordinal: i + 1, ...l })),
    payment: { currency, dueDate: '2026-12-09', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
    ...(rate === undefined ? {} : { exchangeRate: { rate, tableNo: '228/A/NBP/2026', tableDate: '2026-11-23' } }),
  };
}

function faktura(linie: Linia[], currency: string, rate?: number): Invoice {
  const invoice = finalizeInvoice(wejscie(linie, currency, rate));
  return linie.some((l) => l.vatRate === 'zw') ? { ...invoice, annotations: { vatExemptionBasis: 'art. 113 ust. 1 ustawy o VAT' } } : invoice;
}

/** „3118.80” → 311880n (grosze); „4.5005” → 4500500n (milionowe). */
function calkowite(tekst: string, miejsca: number): bigint {
  const [cale, ulamek = ''] = tekst.replace('-', '').split('.');
  const wartosc = BigInt(cale! + ulamek.padEnd(miejsca, '0').slice(0, miejsca));
  return tekst.startsWith('-') ? -wartosc : wartosc;
}
/** Podatek w groszach waluty razy kurs, do grosza, od 0,5 grosza w górę (od zera). */
function wPln(vatTekst: string, kursTekst: string): bigint {
  const iloczyn = calkowite(vatTekst, 2) * calkowite(kursTekst, 6);
  const znak = iloczyn < 0n ? -1n : 1n;
  const modul = iloczyn < 0n ? -iloczyn : iloczyn;
  return znak * ((modul + 500_000n) / 1_000_000n);
}
const tekstPola = (xml: string, pole: string) => new RegExp(`<${pole}>(-?[\\d.]+)</${pole}>`).exec(xml)?.[1];
const grosze = (tekst: string) => calkowite(tekst, 2);

describe('NZ-FA-06: faktura w walucie obcej, VAT w złotych (D56)', () => {
  it('losowe faktury: XSD, kurs w każdej pozycji, P_14_xW = P_14_x razy kurs do grosza, P_15 bez P_14_xW', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(pozycja, { minLength: 1, maxLength: 10 }), waluta, kurs, async (linie, currency, rate) => {
        const xml = generateFA3Xml(faktura(linie, currency, rate), { generatedAt: new Date('2026-11-25T10:00:00Z') });
        expect((await validateFA3(xml)).errors.map((b) => b.message)).toEqual([]);
        expect(sprawdzFa3(xml)).toEqual([]);
        expect(/<KodWaluty>([A-Z]{3})<\/KodWaluty>/.exec(xml)?.[1]).toBe(currency);

        const kursy = [...xml.matchAll(/<KursWaluty>([\d.]+)<\/KursWaluty>/g)].map((d) => d[1]!);
        const wiersze = (xml.match(/<FaWiersz>/g) ?? []).length;
        expect(kursy).toHaveLength(wiersze);
        for (const k of kursy) expect(calkowite(k, 6)).toBe(BigInt(Math.round(rate * 1_000_000)));

        for (const nr of ['1', '2', '3']) {
          const vat = tekstPola(xml, `P_14_${nr}`);
          const wPlnTekst = tekstPola(xml, `P_14_${nr}W`);
          if (vat === undefined) {
            expect(wPlnTekst, `P_14_${nr}W bez P_14_${nr}`).toBeUndefined();
          } else {
            expect(wPlnTekst, `P_14_${nr}W`).toBeDefined();
            expect(grosze(wPlnTekst!)).toBe(wPln(vat, kursy[0]!));
          }
        }

        const suma = (re: RegExp) => [...xml.matchAll(re)].reduce((a, d) => a + grosze(d[1]!), 0n);
        const p15 = grosze(tekstPola(xml, 'P_15')!);
        expect(p15).toBe(suma(/<P_13_[0-9_]+>(-?[\d.]+)<\/P_13_[0-9_]+>/g) + suma(/<P_14_\d+>(-?[\d.]+)<\/P_14_\d+>/g));
      }),
      opcje,
    );
  }, 600_000);

  it('faktura w złotych bez zmian: bez P_14_xW i bez KursWaluty', async () => {
    const pln = faktura([{ name: 'Licencja', unit: 'szt.', quantity: 1, unitPriceNet: 1000, vatRate: '23' }], 'PLN');
    const xml = generateFA3Xml(pln, { generatedAt: new Date('2026-11-25T10:00:00Z') });
    expect((await validateFA3(xml)).errors).toEqual([]);
    expect(xml).not.toMatch(/P_14_\dW|KursWaluty/);
    expect(xml).toContain('<KodWaluty>PLN</KodWaluty>');
  });
});
