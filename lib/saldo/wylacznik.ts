import { getGlobalFlagForExecution } from '@/lib/feature-flags/global-flags';
import type { GlobalFlag } from '@/lib/feature-flags/types';

/**
 * Wyłącznik potwierdzenia salda (krok 2.9, część 2; D27 i D28 mają średnią
 * pewność: zakres potwierdza księgowa, tekst prawnik). WŁĄCZNIK, nie hamulec:
 * flaga `balanceConfirmationsEnabled` w `global_feature_flags` (wiersz
 * wyłączony z migracji 00215). Brak wiersza, `false` albo zły typ znaczą, że
 * FaktWay nie wystawia ani nie wysyła potwierdzeń salda; tę samą flagę
 * sprawdzają funkcje bazy (podgląd i wystawienie odmawiają `disabled`).
 * Odczyt wprost z bazy (`getGlobalFlagForExecution`, bez pamięci podręcznej),
 * więc włączenie i wyłączenie działa od następnej akcji.
 */
export const FLAGA_SALDA = 'balanceConfirmationsEnabled' as const satisfies GlobalFlag;

/** Odczyt rozstrzygający dla akcji. Błąd odczytu albo zły typ rzuca: „nie wiem” to nie „tak”. */
export async function czyPotwierdzenieSaldaWlaczone(): Promise<boolean> {
  return getGlobalFlagForExecution(FLAGA_SALDA);
}

/** Dla ekranów (PR C): czy pokazać przycisk. Błąd odczytu = nie. */
export async function potwierdzenieSaldaDostepne(): Promise<boolean> {
  try {
    return await czyPotwierdzenieSaldaWlaczone();
  } catch {
    return false;
  }
}
