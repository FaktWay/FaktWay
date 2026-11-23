import type {
  Invoice,
  InvoiceLineItem,
  VatRate,
  BuyerParty,
  SellerParty,
  PaymentInfo,
  InvoiceType,
} from '@/types/invoice';
import { receiptBuyerKind, receiptInvoiceIssues } from '@/lib/invoices/receipt-invoice';
import { isSaleDateWithinLimit, SALE_DATE_TOO_LATE_MESSAGE } from '@/lib/invoices/sale-date';
import { addressCountryForKodUE, isNpIiBuyerVat, parseVatUe } from '@/lib/invoices/vat-ue';

// ═══════════════════════════════════════════════════════════════
// Zaokrąglanie i konwersje liczbowe
// ═══════════════════════════════════════════════════════════════

/**
 * Zaokrąglenie do 2 miejsc (grosze) metodą "half away from zero" z korektą epsilon.
 *
 * Naiwna implementacja `Math.round(x * 100) / 100` ma znany bug z liczbami
 * które w IEEE 754 nie są reprezentowane dokładnie:
 *   Math.round(1.005 * 100) / 100 === 1    // ŹLE, powinno być 1.01
 *   bo 1.005 * 100 === 100.49999999999999
 *
 * Dodanie Number.EPSILON przed mnożeniem rozwiązuje najczęstsze przypadki
 * (typowe kwoty faktur). Dla bardzo dużych liczb (> 10^15) nadal może się
 * zemścić, ale tam i tak wpadamy w inne problemy precyzji.
 */
export function roundToCents(value: number): number {
  const sign = Math.sign(value);
  const abs = Math.abs(value);
  return (sign * Math.round((abs + Number.EPSILON) * 100)) / 100;
}

/**
 * Zaokrąglenie do N miejsc (używane dla cen jednostkowych P_9A - do 8 miejsc).
 */
export function roundToDecimals(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  const sign = Math.sign(value);
  const abs = Math.abs(value);
  return (sign * Math.round((abs + Number.EPSILON) * factor)) / factor;
}

const DECIMAL_NOTATION = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/;

/**
 * Liczba jako dokładny ułamek dziesiętny: wartość = cyfry / 10^miejsca.
 * `String(liczba)` to najkrótszy zapis dziesiętny, który wraca do tej samej
 * liczby, więc ilość 2,5 i cena 3,33 dają cyfry 25 i 333 (1 i 2 miejsca),
 * a nie rozwinięcie dwójkowe 3,3299…; zapis wykładniczy (1e-7, 1e+21) też.
 * Null dla NaN i nieskończoności.
 */
function decimalParts(value: number): { digits: bigint; places: number } | null {
  const match = DECIMAL_NOTATION.exec(String(value));
  if (!match) return null;
  const [, sign, whole, fraction = '', exponent = '+0'] = match;
  const places = fraction.length - Number(exponent);
  const scale = places < 0 ? BigInt(10) ** BigInt(-places) : BigInt(1);
  const digits = BigInt(whole + fraction) * scale;
  return { digits: sign === '-' ? -digits : digits, places: Math.max(places, 0) };
}

/**
 * Iloczyn dwóch kwot (ilość × cena) w groszach całkowitych, liczony dokładnie
 * na liczbach całkowitych (BigInt) i zaokrąglony do grosza: końcówki poniżej
 * 0,5 grosza pomija się, od 0,5 grosza w górę, symetrycznie dla kwot ujemnych
 * (art. 106e ust. 11 ustawy o VAT). Iloczyn liczb zmiennoprzecinkowych
 * potrafi wypaść tuż pod połówką: 2,5 × 3,33 = 8,325 dawało 8,32.
 */
export function multiplyToGrosze(a: number, b: number): number {
  return productToGrosze(a, b).grosze;
}

/** Grosze zaokrąglone połówką od zera i to, czy dokładna wartość leżała na połówce grosza. */
interface RoundedGrosze {
  grosze: number;
  half: boolean;
}

function productToGrosze(a: number, b: number): RoundedGrosze {
  const x = decimalParts(a);
  const y = decimalParts(b);
  // NaN i nieskończoność zostają jak w dawnym liczeniu (NaN, ±Infinity).
  if (!x || !y) return { grosze: a * b * 100, half: false };
  const product = x.digits * y.digits;
  const places = x.places + y.places;
  if (places <= 2) return { grosze: Number(product * BigInt(10) ** BigInt(2 - places)), half: false };
  const divisor = BigInt(10) ** BigInt(places - 2);
  const negative = product < BigInt(0);
  const magnitude = negative ? -product : product;
  const rounded = (magnitude * BigInt(2) + divisor) / (divisor * BigInt(2));
  return { grosze: Number(negative ? -rounded : rounded), half: (magnitude % divisor) * BigInt(2) === divisor };
}

/** Zapisane grosze to zaokrąglenie do grosza; na połówce także w stronę zera. */
function roundsTo(value: RoundedGrosze, stored: number): boolean {
  return stored === value.grosze || (value.half && stored === value.grosze - Math.sign(value.grosze));
}

/** Iloczyn dwóch kwot (ilość × cena) w złotych, do grosza jak `multiplyToGrosze`. */
export function multiplyToCents(a: number, b: number): number {
  return groszeToZloty(multiplyToGrosze(a, b));
}

// ═══════════════════════════════════════════════════════════════
// Kalkulacje faktury
// ═══════════════════════════════════════════════════════════════

/**
 * Mapa stawek VAT na wartości numeryczne do kalkulacji.
 * Stawki niematematyczne (zw, oo, np, np_ii) zawsze dają VAT=0.
 */
export function getVatPercentage(rate: VatRate): number {
  switch (rate) {
    case '23':
      return 23;
    case '8':
      return 8;
    case '5':
      return 5;
    case '0':
    case 'zw':
    case 'oo':
    case 'np':
    case 'np_ii':
      return 0;
  }
}

