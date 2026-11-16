import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { sumyOkresu, wierszeOkresu, zbudujEwidencje, type BrakEwidencji, type Ewidencja, type FakturaEwidencji, type WpisReczny } from '@/lib/ksiegowosc/ewidencja';
import { sumyKpir, wierszeKpirOkresu, zbudujKpir, type KolumnaKpir, type KosztKpir, type Kpir, type WpisKpir, type ZaplataFp } from '@/lib/ksiegowosc/kpir';

import { profil, stawkaRyczaltu } from '../generatory/ksiegowosc';
import { opcje } from '../generatory/ustawienia';

/**
 * Niezmienniki ksiąg (żelazny filtr F5, uzupełnienie po spisie luk z 16.11):
 * NZ-WSP-02 (kolejność dokumentów nie zmienia sum ani braków), NZ-EWP-01
 * (jeden wiersz ewidencji to jeden przychód z jedną stawką, suma według
 * stawek to przychód), NZ-KPIR-02 (każdy koszt w dokładnie jednej kolumnie,
 * koszt bez kolumny to brak), NZ-KPIR-03 (suma miesiąca to suma wierszy, od
 * początku roku suma miesięcy), NZ-KPIR-04 (te same faktury dają ten sam
 * przychód w KPiR i w ewidencji), NZ-PIT-08 (FP i FS z zapłaty składek to
 * koszt w kolumnie 13 w dniu zapłaty dokładnie raz; samych składek nie ma
 * w kosztach). Na prawdziwych `zbudujEwidencje` i `zbudujKpir`, rok 2026,
 * faktury w PLN.
 */

const ROK = 2026;
const DZIEN_MS = 86_400_000;
const dzien = fc.integer({ min: 0, max: 364 }).map((d) => new Date(Date.UTC(ROK, 0, 1) + d * DZIEN_MS).toISOString().slice(0, 10));
const kwota = (max = 5_000_000) => fc.integer({ min: 1, max });
const KOLUMNY_KOSZTU = ['col_10', 'col_11', 'col_12', 'col_13', 'col_15', 'col_16'] as const;
const KOSZTOWE: readonly KolumnaKpir[] = ['k10', 'k11', 'k12', 'k13'];

const faktura = (i: number, d: string, gr: number, sprzedaz: string | null = d): FakturaEwidencji => ({
  id: `f-${i}`, numer: `FV/${i}/2026`, dataWystawienia: d, dataSprzedazy: sprzedaz, rodzaj: 'zwykla', nettoGr: gr, waluta: 'PLN',
  numerKsef: null, fp: false, kontrahent: { kraj: null, identyfikator: null }, rozliczoneZaliczkiGr: 0, pozycje: null,
});
const wpisReczny = (i: number, d: string, gr: number, pb: number): WpisReczny => ({
  id: `w-${i}`, rodzaj: 'inny', dataPrzychodu: d, dataWpisu: d, dokument: `W/${i}`, kwotaGr: gr, stawkaPb: pb, opis: null,
});
const koszt = (i: number, d: string, gr: number, kolumna: string | null): KosztKpir => ({
  id: `k-${i}`, data: d, dowod: `K/${i}`, numerKsef: null, kontrahent: { nazwa: 'Dostawca', adres: null, kraj: null, identyfikator: null },
  opis: 'Usługa', kolumnaAplikacji: kolumna, kwotaGr: gr,
});
const wpisKpir = (i: number, d: string, gr: number, kolumna: KolumnaKpir): WpisKpir => ({ id: `wk-${i}`, data: d, dokument: `WK/${i}`, kolumna, kwotaGr: gr, opis: null });

// Data sprzedaży bywa inna niż data wystawienia (także w poprzednim miesiącu) albo jej nie ma: przychód obu ksiąg liczy się z tej samej daty.
const przesun = (d: string, dni: number) => new Date(Math.max(Date.parse(`${d}T00:00:00Z`) - dni * DZIEN_MS, Date.UTC(ROK, 0, 1))).toISOString().slice(0, 10);
const fakturyArb = fc
  .array(fc.record({ d: dzien, gr: kwota(), wstecz: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 40 })), bezDaty: fc.boolean() }), { maxLength: 12 })
  .map((xs) => xs.map((x, i) => faktura(i, x.d, x.gr, x.bezDaty ? null : przesun(x.d, x.wstecz))));
const wpisyArb = fc.array(fc.record({ d: dzien, gr: kwota(1_000_000), pb: stawkaRyczaltu }), { maxLength: 6 }).map((xs) => xs.map((x, i) => wpisReczny(i, x.d, x.gr, x.pb)));
const kosztyArb = fc
  .array(fc.record({ d: dzien, gr: kwota(1_000_000), kol: fc.oneof(fc.constantFrom(...KOLUMNY_KOSZTU), fc.constant(null), fc.constant('col_7')) }), { maxLength: 10 })
  .map((xs) => xs.map((x, i) => koszt(i, x.d, x.gr, x.kol)));
