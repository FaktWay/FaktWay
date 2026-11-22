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
 * Dla formularza cen brutto (PR (b)): `cenyBruttoDostepne()` mówi, czy
 * pokazać metodę „Ceny brutto” i czy podkład z faktury w cenach brutto ma
 * zostać w cenach brutto; przy `false` podkład jest w cenach netto bez cen
 * (`CENY_BRUTTO_PODKLAD`, `prefillCore` w `components/invoices/actions.ts`).
 */

import { getGlobalFlagForExecution } from '@/lib/feature-flags/global-flags';
import type { GlobalFlag } from '@/lib/feature-flags/types';

export const FLAGA_CEN_BRUTTO = 'grossPricesEnabled' as const satisfies GlobalFlag;

/** Odmowa w jobie wysyłki (klient widzi ją po „Faktura nie trafiła do KSeF.”, z powrotem do szkicu). */
export const CENY_BRUTTO_WYLACZONE =
  'Faktura w cenach brutto nie jest jeszcze dostępna w FaktWay. Wystaw fakturę od nowa w cenach netto.';

/** Podkład z dokumentu w cenach brutto przy wyłączonym wyłączniku: pozycje bez ceny netto w dokumencie wracają z pustą ceną. */
export const CENY_BRUTTO_PODKLAD =
  'Faktura, z której wypełniliśmy formularz, ma ceny brutto, a faktury w cenach brutto FaktWay jeszcze nie wystawia. Ceny tych pozycji zostawiliśmy puste: wpisz je w cenach netto.';

/** Gdzie pada odmowa; od tego zależy, co się stało z fakturą. */
export type EtapOdmowyCenBrutto = 'zapis' | 'wysylka' | 'ponowienie';

export interface OdmowaCenBrutto {
  /** `wylaczone`: wyłącznik zdjęty; `nieznany`: nie udało się go odczytać. */
  powod: 'wylaczone' | 'nieznany';
  tekst: string;
}

const CO_SIE_STALO: Record<EtapOdmowyCenBrutto, string> = {
  zapis: 'więc faktury nie zapisaliśmy',
  wysylka: 'więc tego szkicu nie wysłaliśmy do KSeF',
  ponowienie: 'więc tej wysyłki nie wykonaliśmy i faktura zostaje z błędem wysyłki',
};

const WYJSCIE: Record<EtapOdmowyCenBrutto, string> = {
  zapis: 'Wystaw fakturę w cenach netto.',
  wysylka: 'Wystaw fakturę od nowa w cenach netto, a szkic usuń.',
  ponowienie: 'Wystaw fakturę od nowa w cenach netto.',
};

/** Tekst odmowy dla klienta: nazwa dokumentu, co się stało i wyjście (protokół napraw, pkt 4). */
export function tekstOdmowyCenBrutto(etap: EtapOdmowyCenBrutto, powod: OdmowaCenBrutto['powod']): string {
  return powod === 'nieznany'
    ? `Nie udało się sprawdzić, czy faktura w cenach brutto jest dostępna w FaktWay, ${CO_SIE_STALO[etap]}. Spróbuj ponownie za chwilę.`
    : `Faktura w cenach brutto nie jest jeszcze dostępna w FaktWay, ${CO_SIE_STALO[etap]}. ${WYJSCIE[etap]}`;
}

/**
 * Czy dokument (faktura, wartości formularza, `fa3_data`) jest w cenach
 * brutto. Tylko `pricesGross === true`, tak jak czytają go generator FA(3)
 * i bramka wysyłki (`validateInvoice`): napis albo liczba to faktura w cenach
 * netto i taki plik powstanie.
 */
export function czyFakturaWCenachBrutto(dokument: unknown): boolean {
  return typeof dokument === 'object' && dokument !== null && (dokument as { pricesGross?: unknown }).pricesGross === true;
}

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