/**
 * Kalkulacja pojedynczej pozycji na podstawie quantity, unitPriceNet, vatRate.
 * Zwraca WSZYSTKIE pola numeryczne (netAmount, vatAmount, grossAmount).
 *
 * Netto = ilość × cena, VAT = netto × stawka, oba do grosza z połówką w górę
 * (art. 106e ust. 11), liczone na liczbach całkowitych: na liczbach
 * zmiennoprzecinkowych 2,5 × 3,33 dawało 8,32 zamiast 8,33, a 23 % od 35,50
 * dawało 8,16 zamiast 8,17. Faktury wystawione wcześniej mają w bazie kwoty
 * z dawnego liczenia: bramka wysyłki je przyjmuje (netto ±1 grosz, VAT także
 * od brutto), plik zwykłej faktury buduje się z kwot zapisu, a korekta bierze
 * stan przed z kwot zapisu pozycji (`recordedAmounts`), nie liczy go od nowa.
 */
export function calculateLineItem(
  input: Pick<InvoiceLineItem, 'quantity' | 'unitPriceNet' | 'vatRate'>,
  /**
   * Cena brutto pozycji faktury liczonej od brutto (korekta faktury za
   * abonament, `lib/billing/self-invoice.ts`): brutto = ilość × cena brutto,
   * VAT od brutto, netto = brutto − VAT (art. 106e ust. 7, 9, 10 i 11 ustawy
   * o VAT). Jawny argument, a nie pole pozycji: `unitPriceGross` pozycji
   * z importu (P_9B) nie zmienia wzoru. Bez niego VAT od netto jak dotąd.
   */
  opcje: { unitPriceGross?: number } = {},
): Pick<InvoiceLineItem, 'netAmount' | 'vatAmount' | 'grossAmount'> {
  const vatPercentage = getVatPercentage(input.vatRate);
  if (opcje.unitPriceGross !== undefined) {
    const grossGrosze = multiplyToGrosze(input.quantity, opcje.unitPriceGross);
    const vatGrosze = vatFromGrossGrosze(grossGrosze, vatPercentage);
    return {
      netAmount: groszeToZloty(grossGrosze - vatGrosze),
      // `+ 0`: bez zera ze znakiem przy groszowych kwotach ujemnych (anulowanie).
      vatAmount: groszeToZloty(vatGrosze) + 0,
      grossAmount: groszeToZloty(grossGrosze),
    };
  }
  const netGrosze = multiplyToGrosze(input.quantity, input.unitPriceNet);
  const vatGrosze = vatFromNetGrosze(netGrosze, vatPercentage);
  return {
    netAmount: groszeToZloty(netGrosze),
    vatAmount: groszeToZloty(vatGrosze) + 0,
    grossAmount: groszeToZloty(netGrosze + vatGrosze),
  };
}

/**
 * Sumy per stawka VAT (wymagane przez FA(3) pola P_13_1, P_14_1 dla 23%;
 * P_13_2, P_14_2 dla 8%; itd.).
 */
export interface VatSummaryPerRate {
  rate: VatRate;
  /** Suma netto w tej stawce */
  netSum: number;
  /** Suma VAT w tej stawce */
  vatSum: number;
}

export function summarizeVatPerRate(lines: InvoiceLineItem[]): VatSummaryPerRate[] {
  const map = new Map<VatRate, { net: number; vat: number }>();

  for (const line of lines) {
    const existing = map.get(line.vatRate) ?? { net: 0, vat: 0 };
    existing.net += line.netAmount;
    existing.vat += line.vatAmount;
    map.set(line.vatRate, existing);
  }

  return Array.from(map.entries()).map(([rate, sums]) => ({
    rate,
    netSum: roundToCents(sums.net),
    vatSum: roundToCents(sums.vat),
  }));
}

/**
 * Kwoty faktury korygującej według stawek = różnica między stanem po i przed
 * korektą (XSD FA(3): „kwota różnicy, o której mowa w art. 106j ust. 2 pkt 5”).
 * Liczona z PEŁNYCH stanów obu dokumentów, żeby zaokrąglenia VAT były te same
 * co na fakturze pierwotnej i na fakturze po korekcie. Stawki bez różnicy nie
 * są wykazywane. Jedna funkcja dla P_13/P_14 korekty w KSeF i dla JPK (S-01).
 */
export function differenceSummaries(before: InvoiceLineItem[], after: InvoiceLineItem[]): VatSummaryPerRate[] {
  const byRate = new Map<VatRate, VatSummaryPerRate>();
  for (const s of summarizeVatPerRate(after)) byRate.set(s.rate, { ...s });
  for (const s of summarizeVatPerRate(before)) {
    const cur = byRate.get(s.rate);
    byRate.set(s.rate, {
      rate: s.rate,
      netSum: (cur?.netSum ?? 0) - s.netSum,
      vatSum: (cur?.vatSum ?? 0) - s.vatSum,
    });
  }
  return [...byRate.values()]
    .map((s) => ({ rate: s.rate, netSum: roundToCents(s.netSum), vatSum: roundToCents(s.vatSum) }))
    .filter((s) => s.netSum !== 0 || s.vatSum !== 0);
}

/**
 * Totale całej faktury - sumy wszystkich pozycji.
 */
export interface InvoiceTotals {
  netTotal: number;
  vatTotal: number;
  grossTotal: number;
}

export function calculateInvoiceTotals(lines: ReadonlyArray<Pick<InvoiceLineItem, 'netAmount' | 'vatAmount'>>): InvoiceTotals {
  const netTotal = roundToCents(
    lines.reduce((sum, line) => sum + line.netAmount, 0)
  );
  const vatTotal = roundToCents(
    lines.reduce((sum, line) => sum + line.vatAmount, 0)
  );
  const grossTotal = roundToCents(netTotal + vatTotal);
  return { netTotal, vatTotal, grossTotal };
}

