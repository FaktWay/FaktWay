import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, memoryDb, type MemoryDb, type Row } from '../helpers/fake-supabase-memory';

/**
 * Ceny brutto (d): cena brutto produktu w katalogu (plan cen brutto; kolumna
 * `products.default_price_gross` z 00213). Cena brutto i cena netto produktu
 * są niezależne: katalog żadnej nie wylicza z drugiej (na fakturze w cenach
 * brutto cena jednostkowa brutto stoi zamiast netto, art. 106e ust. 8 ustawy
 * o VAT). Za wyłącznikiem `grossPricesEnabled` (#884, B4.0 zasada 2): przy
 * wyłączonym akcja nie zapisuje nowej ceny brutto; produkt bez ceny brutto
 * nie czyta flagi, a pole, które nie przyszło (ekran przy wyłączonym), zostawia
 * zapisaną cenę brutto bez zmian. Atrapy tylko dla sesji, bazy (w pamięci)
 * i odczytu flagi.
 */

const TENANT = 'ten-1';
const P1 = '11111111-1111-4111-8111-111111111111';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), audit: vi.fn(), revalidate: vi.fn(), flag: vi.fn() }));
vi.mock('@/lib/supabase/auth-context', () => ({
  requireOrgRole: mocks.auth,
  ActionAuthError: class ActionAuthError extends Error {},
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlagForExecution: mocks.flag }));

import { createProductAction, updateProductAction } from '@/app/actions/produkty';
import { listProducts, suggestProducts } from '@/lib/produkty/baza';
import { productFormSchema, type ProductFormInput } from '@/lib/produkty/model';
import { vatRateEnum } from '@/lib/schemas/invoice-form';

let db: MemoryDb;

const INPUT: ProductFormInput = { name: 'Kawa', unit: 'szt.', priceNet: '10,00', vatRate: '23', pkwiu: '', gtu: '', description: '' };
const BEZ_PODATKU = ['zw', 'oo', 'np', 'np_ii'];

function produkt(extra: Row = {}): Row {
  return {
    id: P1, tenant_id: TENANT, name: 'Kawa', unit: 'szt.', default_price_net: 10, default_price_gross: null, default_vat_rate: '23',
    pkwiu_code: null, gtu_code: null, description: null, is_archived: false, use_count: 0, last_used_at: null, ...extra,
  };
}

/** Atrapa odczytu katalogu: zapisuje kolumny z `select`, oddaje wiersze jak PostgREST. */
function katalog(rows: Row[]) {
  const selects: string[] = [];
  const q = {
    select: (cols: string) => (selects.push(cols), q),
    eq: () => q,
    ilike: () => q,
    order: () => q,
    range: async () => ({ data: rows, count: rows.length, error: null }),
    limit: async () => ({ data: rows, error: null }),
  };
  return { selects, client: { from: () => q } };
}

beforeEach(() => {
  vi.clearAllMocks();
  db = memoryDb({ products: [] });
  mocks.auth.mockResolvedValue({ supabase: fakeSupabase(db), tenantId: TENANT, user: { id: 'u1' }, role: 'member' });
  mocks.flag.mockResolvedValue(true);
});

