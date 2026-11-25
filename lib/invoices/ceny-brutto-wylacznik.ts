/**
 * Wyłącznik faktury w cenach brutto (plan cen brutto; RP-FA-BRUTTO-01
 * w `filtr/przepisy/faktury.json`).
 *
 * Liczenie w cenach brutto (`Invoice.pricesGross`, `grossPricedLines`, FA(3)
 * `P_9B` i `P_11A`) jest w kodzie od #835, ale reguła ma wzorzec poziomu 5
 * i otwarte pytanie do księgowej. Według B4.0, zasada 2
 * (`docs/koordynacja/PLAN-ZELAZNY-FILTR.md`), taka reguła działa dla klientów
 * tylko za wyłącznikiem.
 *
 * WŁĄCZNIK, nie hamulec: flaga `grossPricesEnabled` w `global_feature_flags`
 * (jak `publicApiEnabled`). Brak wiersza, `false`, zły typ albo błąd odczytu
 * znaczą, że faktury w cenach brutto FaktWay nie wystawia. Odczyt wprost
 * z bazy (`getGlobalFlagForExecution`, bez pamięci podręcznej), więc włączenie
 * i wyłączenie działa od następnego zapisu albo wysyłki. Włącza Bartosz po
 * odpowiedzi księgowej i poprawce telefonu:
 * `docs/runbooks/ceny-brutto-wylacznik.md`.
 *
 * Gdzie pilnowany po stronie serwera (niezależnie od formularza):
 *  1. zapis zwykłej faktury (`insertInvoiceAndLines`, `lib/invoices/issue-regular.ts`):
 *     szkic i „Wystaw i wyślij” ze strony i z telefonu, faktura cykliczna,
 *     faktura z proformy; odmowa przed zapisem;
 *  2. kolejka wysyłki (`enqueueKsefSubmitAfterDraft`): każde zlecenie klienta,
 *     także wysyłka szkicu i „Wyślij ponownie” z zapisanego `fa3_data` (strona,
 *     telefon, API); „Sprawdź ponownie” nic nie wysyła, więc przechodzi;
 *  3. job wysyłki (`submitInvoiceFullFlow`): ostatnia bramka przed plikiem
 *     FA(3), archiwum i POST, także dla ponowień z kopii (cron cyklu życia,
 *     operator), które omijają kolejkę klienta.
 * Faktura w cenach netto przechodzi bez odczytu flagi. Import z KSeF (faktury
 * innych programów z `P_9B`) nie idzie żadną z tych dróg i zostaje bez zmian.
 *
 * Dla formularza cen brutto (PR (b)): `cenyBruttoDostepne()` (tylko serwer:
 * strona formularza i podkład) mówi, czy pokazać metodę „Ceny brutto” i czy
 * podkład z faktury w cenach brutto ma zostać w cenach brutto; przy `false`
 * podkład jest w cenach netto bez cen (`CENY_BRUTTO_PODKLAD`, `prefillCore`
 * w `components/invoices/actions.ts`). Formularz i schemat, które wczytuje też
 * przeglądarka, biorą stałe z `ceny-brutto-wylacznik-wspolne.ts`.
 */

import { getGlobalFlagForExecution } from '@/lib/feature-flags/global-flags';
import {
  czyFakturaWCenachBrutto,
  FLAGA_CEN_BRUTTO,
  tekstOdmowyCenBrutto,
  type EtapOdmowyCenBrutto,
  type OdmowaCenBrutto,
} from '@/lib/invoices/ceny-brutto-wylacznik-wspolne';

// Stałe i `czyFakturaWCenachBrutto` są w module wspólnym (wczytuje go też
// przeglądarka: formularz i schemat (b)); serwer bierze je stąd albo stamtąd.
export {
  CENY_BRUTTO_PODKLAD,
  CENY_BRUTTO_WYLACZONE,
  czyFakturaWCenachBrutto,
  FLAGA_CEN_BRUTTO,
  PODKLAD_BEZ_CENY_NETTO,
  tekstOdmowyCenBrutto,
  type EtapOdmowyCenBrutto,
  type OdmowaCenBrutto,
} from '@/lib/invoices/ceny-brutto-wylacznik-wspolne';

/** Odczyt rozstrzygający, wprost z bazy. Błąd odczytu albo zły typ rzuca: „nie wiem” to nie „tak”. */
export async function czyCenyBruttoWlaczone(): Promise<boolean> {
  return getGlobalFlagForExecution(FLAGA_CEN_BRUTTO);
}

/** Dla ekranów i podkładu: czy pokazać fakturę w cenach brutto. Błąd odczytu = nie. */
export async function cenyBruttoDostepne(): Promise<boolean> {
  try {
    return await czyCenyBruttoWlaczone();
  } catch {
    return false;
  }
}

/**
 * Odmowa wystawienia faktury w cenach brutto albo `null`. Jest fakturą
 * w cenach brutto, gdy którykolwiek z dokumentów nią jest (wartości
 * formularza i zbudowana faktura); bez takiego dokumentu flagi nie czytamy.
 */
export async function odmowaCenBrutto(etap: EtapOdmowyCenBrutto, ...dokumenty: unknown[]): Promise<OdmowaCenBrutto | null> {
  if (!dokumenty.some(czyFakturaWCenachBrutto)) return null;
  let wlaczone: boolean;
  try {
    wlaczone = await czyCenyBruttoWlaczone();
  } catch {
    return { powod: 'nieznany', tekst: tekstOdmowyCenBrutto(etap, 'nieznany') };
  }
  return wlaczone ? null : { powod: 'wylaczone', tekst: tekstOdmowyCenBrutto(etap, 'wylaczone') };
}
