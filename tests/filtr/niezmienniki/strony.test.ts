import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { readCompletePages, readCompletePagesByKey, type KeysetPageQuery } from '@/lib/accounting/read-complete-pages';

import { opcje } from '../generatory/ustawienia';

/**
 * NZ-WSP-08 (żelazny filtr, uzupełnienie po spisie luk z 16.11): odczyt
 * stronami daje te same sumy co jeden odczyt, także przy 999, 1000, 1001
 * i 2500 wierszach (granica PostgREST: produkcja ucina każdą odpowiedź do
 * 1000 wierszy bez błędu, `PGRST_DB_MAX_ROWS`). Na prawdziwych
 * `readCompletePages` (zakresy) i `readCompletePagesByKey` (po `id`), z których
 * czytają księgi modułu (`*-dane.ts`). Do tego bezpieczniki: niższy limit
 * serwera, zapis albo usunięcie w trakcie odczytu i zła kolejność dają
 * wyjątek, nigdy cichą niepełną sumę.
 */

interface Wiersz {
  id: string;
  kwotaGr: number;
}

const LIMIT_SERWERA = 1000;
const GRANICE = [0, 1, 499, 500, 501, 999, 1000, 1001, 2500];
const wiersze = (n: number, kwota: (i: number) => number = (i) => (i * 7919) % 100_000): Wiersz[] =>
  Array.from({ length: n }, (_, i) => ({ id: `id-${String(i).padStart(6, '0')}`, kwotaGr: kwota(i) }));
const suma = (w: readonly Wiersz[]) => w.reduce((s, r) => s + r.kwotaGr, 0);

/** Atrapa zakresów PostgREST: `count=exact`, odpowiedź ucięta do limitu serwera; `poStronie` zmienia dane po każdej stronie. */
function zakresy(dane: Wiersz[], limit = LIMIT_SERWERA, poStronie?: (strona: number) => void) {
  let strona = 0;
  return async (from: number, to: number) => {
    const wynik = { data: dane.slice(from, Math.min(to + 1, from + limit)), count: dane.length, error: null };
    poStronie?.(++strona);
    return wynik;
  };
}

/** Atrapa odczytu po `id` (`gt`, `order`, `limit`, licznik i `head`), z tym samym limitem serwera. */
function poKluczu(dane: Wiersz[], limit = LIMIT_SERWERA, poStronie?: (strona: number) => void) {
  let strona = 0;
  return async (q: KeysetPageQuery) => {
    const dalej = dane.filter((r) => q.afterId === null || r.id > q.afterId);
    const wynik = { data: q.head ? [] : dalej.slice(0, Math.min(q.limit, limit)), count: q.count ? dane.length : null, error: null };
    poStronie?.(++strona);
    return wynik;
  };
}

describe('NZ-WSP-08: odczyt stronami daje te same wiersze i sumy co jeden odczyt', () => {
  it.each(GRANICE)('%i wierszy: oba odczyty zwracają każdy wiersz raz, w kolejności, z tą samą sumą', async (n) => {
    const dane = wiersze(n);
    for (const odczyt of [() => readCompletePages('test', zakresy(dane)), () => readCompletePagesByKey('test', poKluczu(dane))]) {
      const w = await odczyt();
      expect(w.map((r) => r.id)).toEqual(dane.map((r) => r.id));
      expect(suma(w)).toBe(suma(dane));
    }
  });

  it('losowa liczba wierszy do 3000 i losowe kwoty: suma jak w jednym odczycie', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 3000 }), fc.integer({ min: 1, max: 2 ** 31 }), async (n, ziarno) => {
        const dane = wiersze(n, (i) => ((i + 1) * ziarno) % 5_000_000);
        expect(suma(await readCompletePages('test', zakresy(dane)))).toBe(suma(dane));
        expect(suma(await readCompletePagesByKey('test', poKluczu(dane)))).toBe(suma(dane));
      }),
      opcje(Math.min(Number(process.env.FILTR_PRZYPADKI ?? 300), 300)),
    );
  }, 120_000);

  it('serwer ucina odpowiedź poniżej strony (np. limit 300): wyjątek, nie niepełna suma', async () => {
    const dane = wiersze(1001);
    await expect(readCompletePages('test', zakresy(dane, 300))).rejects.toThrow('niepełna strona danych');
    await expect(readCompletePagesByKey('test', poKluczu(dane, 300))).rejects.toThrow('niepełna strona danych');
  });

  it('zapis albo usunięcie w trakcie odczytu: wyjątek, nie suma z dwóch stanów', async () => {
    for (const zmiana of ['dopisany', 'usuniety'] as const) {
      const zmien = (dane: Wiersz[]) => () => {
        if (zmiana === 'dopisany') dane.push({ id: 'id-999999', kwotaGr: 1 });
        else dane.splice(10, 1);
      };
      const a = wiersze(2500);
      await expect(readCompletePages('test', zakresy(a, LIMIT_SERWERA, (s) => s === 1 && zmien(a)()))).rejects.toThrow(/liczby rekordów|niepełna strona/);
      const b = wiersze(2500);
      await expect(readCompletePagesByKey('test', poKluczu(b, LIMIT_SERWERA, (s) => s === 1 && zmien(b)()))).rejects.toThrow(/liczby rekordów|niepełna strona|kolejność/);
    }
  });

  it('powtórzony albo cofnięty identyfikator (serwer zignorował kolejność): wyjątek', async () => {
    const dane = wiersze(1200);
    const zlaKolejnosc = async (from: number, to: number) => ({ data: dane.slice(Math.max(0, from - 1), to), count: dane.length, error: null });
    await expect(readCompletePages('test', zlaKolejnosc)).rejects.toThrow(/kolejność|niepełna strona/);
  });
});
