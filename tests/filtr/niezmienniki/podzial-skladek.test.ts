import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { zbudujEwidencje, type FakturaEwidencji } from '@/lib/ksiegowosc/ewidencja';
import { sumyKpir, zaplatyFunduszuPracy, zbudujKpir, zmianyPodzialu, type ZaplaconeSkladki } from '@/lib/ksiegowosc/kpir';
import { parametryRoku } from '@/lib/ksiegowosc/parametry';
import { tenMiesiac, type Platnosc, type PozycjaMiesiaca } from '@/lib/ksiegowosc/ten-miesiac';

import { profil } from '../generatory/ksiegowosc';
import { opcje } from '../generatory/ustawienia';

/**
 * NZ-PIT-08 na poziomie „Ten miesiąc” (FZ-027, uwaga drugiego czytelnika):
 * dowolne zapłacone wersje składek społecznych jednego okresu (kwota i część
 * bez FP niezależnie). Wersja najwyższa (ostatnia numerem z największą kwotą)
 * ustala podział. Za grudzień, gdy wszystkie zapłaty są już w roku:
 * - ryczałt i próg zdrowotnej: brak z nazwą okresu dokładnie wtedy, gdy wersje
 *   się nie zgadzają (`zmianyPodzialu`), a inaczej odliczenie z łańcucha
 *   miesięcy to część bez FP wersji najwyższej;
 * - skala: zaliczka PIT tak samo, a kolumna 13 KPiR to FP wersji najwyższej.
 * Odliczenie sprawdza się w obu formach, bo ryczałt nie korzysta z KPiR, więc
 * brak w samej księdze go nie naprawia.
 */

const ROK = 2026;
const OKRES = `${ROK}-03`;
const DZIEN_MS = 86_400_000;
const odDnia = (dni: number) => new Date(Date.UTC(ROK, 3, 1) + dni * DZIEN_MS).toISOString().slice(0, 10);

const faktura = (m: number): FakturaEwidencji => {
  const dzien = `${ROK}-${String(m).padStart(2, '0')}-15`;
  return {
    id: `f-${m}`, numer: `FV/${m}/${ROK}`, dataWystawienia: dzien, dataSprzedazy: dzien, rodzaj: 'zwykla', nettoGr: 1_000_000,
    waluta: 'PLN', numerKsef: null, fp: false, kontrahent: { kraj: null, identyfikator: null }, rozliczoneZaliczkiGr: 0, pozycje: null,
  };
};
const FAKTURY = Array.from({ length: 12 }, (_, i) => faktura(i + 1));

const wersjeArb = fc
  .array(fc.record({ b: fc.integer({ min: 0, max: 4 }), f: fc.integer({ min: 0, max: 4 }), dni: fc.integer({ min: 0, max: 40 }) }), { minLength: 1, maxLength: 4 })
  .map((xs) => {
    let dzien = 0;
    return xs.map((x, i): ZaplaconeSkladki => {
      dzien += x.dni;
      return { id: `v${i + 1}`, okres: OKRES, wersja: i + 1, kwotaGr: (x.b + x.f) * 10_000, spoleczneBezFpGr: x.b * 10_000, zaplaconeO: odDnia(dzien) };
    });
  });

const platnosci = (wersje: readonly ZaplaconeSkladki[]): Platnosc[] =>
  wersje.map((v) => ({ miesiac: v.okres, rodzaj: 'zus_spoleczne', wersja: v.wersja, kwotaGr: v.kwotaGr, spoleczneBezFpGr: v.spoleczneBezFpGr, zaplaconeO: v.zaplaconeO }));

const najwyzsza = (wersje: readonly ZaplaconeSkladki[]) => {
  const maxK = Math.max(...wersje.map((v) => v.kwotaGr));
  return [...wersje].sort((a, b) => a.wersja - b.wersja).filter((v) => v.kwotaGr === maxK).at(-1)!;
};

