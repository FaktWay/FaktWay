import { describe, expect, it } from 'vitest';

import { doWartosciFormularza } from '@/lib/api/mobile/schematy';
import { buildInvoiceFromForm } from '@/lib/invoices/build-from-form';
import { parseRegularInvoiceForm } from '@/lib/invoices/issue-regular';
import { calculateLineItem, toGrosze } from '@/lib/xml/invoice-calculator';
import type { VatRate } from '@/types/invoice';

import {
  doFakturyTelefonu,
  kwotyPozycji,
  liczbaZPola,
  type FormularzZwyklej,
  type PozycjaFormularza,
} from '../../mobile/src/lib/faktura/wystawienie';

/**
 * Nocny zespół, TEL-01: podgląd kwot zwykłej faktury VAT na telefonie
 * (`kwotyPozycji`, sumy i kwota na przycisku w `faktury/nowa/[rodzaj].tsx`)
 * ma dawać te same grosze co serwer, który wystawia fakturę z ilości i ceny
 * z formularza (`calculateLineItem`: netto = ilość × cena i VAT = netto ×
 * stawka, każde do grosza z połówką w górę, art. 106e ust. 11 ustawy o VAT,
 * liczone na liczbach całkowitych od #842 i #881). Telefon liczył oba kroki
 * na liczbach zmiennoprzecinkowych, więc część połówek grosza schodziła w dół:
 * 5 % od 80,30 zł dawało 4,01 zamiast 4,02, 23 % od 35,50 zł 8,16 zamiast
 * 8,17, a 2,5 × 3,33 zł 8,32 zamiast 8,33. Klient widział na telefonie inną
 * kwotę niż na wystawionej fakturze.
 */

const pozycja = (ilosc: string, cena: string, stawka: string): PozycjaFormularza => ({
  nazwa: 'Usługa',
  ilosc,
  jednostka: 'szt',
  cena,
  stawka,
});

/** Kwoty pozycji tak, jak policzy je serwer z treści żądania telefonu (ilość i cena jako liczby). */
function serwer(p: PozycjaFormularza): { netto: number; vat: number; brutto: number } {
  const wynik = calculateLineItem({
    quantity: liczbaZPola(p.ilosc),
    unitPriceNet: liczbaZPola(p.cena),
    vatRate: p.stawka as VatRate,
  });
  return { netto: toGrosze(wynik.netAmount), vat: toGrosze(wynik.vatAmount), brutto: toGrosze(wynik.grossAmount) };
}

const formularz = (pozycje: PozycjaFormularza[]): FormularzZwyklej => ({
  numer: 'FV/1/11/2026',
  dataWystawienia: '2026-11-24',
  dataSprzedazy: '2026-11-24',
  terminDni: 14,
  // Osoba bez numeru: schemat strony sprawdza sumę kontrolną NIP, a test nie używa prawdziwych NIP-ów.
  rodzajNabywcy: 'osoba',
  nip: '',
  nazwa: 'Klient Testowy',
  adres1: 'ul. Testowa 1',
  adres2: '00-001 Warszawa',
  email: '',
  metoda: 'Przelew',
  rachunek: 'PL61 1090 1014 0000 0712 1981 2874',
  mpp: false,
  pozycje,
  uwagi: '',
});

