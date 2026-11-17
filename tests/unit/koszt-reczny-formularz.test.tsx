// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ create: vi.fn(), push: vi.fn(), toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: m.push, refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: m.toast }));
vi.mock('@/app/actions/expenses', () => ({
  createManualExpenseAction: m.create,
  getOcrJobStatusAction: vi.fn(),
}));

import { ManualExpenseForm } from '@/components/expenses/manual-expense-form';

/**
 * Krok 3.8, część 1: formularz kosztu wpisanego ręcznie na tych samych polach
 * co odczyt zdjęcia. Prawdziwy komponent, atrapa tylko akcji serwera.
 */

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  for (const f of [m.create, m.push, m.toast.success, m.toast.error]) f.mockReset();
  m.create.mockResolvedValue({ success: true, expenseId: 'exp-9', duplicate: false });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const pokaz = (props: Partial<Parameters<typeof ManualExpenseForm>[0]> = {}) =>
  act(async () => {
    root.render(<ManualExpenseForm tenantId={TENANT} today="2026-11-16" vatExempt={false} {...props} />);
  });

const pole = (id: string) => host.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`#${id}`)!;
async function wpisz(id: string, tekst: string) {
  const el = pole(id);
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, tekst);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
const wyslij = async () => {
  await act(async () => {
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
};

async function wypelnijPoprawnie() {
  await wpisz('manual-expense-seller', 'Urząd Miasta');
  await wpisz('manual-expense-net', '100');
  await wpisz('manual-expense-vat', '0');
  await wpisz('manual-expense-kpir', 'col_13');
}

describe('formularz kosztu wpisanego ręcznie', () => {
  it('ma te same pola co odczyt zdjęcia: sprzedawca, NIP, rodzaj, numer, data, netto, VAT, brutto, kolumna KPiR, uwagi', async () => {
    await pokaz();
    for (const id of ['seller', 'nip', 'type', 'number', 'date', 'net', 'vat', 'gross', 'kpir', 'notes']) {
      expect(pole(`manual-expense-${id}`), id).not.toBeNull();
    }
    expect(pole('manual-expense-date').value).toBe('2026-11-16');
  });

  it('brutto liczy się z netto i VAT, dopóki człowiek go sam nie zmieni', async () => {
    await pokaz();
    await wpisz('manual-expense-net', '100');
    await wpisz('manual-expense-vat', '23');
    expect(pole('manual-expense-gross').value).toBe('123');
    await wpisz('manual-expense-gross', '150');
    await wpisz('manual-expense-net', '200');
    expect(pole('manual-expense-gross').value).toBe('150');
  });

  it('zapis wysyła dane i firmę formularza, pokazuje potwierdzenie i przechodzi do kosztu', async () => {
    await pokaz();
    await wypelnijPoprawnie();
    await wyslij();
    expect(m.create).toHaveBeenCalledTimes(1);
    const [values, tenant] = m.create.mock.calls[0]!;
    expect(tenant).toBe(TENANT);
    expect(values).toMatchObject({ sellerName: 'Urząd Miasta', netAmount: 100, vatAmount: 0, grossAmount: 100, kpirColumn: 'col_13', documentType: 'other', isDeductible: true });
    expect(m.toast.success).toHaveBeenCalled();
    expect(m.push).toHaveBeenCalledWith('/expenses/exp-9');
  });

  it('błędy pól po stronie klienta: komunikaty z id, powiązane z polami (A-01), akcja nie jest wołana', async () => {
    await pokaz();
    await wyslij();
    expect(m.create).not.toHaveBeenCalled();
    const bledy = [...host.querySelectorAll<HTMLElement>('[data-slot="field-error"]')];
    expect(bledy.length).toBeGreaterThan(1);
    for (const b of bledy) {
      expect(b.id).toBeTruthy();
      expect(host.querySelector(`[aria-describedby~="${b.id}"]`)).not.toBeNull();
    }
  });

  it('odmowa z serwera zostaje w formularzu jako komunikat z poleceniem, bez przejścia dalej', async () => {
    m.create.mockResolvedValue({ success: false, error: 'Nie udało się zapisać kosztu. Sprawdź połączenie i spróbuj ponownie za chwilę.' });
    await pokaz();
    await wypelnijPoprawnie();
    await wyslij();
    expect(host.textContent).toContain('Nie udało się zapisać kosztu');
    expect(m.push).not.toHaveBeenCalled();
  });

  it('wyjątek akcji nie psuje formularza', async () => {
    m.create.mockRejectedValue(new Error('sieć'));
    await pokaz();
    await wypelnijPoprawnie();
    await wyslij();
    expect(host.textContent).toMatch(/Nie udało się zapisać kosztu/);
    expect(m.push).not.toHaveBeenCalled();
  });

  it('podwójne kliknięcie wysyła koszt raz', async () => {
    let zwolnij: (v: unknown) => void = () => {};
    m.create.mockImplementation(() => new Promise((r) => { zwolnij = r; }));
    await pokaz();
    await wypelnijPoprawnie();
    await wyslij();
    await wyslij();
    expect(m.create).toHaveBeenCalledTimes(1);
    await act(async () => { zwolnij({ success: true, expenseId: 'exp-9', duplicate: false }); });
  });

  it('podpowiedź o VAT: z paragonu i innego dokumentu VAT nie jest odliczany; firma zwolniona nie odlicza nigdy', async () => {
    await pokaz();
    expect(host.textContent).toMatch(/nie odlicza VAT/i);
    await wpisz('manual-expense-type', 'invoice');
    expect(host.textContent).not.toMatch(/z tego dokumentu nie odlicza VAT/i);
    await pokaz({ vatExempt: true });
    expect(host.textContent).toMatch(/zwolnion\w+ z VAT/i);
  });

  it('teksty bez długich myślników i bez nazwy sprzed zmiany marki', async () => {
    await pokaz();
    expect(host.textContent).not.toMatch(/—|–|FaktFlow/);
  });
});
