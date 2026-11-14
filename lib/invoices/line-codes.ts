/**
 * Kody pozycji faktury z jawnym typem (plan kompletnej aplikacji, krok 2.6,
 * część 2b): PKWiU i oznaczenie GTU. Jedno źródło dla katalogu produktów
 * (`lib/produkty/model.ts`) i schematu formularza faktury. Same kody, bez
 * opisów: które oznaczenie się należy, wybiera klient (D8 planu księgowości).
 * GTU w pozycji faktury dojdzie razem z GTU w JPK_V7M (część 2b-2); do tego
 * czasu lista służy tylko katalogowi.
 */

/** Oznaczenia GTU ze schematu FA(3) (`lib/xml/schemas/fa3/schemat.xsd`, typ `TGTU`). */
export const GTU_CODES = [
  'GTU_01', 'GTU_02', 'GTU_03', 'GTU_04', 'GTU_05', 'GTU_06', 'GTU_07',
  'GTU_08', 'GTU_09', 'GTU_10', 'GTU_11', 'GTU_12', 'GTU_13',
] as const;

/** PKWiU: najwyżej 20 znaków (jak w katalogu); schemat FA(3) przyjmuje do 50 (`TZnakowy50`). */
export const PKWIU_MAX_LENGTH = 20;

/** Format PKWiU nie jest zgadywany: tylko cyfry i kropki, od cyfry. */
export const PKWIU_PATTERN = /^[0-9][0-9.]*$/;

export const PKWIU_PATTERN_MESSAGE = 'PKWiU: tylko cyfry i kropki, na przykład 62.01.11.0.';
export const PKWIU_LENGTH_MESSAGE = `PKWiU: najwyżej ${PKWIU_MAX_LENGTH} znaków.`;
export const GTU_CODE_MESSAGE = 'Wybierz kod GTU z listy albo zostaw pole puste.';

/** Poprawny kod PKWiU (już bez spacji na brzegach). */
export function isPkwiuCode(value: unknown): value is string {
  return typeof value === 'string' && value.length <= PKWIU_MAX_LENGTH && PKWIU_PATTERN.test(value);
}