// ═══════════════════════════════════════════════════════════════
// finalizeInvoice - wejście userowskie → pełny Invoice
// ═══════════════════════════════════════════════════════════════

/** Pozycja jaką user podaje z formularza (bez wyliczeń). */
export type InvoiceLineItemInput = Pick<
  InvoiceLineItem,
  'ordinal' | 'name' | 'unit' | 'quantity' | 'unitPriceNet' | 'vatRate'
> &
  Partial<Pick<InvoiceLineItem, 'unitPriceGross'>>;

/** Faktura jaką user podaje z formularza (bez wyliczeń i totali). */
export interface InvoiceInput {
  internalNumber: string;
  type: InvoiceType;
  issueDate: string;
  saleDate?: string;
  seller: SellerParty;
  buyer: BuyerParty;
  lines: InvoiceLineItemInput[];
  payment: Omit<PaymentInfo, 'amountDue'>;
  notes?: string;
  /** Faktura do paragonu (FP): tylko zwykła faktura VAT. */
  receipt?: Invoice['receipt'];
  /** Faktura w cenach brutto: pozycje z `unitPriceGross`, VAT od sumy brutto stawki (`grossPricedLines`). */
  pricesGross?: true;
}

/**
 * Buduje pełny Invoice z wejścia userowskiego.
 * Zaokrągla każdą pozycję, liczy totale, ustawia amountDue = grossTotal.
 * Single source of truth = pozycje; pola kwotowe na Invoice to derived state.
 */
export function finalizeInvoice(input: InvoiceInput): Invoice {
  const lines: InvoiceLineItem[] = input.pricesGross ? grossPricedLines(input.lines) : input.lines.map((raw) => {
    const { netAmount, vatAmount, grossAmount } = calculateLineItem(raw);
    return {
      ordinal: raw.ordinal,
      name: raw.name,
      unit: raw.unit,
      quantity: raw.quantity,
      unitPriceNet: raw.unitPriceNet,
      vatRate: raw.vatRate,
      netAmount,
      vatAmount,
      grossAmount,
    };
  });

  const { netTotal, vatTotal, grossTotal } = calculateInvoiceTotals(lines);

  return {
    internalNumber: input.internalNumber,
    type: input.type,
    issueDate: input.issueDate,
    saleDate: input.saleDate,
    seller: input.seller,
    buyer: input.buyer,
    lines,
    netTotal,
    vatTotal,
    grossTotal,
    payment: {
      ...input.payment,
      amountDue: grossTotal,
    },
    notes: input.notes,
    // Klucz tylko przy FP: zwykła faktura ma kształt jak przed krokiem 1.2.
    ...(input.receipt ? { receipt: input.receipt } : {}),
    // Klucz tylko przy cenach brutto: faktura w cenach netto ma kształt jak dotąd.
    ...(input.pricesGross ? { pricesGross: true as const } : {}),
  };
}

/**
 * Rozkład VAT nagłówka `total` na pozycje: udział = podstawa × stawka / mianownik
 * (brutto: 100 + stawka, netto: 100), w dół; brakujące grosze do największych
 * reszt (porównanie na krzyż — różne mianowniki przy 23% i 22%), remis — niższy
 * numer pozycji, potem kolejność w pliku. `null`, gdy `total` poza [Σ w dół, Σ w górę].
 * Jeden podział dla importu faktur od brutto i netto (C5c, `lib/import/fa3-line-amounts.ts`)
 * i faktury FaktWay w cenach brutto (`grossPricedLines`).
 */
export function allocateLargestRemainder(
  shares: ReadonlyArray<{ num: number; den: number; ordinal: number; index: number }>,
  total: number,
): { vats: number[]; floor: number; ceil: number } | { vats: null; floor: number; ceil: number } {
  const parts = shares.map((s) => {
    const fl = Math.floor(s.num / s.den);
    return { ...s, fl, rem: s.num - fl * s.den };
  });
  const floor = parts.reduce((a, p) => a + p.fl, 0);
  const ceil = parts.reduce((a, p) => a + p.fl + (p.rem > 0 ? 1 : 0), 0);
  if (total < floor || total > ceil) return { vats: null, floor, ceil };
  const order = parts
    .map((p, i) => ({ ...p, i }))
    .filter((p) => p.rem > 0)
    .sort((a, b) => (b.rem * a.den - a.rem * b.den) || (a.ordinal - b.ordinal) || (a.index - b.index));
  const vats = parts.map((p) => p.fl);
  for (const p of order.slice(0, total - floor)) vats[p.i]! += 1;
  return { vats, floor, ceil };
}

/**
 * Pozycje faktury w cenach brutto (art. 106e ust. 7-9 i 11 ustawy o VAT):
 * wartość brutto pozycji = ilość × cena brutto do grosza (`P_11A`); w każdej
 * stawce VAT od sumy brutto stawki, KP = WB × SP / (100 + SP), do grosza
 * (`vatFromGrossGrosze`); netto stawki = WB − KP. VAT stawki dzielony na
 * pozycje tym samym podziałem co import faktur od brutto (C5c,
 * `allocateLargestRemainder`): każda pozycja dostaje swój udział w dół albo
 * w górę, a suma pozycji = KP. Netto pozycji = brutto − VAT. Cena netto pusta
 * (`unitPriceNetMissing`). Stawka spoza listy liczy się tu jako 0 %, ale bramka
 * wysyłki (`validateInvoice`) odmawia jej z numerem pozycji.
 */
