import { readCompletePages } from '@/lib/accounting/read-complete-pages';
import {
  FA3_PAID_DATE_COLUMN,
  isReceivableBase,
  RECEIVABLE_BASE_COLUMNS,
  type ReceivableBaseRow,
  type ReceivableContext,
} from '@/lib/dashboard/receivables';
import { outstandingOf } from '@/lib/invoices/amount-due';
import { parentsWithOpenCorrection } from '@/lib/invoices/correction-parents';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import type { PageContext } from '@/lib/supabase/page-context';
import type { KsefEnvironment } from '@/types/ksef';

/**
 * Fakty wierszy listy faktur (P3, PLAN-FINORA §5) dla BIEŻĄCEJ strony
 * (≤ 50 wierszy): ikona płatności, kolumna „Do zapłaty” i link „Korekta”.
 *
 * - Płatność i kwota tylko dla faktur z §2.4 pkt 11 — predykat
 *   `isReceivableBase` z `lib/dashboard/receivables.ts`, ten sam co w sumie
 *   należności (bez drugiej kopii warunków). Reszta dostaje `null`, a UI „—”.
 * - „Po terminie” z daty w Europe/Warsaw, nie z `payment_status`.
 * - „Korekta” tylko dla faktur, które przyjmuje formularz
 *   `app/(dashboard)/invoices/new/correction/page.tsx`, i bez korekty w toku
 *   (`lib/invoices/correction-parents.ts`, K4). Bez „Korekta” także faktura
 *   z pozycją bez ceny netto albo ilości (np. w cenach brutto): formularz
 *   takiej zawsze odmawia (`correctionRefusalFromLines`, ustalenie 17).
 * - „Zapłacone” (00158) dla każdej faktury sprzedaży przyjętej w KSeF z resztą do
 *   zapłaty, także spoza należności: importu nie ścigamy, ale jego zapłatę wolno
 *   oznaczyć. Ten sam zbiór warunków sprawdza RPC `mark_invoice_paid`.
 */

/** Kolumny, które strona listy musi wybrać, żeby policzyć fakty wiersza. */
export const LIST_ROW_FACT_COLUMNS = `${RECEIVABLE_BASE_COLUMNS}, ksef_number, fa3_paid_date:${FA3_PAID_DATE_COLUMN}` as const;

export interface ListRowFactsRow extends ReceivableBaseRow {
  ksef_number: string | null;
  /** `Zaplacono = 1` + `DataZaplaty` z FA(3): faktura wystawiona po zapłacie (import, historia KSeF). */
  fa3_paid_date?: string | null;
}

export type InvoicePaymentState = 'paid' | 'overdue' | 'unpaid';

export interface InvoiceListRowFacts {
  /** null = faktura spoza §2.4 pkt 11 → „—”. */
  payment: InvoicePaymentState | null;
  /** `outstandingOf`; null razem z `payment`. 0 = „Opłacona”. */
  outstanding: number | null;
  /** Czy pokazać „Korekta” w menu wiersza. */
  canCorrect: boolean;
  /** Czy faktura czeka na „Zapłacone” (`canMarkInvoicePaid`); rolę sprawdza strona. */
  canMarkPaid: boolean;
}

export interface CorrectionContext {
  environment: KsefEnvironment;
  /** Rodzice z korektą w toku (`parentsWithOpenCorrection`). */
  openCorrectionParents: ReadonlySet<string>;
  /**
   * Faktury z pozycją, przy której formularz korekty zawsze odmawia
   * (`CORRECTION_LINE_GAP_FILTER`). Lista czyta je dla kandydatów; szczegóły
   * faktury liczą to samo z pozycji (`correctionRefusalFromLines`).
   */
  lineGapParents?: ReadonlySet<string>;
}

/** Pomoc FaktWay przy odmowie korekty, jak `CORRECTION_HELP_STEP` w `lib/invoices/issue-correction.ts`. */
const CORRECTION_HELP_STEP = 'Napisz do nas, a przygotujemy korektę z Tobą.';

/**
 * Pozycje, przy których formularz korekty zawsze odmawia
 * (`fetchParentInvoiceLines` w `lib/invoices/issue-correction.ts`): bez ceny
 * netto (faktura w cenach brutto albo plik bez ceny netto) albo bez ilości.
 */
export const CORRECTION_LINE_GAP_FILTER = 'unit_price_net.is.null,quantity.is.null';

export interface CorrectionLineFacts {
  ordinal: number;
  quantity: unknown;
  unit_price_net: unknown;
}

/**
 * Powód, dla którego formularz korekty odmówi tej faktury z powodu pozycji:
 * ten sam tekst i ta sama kolejność sprawdzeń co `fetchParentInvoiceLines`
 * (pierwsza pozycja po numerze; bez ceny netto z ceną brutto w dokumencie:
 * „w cenach brutto”, inaczej „bez pełnej ilości lub ceny”), z wyjściem (pomoc
 * FaktWay). Szczegóły faktury pokazują go zamiast przycisku „Korekta”
 * (ustalenie 17). `label` jak w odmowie: numer faktury albo początek id.
 * `null`, gdy pozycje korekty nie blokują.
 */