const wpisyKpirArb = fc
  .array(fc.record({ d: dzien, gr: kwota(1_000_000), kol: fc.constantFrom<KolumnaKpir>('k7', 'k8', 'k10', 'k11', 'k12', 'k13') }), { maxLength: 6 })
  .map((xs) => xs.map((x, i) => wpisKpir(i, x.d, x.gr, x.kol)));
const fpArb = fc
  .array(fc.record({ m: fc.integer({ min: 1, max: 11 }), dzienZaplaty: fc.integer({ min: 1, max: 20 }), gr: kwota(50_000) }), { maxLength: 5 })
  .map((xs) => xs.map((x, i): ZaplataFp => ({ id: `z-${i}`, zaMiesiac: `${ROK}-${String(x.m).padStart(2, '0')}`, data: `${ROK}-${String(x.m + 1).padStart(2, '0')}-${String(x.dzienZaplaty).padStart(2, '0')}`, fpGr: x.gr })));

const ryczalt = (pb: number) => [profil({ forma: 'ryczalt', stawkaDomyslna: pb, validFrom: `${ROK}-01-01` })];
const skala = [profil({ forma: 'skala', validFrom: `${ROK}-01-01` })];
const ewidencja = (faktury: readonly FakturaEwidencji[], wpisy: readonly WpisReczny[], pb: number): Ewidencja =>
  zbudujEwidencje({ rok: ROK, faktury, wpisy, wersje: ryczalt(pb), kursy: new Map() });
const kpir = (w: { faktury?: readonly FakturaEwidencji[]; koszty?: readonly KosztKpir[]; wpisy?: readonly WpisKpir[]; zaplatyFp?: readonly ZaplataFp[] }): Kpir =>
  zbudujKpir({ rok: ROK, faktury: w.faktury ?? [], koszty: w.koszty ?? [], wpisy: w.wpisy ?? [], zaplatyFp: w.zaplatyFp ?? [], wersje: skala, kursy: new Map() });

const ostatniDzien = (m: number) => new Date(Date.UTC(ROK, m, 0)).toISOString().slice(0, 10);
const miesiac = (m: number) => [`${ROK}-${String(m).padStart(2, '0')}-01`, ostatniDzien(m)] as const;
const braki = (b: readonly BrakEwidencji[]) => b.map((x) => `${x.dzien}|${x.dokument}|${x.komunikat}`).sort();
const sumyEw = (e: Ewidencja) => {
  const s = sumyOkresu(e.wiersze);
  return { razemGr: s.razemGr, liczbaWierszy: s.liczbaWierszy, stawki: [...s.stawki].sort((a, b) => a[0] - b[0]) };
};
const permutacja = <T,>(xs: readonly T[]) => fc.shuffledSubarray([...xs], { minLength: xs.length, maxLength: xs.length });

