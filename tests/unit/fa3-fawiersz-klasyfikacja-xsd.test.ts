import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { PKWIU_LENGTH_MESSAGE, PKWIU_PATTERN_MESSAGE } from '@/lib/invoices/line-codes';
import { generateFinalInvoiceXml } from '@/lib/ksef/fa3-advance-generator';
import { generateCorrectionInvoiceXml } from '@/lib/ksef/fa3-correction-generator';
import { correctionLineSchema, invoiceLineSchema } from '@/lib/validators/invoice-validators';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';
import { validateInvoiceXml } from '@/lib/xml/validator';
import type { BuyerData, CorrectionInvoiceData, FinalInvoiceData, InvoiceLine, SellerData } from '@/types/invoice-types';

/**
 * Kod pozycji z jawnym typem w trzech generatorach FA(3) (plan kompletnej
 * aplikacji, krok 2.6, część 2b-3): faktura zwykła, rozliczająca (ROZ)
 * i korekta (KOR). Pozycja niesie PKWiU (`pkwiuCode`), a plik dostaje
 * `PKWiU`, bez zgadywania typu po długości: dotąd ROZ i KOR zamieniały
 * 8-14 cyfr na GTIN, 4-7 na CN, a filtr `^[0-9A-Za-z]+$` gubił PKWiU
 * z kropkami (62.01.11.0), więc pozycja szła do KSeF bez kodu.
 *
 * Kolejność z XSD (`lib/xml/schemas/fa3/schemat.xsd`, typ FaWiersz,
 * sekwencja): NrWierszaFa, UU_ID, P_6A, P_7, Indeks, GTIN, PKWiU, CN, PKOB,
 * P_8A, P_8B… PKWiU stoi więc po nazwie (P_7), a przed jednostką (P_8A).
 * Schemat pozycji ROZ i KOR (`invoiceLineSchema`, `correctionLineSchema`)
 * sprawdza PKWiU tak samo jak formularz zwykłej faktury.
 */

/** Nazwy elementów pierwszego `FaWiersz` w kolejności z pliku. */
function elementyPierwszegoWiersza(xml: string): string[] {
  const wiersz = /<FaWiersz>([\s\S]*?)<\/FaWiersz>/.exec(xml)?.[1] ?? '';
  return [...wiersz.matchAll(/<([A-Za-z_0-9]+)>/g)].map((m) => m[1]!);
}

function poNazwiePrzedJednostka(elementy: string[]): void {
  const p7 = elementy.indexOf('P_7');
  const kod = elementy.indexOf('PKWiU');
  const p8a = elementy.indexOf('P_8A');
  expect(p7).toBeGreaterThan(-1);
  expect(kod).toBeGreaterThan(p7);
  expect(p8a).toBeGreaterThan(kod);
}

/** PKWiU kolejnych wierszy FaWiersz (`null` = wiersz bez kodu). */
const pkwiuWierszy = (xml: string) =>
  (xml.match(/<FaWiersz>[\s\S]*?<\/FaWiersz>/g) ?? []).map((w) => /<PKWiU>([^<]*)<\/PKWiU>/.exec(w)?.[1] ?? null);

function bezZgadywania(xml: string): void {
  expect(xml).not.toContain('<GTIN>');
  expect(xml).not.toContain('<CN>');
}

const SPRZEDAWCA = {
  nip: '5260001246',
  name: 'ACME Software sp. z o.o.',
  address: { countryCode: 'PL', addressLine1: 'ul. Przykładowa 1/2', addressLine2: '00-001 Warszawa' },
};

/** Zwykła faktura z PKWiU w pozycji (`fa3_data` z formularza ma `pkwiuCode`, część 2b-1). */
function zwykla(pkwiuCode: string) {
  const invoice = finalizeInvoice({
    internalNumber: 'FV 1/11/2026',
    type: 'VAT',
    issueDate: '2026-11-16',
    saleDate: '2026-11-16',
    seller: SPRZEDAWCA,
    buyer: {
      nip: '5252241585',
      name: 'Klient sp. z o.o.',
      address: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '00-002 Warszawa' },
    },
    lines: [{ ordinal: 1, name: 'Produkt', unit: 'szt.', quantity: 2, unitPriceNet: 50, vatRate: '23' }],
    payment: { currency: 'PLN', dueDate: '2026-11-30', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
  });
  return { ...invoice, lines: invoice.lines.map((l) => ({ ...l, pkwiuCode })) };
}

