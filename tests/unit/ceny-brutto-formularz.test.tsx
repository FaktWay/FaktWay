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
import type { PrefillFromLastInvoice } from '@/components/invoices/actions';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

/**
 * Formularz zwykłej faktury i faktury do paragonu w cenach brutto (plan cen
 * brutto, PR (b)). Jeden wybór dla całej faktury: „Ceny netto” (domyślnie, jak
 * dotąd) albo „Ceny brutto”; przy cenach brutto pole ceny pozycji to cena
 * brutto, a podgląd sum liczy to samo co serwer (VAT od sumy brutto stawki).
 * Faktura do paragonu przy pustych cenach przechodzi na ceny brutto, bo
 * paragon ma kwoty brutto. Autozapis (#814), ustawienia domyślne (#818)
 * i „Wypełnij z ostatniej faktury” niosą metodę i ceny brutto.
 *
 * Wszystko to tylko przy włączonym wyłączniku cen brutto (`grossPricesAvailable`
 * ze strony, `cenyBruttoDostepne()`); przy wyłączonym formularz jest jak dotąd:
 * bez wyboru metody, FP w cenach netto, podkład i kopia robocza w cenach netto
 * (blok na końcu pliku).
 *
 * Prawdziwy `InvoiceForm` w jsdom; atrapy: akcje serwera, wyszukiwarka
 * nabywcy, katalog produktów, nawigacja.
 */

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-11-17T08:00:00Z'));
  for (const f of Object.values(m)) f.mockReset();
  m.suggest.mockResolvedValue({ ok: true, items: [] });
  m.autosave.mockResolvedValue({ ok: true, savedAt: '2026-11-17T08:00:05.000Z' });
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
  lines: ['Kawa', 'Herbata', 'Woda'].map((name) => ({ name, unit: 'szt.', quantity: 1, unitPriceNet: 0, vatRate: '23' as const })),
};

/** Formularz przy włączonym wyłączniku cen brutto (testy stanu wyłączonego podają `grossPricesAvailable: false`). */
async function pokaz(props: Partial<Parameters<typeof InvoiceForm>[0]> = {}) {
  await act(async () => {
    root.render(<InvoiceForm tenantId={TENANT} initialValues={POCZATEK} grossPricesAvailable {...props} />);
  });
}

const czekaj = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const metoda = () => container.querySelector<HTMLSelectElement>('select#prices-mode');
const cena = (i: number) => container.querySelector<HTMLInputElement>(`#line-${i}-unit-price`);
const etykietaCeny = (i: number) => container.querySelector(`label[for="line-${i}-unit-price"]`)?.textContent;
const podsumowanie = () => container.querySelector('section[aria-label="Podsumowanie faktury"]')?.textContent ?? '';