export function grossPricedLines(input: InvoiceLineItemInput[]): InvoiceLineItem[] {
  // Ilość × cena brutto dokładnie (art. 106e ust. 11). Pozycja bez ceny brutto zostaje bez niej
  // (brutto 0): brak ceny nie staje się ceną 0 zł, a bramka wysyłki odmawia z numerem pozycji.
  const gross = input.map((raw) =>
    raw.unitPriceGross !== undefined && Number.isFinite(raw.unitPriceGross) ? multiplyToGrosze(raw.quantity, raw.unitPriceGross) : 0,
  );
  const vat = input.map(() => 0);
  for (const rate of new Set(input.map((l) => l.vatRate))) {
    const pct = getVatPercentage(rate) ?? 0;
    const den = 100 + pct;
    const idx = input.flatMap((l, i) => (l.vatRate === rate ? [i] : []));
    const kp = vatFromGrossGrosze(idx.reduce((s, i) => s + gross[i]!, 0), pct);
    // Udział pozycji g × SP / (100 + SP) w groszach; KP od sumy zawsze mieści się
    // między sumą udziałów w dół i w górę (zaokrąglenie sumy), więc podział istnieje.
    const podzial = allocateLargestRemainder(
      idx.map((i) => ({ num: gross[i]! * pct, den, ordinal: input[i]!.ordinal, index: i })),
      kp,
    );
    if (!podzial.vats) {
      throw new Error(`Faktura w cenach brutto: VAT stawki ${rate} (${kp} gr) poza podziałem na pozycje.`);
    }
    idx.forEach((i, k) => {
      vat[i] = podzial.vats[k]!;
    });
  }
  return input.map((raw, i) => ({
    ordinal: raw.ordinal,
    name: raw.name,
    unit: raw.unit,
    quantity: raw.quantity,
    unitPriceNet: 0,
    unitPriceNetMissing: true as const,
    ...(raw.unitPriceGross !== undefined ? { unitPriceGross: raw.unitPriceGross } : {}),
    vatRate: raw.vatRate,
    netAmount: groszeToZloty(gross[i]! - vat[i]!),
    vatAmount: groszeToZloty(vat[i]!),
    grossAmount: groszeToZloty(gross[i]!),
  }));
}

// ═══════════════════════════════════════════════════════════════
// Walidacje podstawowe (NIP, IBAN, daty)
// ═══════════════════════════════════════════════════════════════

/**
 * Walidacja polskiego NIP (10 cyfr + suma kontrolna mod 11).
 * Jeśli mod=10, NIP jest z definicji niepoprawny (żadna cyfra nie może być 10).
 */
export function validateNipChecksum(nip: string): boolean {
  if (!/^\d{10}$/.test(nip)) return false;
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const digits = nip.split('').map(Number);
  const checksum = digits.slice(0, 9).reduce((sum, d, i) => sum + d * weights[i], 0);
  const mod = checksum % 11;
  return mod < 10 && mod === digits[9];
}

/** PESEL — 11 cyfr + algorytm sumy kontrolnej (jak w GUS/regon). */
export function validatePeselChecksum(pesel: string): boolean {
  if (!/^\d{11}$/.test(pesel)) return false;
  const weights = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += parseInt(pesel[i], 10) * weights[i];
  }
  const checksum = (10 - (sum % 10)) % 10;
  return checksum === parseInt(pesel[10], 10);
}

/**
 * Numer rachunku w postaci IBAN: bez spacji i myślników, wielkie litery,
 * a polski NRB (26 cyfr — tak go wpisuje większość klientów i tak podpowiada
 * formularz) dostaje „PL”. Do 01.10.2026 walidacja faktury wymagała kodu
 * kraju, więc zwykły numer rachunku przechodził formularz i dopiero wysyłka
 * do KSeF padała na „nieprawidłowy format IBAN”.
 */
export function normalizeIban(raw: string): string {
  const clean = raw.replace(/[\s-]/g, '').toUpperCase();
  return /^\d{26}$/.test(clean) ? `PL${clean}` : clean;
}

/**
 * Walidacja IBAN (dowolny kraj, ale zoptymalizowane pod PL).
 * Format: 2 litery kraju + 2 cyfry kontrolne + BBAN (max 30 znaków).
 * Algorytm mod-97: przesuwamy 4 pierwsze znaki na koniec, zamieniamy litery
 * na liczby (A=10, B=11, ...), cała wartość mod 97 musi dać 1.
 */
export function validateIban(iban: string): boolean {
  const clean = normalizeIban(iban);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(clean)) return false;

  const rearranged = clean.slice(4) + clean.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (ch) =>
    (ch.charCodeAt(0) - 55).toString()
  );

  // Mod 97 na dużym stringu cyfr (bez BigInt) - kawałkami po 9 cyfr.
  let remainder = '';
  for (const digit of numeric) {
    remainder += digit;
    if (remainder.length >= 9) {
      remainder = (parseInt(remainder, 10) % 97).toString();
    }
  }
  return parseInt(remainder, 10) % 97 === 1;
}

/**
 * Walidacja daty w formacie ISO RRRR-MM-DD (bez czasu).
 * Zwraca Date lub null jeśli format zły.
 */
export function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + 'T00:00:00Z');
  if (Number.isNaN(date.getTime())) return null;
  // Sprawdź że nie było "normalizacji" (np. 2026-02-31 → 2026-03-03)
  const [y, m, d] = value.split('-').map(Number);
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() + 1 !== m ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return date;
}

// ═══════════════════════════════════════════════════════════════
// validateInvoice - pełna walidacja biznesowa faktury
// ═══════════════════════════════════════════════════════════════

/** Minimalna data wystawienia faktury FA(3) wg XSD (DataWytworzeniaFa). */
const FA3_MIN_ISSUE_DATE = new Date('2025-09-01T00:00:00Z');

/** Maksymalne wyprzedzenie daty wystawienia względem today (30 dni). */
const MAX_ISSUE_DATE_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Zakres daty wystawienia — wspólny dla `validateInvoice` (wysyłka do KSeF)
 * i formularza. Reguła sprawdzana tylko przy wysyłce przepuszczała fakturę
 * przez zapis, a job oznaczał ją jako nieudaną bez możliwości poprawki.
 */