const SELLER: SellerData = {
  nip: '1234567890',
  name: 'Sprzedawca testowy',
  address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' },
};
const BUYER: BuyerData = {
  type: 'b2b',
  idType: 'nip',
  nip: '1234567890',
  name: 'Nabywca testowy',
  address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' },
};
const pozycja = (unitPriceNet: number, pkwiuCode?: string, name = 'Usługa'): InvoiceLine => ({
  name,
  unit: 'usł.',
  quantity: 1,
  unitPriceNet,
  vatRate: '23',
  ...(pkwiuCode ? { pkwiuCode } : {}),
});

function rozliczajaca(lines: InvoiceLine[]): string {
  const data: FinalInvoiceData = {
    invoiceType: 'final',
    taxAnnotations: { cashMethod: 2, splitPayment: 2 },
    internalNumber: 'FR 1/11/2026',
    issueDate: '2026-11-16',
    paymentMethod: 'transfer',
    paymentDueDate: '2026-11-30',
    bankAccount: 'PL61109010140000071219812874',
    seller: SELLER,
    buyer: BUYER,
    advanceInvoiceIds: ['00000000-0000-4000-8000-000000000001'],
    totalAdvances: 123,
    lines,
  };
  const zaliczki = [{ internal_number: 'FZ 1/11/2026', ksef_number: null, advance_amount: 123, issue_date: '2026-11-02', vat_rate: '23' }];
  return generateFinalInvoiceXml(data, zaliczki, { generatedAt: new Date('2026-11-16T10:00:00Z') });
}

function korekta(linesBefore: InvoiceLine[], linesAfter: InvoiceLine[]): string {
  const data: CorrectionInvoiceData = {
    invoiceType: 'correction',
    internalNumber: 'FK 1/11/2026',
    issueDate: '2026-11-16',
    paymentMethod: 'transfer',
    paymentDueDate: '2026-11-30',
    parentInvoiceId: '00000000-0000-4000-8000-000000000001',
    parentInvoiceNumber: 'FV 1/11/2026',
    parentInvoiceIssueDate: '2026-11-02',
    correctionType: 'before_after',
    correctionReason: 'Zmiana ceny',
    typKorekty: '2',
    seller: SELLER,
    buyer: BUYER,
    linesBefore,
    linesAfter,
  };
  return generateCorrectionInvoiceXml(data, { generatedAt: new Date('2026-11-16T10:00:00Z') });
}

describe('FaWiersz z PKWiU: faktura zwykła', () => {
  it.each(['62.01.11.0', '85591300', '5901234123457'])('PKWiU %s jako PKWiU po P_7, przed P_8A; plik zgodny z XSD', async (kod) => {
    const xml = generateFA3Xml(zwykla(kod));
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
    poNazwiePrzedJednostka(elementyPierwszegoWiersza(xml));
    expect(pkwiuWierszy(xml)).toEqual([kod]);
    bezZgadywania(xml);
  });
});

describe('FaWiersz z PKWiU: faktura rozliczająca (ROZ)', () => {
  it.each([
    ['z kropkami (dotąd gubione przez filtr)', '62.01.11.0'],
    ['8 cyfr (dotąd GTIN)', '85591300'],
    ['6 cyfr (dotąd CN)', '620111'],
  ])('PKWiU %s zostaje PKWiU, po P_7 i przed P_8A; plik zgodny z XSD', async (_opis, kod) => {
    const xml = rozliczajaca([pozycja(5000, kod)]);
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
    poNazwiePrzedJednostka(elementyPierwszegoWiersza(xml));
    expect(pkwiuWierszy(xml)).toEqual([kod]);
    bezZgadywania(xml);
  });

  it('PKWiU ze spacjami na brzegach bez spacji; pozycja bez kodu bez PKWiU', async () => {
    const xml = rozliczajaca([pozycja(5000, ' 62.01.11.0 '), pozycja(100, undefined, 'Dojazd')]);
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
    expect(pkwiuWierszy(xml)).toEqual(['62.01.11.0', null]);
  });
});

describe('FaWiersz z PKWiU: korekta przed/po (KOR)', () => {
  it.each([
    ['z kropkami (dotąd gubione przez filtr)', '62.01.11.0'],
    ['8 cyfr (dotąd GTIN)', '85591300'],
  ])('PKWiU %s zostaje PKWiU w obu stanach, po P_7 i przed P_8A; plik zgodny z XSD', async (_opis, kod) => {
    const xml = korekta([pozycja(1000, kod)], [pozycja(900, kod)]);
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
    for (const wiersz of xml.match(/<FaWiersz>[\s\S]*?<\/FaWiersz>/g) ?? []) {
      poNazwiePrzedJednostka(elementyPierwszegoWiersza(wiersz));
    }
    expect(pkwiuWierszy(xml)).toEqual([kod, kod]);
    bezZgadywania(xml);
  });
});