async function wybierzMetode(wartosc: 'netto' | 'brutto') {
  const pole = metoda();
  if (!pole) throw new Error('brak wyboru metody cen');
  await act(async () => {
    ustawWybor.call(pole, wartosc);
    pole.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function wpisz(pole: HTMLInputElement | null, tekst: string) {
  if (!pole) throw new Error('brak pola');
  await act(async () => {
    ustawWartosc.call(pole, tekst);
    pole.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function wybierz(pole: HTMLSelectElement | null, wartosc: string) {
  if (!pole) throw new Error('brak listy');
  await act(async () => {
    ustawWybor.call(pole, wartosc);
    pole.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function klik(tekst: string) {
  const przycisk = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === tekst);
  if (!przycisk) throw new Error(`brak przycisku ${tekst}`);
  await act(async () => {
    przycisk.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await czekaj(50);
}

async function zapiszSzkic(): Promise<InvoiceFormValues | null> {
  await klik('Zapisz szkic');
  const wywolanie = m.saveDraft.mock.calls.at(-1);
  return wywolanie ? (wywolanie[0] as InvoiceFormValues) : null;
}

async function przelaczParagon() {
  const fp = container.querySelector<HTMLInputElement>('#receipt-invoice');
  if (!fp) throw new Error('brak pola faktury do paragonu');
  await act(async () => {
    fp.click();
  });
}

describe('formularz faktury: ceny netto albo brutto dla całej faktury', () => {
  it('domyślnie ceny netto, jak dotąd: wybór „Ceny netto” i pole „Cena netto (zł)”', async () => {
    await pokaz();
    expect(metoda()?.value).toBe('netto');
    expect([...metoda()!.options].map((o) => o.textContent)).toEqual(['Ceny netto', 'Ceny brutto']);
    expect(etykietaCeny(0)).toBe('Cena netto (zł)');
  });

  it('wybór „Ceny brutto”: pole ceny brutto, podgląd pozycji i sum jak serwer (VAT 0,56 od 3,00), do zapisu idą metoda i ceny brutto', async () => {
    await pokaz();
    await wybierzMetode('brutto');
    expect(etykietaCeny(0)).toBe('Cena brutto (zł)');
    expect(cena(0)?.value).toBe('');
    for (const i of [0, 1, 2]) await wpisz(cena(i), '1');
    // 3 × 1,00 zł brutto przy 23 %: VAT od sumy brutto stawki 0,56, nie 3 × 0,19.
    expect(podsumowanie()).toContain('Razem netto2,44 zł');
    expect(podsumowanie()).toContain('VAT 23%0,56 zł');
    expect(podsumowanie()).toContain('Do zapłaty3,00 zł');
    // Netto pozycji z tego samego podziału VAT stawki co faktura (0,81, 0,81, 0,82).
    expect(container.textContent).toContain('Netto: 0,81 zł');
    expect(container.textContent).toContain('Netto: 0,82 zł');
    const values = await zapiszSzkic();
    expect(values?.pricesGross).toBe(true);
    expect(values?.lines.map((l) => l.unitPriceGross)).toEqual([1, 1, 1]);
  });

  it('przełączenie metody nie przelicza cen: wpisana cena netto wraca po powrocie, ukryta cena drugiej metody nie zatrzymuje zapisu', async () => {
    await pokaz({ initialValues: { ...POCZATEK, lines: [POCZATEK.lines![0]!] } });
    await wpisz(cena(0), '100');
    await wybierzMetode('brutto');
    expect(cena(0)?.value).toBe('');
    await wpisz(cena(0), '-5');
    await wybierzMetode('netto');
    expect(cena(0)?.value).toBe('100');
    const netto = await zapiszSzkic();
    expect(netto).toMatchObject({ pricesGross: false });
    expect(netto?.lines[0]?.unitPriceNet).toBe(100);
    await wybierzMetode('brutto');
    await wpisz(cena(0), '123');
    await wybierzMetode('netto');
    await wpisz(cena(0), '');
    await wybierzMetode('brutto');
    expect(cena(0)?.value).toBe('123');
    const brutto = await zapiszSzkic();
    expect(brutto).toMatchObject({ pricesGross: true });
    expect(brutto?.lines[0]?.unitPriceGross).toBe(123);
    expect(m.saveDraft).toHaveBeenCalledTimes(2);
  });

  it('stawka zw przy cenach brutto: po zapisie komunikat przy polu stawki pozycji z wyjściem, bez zapisu', async () => {
    await pokaz({ initialValues: { ...POCZATEK, lines: [POCZATEK.lines![0]!] } });
    await wybierzMetode('brutto');
    await wpisz(cena(0), '10');
    await wybierz(container.querySelector<HTMLSelectElement>('#line-0-vat-rate'), 'zw');
    await klik('Zapisz szkic');
    expect(m.saveDraft).not.toHaveBeenCalled();
    const blad = container.querySelector('#line-0-vat-rate-error');
    expect(blad?.textContent).toContain(
      'Stawka „zw” nie ma podatku, więc faktura w cenach brutto jej nie obsługuje. Wystaw fakturę w cenach netto.',
    );
  });

  it('pusta cena brutto przy cenach brutto: błąd „Podaj cenę brutto pozycji” w bloku błędów, bez zapisu', async () => {
    await pokaz({ initialValues: { ...POCZATEK, lines: [POCZATEK.lines![0]!] } });
    await wybierzMetode('brutto');
    await klik('Zapisz szkic');
    expect(m.saveDraft).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="blok-bledow-formularza"]')?.textContent).toContain(
      'Pozycja 1, cena brutto: Podaj cenę brutto pozycji',
    );
  });
});

describe('faktura do paragonu domyślnie w cenach brutto', () => {
  it('zaznaczenie FP przy pustych cenach przechodzi na ceny brutto, odznaczenie bez wpisanej ceny brutto wraca do cen netto', async () => {
    await pokaz();
    await przelaczParagon();
    expect(metoda()?.value).toBe('brutto');
    expect(etykietaCeny(0)).toBe('Cena brutto (zł)');
    await przelaczParagon();
    expect(metoda()?.value).toBe('netto');
  });

  it('FP z wpisaną ceną netto zostaje w cenach netto: wpisanych cen nie przestawiamy', async () => {
    await pokaz();
    await wpisz(cena(1), '12.5');
    await przelaczParagon();
    expect(metoda()?.value).toBe('netto');
    expect(cena(1)?.value).toBe('12.5');
  });

  it('po wpisaniu ceny brutto odznaczenie FP nie zmienia metody', async () => {
    await pokaz();
    await przelaczParagon();
    await wpisz(cena(0), '4.99');
    await przelaczParagon();
    expect(metoda()?.value).toBe('brutto');
    expect(cena(0)?.value).toBe('4.99');
  });
});

describe('podkład, ustawienia domyślne i autozapis niosą metodę i ceny brutto', () => {
  const PODKLAD_BRUTTO: Partial<InvoiceFormValues> = {
    ...POCZATEK,
    pricesGross: true,
    lines: [{ name: 'Obiad', unit: 'szt.', quantity: 2, unitPriceNet: 0, unitPriceGross: 20.99, vatRate: '8' }],
  };

  it('„Wypełnij” z ostatniej faktury w cenach brutto: metoda i cena brutto wracają', async () => {
    const prefill = {
      contractorName: 'Klient sp. z o.o.',
      values: {
        buyerNip: '5252241585', buyerName: 'Klient sp. z o.o.', buyerAddressLine1: 'ul. Klienta 10', buyerAddressLine2: '02-001 Warszawa',
        buyerEmail: '', paymentMethod: 'transfer', bankAccount: 'PL61109010140000071219812874',
        pricesGross: true,
        lines: [{ name: 'Obiad', unit: 'szt.', quantity: 2, unitPriceNet: 0, unitPriceGross: 20.99, vatRate: '8' }],
      },
    } as PrefillFromLastInvoice;
    await pokaz({ initialValues: null, prefill });
    expect(metoda()?.value).toBe('netto');
    await klik('Wypełnij →');
    expect(metoda()?.value).toBe('brutto');
    expect(cena(0)?.value).toBe('20.99');
    expect(podsumowanie()).toContain('Do zapłaty41,98 zł');
  });

  it('podkład z faktury w cenach brutto ma pierwszeństwo przed domyślnymi firmy (#818); same domyślne zostawiają ceny netto', async () => {
    const defaults = { paymentMethod: 'cash' as const, paymentDays: 7, accountantCopyEmail: null };
    await pokaz({ initialValues: PODKLAD_BRUTTO, defaults });
    expect(metoda()?.value).toBe('brutto');
    expect(cena(0)?.value).toBe('20.99');
    act(() => root.unmount());
    root = createRoot(container);
    await pokaz({ initialValues: null, defaults });
    expect(metoda()?.value).toBe('netto');
  });

  it('autozapis (#814): kopia robocza ma metodę i cenę brutto, a „Przywróć” wraca do cen brutto', async () => {
    await pokaz({ initialValues: null });
    await wybierzMetode('brutto');
    await wpisz(cena(0), '7.5');
    await czekaj(6000);
    const zapisane = m.autosave.mock.calls.at(-1)?.[0] as InvoiceFormValues | undefined;
    expect(zapisane?.pricesGross).toBe(true);
    expect(zapisane?.lines[0]?.unitPriceGross).toBe(7.5);
    act(() => root.unmount());
    root = createRoot(container);
    const restoredDraft = {
      requestKey: '33333333-3333-4333-8333-333333333333',
      savedAt: '2026-11-17T07:30:00.000Z',
      values: JSON.parse(JSON.stringify({ pricesGross: zapisane?.pricesGross, lines: zapisane?.lines })) as Partial<InvoiceFormValues>,
    };
    await pokaz({ initialValues: null, restoredDraft });
    expect(metoda()?.value).toBe('netto');
    await klik('Przywróć');
    expect(metoda()?.value).toBe('brutto');
    expect(cena(0)?.value).toBe('7.5');
  });

  it('przywrócenie kopii sprzed cen brutto (bez metody) daje ceny netto, także po wcześniejszym wyborze cen brutto', async () => {
    const restoredDraft = {
      requestKey: '33333333-3333-4333-8333-333333333333',
      savedAt: '2026-11-17T07:30:00.000Z',
      values: { lines: [{ name: 'Usługa', unit: 'szt.', quantity: 1, unitPriceNet: 250, vatRate: '23' }] } as Partial<InvoiceFormValues>,
    };
    await pokaz({ initialValues: null, restoredDraft });
    await wybierzMetode('brutto');
    await klik('Przywróć');
    expect(metoda()?.value).toBe('netto');
    expect(cena(0)?.value).toBe('250');
  });
});

describe('wyłącznik cen brutto wyłączony: formularz jak dotąd, w cenach netto', () => {
  const WYLACZONY = { grossPricesAvailable: false } as const;
  const kopiaBrutto = {
    requestKey: '33333333-3333-4333-8333-333333333333',
    savedAt: '2026-11-17T07:30:00.000Z',
    values: {
      pricesGross: true,
      lines: [{ name: 'Kawa', unit: 'szt.', quantity: 1, unitPriceNet: 4.07, unitPriceGross: 5, vatRate: '23' }],
    } as Partial<InvoiceFormValues>,
  };

  it('bez wyboru metody cen i z polem „Cena netto”; domyślnie formularz też go nie pokazuje', async () => {
    await pokaz(WYLACZONY);
    expect(metoda()).toBeNull();
    expect(etykietaCeny(0)).toBe('Cena netto (zł)');
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(<InvoiceForm tenantId={TENANT} initialValues={POCZATEK} />);
    });
    expect(metoda()).toBeNull();
  });

  it('faktura do paragonu przy pustych cenach zostaje w cenach netto (pole ceny netto przed i po odznaczeniu)', async () => {
    await pokaz(WYLACZONY);
    await przelaczParagon();
    expect(container.querySelector<HTMLInputElement>('#receipt-invoice')?.checked).toBe(true);
    expect(metoda()).toBeNull();
    expect(etykietaCeny(0)).toBe('Cena netto (zł)');
    await przelaczParagon();
    expect(etykietaCeny(0)).toBe('Cena netto (zł)');
  });

  it('podkład, „Wypełnij” i kopia robocza w cenach brutto zostają w cenach netto', async () => {
    await pokaz({ ...WYLACZONY, initialValues: { ...POCZATEK, pricesGross: true, lines: [{ name: 'Obiad', unit: 'szt.', quantity: 2, unitPriceNet: 0, unitPriceGross: 20.99, vatRate: '8' }] } });
    expect(etykietaCeny(0)).toBe('Cena netto (zł)');
    act(() => root.unmount());
    root = createRoot(container);
    const prefill = {
      contractorName: 'Klient sp. z o.o.',
      values: {
        buyerNip: '5252241585', buyerName: 'Klient sp. z o.o.', buyerAddressLine1: 'ul. Klienta 10', buyerAddressLine2: '02-001 Warszawa',
        buyerEmail: '', paymentMethod: 'transfer', bankAccount: 'PL61109010140000071219812874',
        pricesGross: true,
        lines: [{ name: 'Obiad', unit: 'szt.', quantity: 2, unitPriceNet: 0, unitPriceGross: 20.99, vatRate: '8' }],
      },
    } as PrefillFromLastInvoice;
    await pokaz({ ...WYLACZONY, initialValues: null, prefill });
    await klik('Wypełnij →');
    expect(etykietaCeny(0)).toBe('Cena netto (zł)');
    act(() => root.unmount());
    root = createRoot(container);
    // Kopia robocza w cenach brutto (zapisana przy włączonym wyłączniku): po „Przywróć” ceny netto z kopii.
    await pokaz({ ...WYLACZONY, restoredDraft: kopiaBrutto });
    await klik('Przywróć');
    expect(metoda()).toBeNull();
    expect(etykietaCeny(0)).toBe('Cena netto (zł)');
    expect(cena(0)?.value).toBe('4.07');
    const values = await zapiszSzkic();
    expect(values?.pricesGross).toBe(false);
    expect(values?.lines[0]?.unitPriceNet).toBe(4.07);
  });
});
