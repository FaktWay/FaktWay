// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ save: vi.fn(), reset: vi.fn(), toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: m.toast }));
vi.mock('@/components/invoices/actions', () => ({
  saveDraftAction: vi.fn(),
  saveAndSendInvoiceAction: vi.fn(),
  lookupBuyerAction: vi.fn(),
  prefillFromLastInvoiceAction: vi.fn(),
}));
vi.mock('@/app/actions/invoice-autosave', () => ({ saveInvoiceAutosaveAction: vi.fn(), discardInvoiceAutosaveAction: vi.fn() }));
vi.mock('@/app/actions/invoice-defaults', () => ({ saveInvoiceDefaultsAction: m.save, resetInvoiceDefaultsAction: m.reset }));
vi.mock('@/components/invoices/buyer-lookup', () => ({
  BuyerLookup: (p: { inputId?: string; nip: string }) => <input id={p.inputId} defaultValue={p.nip} />,
}));
vi.mock('@/app/actions/produkty', () => ({ suggestProductsAction: vi.fn().mockResolvedValue({ ok: true, items: [] }) }));

import { InvoiceForm } from '@/components/invoices/invoice-form';
import { InvoiceDefaultsForm } from '@/components/settings/invoice-defaults-form';

/**
 * Domyślne ustawienia nowej faktury (plan kompletnej aplikacji, krok 2.8):
 * formularz faktury bierze formę i termin płatności firmy, gdy nie ma podkładu
 * (podkład z faktury, cykliczna i proforma mają pierwszeństwo); ekran ustawień
 * zapisuje je i wraca do domyślnych. Prawdziwe komponenty, atrapa akcji.
 */

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-16T08:00:00Z'));
  for (const f of [m.save, m.reset, m.toast.success, m.toast.error]) f.mockReset();
  m.save.mockImplementation(async (d: unknown) => ({ success: true, defaults: d }));
  m.reset.mockResolvedValue({ success: true });
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
const termin = () => container.querySelector<HTMLInputElement>('#payment-due-date')!.value;

describe('formularz nowej faktury z domyślnymi firmy', () => {
  it('bez ustawień: 14 dni od dziś i przelew, jak dotąd', async () => {
    await formularz();
    expect(termin()).toBe('2026-11-30');
    expect(container.textContent).toMatch(/przelew/i);
  });

  it('z ustawieniami: termin firmy w dniach od dziś', async () => {
    await formularz({ defaults: { paymentMethod: 'cash', paymentDays: 30 } });
    expect(termin()).toBe('2026-12-16');
  });

  it('forma płatności firmy jest wybrana na starcie', async () => {
    await formularz({ defaults: { paymentMethod: 'cash', paymentDays: null } });
    expect(container.textContent).toMatch(/gotówk/i);
    expect(termin()).toBe('2026-11-30');
  });

  it('podkład z faktury (initialValues) ma pierwszeństwo przed domyślnymi firmy', async () => {
    await formularz({ defaults: { paymentMethod: 'cash', paymentDays: 30 }, initialValues: { paymentMethod: 'card', paymentDueDate: '2026-11-20' } });
    expect(termin()).toBe('2026-11-20');
    expect(container.textContent).toMatch(/kart/i);
    expect(container.textContent).not.toMatch(/gotówk/i);
  });
});

describe('ustawienia domyślne w Ustawieniach → Firma', () => {
  const pokaz = (props: Partial<Parameters<typeof InvoiceDefaultsForm>[0]> = {}) =>
    act(async () => {
      root.render(<InvoiceDefaultsForm initial={null} canEdit {...props} />);
    });
  const ustawInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  const wpisz = (id: string, tekst: string) =>
    act(async () => {
      const el = container.querySelector<HTMLInputElement>(`#${id}`)!;
      ustawInput.call(el, tekst);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const klik = (tekst: string) => {
    const b = [...container.querySelectorAll('button')].find((x) => x.textContent?.includes(tekst));
    if (!b) throw new Error(`brak przycisku ${tekst}`);
    return act(async () => { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  };

  it('pokazuje obecne ustawienia i wyjaśnia, że kopia idzie osobną wiadomością', async () => {
    await pokaz({ initial: { paymentMethod: 'cash', paymentDays: 30, accountantCopyEmail: 'k@example.test' } });
    expect(container.querySelector<HTMLInputElement>('#invoice-defaults-days')!.value).toBe('30');
    expect(container.querySelector<HTMLInputElement>('#invoice-defaults-copy')!.value).toBe('k@example.test');
    expect(container.textContent).toMatch(/osobn(a|ą) wiadomo/i);
  });

  it('zapis wysyła termin jako liczbę, adres i formę', async () => {
    await pokaz();
    await wpisz('invoice-defaults-days', '21');
    await wpisz('invoice-defaults-copy', 'ksiegowa@example.test');
    await klik('Zapisz ustawienia');
    expect(m.save).toHaveBeenCalledWith(expect.objectContaining({ paymentDays: 21, accountantCopyEmail: 'ksiegowa@example.test' }));
    expect(m.toast.success).toHaveBeenCalled();
  });

  it('pusty termin to brak ustawienia (null), nie zero', async () => {
    await pokaz({ initial: { paymentMethod: null, paymentDays: 30, accountantCopyEmail: null } });
    await wpisz('invoice-defaults-days', '');
    await klik('Zapisz ustawienia');
    expect(m.save).toHaveBeenCalledWith(expect.objectContaining({ paymentDays: null }));
  });

  it('błąd z serwera pokazany, wyjątek akcji nie psuje ekranu', async () => {
    m.save.mockResolvedValueOnce({ success: false, error: 'Adres księgowej jest nieprawidłowy.' });
    await pokaz();
    await wpisz('invoice-defaults-copy', 'zly');
    await klik('Zapisz ustawienia');
    expect(m.toast.error).toHaveBeenCalledWith('Adres księgowej jest nieprawidłowy.');
    m.save.mockRejectedValueOnce(new Error('sieć'));
    await wpisz('invoice-defaults-copy', 'inny');
    await klik('Zapisz ustawienia');
    expect(m.toast.error).toHaveBeenCalledTimes(2);
  });

  it('„Przywróć domyślne” kasuje ustawienia i czyści pola', async () => {
    await pokaz({ initial: { paymentMethod: 'cash', paymentDays: 30, accountantCopyEmail: 'k@example.test' } });
    await klik('Przywróć domyślne');
    expect(m.reset).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLInputElement>('#invoice-defaults-days')!.value).toBe('');
    expect(container.querySelector<HTMLInputElement>('#invoice-defaults-copy')!.value).toBe('');
  });

  it('członek bez uprawnień: tylko odczyt z wyjaśnieniem', async () => {
    await pokaz({ canEdit: false, initial: { paymentMethod: null, paymentDays: 30, accountantCopyEmail: null } });
    expect(container.querySelector<HTMLInputElement>('#invoice-defaults-days')!.readOnly).toBe(true);
    expect([...container.querySelectorAll('button')].some((b) => b.textContent?.includes('Zapisz ustawienia'))).toBe(false);
    expect(container.textContent).toMatch(/właściciel albo administrator/i);
  });
});
