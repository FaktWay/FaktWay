// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ save: vi.fn(), reset: vi.fn(), toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('sonner', () => ({ toast: m.toast }));
vi.mock('@/app/actions/invoice-email-template', () => ({
  saveInvoiceEmailTemplateAction: m.save,
  resetInvoiceEmailTemplateAction: m.reset,
}));

import { InvoiceEmailTemplateForm } from '@/components/settings/invoice-email-template-form';
import { DEFAULT_INVOICE_EMAIL_TEMPLATE } from '@/lib/email/invoice-email-template';

/**
 * Własny szablon maila z fakturą w ustawieniach firmy (plan kompletnej
 * aplikacji, krok 2.8): pola tematu i treści, wstawianie pól, podgląd na
 * przykładowych danych, zapis i powrót do domyślnego. Prawdziwy komponent,
 * atrapa tylko akcji serwera.
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  for (const f of [m.save, m.reset, m.toast.success, m.toast.error]) f.mockReset();
  m.save.mockImplementation(async (t: { subject: string; body: string }) => ({ success: true, template: t }));
  m.reset.mockResolvedValue({ success: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function pokaz(props: Partial<Parameters<typeof InvoiceEmailTemplateForm>[0]> = {}) {
  await act(async () => {
    root.render(<InvoiceEmailTemplateForm initial={null} canEdit sellerName="Moja Firma sp. z o.o." sampleDueDate="2026-12-15" {...props} />);
  });
}

const ustawInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
const ustawArea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
const temat = () => container.querySelector<HTMLInputElement>('#invoice-email-subject')!;
const tresc = () => container.querySelector<HTMLTextAreaElement>('#invoice-email-body')!;
const podglad = () => container.querySelector('[aria-label="Podgląd wiadomości"]')?.textContent ?? '';

async function wpisz(pole: HTMLInputElement | HTMLTextAreaElement, tekst: string) {
  await act(async () => {
    (pole instanceof HTMLInputElement ? ustawInput : ustawArea).call(pole, tekst);
    pole.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const klik = (tekst: string) => {
  const b = [...container.querySelectorAll('button')].find((x) => x.textContent?.includes(tekst));
  if (!b) throw new Error(`brak przycisku ${tekst}`);
  return act(async () => { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
};

describe('formularz szablonu maila z fakturą', () => {
  it('bez własnego szablonu startuje od domyślnego i mówi, że używa domyślnego', async () => {
    await pokaz();
    expect(temat().value).toBe(DEFAULT_INVOICE_EMAIL_TEMPLATE.subject);
    expect(tresc().value).toBe(DEFAULT_INVOICE_EMAIL_TEMPLATE.body);
    expect(container.textContent).toContain('szablon domyślny');
  });

  it('z zapisanym szablonem pokazuje go i mówi, że to własny', async () => {
    await pokaz({ initial: { subject: 'Moja faktura {numer}', body: 'Cześć' } });
    expect(temat().value).toBe('Moja faktura {numer}');
    expect(container.textContent).toContain('własny szablon');
  });

  it('podgląd składa temat i treść z przykładowych danych i mówi, że to przykład', async () => {
    await pokaz();
    await wpisz(temat(), 'Faktura {numer} na {kwota}');
    await wpisz(tresc(), 'Zapłać do {termin}.\n\nPozdrawia {sprzedawca}');
    const p = podglad();
    expect(p).toContain('Faktura FV/12/11/2026 na 1 230,00 PLN');
    expect(p).toContain('Zapłać do 2026-12-15.');
    expect(p).toContain('Pozdrawia Moja Firma sp. z o.o.');
    expect(container.textContent).toMatch(/przykładowych danych/i);
    expect(container.textContent).toMatch(/kwota, termin płatności i tytuł przelewu/i);
  });

  it('nieznane pole: podgląd zastąpiony komunikatem, zapis zablokowany', async () => {
    await pokaz();
    await wpisz(temat(), 'Faktura {numr}');
    expect(container.textContent).toContain('{numr}');
    await klik('Zapisz szablon');
    expect(m.save).not.toHaveBeenCalled();
  });

  it('przycisk pola wstawia je w miejscu kursora w ostatnio używanym polu', async () => {
    await pokaz();
    await wpisz(tresc(), 'Kwota: ');
    await act(async () => { tresc().focus(); tresc().setSelectionRange(7, 7); });
    await klik('{kwota}');
    expect(tresc().value).toBe('Kwota: {kwota}');
  });

  it('zapis wysyła temat i treść, pokazuje potwierdzenie i stan „własny szablon”', async () => {
    await pokaz();
    await wpisz(temat(), 'Faktura {numer}');
    await wpisz(tresc(), 'Dzień dobry, wysyłamy {numer}.');
    await klik('Zapisz szablon');
    expect(m.save).toHaveBeenCalledWith({ subject: 'Faktura {numer}', body: 'Dzień dobry, wysyłamy {numer}.' });
    expect(m.toast.success).toHaveBeenCalled();
    expect(container.textContent).toContain('własny szablon');
  });

  it('błąd zapisu z serwera pokazany klientowi, szablon zostaje w polach', async () => {
    m.save.mockResolvedValue({ success: false, error: 'Nie udało się zapisać szablonu. Spróbuj ponownie.' });
    await pokaz();
    await wpisz(temat(), 'Faktura {numer}');
    await klik('Zapisz szablon');
    expect(m.toast.error).toHaveBeenCalledWith('Nie udało się zapisać szablonu. Spróbuj ponownie.');
    expect(temat().value).toBe('Faktura {numer}');
  });

  it('wyjątek akcji to komunikat, nie biały ekran', async () => {
    m.save.mockRejectedValue(new Error('sieć'));
    await pokaz();
    await wpisz(temat(), 'Faktura {numer}');
    await klik('Zapisz szablon');
    expect(m.toast.error).toHaveBeenCalled();
  });

  it('„Przywróć domyślny” kasuje własny szablon i wraca do domyślnego tekstu', async () => {
    await pokaz({ initial: { subject: 'Moja {numer}', body: 'Cześć' } });
    await klik('Przywróć domyślny');
    expect(m.reset).toHaveBeenCalledTimes(1);
    expect(temat().value).toBe(DEFAULT_INVOICE_EMAIL_TEMPLATE.subject);
    expect(tresc().value).toBe(DEFAULT_INVOICE_EMAIL_TEMPLATE.body);
    expect(container.textContent).toContain('szablon domyślny');
  });

  it('bez własnego szablonu „Przywróć domyślny” nie ma czego kasować (przycisk wyłączony)', async () => {
    await pokaz();
    const b = [...container.querySelectorAll('button')].find((x) => x.textContent?.includes('Przywróć domyślny'))!;
    expect(b.disabled).toBe(true);
  });

  it('członek bez uprawnień: pola tylko do odczytu, bez przycisków zapisu, z wyjaśnieniem', async () => {
    await pokaz({ canEdit: false, initial: { subject: 'Moja {numer}', body: 'Cześć' } });
    expect(temat().disabled || temat().readOnly).toBe(true);
    expect([...container.querySelectorAll('button')].some((b) => b.textContent?.includes('Zapisz szablon'))).toBe(false);
    expect(container.textContent).toMatch(/właściciel albo administrator/i);
  });
});
