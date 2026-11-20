/**
 * Komunikat o zmianach z 1 stycznia 2027 r. (plan kompletnej aplikacji, krok
 * 1.6, część 2a): kiedy go pokazujemy i dokąd prowadzi. Treść komunikatu jest
 * w `components/dashboard/zmiany-2027-baner.tsx`, a opis zmian i źródła
 * urzędowe w artykule pomocy `content/help/zmiany-od-1-stycznia-2027.mdx`.
 * To informacja ogólna, nie porada podatkowa (D8).
 */

/** Slug artykułu w `content/help` (strona `/pomoc/<slug>`). */
export const ZMIANY_2027_ARTICLE_SLUG = 'zmiany-od-1-stycznia-2027';

/** Pierwszy dzień pokazywania komunikatu (dwa miesiące przed zmianami). */
export const ZMIANY_2027_OD = '2026-11-01';
/** Ostatni dzień pokazywania komunikatu (dwa miesiące po zmianach). */
export const ZMIANY_2027_DO = '2027-02-28';

/** Czy komunikat jest w oknie czasu; `today` to dzień RRRR-MM-DD z czasu polskiego. */
export function zmiany2027Widoczne(today: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(today) && today >= ZMIANY_2027_OD && today <= ZMIANY_2027_DO;
}
