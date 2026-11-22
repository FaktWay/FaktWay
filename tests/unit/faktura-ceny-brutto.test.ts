import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { sprawdzFa3 } from '@/lib/bezpieczniki/fa3';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { finalizeInvoice, validateInvoice, type InvoiceInput } from '@/lib/xml/invoice-calculator';
import { validateFA3 } from '@/lib/xml/validator';

import { opcje } from '../filtr/generatory/ustawienia';

/**
 * Faktura w cenach brutto (ceny brutto w pozycji, FP i zwykła faktura): plan
 * kompletnej aplikacji, ustalenie z #760 i krok 2.6 („cena brutto”), PR (a)
 * z `ceny-brutto-plan.md`. Art. 106e ust. 7 ustawy o VAT: kwota podatku dla
 * pozycji jednej stawki KP = WB × SP / (100 + SP), WB = wartość sprzedaży
 * brutto; ust. 8: zamiast ceny i wartości netto cena jednostkowa brutto
 * i wartość sprzedaży brutto (FA(3): `P_9B`, `P_11A`); ust. 9: suma wartości
 * netto = WB − KP, z podziałem na stawki; ust. 11: grosze. VAT stawki liczy się
 * od sumy brutto stawki, nie pozycji, więc zgadza się z paragonem z kasy.
 *
 * Prawdziwa ścieżka: `finalizeInvoice` (jak budowanie faktury), `validateInvoice`
 * (bramka wysyłki), `generateFA3Xml`, XSD MF i strażnik FA(3). Bez atrap.
 */

