import { describe, expect, it } from 'vitest';

import type { SupabaseClient } from '@supabase/supabase-js';

import { zaliczkiOkresowe } from '@/lib/ksiegowosc/ewidencja-dane';
import { fakePostgrest } from '../helpers/fake-postgrest';
import { sumyOkresu, zbudujEwidencje, type FakturaEwidencji } from '@/lib/ksiegowosc/ewidencja';
import { zbudujKpir } from '@/lib/ksiegowosc/kpir';
import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';

/**
 * D36 (RP-ZAL-01): zaliczka na dostawę wykonaną w następnym okresie nie jest
 * przychodem (art. 14 ust. 3 pkt 1 ustawy o PIT). Przychód w pełnej kwocie
 * powstaje w dniu wykonania, czyli w miesiącu faktury rozliczającej; zaliczka
 * i wykonanie w tym samym miesiącu: przychód w tym miesiącu.
 */

const RYCZALT: WersjaProfilu = {
  id: 'p1', validFrom: '2026-01-01', forma: 'ryczalt', stawkaDomyslna: 1200,
  zusEtap: 'pelny', zusOd: null, chorobowe: false, nrsZus: null, najem: false,
};
const SKALA: WersjaProfilu = { ...RYCZALT, forma: 'skala', stawkaDomyslna: null };

function faktura(z: Partial<FakturaEwidencji> = {}): FakturaEwidencji {
  return {
    id: 'f1', numer: 'FV/1/2026', dataWystawienia: '2026-03-10', dataSprzedazy: '2026-03-10',
    rodzaj: 'zwykla', nettoGr: 10_000_00, waluta: 'PLN', numerKsef: '1234567890-20260310-0A1B2C-3D4E5F-6A',
    fp: false, kontrahent: { kraj: 'PL', identyfikator: '1234567890' }, rozliczoneZaliczkiGr: 0, pozycje: null, ...z,
  };
}

const zal = (z: Partial<FakturaEwidencji> = {}) =>
  faktura({ id: 'z1', numer: 'ZAL/1', rodzaj: 'zaliczka', nettoGr: 3_000_00, dataWystawienia: '2026-03-10', dataSprzedazy: '2026-03-10', ...z });
const roz = (z: Partial<FakturaEwidencji> = {}) =>
  faktura({ id: 'r1', numer: 'ROZ/1', rodzaj: 'rozliczenie', nettoGr: 10_000_00, dataWystawienia: '2026-04-10', dataSprzedazy: '2026-04-10', ...z });

const ewid = (faktury: FakturaEwidencji[]) =>
  zbudujEwidencje({ rok: 2026, faktury, wpisy: [], wersje: [RYCZALT], kursy: new Map() });
const kpir = (faktury: FakturaEwidencji[]) =>
  zbudujKpir({ rok: 2026, faktury, koszty: [], wpisy: [], wersje: [SKALA], kursy: new Map() });

describe('D36: zaliczka w ewidencji ryczałtu', () => {
  it('wykonanie w następnym miesiącu: zaliczka nie jest przychodem, ROZ wchodzi w pełnej kwocie', () => {
    const e = ewid([zal({ zaliczkaRozliczonaDnia: '2026-04-10' }), roz()]);
    expect(e.wiersze.map((w) => [w.dowod, w.dataPrzychodu, w.kwotaGr])).toEqual([['ROZ/1', '2026-04-10', 10_000_00]]);
    expect(sumyOkresu(e.wiersze).razemGr).toBe(10_000_00);
  });

  it('zaliczka i wykonanie w tym samym miesiącu: przychód w tym miesiącu, bez dubla', () => {
    const e = ewid([
      zal({ dataWystawienia: '2026-04-02', dataSprzedazy: '2026-04-02', zaliczkaRozliczonaDnia: '2026-04-10' }),
      roz({ rozliczoneZaliczkiGr: 3_000_00 }),
    ]);
    expect(e.wiersze.map((w) => [w.dowod, w.kwotaGr])).toEqual([['ZAL/1', 3_000_00], ['ROZ/1', 7_000_00]]);
  });

  it('zaliczka bez faktury rozliczającej: dostawa jeszcze nie wykonana, nie jest przychodem', () => {
    expect(ewid([zal({ zaliczkaRozliczonaDnia: null })]).wiersze).toEqual([]);
  });

  it('zaliczka z grudnia, wykonanie w styczniu: przychód w następnym roku', () => {
    const z = zal({ dataWystawienia: '2026-12-20', dataSprzedazy: '2026-12-20', zaliczkaRozliczonaDnia: '2027-01-15' });
    expect(ewid([z]).wiersze).toEqual([]);
  });
});

