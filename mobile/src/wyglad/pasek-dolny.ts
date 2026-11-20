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
 * Etykieta przycisku wysyłki dla czytnika ekranu: zawsze z kwotą, bo to akcja
 * nieodwracalna (po wysłaniu do KSeF fakturę zmienisz tylko korektą), a ludzie
 * z VoiceOver często używają też dużego tekstu.
 */
export function etykietaPrzyciskuWysylki(czasownik: string, kwotaTekst: string | undefined): string {
  return kwotaTekst === undefined ? czasownik : `${czasownik} · ${kwotaTekst}`;
}

/**
 * Tytuł widoczny na przycisku wysyłki: „Wyślij do KSeF · 1 230,00 zł”. Kwotę
 * pokazuje też „Podsumowanie” w formularzu, więc przy dużym tekście, gdzie
 * zawinięty napis zajmował około ćwierci ekranu, zostaje sam czasownik.
 */
export function tytulPrzyciskuWysylki(czasownik: string, kwotaTekst: string | undefined, fontScale: number): string {
  if (fontScale >= SKALA_PIONOWA) return czasownik;
  return etykietaPrzyciskuWysylki(czasownik, kwotaTekst);
}
