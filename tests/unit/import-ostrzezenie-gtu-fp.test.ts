import { describe, expect, it } from 'vitest';

import { amountsOf, type JpkInvoice } from '@/lib/exports/jpk-fa-generator';
import { summarizeJpkV7m } from '@/lib/exports/jpk-v7m-generator';
import type { ParsedInvoice } from '@/lib/import/fa3-parser';
import { heldDocumentWarning, importedInvoiceContent, mapParsedKindToFaVatType } from '@/lib/import/imported-invoice-row';
import type { Fa3Markers } from '@/lib/xml/fa3-annotations';

/**
 * Ostrzeżenie importu o fakturze, której JPK nie wykaże (plan kompletnej
 * aplikacji, osobne ustalenie z kroku 2b-2): tekst ma mówić to samo co
 * prawdziwe generatory. Dla każdego oznaczenia z pliku KSeF ten sam stan
 * faktury idzie do `amountsOf` (JPK_FA) i do `summarizeJpkV7m` (JPK_V7M), a
 * ostrzeżenie ma nazwać dokładnie ten plik (albo oba), który nie powstanie.
 * Po #788 JPK_V7M wykazuje poprawne GTU z pliku, po #715 FP typem FP (gdy
 * paragon jest z wcześniejszego miesiąca); JPK_FA odmawia (decyzja C5b).
 */

const ISSUE = '2026-11-05';
const NUMBER = 'FV/GTU/1';

const liniaOo = { position: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 100, vatRate: 'oo', netAmount: 100 };
const OO = { lines: [liniaOo], totals: { netTotal: 100, vatTotal: 0, grossTotal: 100 } } as Partial<ParsedInvoice>;

function parsed(over: Partial<ParsedInvoice>, markers?: Fa3Markers): ParsedInvoice {
  return {
    invoiceNumber: NUMBER,
    issueDate: ISSUE,
    invoiceType: 'regular',
    seller: { nip: '1234567890', name: 'Firma testowa' },
    buyer: { nip: '5252241585', name: 'Klient Sp. z o.o.' },
    lines: [{ position: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 100, vatRate: '23', netAmount: 100 }],
    totals: { netTotal: 100, vatTotal: 23, grossTotal: 123 },
    ksefAnnotations: {},
    ...(markers ? { ksefMarkers: markers } : {}),
    ...over,
  } as ParsedInvoice;
}

/** Ta sama faktura tak, jak czytają ją generatory po zapisie z importu (`data-fetcher`). */
function jpkInvoice(inv: ParsedInvoice, saleDate: string | null): JpkInvoice {
  const type = mapParsedKindToFaVatType(inv.invoiceType);
  return {
    invoiceNumber: inv.invoiceNumber,
    invoiceType: 'regular',
    ...(type === 'VAT' ? {} : { importedDocumentType: type }),
    currency: 'PLN',
    importedFromKsef: true,
    ...(inv.ksefMarkers ? { ksefMarkers: inv.ksefMarkers } : {}),
    issueDate: inv.issueDate,
    ...(saleDate ? { saleDate } : {}),
    buyerNip: inv.buyer.nip,
    buyerName: inv.buyer.name,
    netTotal: inv.totals.netTotal,
    vatTotal: inv.totals.vatTotal,
    grossTotal: inv.totals.grossTotal,
    lines: inv.lines.map((l) => ({ position: l.position, name: l.name, unit: l.unit, quantity: l.quantity, unitPriceNet: l.unitPriceNet, netAmount: l.netAmount, vatRate: l.vatRate })),
  } as JpkInvoice;
}

const throws = (f: () => unknown): boolean => {
  try {
    f();
    return false;
  } catch {
    return true;
  }
};

interface Scenariusz {
  nazwa: string;
  inv: ParsedInvoice;
}