export function correctionRefusalFromLines(
  lines: readonly CorrectionLineFacts[],
  grossPrices: ReadonlyMap<number, number>,
  label: string,
): string | null {
  const sorted = [...lines].sort((a, b) => a.ordinal - b.ordinal);
  for (const line of sorted) {
    if (line.unit_price_net == null && grossPrices.has(line.ordinal)) {
      return `Faktura ${label} jest w cenach brutto (pozycje mają cenę brutto zamiast ceny netto), a korekty takiej faktury aplikacja jeszcze nie przygotowuje. ${CORRECTION_HELP_STEP}`;
    }
    if (line.quantity == null || line.unit_price_net == null ||
        !Number.isFinite(Number(line.quantity)) ||
        !Number.isFinite(Number(line.unit_price_net))) {
      return `Faktura ${label} ma pozycję bez pełnej ilości lub ceny, więc korekty nie przygotujemy w aplikacji. ${CORRECTION_HELP_STEP}`;
    }
  }
  return null;
}

/** Ten sam zbiór warunków co zapytanie formularza korekty + K4. */
function isCorrectionParentCandidate(row: ListRowFactsRow, environment: KsefEnvironment): boolean {
  return row.direction === 'outgoing'
    && row.ksef_status === 'accepted'
    && row.invoice_kind === 'regular'
    && row.ksef_environment === environment
    && typeof row.ksef_number === 'string' && row.ksef_number !== '';
}

export function canCorrectInvoice(row: ListRowFactsRow, ctx: CorrectionContext): boolean {
  return isCorrectionParentCandidate(row, ctx.environment)
    && !ctx.openCorrectionParents.has(row.id)
    && !ctx.lineGapParents?.has(row.id);
}

function isFa3Paid(row: Pick<ListRowFactsRow, 'fa3_paid_date'>): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(row.fa3_paid_date?.trim() ?? '');
}

function isAcceptedSale(row: ReceivableBaseRow, environment: KsefEnvironment): boolean {
  return row.direction === 'outgoing' && row.ksef_status === 'accepted' && row.ksef_environment === environment;
}

/**
 * Faktura sprzedaży zapłacona naprawdę, także spoza należności (import, faktura
 * z dzieckiem, korekta in plus): zapłata jest faktem, więc wiersz mówi „Opłacona”,
 * a nie „—”. Te same warunki co filtr „Opłacone” (`settledFilterOps`).
 */
function isSettledSale(row: ReceivableBaseRow & Pick<ListRowFactsRow, 'fa3_paid_date'>, environment: KsefEnvironment): boolean {
  return isAcceptedSale(row, environment) && (row.payment_status === 'paid' || isFa3Paid(row));
}

/**
 * Czy pokazać „Zapłacone”. Lustro warunków `mark_invoice_paid` (00158) po stronie
 * ekranu: faktura sprzedaży przyjęta w KSeF, bez zapłaty, z resztą do zapłaty,
 * niezerowana korektą. `corrections` to suma różnic przyjętych korekt faktury.
 */
export function canMarkInvoicePaid(
  row: ReceivableBaseRow & Pick<ListRowFactsRow, 'fa3_paid_date'>,
  environment: KsefEnvironment,
  corrections = 0,
): boolean {
  if (!isAcceptedSale(row, environment) || isSettledSale(row, environment)) return false;
  const outstanding = outstandingOf(row);
  return outstanding > 0 && outstanding + corrections > 0;
}

/** Ikona i kwota „Do zapłaty”; `today` = RRRR-MM-DD w Europe/Warsaw. */
export function paymentFactsOf(
  row: ReceivableBaseRow & Pick<ListRowFactsRow, 'fa3_paid_date'>,
  ctx: ReceivableContext,
  today: string,
): Pick<InvoiceListRowFacts, 'payment' | 'outstanding'> {
  if (!isReceivableBase(row, ctx)) {
    return isSettledSale(row, ctx.environment)
      ? { payment: 'paid', outstanding: 0 }
      : { payment: null, outstanding: null };
  }
  const outstanding = outstandingOf(row);
  if (outstanding === 0 || row.payment_status === 'paid') return { payment: 'paid', outstanding };
  const due = row.payment_due_date;
  const overdue = typeof due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(due) && due < today;
  return { payment: overdue ? 'overdue' : 'unpaid', outstanding };
}

const LOOKUP_CHUNK = 100;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface PageChildren {
  childIds: Set<string>;
  openCorrectionParents: Set<string>;
  /** Suma różnic przyjętych korekt faktury: korekta do zera zdejmuje „Zapłacone”. */
  corrections: Map<string, number>;
}

/**
 * Dzieci wierszy strony w tej firmie: korekty (`parent_invoice_id`) i ROZ
 * (`advance_invoice_ids`). Każde dziecko w dowolnym statusie wyklucza
 * należność (jak widok 00145); korekty w toku blokują „Korekta” (K4).
 * Odczyt pełny i liczony — błąd rzuca, bo „nie wiem” to nie „bez dzieci”.
 */
