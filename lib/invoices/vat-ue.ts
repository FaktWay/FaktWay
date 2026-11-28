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

/**
 * Wzorce numerów VAT-UE według kraju (część po prefiksie), jak w dokumentacji
 * VIES. Plan zero, karta C2, S8. Austria ma literę „U”, Holandia „B” przed
 * numerem oddziału, Francja dwa znaki kontrolne, Irlandia dwie postacie.
 * Wzorzec sprawdza FORMĘ numeru, nie sumę kontrolną ani istnienie w VIES.
 */
const WZORCE_KRAJOWE: Record<KodUE, RegExp> = {
  AT: /^U\d{8}$/,
  BE: /^[01]\d{9}$/,
  BG: /^\d{9,10}$/,
  CY: /^\d{8}[A-Z]$/,
  CZ: /^\d{8,10}$/,
  DE: /^\d{9}$/,
  DK: /^\d{8}$/,
  EE: /^\d{9}$/,
  EL: /^\d{9}$/,
  ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^\d{8}$/,
  FR: /^[A-Z0-9]{2}\d{9}$/,
  HR: /^\d{11}$/,
  HU: /^\d{8}$/,
  IE: /^(?:\d{7}[A-Z]{1,2}|\d[A-Z+*]\d{5}[A-Z])$/,
  IT: /^\d{11}$/,
  LT: /^(?:\d{9}|\d{12})$/,
  LU: /^\d{8}$/,
  LV: /^\d{11}$/,
  MT: /^\d{8}$/,
  NL: /^\d{9}B\d{2}$/,
  PL: /^\d{10}$/,
  PT: /^\d{9}$/,
  RO: /^\d{2,10}$/,
  SE: /^\d{12}$/,
  SI: /^\d{8}$/,
  SK: /^\d{10}$/,
  XI: /^(?:\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
};

/**
 * Rozbiór numeru VAT-UE wpisywanego przez człowieka (formularz, API): oprócz
 * ogólnego wzorca XSD wymaga wzorca kraju, więc „DEDE123456789” (podwójny
 * prefiks), „AT123456789” (bez „U”) i „NL123456789001” (bez „B”) są odrzucane.
 * Dane już zapisane czyta luźny {@link parseVatUe}: starsza faktura z numerem
 * poza wzorcem nie może przestać się generować ani eksportować.
 */
export function parseVatUeInput(raw: string | null | undefined): ParsedVatUe | null {
  const parsed = parseVatUe(raw);
  return parsed && WZORCE_KRAJOWE[parsed.kodUE].test(parsed.numer) ? parsed : null;
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

/**
 * Identyfikator sprzedawcy do pokazania na ekranie i wydruku (ustalenie 28 planu
 * kompletnej aplikacji): przy stawce „np II” numer VAT UE z prefiksem PL, jak
 * `PrefiksPodatnika` w pliku FA(3) (RP-FA-VATUE-01), w innym razie NIP. `rates` to
 * stawki pozycji dokumentu, a przy korekcie także stanu przed i po
 * (`correctionEnvelopeVatRates`).
 */
export function sellerIdentifier(
  nip: string,
  rates: Iterable<string | null | undefined>,
): { label: 'VAT UE' | 'NIP'; value: string } {
  return sellerNeedsVatUePrefix(rates)
    ? { label: 'VAT UE', value: `${SELLER_VAT_UE_PREFIX}${nip}` }
    : { label: 'NIP', value: nip };
}

/**
 * Stawki pozycji stanów „przed” i „po” z koperty korekty (`special_data.correctionData`),
 * czyli te, które plik FA(3) korekty i JPK_FA biorą pod uwagę przy prefiksie PL. Pozycje
 * samego wiersza korekty mają tylko stan po, więc sam wiersz nie wystarcza.
 */
export function correctionEnvelopeVatRates(specialData: unknown): string[] {
  const envelope =
    specialData && typeof specialData === 'object'
      ? (specialData as { correctionData?: unknown }).correctionData
      : undefined;
  if (!envelope || typeof envelope !== 'object') return [];
  const rates: string[] = [];
  for (const key of ['linesBefore', 'linesAfter'] as const) {
    const lines = (envelope as Record<string, unknown>)[key];
    if (!Array.isArray(lines)) continue;
    for (const line of lines) {
      const rate = line && typeof line === 'object' ? (line as { vatRate?: unknown }).vatRate : undefined;
      if (typeof rate === 'string') rates.push(rate);
    }
  }
  return rates;
}
