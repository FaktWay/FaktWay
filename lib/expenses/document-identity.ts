/**
 * Tożsamość dokumentu kosztowego: NIP i numer w postaci do porównań. Jedno
 * miejsce dla pulpitu kosztów (pokrycie faktur ze Skrzynki KSeF) i dla kosztu
 * wpisanego ręcznie (odmowa drugiego kosztu tej samej faktury). Czyste
 * funkcje, bez zależności serwerowych (importuje je też formularz).
 */

/** NIP do porównań: same cyfry, dokładnie 10, inaczej brak. */
export function nip10(value: unknown): string | null {
  const digits = typeof value === 'string' ? value.replace(/\D/g, '') : '';
  return digits.length === 10 ? digits : null;
}

/** Numer dokumentu do porównań: bez odstępów i wielkości liter („fv 1/10” = „FV1/10”). */
export function documentKey(value: unknown): string | null {
  const key = typeof value === 'string' ? value.replace(/\s+/g, '').toUpperCase() : '';
  return key || null;
}
