import { describe, expect, it } from 'vitest';

import {
  ACCEPTANCE_SAVE_ERROR,
  ACCEPTANCE_STATUS_LABELS,
  EMPTY_REASON,
  REASON_TOO_LONG,
  acceptanceStatus,
  canDecideExpenseAcceptance,
  decideRefusalText,
  expenseAcceptanceInputSchema,
  parseAcceptanceState,
} from '@/lib/expenses/acceptance';

/**
 * Akceptacja kosztu przez księgową (krok 6.2, część 5a, 00214): reguły modułu
 * wspólnego dla akcji, ładowarki i komponentu. Zachowanie funkcji bazy na
 * prawdziwym PostgREST: `tests/rls-akceptacja-kosztow.test.ts`.
 */

const EXPENSE = '00214214-0000-4000-8000-0000000000e1';
const FP = '0123456789abcdef0123456789abcdef';

describe('akceptacja kosztu: kto, stan i decyzja', () => {
  it('decyduje tylko rola księgowej (jak w expense_acceptance_decide)', () => {
    expect(canDecideExpenseAcceptance('accountant')).toBe(true);
    for (const role of ['owner', 'admin', 'member', 'viewer', '', null, undefined]) {
      expect(canDecideExpenseAcceptance(role), String(role)).toBe(false);
    }
  });

  it('stan z funkcji bazy: bez decyzji nieaktualny, powód tylko przy „Do poprawy”, zły kształt to null', () => {
    expect(parseAcceptanceState({ current_fingerprint: FP, decision: null, reason: null, decided_by: null, decided_at: null, is_current: false }))
      .toEqual({ currentFingerprint: FP, decision: null, reason: null, decidedBy: null, decidedAt: null, isCurrent: false });
    expect(parseAcceptanceState({ current_fingerprint: FP, decision: 'needs_changes', reason: 'Brak faktury.', decided_by: EXPENSE, decided_at: '2026-11-25T01:00:00Z', is_current: true }))
      .toMatchObject({ decision: 'needs_changes', reason: 'Brak faktury.', isCurrent: true });
    expect(parseAcceptanceState({ current_fingerprint: FP, decision: 'accepted', reason: 'x', decided_by: null, decided_at: '2026-11-25T01:00:00Z', is_current: true }))
      .toMatchObject({ decision: 'accepted', reason: null, decidedBy: null });
    for (const zly of [null, {}, { current_fingerprint: 'abc', decision: null, reason: null, decided_by: null, decided_at: null, is_current: false }, { current_fingerprint: FP, decision: 'approved', reason: null, decided_by: null, decided_at: null, is_current: true }]) {
      expect(parseAcceptanceState(zly)).toBeNull();
    }
  });

  it('stany ekranu: decyzja liczy się tylko dla treści, którą księgowa widziała', () => {
    expect(acceptanceStatus({ decision: null, isCurrent: false })).toBe('awaiting');
    expect(acceptanceStatus({ decision: 'accepted', isCurrent: true })).toBe('accepted');
    expect(acceptanceStatus({ decision: 'needs_changes', isCurrent: true })).toBe('needs_changes');
    expect(acceptanceStatus({ decision: 'accepted', isCurrent: false })).toBe('changed_after_acceptance');
    expect(acceptanceStatus({ decision: 'needs_changes', isCurrent: false })).toBe('changed_after_needs_changes');
    expect(ACCEPTANCE_STATUS_LABELS.changed_after_acceptance).toContain('czeka na ponowną akceptację');
    expect(ACCEPTANCE_STATUS_LABELS.accepted).not.toBe(ACCEPTANCE_STATUS_LABELS.changed_after_acceptance);
  });

  it('decyzja z formularza: „Do poprawy” wymaga powodu do 2000 znaków, akceptacja go nie wymaga, odcisk md5', () => {
    const ok = (input: Record<string, unknown>) => expenseAcceptanceInputSchema.safeParse({ expenseId: EXPENSE, fingerprint: FP, ...input });
    expect(ok({ decision: 'accepted' }).success).toBe(true);
    expect(ok({ decision: 'needs_changes', reason: '  Brak faktury.  ' })).toMatchObject({ success: true, data: { reason: 'Brak faktury.' } });
    const bezPowodu = ok({ decision: 'needs_changes', reason: '   ' });
    expect(bezPowodu.success).toBe(false);
    if (!bezPowodu.success) expect(bezPowodu.error.issues[0]?.message).toBe(EMPTY_REASON);
    const zaDlugi = ok({ decision: 'needs_changes', reason: 'x'.repeat(2001) });
    expect(zaDlugi.success).toBe(false);
    if (!zaDlugi.success) expect(zaDlugi.error.issues[0]?.message).toBe(REASON_TOO_LONG);
    expect(ok({ decision: 'approved' }).success).toBe(false);
    expect(ok({ decision: 'accepted', fingerprint: 'abc' }).success).toBe(false);
    expect(ok({ decision: 'accepted', expenseId: 'nie-uuid' }).success).toBe(false);
  });

  it('odmowy funkcji bazy: przyczyna i wyjście, nieznany kod to błąd zapisu', () => {
    expect(decideRefusalText('role')).toMatch(/tylko osoba z rolą „księgowy”.*ustawieniach zespołu/);
    expect(decideRefusalText('changed')).toMatch(/zmienił się od otwarcia tej strony\. Odśwież stronę/);
    expect(decideRefusalText('not_found')).toMatch(/Odśwież stronę albo przełącz firmę/);
    expect(decideRefusalText('empty_reason')).toBe(EMPTY_REASON);
    expect(decideRefusalText('reason_too_long')).toBe(REASON_TOO_LONG);
    expect(decideRefusalText('invalid_decision')).toBe(ACCEPTANCE_SAVE_ERROR);
    expect(decideRefusalText(undefined)).toBe(ACCEPTANCE_SAVE_ERROR);
    for (const code of ['role', 'changed', 'not_found', 'empty_reason', 'reason_too_long', 'x']) {
      expect(decideRefusalText(code), code).not.toMatch(/[—–]/);
    }
  });
});