function pozycja(pozycje: readonly PozycjaMiesiaca[], rodzaj: PozycjaMiesiaca['rodzaj']): PozycjaMiesiaca {
  const p = pozycje.find((x) => x.rodzaj === rodzaj);
  if (!p) throw new Error(`brak pozycji ${rodzaj}`);
  return p;
}

const sumaLancucha = (lancuch: unknown, pole: string) =>
  (lancuch as Array<Record<string, number>>).reduce((s, m) => s + (m[pole] ?? 0), 0);

describe('NZ-PIT-08 w „Ten miesiąc”: brak albo odliczenie z podziału wersji najwyższej (FZ-027)', () => {
  it('ryczałt: ryczałt i próg zdrowotnej za grudzień', () => {
    const wersjeProfilu = [profil({ forma: 'ryczalt', validFrom: `${ROK}-01-01` })];
    const ewidencja = zbudujEwidencje({ rok: ROK, faktury: FAKTURY, wpisy: [], wersje: wersjeProfilu, kursy: new Map() });
    fc.assert(
      fc.property(wersjeArb, (wersje) => {
        const konflikt = zmianyPodzialu(wersje).length > 0;
        const a = najwyzsza(wersje);
        const w = tenMiesiac({ miesiac: `${ROK}-12`, ewidencja, wersje: wersjeProfilu, platnosci: platnosci(wersje), parametry: parametryRoku });
        if (!w.ok) throw new Error(w.braki.join(' '));
        const ryczalt = pozycja(w.wynik.pozycje, 'ryczalt');
        const zdrowotna = pozycja(w.wynik.pozycje, 'zdrowotna');
        if (konflikt) {
          for (const p of [ryczalt, zdrowotna]) expect(p.ok ? null : p.brak, JSON.stringify(wersje)).toContain(`Składki ZUS za marzec ${ROK}`);
          return;
        }
        if (!ryczalt.ok || !zdrowotna.ok) throw new Error(`bez konfliktu brak pozycji: ${JSON.stringify(wersje)}`);
        expect(sumaLancucha(ryczalt.szczegoly?.lancuch, 'spoleczne')).toBe(a.spoleczneBezFpGr);
        expect(zdrowotna.szczegoly?.spoleczneNarastajacoGr).toBe(a.spoleczneBezFpGr);
      }),
      opcje(),
    );
  });

  it('skala: zaliczka PIT za grudzień i kolumna 13 KPiR', () => {
    const wersjeProfilu = [profil({ forma: 'skala', stawkaDomyslna: null, validFrom: `${ROK}-01-01` })];
    fc.assert(
      fc.property(wersjeArb, (wersje) => {
        const zmiany = zmianyPodzialu(wersje);
        const a = najwyzsza(wersje);
        const kpir = zbudujKpir({ rok: ROK, faktury: FAKTURY, koszty: [], wpisy: [], zaplatyFp: zaplatyFunduszuPracy(wersje), zmianyPodzialu: zmiany, wersje: wersjeProfilu, kursy: new Map() });
        const w = tenMiesiac({ miesiac: `${ROK}-12`, kpir: { rok: kpir, poprzedni: null }, wersje: wersjeProfilu, platnosci: platnosci(wersje), parametry: parametryRoku });
        if (!w.ok) throw new Error(w.braki.join(' '));
        const pit = pozycja(w.wynik.pozycje, 'pit');
        if (zmiany.length > 0) {
          expect(pit.ok, JSON.stringify(wersje)).toBe(false);
          expect(kpir.braki.some((b) => b.dokument === `Składki ZUS za 03/${ROK}`)).toBe(true);
          return;
        }
        if (!pit.ok) throw new Error(`bez konfliktu brak zaliczki: ${pit.brak}`);
        expect(sumaLancucha((pit.wejscia as { lancuch: unknown }).lancuch, 'spoleczneZaplaconeGr')).toBe(a.spoleczneBezFpGr);
        expect(sumyKpir(kpir.wiersze).kolumny.k13).toBe(a.kwotaGr - a.spoleczneBezFpGr);
      }),
      opcje(),
    );
  });
});
