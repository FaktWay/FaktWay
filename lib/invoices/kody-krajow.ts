/**
 * Kody krajów dla `TKodKraju` ze schematu FA(3) (`KodyKrajow_v10-0E.xsd`):
 * `Podmiot2/Adres/KodKraju` i `DaneIdentyfikacyjne/KodKraju`. Plan zero, karta
 * C2, S7: nabywca z paszportem albo dowodem wybiera kraj w formularzu, zamiast
 * dostawać `PL` na sztywno. Test `tests/unit/zero-c2-nabywca-kraj-i-vat-ue.test.ts`
 * pilnuje, żeby lista była równa XSD.
 */
export const KODY_KRAJOW: readonly string[] = [
  'AF', 'AX', 'AL', 'DZ', 'AD', 'AO', 'AI', 'AQ', 'AG', 'AN', 'SA', 'AR', 'AM', 'AW',
  'AU', 'AT', 'AZ', 'BS', 'BH', 'BD', 'BB', 'BE', 'BZ', 'BJ', 'BM', 'BT', 'BY', 'BO',
  'BQ', 'BA', 'BW', 'BR', 'BN', 'IO', 'BG', 'BF', 'BI', 'XC', 'CL', 'CN', 'HR', 'CW',
  'CY', 'TD', 'ME', 'DK', 'DM', 'DO', 'DJ', 'EG', 'EC', 'ER', 'EE', 'ET', 'FK', 'FJ',
  'PH', 'FI', 'FR', 'TF', 'GA', 'GM', 'GH', 'GI', 'GR', 'GD', 'GL', 'GE', 'GU', 'GG',
  'GY', 'GF', 'GP', 'GT', 'GN', 'GQ', 'GW', 'HT', 'ES', 'HN', 'HK', 'IN', 'ID', 'IQ',
  'IR', 'IE', 'IS', 'IL', 'JM', 'JP', 'YE', 'JE', 'JO', 'KY', 'KH', 'CM', 'CA', 'QA',
  'KZ', 'KE', 'KG', 'KI', 'CO', 'KM', 'CG', 'CD', 'KP', 'XK', 'CR', 'CU', 'KW', 'LA',
  'LS', 'LB', 'LR', 'LY', 'LI', 'LT', 'LV', 'LU', 'MK', 'MG', 'YT', 'MO', 'MW', 'MV',
  'MY', 'ML', 'MT', 'MP', 'MA', 'MQ', 'MR', 'MU', 'MX', 'XL', 'FM', 'UM', 'MD', 'MC',
  'MN', 'MS', 'MZ', 'MM', 'NA', 'NR', 'NP', 'NL', 'DE', 'NE', 'NG', 'NI', 'NU', 'NF',
  'NO', 'NC', 'NZ', 'PS', 'OM', 'PK', 'PW', 'PA', 'PG', 'PY', 'PE', 'PN', 'PF', 'PL',
  'GS', 'PT', 'PR', 'CF', 'CZ', 'KR', 'ZA', 'RE', 'RU', 'RO', 'RW', 'EH', 'BL', 'KN',
  'LC', 'MF', 'VC', 'SV', 'WS', 'AS', 'SM', 'SN', 'RS', 'SC', 'SL', 'SG', 'SK', 'SI',
  'SO', 'LK', 'PM', 'US', 'SZ', 'SD', 'SS', 'SR', 'SJ', 'SH', 'SY', 'CH', 'SE', 'TJ',
  'TH', 'TW', 'TZ', 'TG', 'TK', 'TO', 'TT', 'TN', 'TR', 'TM', 'TV', 'UG', 'UA', 'UY',
  'UZ', 'VU', 'WF', 'VA', 'HU', 'VE', 'GB', 'VN', 'IT', 'TL', 'CI', 'BV', 'CX', 'IM',
  'SX', 'CK', 'VI', 'VG', 'HM', 'CC', 'MH', 'FO', 'SB', 'ST', 'TC', 'ZM', 'CV', 'ZW',
  'AE', 'XI',
];

const KODY_KRAJOW_ZBIOR: ReadonlySet<string> = new Set(KODY_KRAJOW);

/** Czy to kod kraju przyjmowany przez XSD FA(3) (wielkie litery, bez poprawiania). */
export function isKodKraju(value: string | null | undefined): boolean {
  return KODY_KRAJOW_ZBIOR.has(value ?? '');
}

/** Polska nazwa kraju z kodu (do listy wyboru); nieznany kod zwraca sam kod. */
export function nazwaKraju(kod: string): string {
  try {
    return new Intl.DisplayNames(['pl'], { type: 'region' }).of(kod) ?? kod;
  } catch {
    return kod;
  }
}