export function issueDateRangeErrors(issueDateIso: string, now: Date = new Date()): string[] {
  const issueDate = parseIsoDate(issueDateIso);
  if (!issueDate) {
    return [`Data wystawienia "${issueDateIso}" ma nieprawidłowy format (oczekiwane RRRR-MM-DD).`];
  }
  const errors: string[] = [];
  if (issueDate < FA3_MIN_ISSUE_DATE) {
    errors.push(`Data wystawienia ${issueDateIso} jest wcześniejsza niż minimalna data FA(3) (2025-09-01).`);
  }
  if (issueDate.getTime() - now.getTime() > MAX_ISSUE_DATE_AHEAD_MS) {
    errors.push(`Data wystawienia ${issueDateIso} jest więcej niż 30 dni w przyszłości.`);
  }
  return errors;
}

/**
 * Kwota w groszach całkowitych: porównania kwot bez błędów liczb
 * zmiennoprzecinkowych (FZ-008). Najpierw grosz jak wszędzie
 * (`roundToCents`), potem ×100 domknięte do liczby całkowitej
 * (`roundToDecimals(…, 0)`), bez nowych zaokrągleń obok tych dwóch.
 */
export function toGrosze(value: number): number {
  return roundToDecimals(roundToCents(value) * 100, 0);
}

/** Grosze z powrotem na złote do komunikatu (jak reszta komunikatów: liczba, np. 20.99). */
function groszeToZloty(grosze: number): number {
  return grosze / 100;
}

/**
 * Granica 1 grosza dla netto pozycji i sum faktury, jak od pierwszej wersji
 * walidatora. Do FZ-008 liczona na liczbach zmiennoprzecinkowych (0,01), więc
 * różnica dokładnie 1 grosza raz przechodziła, a raz nie. XML bierze sumy
 * z pozycji (`generateFA3Xml`), więc ta granica nie trafia do pliku.
 */
const AMOUNT_TOLERANCE_GROSZE = 1;

function amountsDiffer(a: number, b: number): boolean {
  return Math.abs(toGrosze(a) - toGrosze(b)) > AMOUNT_TOLERANCE_GROSZE;
}

/** num / den do liczby całkowitej, połówka od zera (jak `roundToCents`); den > 0, liczby całkowite. */
function divRoundHalfAway(num: number, den: number): number {
  const q = Math.floor((2 * Math.abs(num) + den) / (2 * den));
  return num < 0 ? -q : q;
}

/** VAT od netto w groszach (art. 106e ust. 1 pkt 14 i ust. 11): netto × stawka / 100. */
function vatFromNetGrosze(netGrosze: number, ratePct: number): number {
  return divRoundHalfAway(ratePct * netGrosze, 100);
}

/**
 * VAT od netto w złotych do grosza (art. 106e ust. 1 pkt 14 i ust. 11): netto × stawka / 100,
 * od 0,5 grosza w górę (symetrycznie dla kwot ujemnych), liczony na groszach całkowitych.
 * Dla kwot z miejscami do grosza; `roundToCents(netto × stawka)` na liczbach zmiennoprzecinkowych
 * zaokrągla część połówek w dół (5 % od 80,30 zł = 4,015 dawało 4,01, a 23 % od 35,50 zł
 * w zapisie `netto × stawka / 100` dawało 8,16). Bez zera ze znakiem.
 */
export function vatFromNetCents(net: number, ratePct: number): number {
  return groszeToZloty(vatFromNetGrosze(toGrosze(net), ratePct)) + 0;
}

/**
 * Czy zapisane kwoty pozycji wynikają z ilości × ceny netto i VAT od netto,
 * każda kwota do grosza (art. 106e ust. 11), z połówką grosza zaokrągloną
 * w dowolną stronę. Dawne liczenie (do naprawy ilość × cena) zaokrąglało
 * iloczyn na połówce czasem w dół: 2,5 × 3,33 = 8,32, a 23 % od 35,50 = 8,16.
 * Pozycje takich faktur są liczone od netto, nie od brutto (korekta,
 * `lib/invoices/issue-correction.ts`). VAT sprawdza się od zapisanego netto,
 * bo tak liczyło też dawne liczenie.
 */
export function amountsFollowNetPrice(
  line: Pick<InvoiceLineItem, 'quantity' | 'unitPriceNet' | 'vatRate'>,
  amounts: Pick<InvoiceLineItem, 'netAmount' | 'vatAmount' | 'grossAmount'>,
): boolean {
  const ratePct: number | undefined = getVatPercentage(line.vatRate);
  if (ratePct === undefined) return false;
  const netGr = toGrosze(amounts.netAmount);
  const vatGr = toGrosze(amounts.vatAmount);
  if (toGrosze(amounts.grossAmount) !== netGr + vatGr) return false;
  if (!roundsTo(productToGrosze(line.quantity, line.unitPriceNet), netGr)) return false;
  const vatHalf = Math.abs(ratePct * netGr) % 100 === 50;
  return roundsTo({ grosze: vatFromNetGrosze(netGr, ratePct), half: vatHalf }, vatGr);
}

/** VAT od brutto w groszach (art. 106e ust. 7 i ust. 11): brutto × stawka / (100 + stawka). */
export function vatFromGrossGrosze(grossGrosze: number, ratePct: number): number {
  return divRoundHalfAway(ratePct * grossGrosze, 100 + ratePct);
}

/**
 * Czy VAT pozycji wynika z jej netto albo brutto według ustawy o VAT (FZ-008):
 * od netto (art. 106e ust. 1 pkt 14) albo od brutto (ust. 7; netto to wtedy
 * brutto − VAT, ust. 9), w obu przypadkach do grosza (ust. 11). Brutto pozycji
 * to netto + VAT (sprawdzane osobno), więc wzór od brutto liczy się z N + V.
 * VAT od netto jest zawsze też VAT od brutto dla B = N + V, więc druga metoda
 * dodaje tylko kwoty, przy których VAT od brutto różni się o grosz (przy 23 %
 * ok. 19 % kwot brutto). Faktura za abonament FaktWay liczy się od brutto
 * (`lib/billing/self-invoice.ts`, RPC `create_billing_vat_invoice`), bo Stripe
 * pobiera kwotę brutto.
 */
