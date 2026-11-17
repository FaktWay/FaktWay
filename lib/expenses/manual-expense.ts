/**
 * Koszt wpisany ręcznie (plan kompletnej aplikacji, krok 3.8, część 1): opłata
 * bez faktury, składka członkowska, zakup bez zdjęcia. Te same pola co koszt
 * odczytany ze zdjęcia, ale z wyborem kolumny KPiR przez człowieka (bez
 * klasyfikatora i bez AI).
 *
 * Co zapisujemy: wiersz `expenses` ze źródłem `manual` (wartość enumu od 00034),
 * osobą i firmą z sesji (RLS `expenses_insert_own_tenant`: firma aktywna i
 * `created_by = auth.uid()`), bez zdjęcia i bez zadania odczytu (`ocr_job_id`,
 * `source_file_*`, `ocr_extracted_data` puste). Strażnik pochodzenia (00123)
 * odrzuca tylko `ksef_inbox`, więc `manual` przechodzi, a migracja nie jest
 * potrzebna.
 *
 * Kwoty: złote, zaokrąglenie do grosza przez `roundToCents`, netto + VAT = brutto, bez kwot
 * ujemnych. VAT do odliczenia liczy ta sama reguła co przy odczycie i w
 * przeglądzie kosztu (`vatDeductionForDocument`: odlicza tylko faktura w dniu
 * jej wystawienia), a firma zwolniona podmiotowo z VAT nie odlicza nic
 * (`isSubjectiveVatExemption`, jak w `process-ocr.ts`). Koszt w KPiR liczy
 * dotychczasowa `kpirCostAmount`. Rodzaj „simplified_invoice” (paragon z NIP
 * jako faktura uproszczona) pochodzi tylko z odczytu dokumentu: ręcznie wpisuje
 * się fakturę, paragon albo inny dokument.
 *
 * Ponowienie: tabela nie ma klucza zapisu (bez migracji), więc bliźniak (ta sama
 * osoba, sprzedawca, numer, data i brutto w ciągu 2 minut) zwraca istniejący
 * koszt zamiast drugiego. Po 2 minutach ten sam koszt to świadomie nowy wpis.
 */
import { z } from 'zod';

import { isCalendarDate } from '@/lib/api/v1/pagination';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { isSubjectiveVatExemption, readTenantVatExemption } from '@/lib/invoices/vat-exemption';
import { vatDeductionForDocument } from '@/lib/expenses/vat-deduction-document';
import { roundToCents, validateNipChecksum } from '@/lib/xml/invoice-calculator';
import type { createClient } from '@/lib/supabase/server';
import type { Database } from '@/types/database';

export const MANUAL_EXPENSE_DOCUMENT_TYPES = ['invoice', 'receipt', 'other'] as const;
export const MANUAL_EXPENSE_KPIR_COLUMNS = ['col_10', 'col_11', 'col_12', 'col_13', 'col_15'] as const;

/** Najstarsza data kosztu, jaką przyjmujemy ręcznie (zapas na zaległe dokumenty). */
export const MANUAL_EXPENSE_MIN_DATE = '2010-01-01';
export const MANUAL_EXPENSE_MAX_AMOUNT = 9_999_999_999.99;
/** Bliźniak z tego okna zwraca istniejący koszt. */
export const MANUAL_EXPENSE_DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

const SAVE_FAILED = 'Nie udało się zapisać kosztu. Sprawdź połączenie i spróbuj ponownie za chwilę.';

const money = z.number({ message: 'Podaj kwotę liczbą.' }).finite('Podaj kwotę liczbą.').min(0, 'Kwota nie może być ujemna.').max(MANUAL_EXPENSE_MAX_AMOUNT, 'Kwota jest zbyt duża.');

