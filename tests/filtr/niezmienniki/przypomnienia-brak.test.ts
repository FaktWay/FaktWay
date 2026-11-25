import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { niezaplacone } from '@/lib/ksiegowosc/przypomnienia';
import type { PozycjaZeSkrotem, Rozliczenie } from '@/lib/ksiegowosc/ten-miesiac-dane';

import { profil } from '../generatory/ksiegowosc';
import { opcje } from '../generatory/ustawienia';

/**
 * FZ-030 (niezmiennik przypomnień): gdy bieżące dane dają dla pozycji brak,
 * przypomnienie nie podaje kwoty (żadnej liczby z zatwierdzonej wersji), a gdy
 * najnowsza wersja czeka na zapłatę albo nic nie jest zapłacone, przypomnienie
 * o tej pozycji wychodzi (bez kwoty), więc dopłata nie znika po cichu.
 * Dowolne wersje rozliczenia (kwoty, zapłata, skrót wejść) i szkic z brakiem.
 */

const RODZAJE = ['ryczalt', 'zus_spoleczne', 'zdrowotna'] as const;
type Rodzaj = (typeof RODZAJE)[number];

const wersjeArb = fc.array(
  fc.record({ kwotaGr: fc.integer({ min: 0, max: 300_000 }), zaplacona: fc.boolean(), skrot: fc.constantFrom('a', 'b') }),
  { maxLength: 3 },
);

const rozliczenia = (rodzaj: Rodzaj, wersje: { kwotaGr: number; zaplacona: boolean; skrot: string }[]): Rozliczenie[] =>
  wersje.map((v, i) => ({
    id: `${rodzaj}-${i + 1}`,
    miesiac: '2026-10',
    rodzaj,
    wersja: i + 1,
    kwotaGr: v.kwotaGr,
    termin: '2026-11-20',
    status: v.zaplacona ? 'zaplacone' : 'zatwierdzone',
    wejsciaHash: v.skrot.repeat(64),
    zatwierdzoneO: `2026-11-0${i + 1}T10:00:00Z`,
    zaplaconeO: v.zaplacona ? `2026-11-0${i + 2}` : null,
    spoleczneBezFpGr: 0,
    reczna: false,
  }));

describe('FZ-030: brak w szkicu pozycji w przypomnieniu o terminie', () => {
  it('brak nigdy nie daje kwoty, a niezapłacona najnowsza wersja albo brak zapłat nigdy nie daje ciszy', () => {
    fc.assert(
      fc.property(fc.constantFrom(...RODZAJE), wersjeArb, (rodzaj, wersje) => {
        const r = rozliczenia(rodzaj, wersje);
        const pozycje: PozycjaZeSkrotem[] = [{ ok: false, rodzaj, termin: null, brak: 'Ewidencja przychodów ma braki w miesiącach: październik 2026.' }];
        const wynik = niezaplacone({ grupy: rodzaj === 'ryczalt' ? ['ryczalt'] : ['zus'], rozliczenia: r, pozycje, profil: profil() }).filter((p) => p.rodzaj === rodzaj);
        expect(wynik.every((p) => p.kwotaGr === null), JSON.stringify(wersje)).toBe(true);
        const najnowsza = r.at(-1);
        const niczegoNieZaplacono = r.every((v) => v.status !== 'zaplacone' || v.kwotaGr === 0);
        if (niczegoNieZaplacono || (najnowsza && najnowsza.status !== 'zaplacone')) {
          expect(wynik, JSON.stringify(wersje)).toEqual([{ rodzaj, kwotaGr: null }]);
        }
      }),
      opcje(),
    );
  });
});

/**
 * D31 i D32 (FZ-030, `docs/koordynacja/DECYZJE-2026-11-25.md`): miesiąc, który się
 * nie liczy (`pozycje: null`), nigdy nie daje kwoty; przy braku w szkicu i najnowszej
 * zapłaconej wersji z kwotą przypomnienie wychodzi bez kwoty, gdy wersję wyliczył
 * moduł (może zostać dopłata), a cisza, gdy to zapłata spoza wyliczenia (`reczna`,
 * kwota z PUE ZUS).
 */
describe('D31 i D32: miesiąc bez kwot i zapłacona najnowsza wersja przy braku', () => {
  const zZaplacona = (rodzaj: Rodzaj, wersje: { kwotaGr: number; zaplacona: boolean; skrot: string }[], kwotaGr: number, reczna: boolean): Rozliczenie[] => {
    const r = rozliczenia(rodzaj, [...wersje, { kwotaGr, zaplacona: true, skrot: 'a' }]);
    return r.map((v, i) => (i === r.length - 1 ? { ...v, reczna } : v));
  };
  const grupy = (rodzaj: Rodzaj) => (rodzaj === 'ryczalt' ? (['ryczalt'] as const) : (['zus'] as const));

  it('D31: miesiąc, który się nie liczy, nigdy nie daje kwoty (dowolne wersje i zapłaty)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...RODZAJE), wersjeArb, fc.boolean(), (rodzaj, wersje, reczna) => {
        const r = rozliczenia(rodzaj, wersje).map((v) => ({ ...v, reczna }));
        const wynik = niezaplacone({ grupy: grupy(rodzaj), rozliczenia: r, pozycje: null, profil: profil() });
        expect(wynik.every((p) => p.kwotaGr === null), JSON.stringify(wersje)).toBe(true);
      }),
      opcje(),
    );
  });

  it('D32: brak w szkicu i najnowsza zapłacona wersja wyliczona przez moduł: dokładnie przypomnienie bez kwoty, oznaczone jako po zapłacie', () => {
    fc.assert(
      fc.property(fc.constantFrom(...RODZAJE), wersjeArb, fc.integer({ min: 1, max: 300_000 }), (rodzaj, wersje, kwotaGr) => {
        const r = zZaplacona(rodzaj, wersje, kwotaGr, false);
        const pozycje: PozycjaZeSkrotem[] = [{ ok: false, rodzaj, termin: null, brak: 'Ewidencja przychodów ma braki w miesiącach: październik 2026.' }];
        const wynik = niezaplacone({ grupy: grupy(rodzaj), rozliczenia: r, pozycje, profil: profil() }).filter((p) => p.rodzaj === rodzaj);
        expect(wynik, JSON.stringify(wersje)).toEqual([{ rodzaj, kwotaGr: null, poZaplacie: true }]);
      }),
      opcje(),
    );
  });

  it('D32: brak w szkicu i najnowsza zapłacona to zapłata spoza wyliczenia: cisza', () => {
    fc.assert(
      fc.property(fc.constantFrom(...RODZAJE), wersjeArb, fc.integer({ min: 1, max: 300_000 }), (rodzaj, wersje, kwotaGr) => {
        const r = zZaplacona(rodzaj, wersje, kwotaGr, true);
        const pozycje: PozycjaZeSkrotem[] = [{ ok: false, rodzaj, termin: null, brak: 'Ewidencja przychodów ma braki w miesiącach: październik 2026.' }];
        const wynik = niezaplacone({ grupy: grupy(rodzaj), rozliczenia: r, pozycje, profil: profil() }).filter((p) => p.rodzaj === rodzaj);
        expect(wynik, JSON.stringify(wersje)).toEqual([]);
      }),
      opcje(),
    );
  });
});
