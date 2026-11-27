/**
 * Wyłącznik faktury w walucie obcej (krok 2.1, część 3; D56). WŁĄCZNIK, nie
 * hamulec: flaga `foreignCurrencyEnabled` w `global_feature_flags` (jak
 * `grossPricesEnabled`, bez migracji). Brak wiersza, `false`, zły typ albo błąd
 * odczytu znaczą, że faktury w walucie obcej FaktWay nie wystawia. Odczyt wprost
 * z bazy, bez pamięci podręcznej.
 *
 * Miejsca odmowy po stronie serwera: zapis zwykłej faktury
 * (`insertInvoiceAndLines`) i kolejka wysyłki (`enqueueKsefSubmitAfterDraft`).
 * Formularz pokazuje wybór waluty tylko przy włączonym wyłączniku
 * (`walutyDostepne()` na serwerze strony).
 */

import { getGlobalFlagForExecution } from '@/lib/feature-flags/global-flags';
import {
  czyFakturaWWalucie,
  FLAGA_WALUT,
  tekstOdmowyWaluty,
  type EtapOdmowyWaluty,
} from '@/lib/invoices/waluty-wylacznik-wspolne';

export interface OdmowaWaluty {
  powod: 'wylaczone' | 'nieznany';
  tekst: string;
}

/** Odczyt rozstrzygający. Błąd odczytu albo zły typ rzuca: „nie wiem” to nie „tak”. */
export async function czyWalutyWlaczone(): Promise<boolean> {
  return getGlobalFlagForExecution(FLAGA_WALUT);
}

/** Dla ekranów: czy pokazać wybór waluty. Błąd odczytu = nie. */
export async function walutyDostepne(): Promise<boolean> {
  try {
    return await czyWalutyWlaczone();
  } catch {
    return false;
  }
}

/** Odmowa wystawienia faktury w walucie obcej albo `null`. Dokument w złotych nie czyta flagi. */
export async function odmowaWaluty(etap: EtapOdmowyWaluty, ...dokumenty: unknown[]): Promise<OdmowaWaluty | null> {
  if (!dokumenty.some(czyFakturaWWalucie)) return null;
  let wlaczone: boolean;
  try {
    wlaczone = await czyWalutyWlaczone();
  } catch {
    return { powod: 'nieznany', tekst: tekstOdmowyWaluty(etap, 'nieznany') };
  }
  return wlaczone ? null : { powod: 'wylaczone', tekst: tekstOdmowyWaluty(etap, 'wylaczone') };
}
