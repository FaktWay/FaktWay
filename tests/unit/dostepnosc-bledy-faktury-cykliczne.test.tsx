// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/app/actions/recurring-invoices', () => ({
  createRecurringInvoiceAction: vi.fn(),
  updateRecurringInvoiceAction: vi.fn(),
}));
vi.mock('@/app/actions/recurring-invoice-templates', () => ({ searchRecurringTemplatesAction: vi.fn() }));

import { RecurringInvoiceSheet } from '@/app/(dashboard)/(faktury)/invoices/recurring/_components/recurring-invoice-sheet';

/**
 * Audyt dostępności 11.2026, A-01 (po #712, #741 i #824): w arkuszu faktury
 * cyklicznej komunikat błędu pola ma `id` i `role="alert"`, a pole
 * `aria-invalid` i `aria-describedby` na ten komunikat. Prawdziwy komponent,
 * atrapy tylko akcji serwera.
 */

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

async function pokaz(props: Partial<React.ComponentProps<typeof RecurringInvoiceSheet>> = {}) {
  await act(async () => {
    root.render(<RecurringInvoiceSheet open onOpenChange={vi.fn()} today="2026-11-16" candidates={[]} {...props} />);
  });
}

async function wyslij() {
  const form = document.getElementById('recurring-invoice-form') as HTMLFormElement;
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

const bledy = () => [...document.querySelectorAll<HTMLElement>('[data-slot="field-error"]')];

function pola(idBledu: string) {
  return [...document.querySelectorAll<HTMLElement>('[aria-describedby]')].filter((el) =>
    (el.getAttribute('aria-describedby') ?? '').split(/\s+/).includes(idBledu),
  );
}

describe('A-01 w arkuszu faktury cyklicznej', () => {
  it('po zapisie bez wzoru i nazwy: każdy błąd ma id i role=alert, a pole go wskazuje i jest oznaczone jako błędne', async () => {
    await pokaz();
    await wyslij();
    const lista = bledy();
    expect(lista.length, 'arkusz powinien pokazać błędy pól').toBeGreaterThanOrEqual(2);
    for (const blad of lista) {
      expect(blad.id, `komunikat bez id: ${blad.textContent}`).toBeTruthy();
      expect(blad.getAttribute('role')).toBe('alert');
      const wskazujace = pola(blad.id);
      expect(wskazujace.length, `nikt nie wskazuje komunikatu ${blad.id}`).toBeGreaterThan(0);
      for (const pole of wskazujace) expect(pole.getAttribute('aria-invalid')).toBe('true');
    }
  });

  it('wybór wzoru i nazwa: komunikat nazwy wskazuje pole nazwy, wzoru pole wyboru wzoru', async () => {
    await pokaz();
    await wyslij();
    const nazwa = document.getElementById('recurring-invoice-form-name')!;
    expect(nazwa.getAttribute('aria-describedby')).toBe('recurring-invoice-form-name-error');
    expect(document.getElementById('recurring-invoice-form-name-error')?.textContent).toBeTruthy();
    const wzor = document.getElementById('recurring-invoice-form-template')!;
    expect(wzor.getAttribute('aria-describedby')).toBe('recurring-invoice-form-template-error');
  });

  it('dzień miesiąca poza zakresem: komunikat ma id, pole go wskazuje', async () => {
    await pokaz();
    const dzien = document.getElementById('recurring-invoice-form-day') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(dzien, '40');
      dzien.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await wyslij();
    expect(dzien.getAttribute('aria-describedby')).toBe('recurring-invoice-form-day-error');
    expect(document.getElementById('recurring-invoice-form-day-error')?.getAttribute('role')).toBe('alert');
    expect(dzien.getAttribute('aria-invalid')).toBe('true');
  });

  it('bez błędów pola nie mają aria-describedby na komunikaty (znaczniki jak dotąd)', async () => {
    await pokaz();
    const nazwa = document.getElementById('recurring-invoice-form-name')!;
    expect(nazwa.hasAttribute('aria-describedby')).toBe(false);
  });
});