const SCENARIUSZE: Scenariusz[] = [
  { nazwa: 'poprawne GTU (GTU_12)', inv: parsed({}, { gtu: ['GTU_12'] }) },
  { nazwa: 'kilka poprawnych GTU', inv: parsed({}, { gtu: ['GTU_01', 'GTU_12'] }) },
  { nazwa: 'kod GTU spoza listy', inv: parsed({}, { gtu: ['GTU_99'] }) },
  { nazwa: 'poprawne GTU i kod spoza listy', inv: parsed({}, { gtu: ['GTU_12', 'GTU_99'] }) },
  { nazwa: 'FP, paragon z wcześniejszego miesiąca', inv: parsed({ saleDate: '2026-10-20' }, { fp: true }) },
  { nazwa: 'FP, paragon z miesiąca wystawienia', inv: parsed({ saleDate: '2026-11-02' }, { fp: true }) },
  { nazwa: 'FP bez daty sprzedaży (jak data wystawienia)', inv: parsed({}, { fp: true }) },
  { nazwa: 'FP i poprawne GTU, paragon z wcześniejszego miesiąca', inv: parsed({ saleDate: '2026-10-20' }, { fp: true, gtu: ['GTU_12'] }) },
  { nazwa: 'TP', inv: parsed({}, { tp: true }) },
  { nazwa: 'procedura w pozycjach', inv: parsed({}, { procedures: ['TT_D'] }) },
  { nazwa: 'FP i TP', inv: parsed({ saleDate: '2026-10-20' }, { fp: true, tp: true }) },
  { nazwa: 'GTU i TP', inv: parsed({}, { gtu: ['GTU_12'], tp: true }) },
  { nazwa: 'sama stawka oo (JPK_V7M odmawia, JPK_FA powstaje)', inv: parsed(OO) },
  { nazwa: 'stawka oo obok stawki 23 (JPK_V7M odmawia)', inv: parsed({ lines: [
    { position: 1, name: 'A', unit: 'szt.', quantity: 1, unitPriceNet: 50, vatRate: '23', netAmount: 50 },
    { position: 2, name: 'B', unit: 'szt.', quantity: 1, unitPriceNet: 50, vatRate: 'oo', netAmount: 50 },
  ], totals: { netTotal: 100, vatTotal: 11.5, grossTotal: 111.5 } }) },
  { nazwa: 'stawka oo z poprawnym GTU (JPK_V7M odmawia stawki oo)', inv: parsed(OO, { gtu: ['GTU_12'] }) },
  { nazwa: 'stawka oo z FP, paragon z wcześniejszego miesiąca', inv: parsed({ ...OO, saleDate: '2026-10-20' }, { fp: true }) },
  { nazwa: 'FP z poprawnym GTU i różnymi datami sprzedaży pozycji', inv: parsed({ lines: [
    { position: 1, name: 'A', unit: 'szt.', quantity: 1, unitPriceNet: 50, vatRate: '23', netAmount: 50, saleDate: '2026-10-02' },
    { position: 2, name: 'B', unit: 'szt.', quantity: 1, unitPriceNet: 50, vatRate: '23', netAmount: 50, saleDate: '2026-10-03' },
  ] }, { fp: true, gtu: ['GTU_12'] }) },
  { nazwa: 'zaimportowana korekta z GTU', inv: parsed({ invoiceType: 'correction' }, { gtu: ['GTU_12'] }) },
];

