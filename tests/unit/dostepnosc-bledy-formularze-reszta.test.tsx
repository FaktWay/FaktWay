// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/app/actions/proformy', () => ({ addQuoteContractorAction: vi.fn(), saveQuoteDraftAction: vi.fn() }));
vi.mock('@/app/actions/noty', () => ({ addNoteContractorAction: vi.fn(), saveNoteDraftAction: vi.fn() }));
vi.mock('@/app/actions/expense-payments', () => ({ markExpensePaidAction: vi.fn(), undoExpensePaidAction: vi.fn() }));
vi.mock('@/app/actions/validation', () => ({ validateBankAccountAction: vi.fn() }));

import { QuoteForm } from '@/app/(dashboard)/proformy/_components/quote-form';
import { NoteForm } from '@/app/(dashboard)/noty/_components/note-form';
import { OznaczZaplacone } from '@/components/expenses/do-zaplaty/dane-przelewu';
import { PaymentSection } from '@/components/invoices/invoice-form-parts/payment-section';

/**
 * Audyt dostępności 11.2026, A-01 dla pozostałych formularzy (po #712 i #741):
 * komunikat błędu pola ma `id` i `role="alert"`, a pole `aria-invalid` i
 * `aria-describedby` na ten komunikat. Prawdziwe formularze: proforma i oferta,
 * nota obciążeniowa i uznaniowa, MPP w płatności, data zapłaty kosztu. Arkusz faktury
 * cyklicznej (obszar R1 `faktury.cykliczne`) czeka na osobny PR.
 * Sprawdzamy powiązanie generycznie: każdy komunikat błędu pola jest wskazany
 * przez `aria-describedby` jakiegoś pola.
 */

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render(el: React.ReactElement) {
  await act(async () => {
    root.render(el);
  });
}

async function wyslij(selector: string) {
  const form = document.querySelector<HTMLFormElement>(selector) ?? host.querySelector('form');
  if (!form) throw new Error('brak formularza');
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

/** Komunikaty błędów pól (shadcn `FieldError` i własne akapity z `role="alert"` w polach). */
function bledyPol() {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="field-error"], [role="alert"][id$="-error"]')];
}

function sprawdzPowiazanie() {
  const bledy = bledyPol();
  expect(bledy.length, 'formularz powinien pokazać błędy pól').toBeGreaterThan(0);
  const opisy = [...document.querySelectorAll<HTMLElement>('[aria-describedby]')].flatMap((el) =>
    (el.getAttribute('aria-describedby') ?? '').split(/\s+/).map((id) => ({ id, el })),
  );
  const bezId = bledy.filter((b) => !b.id).map((b) => b.textContent);
  expect(bezId, 'komunikat błędu bez id').toEqual([]);
  const niepowiazane = bledy.filter((b) => !opisy.some((o) => o.id === b.id)).map((b) => `${b.id}: ${b.textContent}`);
  expect(niepowiazane.join(' | '), 'komunikat nie jest wskazany').toBe('');
  // Pole wskazujące komunikat jest oznaczone jako błędne.
  const bezInvalid = opisy
    .filter((o) => bledy.some((b) => b.id === o.id))
    // Błąd całej listy pozycji wskazuje grupa (`role="group"`): aria-invalid nie dotyczy tej roli.
    .filter((o) => o.el.getAttribute('role') !== 'group')
    .filter((o) => o.el.getAttribute('aria-invalid') !== 'true')
    .map((o) => o.el.id || o.el.tagName);
  expect(bezInvalid, 'pole z błędem bez aria-invalid').toEqual([]);
  for (const b of bledy) expect(b.getAttribute('role')).toBe('alert');
}

describe('A-01 w pozostałych formularzach: błąd pola powiązany z polem', () => {
  it('proforma: puste dane po zapisie, każdy błąd ma id i jest wskazany przez pole', async () => {
    await render(<QuoteForm tenantId={TENANT} contractors={[]} today="2026-11-16" />);
    await wyslij('form');
    sprawdzPowiazanie();
  });

  it('proforma: pole nazwy pozycji wskazuje swój komunikat', async () => {
    await render(<QuoteForm tenantId={TENANT} contractors={[]} today="2026-11-16" />);
    await wyslij('form');
    sprawdzPowiazanie();
    // Pole pozycji: nazwa pozycji 1 wskazuje swój komunikat.
    const nazwa = host.querySelector<HTMLInputElement>('input[id$="-item-0-name"]');
    expect(nazwa?.getAttribute('aria-describedby')).toMatch(/-item-0-name-error$/);
    expect(document.getElementById(nazwa!.getAttribute('aria-describedby')!)?.textContent).toBeTruthy();
  });

  it('nota: puste dane po zapisie, każdy błąd ma id i jest wskazany przez pole', async () => {
    await render(<NoteForm tenantId={TENANT} contractors={[]} today="2026-11-16" />);
    await wyslij('form');
    sprawdzPowiazanie();
  });

  it('MPP w płatności faktury: błąd pola ma id, role=alert i jest wskazany przez pole wyboru', async () => {
    const form = {
      formState: { errors: { splitPayment: { message: 'Przy MPP podaj rachunek bankowy.' } } },
      register: () => ({ name: 'splitPayment', onChange: vi.fn(), onBlur: vi.fn(), ref: vi.fn() }),
      setValue: vi.fn(),
      getValues: vi.fn(),
    } as never;
    await render(<PaymentSection form={form} paymentMethod='transfer' podpowiedzMpp={false} />);
    const blad = [...document.querySelectorAll('[role="alert"]')].find((e) => e.textContent?.includes('MPP'));
    expect(blad?.id).toBeTruthy();
    const pole = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(pole?.getAttribute('aria-describedby')).toBe(blad?.id);
    expect(pole?.getAttribute('aria-invalid')).toBe('true');
  });

  it('data zapłaty kosztu z przyszłości: komunikat ma id i role=alert, pole wskazuje go i jest błędne', async () => {
    await render(<OznaczZaplacone expenseId='koszt-1' dzis='2026-11-16' />);
    const pole = host.querySelector<HTMLInputElement>('#zaplata-koszt-1')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(pole, '2026-12-31');
      pole.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const blad = document.getElementById('zaplata-koszt-1-blad');
    expect(blad?.getAttribute('role')).toBe('alert');
    expect(pole.getAttribute('aria-describedby')).toBe('zaplata-koszt-1-blad');
    expect(pole.getAttribute('aria-invalid')).toBe('true');
  });
});