const SELLER = {
  nip: '5260001246',
  name: 'ACME Software sp. z o.o.',
  address: { countryCode: 'PL', addressLine1: 'ul. Przykładowa 1/2', addressLine2: '00-001 Warszawa' },
};
const BUYER = {
  nip: '5252241585',
  name: 'Klient sp. z o.o.',
  address: { countryCode: 'PL', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa' },
};

type Stawka = '23' | '8' | '5' | '0';
type Pozycja = { name: string; quantity: number; unitPriceGross: number; vatRate: Stawka };

function faktura(pozycje: Pozycja[]): InvoiceInput {
  return {
    internalNumber: 'FV 2026/11/001',
    type: 'VAT',
    issueDate: '2026-11-17',
    seller: SELLER,
    buyer: BUYER,
    pricesGross: true,
    lines: pozycje.map((p, i) => ({ ordinal: i + 1, unit: 'szt.', unitPriceNet: 0, ...p })),
    payment: { currency: 'PLN', dueDate: '2026-12-01', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
  };
}

const NOW = new Date('2026-11-17T10:00:00Z');
const pole = (xml: string, nazwa: string) => [...xml.matchAll(new RegExp(`<${nazwa}>([^<]*)</${nazwa}>`, 'g'))].map((m) => m[1]!);
const PROCENT: Record<Stawka, number> = { '23': 23, '8': 8, '5': 5, '0': 0 };
/** VAT od brutto w groszach całkowitych, połówka od zera (art. 106e ust. 7 i 11), niezależnie od kalkulatora. */
const vatOdBrutto = (bruttoGr: number, p: number) => Math.floor((2 * bruttoGr * p + (100 + p)) / (2 * (100 + p)));

async function plik(pozycje: Pozycja[]) {
  const invoice = finalizeInvoice(faktura(pozycje));
  expect(validateInvoice(invoice, new Date('2026-11-17T10:00:00Z'))).toEqual([]);
  const xml = generateFA3Xml(invoice, { generatedAt: new Date('2026-11-17T10:00:00Z') });
  expect((await validateFA3(xml)).errors.map((b) => b.message)).toEqual([]);
  expect(sprawdzFa3(xml)).toEqual([]);
  return { invoice, xml };
}

describe('faktura w cenach brutto: P_9B i P_11A, VAT od sumy brutto stawki', () => {
  it('trzy pozycje po 1,00 zł brutto przy 23 %: VAT stawki 0,56 (od 3,00), nie 0,57 z pozycji; netto 2,44; P_15 3,00', async () => {
    const { invoice, xml } = await plik([
      { name: 'Kawa', quantity: 1, unitPriceGross: 1, vatRate: '23' },
      { name: 'Herbata', quantity: 1, unitPriceGross: 1, vatRate: '23' },
      { name: 'Woda', quantity: 1, unitPriceGross: 1, vatRate: '23' },
    ]);
    expect([pole(xml, 'P_13_1'), pole(xml, 'P_14_1'), pole(xml, 'P_15')]).toEqual([['2.44'], ['0.56'], ['3.00']]);
    expect(pole(xml, 'P_9B')).toEqual(['1.0000', '1.0000', '1.0000']);
    expect(pole(xml, 'P_11A')).toEqual(['1.00', '1.00', '1.00']);
    // Art. 106e ust. 8: cena i wartość brutto zamiast netto.
    expect(pole(xml, 'P_9A')).toEqual([]);
    expect(pole(xml, 'P_11')).toEqual([]);
    expect(invoice.lines.reduce((s, l) => s + Math.round(l.vatAmount * 100), 0)).toBe(56);
    expect(invoice).toMatchObject({ netTotal: 2.44, vatTotal: 0.56, grossTotal: 3 });
  });

  it('dwie stawki jak na paragonie z kasy (bez danych paragonu): VAT każdej stawki od jej sumy brutto, jak PTU', async () => {
    const { xml } = await plik([
      { name: 'Obiad', quantity: 2, unitPriceGross: 20.99, vatRate: '8' },
      { name: 'Deser', quantity: 1, unitPriceGross: 12.5, vatRate: '8' },
      { name: 'Napój', quantity: 3, unitPriceGross: 5.49, vatRate: '23' },
    ]);
    // 8 %: WB = 41,98 + 12,50 = 54,48; KP = 54,48 × 8 / 108 = 4,0355… → 4,04; netto 50,44.
    // 23 %: WB = 16,47; KP = 16,47 × 23 / 123 = 3,0797… → 3,08; netto 13,39.
    expect([pole(xml, 'P_13_1'), pole(xml, 'P_14_1')]).toEqual([['13.39'], ['3.08']]);
    expect([pole(xml, 'P_13_2'), pole(xml, 'P_14_2')]).toEqual([['50.44'], ['4.04']]);
    expect(pole(xml, 'P_15')).toEqual(['70.95']);
  });

  it('prawdziwa faktura do paragonu (FP) w cenach brutto: dane paragonu, FP = 1, P_9B i P_11A, VAT od sumy stawki; XSD i strażnik', async () => {
    const invoice = finalizeInvoice({
      ...faktura([
        { name: 'Rower', quantity: 2, unitPriceGross: 249.99, vatRate: '23' },
        { name: 'Książka', quantity: 1, unitPriceGross: 12.5, vatRate: '5' },
      ]),
      saleDate: '2026-11-10',
      receipt: { receiptNumber: '000123', receiptDate: '2026-11-10', cashRegisterNumber: 'ABC1234567890', buyerNipOnReceipt: true },
      payment: { currency: 'PLN', dueDate: '2026-11-17', method: 'cash' },
    });
    expect(validateInvoice(invoice, NOW)).toEqual([]);
    const xml = generateFA3Xml(invoice, { generatedAt: NOW });
    expect((await validateFA3(xml)).errors.map((b) => b.message)).toEqual([]);
    expect(sprawdzFa3(xml)).toEqual([]);
    expect(xml).toContain('<RodzajFaktury>VAT</RodzajFaktury><FP>1</FP>');
    expect(pole(xml, 'P_9B')).toEqual(['249.9900', '12.5000']);
    expect(pole(xml, 'P_11A')).toEqual(['499.98', '12.50']);
    // 23 %: KP = 499,98 × 23 / 123 = 93,49; 5 %: KP = 12,50 × 5 / 105 = 0,60.
    expect([pole(xml, 'P_13_1'), pole(xml, 'P_14_1'), pole(xml, 'P_13_3'), pole(xml, 'P_14_3'), pole(xml, 'P_15')])
      .toEqual([['406.49'], ['93.49'], ['11.90'], ['0.60'], ['512.48']]);
    expect(pole(xml, 'P_11')).toEqual([]);
  });

  it('ilość × cena brutto dokładnie, do grosza (art. 106e ust. 11): 6,75 × 4216,86 = 28 463,81 brutto, 2,5 × 3,33 = 8,33', async () => {
    const { xml } = await plik([
      { name: 'Montaż', quantity: 6.75, unitPriceGross: 4216.86, vatRate: '23' },
      { name: 'Usługa', quantity: 2.5, unitPriceGross: 3.33, vatRate: '8' },
    ]);
    expect(pole(xml, 'P_11A')).toEqual(['28463.81', '8.33']);
  });

  it('faktura w cenach netto bez zmian: P_9A i P_11, bez P_9B i P_11A', async () => {
    const input: InvoiceInput = { ...faktura([]), pricesGross: undefined, lines: [{ ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 17.07, vatRate: '23' }] };
    const invoice = finalizeInvoice(input);
    const xml = generateFA3Xml(invoice, { generatedAt: new Date('2026-11-17T10:00:00Z') });
    expect([pole(xml, 'P_9A'), pole(xml, 'P_11'), pole(xml, 'P_9B'), pole(xml, 'P_11A')]).toEqual([['17.0700'], ['17.07'], [], []]);
    expect(invoice).toMatchObject({ netTotal: 17.07, vatTotal: 3.93, grossTotal: 21 });
  });
});

describe('niezmiennik faktury w cenach brutto', () => {
  // Ilość w tysięcznych częściach i cena w groszach: wyrocznia liczy brutto pozycji na liczbach
  // całkowitych (połówka grosza w górę, art. 106e ust. 11), bez wyłączeń i bez poprawki epsilon.
  const pozycjaArb = fc.record({
    name: fc.constantFrom('Kawa', 'Obiad', 'Usługa', 'Towar'),
    iloscTys: fc.oneof(fc.integer({ min: 1, max: 20 }).map((n) => n * 1000), fc.integer({ min: 1, max: 9_999 })),
    cenaGr: fc.integer({ min: 1, max: 500_000 }),
    vatRate: fc.constantFrom<Stawka>('23', '8', '5', '0'),
  });

  it('każda stawka: P_14 = VAT od sumy P_11A, P_13 = suma P_11A − P_14; P_15 = suma P_11A; VAT pozycji sumuje się do stawki i różni od udziału o mniej niż grosz; XSD i strażnik', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(pozycjaArb, { minLength: 1, maxLength: 6 }), async (losowe) => {
        const pozycje: Pozycja[] = losowe.map((p) => ({ name: p.name, quantity: p.iloscTys / 1000, unitPriceGross: p.cenaGr / 100, vatRate: p.vatRate }));
        const { invoice, xml } = await plik(pozycje);
        const bruttoGr = losowe.map((p) => Math.floor((2 * p.iloscTys * p.cenaGr + 1000) / 2000));
        expect(pole(xml, 'P_11A').map((v) => Math.round(Number(v) * 100))).toEqual(bruttoGr);
        const POLA: Record<Stawka, [string, string | null]> = { '23': ['P_13_1', 'P_14_1'], '8': ['P_13_2', 'P_14_2'], '5': ['P_13_3', 'P_14_3'], '0': ['P_13_6_1', null] };
        let razem = 0;
        for (const s of Object.keys(POLA) as Stawka[]) {
          const idx = pozycje.flatMap((p, i) => (p.vatRate === s ? [i] : []));
          if (idx.length === 0) continue;
          const wb = idx.reduce((a, i) => a + bruttoGr[i]!, 0);
          const kp = vatOdBrutto(wb, PROCENT[s]);
          razem += wb;
          const [polNetto, polVat] = POLA[s];
          expect(pole(xml, polNetto).map((v) => Math.round(Number(v) * 100))).toEqual([wb - kp]);
          if (polVat) expect(pole(xml, polVat).map((v) => Math.round(Number(v) * 100))).toEqual([kp]);
          // Podział VAT stawki na pozycje (wewnętrzny, do JPK i KPiR): suma = KP, każda pozycja blisko swojego udziału.
          const vatPozycji = idx.map((i) => Math.round(invoice.lines[i]!.vatAmount * 100));
          expect(vatPozycji.reduce((a, v) => a + v, 0)).toBe(kp);
          idx.forEach((i, k) => {
            const udzial = (bruttoGr[i]! * PROCENT[s]) / (100 + PROCENT[s]);
            expect(Math.abs(vatPozycji[k]! - udzial)).toBeLessThan(1);
            expect(Math.round(invoice.lines[i]!.netAmount * 100)).toBe(bruttoGr[i]! - vatPozycji[k]!);
          });
        }
        expect(pole(xml, 'P_15').map((v) => Math.round(Number(v) * 100))).toEqual([razem]);
      }),
      opcje(40),
    );
  });
});

