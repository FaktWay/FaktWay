// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Sekcja „Akceptacja księgowej” na ekranie kosztu (krok 6.2, część 5a, 00214):
 * stan z kim i kiedy, powód „Do poprawy”, a dla księgowej przyciski decyzji
 * z odciskiem treści widzianej na stronie. Akcja serwerowa jest atrapą; jej
 * zachowanie: `tests/unit/koszt-akceptacja-akcja.test.ts`.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const m = vi.hoisted(() => ({
  decide: vi.fn(),
  refresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/app/actions/expense-acceptance', () => ({ decideExpenseAcceptanceAction: m.decide }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: m.refresh, push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: m.toastSuccess, error: m.toastError } }));

const { ExpenseAcceptancePanel } = await import('@/app/(dashboard)/expenses/[id]/_components/expense-acceptance-panel');
const A = await import('@/lib/expenses/acceptance');
type Load = import('@/lib/expenses/acceptance').ExpenseAcceptanceLoad;

const EXPENSE = '11111111-1111-4111-8111-111111111111';
const FP = '0123456789abcdef0123456789abcdef';

const load = (state: Partial<import('@/lib/expenses/acceptance').ExpenseAcceptanceState> = {}, decidedByLabel: string | null = null): Load => ({
  ok: true,
  decidedByLabel,
  state: { currentFingerprint: FP, decision: null, reason: null, decidedBy: null, decidedAt: null, isCurrent: false, ...state },
});

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  m.decide.mockResolvedValue({ success: true, status: 'decided', decision: 'accepted' });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(props: { load: Load; canDecide: boolean }) {
  act(() => root.render(<ExpenseAcceptancePanel expenseId={EXPENSE} {...props} />));
}
const button = (name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(name));
async function click(el: Element | undefined) {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
}

describe('sekcja „Akceptacja księgowej”', () => {
  it('księgowa przy koszcie bez decyzji: stan „Czeka…”, akceptacja z odciskiem treści, potwierdzenie i odświeżenie', async () => {
    render({ load: load(), canDecide: true });
    expect(host.textContent).toContain(A.ACCEPTANCE_STATUS_LABELS.awaiting);
    expect(host.textContent).toContain('Akceptacja nie zmienia KPiR ani VAT.');
    await click(button('Zaakceptuj koszt'));
    expect(m.decide).toHaveBeenCalledExactlyOnceWith({ expenseId: EXPENSE, decision: 'accepted', reason: undefined, fingerprint: FP });
    expect(m.toastSuccess).toHaveBeenCalledWith(A.ACCEPTED_TEXT);
    expect(m.refresh).toHaveBeenCalled();
  });

  it('„Oznacz do poprawy”: pusty powód zatrzymuje formularz, powód idzie do akcji, odmowa bazy pokazuje tekst odmowy', async () => {
    render({ load: load(), canDecide: true });
    await click(button('Oznacz do poprawy'));
    const textarea = host.querySelector('textarea');
    expect(textarea).toBeTruthy();
    await click(button('Zapisz uwagę'));
    expect(host.textContent).toContain(A.EMPTY_REASON);
    expect(m.decide).not.toHaveBeenCalled();

    m.decide.mockResolvedValueOnce({ success: false, error: A.decideRefusalText('changed') });
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, 'Brak faktury, jest tylko paragon.');
      textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('Zapisz uwagę'));
    expect(m.decide).toHaveBeenCalledExactlyOnceWith({ expenseId: EXPENSE, decision: 'needs_changes', reason: 'Brak faktury, jest tylko paragon.', fingerprint: FP });
    expect(m.toastError).toHaveBeenCalledWith(A.decideRefusalText('changed'));
    expect(m.refresh).not.toHaveBeenCalled();
  });

  it('właściciel: stan z kim i kiedy oraz powód, bez przycisków decyzji', () => {
    render({ load: load({ decision: 'needs_changes', reason: 'Brak faktury.', decidedBy: 'x', decidedAt: '2026-11-25T00:30:00Z', isCurrent: true }, 'Anna Księgowa'), canDecide: false });
    expect(host.textContent).toContain(A.ACCEPTANCE_STATUS_LABELS.needs_changes);
    expect(host.textContent).toContain('Anna Księgowa, 25.11.2026');
    expect(host.textContent).toContain('Powód: Brak faktury.');
    expect(button('Zaakceptuj koszt')).toBeUndefined();
    expect(button('Oznacz do poprawy')).toBeUndefined();
  });

  it('koszt zmieniony po akceptacji: stan „Zmieniony po akceptacji…”, księgowa może zaakceptować ponownie', () => {
    render({ load: load({ decision: 'accepted', decidedBy: 'x', decidedAt: '2026-11-25T00:30:00Z', isCurrent: false }, 'Anna Księgowa'), canDecide: true });
    expect(host.textContent).toContain(A.ACCEPTANCE_STATUS_LABELS.changed_after_acceptance);
    expect((button('Zaakceptuj koszt') as HTMLButtonElement).disabled).toBe(false);
  });

  it('bieżąca akceptacja: przycisk akceptacji wyłączony; błąd odczytu: komunikat ze „Spróbuj ponownie”', async () => {
    render({ load: load({ decision: 'accepted', decidedBy: 'x', decidedAt: '2026-11-25T00:30:00Z', isCurrent: true }, 'Ty'), canDecide: true });
    expect((button('Zaakceptuj koszt') as HTMLButtonElement).disabled).toBe(true);

    render({ load: { ok: false, error: A.ACCEPTANCE_LOAD_ERROR }, canDecide: true });
    expect(host.textContent).toContain(A.ACCEPTANCE_LOAD_ERROR);
    await click(button('Spróbuj ponownie'));
    expect(m.refresh).toHaveBeenCalled();
  });
});
