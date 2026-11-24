/**
 * Koszt wpisany ręcznie (plan kompletnej aplikacji, krok 3.8, część 1): opłata
 * bez faktury, składka członkowska, zakup bez zdjęcia. Te same pola co koszt
 * odczytany ze zdjęcia, ale z wyborem kolumny KPiR przez człowieka (bez
 * klasyfikatora i bez AI).
 *
 * Co zapisujemy: wiersz `expenses` ze źródłem `manual` (wartość enumu od 00034),
 * osobą i firmą z sesji, bez zdjęcia i bez zadania odczytu (`ocr_job_id`,
 * `source_file_*`, `ocr_extracted_data` puste). Od 00127 rola authenticated nie
 * ma INSERT na `expenses`, więc zapis robi funkcja `expense_create_manual`
 * (00212, SECURITY DEFINER): firma z `get_current_tenant_id()`, `created_by =
 * auth.uid()`, `source = 'manual'` na sztywno i własna kontrola kształtu kwot.
 *
 * Kwoty: złote, każda z najwyżej dwoma miejscami po przecinku, netto + VAT = brutto w groszach
 * (`roundToCents`), bez kwot ujemnych. VAT do odliczenia liczy ta sama reguła co przy odczycie i w
 * przeglądzie kosztu (`vatDeductionForDocument`: odlicza tylko faktura w dniu
 * jej wystawienia), a firma zwolniona podmiotowo z VAT nie odlicza nic
 * (`isSubjectiveVatExemption`, jak w `process-ocr.ts`). Koszt w KPiR liczy
 * dotychczasowa `kpirCostAmount`. Rodzaj „simplified_invoice” (paragon z NIP
 * jako faktura uproszczona) pochodzi tylko z odczytu dokumentu: ręcznie wpisuje
 * się fakturę, paragon albo inny dokument.
 *
 * Ponowienie: tabela nie ma klucza zapisu, więc bliźniak (ta sama
 * osoba, sprzedawca, numer, data i brutto w ciągu 2 minut) zwraca istniejący
 * koszt zamiast drugiego. Po 2 minutach ten sam koszt to świadomie nowy wpis.
 */
import { z } from 'zod';

import { readCompletePages } from '@/lib/accounting/read-complete-pages';
import { isCalendarDate } from '@/lib/api/v1/pagination';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { isSubjectiveVatExemption, readTenantVatExemption } from '@/lib/invoices/vat-exemption';
import { documentKey, nip10 } from '@/lib/expenses/document-identity';
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

/** Znaki specjalne wzorca LIKE (`\\`, `%`, `_`) jako dosłowne. */
const escapeLike = (c: string) => (c === '\\' || c === '%' || c === '_' ? `\\${c}` : c);

const SAVE_FAILED = 'Nie udało się zapisać kosztu. Sprawdź połączenie i spróbuj ponownie za chwilę.';
/**
 * Odmowy funkcji `expense_create_manual` (00212), przy których ponowienie nie pomoże
 * (dalszy krok #834): 42501 to brak sesji, aktywnej firmy albo roli w firmie (np. firma
 * zmieniona w innej karcie, rola odebrana), 23514 to dane, których baza nie przyjęła.
 */
const SAVE_FORBIDDEN = 'Nie zapisaliśmy kosztu, bo zmieniła się wybrana firma albo Twoja rola w niej. Odśwież stronę i sprawdź wybraną firmę, a jeśli to się powtórzy, poproś właściciela firmy o sprawdzenie Twojej roli.';
const SAVE_REJECTED_DATA = 'Nie zapisaliśmy kosztu, bo baza odrzuciła dane dokumentu (data, kwoty albo kolumna KPiR). Sprawdź pola formularza i zapisz ponownie, a jeśli to się powtórzy, napisz do nas.';

function saveFailedMessage(error: { code?: string | null } | null): string {
  if (error?.code === '42501') return SAVE_FORBIDDEN;
  if (error?.code === '23514') return SAVE_REJECTED_DATA;
  return SAVE_FAILED;
}

/** Podpowiedzi kategorii jak w edycji kosztu; można wpisać własną. */
export const MANUAL_EXPENSE_CATEGORIES = [
  'Paliwo',
  'Telekomunikacja',
  'Oprogramowanie',
  'Marketing',
  'Materiały biurowe',
  'Reprezentacja',
  'Podróże służbowe',
  'Usługi obce',
  'Energia',
  'Czynsz',
  'Pozostałe wydatki',
] as const;