describe('bramka wysyłki (validateInvoice) dla faktury w cenach brutto', () => {
  const trzyKawy = (): Pozycja[] => [
    { name: 'Kawa', quantity: 1, unitPriceGross: 1, vatRate: '23' },
    { name: 'Herbata', quantity: 1, unitPriceGross: 1, vatRate: '23' },
    { name: 'Woda', quantity: 1, unitPriceGross: 1, vatRate: '23' },
  ];

  it('VAT policzony przy pozycjach (0,19 × 3 = 0,57) zamiast od sumy brutto stawki (0,56): odmowa z kwotą, która powinna być', () => {
    const invoice = finalizeInvoice(faktura(trzyKawy()));
    const zlaFaktura = {
      ...invoice,
      lines: invoice.lines.map((l) => ({ ...l, vatAmount: 0.19, netAmount: 0.81 })),
      netTotal: 2.43,
      vatTotal: 0.57,
    };
    const bledy = validateInvoice(zlaFaktura, new Date('2026-11-17T10:00:00Z'));
    expect(bledy.join(' ')).toMatch(/Stawka 23%: VAT pozycji \(0\.57\) nie wynika z sumy brutto stawki \(3\); powinien być 0\.56 \(art\. 106e ust\. 7/);
  });

  it('pozycja bez ceny brutto (wejście z samą ceną netto): cena nie staje się 0 zł, bramka odmawia z numerem pozycji, pliku nie ma', () => {
    const wejscie = faktura(trzyKawy());
    const invoice = finalizeInvoice({
      ...wejscie,
      lines: [{ ordinal: 1, name: 'Usługa', unit: 'szt.', quantity: 1, unitPriceNet: 1000, vatRate: '23' }, ...wejscie.lines.slice(1)],
    });
    expect(invoice.lines[0]).not.toHaveProperty('unitPriceGross');
    expect(validateInvoice(invoice, NOW)).toEqual(expect.arrayContaining([
      'Pozycja 1: faktura w cenach brutto wymaga ceny brutto pozycji (nieujemnej).',
    ]));
    expect(() => generateFA3Xml(invoice, { generatedAt: NOW })).toThrow(/Pozycja 1: faktura w cenach brutto wymaga ceny brutto/);
    expect(() => generateFA3Xml(invoice, { generatedAt: NOW, validate: false })).toThrow(/pozycja 1 faktury w cenach brutto nie ma ceny brutto/);
  });

  it('VAT pozycji poza jej udziałem w VAT stawki (0,57 / −0,01 / 0 przy sumie stawki 0,56): odmowa z numerem pozycji', () => {
    const invoice = finalizeInvoice(faktura(trzyKawy()));
    const podzial = [0.57, -0.01, 0];
    const zla = {
      ...invoice,
      lines: invoice.lines.map((l, i) => ({ ...l, vatAmount: podzial[i]!, netAmount: Math.round((l.grossAmount - podzial[i]!) * 100) / 100 })),
    };
    const bledy = validateInvoice(zla, NOW);
    expect(bledy).toEqual(expect.arrayContaining([
      'Pozycja 1: VAT (0.57) to nie udział pozycji w VAT stawki: od brutto 1 przy 23% wychodzi 0.18 albo 0.19.',
      'Pozycja 2: VAT (-0.01) to nie udział pozycji w VAT stawki: od brutto 1 przy 23% wychodzi 0.18 albo 0.19.',
      'Pozycja 3: VAT (0) to nie udział pozycji w VAT stawki: od brutto 1 przy 23% wychodzi 0.18 albo 0.19.',
    ]));
    // Suma stawki się zgadza (0,56), więc odmawia tylko kontrola udziału pozycji.
    expect(bledy.some((b) => b.startsWith('Stawka 23%'))).toBe(false);
  });

  it('pozycja bez ceny brutto albo z brutto innym niż ilość × cena brutto: odmowa z numerem pozycji', () => {
    const invoice = finalizeInvoice(faktura(trzyKawy()));
    const bledy = validateInvoice({
      ...invoice,
      lines: [{ ...invoice.lines[0]!, unitPriceGross: undefined }, { ...invoice.lines[1]!, unitPriceGross: 2 }, invoice.lines[2]!],
    }, new Date('2026-11-17T10:00:00Z'));
    expect(bledy).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Pozycja 1: faktura w cenach brutto wymaga ceny brutto pozycji/),
      expect.stringMatching(/^Pozycja 2: brutto \(1\) nie zgadza się z ilość × cena brutto \(2\)/),
    ]));
  });
});