describe('schemat pozycji ROZ i KOR: PKWiU jak w zwykłej fakturze', () => {
  const POZ = { name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 100, vatRate: '23' as const };
  const bledy = (wynik: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) =>
    wynik.success ? [] : wynik.error!.issues.map((i) => `${i.path.join('.')}: ${i.message}`);

  it.each([
    ['invoiceLineSchema', invoiceLineSchema],
    ['correctionLineSchema', correctionLineSchema],
  ] as const)('%s: PKWiU z kropkami i bez, puste i brak przechodzą', (_nazwa, schemat) => {
    for (const pkwiuCode of ['62.01.11.0', '85591300', ' 62.01.11.0 ', '', undefined]) {
      expect(bledy(schemat.safeParse({ ...POZ, pkwiuCode }))).toEqual([]);
    }
  });

  it.each([
    ['invoiceLineSchema', invoiceLineSchema],
    ['correctionLineSchema', correctionLineSchema],
  ] as const)('%s: PKWiU z literami albo dłuższe niż 20 znaków to błąd z tym, co zrobić', (_nazwa, schemat) => {
    expect(bledy(schemat.safeParse({ ...POZ, pkwiuCode: 'ABC123' }))).toEqual([`pkwiuCode: ${PKWIU_PATTERN_MESSAGE}`]);
    expect(bledy(schemat.safeParse({ ...POZ, pkwiuCode: '.62.01' }))).toEqual([`pkwiuCode: ${PKWIU_PATTERN_MESSAGE}`]);
    expect(bledy(schemat.safeParse({ ...POZ, pkwiuCode: '1'.repeat(21) }))).toEqual([`pkwiuCode: ${PKWIU_LENGTH_MESSAGE}`]);
  });
});

describe('niezmiennik: PKWiU pozycji ROZ i KOR', () => {
  /** PKWiU jak w formularzu: cyfra, potem cyfry i kropki, razem do 20 znaków. */
  const kodArb = fc
    .tuple(fc.integer({ min: 0, max: 9 }), fc.array(fc.constantFrom('0', '1', '5', '9', '.'), { maxLength: 19 }))
    .map(([pierwsza, reszta]) => `${pierwsza}${reszta.join('')}`);
  // Netto od 100 zł: zaliczka do rozliczenia ma 123 zł brutto, więcej niż zamówienie zatrzymuje generator ROZ.
  const pozycjeArb = fc.array(
    fc.record({ kod: fc.option(kodArb, { nil: undefined }), netto: fc.integer({ min: 100, max: 100_000 }) }),
    { minLength: 1, maxLength: 5 },
  );

  it('każdy wiersz FaWiersz ma dokładnie PKWiU swojej pozycji (albo żadnego), nigdy GTIN ani CN; plik zgodny z XSD', async () => {
    await fc.assert(
      fc.asyncProperty(pozycjeArb, async (opisy) => {
        const lines = opisy.map((o, i) => pozycja(o.netto, o.kod, `Pozycja ${i + 1}`));
        const roz = rozliczajaca(lines);
        expect(pkwiuWierszy(roz)).toEqual(opisy.map((o) => o.kod ?? null));
        bezZgadywania(roz);
        expect((await validateInvoiceXml(roz)).errors).toEqual([]);

        // Korekta każdej pozycji o 1 zł: wiersz „przed” i „po” z tym samym kodem.
        const kor = korekta(lines, lines.map((l) => ({ ...l, unitPriceNet: l.unitPriceNet + 1 })));
        expect(pkwiuWierszy(kor)).toEqual(opisy.flatMap((o) => [o.kod ?? null, o.kod ?? null]));
        bezZgadywania(kor);
        expect((await validateInvoiceXml(kor)).errors).toEqual([]);
      }),
      { numRuns: 30 },
    );
    // 30 przebiegów po dwa pliki przez walidator XSD: w części Vitest na CI to bywa ponad
    // domyślne 5 s („Test timed out in 5000ms” na main 240aee97 i ba79d18d, grupy kolejki #820,
    // #838). Limit jak w pozostałych testach XSD (`tests/filtr/xsd/*`: 600_000).
  }, 600_000);
});
