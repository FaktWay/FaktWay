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
 * Osobne ustalenie 13 z dziennika planu (uwaga N5 czytelnika #885): firma
 * zwolniona z VAT (`vatExempt`, nowe pozycje dostają „zw”) widziała wybór
 * „Ceny brutto”, który zawsze kończy się odmową przy stawce (faktura w cenach
 * brutto nie przyjmuje stawek bez podatku, #880). Teraz takiej firmie formularz
 * nie pokazuje wyboru metody i nie przechodzi w ceny brutto z podkładu (bez
 * wyboru nie mogłaby wrócić do cen netto). Firma z VAT: wybór jak dotąd.
 * Prawdziwy `InvoiceForm` w jsdom; atrapy: akcje serwera, wyszukiwarka
 * nabywcy, katalog produktów, nawigacja.
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


describe('firma zwolniona z VAT a wybór cen brutto (ustalenie 13)', () => {
  it('zwolnienie podmiotowe (art. 113): bez wyboru „Ceny netto / Ceny brutto”, pole „Cena netto”', async () => {
    await pokaz({ vatExempt: true, vatExemptSubjective: true });
    expect(container.querySelector('select#prices-mode')).toBeNull();
    expect(container.querySelector('label[for="line-0-unit-price"]')?.textContent).toBe('Cena netto (zł)');
  });

  it('zwolnienie podmiotowe i podkład z faktury w cenach brutto: formularz w cenach netto (da się wystawić bez wyboru metody)', async () => {
    await pokaz({ vatExempt: true, vatExemptSubjective: true, initialValues: { ...POCZATEK, pricesGross: true } as Partial<InvoiceFormValues> });
    expect(container.querySelector('select#prices-mode')).toBeNull();
    expect(container.querySelector('label[for="line-0-unit-price"]')?.textContent).toBe('Cena netto (zł)');
  });

  it('zwolnienie podmiotowe i faktura do paragonu przy pustych cenach: zostaje w cenach netto', async () => {
    await pokaz({ vatExempt: true, vatExemptSubjective: true });
    const fp = container.querySelector<HTMLInputElement>('#receipt-invoice');
    expect(fp).not.toBeNull();
    await act(async () => {
      fp!.click();
    });
    expect(container.querySelector('select#prices-mode')).toBeNull();
    expect(container.querySelector('label[for="line-0-unit-price"]')?.textContent).toBe('Cena netto (zł)');
  });

  it('zwolnienie przedmiotowe (art. 43, czynny podatnik): wybór metody jest, bo sprzedaż może mieć stawkę z podatkiem', async () => {
    await pokaz({ vatExempt: true, vatExemptSubjective: false });
    expect(container.querySelector<HTMLSelectElement>('select#prices-mode')?.value).toBe('netto');
  });

  it('firma z VAT: wybór metody jak dotąd', async () => {
    await pokaz();
    expect(container.querySelector<HTMLSelectElement>('select#prices-mode')?.value).toBe('netto');
  });
});
