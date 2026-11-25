import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { generateJpkFa, type JpkInvoice } from '@/lib/exports/jpk-fa-generator';
import { settlementRoundingRefusal, settlementVatSummaries, type AdvanceInvoiceSettlementRow } from '@/lib/ksef/fa3-advance-generator';
import type { InvoiceLineItem, VatRate } from '@/types/invoice';

/**
 * Osobne ustalenie 19 (decyzja D8 poprawiona 25.11.2026, RP-FA-ROZ-01, art. 106f
 * ust. 3 ustawy o VAT): ujemne P_13_x albo P_14_x w fakturze rozliczającej są
 * dozwolone, gdy wynikają z zaokrągleń. Granica w każdej stawce, osobno dla
 * netto i VAT: B = ⌊(n + 3m) / 2⌋ grosza, gdzie n to pozycje zamówienia w stawce
 * (VAT od pozycji, D1: pół grosza na pozycję), a m to faktury zaliczkowe
 * w stawce (pół grosza zaokrąglenia i grosz odchyłki rozbicia od wzoru,
 * NZ-FA-05). Przekroczenie znaczy, że któraś zaliczka ma VAT inny niż wzór
 * z art. 106f ust. 1 pkt 3 o 2 grosze albo więcej: odmowa wymienia ją z obiema
 * kwotami, a wyjściem jest faktura korygująca do niej (art. 106j ust. 1 pkt 5).
 * Odmowa tylko przy zapisie nowej faktury rozliczającej i przed wysyłką;
 * JPK_FA i plik już wysłanej faktury raportują ją taką, jaka jest.
 */

const pozycja = (ordinal: number, net: number, vatRate: VatRate, vat: number): InvoiceLineItem => ({
  ordinal, name: `Pozycja ${ordinal}`, unit: 'szt.', quantity: 1, unitPriceNet: net, vatRate,
  netAmount: net, vatAmount: vat, grossAmount: Math.round((net + vat) * 100) / 100,
});
const zaliczka = (o: Partial<AdvanceInvoiceSettlementRow>): AdvanceInvoiceSettlementRow => ({
  internal_number: 'ZAL/1', ksef_number: null, advance_amount: 0, issue_date: '2026-11-02', ...o,
});
/** Zamówienie 1 × 1,00 zł przy 23 % i jedna zaliczka 1,23 zł z danym rozbiciem (wzór: 1,00 + 0,23). */
const jednaZaliczka = (net: number, vat: number) =>
  settlementRoundingRefusal([pozycja(1, 1, '23', 0.23)], [zaliczka({ internal_number: 'ZAL/7/2026', advance_amount: 1.23, vat_rate: '23', net_amount: net, vat_amount: vat })]);