export function lineVatMatchesRate(netGrosze: number, vatGrosze: number, ratePct: number): boolean {
  return vatGrosze === vatFromNetGrosze(netGrosze, ratePct)
    || vatGrosze === vatFromGrossGrosze(netGrosze + vatGrosze, ratePct);
}

const ZERO_VAT_RATE_LABELS: Partial<Record<VatRate, string>> = {
  '0': '0%', zw: 'zw', oo: 'oo', np: 'np', np_ii: 'np II',
};

/**
 * Stawki bez podatku w fakturze w cenach brutto: odmowa z wyjściem (ceny netto).
 * Art. 106e ust. 7 i 8 to podatek od wartości brutto i cena brutto zamiast netto;
 * przy zwolnieniu, odwrotnym obciążeniu i „nie podlega” podatku nie ma, a czy plik
 * może wtedy mieć P_9B i P_11A, rozstrzyga księgowa (RP-FA-BRUTTO-01). Stawka 0 %
 * to stawka podatku (od brutto wychodzi 0 zł), więc zostaje.
 */
export const GROSS_PRICES_UNTAXED_RATES: ReadonlySet<VatRate> = new Set<VatRate>(['zw', 'oo', 'np', 'np_ii']);

/**
 * Odmowa stawki bez podatku w fakturze w cenach brutto: to samo zdanie w bramce
 * wysyłki (z numerem pozycji) i w formularzu (bez numeru, przy polu stawki pozycji).
 */
export function grossPricesUntaxedRateMessage(rate: VatRate, ordinal?: number): string {
  const text = `„${ZERO_VAT_RATE_LABELS[rate] ?? rate}” nie ma podatku, więc faktura w cenach brutto jej nie obsługuje. Wystaw fakturę w cenach netto.`;
  return ordinal === undefined ? `Stawka ${text}` : `Pozycja ${ordinal}: stawka ${text}`;
}

function lineVatMessage(line: InvoiceLineItem, netGr: number, vatGr: number, ratePct: number): string {
  if (ratePct === 0) {
    return `Pozycja ${line.ordinal}: stawka „${ZERO_VAT_RATE_LABELS[line.vatRate] ?? line.vatRate}” nie ma VAT, a pozycja ma VAT ${line.vatAmount}.`;
  }
  const fromNet = vatFromNetGrosze(netGr, ratePct);
  const grossGr = netGr + vatGr;
  const fromGross = vatFromGrossGrosze(grossGr, ratePct);
  return (
    `Pozycja ${line.ordinal}: VAT (${line.vatAmount}) nie wynika ze stawki ${ratePct}%: ` +
    `od netto ${line.netAmount} wychodzi ${groszeToZloty(fromNet)}, ` +
    `a od brutto ${groszeToZloty(grossGr)} wychodzi ${groszeToZloty(fromGross)}.`
  );
}

