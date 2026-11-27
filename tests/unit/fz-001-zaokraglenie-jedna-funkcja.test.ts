import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { doZlotych } from '@/lib/ksiegowosc/pit';
import { doPelnychZlotych } from '@/lib/ksiegowosc/ryczalt';

/**
 * FZ-001: jedna funkcja zaokrąglenia do pełnych złotych (art. 63 § 1 Ordynacji
 * podatkowej, RP-ZAOKR-01): połówka od zera także dla kwot ujemnych, bez -0.
 */
describe('FZ-001: zaokrąglenie do pełnych złotych', () => {
  it.each([[-150, -200], [-250, -300], [-149, -100], [-50, -100], [-49, 0], [-30, 0], [0, 0], [50, 100], [149, 100], [150, 200]])(
    '%s gr daje %s gr w obu funkcjach',
    (gr, wynik) => {
      expect(doZlotych(gr)).toBe(wynik);
      expect(doPelnychZlotych(gr)).toBe(wynik);
    },
  );

  it('każda kwota: obie funkcje dają ten sam wynik i nigdy -0', () => {
    fc.assert(
      fc.property(fc.integer({ min: -100_000_000, max: 100_000_000 }), (gr) => {
        expect(doPelnychZlotych(gr)).toBe(doZlotych(gr));
        expect(Object.is(doZlotych(gr), -0)).toBe(false);
      }),
    );
  });
});