describe('schemat produktu: cena brutto', () => {
  it('„1 537,50” to 1537,5; puste pole to brak ceny brutto (null); pole, które nie przyszło, to cena brutto bez zmian (undefined)', () => {
    expect(productFormSchema.parse({ ...INPUT, priceGross: '1 537,50' }).defaultPriceGross).toBe(1537.5);
    expect(productFormSchema.parse({ ...INPUT, priceGross: '' }).defaultPriceGross).toBeNull();
    expect(productFormSchema.parse({ ...INPUT, priceGross: null }).defaultPriceGross).toBeNull();
    expect(productFormSchema.parse(INPUT).defaultPriceGross).toBeUndefined();
  });

  it('cena brutto i cena netto są niezależne: żadnej nie wyliczamy z drugiej', () => {
    expect(productFormSchema.parse({ ...INPUT, priceNet: '', priceGross: '12,30' })).toMatchObject({ defaultPriceNet: null, defaultPriceGross: 12.3 });
    expect(productFormSchema.parse({ ...INPUT, priceNet: '10,00', priceGross: '99,99' })).toMatchObject({ defaultPriceNet: 10, defaultPriceGross: 99.99 });
    expect(productFormSchema.parse({ ...INPUT, priceGross: '' })).toMatchObject({ defaultPriceNet: 10, defaultPriceGross: null });
  });

  it('zła cena brutto: komunikat o cenie brutto przy polu ceny brutto, nie o cenie netto', () => {
    for (const zle of ['-1', '12,345', 'abc', '1000000000000,00']) {
      const r = productFormSchema.safeParse({ ...INPUT, priceGross: zle });
      expect(r.success, zle).toBe(false);
      if (!r.success) {
        expect(r.error.issues[0].message, zle).toMatch(/cenę brutto/);
        expect(r.error.issues[0].message, zle).not.toMatch(/cenę netto/);
        expect(r.error.issues[0].path, zle).toEqual(['priceGross']);
      }
    }
  });

  it('cena brutto przy stawce bez podatku (zw, oo, np, np II): odmowa z wyjściem przy polu ceny brutto; przy 23, 8, 5 i 0 % przechodzi', () => {
    for (const rate of vatRateEnum.options) {
      const r = productFormSchema.safeParse({ ...INPUT, vatRate: rate, priceGross: '12,30' });
      if (BEZ_PODATKU.includes(rate)) {
        expect(r.success, rate).toBe(false);
        if (!r.success) {
          expect(r.error.issues[0].message, rate).toMatch(/nie ma podatku/);
          expect(r.error.issues[0].message, rate).toMatch(/Zostaw cenę brutto pustą/);
          expect(r.error.issues[0].path, rate).toEqual(['priceGross']);
        }
      } else {
        expect(r.success, rate).toBe(true);
      }
      // Bez ceny brutto każda stawka przechodzi jak dotąd.
      expect(productFormSchema.safeParse({ ...INPUT, vatRate: rate, priceGross: '' }).success, rate).toBe(true);
      expect(productFormSchema.safeParse({ ...INPUT, vatRate: rate }).success, rate).toBe(true);
    }
  });
});

describe('odczyt katalogu: cena brutto', () => {
  it('lista: `default_price_gross` w zapytaniu, NUMERIC jako tekst to liczba, brak ceny brutto to null (nie 0)', async () => {
    const k = katalog([produkt({ default_price_gross: '1537.50' }), produkt({ id: 'p2', name: 'Kawa duża' })]);
    const items = await listProducts(k.client, TENANT, { q: '', archived: false });
    expect(k.selects[0]).toContain('default_price_gross');
    expect(items.map((i) => [i.defaultPriceNet, i.defaultPriceGross])).toEqual([[10, 1537.5], [10, null]]);
  });

  it('podpowiedź: produkt ze stawką bez podatku nie podaje ceny brutto, nawet gdy jest zapisana (osobne ustalenie 14)', async () => {
    // Stawka zmieniona na „zw” przy ukrytym polu ceny brutto (wyłącznik wyłączony) zostawia zapisaną cenę brutto;
    // faktura w cenach brutto takiej pozycji nie przyjmie (#880), więc podpowiedź jej nie wstawia.
    const k = katalog([
      produkt({ default_vat_rate: 'zw', default_price_gross: '12.30' }),
      produkt({ id: 'p2', name: 'Kawa duża', default_vat_rate: '23', default_price_gross: '12.30' }),
    ]);
    const items = await suggestProducts(k.client, TENANT, 'Kawa');
    expect(items.map((i) => [i.vatRate, i.priceGross])).toEqual([['zw', null], ['23', 12.3]]);
  });

  it('podpowiedź przy pozycji faktury: cena brutto obok ceny netto, brak to null', async () => {
    const k = katalog([produkt({ default_price_gross: '12.30' }), produkt({ id: 'p2', name: 'Kawa duża', default_price_net: null })]);
    const items = await suggestProducts(k.client, TENANT, 'Kawa');
    expect(k.selects[0]).toContain('default_price_gross');
    expect(items.map((i) => [i.priceNet, i.priceGross])).toEqual([[10, 12.3], [null, null]]);
  });
});