export function validateInvoice(invoice: Invoice, now: Date = new Date()): string[] {
  const errors: string[] = [];

  // ── Sprzedawca ─────────────────────────────────────────────
  if (!validateNipChecksum(invoice.seller.nip)) {
    errors.push(`NIP sprzedawcy "${invoice.seller.nip}" ma nieprawidłową sumę kontrolną.`);
  }

  // ── Nabywca: dokładnie jeden identyfikator ─────────────────
  const buyerIdCount =
    (invoice.buyer.nip ? 1 : 0) +
    (invoice.buyer.vatUeNumber ? 1 : 0) +
    (invoice.buyer.noIdMarker ? 1 : 0) +
    (invoice.buyer.pesel?.trim() ? 1 : 0) +
    (invoice.buyer.nrInny?.trim() ? 1 : 0);
  if (buyerIdCount === 0) {
    errors.push(
      'Nabywca musi mieć ustawiony dokładnie jeden identyfikator (NIP, VAT UE, PESEL, nr inny dokumentu lub „brak ID”).'
    );
  } else if (buyerIdCount > 1) {
    errors.push(
      'Nabywca może mieć tylko jeden identyfikator (NIP, VAT UE, PESEL, dokument lub marker braku ID).'
    );
  }
  if (invoice.buyer.nip && !validateNipChecksum(invoice.buyer.nip)) {
    errors.push(`NIP nabywcy "${invoice.buyer.nip}" ma nieprawidłową sumę kontrolną.`);
  }
  if (invoice.buyer.pesel && !validatePeselChecksum(invoice.buyer.pesel)) {
    errors.push(`PESEL nabywcy ma nieprawidłową sumę kontrolną.`);
  }
  errors.push(...buyerVatUeErrors(invoice));

  // ── Daty ───────────────────────────────────────────────────
  const issueDate = parseIsoDate(invoice.issueDate);
  errors.push(...issueDateRangeErrors(invoice.issueDate, now));

  if (invoice.saleDate !== undefined) {
    const saleDate = parseIsoDate(invoice.saleDate);
    if (!saleDate) {
      errors.push(`Data sprzedaży "${invoice.saleDate}" ma nieprawidłowy format.`);
    } else if (issueDate && !isSaleDateWithinLimit(invoice.issueDate, invoice.saleDate)) {
      errors.push(SALE_DATE_TOO_LATE_MESSAGE);
    }
  }

  const dueDate = parseIsoDate(invoice.payment.dueDate);
  if (!dueDate) {
    errors.push(`Termin płatności "${invoice.payment.dueDate}" ma nieprawidłowy format.`);
  } else if (issueDate && dueDate < issueDate) {
    errors.push('Termin płatności nie może być wcześniejszy niż data wystawienia.');
  }

  // ── Pozycje ────────────────────────────────────────────────
  if (invoice.lines.length === 0) {
    errors.push('Faktura musi mieć co najmniej jedną pozycję.');
  }

  // Faktura w cenach brutto: pozycja liczy brutto z ceny brutto, a VAT jest
  // podziałem VAT stawki (sprawdzany niżej sumą stawki), więc bez kontroli
  // netto = ilość × cena netto i VAT pozycji od netto albo brutto.
  const pricesGross = invoice.pricesGross === true;
  for (const line of invoice.lines) {
    if (line.name.length === 0 || line.name.length > 512) {
      errors.push(`Pozycja ${line.ordinal}: nazwa musi mieć 1-512 znaków (obecnie ${line.name.length}).`);
    }
    if (line.quantity <= 0) {
      errors.push(`Pozycja ${line.ordinal}: ilość musi być > 0.`);
    }
    if (pricesGross) {
      const priceGross = line.unitPriceGross;
      if (priceGross === undefined || !Number.isFinite(priceGross) || priceGross < 0) {
        errors.push(`Pozycja ${line.ordinal}: faktura w cenach brutto wymaga ceny brutto pozycji (nieujemnej).`);
      } else if (multiplyToGrosze(line.quantity, priceGross) !== toGrosze(line.grossAmount)) {
        errors.push(
          `Pozycja ${line.ordinal}: brutto (${line.grossAmount}) nie zgadza się z ilość × cena brutto (${multiplyToCents(line.quantity, priceGross)}).`,
        );
      }
      if (toGrosze(line.grossAmount) !== toGrosze(line.netAmount) + toGrosze(line.vatAmount)) {
        errors.push(
          `Pozycja ${line.ordinal}: brutto (${line.grossAmount}) to nie netto + VAT (${groszeToZloty(toGrosze(line.netAmount) + toGrosze(line.vatAmount))}).`,
        );
      }
      const linePct = getVatPercentage(line.vatRate) as number | undefined;
      if (linePct === undefined) {
        errors.push(`Pozycja ${line.ordinal}: nieznana stawka VAT „${line.vatRate}”. Wybierz w pozycji stawkę z listy formularza.`);
      } else if (GROSS_PRICES_UNTAXED_RATES.has(line.vatRate)) {
        errors.push(grossPricesUntaxedRateMessage(line.vatRate, line.ordinal));
      } else {
        // VAT pozycji to jej udział w VAT stawki (brutto × stawka / (100 + stawka)) w dół albo
        // w górę (`grossPricedLines`): te kwoty idą do JPK i KPiR, więc podział 0,57 / −0,01 / 0
        // przy poprawnej sumie stawki też jest błędem.
        const share = toGrosze(line.grossAmount) * linePct;
        const den = 100 + linePct;
        const low = Math.floor(share / den);
        const high = share % den === 0 ? low : low + 1;
        const vatGr = toGrosze(line.vatAmount);
        if (vatGr < low || vatGr > high) {
          errors.push(
            `Pozycja ${line.ordinal}: VAT (${line.vatAmount}) to nie udział pozycji w VAT stawki: od brutto ${line.grossAmount} ` +
              `przy ${linePct}% wychodzi ${groszeToZloty(low)}${high === low ? '' : ` albo ${groszeToZloty(high)}`}.`,
          );
        }
      }
      continue;
    }
    if (line.unitPriceNet < 0) {
      errors.push(`Pozycja ${line.ordinal}: cena netto nie może być ujemna.`);
    }

    const calculated = calculateLineItem(line);
    if (amountsDiffer(calculated.netAmount, line.netAmount)) {
      errors.push(
        `Pozycja ${line.ordinal}: netAmount (${line.netAmount}) nie zgadza się z ` +
          `quantity * unitPriceNet (${calculated.netAmount}).`
      );
    }
    // FZ-008: VAT od netto albo od brutto (art. 106e), w groszach całkowitych.
    const netGr = toGrosze(line.netAmount);
    const vatGr = toGrosze(line.vatAmount);
    const ratePct: number | undefined = getVatPercentage(line.vatRate);
    if (ratePct === undefined) {
      errors.push(`Pozycja ${line.ordinal}: nieznana stawka VAT „${line.vatRate}”. Wybierz w pozycji stawkę z listy formularza.`);
    } else if (!lineVatMatchesRate(netGr, vatGr, ratePct)) {
      errors.push(lineVatMessage(line, netGr, vatGr, ratePct));
    }
    if (toGrosze(line.grossAmount) !== netGr + vatGr) {
      errors.push(
        `Pozycja ${line.ordinal}: brutto (${line.grossAmount}) to nie netto + VAT (${groszeToZloty(netGr + vatGr)}).`
      );
    }
  }

  // Faktura w cenach brutto: VAT każdej stawki od sumy brutto stawki (art. 106e ust. 7, 11).
  if (pricesGross) {
    for (const rate of new Set(invoice.lines.map((l) => l.vatRate))) {
      // Stawka spoza listy: odmowa z numerem pozycji wyżej, bez liczenia jej jako 0 %.
      if ((getVatPercentage(rate) as number | undefined) === undefined) continue;
      const inRate = invoice.lines.filter((l) => l.vatRate === rate);
      const wb = inRate.reduce((s, l) => s + toGrosze(l.grossAmount), 0);
      const vatGr = inRate.reduce((s, l) => s + toGrosze(l.vatAmount), 0);
      const kp = vatFromGrossGrosze(wb, getVatPercentage(rate) ?? 0);
      if (vatGr !== kp) {
        errors.push(
          `Stawka ${ZERO_VAT_RATE_LABELS[rate] ?? `${rate}%`}: VAT pozycji (${groszeToZloty(vatGr)}) nie wynika z sumy brutto stawki (${groszeToZloty(wb)}); powinien być ${groszeToZloty(kp)} (art. 106e ust. 7 ustawy o VAT).`,
        );
      }
    }
  }

  // ── Totale całej faktury ───────────────────────────────────
  const totals = calculateInvoiceTotals(invoice.lines);
  if (amountsDiffer(totals.netTotal, invoice.netTotal)) {
    errors.push(
      `Suma netto faktury (${invoice.netTotal}) nie zgadza się z sumą pozycji (${totals.netTotal}).`
    );
  }
  if (amountsDiffer(totals.vatTotal, invoice.vatTotal)) {
    errors.push(
      `Suma VAT faktury (${invoice.vatTotal}) nie zgadza się z sumą pozycji (${totals.vatTotal}).`
    );
  }
  if (amountsDiffer(totals.grossTotal, invoice.grossTotal)) {
    errors.push(
      `Suma brutto faktury (${invoice.grossTotal}) nie zgadza się z sumą pozycji (${totals.grossTotal}).`
    );
  }

  // ── Sumy per stawka muszą zgadzać się z totalem netto ──────
  const perRate = summarizeVatPerRate(invoice.lines);
  const netPerRateSum = roundToCents(perRate.reduce((s, r) => s + r.netSum, 0));
  if (amountsDiffer(netPerRateSum, invoice.netTotal)) {
    errors.push(
      `Suma netto per stawka VAT (${netPerRateSum}) nie zgadza się z sumą netto faktury (${invoice.netTotal}).`
    );
  }

  // ── Płatność ───────────────────────────────────────────────
  if (amountsDiffer(invoice.payment.amountDue, invoice.grossTotal)) {
    errors.push(
      `Kwota do zapłaty (${invoice.payment.amountDue}) nie zgadza się z kwotą brutto (${invoice.grossTotal}).`
    );
  }

  if (invoice.payment.method === 'transfer') {
    if (!invoice.payment.bankAccount) {
      errors.push('Dla płatności przelewem wymagany jest numer rachunku bankowego.');
    } else if (!validateIban(invoice.payment.bankAccount)) {
      errors.push(`Numer rachunku "${invoice.payment.bankAccount}" ma nieprawidłowy format IBAN.`);
    }
  }

  // ── Zwolnienie z VAT ───────────────────────────────────────
  // FA(3): stawka 'zw' wymaga P_19 + podstawy prawnej (P_19A).
  if (invoice.lines.some((l) => l.vatRate === 'zw') && !invoice.annotations?.vatExemptionBasis?.trim()) {
    errors.push(ZW_WITHOUT_BASIS_MESSAGE);
  }

  // ── Faktura do paragonu (FP, krok 1.2) ─────────────────────
  // Te same reguły co formularz (`lib/invoices/receipt-invoice.ts`): szkic,
  // job wysyłki i ponowienie z kopii nie wyślą FP, której formularz by nie przyjął.
  if (invoice.receipt !== undefined) {
    for (const issue of receiptInvoiceIssues({
      receipt: invoice.receipt,
      invoiceType: invoice.type,
      issueDate: invoice.issueDate,
      saleDate: invoice.saleDate,
      buyerKind: receiptBuyerKind(invoice.buyer),
      grossTotal: invoice.grossTotal,
    })) {
      errors.push(issue.message);
    }
  }

  return errors;
}

