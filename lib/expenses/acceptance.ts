import { z } from 'zod';

/**
 * Akceptacja kosztu przez księgową (plan kompletnej aplikacji, krok 6.2,
 * część 5a; tabela `expense_acceptances`, 00214). Role, schemat decyzji,
 * kształty wyników, stany i teksty w module bez importów serwerowych: biorą go
 * akcja, ładowarka i komponent klienta.
 *
 * Akceptacja jest informacyjna: nie zmienia kosztu, KPiR, VAT, ewidencji ani
 * raportów (żaden z nich jej nie czyta). Decyzję zapisuje wyłącznie funkcja bazy
 * `expense_acceptance_decide`: tylko księgowa aktywnej firmy, dla treści kosztu,
 * którą widziała (odcisk z `expense_acceptance_state`), z audytem i przy „Do
 * poprawy” wpisem w dzwonku pozostałych członków firmy, w jednej transakcji.
 */

export const EXPENSE_ACCEPTANCE_DECISIONS = ['accepted', 'needs_changes'] as const;
export type ExpenseAcceptanceDecision = (typeof EXPENSE_ACCEPTANCE_DECISIONS)[number];

/** Decyduje tylko rola księgowej; ta sama reguła stoi w `expense_acceptance_decide` (00214). */
export function canDecideExpenseAcceptance(role: unknown): boolean {
  return role === 'accountant';
}

/** Limit powodu z CHECK `expense_acceptances_reason_check`. */
export const EXPENSE_ACCEPTANCE_REASON_MAX = 2000;
/** Kotwica sekcji na ekranie kosztu; link z dzwonka (00214) prowadzi do `/expenses/<id>#akceptacja`. */
export const EXPENSE_ACCEPTANCE_ANCHOR = 'akceptacja';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINT_RE = /^[0-9a-f]{32}$/;

export const EMPTY_REASON = 'Napisz, co trzeba poprawić w koszcie.';
export const REASON_TOO_LONG = 'Powód może mieć najwyżej 2000 znaków. Skróć go i zapisz ponownie.';

/** Decyzja z formularza: ta sama reguła w komponencie i w akcji; funkcja bazy sprawdza ją jeszcze raz. */
export const expenseAcceptanceInputSchema = z
  .object({
    expenseId: z.string().regex(UUID_RE),
    decision: z.enum(EXPENSE_ACCEPTANCE_DECISIONS),
    reason: z.string().trim().max(EXPENSE_ACCEPTANCE_REASON_MAX, REASON_TOO_LONG).optional(),
    /** Odcisk treści kosztu, którą księgowa widziała (00214). */
    fingerprint: z.string().regex(FINGERPRINT_RE),
  })
  .superRefine((value, ctx) => {
    if (value.decision === 'needs_changes' && !value.reason) {
      ctx.addIssue({ code: 'custom', path: ['reason'], message: EMPTY_REASON });
    }
  });
export type ExpenseAcceptanceInput = z.input<typeof expenseAcceptanceInputSchema>;

/** Powód „Do poprawy” w formularzu sekcji (te same teksty co w akcji i w funkcji bazy). */
export const expenseAcceptanceReasonFormSchema = z.object({
  reason: z.string().trim().min(1, EMPTY_REASON).max(EXPENSE_ACCEPTANCE_REASON_MAX, REASON_TOO_LONG),
});
export type ExpenseAcceptanceReasonFormValues = z.infer<typeof expenseAcceptanceReasonFormSchema>;

/** Stan z `expense_acceptance_state`. */
export interface ExpenseAcceptanceState {
  currentFingerprint: string;
  decision: ExpenseAcceptanceDecision | null;
  reason: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  /** Decyzja dotyczy bieżącej treści kosztu (odcisk się zgadza). */
  isCurrent: boolean;
}