describe('TEL-01: podgląd kwot pozycji na telefonie jak na serwerze', () => {
  it.each([
    // [ilość, cena, stawka, netto, VAT, brutto] w groszach
    ['1', '80,30', '5', 8030, 402, 8432],
    ['1', '35,50', '23', 3550, 817, 4367],
    ['1', '42,70', '5', 4270, 214, 4484],
    ['1', '1114,50', '23', 111450, 25634, 137084],
    ['2,5', '3,33', '23', 833, 192, 1025],
    ['1', '0,10', '5', 10, 1, 11],
  ])('%s × %s zł, stawka %s: netto %i gr, VAT %i gr, brutto %i gr', (ilosc, cena, stawka, netto, vat, brutto) => {
    const p = pozycja(ilosc, cena, stawka);
    expect(serwer(p)).toEqual({ netto, vat, brutto });
    expect(kwotyPozycji(p)).toEqual({ netto, vat, brutto });
  });

  it('sumy telefonu równe kwotom faktury, którą serwer wystawi z tej samej treści żądania', () => {
    const pozycje = [pozycja('1', '80,30', '5'), pozycja('1', '35,50', '23'), pozycja('2,5', '3,33', '23'), pozycja('1', '500', 'zw')];
    const parsed = parseRegularInvoiceForm(doWartosciFormularza(doFakturyTelefonu(formularz(pozycje))));
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    const faktura = buildInvoiceFromForm(
      parsed.values,
      { id: '00000000-0000-4000-8000-000000000001', nip: '1234567890', name: 'Firma Testowa', address: null },
      null,
      false,
    );
    const telefon = pozycje.map(kwotyPozycji);
    expect(telefon).toEqual(
      faktura.lines.map((l) => ({ netto: toGrosze(l.netAmount), vat: toGrosze(l.vatAmount), brutto: toGrosze(l.grossAmount) })),
    );
    const suma = (k: 'netto' | 'vat' | 'brutto') => telefon.reduce((s, t) => s + t[k], 0);
    expect({ netto: suma('netto'), vat: suma('vat'), brutto: suma('brutto') }).toEqual({
      netto: toGrosze(faktura.netTotal),
      vat: toGrosze(faktura.vatTotal),
      brutto: toGrosze(faktura.grossTotal),
    });
  });

  it('niezmiennik: każda cena od 0,01 do 200,00 zł przy ilości 1 i stawkach 23, 8, 5 i 0 %', () => {
    const rozne: string[] = [];
    for (const stawka of ['23', '8', '5', '0']) {
      for (let gr = 1; gr <= 20000; gr += 1) {
        const cena = `${Math.floor(gr / 100)},${String(gr % 100).padStart(2, '0')}`;
        const p = pozycja('1', cena, stawka);
        const t = kwotyPozycji(p);
        const s = serwer(p);
        if (t.netto !== s.netto || t.vat !== s.vat || t.brutto !== s.brutto) rozne.push(`${cena} zł ${stawka}%: ${t.vat} wobec ${s.vat}`);
      }
    }
    expect(rozne.slice(0, 5), `${rozne.length} pozycji różni się od serwera`).toEqual([]);
  });

  it('niezmiennik: ilość ułamkowa razy cena z groszami albo z czterema miejscami', () => {
    const rozne: string[] = [];
    const ilosci = ['0,5', '1,5', '2,5', '3', '0,333', '12,75', '1 000'];
    const ceny: string[] = [];
    for (let gr = 1; gr <= 50000; gr += 37) ceny.push(`${Math.floor(gr / 100)},${String(gr % 100).padStart(2, '0')}`);
    ceny.push('1 200,1234', '26,8333', '0,0050', '19,9999', '3,3333');
    for (const ilosc of ilosci) {
      for (const cena of ceny) {
        for (const stawka of ['23', '8', '5']) {
          const p = pozycja(ilosc, cena, stawka);
          const t = kwotyPozycji(p);
          const s = serwer(p);
          if (t.netto !== s.netto || t.vat !== s.vat || t.brutto !== s.brutto) {
            rozne.push(`${ilosc} × ${cena} zł ${stawka}%: ${JSON.stringify(t)} wobec ${JSON.stringify(s)}`);
          }
        }
      }
    }
    expect(rozne.slice(0, 5), `${rozne.length} pozycji różni się od serwera`).toEqual([]);
  });

  it('stawka bez procentu (zw, np, oo) bez VAT, a pole puste albo błędne liczy się jako 0', () => {
    for (const stawka of ['zw', 'np', 'oo']) {
      expect(kwotyPozycji(pozycja('1', '80,30', stawka))).toEqual({ netto: 8030, vat: 0, brutto: 8030 });
    }
    expect(kwotyPozycji(pozycja('', '80,30', '23'))).toEqual({ netto: 0, vat: 0, brutto: 0 });
    expect(kwotyPozycji(pozycja('1', 'abc', '23'))).toEqual({ netto: 0, vat: 0, brutto: 0 });
  });
});
