import type { GtuCode } from '@/types/invoice';

/**
 * Kody pozycji faktury z jawnym typem (plan kompletnej aplikacji, krok 2.6,
 * część 2b): PKWiU i oznaczenie GTU. Jedno źródło dla katalogu produktów
 * (`lib/produkty/model.ts`), schematu formularza faktury, budowania faktury,
 * generatora FA(3) i wiersza sprzedaży JPK_V7M. Same kody, bez opisów: które
 * oznaczenie się należy, wybiera klient (D8 planu księgowości).
 */

/**
 * Oznaczenia GTU ze schematu FA(3) (`lib/xml/schemas/fa3/schemat.xsd`, typ
 * `TGTU`), w kolejności sekwencji `GTU_01`..`GTU_13` wiersza sprzedaży
 * JPK_V7M(3) (`lib/exports/schemas/jpk-v7m3/schemat.xsd`; § 10 ust. 3
 * rozporządzenia MFiR z 15.10.2019, Dz.U. 2019 poz. 1988).
 */
export const GTU_CODES = [
  'GTU_01', 'GTU_02', 'GTU_03', 'GTU_04', 'GTU_05', 'GTU_06', 'GTU_07',
  'GTU_08', 'GTU_09', 'GTU_10', 'GTU_11', 'GTU_12', 'GTU_13',
] as const satisfies readonly GtuCode[];

/** Kod z listy `GTU_CODES`, dokładnie (bez spacji, wielkimi literami). */
export function isGtuCode(value: unknown): value is GtuCode {
  return typeof value === 'string' && (GTU_CODES as readonly string[]).includes(value);
}

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

/**
 * Poprawne kody pozycji z zapisanych danych (dokument faktury `fa3_data.lines`,
 * koperta korekty): PKWiU bez spacji na brzegach i GTU z listy, inne pominięte.
 * Krok 2.6, część 2b-3: kody faktury korygowanej w wierszach korekty.
 */
export function lineCodesOf(line: { pkwiuCode?: unknown; gtuCode?: unknown } | null | undefined): { pkwiuCode?: string; gtuCode?: GtuCode } {
  const pkwiu = typeof line?.pkwiuCode === 'string' ? line.pkwiuCode.trim() : '';
  const gtu = line?.gtuCode;
  return {
    ...(isPkwiuCode(pkwiu) ? { pkwiuCode: pkwiu } : {}),
    ...(isGtuCode(gtu) ? { gtuCode: gtu } : {}),
  };
}
