import { isCalendarDate } from '@/lib/api/v1/pagination';
import { rateBefore, type NbpRate, type RateLookup } from '@/lib/flo/nbp';
import { fetchNbpTablesBefore } from '@/lib/nbp/client';

/**
 * Kurs NBP do faktury w walucie obcej (plan kompletnej aplikacji, krok 2.1,
 * decyzja D56 w `docs/koordynacja/DECYZJE-2026-11-25.md`).
 *
 * Art. 31a ust. 1 ustawy o VAT: kwoty w walucie obcej przelicza się „według
 * kursu średniego danej waluty obcej ogłoszonego przez Narodowy Bank Polski na
 * ostatni dzień roboczy poprzedzający dzień powstania obowiązku podatkowego”.
 * Ust. 2: gdy faktura jest wystawiona przed powstaniem obowiązku, „na ostatni
 * dzień roboczy poprzedzający dzień wystawienia faktury”. Kurs EBC (ust. 1
 * zd. 2) i zasady z ustawy o PIT (ust. 2a) są poza pierwszą wersją.
 *
 * Wybór tabeli (ostatnia opublikowana PRZED dniem odniesienia, bez zgadywania
 * przy luce) robi ta sama funkcja co przy kosztach (`rateBefore`), a niezmiennik
 * NZ-FA-06 sprawdza całość na każdym dniu 2026-2030
 * (`tests/filtr/roznicowe/kurs-dzien-faktury.test.ts`).
 */

/**
 * Dzień, przed którym bierze się kurs: wcześniejszy z dni (obowiązek podatkowy,
 * wystawienie faktury). Domyślny obowiązek (art. 19a ust. 1): dzień dostawy
 * towaru albo wykonania usługi (`P_6`), a bez niego dzień wystawienia. Inny dzień
 * obowiązku (art. 19a ust. 3-8, np. usługa ciągła albo zaliczka) podaje klient
 * w `taxPointDate`. Zła data to błąd programu (`RangeError`), nie cichy kurs
 * z innego dnia.
 */
export function invoiceRateReferenceDate(dates: { issueDate: string; taxPointDate?: string | null }): string {
  const { issueDate, taxPointDate } = dates;
  if (!isCalendarDate(issueDate)) throw new RangeError(`Kurs faktury: zła data wystawienia „${issueDate}”.`);
  if (taxPointDate === undefined || taxPointDate === null) return issueDate;
  if (!isCalendarDate(taxPointDate)) throw new RangeError(`Kurs faktury: zła data obowiązku podatkowego „${taxPointDate}”.`);
  return taxPointDate < issueDate ? taxPointDate : issueDate;
}

/**
 * Kurs NBP (tabela A) do faktury w walucie obcej: tabela z ostatniego dnia
 * roboczego przed `invoiceRateReferenceDate`. Brak tabeli to `found: false`
 * z powodem; błąd sieci albo NBP rzuca (do ponowienia), jak przy kosztach.
 */
export async function nbpRateForInvoice(
  currency: string,
  dates: { issueDate: string; taxPointDate?: string | null },
): Promise<RateLookup> {
  const reference = invoiceRateReferenceDate(dates);
  return rateBefore(await fetchNbpTablesBefore(currency, reference), currency, reference);
}

/** Kurs z tabeli NBP w kształcie faktury (`Invoice.exchangeRate`). */
export function exchangeRateFromNbp(rate: NbpRate): { rate: number; tableNo: string; tableDate: string } {
  return { rate: rate.mid, tableNo: rate.tableNo, tableDate: rate.effectiveDate };
}
