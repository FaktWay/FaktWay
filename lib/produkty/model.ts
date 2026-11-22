import { z } from 'zod';

import {
  GTU_CODE_MESSAGE,
  GTU_CODES,
  PKWIU_MAX_LENGTH,
  PKWIU_PATTERN,
  PKWIU_PATTERN_MESSAGE,
} from '@/lib/invoices/line-codes';
import { vatRateEnum } from '@/lib/schemas/invoice-form';
import { GROSS_PRICES_UNTAXED_RATES } from '@/lib/xml/invoice-calculator';
import type { GtuCode } from '@/types/invoice';

/**
 * Katalog produktów i usług firmy (plan kompletnej aplikacji, krok 2.6, część 1)
 * na tabeli `products` (00013, unikalny klucz nazwa + jednostka z 00186).
 * Jeden schemat dla formularza (klient) i akcji zapisu (serwer): AGENTS.md,
 * „Formularze”. Granice jak w bazie: cena NUMERIC(15,2), reszta tekst.
 *
 * Cena brutto produktu (plan cen brutto, PR (d), kolumna `default_price_gross`
 * z 00213) obok ceny netto: faktura w cenach netto bierze cenę netto, faktura
 * w cenach brutto cenę brutto (art. 106e ust. 8 ustawy o VAT: cena jednostkowa
 * brutto zamiast netto). Katalog żadnej z nich nie wylicza z drugiej. Cenę
 * brutto pokazuje i zapisuje tylko włączony wyłącznik `grossPricesEnabled`
 * (#884): ekran przy wyłączonym nie wysyła pola, a pole, które nie przyszło,
 * zostawia zapisaną cenę brutto (`undefined` w danych po walidacji).
 */

/** Stawki VAT jak w formularzu faktury: ta sama lista (`vatRateEnum`), nie nowa. */
export const PRODUCT_VAT_RATES = vatRateEnum.options;
export type ProductVatRate = (typeof PRODUCT_VAT_RATES)[number];

/** Etykiety stawek jak na PDF faktury; „np. II” jak w formularzu faktury. */
export const PRODUCT_VAT_RATE_LABELS: Record<ProductVatRate, string> = {
  '23': '23%',
  '8': '8%',
  '5': '5%',
  '0': '0%',
  zw: 'zw.',
  oo: 'o.o.',
  np: 'np.',
  np_ii: 'np. II',
};

/**
 * Kody GTU ze schematu FA(3) (GTU_01 do GTU_13), wspólne z pozycją faktury
 * (`lib/invoices/line-codes.ts`). Same kody, bez opisów: słownik opisów
 * i reguły, kiedy który kod się należy, to wiedza prawna i osobny krok planu.
 */
export { GTU_CODES };

export const PRODUCT_LIMITS = {
  name: 200,
  unit: 30,
  pkwiu: PKWIU_MAX_LENGTH,
  description: 2000,
  /** Największa cena netto i brutto: 12 cyfr przed przecinkiem (NUMERIC(15,2) ma zapas). */
  priceMax: 999_999_999_999.99,
} as const;