describe('ostrzeżenie importu: GTU i FP mówią to, co robią generatory', () => {
  it.each(SCENARIUSZE)('$nazwa: tekst nazywa fakturę i dokładnie ten plik, którego generator nie zrobi', ({ inv }) => {
    const { content, amounts } = importedInvoiceContent(inv);
    const jpk = jpkInvoice(inv, content.saleDate);
    const faOdmawia = throws(() => amountsOf(jpk));
    const v7mOdmawia = throws(() => summarizeJpkV7m({ issuedInvoices: [jpk], expenses: [] }));
    const tekst = heldDocumentWarning(inv, inv.invoiceNumber, undefined, 'outgoing', 'accepted', content, amounts);

    if (!faOdmawia && !v7mOdmawia) {
      expect(tekst).toBeNull();
      return;
    }
    expect(tekst, 'brak ostrzeżenia mimo odmowy generatora').not.toBeNull();
    expect(tekst).toContain(NUMBER);
    const okres = '2026-11';
    // Tekst nie obiecuje plików, których nie sprawdza: bez „działają” (CSV odmawia FP, JPK_V7M odmawia stawki oo).
    expect(tekst).not.toMatch(/działa/);
    if (faOdmawia && v7mOdmawia) {
      expect(tekst).toContain(`JPK_FA i JPK_V7M za ${okres} nie powstaną`);
    } else if (faOdmawia) {
      expect(tekst).toContain(`JPK_FA za ${okres} nie powstanie`);
      expect(tekst, 'JPK_V7M powstaje, tekst nie może mówić inaczej').not.toMatch(/JPK_V7M[^.]*nie powst/);
      expect(tekst).not.toContain('JPK_FA i JPK_V7M');
    } else {
      expect(tekst).toContain(`JPK_V7M za ${okres} nie powstanie`);
      expect(tekst).not.toMatch(/JPK_FA[^.]*nie powst/);
    }
  });

  it('sama stawka oo: JPK_V7M odmawia, JPK_FA powstaje (generatory), a ostrzeżenie nazywa tylko JPK_V7M i fakturę', () => {
    const inv = parsed(OO);
    const { content, amounts } = importedInvoiceContent(inv);
    const jpk = jpkInvoice(inv, content.saleDate);
    expect(throws(() => summarizeJpkV7m({ issuedInvoices: [jpk], expenses: [] }))).toBe(true);
    expect(throws(() => amountsOf(jpk))).toBe(false);
    const tekst = heldDocumentWarning(inv, inv.invoiceNumber, undefined, 'outgoing', 'accepted', content, amounts);
    expect(tekst).toContain(NUMBER);
    expect(tekst).toContain('JPK_V7M za 2026-11 nie powstanie');
    expect(tekst).not.toContain('JPK_FA');
  });

  it('stawka oo na dokumencie, który nie jest sprzedażą przyjętą w KSeF (odebrany, szkic): bez ostrzeżenia, jak dotąd', () => {
    const inv = parsed(OO);
    const { content, amounts } = importedInvoiceContent(inv);
    expect(heldDocumentWarning(inv, NUMBER, undefined, 'incoming', 'accepted', content, amounts)).toBeNull();
    expect(heldDocumentWarning(inv, NUMBER, undefined, 'outgoing', 'draft', content, amounts)).toBeNull();
  });

  it('ostrzeżenia o stawce spoza FaktWay i o rodzaju dokumentu bez długich myślników (każde zdanie z tych powodów)', () => {
    const nieznana = parsed({ lines: [{ position: 1, name: 'U', unit: 'szt.', quantity: 1, unitPriceNet: 100, vatRate: '17', netAmount: 100 }] });
    const korekta = parsed({ invoiceType: 'correction' });
    const przypadki: Array<[string, ParsedInvoice, 'outgoing' | 'incoming', string]> = [
      ['sprzedaż przyjęta, stawka spoza FaktWay', nieznana, 'outgoing', 'accepted'],
      ['szkic, stawka spoza FaktWay', nieznana, 'outgoing', 'draft'],
      ['zakup przyjęty, stawka spoza FaktWay', nieznana, 'incoming', 'accepted'],
      ['sprzedaż przyjęta, korekta', korekta, 'outgoing', 'accepted'],
    ];
    for (const [opis, inv, kierunek, status] of przypadki) {
      const { content, amounts } = importedInvoiceContent(inv);
      const tekst = heldDocumentWarning(inv, inv.invoiceNumber, undefined, kierunek, status, content, amounts);
      expect(tekst, opis).not.toBeNull();
      expect(tekst, opis).not.toMatch(/—|–/);
    }
  });

  it('FP z nieczytelnymi datami sprzedaży: tekst nie przypisuje paragonowi miesiąca wystawienia', () => {
    const inv = SCENARIUSZE.find((s) => s.nazwa.startsWith('FP z poprawnym GTU i różnymi'))!.inv;
    const { content, amounts } = importedInvoiceContent(inv);
    const tekst = heldDocumentWarning(inv, inv.invoiceNumber, undefined, 'outgoing', 'accepted', content, amounts) ?? '';
    expect(tekst).not.toContain('z paragonem z miesiąca wystawienia');
  });

  it('poprawne GTU: JPK_V7M powstaje (generator), JPK_FA nie (generator): zgodnie z tym tekst', () => {
    const inv = parsed({}, { gtu: ['GTU_12'] });
    const jpk = jpkInvoice(inv, importedInvoiceContent(inv).content.saleDate);
    expect(throws(() => summarizeJpkV7m({ issuedInvoices: [jpk], expenses: [] }))).toBe(false);
    expect(throws(() => amountsOf(jpk))).toBe(true);
  });

  it('teksty bez długich myślników tam, gdzie dotyczą GTU i FP', () => {
    for (const { inv } of SCENARIUSZE.filter((s) => !s.inv.ksefMarkers?.tp && !s.inv.ksefMarkers?.procedures && s.inv.invoiceType === 'regular')) {
      const { content, amounts } = importedInvoiceContent(inv);
      const tekst = heldDocumentWarning(inv, inv.invoiceNumber, undefined, 'outgoing', 'accepted', content, amounts) ?? '';
      expect(tekst).not.toMatch(/—|–/);
    }
  });
});
