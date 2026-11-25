import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { wholeZloty } from '@/lib/exports/jpk-v7m-generator';

/**
 * FZ-002: `wholeZloty` (pełne złote części deklaracyjnej JPK_V7M, RP-ZAOKR-03)
 * dawał ujemne zero dla kwoty ujemnej poniżej 50 gr (np. korekta zakupu
 * -0,03 zł), bo `Math.sign(n) * 0` to -0. W pliku XML wychodzi „0”, ale -0
 * w `Intl.NumberFormat` to „-0,00 zł”.
 */
describe('FZ-002: pełne złote JPK_V7M bez ujemnego zera', () => {
  it.each([-0.03, -0.49, -0.004, -0])('%s zł daje zwykłe 0', (n) => {
    expect(Object.is(wholeZloty(n), 0)).toBe(true);
  });

  it('każda kwota: wynik nigdy nie jest ujemnym zerem, a połówka zaokrągla się od zera (art. 63 § 1 Ordynacji)', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 1_000_000 }), (gr) => {
        const wynik = wholeZloty(gr / 100);
        expect(Object.is(wynik, -0)).toBe(false);
        const pelne = Math.floor((Math.abs(gr) + 50) / 100);
        expect(wynik).toBe(gr < 0 ? -pelne || 0 : pelne);
      }),
    );
  });
});
