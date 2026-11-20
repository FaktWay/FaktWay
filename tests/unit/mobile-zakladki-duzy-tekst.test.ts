/**
 * Pasek zakładek na telefonie przy największym tekście z ustawień dostępności
 * (ustalenia U39 i U40 z obchodu w symulatorze, 20.11.2026, obszar R3).
 *
 * Czerwone przed poprawką (origin/main po #856): etykiety zakładek miały stałe
 * 10 pt i nie rosły z tekstem (U39), a pasek zawsze minimalizował się przy
 * przewijaniu: przy dużym tekście kółko zasłaniało lewy dolny róg treści
 * i zostawało zminimalizowane na ekranach bez przewijania (U40).
 *
 * Reguły leżą w pliku bez React Native; układ składa `(zakladki)/_layout.tsx`,
 * więc test sprawdza też, że używa tych reguł zamiast stałych.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SKALA_PIONOWA } from '../../mobile/src/wyglad/odstepy';
import { ETYKIETA_ZAKLADKI, ETYKIETA_ZAKLADKI_MAKS, minimalizacjaPaska, rozmiarEtykietyZakladki } from '../../mobile/src/wyglad/zakladki';

const UKLAD = readFileSync(join(__dirname, '../../mobile/src/app/(zakladki)/_layout.tsx'), 'utf8');

describe('rozmiarEtykietyZakladki: etykiety rosną z tekstem, ale mają sufit', () => {
  it('przy zwykłym tekście zostaje 10 pt', () => {
    expect(rozmiarEtykietyZakladki(1)).toBe(ETYKIETA_ZAKLADKI);
  });

  it('przy małym tekście nie schodzi poniżej 10 pt (czytelność)', () => {
    expect(rozmiarEtykietyZakladki(0.8)).toBe(ETYKIETA_ZAKLADKI);
  });

  it('przy dużym tekście rośnie ponad 10 pt', () => {
    expect(rozmiarEtykietyZakladki(1.3)).toBeGreaterThan(ETYKIETA_ZAKLADKI);
    expect(rozmiarEtykietyZakladki(SKALA_PIONOWA)).toBeGreaterThan(ETYKIETA_ZAKLADKI);
  });

  it('przy największym tekście (AX5, ok. 3,1) nie przekracza sufitu, żeby pięć napisów się mieściło', () => {
    expect(rozmiarEtykietyZakladki(3.1)).toBe(ETYKIETA_ZAKLADKI_MAKS);
    expect(rozmiarEtykietyZakladki(10)).toBe(ETYKIETA_ZAKLADKI_MAKS);
  });

  it('rośnie monotonicznie', () => {
    let poprzedni = 0;
    for (let s = 0.8; s <= 3.2; s += 0.05) {
      const r = rozmiarEtykietyZakladki(s);
      expect(r).toBeGreaterThanOrEqual(poprzedni);
      poprzedni = r;
    }
  });
});

describe('minimalizacjaPaska: duży tekst nie minimalizuje paska', () => {
  it('przy zwykłym tekście pasek minimalizuje się przy przewijaniu w dół (bez zmian)', () => {
    expect(minimalizacjaPaska(1)).toBe('onScrollDown');
    expect(minimalizacjaPaska(SKALA_PIONOWA - 0.01)).toBe('onScrollDown');
  });

  it('od progu dużego tekstu pasek zostaje rozwinięty', () => {
    expect(minimalizacjaPaska(SKALA_PIONOWA)).toBe('never');
    expect(minimalizacjaPaska(3.1)).toBe('never');
  });
});

describe('układ zakładek korzysta z tych reguł', () => {
  it('rozmiar etykiet i minimalizacja idą przez funkcje, nie przez stałe', () => {
    expect(UKLAD).toContain('rozmiarEtykietyZakladki(');
    expect(UKLAD).toContain('minimalizacjaPaska(');
    expect(UKLAD).not.toMatch(/fontSize:\s*10\b/);
    expect(UKLAD).not.toMatch(/minimizeBehavior="onScrollDown"/);
  });
});