describe('ustalenie 19: granica ujemnej reszty ROZ (D8)', () => {
  it('zaokrąglenia ze wzoru i w granicy przechodzą: dwie zaliczki (VAT -0,01), 10 pozycji (netto -0,05), rozbicie o grosz od wzoru z #898 (netto -0,02), VAT zaliczki proporcjonalny z innego programu', () => {
    // 5 %: netto 0,61, VAT 0,03; zaliczki 2 × 0,32 ze wzoru (0,30 + 0,02). B = ⌊(1 + 6) / 2⌋ = 3.
    expect(settlementRoundingRefusal([pozycja(1, 0.61, '5', 0.03)], [
      zaliczka({ internal_number: 'ZAL/1', advance_amount: 0.32, vat_rate: '5' }),
      zaliczka({ internal_number: 'ZAL/2', advance_amount: 0.32, vat_rate: '5' }),
    ])).toBeNull();
    // 10 × netto 0,10 przy 5 %, zaliczka 1,10 ze wzoru (1,05 + 0,05): netto -0,05, B = ⌊(10 + 3) / 2⌋ = 6.
    const dziesiec = Array.from({ length: 10 }, (_, i) => pozycja(i + 1, 0.1, '5', 0.01));
    expect(settlementVatSummaries(dziesiec, [zaliczka({ advance_amount: 1.1, vat_rate: '5' })])).toEqual([expect.objectContaining({ netSum: -0.05, vatSum: 0.05 })]);
    expect(settlementRoundingRefusal(dziesiec, [zaliczka({ advance_amount: 1.1, vat_rate: '5' })])).toBeNull();
    // #898 (FZ-029): 1,00 przy 23 % i dwie zaliczki 0,61 z rozbiciem 0,51 + 0,10 (wzór 0,50 + 0,11): netto -0,02, B = 3.
    expect(settlementRoundingRefusal([pozycja(1, 1, '23', 0.23)], [1, 2].map((i) =>
      zaliczka({ internal_number: `ZAL/23/${i}`, advance_amount: 0.61, vat_rate: '23', net_amount: 0.51, vat_amount: 0.1 }),
    ))).toBeNull();
    // Inny program liczy VAT zaliczki proporcjonalnie do VAT zamówienia: 10 × 0,10 przy 5 %, zaliczka 1,10 z VAT 0,10, reszta 0.
    expect(settlementRoundingRefusal(dziesiec, [zaliczka({ advance_amount: 1.1, vat_rate: '5', net_amount: 1, vat_amount: 0.1 })])).toBeNull();
  });

  it('przypadek z decyzji: zaliczka 1,23 zł z rozbiciem 1,03 + 0,20, netto reszty -0,03 przy B = 2: odmowa z numerem, obiema kwotami VAT i wyjściem', () => {
    const odmowa = jednaZaliczka(1.03, 0.2);
    expect(odmowa).toMatch(/^Faktury rozliczającej nie wystawimy z tymi zaliczkami: w stawce 23% reszta netto wychodzi -0,03 zł, a zaokrąglenia zaliczek i pozycji dają najwyżej -0,02 zł\./);
    expect(odmowa).toContain('Faktura zaliczkowa ZAL/7/2026 ma VAT 0,20 zł, a ze wzoru z art. 106f ust. 1 pkt 3 ustawy o VAT wychodzi 0,23 zł.');
    expect(odmowa).toContain('Wystaw fakturę korygującą do tej faktury zaliczkowej (art. 106j ust. 1 pkt 5) tam, gdzie ją wystawiono, a potem fakturę rozliczającą.');
    expect(odmowa).not.toMatch(/[—–]/);
  });

  it('granica przy n = 1 i m = 1 (B = 2): -0,02 przechodzi, -0,03 to odmowa, po stronie netto i VAT', () => {
    expect(jednaZaliczka(1.02, 0.21)).toBeNull();
    expect(jednaZaliczka(0.98, 0.25)).toBeNull();
    expect(jednaZaliczka(0.97, 0.26)).toMatch(/reszta VAT wychodzi -0,03 zł.*ZAL\/7\/2026 ma VAT 0,26 zł, a ze wzoru .* 0,23 zł/);
  });

  it('kilka zaliczek spoza wzoru: odmowa wymienia każdą z obiema kwotami, a zaliczek w granicy nie', () => {
    const odmowa = settlementRoundingRefusal([pozycja(1, 3, '23', 0.69)], [
      zaliczka({ internal_number: 'ZAL/1', advance_amount: 1.23, vat_rate: '23', net_amount: 1.03, vat_amount: 0.2 }),
      zaliczka({ internal_number: 'ZAL/2', advance_amount: 1.23, vat_rate: '23', net_amount: 1.03, vat_amount: 0.2 }),
      zaliczka({ internal_number: 'ZAL/3', advance_amount: 1.23, vat_rate: '23', net_amount: 1.01, vat_amount: 0.22 }),
    ]);
    expect(odmowa).toContain('Faktury zaliczkowe ZAL/1 (VAT 0,20 zł, ze wzoru 0,23 zł), ZAL/2 (VAT 0,20 zł, ze wzoru 0,23 zł) mają VAT inny niż wzór');
    expect(odmowa).not.toContain('ZAL/3');
    expect(odmowa).toContain('Wystaw faktury korygujące do tych faktur zaliczkowych');
  });

  it('JPK_FA z taką fakturą rozliczającą: plik powstaje, reszta taka, jaka jest (bez odmowy)', () => {
    const fa: JpkInvoice = {
      invoiceNumber: 'ROZ/3/2026', currency: 'PLN', invoiceType: 'final', issueDate: '2026-11-20', buyerName: 'Klient Sp. z o.o.',
      buyerNip: '1234567890', buyerAddress: 'ul. Klienta 10, 02-001 Warszawa', netTotal: 1, vatTotal: 0.23, grossTotal: 1.23,
      lines: [{ position: 1, name: 'Strona WWW', unit: 'szt.', quantity: 1, unitPriceNet: 1, netAmount: 1, vatRate: '23', vatAmount: 0.23 }],
      advanceSettlement: [{ internal_number: 'ZAL/7/2026', advance_amount: 1.23, issue_date: '2026-11-02', vat_rate: '23', net_amount: 1.03, vat_amount: 0.2 }],
    } as JpkInvoice;
    const xml = generateJpkFa({
      issuer: {
        nip: '1234567890', name: 'ACME sp. z o.o.', taxOfficeCode: '1433',
        registeredAddress: { voivodeship: 'MAZOWIECKIE', county: 'Warszawa', commune: 'Mokotów', street: 'ul. Puławska', buildingNumber: '12', city: 'Warszawa', postCode: '02-566' },
      },
      periodStart: '2026-11-01', periodEnd: '2026-11-30', generatedAt: new Date('2026-12-01T08:00:00Z'),
      issuedInvoices: [fa],
    });
    expect(xml).toContain('ROZ/3/2026');
  });

  it('wysyłka: ostatnia bramka w submitInvoiceFullFlow po hamulcu ROZ, przed budową pliku (szkic zapisany przed bramką)', () => {
    const kod = readFileSync(join(process.cwd(), 'lib/ksef/submit-invoice-full.ts'), 'utf8');
    const hamulec = kod.indexOf('throw new InvoiceValidationError([ROZ_SUBMISSION_HOLD_MESSAGE]);');
    const bramka = kod.indexOf('finalInvoiceRoundingRefusal(finalPayload.finalData, finalPayload.advanceSettlementRows)');
    const plik = kod.indexOf('generateFinalInvoiceXml(finalPayload.finalData');
    expect(hamulec).toBeGreaterThan(0);
    expect(bramka).toBeGreaterThan(hamulec);
    expect(plik).toBeGreaterThan(bramka);
  });
});
