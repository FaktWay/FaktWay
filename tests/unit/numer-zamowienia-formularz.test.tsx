// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ saveDraft: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/invoices/actions', () => ({
  saveDraftAction: m.saveDraft,
  saveAndSendInvoiceAction: vi.fn(),
  lookupBuyerAction: vi.fn(),
  prefillFromLastInvoiceAction: vi.fn(),
}));
vi.mock('@/app/actions/invoice-autosave', () => ({ saveInvoiceAutosaveAction: vi.fn(), discardInvoiceAutosaveAction: vi.fn() }));
vi.mock('@/components/invoices/buyer-lookup', () => ({
  BuyerLookup: (p: { inputId?: string; nip: string }) => <input id={p.inputId} defaultValue={p.nip} />,
}));
vi.mock('@/app/actions/produkty', () => ({ suggestProductsAction: vi.fn().mockResolvedValue({ ok: true, items: [] }) }));

import { InvoiceForm } from '@/components/invoices/invoice-form';

/**
 * Plan kompletnej aplikacji, krok 2.8: numer i data zamówienia w formularzu
 * zwykłej faktury. Pola zwinięte pod przyciskiem „Dodaj numer zamówienia”
 * (jak „Dodaj PKWiU”), więc formularz bez numeru wygląda jak dotąd (D1).
 * Prawdziwy formularz, atrapa tylko akcji i wyszukiwarek.
 */

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-16T08:00:00Z'));
  m.saveDraft.mockReset();
  m.saveDraft.mockResolvedValue({ success: false, error: 'test' });
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function formularz(props: Partial<Parameters<typeof InvoiceForm>[0]> = {}) {
  await act(async () => {
    root.render(<InvoiceForm tenantId={TENANT} initialValues={{}} {...props} />);
  });
}
const przycisk = () => container.querySelector<HTMLButtonElement>('button[aria-label="Dodaj numer zamówienia"]');
const ustawInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
const wpisz = (id: string, tekst: string) =>
  act(async () => {
    const el = container.querySelector<HTMLInputElement>(`#${id}`)!;
    ustawInput.call(el, tekst);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('formularz faktury: numer zamówienia', () => {
  it('na starcie tylko przycisk „Dodaj numer zamówienia”, bez pól (formularz jak dotąd)', async () => {
    await formularz();
    expect(przycisk()?.textContent).toBe('Dodaj numer zamówienia');
    expect(container.querySelector('#invoice-order-number')).toBeNull();
    expect(container.querySelector('#invoice-order-date')).toBeNull();
  });

  it('po kliknięciu pola numeru i daty, kursor w numerze; przycisk znika', async () => {
    await formularz();
    act(() => przycisk()?.click());
    const numer = container.querySelector<HTMLInputElement>('#invoice-order-number');
    expect(numer).not.toBeNull();
    expect(document.activeElement).toBe(numer);
    expect(container.querySelector<HTMLInputElement>('#invoice-order-date')?.type).toBe('date');
    expect(przycisk()).toBeNull();
  });

  it('podkład z numerem (np. szkic) od razu pokazuje pola z wartościami', async () => {
    await formularz({ initialValues: { orderNumber: 'ZAM/2026/17', orderDate: '2026-11-02' } });
    expect(container.querySelector<HTMLInputElement>('#invoice-order-number')?.value).toBe('ZAM/2026/17');
    expect(container.querySelector<HTMLInputElement>('#invoice-order-date')?.value).toBe('2026-11-02');
    expect(przycisk()).toBeNull();
  });

  it('data bez numeru: błąd przy polu numeru, powiązany z polem (A-01), akcja zapisu nie jest wołana', async () => {
    await formularz();
    act(() => przycisk()?.click());
    await wpisz('invoice-order-date', '2026-11-02');
    const zapisz = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Zapisz szkic'))!;
    await act(async () => { zapisz.click(); });
    const blad = container.querySelector('#invoice-order-number-error');
    expect(blad?.textContent).toContain('Podaj numer zamówienia albo usuń datę zamówienia.');
    expect(blad?.getAttribute('role')).toBe('alert');
    expect(container.querySelector('#invoice-order-number')?.getAttribute('aria-describedby')).toBe('invoice-order-number-error');
    expect(m.saveDraft).not.toHaveBeenCalled();
  });
});