/**
 * Numer VAT-UE nabywcy i stawka „np II” (AUD-70).
 *
 * - numer musi dać się zapisać w XSD: prefiks z `TKodyKrajowUE` (Grecja „EL”)
 *   i numer zgodny z `TNrVatUE` — inaczej KSeF odrzuca XML,
 * - „np II” (usługi z art. 100 ust. 1 pkt 4 — art. 28b, VAT rozlicza nabywca)
 *   wymaga nabywcy-podatnika z INNEGO państwa UE, czyli numeru VAT-UE
 *   z prefiksem innym niż „PL” i „XI” (`isNpIiBuyerVat`),
 * - nabywca z zagranicznym VAT-UE ma adres za granicą (`Adres/KodKraju` to
 *   kod ISO — dla Grecji „GR”, nie „EL”).
 */
function buyerVatUeErrors(invoice: Invoice): string[] {
  const errors: string[] = [];
  const raw = invoice.buyer.vatUeNumber;
  const parsed = raw ? parseVatUe(raw) : null;

  if (raw && !parsed) {
    errors.push(
      `Numer VAT-UE nabywcy "${raw}" jest nieprawidłowy: oczekiwano prefiksu kraju UE ` +
        '(Grecja to „EL”, nie „GR”) i do 12 znaków (cyfry, wielkie litery, „+”, „*”), np. „DE123456789”.'
    );
  }

  const npIiOrdinals = invoice.lines.filter((l) => l.vatRate === 'np_ii').map((l) => l.ordinal);
  if (npIiOrdinals.length > 0 && !isNpIiBuyerVat(raw)) {
    const label = npIiOrdinals.length === 1 ? 'Pozycja' : 'Pozycje';
    errors.push(
      `${label} ${npIiOrdinals.join(', ')}: stawka „np II” (usługi z art. 100 ust. 1 pkt 4 ustawy o VAT) ` +
        'wymaga nabywcy — podatnika z innego państwa UE — z numerem VAT-UE (np. „DE123456789”). ' +
        'Dla nabywcy z NIP, z polskim VAT-UE, z Irlandii Płn. (XI — numer tylko dla towarów) ' +
        'albo bez numeru wybierz inną stawkę.'
    );
  }

  if (parsed && parsed.kodUE !== 'PL') {
    const country = (invoice.buyer.address?.countryCode ?? '').trim().toUpperCase();
    if (!country || country === 'PL') {
      errors.push(
        `Nabywca z numerem VAT-UE ${parsed.kodUE} musi mieć kraj w adresie inny niż Polska ` +
          `(np. „${addressCountryForKodUE(parsed.kodUE)}”).`
      );
    }
  }

  return errors;
}

/** Wspólny komunikat walidacji i generatora — człowiek wie, gdzie to ustawić. */
export const ZW_WITHOUT_BASIS_MESSAGE =
  'Pozycja ze stawką „zw” wymaga podstawy prawnej zwolnienia z VAT. Ustaw ją w Ustawieniach → Podatek VAT (np. „art. 113 ust. 1 ustawy o VAT”).';