const stateSchema = z.object({
  current_fingerprint: z.string().regex(FINGERPRINT_RE),
  decision: z.enum(EXPENSE_ACCEPTANCE_DECISIONS).nullable(),
  reason: z.string().nullable(),
  decided_by: z.string().nullable(),
  decided_at: z.string().nullable(),
  is_current: z.boolean(),
});

/** Odpowiedź funkcji bazy; kształt spoza umowy to `null` (ładowarka pokazuje błąd odczytu). */
export function parseAcceptanceState(raw: unknown): ExpenseAcceptanceState | null {
  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success) return null;
  const s = parsed.data;
  return {
    currentFingerprint: s.current_fingerprint,
    decision: s.decision,
    reason: s.decision === 'needs_changes' ? s.reason : null,
    decidedBy: s.decided_by,
    decidedAt: s.decided_at,
    isCurrent: s.decision !== null && s.is_current,
  };
}

export type ExpenseAcceptanceStatus =
  | 'awaiting'
  | 'accepted'
  | 'needs_changes'
  | 'changed_after_acceptance'
  | 'changed_after_needs_changes';

/** Stan dla ekranu: decyzja dotyczy tylko treści, którą księgowa widziała (niezmiennik 3). */
export function acceptanceStatus(state: Pick<ExpenseAcceptanceState, 'decision' | 'isCurrent'>): ExpenseAcceptanceStatus {
  if (state.decision === null) return 'awaiting';
  if (state.isCurrent) return state.decision;
  return state.decision === 'accepted' ? 'changed_after_acceptance' : 'changed_after_needs_changes';
}

export const ACCEPTANCE_STATUS_LABELS: Record<ExpenseAcceptanceStatus, string> = {
  awaiting: 'Czeka na akceptację księgowej',
  accepted: 'Zaakceptowany przez księgową',
  needs_changes: 'Do poprawy',
  changed_after_acceptance: 'Zmieniony po akceptacji, czeka na ponowną akceptację księgowej',
  changed_after_needs_changes: 'Zmieniony po uwagach księgowej, czeka na jej decyzję',
};

export type ExpenseAcceptanceLoad =
  | { ok: true; state: ExpenseAcceptanceState; decidedByLabel: string | null }
  | { ok: false; error: string };

export type DecideExpenseAcceptanceResult =
  | { success: true; status: 'decided' | 'exists'; decision: ExpenseAcceptanceDecision }
  | { success: false; error: string };

export const ACCEPTANCE_LOAD_ERROR = 'Nie udało się wczytać akceptacji kosztu. Spróbuj ponownie za chwilę.';
export const ACCEPTANCE_SAVE_ERROR = 'Nie udało się zapisać decyzji. Sprawdź połączenie i spróbuj ponownie.';
export const ACCEPTANCE_NO_ACCESS = 'Nie masz dostępu do kosztów tej firmy. Odśwież stronę albo przełącz firmę.';
export const ACCEPTANCE_ROLE_ONLY =
  'Akceptować koszty może tylko osoba z rolą „księgowy” w tej firmie. Rolę nadaje właściciel albo admin w ustawieniach zespołu.';

export const ACCEPTED_TEXT = 'Koszt zaakceptowany.';
export const NEEDS_CHANGES_TEXT = 'Koszt oznaczony do poprawy. Firma dostała wpis w powiadomieniach.';

/** Odmowa `expense_acceptance_decide`: przyczyna i co zrobić (protokół napraw, pkt 4). */
export function decideRefusalText(code: unknown): string {
  switch (code) {
    case 'role':
      return ACCEPTANCE_ROLE_ONLY;
    case 'empty_reason':
      return EMPTY_REASON;
    case 'reason_too_long':
      return REASON_TOO_LONG;
    case 'not_found':
      return 'Nie znaleziono tego kosztu w aktywnej firmie. Odśwież stronę albo przełącz firmę.';
    case 'changed':
      return 'Koszt zmienił się od otwarcia tej strony. Odśwież stronę, sprawdź koszt i zdecyduj jeszcze raz.';
    default:
      return ACCEPTANCE_SAVE_ERROR;
  }
}
