/**
 * Pasek zakładek przy dużym tekście z ustawień dostępności (obchód U39 i U40,
 * 20.11.2026). Same reguły, bez React Native, żeby sprawdzał je test strony
 * (`tests/unit/mobile-zakladki-duzy-tekst.test.ts`); układ składa
 * `app/(zakladki)/_layout.tsx`.
 */
import { SKALA_PIONOWA } from './odstepy';

export type MinimalizacjaPaska = 'onScrollDown' | 'never';

/** Rozmiar etykiet zakładek przy zwykłym tekście: 10 pt, jak w systemie. */
export const ETYKIETA_ZAKLADKI = 10;

/** Pięć napisów („Księgowość” najdłuższy) musi zmieścić się w pasku, więc rozmiar ma sufit. */
export const ETYKIETA_ZAKLADKI_MAKS = 12;

/**
 * Etykiety rosną razem z tekstem, ale od 10 do 12 pt: system nie skaluje
 * napisów paska sam, a bez sufitu „Księgowość” nie zmieściłaby się w jednej
 * piątej szerokości przy największym tekście.
 */
export function rozmiarEtykietyZakladki(fontScale: number): number {
  const rozmiar = Math.round(ETYKIETA_ZAKLADKI * fontScale);
  return Math.min(ETYKIETA_ZAKLADKI_MAKS, Math.max(ETYKIETA_ZAKLADKI, rozmiar));
}

/**
 * Przy zwykłym tekście pasek chowa się w kółko przy przewijaniu w dół (Liquid
 * Glass). Przy dużym tekście kółko zasłaniało lewy dolny róg treści i zostawało
 * zminimalizowane na ekranach bez przewijania, więc pasek zostaje rozwinięty
 * (zajmuje wtedy kilka procent wysokości ekranu).
 */
export function minimalizacjaPaska(fontScale: number): MinimalizacjaPaska {
  return fontScale >= SKALA_PIONOWA ? 'never' : 'onScrollDown';
}