describe('D36: zaliczka w KPiR', () => {
  it('wykonanie w następnym miesiącu: zaliczka bez kwoty w kolumnie 7, ROZ w pełnej kwocie', () => {
    const k = kpir([zal({ zaliczkaRozliczonaDnia: '2026-04-10' }), roz()]);
    expect(k.wiersze.map((w) => [w.dowod, w.kwoty.k7])).toEqual([['ROZ/1', 10_000_00]]);
    expect(k.pominiete.map((p) => p.numer)).toEqual(['ZAL/1']);
    expect(k.pominiete[0].powod).toContain('art. 14 ust. 3 pkt 1');
  });

  it('ten sam miesiąc: zaliczka i reszta jak dotąd', () => {
    const k = kpir([
      zal({ dataWystawienia: '2026-04-02', dataSprzedazy: '2026-04-02', zaliczkaRozliczonaDnia: '2026-04-10' }),
      roz({ rozliczoneZaliczkiGr: 3_000_00 }),
    ]);
    expect(k.wiersze.map((w) => [w.dowod, w.kwoty.k7])).toEqual([['ZAL/1', 3_000_00], ['ROZ/1', 7_000_00]]);
  });

  it('zaliczka bez rozliczenia nie jest przychodem', () => {
    expect(kpir([zal()]).wiersze).toEqual([]);
  });
});

describe('D36: odczyt zaliczek (zaliczkiOkresowe)', () => {
  const T = 'tenant-1';
  const wiersz = (id: string, kind: string, issue: string, extra: Record<string, unknown> = {}) => ({
    id, tenant_id: T, direction: 'outgoing', invoice_kind: kind, ksef_status: 'accepted',
    issue_date: issue, sale_date: issue, net_total: 0, advance_invoice_ids: null, ...extra,
  });
  const klient = (rows: Record<string, unknown>[]) =>
    fakePostgrest({ invoices: rows } as never) as unknown as SupabaseClient;

  it('ROZ w kwietniu: zaliczka z marca poza przychodem, z kwietnia w przychodzie; zaliczka zna dzień ROZ', async () => {
    const zMarzec = wiersz('z1', 'advance', '2026-03-10', { net_total: 3000 });
    const zKwiecien = wiersz('z2', 'advance', '2026-04-02', { net_total: 500 });
    const r = wiersz('r1', 'final', '2026-04-10', { net_total: 10000, advance_invoice_ids: ['z1', 'z2'] });
    const wynik = await zaliczkiOkresowe(klient([zMarzec, zKwiecien, r]), T, [zMarzec, zKwiecien, r] as never);
    expect(wynik.wPrzychodzie.get('r1')).toBe(500);
    expect(wynik.poza.get('r1')).toBe(3000);
    expect(wynik.rozliczonaDnia.get('z1')).toBe('2026-04-10');
    expect(wynik.rozliczonaDnia.get('z2')).toBe('2026-04-10');
  });

  it('zaliczka bez rozliczenia nie ma dnia wykonania; cudza zaliczka niczego nie odejmuje', async () => {
    const z = wiersz('z1', 'advance', '2026-03-10', { net_total: 3000 });
    const cudza = { ...wiersz('z9', 'advance', '2026-04-10', { net_total: 900 }), tenant_id: 'inny' };
    const r = wiersz('r1', 'final', '2026-04-10', { advance_invoice_ids: ['z9'] });
    const wynik = await zaliczkiOkresowe(klient([z, cudza, r]), T, [z, r] as never);
    expect(wynik.rozliczonaDnia.has('z1')).toBe(false);
    expect(wynik.wPrzychodzie.get('r1')).toBe(0);
  });
});