describe('bramka wysyłki: nieznana stawka w fakturze w cenach brutto', () => {
  it('pozycja ze stawką spoza listy: ten sam komunikat z numerem pozycji co w cenach netto, stawka nie liczy się jako 0 %', () => {
    const invoice = finalizeInvoice(faktura([
      { name: 'Kawa', quantity: 1, unitPriceGross: 10, vatRate: '23' },
      { name: 'Coś', quantity: 1, unitPriceGross: 10, vatRate: '7' as unknown as Stawka },
    ]));
    const bledy = validateInvoice(invoice, new Date('2026-11-17T10:00:00Z'));
    expect(bledy).toEqual(expect.arrayContaining([
      'Pozycja 2: nieznana stawka VAT „7”. Wybierz w pozycji stawkę z listy formularza.',
    ]));
  });
});

describe('bramka wysyłki: stawki bez podatku w fakturze w cenach brutto (zw, oo, np, np II)', () => {
  /**
   * Art. 106e ust. 7 i 8: cena brutto zamiast netto, gdy podatek liczy się od wartości brutto. Przy
   * stawkach bez podatku (zwolnienie, odwrotne obciążenie, „nie podlega”) wzoru nie ma do czego
   * zastosować, a czy plik może wtedy mieć `P_9B` i `P_11A`, rozstrzyga księgowa (RP-FA-BRUTTO-01).
   * Do tego czasu odmowa z wyjściem: faktura w cenach netto (cena netto = cena brutto, bo podatku nie ma).
   */
  it.each([
    ['zw', 'zw'],
    ['oo', 'oo'],
    ['np', 'np'],
    ['np_ii', 'np II'],
  ])('pozycja ze stawką %s: odmowa z numerem pozycji i wyjściem (ceny netto)', (stawka, etykieta) => {
    const invoice = finalizeInvoice(faktura([
      { name: 'Kawa', quantity: 1, unitPriceGross: 10, vatRate: '23' },
      { name: 'Usługa', quantity: 1, unitPriceGross: 100, vatRate: stawka as unknown as Stawka },
    ]));
    expect(validateInvoice(invoice, NOW)).toEqual(expect.arrayContaining([
      `Pozycja 2: stawka „${etykieta}” nie ma podatku, więc faktura w cenach brutto jej nie obsługuje. Wystaw fakturę w cenach netto: przy tej stawce cena netto to cena brutto.`,
    ]));
  });

  it('stawka 0 % w cenach brutto przechodzi (podatek od brutto 0 zł)', () => {
    const invoice = finalizeInvoice(faktura([{ name: 'Książka', quantity: 2, unitPriceGross: 30, vatRate: '0' }]));
    expect(validateInvoice(invoice, NOW)).toEqual([]);
  });
});
