/**
 * Kolor kwoty wpisu w księdze (KPiR, ewidencja przychodów) na liście telefonu.
 * Zielony znaczy „przychód, który przybył”. Ujemna kwota w kolumnie przychodu
 * (korekta w minus, zwrot sprzedaży) przychód zmniejsza, więc nie może wyglądać
 * jak przychód: dostaje kolor błędu (ustalenie U41 z obchodu 20.11.2026).
 * Koszt zostaje neutralny, także ujemny (zwrot kosztu), bo kolor kosztu nic
 * nie mówi o podatku.
 *
 * Plik bez React Native (importują go testy strony). Liczy się tylko znak
 * kwoty, więc grosze i złote działają tak samo.
 */
export type KolorKwotyKsiegi = 'sukces' | 'blad' | 'etykieta';

export function kolorKwotyWpisu(przychod: boolean, kwota: number): KolorKwotyKsiegi {
  if (!przychod) return 'etykieta';
  return kwota < 0 ? 'blad' : 'sukces';
}
