/**
 * Jeden tekst statusu faktury dla listy i szczegółu. Status zawsze ma tekst,
 * kolor tylko go wzmacnia (docs/mobile/ZASADY-DESIGNU.md, sekcja 4).
 */
// Importy względne, nie przez `@/`: plik czytają też testy i `tsc` strony (`tests/unit/mobile-dane-mapowanie.test.ts`),
// gdzie `@/` to katalog główny repozytorium. Typy kolorów z `paleta.ts`, który nie ciągnie React Native.
import type { Faktura } from '../dane-przykladowe';
import type { Kolory, Ton } from '../wyglad/paleta';
import { dataKrotka, dniMiedzy } from './format';

/** `ton` to plakietka na liście (jak `status-badge.tsx` strony), `kolor` to ten sam status jako tekst. */
export type Status = { tekst: string; kolor: keyof Kolory; ton: Ton; zalegla: boolean; trwa?: boolean };

/** „1 dzień”, „2 dni”, „5 dni”. */
export function dni(n: number): string {
  return n === 1 ? '1 dzień' : `${n} dni`;
}

export function statusFaktury(f: Faktura, dzis: string): Status {
  if (f.statusKsef === 'robocza') return { tekst: 'Szkic', kolor: 'etykietaDrugorzedna', ton: 'neutralny', zalegla: false };
  if (f.statusKsef === 'wysylanie') return { tekst: 'Wysyłanie do KSeF', kolor: 'info', ton: 'info', zalegla: false, trwa: true };
  if (f.statusKsef === 'odrzucona') return { tekst: 'Odrzucona przez KSeF', kolor: 'blad', ton: 'blad', zalegla: false };
  // Wysyłka nie wyszła (na stronie `failed`): KSeF faktury nie odrzucił, ale nie jest w KSeF.
  if (f.statusKsef === 'blad') return { tekst: 'Błąd wysyłki do KSeF', kolor: 'ostrzezenie', ton: 'ostrzezenie', zalegla: false };
  if (f.zaplacona) return { tekst: 'Zapłacona', kolor: 'sukces', ton: 'sukces', zalegla: false };

  const poTerminie = dniMiedzy(f.terminPlatnosci, dzis);
  if (poTerminie > 7) return { tekst: `${dni(poTerminie)} po terminie`, kolor: 'blad', ton: 'blad', zalegla: true };
  if (poTerminie > 0) return { tekst: `${dni(poTerminie)} po terminie`, kolor: 'ostrzezenie', ton: 'ostrzezenie', zalegla: true };
  if (poTerminie === 0) return { tekst: 'Termin dziś', kolor: 'ostrzezenie', ton: 'ostrzezenie', zalegla: false };
  return { tekst: `Termin ${dataKrotka(f.terminPlatnosci)}`, kolor: 'etykietaDrugorzedna', ton: 'neutralny', zalegla: false };
}

/**
 * Faktura czeka na zapłatę: wysłana (przyjęta albo jeszcze w drodze do KSeF)
 * i niezapłacona. Klient bywa winien pieniądze, zanim KSeF potwierdzi przyjęcie.
 */
export function doZaplaty(f: Faktura): boolean {
  return (f.statusKsef === 'przyjeta' || f.statusKsef === 'wysylanie') && !f.zaplacona;
}

/**
 * Ile jeszcze do zapłaty: kwota do zapłaty na fakturze minus wpłaty częściowe
 * (dane z bazy); zapłacona to 0. Kwota do zapłaty to całe brutto, a na
 * fakturze rozliczającej reszta po zaliczkach (`kwotaDoZaplaty`, jak na
 * stronie: `amountDueOf` i `outstandingOf`, z dolną granicą 0). Wszystkie
 * sumy należności na telefonie liczą się tą funkcją, nie z samego `brutto`.
 */
export function pozostaloDoZaplaty(f: Faktura): number {
  if (f.zaplacona) return 0;
  const reszta = (f.kwotaDoZaplaty ?? f.brutto) - (f.zaplacono ?? 0);
  // Rozliczenie nie schodzi poniżej zera (wpłata ponad resztę po zaliczkach); inne faktury bez zmian.
  return f.kwotaDoZaplaty === undefined ? reszta : Math.max(0, reszta);
}

/** Faktura w złotych: PLN albo brak waluty (jak `isPlnOrUnset` strony); waluty obce nie dodają się do złotówek. */
export const wZlotych = (f: Faktura) => !f.waluta || f.waluta === 'PLN';

