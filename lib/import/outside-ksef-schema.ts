import { z } from 'zod';
import { addDaysToIsoDate } from '@/lib/format/warsaw-date';
import { GTU_CODES } from '@/lib/invoices/line-codes';
import { toGrosze } from '@/lib/xml/invoice-calculator';

/**
 * Schemat wpisu „faktura wystawiona poza KSeF” (plan kompletnej aplikacji,
 * krok 1.6, część 2b, decyzje D21 i D22 z `DECYZJE-2026-11-25.md`). Używają go
 * formularz i akcja zapisu (kolejne PR-y); tu tylko kształt i odmowy.
 *
 * Zakres pierwszej wersji (D22): faktura VAT w PLN, stawki 23, 8, 5, 0,
 * „zw” (z podstawą zwolnienia) i „np”, oznaczenia GTU i TP (zmieniają tylko
 * wiersz w JPK_V7M). Inne rodzaje: odmowa z wyjściem, bez zapisu.
 * Data wystawienia: 1.01.2026 do 31.12.2026 (D21); data sprzedaży może być
 * wcześniejsza. Wpis jest kopią dokumentu klienta: FaktWay go nie wystawia
 * i nie wysyła do KSeF.
 */

export const OUTSIDE_KSEF_ISSUE_DATE_MIN = '2026-01-01';
export const OUTSIDE_KSEF_ISSUE_DATE_MAX = '2026-12-31';

export const OUTSIDE_KSEF_VAT_RATES = ['23', '8', '5', '0', 'zw', 'np'] as const;
export type OutsideKsefVatRate = (typeof OUTSIDE_KSEF_VAT_RATES)[number];

/** Rodzaje dokumentu, których FaktWay nie ujmie w księgach (D22). */
export const OUTSIDE_KSEF_REFUSED_KINDS = [
  'faktura_do_paragonu',
  'korekta',
  'zaliczka',
  'rozliczenie',
  'waluta',
  'procedura_marzy',
  'oo',
  'metoda_kasowa',
  'samofakturowanie',
] as const;
export type OutsideKsefRefusedKind = (typeof OUTSIDE_KSEF_REFUSED_KINDS)[number];

/** Komunikat odmowy (D22): mówi, co zrobić zamiast. */
export const OUTSIDE_KSEF_REFUSAL_MESSAGE =
  'Tej faktury FaktWay nie ujmie w księgach; ujmuje się ją w księgach poza FaktWay.';

export function outsideKsefRefusal(kind: string): string | null {
  return (OUTSIDE_KSEF_REFUSED_KINDS as readonly string[]).includes(kind)
    ? OUTSIDE_KSEF_REFUSAL_MESSAGE
    : null;
}

const NUMERIC_RATE: Record<string, number> = { '23': 23, '8': 8, '5': 5, '0': 0 };

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data w formacie RRRR-MM-DD.')
  .refine((v) => addDaysToIsoDate(v, 0) === v, 'Taka data nie istnieje.');

// Kwota z dokładnością do grosza: zaokrąglenie do grosza nie zmienia liczby.
const money = z.number().finite().refine((v) => Math.abs(v * 100 - toGrosze(v)) < 1e-6, 'Kwota z dokładnością do grosza.');

const cents = toGrosze;

export const outsideKsefLineSchema = z
  .object({
    name: z.string().trim().min(1, 'Podaj nazwę pozycji.').max(512),
    netAmount: money,
    vatRate: z.enum(OUTSIDE_KSEF_VAT_RATES),
    vatAmount: money,
    grossAmount: money,
    /** Podstawa zwolnienia, wymagana przy „zw” (FA(3) P_19). */
    exemptionBasis: z.string().trim().max(256).optional(),
    gtuCode: z.enum(GTU_CODES).optional(),
    /** Oznaczenie TP (powiązania): tylko wiersz w JPK_V7M. */
    tp: z.boolean().optional(),
  })
  .superRefine((line, ctx) => {
    if (cents(line.netAmount) + cents(line.vatAmount) !== cents(line.grossAmount)) {
      ctx.addIssue({ code: 'custom', path: ['grossAmount'], message: 'Brutto musi być równe netto plus VAT.' });
    }
    const rate = NUMERIC_RATE[line.vatRate];
    if (rate === undefined || rate === 0) {
      if (cents(line.vatAmount) !== 0) {
        ctx.addIssue({ code: 'custom', path: ['vatAmount'], message: 'Przy tej stawce kwota VAT to 0,00.' });
      }
    } else if (Math.abs(cents(line.vatAmount) * 100 - cents(line.netAmount) * rate) > 100) {
      ctx.addIssue({ code: 'custom', path: ['vatAmount'], message: 'Kwota VAT nie zgadza się ze stawką.' });
    }
    if (line.vatRate === 'zw' && !line.exemptionBasis) {
      ctx.addIssue({ code: 'custom', path: ['exemptionBasis'], message: 'Przy stawce „zw” podaj podstawę zwolnienia.' });
    }
  });

export const outsideKsefInvoiceSchema = z.object({
  /** Numer faktury nadany przez wystawcę (kolumna 4 KPiR, D20). */
  number: z.string().trim().min(1, 'Podaj numer faktury.').max(256),
  issueDate: isoDate.refine(
    (v) => v >= OUTSIDE_KSEF_ISSUE_DATE_MIN && v <= OUTSIDE_KSEF_ISSUE_DATE_MAX,
    'Data wystawienia: od 1 stycznia do 31 grudnia 2026 r.',
  ),
  saleDate: isoDate.optional(),
  buyerName: z.string().trim().min(1, 'Podaj nabywcę.').max(512),
  buyerNip: z.string().regex(/^\d{10}$/, 'NIP: 10 cyfr.').optional(),
  currency: z.literal('PLN', { message: 'Tylko faktury w złotych.' }),
  lines: z.array(outsideKsefLineSchema).min(1, 'Dodaj co najmniej jedną pozycję.').max(1000),
});

export type OutsideKsefInvoiceInput = z.infer<typeof outsideKsefInvoiceSchema>;
