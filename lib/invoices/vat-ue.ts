/**
 * Numer VAT-UE nabywcy z innego państwa członkowskiego (AUD-70).
 *
 * FA(3) zapisuje go w `Podmiot2/DaneIdentyfikacyjne` jako parę `KodUE`
 * (lista `TKodyKrajowUE` ze schematu — Grecja to `EL`, Irlandia Płn. `XI`)
 * i `NrVatUE` (wzorzec `TNrVatUE`: 1–12 znaków z [0-9A-Z+*], bez prefiksu).
 * Adres nabywcy ma osobny kod kraju ISO (`TKodKraju`) — dla Grecji `GR`.
 *
 * Test `tests/unit/vat-ue.test.ts` pilnuje, żeby lista była równa XSD.
 */

export const KOD_UE = [
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'EL', 'HR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'XI',
] as const;

export type KodUE = (typeof KOD_UE)[number];

export interface ParsedVatUe {
  kodUE: KodUE;
  /** Numer bez prefiksu kraju (`NrVatUE`). */
  numer: string;
  /** Postać kanoniczna `KodUE + NrVatUE`, np. `DE123456789`. */
  normalized: string;
}

const NR_VAT_UE = /^(?:\d|[A-Z]|\+|\*){1,12}$/;

/** Rozbiór numeru VAT-UE; `null`, gdy prefiks spoza listy XSD albo zły format. */
export function parseVatUe(raw: string | null | undefined): ParsedVatUe | null {
  const cleaned = (raw ?? '').replace(/[\s.\-]/g, '').toUpperCase();
  const prefix = cleaned.slice(0, 2);
  const numer = cleaned.slice(2);
  if (!(KOD_UE as readonly string[]).includes(prefix) || !NR_VAT_UE.test(numer)) return null;
  return { kodUE: prefix as KodUE, numer, normalized: `${prefix}${numer}` };
}

/** Numer VAT-UE nabywcy z INNEGO państwa członkowskiego (prefiks ≠ PL). */
export function isForeignEuVat(raw: string | null | undefined): boolean {
  const parsed = parseVatUe(raw);
  return parsed !== null && parsed.kodUE !== 'PL';
}

/**
 * Nabywca, dla którego usługa może mieć stawkę „np II” (art. 100 ust. 1 pkt 4,
 * art. 28b): podatnik z INNEGO państwa członkowskiego. Bez `PL` i bez `XI` —
 * Irlandia Północna ma numer VAT-UE tylko dla obrotu towarami; usługa dla
 * firmy z Irlandii Płn. to usługa dla podatnika spoza UE (np I).
 */
export function isNpIiBuyerVat(raw: string | null | undefined): boolean {
  const parsed = parseVatUe(raw);
  return parsed !== null && parsed.kodUE !== 'PL' && parsed.kodUE !== 'XI';
}

/** Kod kraju do adresu (ISO, `TKodKraju`) dla prefiksu VAT-UE. */
export function addressCountryForKodUE(kodUE: KodUE): string {
  return kodUE === 'EL' ? 'GR' : kodUE;
}

/**
 * Numer VAT UE sprzedawcy, czyli NIP z prefiksem PL (plan zero, karta C2, W8):
 * FA(3) `Podmiot1/PrefiksPodatnika`, JPK_FA `P_4A` i PDF. Wymaga go usługa, dla
 * której miejsce świadczenia ustala się według art. 28b, na rzecz podatnika
 * z innego państwa UE (stawka „np II”, art. 100 ust. 1 pkt 4), bo art. 97
 * ust. 10 pkt 3 ustawy o VAT każe przy niej posługiwać się numerem z prefiksem
 * PL (RP-FA-VATUE-01). WDT (pkt 2) i transakcji trójstronnej (art. 136 ust. 1
 * pkt 3) FaktWay nie wystawia.
 */
export const SELLER_VAT_UE_PREFIX = 'PL';

/** Czy dokument ze stawkami pozycji `vatRates` wymaga prefiksu PL przy NIP sprzedawcy. */
export function sellerNeedsVatUePrefix(vatRates: Iterable<string | null | undefined>): boolean {
  for (const rate of vatRates) if (rate === 'np_ii') return true;
  return false;
}