/**
 * Id faktur, które mają „dziecko” na liście: ktoś wskazuje je w `parent_invoice_id`
 * (korekta) albo w `advance_invoice_ids` (rozliczenie zaliczki), w dowolnym
 * statusie dziecka, także szkic i odrzucone. Jak `loadTenantChildIds` strony
 * (`lib/dashboard/receivables.ts`) i NOT EXISTS w widoku `invoices_overdue`
 * (00145). Lista telefonu to faktury jednej firmy od najnowszej, a dziecko jest
 * zawsze nowsze od rodzica, więc rodzic na liście ma tu swoje dzieci.
 */
function idZDzieckiem(faktury: readonly Faktura[]): Set<string> {
  const ids = new Set<string>();
  for (const f of faktury) {
    if (f.rodzicId) ids.add(f.rodzicId);
    for (const id of f.zaliczkiId ?? []) ids.add(id);
  }
  return ids;
}

/**
 * Faktury, które liczą się do należności (karta „Do zapłaty od klientów”,
 * licznik „Po terminie”): jedna reguła dla sum na ekranie Faktury, w częściach
 * `getReceivables` strony (§2.4 pkt 11), które telefon umie sprawdzić ze swoich
 * kolumn. Czekają na zapłatę (`doZaplaty`) i:
 * - nie są korektą (korekt nie liczymy nigdy, także w plus),
 * - nie mają „dziecka” (zaliczka z rozliczeniem, faktura z korektą liczą się
 *   przez dziecko albo wcale, nie drugi raz),
 * - mają dodatnią resztę do zapłaty (rozliczenie w całości pokryte
 *   zaliczkami nie jest pozycją „po terminie”).
 * Czego telefon nie sprawdza: pochodzenia (`origin`: import z KSeF, strona
 * liczy tylko sprzedaż z aplikacji), środowiska KSeF i znaczników FP, bo
 * `KOLUMNY_FAKTURY` ich nie czyta (ustalenie U42c). Telefon liczy też fakturę
 * „w drodze do KSeF” (`doZaplaty`), serwer dopiero przyjętą.
 */
export function naleznosciOtwarte(faktury: readonly Faktura[]): Faktura[] {
  const zDzieckiem = idZDzieckiem(faktury);
  return faktury.filter((f) => doZaplaty(f) && f.rodzaj !== 'korygujaca' && !zDzieckiem.has(f.id) && pozostaloDoZaplaty(f) > 0);
}

/**
 * Ile klienci jeszcze winni w złotych: `pozostaloDoZaplaty` z faktur w PLN
 * (na fakturze rozliczającej reszta po zaliczkach, od wpłat częściowych
 * odjęte), nie suma `brutto`. Suma `brutto` to wartość faktur, nie należność.
 */
export function sumaDoZaplaty(faktury: readonly Faktura[]): number {
  return faktury.reduce((s, f) => s + (wZlotych(f) ? pozostaloDoZaplaty(f) : 0), 0);
}

/**
 * Karta „Do zapłaty od klientów” na ekranie Faktury: ile klienci winni w sumie
 * (`razem`), ile z tego po terminie i które to faktury (`zalegle`). Jedno
 * złożenie dla ekranu i testu (`tests/unit/mobile-naleznosci-dzieci.test.ts`),
 * żeby nikt nie zsumował listy obok reguły `naleznosciOtwarte`.
 */
export function kartaNaleznosci(faktury: readonly Faktura[], dzis: string): { otwarte: Faktura[]; zalegle: Faktura[]; razem: number; poTerminie: number } {
  const otwarte = naleznosciOtwarte(faktury);
  const zalegle = otwarte.filter((f) => statusFaktury(f, dzis).zalegla);
  return { otwarte, zalegle, razem: sumaDoZaplaty(otwarte), poTerminie: sumaDoZaplaty(zalegle) };
}

/** „1 faktura”, „2 faktury”, „5 faktur”, „22 faktury” (polska liczba mnoga). */
export function ileFaktur(n: number): string {
  if (n === 1) return '1 faktura';
  const j = n % 10;
  const d = n % 100;
  return j >= 2 && j <= 4 && (d < 12 || d > 14) ? `${n} faktury` : `${n} faktur`;
}

/** Termin względem dziś: „dziś”, „jutro”, „za 3 dni”, „2 dni po terminie”. */
export function kiedyTermin(dzis: string, termin: string): string {
  const za = dniMiedzy(dzis, termin);
  if (za === 0) return 'dziś';
  if (za === 1) return 'jutro';
  return za > 0 ? `za ${dni(za)}` : `${dni(-za)} po terminie`;
}
