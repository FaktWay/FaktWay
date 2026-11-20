/**
 * Kolor kwoty wpisu księgi na telefonie (ustalenie U41 z obchodu w symulatorze,
 * 20.11.2026, obszar R2: wprowadza w błąd).
 *
 * Czerwone przed poprawką (origin/main po #856): w Ewidencji i KPiR kwota
 * wpisu w kolumnie przychodu była zielona bez względu na znak, więc ujemna
 * korekta „-100,00 zł” wyglądała jak przychód, który przybył. Strona nie
 * koloruje kwot (dwie kolumny, „Przychód” i „Koszt”), więc to wada samego
 * telefonu.
 *
 * Źródła ekranów są osobnym workspace (React Native), dlatego zgodność
 * wszystkich czterech miejsc sprawdza odczyt źródła, jak `mobile-android.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { kolorKwotyWpisu, kolorMarzy } from '../../mobile/src/lib/kolor-kwoty-ksiegi';

const EKRANY = join(__dirname, '../../mobile/src/app/(zakladki)/ksiegowosc');

describe('kolorKwotyWpisu: kolor kwoty wpisu księgi', () => {
  it('przychód dodatni jest zielony (bez zmian)', () => {
    expect(kolorKwotyWpisu(true, 10000)).toBe('sukces');
    expect(kolorKwotyWpisu(true, 0.01)).toBe('sukces');
  });

  it('ujemna korekta przychodu nie jest zielona: dostaje kolor błędu', () => {
    expect(kolorKwotyWpisu(true, -10000)).toBe('blad');
    expect(kolorKwotyWpisu(true, -0.01)).toBe('blad');
  });

  it('przychód równy zeru jest neutralny (nic nie przybyło)', () => {
    expect(kolorKwotyWpisu(true, 0)).toBe('etykieta');
  });

  it('koszt zostaje neutralny, także ujemny (zwrot kosztu)', () => {
    expect(kolorKwotyWpisu(false, 12300)).toBe('etykieta');
    expect(kolorKwotyWpisu(false, -12300)).toBe('etykieta');
  });
});

describe('kolorMarzy: plakietka „Marża” w KPiR (ta sama wada co U41, drugi czytelnik)', () => {
  it('marża dodatnia jest zielona', () => {
    expect(kolorMarzy(66)).toBe('sukces');
  });

  it('marża ujemna (strata) nie jest zielona: dostaje kolor błędu, jak na stronie', () => {
    expect(kolorMarzy(-12)).toBe('blad');
  });

  it('marża zero jest neutralna', () => {
    expect(kolorMarzy(0)).toBe('etykietaDrugorzedna');
  });
});

describe('ekrany księgi: żadna lista nie koloruje kwoty wpisu z pominięciem znaku', () => {
  it.each(['ewidencja.tsx', 'kpir.tsx'])('%s: kwota wpisu idzie przez kolorKwotyWpisu', (plik) => {
    const zrodlo = readFileSync(join(EKRANY, plik), 'utf8');
    // Zielona kwota wprost od flagi przychodu to dokładnie wada U41.
    expect(zrodlo).not.toMatch(/wartoscKolor=\{[^}]*\?\s*'sukces'/);
    expect(zrodlo).toContain('kolorKwotyWpisu(');
  });

  it('plakietka „Marża” w KPiR nie jest zielona na stałe (dane przykładowe i prawdziwe konto)', () => {
    const zrodlo = readFileSync(join(EKRANY, 'kpir.tsx'), 'utf8');
    expect(zrodlo).not.toMatch(/Marża[^\n]*statusKolor="sukces"/);
    expect(zrodlo).not.toMatch(/statusKolor="sukces"/);
    expect(zrodlo.match(/kolorMarzy\(/g)?.length).toBe(2);
  });

  it('każde wywołanie podaje kwotę wpisu, nie tylko flagę przychodu', () => {
    for (const plik of ['ewidencja.tsx', 'kpir.tsx']) {
      const zrodlo = readFileSync(join(EKRANY, plik), 'utf8');
      const wywolania = [...zrodlo.matchAll(/kolorKwotyWpisu\(([^)]*\)?[^)]*)\)/g)];
      expect(wywolania.length, plik).toBeGreaterThan(0);
      for (const w of wywolania) expect(w[1], plik).toMatch(/,\s*\S+/);
    }
  });
});