describe('akcje katalogu: cena brutto za wyłącznikiem', () => {
  it('włączony: nowy produkt z ceną brutto zapisuje `default_price_gross`, ceny netto nie zmienia', async () => {
    const r = await createProductAction({ ...INPUT, priceGross: '12,30' });
    expect(r.success).toBe(true);
    expect(db.tables.products[0]).toMatchObject({ default_price_net: 10, default_price_gross: 12.3 });
    expect(mocks.flag).toHaveBeenCalledWith('grossPricesEnabled');
  });

  it('wyłączony (brak wiersza flagi): produkt z ceną brutto dostaje odmowę z wyjściem, nic nie zapisane', async () => {
    mocks.flag.mockResolvedValue(false);
    const r = await createProductAction({ ...INPUT, priceGross: '12,30' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error).toMatch(/Ceny brutto nie są jeszcze dostępne/);
      expect(r.error).toMatch(/Usuń cenę brutto/);
    }
    expect(db.tables.products).toHaveLength(0);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('błąd odczytu flagi: odmowa „spróbuj ponownie”, nic nie zapisane („nie wiem” to nie „tak”)', async () => {
    mocks.flag.mockRejectedValue(new Error('Nie udało się sprawdzić wyłącznika funkcji'));
    const r = await createProductAction({ ...INPUT, priceGross: '12,30' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/Spróbuj ponownie/);
    expect(db.tables.products).toHaveLength(0);
  });

  it('produkt bez ceny brutto (bez pola albo z pustym polem) nie czyta flagi i zapisuje się jak dotąd, także przy wyłączonym', async () => {
    mocks.flag.mockResolvedValue(false);
    expect((await createProductAction(INPUT)).success).toBe(true);
    expect((await createProductAction({ ...INPUT, name: 'Herbata', priceGross: '' })).success).toBe(true);
    expect(mocks.flag).not.toHaveBeenCalled();
    expect(db.tables.products.map((p) => p.default_price_gross ?? null)).toEqual([null, null]);
  });

  it('edycja bez pola ceny brutto (ekran przy wyłączonym) zostawia zapisaną cenę brutto i nie czyta flagi', async () => {
    mocks.flag.mockResolvedValue(false);
    db.tables.products = [produkt({ default_price_gross: 12.3 })];
    const r = await updateProductAction(P1, { ...INPUT, priceNet: '11,00' });
    expect(r.success).toBe(true);
    expect(db.tables.products[0]).toMatchObject({ default_price_net: 11, default_price_gross: 12.3 });
    expect(mocks.flag).not.toHaveBeenCalled();
  });

  it('edycja przy włączonym: zmiana i wyczyszczenie ceny brutto trafiają do bazy i do audytu', async () => {
    db.tables.products = [produkt({ default_price_gross: 12.3 })];
    expect((await updateProductAction(P1, { ...INPUT, priceGross: '13,00' })).success).toBe(true);
    expect(db.tables.products[0].default_price_gross).toBe(13);
    expect(mocks.audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'product.updated', metadata: { fields: ['default_price_gross'] } }));
    expect((await updateProductAction(P1, { ...INPUT, priceGross: '' })).success).toBe(true);
    expect(db.tables.products[0].default_price_gross).toBeNull();
  });

  it('edycja przy wyłączonym z nową ceną brutto (okno otwarte przed wyłączeniem): odmowa, produkt bez zmian', async () => {
    mocks.flag.mockResolvedValue(false);
    db.tables.products = [produkt({ default_price_gross: 12.3 })];
    const r = await updateProductAction(P1, { ...INPUT, name: 'Kawa ziarnista', priceGross: '13,00' });
    expect(r.success).toBe(false);
    expect(db.tables.products[0]).toMatchObject({ name: 'Kawa', default_price_gross: 12.3 });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('edycja przy wyłączonym z tą samą ceną brutto (zmiana tylko nazwy) przechodzi bez odczytu flagi', async () => {
    mocks.flag.mockResolvedValue(false);
    db.tables.products = [produkt({ default_price_gross: 12.3 })];
    const r = await updateProductAction(P1, { ...INPUT, name: 'Kawa ziarnista', priceGross: '12,30' });
    expect(r.success).toBe(true);
    expect(db.tables.products[0]).toMatchObject({ name: 'Kawa ziarnista', default_price_gross: 12.3 });
    expect(mocks.flag).not.toHaveBeenCalled();
  });
});