describe('niezmienniki ksiąg (F5): ewidencja i KPiR', () => {
  it('NZ-WSP-02: kolejność faktur i wpisów nie zmienia ewidencji (sumy, stawki, braki)', () => {
    fc.assert(
      fc.property(
        fc.tuple(fakturyArb, wpisyArb, stawkaRyczaltu).chain(([f, w, pb]) => fc.tuple(fc.constant(f), fc.constant(w), fc.constant(pb), permutacja(f), permutacja(w))),
        ([f, w, pb, f2, w2]) => {
          const a = ewidencja(f, w, pb);
          const b = ewidencja(f2, w2, pb);
          expect(sumyEw(b)).toEqual(sumyEw(a));
          expect(braki(b.braki)).toEqual(braki(a.braki));
        },
      ),
      opcje(),
    );
  });

  it('NZ-WSP-02: kolejność faktur, kosztów, wpisów i zapłat nie zmienia KPiR', () => {
    fc.assert(
      fc.property(
        fc.tuple(fakturyArb, kosztyArb, wpisyKpirArb, fpArb).chain(([f, k, w, z]) =>
          fc.tuple(fc.constant({ faktury: f, koszty: k, wpisy: w, zaplatyFp: z }), fc.record({ faktury: permutacja(f), koszty: permutacja(k), wpisy: permutacja(w), zaplatyFp: permutacja(z) })),
        ),
        ([a, b]) => {
          const ka = kpir(a);
          const kb = kpir(b);
          expect(sumyKpir(kb.wiersze)).toEqual(sumyKpir(ka.wiersze));
          expect(braki(kb.braki)).toEqual(braki(ka.braki));
        },
      ),
      opcje(),
    );
  });

  it('NZ-EWP-01: jeden wiersz to jeden przychód z jedną stawką; suma według stawek to przychód', () => {
    fc.assert(
      fc.property(fakturyArb, wpisyArb, stawkaRyczaltu, (f, w, pb) => {
        const e = ewidencja(f, w, pb);
        const s = sumyOkresu(e.wiersze);
        expect([...s.stawki.values()].reduce((x, y) => x + y, 0)).toBe(s.razemGr);
        expect(e.wiersze.reduce((x, r) => x + r.kwotaGr, 0)).toBe(s.razemGr);
        // Bez braków: każda faktura i każdy wpis to dokładnie jeden wiersz z kwotą dokumentu.
        if (e.braki.length === 0) {
          expect(s.liczbaWierszy).toBe(f.length + w.length);
          expect(s.razemGr).toBe(f.reduce((x, y) => x + y.nettoGr, 0) + w.reduce((x, y) => x + y.kwotaGr, 0));
        }
      }),
      opcje(),
    );
  });

  it('NZ-KPIR-02: każdy koszt z kolumną w dokładnie jednej kolumnie kosztów; bez kolumny albo z kolumną przychodu to brak', () => {
    fc.assert(
      fc.property(kosztyArb, (koszty) => {
        const k = kpir({ koszty });
        for (const c of koszty) {
          const wiersze = k.wiersze.filter((r) => r.zrodlo.typ === 'koszt' && r.zrodlo.id === c.id);
          const zBrakiem = k.braki.filter((b) => b.dokument === c.dowod);
          if (c.kolumnaAplikacji === null || c.kolumnaAplikacji === 'col_7') {
            expect([wiersze.length, zBrakiem.length]).toEqual([0, 1]);
            continue;
          }
          expect(wiersze).toHaveLength(1);
          const niezerowe = KOSZTOWE.filter((kol) => wiersze[0].kwoty[kol] !== 0);
          expect(niezerowe).toHaveLength(1);
          expect(wiersze[0].kwoty[niezerowe[0]]).toBe(c.kwotaGr);
          expect(wiersze[0].kwoty.k7 + wiersze[0].kwoty.k8).toBe(0);
        }
        const zKolumna = koszty.filter((c) => c.kolumnaAplikacji !== null && c.kolumnaAplikacji !== 'col_7');
        expect(sumyKpir(k.wiersze).kosztyGr).toBe(zKolumna.reduce((x, c) => x + c.kwotaGr, 0));
      }),
      opcje(),
    );
  });

  it('NZ-KPIR-03: suma miesiąca to suma jego wierszy, a od początku roku suma miesięcy', () => {
    fc.assert(
      fc.property(fakturyArb, kosztyArb, wpisyKpirArb, fpArb, (faktury, koszty, wpisy, zaplatyFp) => {
        const k = kpir({ faktury, koszty, wpisy, zaplatyFp });
        let narastajaco = sumyKpir([]);
        for (let m = 1; m <= 12; m++) {
          const [od, doDnia] = miesiac(m);
          const wiersze = wierszeKpirOkresu(k, od, doDnia);
          const s = sumyKpir(wiersze);
          expect(s.liczbaWierszy).toBe(wiersze.length);
          narastajaco = {
            przychodGr: narastajaco.przychodGr + s.przychodGr,
            kosztyGr: narastajaco.kosztyGr + s.kosztyGr,
            brGr: narastajaco.brGr + s.brGr,
            liczbaWierszy: narastajaco.liczbaWierszy + s.liczbaWierszy,
            kolumny: Object.fromEntries(Object.entries(narastajaco.kolumny).map(([kol, v]) => [kol, v + s.kolumny[kol as KolumnaKpir]])) as typeof s.kolumny,
          };
          expect(sumyKpir(wierszeKpirOkresu(k, `${ROK}-01-01`, doDnia))).toEqual(narastajaco);
        }
      }),
      opcje(),
    );
  });

  it('NZ-KPIR-04: te same faktury dają ten sam przychód w KPiR (kolumna 7) i w ewidencji, w każdym miesiącu', () => {
    fc.assert(
      fc.property(fakturyArb, stawkaRyczaltu, (faktury, pb) => {
        const e = ewidencja(faktury, [], pb);
        const k = kpir({ faktury });
        expect(braki(k.braki).length + braki(e.braki).length).toBe(0);
        for (let m = 1; m <= 12; m++) {
          const [od, doDnia] = miesiac(m);
          expect(sumyKpir(wierszeKpirOkresu(k, od, doDnia)).kolumny.k7).toBe(sumyOkresu(wierszeOkresu(e, od, doDnia)).razemGr);
        }
      }),
      opcje(),
    );
  });

  it('NZ-PIT-08: FP i FS z zapłaty składek to koszt w kolumnie 13 w dniu zapłaty, dokładnie raz; nic poza tym', () => {
    fc.assert(
      fc.property(fpArb, (zaplatyFp) => {
        const k = kpir({ zaplatyFp });
        for (const z of zaplatyFp) {
          const wiersze = k.wiersze.filter((r) => r.zrodlo.typ === 'zaplata' && r.zrodlo.id === z.id);
          expect(wiersze).toHaveLength(1);
          expect(wiersze[0].data).toBe(z.data);
          expect(wiersze[0].kwoty).toEqual({ k7: 0, k8: 0, k10: 0, k11: 0, k12: 0, k13: z.fpGr });
        }
        // Bez kosztów i faktur koszty KPiR to tylko FP i FS: składek społecznych i zdrowotnej w nich nie ma.
        expect(sumyKpir(k.wiersze).kosztyGr).toBe(zaplatyFp.reduce((x, z) => x + z.fpGr, 0));
        expect(k.wiersze.every((r) => r.zrodlo.typ === 'zaplata')).toBe(true);
      }),
      opcje(),
    );
  });
});
