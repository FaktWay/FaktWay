import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { toLineItems } from '@/components/invoices/invoice-form-parts/calculations';
import { sprawdzFa3 } from '@/lib/bezpieczniki/fa3';
import { buildInvoiceFromForm, draftLineRows } from '@/lib/invoices/build-from-form';
import { invoiceFormSchema, type InvoiceFormValues } from '@/lib/schemas/invoice-form';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { calculateInvoiceTotals, finalizeInvoice, summarizeVatPerRate, validateInvoice } from '@/lib/xml/invoice-calculator';
import { validateFA3 } from '@/lib/xml/validator';
import type { InvoiceLineItem } from '@/types/invoice';

import { opcje } from '../filtr/generatory/ustawienia';

/**
 * Faktura w cenach brutto z formularza (plan cen brutto, PR (b); krok 2.6 planu
 * kompletnej aplikacji, „cena brutto”). Klient wybiera dla całej faktury ceny
 * netto albo ceny brutto. Przy cenach brutto pozycja ma cenę brutto, a faktura
 * liczy VAT od sumy brutto stawki (art. 106e ust. 7-9 i 11 ustawy o VAT,
 * RP-FA-BRUTTO-01); plik FA(3) ma `P_9B` i `P_11A` zamiast `P_9A` i `P_11` (#835).
 *
 * Prawdziwa ścieżka bez atrap: schemat formularza (`invoiceFormSchema`, ten sam
 * na kliencie i serwerze), budowanie faktury (`buildInvoiceFromForm`), wiersze
 * pozycji w bazie (`draftLineRows`), bramka wysyłki (`validateInvoice`),
 * generator FA(3), XSD MF i strażnik FA(3); podgląd sum formularza (`toLineItems`).
 */

const NOW = new Date('2026-11-17T10:00:00Z');
const TENANT = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  nip: '5260001246',
  name: 'ACME Software sp. z o.o.',
  address: { countryCode: 'PL', addressLine1: 'ul. Przykładowa 1/2', addressLine2: '00-001 Warszawa' },
};

type Pozycja = InvoiceFormValues['lines'][number];

const kawy = (): Pozycja[] =>
  ['Kawa', 'Herbata', 'Woda'].map((name) => ({ name, unit: 'szt.', quantity: 1, unitPriceNet: 0, unitPriceGross: 1, vatRate: '23' as const }));

function wartosci(o: Partial<InvoiceFormValues> = {}): InvoiceFormValues {
  return {
    internalNumber: 'FV/1/11/2026',
    issueDate: '2026-11-17',
    saleDate: '',
    buyerNip: '5252241585',
    buyerName: 'Klient sp. z o.o.',
    buyerAddressLine1: 'ul. Klienta 10',
    buyerAddressLine2: '02-001 Warszawa',
    buyerEmail: '',
    buyerIsConsumer: false,
    buyerPesel: '',
    buyerIdDocument: '',
    paymentMethod: 'transfer',
    paymentDueDate: '2026-12-01',
    bankAccount: 'PL61109010140000071219812874',
    notes: '',
    splitPayment: false,
    pricesGross: true,
    lines: kawy(),
    ...o,
  } as InvoiceFormValues;
}