// Kolumny bazy to numeric(15,2): kwota z trzecim miejscem zostałaby zaokrąglona osobno i suma przestałaby się zgadzać.
const money = z
  .number({ message: 'Podaj kwotę liczbą.' })
  .finite('Podaj kwotę liczbą.')
  .min(0, 'Kwota nie może być ujemna.')
  .max(MANUAL_EXPENSE_MAX_AMOUNT, 'Kwota jest zbyt duża.')
  .refine((v) => roundToCents(v) === v, 'Kwota z najwyżej dwoma miejscami po przecinku.');

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
    categoryLabel: z.string().trim().min(1, 'Wpisz kategorię kosztu.').max(200, 'Kategoria jest za długa.'),
    kpirColumn: z.enum(MANUAL_EXPENSE_KPIR_COLUMNS, { message: 'Wybierz kolumnę KPiR.' }),
    notes: z.string().max(10_000, 'Uwagi są za długie.'),
    isDeductible: z.boolean(),
  })
  .superRefine((v, ctx) => {
    // Każda kwota ma najwyżej grosze (pole `money`), suma liczona w groszach przez `roundToCents` (reguła kwoty-bez-float).
    if (roundToCents(v.netAmount + v.vatAmount) !== v.grossAmount) {
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

/** Funkcja 00212 jeszcze nie jest w wygenerowanych typach bazy (types/database.ts po wgraniu migracji). */
interface ExpenseCreateRpc {
  rpc(
    name: 'expense_create_manual',
    args: Record<string, string | number | boolean | null>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

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

  // Faktura z NIP i numerem, która już jest w Kosztach (np. ze Skrzynki KSeF): drugi koszt dałby podwójny koszt w KPiR i podwójne odliczenie VAT.
  const nip = nip10(v.sellerNip);
  const key = documentKey(v.documentNumber);
  if (v.documentType === 'invoice' && nip && key) {
    // Zawężenie w bazie po NIP i numerze (wzorce tolerują przedrostek, myślniki i odstępy), dokładne porównanie `nip10` i `documentKey` w JS.
    const numberPattern = `%${[...key].map(escapeLike).join('%')}%`;
    let rows: Array<{ id: string; seller_nip: string | null; document_number: string | null }>;
    try {
      rows = await readCompletePages('Nie można sprawdzić kosztów tego dostawcy', (from, to) =>
        supabase
          .from('expenses')
          .select('id, seller_nip, document_number', { count: 'exact' })
          .eq('tenant_id', tenantId)
          .ilike('seller_nip', `%${nip.split('').join('%')}%`)
          .ilike('document_number', numberPattern)
          .order('id', { ascending: true })
          .range(from, to),
      );
    } catch {
      return { success: false, error: 'Nie udało się sprawdzić, czy ten dokument jest już w Kosztach. Spróbuj ponownie za chwilę.' };
    }
    if (rows.some((r) => nip10(r.seller_nip) === nip && documentKey(r.document_number) === key)) {
      return { success: false, error: `Ten dokument jest już w Kosztach (${v.documentNumber}). Otwórz go z listy kosztów.` };
    }
  }

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
    category_label: v.categoryLabel,
    categorization_method: 'manual',
    is_deductible: v.isDeductible,
    notes: v.notes.trim() === '' ? null : v.notes.trim(),
    is_reviewed: true,
  };
  // Od 00127 klient sesji nie ma INSERT na expenses: zapis idzie funkcją 00212, która bierze firmę i osobę z sesji i wstawia source = 'manual'.
  const { data, error } = await (supabase as unknown as ExpenseCreateRpc).rpc('expense_create_manual', {
    p_seller_name: row.seller_name,
    p_seller_nip: row.seller_nip ?? null,
    p_document_type: v.documentType,
    p_document_number: number,
    p_issue_date: v.issueDate,
    p_net_amount: v.netAmount,
    p_vat_amount: v.vatAmount,
    p_gross_amount: v.grossAmount,
    p_vat_deductible_amount: row.vat_deductible_amount ?? 0,
    p_kpir_column: v.kpirColumn,
    p_category_label: v.categoryLabel,
    p_notes: row.notes ?? null,
    p_is_deductible: v.isDeductible,
  });
  if (error || typeof data !== 'string' || data === '') return { success: false, error: saveFailedMessage(error) };
  return { success: true, expenseId: data, duplicate: false, row };
}
