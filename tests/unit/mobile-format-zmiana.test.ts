import { describe, expect, it } from 'vitest';

import { formatPlPercentChange } from '@/lib/format/pl';

import { zmiana, zmianaPelna } from '../../mobile/src/lib/format';

/**
 * Obchód w symulatorze 20.11.2026 (U12): Pulpit, Przepływy, Miesięcznie,
 * kafel „Koszty w tym miesiącu” pokazywał „+65.65040650406505% wobec
 * poprzedniego miesiąca”, bo `zmiana` wstawiała surowy procent z serwera
 * (`lib/dashboard/cash-movements.ts`: `((amount - prevAmount) / prevAmount) * 100`).
 * Liczba była poprawna (407,50 zł wobec 246,00 zł), zły był zapis: pełny
 * ułamek i kropka. Strona zaokrągla do całych procent (`formatPlPercentChange`,
 * plan Finora §7.1), telefon ma pokazywać to samo.
 *
 * Minus jest typograficzny (U+2212) jak na stronie, to nie myślnik.
 */
const MINUS = '−';

describe('zmiana: procent zmiany na telefonie w pełnych procentach, po polsku', () => {
  it('błąd z obchodu U12: koszty 407,50 zł wobec 246,00 zł to „+66%”, nie „+65.65040650406505%”', () => {
    const pct = ((40_750 - 24_600) / 24_600) * 100;
    expect(pct).toBe(65.65040650406505);
    expect(zmiana(pct)).toBe('+66%');
  });

  it('nie ma kropki ani przecinka ułamka, tylko znak i całe procenty', () => {
    for (const pct of [65.65040650406505, 0.5, 12.34, 99.999, 1234.5678, -3.3333, -65.65040650406505]) {
      expect(zmiana(pct), String(pct)).toMatch(new RegExp(`^[+${MINUS}]\\d+%$`));
    }
  });

  it('wzrost ma plus, spadek minus typograficzny (jak strona), zaokrąglenie do najbliższego procenta', () => {
    expect(zmiana(2)).toBe('+2%');
    expect(zmiana(12.4)).toBe('+12%');
    expect(zmiana(12.6)).toBe('+13%');
    expect(zmiana(-6)).toBe(`${MINUS}6%`);
    expect(zmiana(-8.4)).toBe(`${MINUS}8%`);
    expect(zmiana(-65.65040650406505)).toBe(`${MINUS}66%`);
  });

  it('zero i wartości, które po zaokrągleniu są zerem, to „0%”: bez plusa i bez „−0%”', () => {
    expect(zmiana(0)).toBe('0%');
    expect(zmiana(-0)).toBe('0%');
    expect(zmiana(0.3)).toBe('0%');
    expect(zmiana(0.49)).toBe('0%');
    expect(zmiana(-0.3)).toBe('0%');
    expect(zmiana(-0.4999)).toBe('0%');
    expect(zmiana(1e-9)).toBe('0%');
    expect(zmiana(-1e-9)).toBe('0%');
  });

  it('brak liczby (null, undefined, NaN, nieskończoność) nie daje „NaN%”, „Infinity%” ani „null%”', () => {
    for (const brak of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const tekst = zmiana(brak);
      expect(tekst, String(brak)).toBe('b.d.');
      expect(tekst).not.toMatch(/NaN|Infinity|null|undefined/);
      expect(tekst).not.toContain('%');
    }
  });

  it('telefon zapisuje zmianę tak samo jak strona (formatPlPercentChange) dla każdej wartości skończonej', () => {
    const wartosci: number[] = [];
    for (let pct = -150; pct <= 150; pct += 0.05) wartosci.push(Math.round(pct * 100) / 100);
    wartosci.push(65.65040650406505, -65.65040650406505, 0.5, -0.5, 2.5, -2.5, 99.5, -99.5, 1234.5);
    for (const pct of wartosci) expect(zmiana(pct), String(pct)).toBe(formatPlPercentChange(pct));
  });
});

describe('zmianaPelna: ta sama liczba, którą zapis pokazuje (do koloru i strzałki)', () => {
  it('zwraca całe procenty jak zapis, a dla zera, „−0” i braku liczby zero', () => {
    expect(zmianaPelna(65.65040650406505)).toBe(66);
    expect(zmianaPelna(-65.65040650406505)).toBe(-66);
    expect(zmianaPelna(0.4)).toBe(0);
    expect(Object.is(zmianaPelna(-0.4), 0)).toBe(true);
    expect(Object.is(zmianaPelna(-0), 0)).toBe(true);
    expect(zmianaPelna(Number.NaN)).toBe(0);
    expect(zmianaPelna(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('znak zmianaPelna zgadza się ze znakiem w zapisie „zmiana”', () => {
    for (const pct of [-66.4, -0.6, -0.4, 0, 0.4, 0.6, 65.65040650406505]) {
      const tekst = zmiana(pct);
      const znak = Math.sign(zmianaPelna(pct));
      expect(znak === 1 ? tekst.startsWith('+') : znak === -1 ? tekst.startsWith(MINUS) : tekst === '0%', String(pct)).toBe(true);
    }
  });
});
