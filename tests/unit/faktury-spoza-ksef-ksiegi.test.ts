import { describe, expect, it } from 'vitest';

import { generateJpkV7m } from '@/lib/exports/jpk-v7m-generator';
import { validateJpkV7m } from '@/lib/exports/jpk-v7m-validator';
import type { JpkInvoice } from '@/lib/exports/jpk-fa-generator';
import type { FakturaEwidencji } from '@/lib/ksiegowosc/ewidencja';
import { generujJpkPkpir } from '@/lib/ksiegowosc/jpk-pkpir';
import { wierszeKpirOkresu, zbudujKpir } from '@/lib/ksiegowosc/kpir';
import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';

/**
 * Krok 1.6, część 2b, PR B: faktura dopisana spoza KSeF (bez numeru KSeF)
 * w księgach. D20: KPiR ma numer faktury w kolumnie 4 (K_3A pliku), kolumna 3
 * (numer KSeF, K_3B) zostaje pusta, bez dodatkowej adnotacji. D19: JPK_V7M
 * oznacza wiersz BFK, nie NrKSeF ani OFF; GTU wiersza trafia do pliku.
 */

const SKALA: WersjaProfilu = {
  id: 'p1', validFrom: '2026-01-01', forma: 'skala', stawkaDomyslna: null, zusEtap: 'pelny', zusOd: null, chorobowe: true, nrsZus: null, najem: false,
};

const SPOZA: FakturaEwidencji = {
  id: 'f1', numer: 'FV/12/2026', dataWystawienia: '2026-03-10', dataSprzedazy: '2026-03-10', rodzaj: 'zwykla', nettoGr: 10_000, waluta: 'PLN',
  numerKsef: null, fp: false,
  kontrahent: { kraj: 'PL', identyfikator: '5252241585', nazwa: 'Klient Sp. z o.o.', adres: 'ul. Prosta 1, 00-001 Warszawa' },
  rozliczoneZaliczkiGr: 0, pozycje: null,
};

describe('KPiR i JPK_PKPIR: faktura spoza KSeF (D20)', () => {
  it('numer faktury w kolumnie 4 (K_3A), numeru KSeF brak (K_3B), przychód w K_7', () => {
    const k = zbudujKpir({ rok: 2026, faktury: [SPOZA], koszty: [], wpisy: [], wersje: [SKALA], kursy: new Map() });
    expect(k.braki).toEqual([]);
    expect(k.wiersze[0]).toMatchObject({ dowod: 'FV/12/2026', numerKsef: null, kwoty: { k7: 10_000 } });
    const xml = generujJpkPkpir({
      od: '2026-03-01', do: '2026-03-31', celZlozenia: 0, kodUrzedu: '1433',
      podatnik: { nip: '5260001246', imie: 'Jan', nazwisko: 'Kowalski', dataUrodzenia: '1980-01-01' },
      wiersze: wierszeKpirOkresu(k, '2026-03-01', '2026-03-31'),
    });
    expect(xml).toContain('<K_3A>FV/12/2026</K_3A>');
    expect(xml).not.toContain('K_3B');
  });
});

describe('JPK_V7M: faktura spoza KSeF (D19)', () => {
  const faktura: JpkInvoice = {
    invoiceNumber: 'FV/12/2026', currency: 'PLN', invoiceType: 'regular', issueDate: '2026-03-10', buyerName: 'Klient Sp. z o.o.', buyerNip: '5252241585',
    netTotal: 100, vatTotal: 23, grossTotal: 123,
    lines: [{ position: 1, name: 'Telefon', unit: 'szt.', quantity: 1, unitPriceNet: 100, netAmount: 100, vatRate: '23', gtuCode: 'GTU_06' }],
  } as JpkInvoice;

  const dane = {
    issuer: { nip: '5260001246', name: 'Moja Firma Sp. z o.o.', email: 'biuro@example.test', taxOfficeCode: '1433' },
    periodStart: '2026-03-01', periodEnd: '2026-03-31', generatedAt: new Date('2026-04-10T10:00:00Z'),
    issuedInvoices: [faktura], expenses: [],
  };

  it('wiersz ma BFK (bez NrKSeF i OFF), GTU z pozycji, plik przechodzi XSD', async () => {
    const xml = generateJpkV7m(dane);
    expect(xml).toContain('<DowodSprzedazy>FV/12/2026</DowodSprzedazy>');
    expect(xml).toContain('<BFK>1</BFK>');
    expect(xml).toContain('<GTU_06>1</GTU_06>');
    expect(xml).not.toContain('<NrKSeF>');
    expect(xml).not.toContain('<OFF>');
    const wynik = await validateJpkV7m(xml);
    expect(wynik.errors).toEqual([]);
  });

  it('oznaczenie TP: JPK_V7M odmawia z wyjściem (generator nie wykazuje TP), zamiast je pominąć po cichu', () => {
    expect(() => generateJpkV7m({ ...dane, issuedInvoices: [{ ...faktura, ksefMarkers: { tp: true } } as JpkInvoice] })).toThrow(
      /JPK wstrzymany: faktura FV\/12\/2026 .*\(TP\).*poza FaktWay/,
    );
  });
});
