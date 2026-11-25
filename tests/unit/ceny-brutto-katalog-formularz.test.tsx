// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ saveDraft: vi.fn(), send: vi.fn(), suggest: vi.fn(), autosave: vi.fn(), discard: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
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
vi.mock('@/app/actions/produkty', () => ({ suggestProductsAction: m.suggest }));

import { InvoiceForm } from '@/components/invoices/invoice-form';
import type { ProductSuggestion } from '@/lib/produkty/model';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

/**
 * Ceny brutto (d): produkt z katalogu w pozycji faktury w cenach brutto.
 * Faktura w cenach brutto bierze z katalogu cenę brutto produktu (00213) do
 * pola ceny brutto pozycji; produkt bez ceny brutto nie wstawia tam niczego
 * (brak, nie 0 i nie cena netto), cofa cenę brutto wstawioną wcześniej
 * z katalogu i mówi, że cenę brutto trzeba wpisać. Faktura w cenach netto
 * i formularz przy wyłączonym wyłączniku działają jak dotąd: cena netto,
 * bez ceny brutto w pozycji. Prawdziwy `InvoiceForm` w jsdom; atrapy: akcje
 * serwera, wyszukiwarka nabywcy, katalog produktów, nawigacja.
 */

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KAWA: ProductSuggestion = { id: 'p1', name: 'Kawa ziarnista', unit: 'szt.', priceNet: 10, priceGross: 12.3, vatRate: '23', pkwiuCode: null, gtuCode: null };
const KAWA_BEZ_BRUTTO: ProductSuggestion = {
  id: 'p2', name: 'Kawa mielona', unit: 'szt.', priceNet: 150, priceGross: null, vatRate: '23', pkwiuCode: null, gtuCode: null,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-11-23T08:00:00Z'));
  for (const f of Object.values(m)) f.mockReset();
  m.suggest.mockResolvedValue({ ok: true, items: [KAWA, KAWA_BEZ_BRUTTO] });
  m.autosave.mockResolvedValue({ ok: true, savedAt: '2026-11-23T08:00:05.000Z' });
  m.discard.mockResolvedValue(undefined);
  m.saveDraft.mockResolvedValue({ success: false, error: 'stop' });
  window.confirm = vi.fn(() => true);
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
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
const ustawWybor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;

const POCZATEK: Partial<InvoiceFormValues> = {
  internalNumber: 'FV/9/11/2026',
  buyerNip: '5252241585',
  buyerName: 'Klient sp. z o.o.',
  buyerAddressLine1: 'ul. Klienta 10',
  buyerAddressLine2: '02-001 Warszawa',
  paymentMethod: 'transfer',
  bankAccount: 'PL61109010140000071219812874',
  lines: [{ name: '', unit: 'szt.', quantity: 1, unitPriceNet: 0, vatRate: '23' }],
};

async function pokaz(props: Partial<Parameters<typeof InvoiceForm>[0]> = {}) {
  await act(async () => {
    root.render(<InvoiceForm tenantId={TENANT} initialValues={POCZATEK} grossPricesAvailable {...props} />);
  });
}

const czekaj = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const nazwa = () => container.querySelector<HTMLInputElement>('#line-0-name')!;
const cena = () => container.querySelector<HTMLInputElement>('#line-0-unit-price')!;
const opcje = () => [...container.querySelectorAll<HTMLElement>('[role="option"]')];

async function wybierzMetode(wartosc: 'netto' | 'brutto') {
  const pole = container.querySelector<HTMLSelectElement>('select#prices-mode');
  if (!pole) throw new Error('brak wyboru metody cen');
  await act(async () => {
    ustawWybor.call(pole, wartosc);
    pole.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function wpisz(pole: HTMLInputElement, tekst: string, ms = 0) {
  await act(async () => {
    ustawWartosc.call(pole, tekst);
    pole.dispatchEvent(new Event('input', { bubbles: true }));
  });
  if (ms) await czekaj(ms);
}

function klawisz(pole: HTMLElement, key: string) {
  act(() => {
    pole.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

/** Wpisuje frazę w nazwę pozycji i wybiera n-tą podpowiedź klawiaturą. */
async function wybierzProdukt(n: number) {
  await wpisz(nazwa(), 'Kawa', 300);
  for (let i = 0; i <= n; i += 1) klawisz(nazwa(), 'ArrowDown');
  klawisz(nazwa(), 'Enter');
  await czekaj(10);
}

async function zapiszSzkic(): Promise<InvoiceFormValues | null> {
  const przycisk = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Zapisz szkic');
  if (!przycisk) throw new Error('brak przycisku Zapisz szkic');
  await act(async () => {
    przycisk.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await czekaj(50);
  const wywolanie = m.saveDraft.mock.calls.at(-1);
  return wywolanie ? (wywolanie[0] as InvoiceFormValues) : null;
}

describe('produkt z katalogu w fakturze w cenach brutto', () => {
  it('produkt z ceną brutto: podpowiedź pokazuje cenę brutto, wybór wstawia ją do pola ceny brutto pozycji i do zapisu', async () => {
    await pokaz();
    await wybierzMetode('brutto');
    await wpisz(nazwa(), 'Kawa', 300);
    expect(opcje()[0]!.textContent).toContain('12,30 zł brutto');
    expect(opcje()[0]!.textContent).not.toContain('zł netto');
    // Produkt bez ceny brutto nie pokazuje przy cenach brutto ceny netto jako ceny.
    expect(opcje()[1]!.textContent).not.toContain('150,00');
    klawisz(nazwa(), 'ArrowDown');
    klawisz(nazwa(), 'Enter');
    await czekaj(10);
    expect(nazwa().value).toBe('Kawa ziarnista');
    expect(cena().value).toBe('12.3');
    const values = await zapiszSzkic();
    expect(values?.pricesGross).toBe(true);
    expect(values?.lines[0]?.unitPriceGross).toBe(12.3);
  });

  it('produkt bez ceny brutto: pole ceny brutto puste (nie 0 i nie cena netto) z informacją; cena brutto poprzedniego produktu z katalogu znika', async () => {
    await pokaz();
    await wybierzMetode('brutto');
    await wybierzProdukt(0);
    expect(cena().value).toBe('12.3');
    await wybierzProdukt(1);
    expect(nazwa().value).toBe('Kawa mielona');
    expect(cena().value).toBe('');
    expect(container.textContent).toContain('Produkt nie ma w katalogu ceny brutto');
    const values = await zapiszSzkic();
    // Pusta cena brutto zatrzymuje zapis w formularzu (schemat (b)): szkic nie idzie z ceną 0 zł.
    expect(values).toBeNull();
  });

  it('cena brutto wpisana ręcznie zostaje, gdy wybrany produkt nie ma ceny brutto', async () => {
    await pokaz();
    await wybierzMetode('brutto');
    await wpisz(cena(), '5');
    await wybierzProdukt(1);
    expect(cena().value).toBe('5');
  });
});

describe('faktura w cenach netto i wyłączony wyłącznik: jak dotąd', () => {
  it('faktura w cenach netto: wybór wstawia cenę netto, cena brutto z katalogu nie trafia do pozycji', async () => {
    await pokaz();
    await wpisz(nazwa(), 'Kawa', 300);
    expect(opcje()[0]!.textContent).toContain('10,00 zł netto');
    klawisz(nazwa(), 'ArrowDown');
    klawisz(nazwa(), 'Enter');
    await czekaj(10);
    expect(cena().value).toBe('10');
    m.saveDraft.mockResolvedValue({ success: false, error: 'stop' });
    const values = await zapiszSzkic();
    expect(values?.pricesGross).not.toBe(true);
    expect(values?.lines[0]?.unitPriceGross).toBeUndefined();
    expect(values?.lines[0]?.unitPriceNet).toBe(10);
  });

  it('wyłączony: podpowiedź bez ceny brutto, wybór wstawia cenę netto jak dotąd', async () => {
    await pokaz({ grossPricesAvailable: false });
    await wpisz(nazwa(), 'Kawa', 300);
    expect(opcje()[0]!.textContent).toContain('10,00 zł netto');
    expect(opcje()[0]!.textContent).not.toContain('brutto');
    klawisz(nazwa(), 'ArrowDown');
    klawisz(nazwa(), 'Enter');
    await czekaj(10);
    expect(cena().value).toBe('10');
    const values = await zapiszSzkic();
    expect(values?.lines[0]?.unitPriceGross).toBeUndefined();
  });
});
