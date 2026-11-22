/**
 * Podstawa zwolnienia z VAT z formularza Więcej > Firma > Podatek VAT. Plik bez
 * React Native, żeby czytał go test strony (`tests/unit/mobile-zwolnienie-vat.test.ts`).
 * Obszar R2 mapy filtra (`mobile.szacunki`): zwolnienie decyduje o stawkach „zw”
 * i podstawie na każdej kolejnej fakturze do KSeF.
 *
 * Dla `POST /ustawienia/firma` (i akcji strony) pusta podstawa to „czynny podatnik
 * VAT”. To zamierzona droga wyłączenia zwolnienia, więc telefon wysyła ją tylko
 * po wyłączeniu przełącznika. Przy włączonym zwolnieniu i pustej „Innej podstawie”
 * nie wysyła nic, bo serwer zdjąłby zwolnienie bez słowa (U19). Długość (3 do 256
 * znaków) i znaki sprawdza serwer, jego zdanie stoi pod polem.
 */

/** Wartość wyboru „Inna podstawa” na liście podstaw (reszta to przepisy podpowiadane przez stronę). */
export const INNA_PODSTAWA = 'inna';

export const KOMUNIKAT_BRAK_PODSTAWY = 'Podaj podstawę zwolnienia z VAT.';

export type WynikPodstawy = { ok: true; podstawa: string } | { ok: false; komunikat: string };

/**
 * Podstawa do wysłania (`''`: zwolnienie wyłączone) albo odmowa ze zdaniem dla
 * klienta, gdy zwolnienie jest włączone, a „Inna podstawa” pusta lub z samych spacji.
 */
export function podstawaZwolnienia({ zwolniona, wybor, inna }: { zwolniona: boolean; wybor: string; inna: string }): WynikPodstawy {
  if (!zwolniona) return { ok: true, podstawa: '' };
  if (wybor !== INNA_PODSTAWA) return { ok: true, podstawa: wybor };
  if (inna.trim() === '') return { ok: false, komunikat: KOMUNIKAT_BRAK_PODSTAWY };
  return { ok: true, podstawa: inna };
}