/** Błędy schematu jako `ścieżka: komunikat` (pusta lista = wartości przechodzą). */
function bledy(values: unknown): string[] {
  const r = invoiceFormSchema.safeParse(values);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

function zbuduj(values: InvoiceFormValues) {
  return buildInvoiceFromForm(invoiceFormSchema.parse(values), TENANT, null, false);
}

const pole = (xml: string, nazwa: string) => [...xml.matchAll(new RegExp(`<${nazwa}>([^<]*)</${nazwa}>`, 'g'))].map((m) => m[1]!);

async function plik(values: InvoiceFormValues) {
  const invoice = zbuduj(values);
  expect(validateInvoice(invoice, NOW)).toEqual([]);
  const xml = generateFA3Xml(invoice, { generatedAt: NOW });
  expect((await validateFA3(xml)).errors.map((b) => b.message)).toEqual([]);
  expect(sprawdzFa3(xml)).toEqual([]);
  return { invoice, xml };
}

const kwoty = (l: Pick<InvoiceLineItem, 'netAmount' | 'vatAmount' | 'grossAmount'>) => [l.netAmount, l.vatAmount, l.grossAmount];

describe('faktura w cenach brutto z formularza: schemat i budowanie', () => {
  it('trzy pozycje po 1,00 zł brutto przy 23 %: VAT stawki 0,56 od 3,00; plik z P_9B i P_11A przez XSD MF, strażnik i bramkę wysyłki; w bazie cena netto pusta', async () => {
    expect(bledy(wartosci())).toEqual([]);
    const { invoice, xml } = await plik(wartosci());
    expect(invoice).toMatchObject({ pricesGross: true, netTotal: 2.44, vatTotal: 0.56, grossTotal: 3, payment: { amountDue: 3 } });
    expect(pole(xml, 'P_9B')).toEqual(['1.0000', '1.0000', '1.0000']);
    expect(pole(xml, 'P_11A')).toEqual(['1.00', '1.00', '1.00']);
    expect([pole(xml, 'P_9A'), pole(xml, 'P_11')]).toEqual([[], []]);
    expect([pole(xml, 'P_13_1'), pole(xml, 'P_14_1'), pole(xml, 'P_15')]).toEqual([['2.44'], ['0.56'], ['3.00']]);
    // Pozycje w bazie jak import od brutto (F12-E4): cena netto pusta, netto i VAT z podziału VAT stawki.
    const wiersze = draftLineRows(invoice);
    expect(wiersze.map((w) => w.unit_price_net)).toEqual([null, null, null]);
    expect(wiersze.map((w) => [w.net_amount, w.vat_amount, w.gross_amount])).toEqual([
      [0.81, 0.19, 1],
      [0.81, 0.19, 1],
      [0.82, 0.18, 1],
    ]);
  });

  it('faktura do paragonu (FP) z formularza w cenach brutto: dane paragonu, FP 1, VAT każdej stawki od jej sumy brutto jak PTU z kasy; XSD i strażnik', async () => {
    const fp = wartosci({
      saleDate: '2026-11-10',
      receiptInvoice: true,
      receiptNumber: '000123',
      receiptDate: '2026-11-10',
      cashRegisterNumber: 'ABC1234567890',
      receiptRequestDate: '',
      buyerNipOnReceipt: true,
      paymentMethod: 'cash',
      bankAccount: '',
      paymentDueDate: '2026-11-17',
      lines: [
        { name: 'Rower', unit: 'szt.', quantity: 2, unitPriceNet: 0, unitPriceGross: 249.99, vatRate: '23' },
        { name: 'Książka', unit: 'szt.', quantity: 1, unitPriceNet: 0, unitPriceGross: 12.5, vatRate: '5' },
      ],
    });
    expect(bledy(fp)).toEqual([]);
    const { invoice, xml } = await plik(fp);
    expect(invoice.receipt).toMatchObject({ receiptNumber: '000123', receiptDate: '2026-11-10', cashRegisterNumber: 'ABC1234567890' });
    expect(xml).toContain('<RodzajFaktury>VAT</RodzajFaktury><FP>1</FP>');
    expect(pole(xml, 'P_11A')).toEqual(['499.98', '12.50']);
    // 23 %: KP = 499,98 × 23 / 123 = 93,49; 5 %: KP = 12,50 × 5 / 105 = 0,60.
    expect([pole(xml, 'P_13_1'), pole(xml, 'P_14_1'), pole(xml, 'P_13_3'), pole(xml, 'P_14_3'), pole(xml, 'P_15')])
      .toEqual([['406.49'], ['93.49'], ['11.90'], ['0.60'], ['512.48']]);
  });

  it('pozycja bez ceny brutto przy cenach brutto: „Podaj cenę brutto pozycji” przy polu ceny brutto tej pozycji, a nie cena 0 zł', () => {
    const [kawa, herbata] = kawy();
    expect(bledy(wartosci({ lines: [{ ...kawa!, unitPriceGross: undefined }, herbata!] }))).toEqual([
      'lines.0.unitPriceGross: Podaj cenę brutto pozycji',
    ]);
  });

  it('cena brutto: te same granice co cena netto (nieujemna, najwyżej 4 miejsca, do 10 mld zł), błąd przy polu', () => {
    const z = (unitPriceGross: number) => bledy(wartosci({ lines: [{ ...kawy()[0]!, unitPriceGross }] }));
    expect(z(-1)).toEqual(['lines.0.unitPriceGross: Cena brutto nie może być ujemna']);
    expect(z(1.23456)).toEqual(['lines.0.unitPriceGross: Cena brutto: najwyżej 4 miejsca po przecinku']);
    expect(z(20_000_000_000)).toEqual(expect.arrayContaining(['lines.0.unitPriceGross: Cena brutto za duża']));
  });

  it('limit kwoty faktury przy cenach brutto liczy się z ceny brutto', () => {
    expect(bledy(wartosci({ lines: [{ ...kawy()[0]!, quantity: 2, unitPriceGross: 6_000_000_000 }] }))).toEqual([
      'lines: Kwota faktury przekracza 10 mld zł — podziel ją na kilka faktur',
    ]);
  });

  const EU = { buyerIsEu: true, buyerNip: '', buyerVatUe: 'DE123456789', buyerCountryCode: 'DE' } as const;

  it.each([
    ['zw', 'zw', {}],
    ['oo', 'oo', {}],
    ['np', 'np', {}],
    ['np_ii', 'np II', EU],
  ] as const)('stawka %s w cenach brutto: przy polu stawki ten sam komunikat co bramka wysyłki (z wyjściem: ceny netto)', (stawka, etykieta, nabywca) => {
    const values = wartosci({
      ...nabywca,
      lines: [kawy()[0]!, { name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 0, unitPriceGross: 100, vatRate: stawka }],
    });
    const tekst = `„${etykieta}” nie ma podatku, więc faktura w cenach brutto jej nie obsługuje. Wystaw fakturę w cenach netto.`;
    expect(bledy(values)).toEqual([`lines.1.vatRate: Stawka ${tekst}`]);
    // Ta sama faktura zbudowana bez schematu (wywołanie wprost) i tak nie wyjdzie: bramka wysyłki ma to samo zdanie.
    const invoice = buildInvoiceFromForm(values, TENANT, stawka === 'zw' ? 'art. 113 ust. 1 ustawy o VAT' : null, false);
    expect(validateInvoice(invoice, NOW)).toContain(`Pozycja 2: stawka ${tekst}`);
  });

  it('stawka 0 % w cenach brutto przechodzi (to stawka podatku; od brutto wychodzi 0 zł)', () => {
    expect(bledy(wartosci({ lines: [{ ...kawy()[0]!, vatRate: '0', unitPriceGross: 50 }] }))).toEqual([]);
    expect(zbuduj(wartosci({ lines: [{ ...kawy()[0]!, vatRate: '0', unitPriceGross: 50 }] }))).toMatchObject({ netTotal: 50, vatTotal: 0, grossTotal: 50 });
  });

  it('faktura w cenach netto bez zmian: ta sama faktura, plik i wiersze bez klucza metody, z „ceny netto” i z ukrytą ceną brutto', async () => {
    const netto = wartosci({
      pricesGross: undefined,
      lines: [{ name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 17.07, vatRate: '23' }],
    });
    const { invoice, xml } = await plik(netto);
    expect(invoice).not.toHaveProperty('pricesGross');
    expect(invoice).toMatchObject({ netTotal: 17.07, vatTotal: 3.93, grossTotal: 21 });
    expect(invoice.lines[0]).not.toHaveProperty('unitPriceGross');
    expect(invoice.lines[0]).not.toHaveProperty('unitPriceNetMissing');
    expect([pole(xml, 'P_9A'), pole(xml, 'P_11'), pole(xml, 'P_9B'), pole(xml, 'P_11A')]).toEqual([['17.0700'], ['17.07'], [], []]);
    expect(draftLineRows(invoice).map((w) => w.unit_price_net)).toEqual([17.07]);
    // „Ceny netto” w formularzu (false) i cena brutto pozostała po przełączeniu metod: faktura ta sama co znak w znak.
    const zWyboru = wartosci({ ...netto, pricesGross: false, lines: [{ ...netto.lines[0]!, unitPriceGross: 21 }] });
    expect(bledy(zWyboru)).toEqual([]);
    expect(zbuduj(zWyboru)).toEqual(invoice);
    expect(generateFA3Xml(zbuduj(zWyboru), { generatedAt: NOW })).toBe(xml);
  });
});

describe('podgląd sum w formularzu liczy tak samo jak serwer', () => {
  it('trzy pozycje po 1,00 zł brutto: podgląd VAT 0,56 od sumy brutto stawki (nie 0,57 z pozycji), jak faktura', () => {
    const podglad = toLineItems(kawy(), true);
    expect(calculateInvoiceTotals(podglad)).toEqual({ netTotal: 2.44, vatTotal: 0.56, grossTotal: 3 });
    expect(podglad.map(kwoty)).toEqual(zbuduj(wartosci()).lines.map(kwoty));
  });

  it('niedokończone pozycje (puste pole ilości albo ceny brutto) liczą się jak zero, podgląd nie pada', () => {
    const lines = [
      { name: 'Kawa', unit: 'szt.', quantity: Number.NaN, unitPriceNet: 0, unitPriceGross: 2, vatRate: '23' },
      { name: '', unit: 'szt.', quantity: 1, unitPriceNet: 0, unitPriceGross: undefined, vatRate: '8' },
      { name: 'Woda', unit: 'szt.', quantity: 2, unitPriceNet: 0, unitPriceGross: 1.5, vatRate: '23' },
    ] as Pozycja[];
    expect(calculateInvoiceTotals(toLineItems(lines, true))).toEqual({ netTotal: 2.44, vatTotal: 0.56, grossTotal: 3 });
  });

  it('losowe pozycje: podgląd (pozycje, stawki, sumy) = faktura z serwera = finalizeInvoice w cenach brutto (#835), a VAT każdej stawki = KP od sumy brutto stawki (wyrocznia na liczbach całkowitych)', () => {
    // Ilość w tysięcznych częściach i cena w groszach: wyrocznia liczy brutto pozycji
    // i VAT stawki na liczbach całkowitych (połówka od zera, art. 106e ust. 7 i 11).
    const pozycjaArb = fc.record({
      iloscTys: fc.oneof(fc.integer({ min: 1, max: 20 }).map((n) => n * 1000), fc.integer({ min: 1, max: 9_999 })),
      cenaGr: fc.integer({ min: 0, max: 500_000 }),
      vatRate: fc.constantFrom('23', '8', '5', '0'),
    });
    const PROCENT: Record<string, number> = { '23': 23, '8': 8, '5': 5, '0': 0 };
    fc.assert(
      fc.property(fc.array(pozycjaArb, { minLength: 1, maxLength: 6 }), (losowe) => {
        const lines: Pozycja[] = losowe.map((p, i) => ({
          name: `Pozycja ${i + 1}`, unit: 'szt.', quantity: p.iloscTys / 1000, unitPriceNet: 0,
          unitPriceGross: p.cenaGr / 100, vatRate: p.vatRate as Pozycja['vatRate'],
        }));
        const invoice = zbuduj(wartosci({ lines }));
        const podglad = toLineItems(lines, true);
        const zLiczenia = finalizeInvoice({
          internalNumber: invoice.internalNumber, type: 'VAT', issueDate: invoice.issueDate, seller: invoice.seller, buyer: invoice.buyer,
          payment: { currency: 'PLN', dueDate: invoice.payment.dueDate, method: 'transfer' }, pricesGross: true,
          lines: lines.map((l, i) => ({ ordinal: i + 1, name: l.name, unit: l.unit, quantity: l.quantity, unitPriceNet: 0, unitPriceGross: l.unitPriceGross, vatRate: l.vatRate })),
        });
        expect(invoice.lines.map(kwoty)).toEqual(zLiczenia.lines.map(kwoty));
        expect([invoice.netTotal, invoice.vatTotal, invoice.grossTotal]).toEqual([zLiczenia.netTotal, zLiczenia.vatTotal, zLiczenia.grossTotal]);
        expect(podglad.map(kwoty)).toEqual(invoice.lines.map(kwoty));
        expect(calculateInvoiceTotals(podglad)).toEqual({ netTotal: invoice.netTotal, vatTotal: invoice.vatTotal, grossTotal: invoice.grossTotal });
        expect(summarizeVatPerRate(podglad)).toEqual(summarizeVatPerRate(invoice.lines));
        const bruttoGr = losowe.map((p) => Math.floor((2 * p.iloscTys * p.cenaGr + 1000) / 2000));
        for (const s of new Set(losowe.map((p) => p.vatRate))) {
          const wb = losowe.reduce((a, p, i) => a + (p.vatRate === s ? bruttoGr[i]! : 0), 0);
          const pct = PROCENT[s]!;
          const kp = Math.floor((2 * wb * pct + (100 + pct)) / (2 * (100 + pct)));
          const vatStawki = invoice.lines.reduce((a, l) => a + (l.vatRate === s ? Math.round(l.vatAmount * 100) : 0), 0);
          expect(vatStawki).toBe(kp);
        }
      }),
      opcje(60),
    );
  });
});