async function loadPageChildren(
  supabase: PageContext['supabase'],
  tenantId: string,
  ids: readonly string[],
): Promise<PageChildren> {
  const childIds = new Set<string>();
  const corrections: Array<{ parent_invoice_id: string | null; ksef_status: string | null }> = [];
  const sums = new Map<string, number>();
  for (const chunk of chunks(ids, LOOKUP_CHUNK)) {
    const [byParent, bySettlement] = await Promise.all([
      readCompletePages('Nie można odczytać korekt faktur na liście', (from, to) => supabase
        .from('invoices')
        .select('id, parent_invoice_id, invoice_kind, ksef_status, gross_total', { count: 'exact' })
        .eq('tenant_id', tenantId)
        .in('parent_invoice_id', chunk)
        .order('id', { ascending: true })
        .range(from, to)),
      readCompletePages('Nie można odczytać faktur rozliczających zaliczki na liście', (from, to) => supabase
        .from('invoices')
        .select('id, advance_invoice_ids', { count: 'exact' })
        .eq('tenant_id', tenantId)
        .overlaps('advance_invoice_ids', chunk)
        .order('id', { ascending: true })
        .range(from, to)),
    ]);
    for (const row of byParent) {
      if (!row.parent_invoice_id) continue;
      childIds.add(row.parent_invoice_id);
      if (row.invoice_kind === 'correction') corrections.push(row);
      if (row.ksef_status === 'accepted') {
        sums.set(row.parent_invoice_id, (sums.get(row.parent_invoice_id) ?? 0) + (Number(row.gross_total) || 0));
      }
    }
    for (const row of bySettlement) {
      for (const id of row.advance_invoice_ids ?? []) {
        if (chunk.includes(id)) childIds.add(id);
      }
    }
  }
  return { childIds, openCorrectionParents: parentsWithOpenCorrection(corrections), corrections: sums };
}

/**
 * Kandydaci na rodzica korekty z pozycją, przy której formularz korekty
 * zawsze odmawia (`CORRECTION_LINE_GAP_FILTER`, ustalenie 17). Odczyt pełny
 * i liczony, jak dzieci: błąd rzuca, bo „nie wiem” to nie „pozycje pełne”.
 */
async function loadCorrectionLineGaps(
  supabase: PageContext['supabase'],
  ids: readonly string[],
): Promise<Set<string>> {
  const gaps = new Set<string>();
  for (const chunk of chunks(ids, LOOKUP_CHUNK)) {
    const lines = await readCompletePages('Nie można odczytać pozycji faktur na liście', (from, to) => supabase
      .from('invoice_line_items')
      .select('id, invoice_id', { count: 'exact' })
      .in('invoice_id', chunk)
      .or(CORRECTION_LINE_GAP_FILTER)
      .order('id', { ascending: true })
      .range(from, to));
    for (const line of lines) gaps.add(line.invoice_id);
  }
  return gaps;
}

export async function loadInvoiceListRowFacts(
  supabase: PageContext['supabase'],
  tenantId: string,
  rows: readonly ListRowFactsRow[],
  now: Date = new Date(),
): Promise<Map<string, InvoiceListRowFacts>> {
  const environment = requireConfiguredKsefEnvironment();
  const today = todayInWarsaw(now);

  // Dzieci czytamy tylko dla wierszy, którym mogą coś zmienić: kandydatów
  // należności (przed odjęciem dzieci), kandydatów na rodzica korekty
  // i faktur z „Zapłacone” (korekta do zera je zdejmuje).
  const noChildren: ReceivableContext = { environment, childIds: new Set() };
  const lookupIds = [...new Set(rows
    .filter((row) =>
      isReceivableBase(row, noChildren)
      || isCorrectionParentCandidate(row, environment)
      || canMarkInvoicePaid(row, environment))
    .map((row) => row.id))];
  const correctionIds = rows.filter((row) => isCorrectionParentCandidate(row, environment)).map((row) => row.id);
  const [children, lineGapParents] = await Promise.all([
    lookupIds.length > 0
      ? loadPageChildren(supabase, tenantId, lookupIds)
      : Promise.resolve<PageChildren>({ childIds: new Set(), openCorrectionParents: new Set(), corrections: new Map() }),
    correctionIds.length > 0 ? loadCorrectionLineGaps(supabase, correctionIds) : Promise.resolve(new Set<string>()),
  ]);

  const receivableCtx: ReceivableContext = { environment, childIds: children.childIds };
  const correctionCtx: CorrectionContext = {
    environment,
    openCorrectionParents: children.openCorrectionParents,
    lineGapParents,
  };
  const result = new Map<string, InvoiceListRowFacts>();
  for (const row of rows) {
    result.set(row.id, {
      ...paymentFactsOf(row, receivableCtx, today),
      canCorrect: canCorrectInvoice(row, correctionCtx),
      canMarkPaid: canMarkInvoicePaid(row, environment, children.corrections.get(row.id) ?? 0),
    });
  }
  return result;
}
