/**
 * Dolny pasek przypięty w formularzu faktury („Podgląd” i „Wyślij do KSeF ·
 * kwota”) przy dużym tekście z ustawień dostępności (obchód U38, 20.11.2026).
 * Same reguły, bez React Native, żeby sprawdzał je test strony
 * (`tests/unit/mobile-pasek-formularza-duzy-tekst.test.ts`).
 */
import { SKALA_PIONOWA } from './odstepy';

/**
 * Sufit skali tekstu w przycisku paska: pasek stoi nad treścią i zabiera jej
 * miejsce, więc napis rośnie z tekstem tylko do tej skali (reszta ekranu bez limitu).
 */
export const MAKS_SKALA_TEKSTU_PASKA = 1.6;

/**
 * Tytuł przycisku wysyłki: „Wyślij do KSeF · 1 230,00 zł”. Kwotę pokazuje też
 * „Podsumowanie” w formularzu, więc przy dużym tekście, gdzie zawinięty napis
 * zajmował około ćwierci ekranu, zostaje sam czasownik.
 */
export function tytulPrzyciskuWysylki(czasownik: string, kwotaTekst: string | undefined, fontScale: number): string {
  if (kwotaTekst === undefined || fontScale >= SKALA_PIONOWA) return czasownik;
  return `${czasownik} · ${kwotaTekst}`;
}