export const manualExpenseSchema = z
  .object({
    sellerName: z.string().trim().min(1, 'Wpisz sprzedawcę albo odbiorcę płatności.').max(500, 'Nazwa jest za długa.'),
    sellerNip: z
      .string()
      .trim()
      .max(32)
      .transform((v) => v.replace(/[\s-]/g, ''))
      .refine((v) => v === '' || (/^\d{10}$/.test(v) && validateNipChecksum(v)), 'NIP ma błędną sumę kontrolną. Sprawdź go albo zostaw pole puste.'),
    documentType: z.enum(MANUAL_EXPENSE_DOCUMENT_TYPES, { message: 'Wybierz rodzaj dokumentu z listy.' }),
    documentNumber: z.string().trim().max(200, 'Numer dokumentu jest za długi.'),
    issueDate: z.string().refine(isCalendarDate, 'Podaj datę w formacie RRRR-MM-DD.'),
    netAmount: money,
    vatAmount: money,
    grossAmount: money.refine((v) => v > 0, 'Kwota brutto musi być większa od zera.'),
    kpirColumn: z.enum(MANUAL_EXPENSE_KPIR_COLUMNS, { message: 'Wybierz kolumnę KPiR.' }),
    notes: z.string().max(10_000, 'Uwagi są za długie.'),
    isDeductible: z.boolean(),
  })
  .superRefine((v, ctx) => {
    // Zaokrąglenie do grosza przez funkcję z rejestru (`roundToCents`), bez własnego zaokrąglania (reguła kwoty-bez-float).
    if (roundToCents(v.netAmount + v.vatAmount) !== roundToCents(v.grossAmount)) {
      ctx.addIssue({ code: 'custom', path: ['grossAmount'], message: 'Netto i VAT muszą dawać kwotę brutto.' });
    }
    if (isCalendarDate(v.issueDate)) {
      if (v.issueDate > todayInWarsaw()) ctx.addIssue({ code: 'custom', path: ['issueDate'], message: 'Data kosztu nie może być z przyszłości.' });
      else if (v.issueDate < MANUAL_EXPENSE_MIN_DATE) ctx.addIssue({ code: 'custom', path: ['issueDate'], message: 'Data kosztu jest zbyt odległa.' });
    }
  });

export type ManualExpenseInput = z.infer<typeof manualExpenseSchema>;

/** Pierwszy komunikat walidacji po polsku (formularz pokazuje wszystkie przy polach). */
export function firstManualExpenseIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Sprawdź dane kosztu.';
}

type SessionDb = Awaited<ReturnType<typeof createClient>>;

export interface ManualExpenseContext {
  supabase: SessionDb;
  userId: string;
  tenantId: string;
}

export type ManualExpenseResult =
  | { success: true; expenseId: string; duplicate: boolean; row: Database['public']['Tables']['expenses']['Insert'] | null }
  | { success: false; error: string };

export async function createManualExpense(ctx: ManualExpenseContext, input: unknown): Promise<ManualExpenseResult> {
  const parsed = manualExpenseSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: firstManualExpenseIssue(parsed.error) };
  const v = parsed.data;
  const { supabase, userId, tenantId } = ctx;

  // Bliźniak: ponowienie po zerwanym połączeniu albo podwójne kliknięcie.
  const since = new Date(Date.now() - MANUAL_EXPENSE_DUPLICATE_WINDOW_MS).toISOString();
  const number = v.documentNumber === '' ? null : v.documentNumber;
  let twin = supabase
    .from('expenses')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('created_by', userId)
    .eq('source', 'manual')
    .eq('seller_name', v.sellerName)
    .eq('issue_date', v.issueDate)
    .eq('gross_amount', v.grossAmount)
    .gte('created_at', since);
  twin = number === null ? twin.is('document_number', null) : twin.eq('document_number', number);
  const { data: existing } = await twin.limit(1);
  const first = (existing as Array<{ id: string }> | null)?.[0];
  if (first) return { success: true, expenseId: first.id, duplicate: true, row: null };

  // Zwolnienie podmiotowe odbiera odliczenie VAT (jak w `process-ocr.ts`); odczyt odporny przed 00091.
  const vatExempt = isSubjectiveVatExemption(await readTenantVatExemption(supabase, tenantId));
  const deduction = vatDeductionForDocument({ documentType: v.documentType, issueDate: v.issueDate, grossAmount: v.grossAmount });
  const row: Database['public']['Tables']['expenses']['Insert'] = {
    tenant_id: tenantId,
    created_by: userId,
    source: 'manual',
    seller_name: v.sellerName,
    seller_nip: v.sellerNip === '' ? null : v.sellerNip,
    document_number: number,
    document_type: v.documentType,
    issue_date: v.issueDate,
    net_amount: v.netAmount,
    vat_amount: v.vatAmount,
    gross_amount: v.grossAmount,
    vat_deductible_amount: !vatExempt && deduction.deductible ? v.vatAmount : 0,
    kpir_column: v.kpirColumn,
    categorization_method: 'manual',
    is_deductible: v.isDeductible,
    notes: v.notes.trim() === '' ? null : v.notes.trim(),
    is_reviewed: true,
  };
  const { data, error } = await supabase.from('expenses').insert(row).select('id').single();
  if (error || !data) return { success: false, error: SAVE_FAILED };
  return { success: true, expenseId: data.id, duplicate: false, row };
}
