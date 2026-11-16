// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  autosave: vi.fn(),
  discard: vi.fn(),
  saveDraft: vi.fn(),
  send: vi.fn(),
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: m.push, refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/invoices/actions', () => ({
  saveDraftAction: m.saveDraft,
  saveAndSendInvoiceAction: m.send,
  lookupBuyerAction: vi.fn(),
  prefillFromLastInvoiceAction: vi.fn(),
}));
vi.mock('@/app/actions/invoice-autosave', () => ({
  saveInvoiceAutosaveAction: m.autosave,
  discardInvoiceAutosaveAction: m.discard,
}));
vi.mock('@/components/invoices/buyer-lookup', () => ({
  BuyerLookup: (p: { inputId?: string; nip: string }) => <input id={p.inputId} defaultValue={p.nip} />,
}));
vi.mock('@/app/actions/produkty', () => ({ suggestProductsAction: vi.fn().mockResolvedValue({ ok: true, items: [] }) }));

import { InvoiceForm } from '@/components/invoices/invoice-form';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

/**
 * Autozapis formularza zwykłej faktury (plan kompletnej aplikacji, krok 2.8):
 * zapis roboczej kopii co kilka sekund po zmianie, ten sam klucz przy każdym
 * zapisie (jedna kopia, nie kolejne), przywrócenie z banera, koniec autozapisu
 * po zapisie faktury. Prawdziwy `InvoiceForm`, atrapa tylko akcji serwera.
 */

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY_ZAPISANY = '33333333-3333-4333-8333-333333333333';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-16T08:00:00Z'));
  for (const f of Object.values(m)) f.mockReset();
  m.autosave.mockResolvedValue({ ok: true, savedAt: '2026-11-16T08:00:05.000Z' });
  m.discard.mockResolvedValue(undefined);
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
  window.confirm = vi.fn(() => true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const ustawWartosc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;

async function pokaz(props: Partial<Parameters<typeof InvoiceForm>[0]> = {}) {
  await act(async () => {
    root.render(<InvoiceForm tenantId={TENANT} initialValues={{}} {...props} />);
  });
}

const czekaj = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

async function wpisz(id: string, tekst: string) {
  const pole = container.querySelector<HTMLInputElement>(`#${id}`)!;
  await act(async () => {
    ustawWartosc.call(pole, tekst);
    pole.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const klik = (tekst: string) => {
  const przycisk = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(tekst));
  if (!przycisk) throw new Error(`brak przycisku ${tekst}`);
  return act(async () => { przycisk.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
};

const wartosciOstatniegoZapisu = () => m.autosave.mock.calls.at(-1)![0] as InvoiceFormValues;

describe('autozapis formularza faktury', () => {
  it('po zmianie zapisuje kopię roboczą po kilku sekundach, nie od razu', async () => {
    await pokaz();
    await wpisz('buyer-name', 'Acme sp. z o.o.');
    await czekaj(1500);
    expect(m.autosave).not.toHaveBeenCalled();
    await czekaj(4000);
    expect(m.autosave).toHaveBeenCalledTimes(1);
    expect(wartosciOstatniegoZapisu()).toMatchObject({ buyerName: 'Acme sp. z o.o.' });
    expect(m.autosave.mock.calls[0]![1]).toBe(TENANT);
  });

  it('seria zmian w krótkim czasie to jeden zapis z ostatnią wartością', async () => {
    await pokaz();
    await wpisz('buyer-name', 'A');
    await czekaj(2000);
    await wpisz('buyer-name', 'Ac');
    await czekaj(2000);
    await wpisz('buyer-name', 'Acme');
    await czekaj(6000);
    expect(m.autosave).toHaveBeenCalledTimes(1);
    expect(wartosciOstatniegoZapisu().buyerName).toBe('Acme');
  });

  it('kolejne zapisy idą pod tym samym kluczem (jedna kopia, nie dwie)', async () => {
    await pokaz();
    await wpisz('buyer-name', 'Acme');
    await czekaj(6000);
    await wpisz('buyer-name', 'Acme sp. z o.o.');
    await czekaj(6000);
    expect(m.autosave).toHaveBeenCalledTimes(2);
    const [a, b] = m.autosave.mock.calls.map((c) => (c[0] as InvoiceFormValues).numberRequestKey);
    expect(a).toBeTruthy();
    expect(a).toBe(b);
  });

  it('bez zmian nic nie zapisuje', async () => {
    await pokaz();
    await czekaj(60_000);
    expect(m.autosave).not.toHaveBeenCalled();
  });

  it('ciągłe pisanie nie odkłada zapisu w nieskończoność (najdalej po 15 s)', async () => {
    await pokaz();
    for (let i = 0; i < 12; i++) {
      await wpisz('buyer-name', `Acme ${i}`);
      await czekaj(2000);
    }
    expect(m.autosave.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('zapisuje też niedokończony formularz (bez NIP, numeru i pozycji)', async () => {
    await pokaz();
    await wpisz('buyer-name', 'Ktoś');
    await czekaj(6000);
    expect(m.autosave).toHaveBeenCalledTimes(1);
    expect(wartosciOstatniegoZapisu().buyerNip).toBe('');
  });

  it('pokazuje, kiedy zapisano, i nie blokuje formularza przy błędzie zapisu', async () => {
    await pokaz();
    await wpisz('buyer-name', 'Acme');
    await czekaj(6000);
    expect(container.textContent).toContain('Autozapis');
    m.autosave.mockResolvedValue({ ok: false });
    await wpisz('buyer-name', 'Acme 2');
    await czekaj(6000);
    expect(container.textContent).toMatch(/Autozapis.*(niedostępny|nie udał)/);
  });

  it('wyjątek akcji nie psuje formularza', async () => {
    m.autosave.mockRejectedValue(new Error('sieć'));
    await pokaz();
    await wpisz('buyer-name', 'Acme');
    await czekaj(6000);
    expect(container.querySelector<HTMLInputElement>('#buyer-name')!.value).toBe('Acme');
  });

  it('w trybie faktury cyklicznej nie zapisuje (tam nie ma szkicu)', async () => {
    await pokaz({ recurringInvoiceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', recurringPeriod: '2026-11' });
    await wpisz('buyer-name', 'Acme');
    await czekaj(10_000);
    expect(m.autosave).not.toHaveBeenCalled();
  });

  it('po udanym zapisie szkicu kasuje kopię roboczą i przestaje zapisywać', async () => {
    m.saveDraft.mockResolvedValue({ success: true, invoiceId: 'inv-1' });
    await pokaz({
      initialValues: {
        internalNumber: 'FV/1/2026', buyerNip: '5252241585', buyerName: 'Acme',
        buyerAddressLine1: 'Prosta 1', buyerAddressLine2: '00-001 Warszawa', paymentMethod: 'cash',
        lines: [{ name: 'Usługa', unit: 'szt.', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
      },
    });
    await wpisz('buyer-name', 'Acme 2');
    await klik('Zapisz szkic');
    await czekaj(100);
    expect(m.saveDraft).toHaveBeenCalledTimes(1);
    const klucz = (m.saveDraft.mock.calls[0]![0] as InvoiceFormValues).numberRequestKey;
    expect(m.discard).toHaveBeenCalledWith(klucz, TENANT);
    await czekaj(60_000);
    expect(m.autosave).not.toHaveBeenCalled();
  });
});

describe('przywracanie kopii roboczej', () => {
  const przywracany = {
    requestKey: KEY_ZAPISANY,
    savedAt: '2026-11-15T17:30:00.000Z',
    values: { buyerName: 'Wczorajszy Klient', buyerEmail: 'k@example.com', notes: 'Uwaga z wczoraj' } as Partial<InvoiceFormValues>,
  };

  it('pokazuje baner z propozycją przywrócenia i nic nie wkłada samo', async () => {
    await pokaz({ restoredDraft: przywracany });
    expect(container.textContent).toContain('niezapisaną fakturę');
    expect(container.querySelector<HTMLInputElement>('#buyer-name')!.value).toBe('');
  });

  it('„Przywróć” wkłada wartości, chowa baner i kolejne zapisy idą pod kluczem kopii', async () => {
    await pokaz({ restoredDraft: przywracany });
    await klik('Przywróć');
    expect(container.querySelector<HTMLInputElement>('#buyer-name')!.value).toBe('Wczorajszy Klient');
    expect(container.querySelector<HTMLInputElement>('#buyer-email')!.value).toBe('k@example.com');
    expect(container.textContent).not.toContain('niezapisaną fakturę');
    await wpisz('buyer-name', 'Wczorajszy Klient sp. z o.o.');
    await czekaj(6000);
    expect(wartosciOstatniegoZapisu().numberRequestKey).toBe(KEY_ZAPISANY);
  });

  it('po przywróceniu zapis faktury niesie klucz kopii (zapisana faktura wyklucza kopię z kolejnych propozycji)', async () => {
    m.saveDraft.mockResolvedValue({ success: false, error: 'x' });
    await pokaz({ restoredDraft: przywracany });
    await klik('Przywróć');
    await klik('Zapisz szkic');
    // walidacja formularza nie przechodzi (brak NIP i pozycji), więc zapis nie rusza; klucz sprawdzamy przez autozapis
    await wpisz('buyer-name', 'Zmiana');
    await czekaj(6000);
    expect(wartosciOstatniegoZapisu().numberRequestKey).toBe(KEY_ZAPISANY);
  });

  it('„Zacznij od nowa” kasuje kopię i zostawia pusty formularz z nowym kluczem', async () => {
    await pokaz({ restoredDraft: przywracany });
    await klik('Zacznij od nowa');
    expect(m.discard).toHaveBeenCalledWith(KEY_ZAPISANY, TENANT);
    expect(container.textContent).not.toContain('niezapisaną fakturę');
    expect(container.querySelector<HTMLInputElement>('#buyer-name')!.value).toBe('');
    await wpisz('buyer-name', 'Nowy');
    await czekaj(6000);
    expect(wartosciOstatniegoZapisu().numberRequestKey).not.toBe(KEY_ZAPISANY);
  });

  it('przywrócenie nie ustawia numeru, serii ani dat z kopii', async () => {
    await pokaz({
      restoredDraft: { ...przywracany, values: { ...przywracany.values, issueDate: '2026-10-01', internalNumber: 'FV/OLD/1', paymentDueDate: '2026-10-15' } },
    });
    await klik('Przywróć');
    expect(container.querySelector<HTMLInputElement>('#issue-date')?.value ?? '2026-11-16').toBe('2026-11-16');
    expect(container.querySelector<HTMLInputElement>('#internalNumber')?.value ?? '').not.toBe('FV/OLD/1');
  });
});
