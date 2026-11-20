/**
 * Dolny pasek formularza faktury na telefonie przy największym tekście
 * (ustalenie U38 z obchodu w symulatorze, 20.11.2026, obszar R1: folder
 * formularza faktury).
 *
 * Czerwone przed poprawką (origin/main po #856): przycisk „Wyślij do KSeF ·
 * 0,00 zł” zawijał się do 3 linii i pasek zajmował około 25% ekranu; do tego
 * treść formularza miała pod paskiem stałe 112 pt miejsca, więc przy wyższym
 * pasku ostatnie pola wchodziły pod niego i nie dało się ich dosunąć.
 *
 * Reguły tytułu leżą w pliku bez React Native. Sam formularz jest osobnym
 * workspace, więc jego zgodność z regułami sprawdza odczyt źródła, jak
 * `mobile-wybor-rodzaju-stopka.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SKALA_PIONOWA } from '../../mobile/src/wyglad/odstepy';
import { MAKS_SKALA_TEKSTU_PASKA, tytulPrzyciskuWysylki } from '../../mobile/src/wyglad/pasek-dolny';

const FORMULARZ = readFileSync(join(__dirname, '../../mobile/src/app/(zakladki)/faktury/nowa/[rodzaj].tsx'), 'utf8');
const PRZYCISK = readFileSync(join(__dirname, '../../mobile/src/komponenty/przycisk-glowny.tsx'), 'utf8');

describe('tytulPrzyciskuWysylki: kwota na przycisku tylko, gdy się mieści', () => {
  it('przy zwykłym tekście przycisk niesie kwotę (bez zmian)', () => {
    expect(tytulPrzyciskuWysylki('Wyślij do KSeF', '1 230,00 zł', 1)).toBe('Wyślij do KSeF · 1 230,00 zł');
    expect(tytulPrzyciskuWysylki('Wyślij zaliczkę', '615,00 zł', SKALA_PIONOWA - 0.01)).toBe('Wyślij zaliczkę · 615,00 zł');
  });

  it('od progu dużego tekstu zostaje sam czasownik, bez kwoty', () => {
    expect(tytulPrzyciskuWysylki('Wyślij do KSeF', '0,00 zł', SKALA_PIONOWA)).toBe('Wyślij do KSeF');
    expect(tytulPrzyciskuWysylki('Wyślij korektę', '-123,00 zł', 3.1)).toBe('Wyślij korektę');
  });

  it('bez kwoty (jeszcze nie wyliczona) zostaje sam czasownik przy każdym tekście', () => {
    expect(tytulPrzyciskuWysylki('Wyślij do KSeF', undefined, 1)).toBe('Wyślij do KSeF');
    expect(tytulPrzyciskuWysylki('Wyślij do KSeF', undefined, 3.1)).toBe('Wyślij do KSeF');
  });

  it('sufit skali napisu w pasku jest większy od 1 (tekst nadal rośnie), a mniejszy od największego tekstu', () => {
    expect(MAKS_SKALA_TEKSTU_PASKA).toBeGreaterThan(1);
    expect(MAKS_SKALA_TEKSTU_PASKA).toBeLessThan(3);
  });
});

describe('formularz faktury: pasek dolny przy dużym tekście', () => {
  it('tytuł przycisku wysyłki idzie przez tytulPrzyciskuWysylki, nie przez sklejanie kwoty w miejscu', () => {
    expect(FORMULARZ).toContain('tytulPrzyciskuWysylki(');
    expect(FORMULARZ).not.toMatch(/`\$\{przyciskWyslij\} · \$\{kwota\(/);
  });

  it('miejsce pod paskiem wynika z zmierzonej wysokości paska, nie ze stałej', () => {
    expect(FORMULARZ).toMatch(/onLayout=\{[^}]*layout\.height/);
    expect(FORMULARZ).not.toMatch(/paddingBottom:\s*WYSOKOSC_PASKA\b/);
  });

  it('przyciski paska mają sufit skali tekstu', () => {
    expect(PRZYCISK).toContain('maxFontSizeMultiplier');
    expect(FORMULARZ).toMatch(/maksSkalaTekstu=\{MAKS_SKALA_TEKSTU_PASKA\}/);
  });
});
