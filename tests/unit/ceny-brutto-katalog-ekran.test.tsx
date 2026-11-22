// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ceny brutto (d), ekran katalogu: pole „Cena brutto” w oknie produktu
 * i kolumna na liście tylko przy włączonym wyłączniku `grossPricesEnabled`
 * (odczyt strony przez `cenyBruttoDostepne`, błąd = wyłączony). Przy
 * wyłączonym okno nie wysyła pola ceny brutto, więc zapisana cena brutto
 * produktu zostaje bez zmian (akcja: `ceny-brutto-katalog.test.ts`).
 */

const m = vi.hoisted(() => ({
  list: vi.fn(),
  dostepne: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/supabase/page-context', () => ({
  getPageContext: async () => ({ supabase: {}, tenantId: 'T1', user: { id: 'u' }, role: 'owner' }),
}));
vi.mock('@/lib/produkty/baza', () => ({ listProducts: m.list }));
vi.mock('@/lib/invoices/ceny-brutto-wylacznik', () => ({ cenyBruttoDostepne: m.dostepne }));
vi.mock('@/app/actions/produkty', () => ({
  createProductAction: m.create,
  updateProductAction: m.update,
  archiveProductAction: vi.fn(),
  restoreProductAction: vi.fn(),
  deleteProductAction: vi.fn(),
}));

import ProductsPage from '@/app/(dashboard)/produkty/page';
import { ProductFormDialog } from '@/app/(dashboard)/produkty/_components/product-form-dialog';
import type { ProductListItem } from '@/lib/produkty/model';

const plain = (html: string) => html.replace(/[  ]/g, ' ').replace(/&quot;/g, '"');
const item = (extra: Partial<ProductListItem> = {}): ProductListItem => ({
  id: 'p1', name: 'Kawa', unit: 'szt.', defaultPriceNet: 10, defaultPriceGross: 12.3, defaultVatRate: '23', pkwiuCode: null, gtuCode: null,
  description: null, isArchived: false, useCount: 0, lastUsedAt: null, ...extra,
});

async function strona() {
  const el = await ProductsPage({ searchParams: Promise.resolve({}) });
  return plain(renderToStaticMarkup(el));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.list.mockResolvedValue([item(), item({ id: 'p2', name: 'Herbata', defaultPriceGross: null })]);
  m.create.mockResolvedValue({ success: true, id: 'nowy' });
  m.update.mockResolvedValue({ success: true, id: 'p1' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const ustawWartosc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;

async function otworz(props: { grossPrices: boolean; product?: ProductListItem }) {
  await act(async () => {
    root.render(<ProductFormDialog {...props} trigger={<button type='button'>Otwórz</button>} />);
  });
  const trigger = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Otwórz')!;
  await act(async () => {
    trigger.click();
  });
}

const pole = (id: string) => document.getElementById(id) as HTMLInputElement | null;

async function wpisz(el: HTMLInputElement, tekst: string) {
  await act(async () => {
    ustawWartosc.call(el, tekst);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function zapisz() {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Zapisz')!;
  await act(async () => {
    btn.click();
  });
}

describe('strona katalogu a wyłącznik cen brutto', () => {
  it('wyłączony: lista bez kolumny „Cena brutto”, opis strony jak dotąd', async () => {
    m.dostepne.mockResolvedValue(false);
    const html = await strona();
    expect(html).toContain('Cena netto');
    expect(html).not.toContain('Cena brutto');
    expect(html).not.toContain('12,30');
  });

  it('włączony: kolumna „Cena brutto” z ceną produktu, a przy produkcie bez ceny brutto „brak” (nie 0,00)', async () => {
    m.dostepne.mockResolvedValue(true);
    const html = await strona();
    expect(html).toContain('Cena brutto');
    expect(html).toMatch(/title="Kawa">Kawa<\/span>.*?>10,00<\/td><td[^>]*>12,30<\/td>/);
    // Herbata bez ceny brutto: komórka „brak”, nigdy „0,00”.
    expect(html).toMatch(/title="Herbata">Herbata<\/span>.*?>10,00<\/td><td[^>]*>brak<\/td>/);
    expect(html).not.toMatch(/>0,00</);
  });
});

describe('okno produktu a wyłącznik cen brutto', () => {
  it('włączony: pole „Cena brutto (zł)”, a zapis wysyła cenę brutto obok ceny netto', async () => {
    await otworz({ grossPrices: true });
    expect(document.body.textContent).toContain('Cena brutto (zł)');
    await wpisz(pole('product-name')!, 'Kawa');
    await wpisz(pole('product-price')!, '10,00');
    await wpisz(pole('product-price-gross')!, '12,30');
    await zapisz();
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Kawa', priceNet: '10,00', priceGross: '12,30' }));
  });

  it('włączony, edycja: pole ma zapisaną cenę brutto produktu', async () => {
    await otworz({ grossPrices: true, product: item() });
    expect(pole('product-price-gross')?.value).toBe('12,3');
  });

  it('wyłączony: bez pola ceny brutto, a zapis nie wysyła klucza ceny brutto (zapisana cena brutto zostaje)', async () => {
    await otworz({ grossPrices: false, product: item() });
    expect(document.body.textContent).not.toContain('Cena brutto');
    expect(pole('product-price-gross')).toBeNull();
    await zapisz();
    expect(m.update).toHaveBeenCalledTimes(1);
    expect(m.update.mock.calls[0][1]).not.toHaveProperty('priceGross');
  });
});