/** „1 250,50”, „1250.5”, 99.9 → liczba z najwyżej dwoma miejscami; inne wejście → null. */
export function parseProductPrice(raw: string | number): number | null {
  const clean = String(raw).replace(/[\s ]/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const value = Number(clean);
  return Number.isFinite(value) && value <= PRODUCT_LIMITS.priceMax ? value : null;
}

const PRICE_ERROR = 'Podaj cenę netto, na przykład 1250,00 (najwyżej dwa miejsca po przecinku, bez minusa).';
const GROSS_PRICE_ERROR = 'Podaj cenę brutto, na przykład 1537,50 (najwyżej dwa miejsca po przecinku, bez minusa).';

const priceSchema = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((raw, ctx) => {
    if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return null;
    const value = parseProductPrice(raw);
    if (value === null) {
      ctx.addIssue({ code: 'custom', message: PRICE_ERROR });
      return z.NEVER;
    }
    return value;
  });

/**
 * Cena brutto: puste pole to `null` (bez ceny brutto), pole, które nie przyszło,
 * to `undefined` (zapisana cena brutto bez zmian), reszta jak cena netto.
 */
const grossPriceSchema = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((raw, ctx) => {
    if (raw === undefined) return undefined;
    if (raw === null || (typeof raw === 'string' && raw.trim() === '')) return null;
    const value = parseProductPrice(raw);
    if (value === null) {
      ctx.addIssue({ code: 'custom', message: GROSS_PRICE_ERROR });
      return z.NEVER;
    }
    return value;
  });

/** Stawka bez podatku a cena brutto: faktura w cenach brutto takiej pozycji nie przyjmie (#880). */
export function untaxedGrossPriceMessage(rate: ProductVatRate): string {
  return `Stawka „${PRODUCT_VAT_RATE_LABELS[rate]}” nie ma podatku, a faktura w cenach brutto jej nie obsługuje. Zostaw cenę brutto pustą albo wybierz stawkę 23%, 8%, 5% lub 0%.`;
}

/** Odmowa zapisu ceny brutto produktu przy wyłączonym wyłączniku `grossPricesEnabled`. */
export const PRODUCT_GROSS_PRICES_OFF =
  'Ceny brutto nie są jeszcze dostępne w FaktWay, więc produktu z ceną brutto nie zapisaliśmy. Usuń cenę brutto i zapisz produkt z ceną netto.';
/** Błąd odczytu wyłącznika: „nie wiem” to nie „tak”. */
export const PRODUCT_GROSS_PRICES_UNKNOWN =
  'Nie udało się sprawdzić, czy ceny brutto są dostępne, więc produktu nie zapisaliśmy. Spróbuj ponownie za chwilę.';

/** Pole opcjonalne z walidacją: puste to null. */
function optional(max: number, label: string, pattern?: RegExp, patternMessage?: string) {
  return z
    .string()
    .nullish()
    .transform((raw, ctx) => {
      const value = (raw ?? '').trim();
      if (!value) return null;
      if (value.length > max) {
        ctx.addIssue({ code: 'custom', message: `${label}: najwyżej ${max} znaków.` });
        return z.NEVER;
      }
      if (pattern && !pattern.test(value)) {
        ctx.addIssue({ code: 'custom', message: patternMessage ?? `${label}: nieprawidłowa wartość.` });
        return z.NEVER;
      }
      return value;
    });
}

export const productFormSchema = z
  .object({
    name: z
      .string({ message: 'Podaj nazwę produktu lub usługi.' })
      .trim()
      .min(1, 'Podaj nazwę produktu lub usługi.')
      .max(PRODUCT_LIMITS.name, `Nazwa: najwyżej ${PRODUCT_LIMITS.name} znaków.`),
    unit: z
      .string({ message: 'Podaj jednostkę, na przykład szt. albo godz.' })
      .trim()
      .min(1, 'Podaj jednostkę, na przykład szt. albo godz.')
      .max(PRODUCT_LIMITS.unit, `Jednostka: najwyżej ${PRODUCT_LIMITS.unit} znaków.`),
    priceNet: priceSchema,
    priceGross: grossPriceSchema,
    vatRate: vatRateEnum,
    // Format PKWiU nie jest tu zgadywany: tylko znaki (cyfry i kropki) i długość.
    pkwiu: optional(PRODUCT_LIMITS.pkwiu, 'PKWiU', PKWIU_PATTERN, PKWIU_PATTERN_MESSAGE),
    gtu: z
      .string()
      .nullish()
      .transform((raw, ctx) => {
        const value = (raw ?? '').trim();
        if (!value) return null;
        if (!(GTU_CODES as readonly string[]).includes(value)) {
          ctx.addIssue({ code: 'custom', message: GTU_CODE_MESSAGE });
          return z.NEVER;
        }
        return value;
      }),
    description: optional(PRODUCT_LIMITS.description, 'Opis'),
  })
  .superRefine((d, ctx) => {
    if (d.priceGross !== null && d.priceGross !== undefined && GROSS_PRICES_UNTAXED_RATES.has(d.vatRate)) {
      ctx.addIssue({ code: 'custom', path: ['priceGross'], message: untaxedGrossPriceMessage(d.vatRate) });
    }
  })
  .transform((d) => ({
    name: d.name,
    unit: d.unit,
    defaultPriceNet: d.priceNet,
    defaultPriceGross: d.priceGross,
    defaultVatRate: d.vatRate,
    pkwiuCode: d.pkwiu,
    gtuCode: d.gtu,
    description: d.description,
  }));

/** Dane z formularza (przed walidacją). */
export type ProductFormInput = z.input<typeof productFormSchema>;
/** Dane po walidacji. */
export type ProductFormData = z.output<typeof productFormSchema>;

/** Wiersz katalogu dla listy. */
export interface ProductListItem {
  id: string;
  name: string;
  unit: string;
  defaultPriceNet: number | null;
  /** Cena brutto z katalogu (00213); brak to `null`, nigdy 0. */
  defaultPriceGross: number | null;
  defaultVatRate: string;
  pkwiuCode: string | null;
  gtuCode: string | null;
  description: string | null;
  isArchived: boolean;
  useCount: number;
  lastUsedAt: string | null;
}

/** Podpowiedź przy nazwie pozycji faktury (krok 2.6, część 2a): najwyżej tyle produktów. */
export const PRODUCT_SUGGESTIONS_LIMIT = 8;
/** Od tylu znaków frazy (po usunięciu znaków wzorca) idzie zapytanie do katalogu. */
export const PRODUCT_SUGGESTIONS_MIN_QUERY = 2;

/** Produkt w podpowiedzi: to, co wstawia się do pozycji faktury. */
export interface ProductSuggestion {
  id: string;
  name: string;
  unit: string;
  priceNet: number | null;
  /** Cena brutto z katalogu (00213) dla faktury w cenach brutto; brak to `null`. */
  priceGross: number | null;
  /** Stawka spoza listy formularza (np. z dawnego importu) to `null`: pozycja zostaje przy swojej. */
  vatRate: ProductVatRate | null;
  /** PKWiU z katalogu (krok 2.6, część 2b-1); niepoprawny albo brak to `null`. */
  pkwiuCode: string | null;
  /** GTU z katalogu (krok 2.6, część 2b-2); spoza listy GTU_01-GTU_13 albo brak to `null`. */
  gtuCode: GtuCode | null;
}

/** Czy wartość z bazy jest stawką z listy formularza faktury (`vatRateEnum`). */
export function isProductVatRate(value: unknown): value is ProductVatRate {
  return typeof value === 'string' && (PRODUCT_VAT_RATES as readonly string[]).includes(value);
}

/** Komunikat dla zajętego klucza nazwa + jednostka (indeks 00186): z nazwą, bez błędu bazy. */
export function duplicateProductMessage(name: string, unit: string): string {
  return `Produkt „${name}” w jednostce „${unit}” już jest w katalogu. Zmień nazwę lub jednostkę albo edytuj istniejący wpis (może być zarchiwizowany).`;
}
