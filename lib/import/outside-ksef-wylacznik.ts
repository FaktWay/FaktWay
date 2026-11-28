import { getGlobalFlagForExecution } from '@/lib/feature-flags/global-flags';
import type { GlobalFlag } from '@/lib/feature-flags/types';

/**
 * Wyłącznik faktur spoza KSeF (krok 1.6, część 2b). WŁĄCZNIK, nie hamulec:
 * flaga `outsideKsefImportEnabled` w `global_feature_flags`, domyślnie
 * wyłączona (brak wiersza). D22 i D23 mają średnią pewność (potwierdza
 * księgowa), D24 i D25 potwierdza prawnik, więc klienci dostają tę funkcję
 * dopiero po włączeniu przez Bartosza. Odczyt wprost z bazy, bez pamięci
 * podręcznej: włączenie i wyłączenie działa od następnej akcji.
 */
export const FLAGA_SPOZA_KSEF = 'outsideKsefImportEnabled' as const satisfies GlobalFlag;

export const SPOZA_KSEF_WYLACZONE =
  'Dopisywanie faktur wystawionych poza KSeF nie jest jeszcze dostępne w FaktWay, więc niczego nie zapisaliśmy. Takie faktury ujmuje się w księgach poza FaktWay.';
export const SPOZA_KSEF_NIEZNANE =
  'Nie udało się sprawdzić, czy dopisywanie faktur spoza KSeF jest dostępne, więc niczego nie zmieniliśmy. Spróbuj ponownie za chwilę.';

/** Odczyt rozstrzygający dla akcji. Błąd odczytu albo zły typ rzuca: „nie wiem” to nie „tak”. */
export async function czySpozaKsefWlaczone(): Promise<boolean> {
  return getGlobalFlagForExecution(FLAGA_SPOZA_KSEF);
}

/** Dla ekranów: czy pokazać dopisywanie. Błąd odczytu = nie. */
export async function spozaKsefDostepne(): Promise<boolean> {
  try {
    return await czySpozaKsefWlaczone();
  } catch {
    return false;
  }
}
