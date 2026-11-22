import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  dzienPrzychodu,
  kluczKursu,
  przeliczNaPln,
  sumyOkresu,
  wierszeOkresu,
  zbudujEwidencje,
  type Ewidencja,
  type FakturaEwidencji,
  type KursPrzychodu,
  type ProgNajmu,
  type RodzajFaktury,
  type WpisReczny,
} from '@/lib/ksiegowosc/ewidencja';
import {
  brakiKpirOkresu,
  sumyKpir,
  wierszeKpirOkresu,
  zaplatyFunduszuPracy,
  zbudujKpir,
  type KolumnaKpir,
  type KosztKpir,
  type Kpir,
  type WpisKpir,
  type ZaplaconeSkladki,
  type ZaplataFp,
} from '@/lib/ksiegowosc/kpir';
import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';
import { przyrostyZaplat } from '@/lib/ksiegowosc/ten-miesiac';

import { profil, stawkaRyczaltu } from '../generatory/ksiegowosc';
import { opcje } from '../generatory/ustawienia';

/**
 * Niezmienniki ksiąg, uzupełnienie `ksiegi.test.ts` po drugim czytelniku #805
 * (żelazny filtr F5). Tamten plik zostaje bez zmian, a tu jest to, czego nie
 * sprawdza:
 * - NZ-EWP-01: wiersz ma stawkę dokumentu (profilu, wpisu albo pozycji),
 *   a faktura z kilkoma stawkami to po jednym wierszu na stawkę z sumą jej
 *   pozycji;
 * - NZ-KPIR-02: kolumna kosztu z kategorii (col_10 do col_13 to K_10 do K_13,
 *   koszt B+R z col_15 albo col_16 to K_13 z zapisem w K_16);
 * - NZ-PIT-08: FP i FS z zapłaconych wersji składek (`zaplatyFunduszuPracy`),
 *   także z dopłatami, nigdy z części odliczanej od dochodu; FZ-027 (`.fails`):
 *   wersja, która przesuwa kwotę z FP do części bez FP, daje koszt i
 *   odliczenie z tych samych pieniędzy;
 * - NZ-KPIR-03: dokument z dniem spoza roku nie wchodzi do księgi ani do
 *   braków, a dwanaście miesięcy to cała księga;
 * - NZ-KPIR-04: ten sam przychód i ten sam dzień w KPiR i w ewidencji także
 *   dla korekty, zaliczki, rozliczenia z zaliczkami i faktury w walucie
 *   (wspólny kurs). Faktura w walucie z kilkoma stawkami różni się o grosze
 *   zaokrągleń: ewidencja przelicza osobno każdą stawkę, KPiR całość. Dzień
 *   należy do jednej księgi, więc klient tej różnicy nie widzi;
 * - NZ-WSP-02 przy progu najmu: kolejność nie zmienia ewidencji, a ponad
 *   próg idzie dokładnie nadwyżka przychodu z najmu od początku roku.
 * Na prawdziwych `zbudujEwidencje` i `zbudujKpir`, rok 2026.
 */

const ROK = 2026;
const DZIEN_MS = 86_400_000;
const odDnia = (start: number, dni: number) => new Date(start + dni * DZIEN_MS).toISOString().slice(0, 10);
const dzienRoku = fc.integer({ min: 0, max: 364 }).map((d) => odDnia(Date.UTC(ROK, 0, 1), d));
/** Od 1 listopada roku poprzedniego do 28 lutego następnego: także poza rokiem księgi. */
const dzienSzeroko = fc.integer({ min: 0, max: 484 }).map((d) => odDnia(Date.UTC(ROK - 1, 10, 1), d));
const wstecz = (d: string, dni: number) => odDnia(Date.parse(`${d}T00:00:00Z`), -dni);
const wRoku = (d: string) => d.startsWith(`${ROK}-`);
const ZERO: Readonly<Record<KolumnaKpir, number>> = { k7: 0, k8: 0, k10: 0, k11: 0, k12: 0, k13: 0 };

const ryczalt = (pb: number, z: Partial<WersjaProfilu> = {}) => [profil({ forma: 'ryczalt', stawkaDomyslna: pb, validFrom: `${ROK}-01-01`, ...z })];
const skala = [profil({ forma: 'skala', validFrom: `${ROK}-01-01` })];

const faktura = (i: number, z: Partial<FakturaEwidencji> & Pick<FakturaEwidencji, 'dataWystawienia' | 'nettoGr'>): FakturaEwidencji => ({
  id: `f-${i}`,
  numer: `FV/${i}/${ROK}`,
  dataSprzedazy: z.dataWystawienia,
  rodzaj: 'zwykla',
  waluta: 'PLN',
  numerKsef: null,
  fp: false,
  kontrahent: { kraj: null, identyfikator: null },
  rozliczoneZaliczkiGr: 0,
  pozycje: null,
  ...z,
});
const wpisReczny = (i: number, d: string, gr: number, pb: number): WpisReczny => ({
  id: `w-${i}`, rodzaj: 'inny', dataPrzychodu: d, dataWpisu: d, dokument: `W/${i}`, kwotaGr: gr, stawkaPb: pb, opis: null,
});
const koszt = (i: number, d: string, gr: number, kolumna: string | null): KosztKpir => ({
  id: `k-${i}`, data: d, dowod: `K/${i}`, numerKsef: null, kontrahent: { nazwa: 'Dostawca', adres: null, kraj: null, identyfikator: null },
  opis: 'Usługa', kolumnaAplikacji: kolumna, kwotaGr: gr,
});
const wpisKpir = (i: number, d: string, gr: number, kolumna: KolumnaKpir): WpisKpir => ({ id: `wk-${i}`, data: d, dokument: `WK/${i}`, kolumna, kwotaGr: gr, opis: null });

const kpir = (w: { faktury?: readonly FakturaEwidencji[]; koszty?: readonly KosztKpir[]; wpisy?: readonly WpisKpir[]; zaplatyFp?: readonly ZaplataFp[]; kursy?: ReadonlyMap<string, KursPrzychodu> }): Kpir =>
  zbudujKpir({ rok: ROK, faktury: w.faktury ?? [], koszty: w.koszty ?? [], wpisy: w.wpisy ?? [], zaplatyFp: w.zaplatyFp ?? [], wersje: skala, kursy: w.kursy ?? new Map() });
const ewidencja = (w: { faktury?: readonly FakturaEwidencji[]; wpisy?: readonly WpisReczny[]; wersje: readonly WersjaProfilu[]; kursy?: ReadonlyMap<string, KursPrzychodu>; najem?: ProgNajmu }): Ewidencja =>
  zbudujEwidencje({ rok: ROK, faktury: w.faktury ?? [], wpisy: w.wpisy ?? [], wersje: w.wersje, kursy: w.kursy ?? new Map(), najem: w.najem });

const wierszeFaktury = <T extends { zrodlo: { id: string } }>(wiersze: readonly T[], f: { id: string }) => wiersze.filter((w) => w.zrodlo.id === f.id);
const brakiDokumentu = (braki: readonly { dokument: string }[], dokument: string) => braki.filter((b) => b.dokument === dokument);
const miesiac = (m: number) => [`${ROK}-${String(m).padStart(2, '0')}-01`, new Date(Date.UTC(ROK, m, 0)).toISOString().slice(0, 10)] as const;
const permutacja = <T,>(xs: readonly T[]) => fc.shuffledSubarray([...xs], { minLength: xs.length, maxLength: xs.length });

describe('niezmienniki ksiąg (F5), uzupełnienie: stawki, kolumny, FP, rok, rodzaje faktur, próg najmu', () => {
  // NZ-EWP-01: pozycje ze stawką w procentach (jak `invoice_items`) albo bez niej (stawka profilu).
  const pozycjeArb = fc.oneof(
    fc.constant(null),
    fc.array(fc.record({ nettoGr: fc.integer({ min: 1, max: 500_000 }), pb: fc.oneof(fc.constant(null), stawkaRyczaltu) }), { minLength: 1, maxLength: 4 }),
  );
  const fakturyStawekArb = fc
    .array(fc.record({ d: dzienRoku, gr: fc.integer({ min: 1, max: 2_000_000 }), pozycje: pozycjeArb, rozjazd: fc.integer({ min: 0, max: 9 }) }), { maxLength: 10 })
    .map((xs) =>
      xs.map((x, i) => {
        if (x.pozycje === null) return faktura(i, { dataWystawienia: x.d, nettoGr: x.gr });
        const suma = x.pozycje.reduce((s, p) => s + p.nettoGr, 0);
        // Co dziesiąta faktura ma nagłówek inny niż suma pozycji: przy kilku stawkach to brak.
        return faktura(i, {
          dataWystawienia: x.d,
          nettoGr: x.rozjazd === 0 ? suma + 1 : suma,
          pozycje: x.pozycje.map((p) => ({ nettoGr: p.nettoGr, stawkaRyczaltu: p.pb === null ? null : p.pb / 100 })),
        });
      }),
    );

  it('NZ-EWP-01: wiersz ma stawkę dokumentu, a faktura z kilkoma stawkami to wiersz na stawkę z sumą jej pozycji', () => {
    fc.assert(
      fc.property(
        fakturyStawekArb,
        fc.array(fc.record({ d: dzienRoku, gr: fc.integer({ min: 1, max: 1_000_000 }), pb: stawkaRyczaltu }), { maxLength: 6 }),
        stawkaRyczaltu,
        (faktury, wpisyX, pbProfilu) => {
          const wpisy = wpisyX.map((x, i) => wpisReczny(i, x.d, x.gr, x.pb));
          const e = ewidencja({ faktury, wpisy, wersje: ryczalt(pbProfilu) });
          for (const f of faktury) {
            const grupy = new Map<number, number>();
            for (const p of f.pozycje ?? [{ nettoGr: f.nettoGr, stawkaRyczaltu: null }]) {
              const pb = p.stawkaRyczaltu === null ? pbProfilu : Math.round(Number(p.stawkaRyczaltu) * 100);
              grupy.set(pb, (grupy.get(pb) ?? 0) + p.nettoGr);
            }
            const wiersze = wierszeFaktury(e.wiersze, f);
            const sumaPozycji = [...grupy.values()].reduce((s, x) => s + x, 0);
            if (grupy.size > 1 && sumaPozycji !== f.nettoGr) {
              expect(wiersze).toEqual([]);
              expect(brakiDokumentu(e.braki, f.numer)).toHaveLength(1);
              continue;
            }
            expect(brakiDokumentu(e.braki, f.numer)).toEqual([]);
            // Jedna stawka: kwota z nagłówka; kilka: suma pozycji tej stawki, po jednym wierszu.
            const oczekiwane = grupy.size === 1 ? new Map([[[...grupy.keys()][0], f.nettoGr]]) : grupy;
            expect(new Map(wiersze.map((w) => [w.stawkaPb, w.kwotaGr]))).toEqual(oczekiwane);
            expect(wiersze).toHaveLength(oczekiwane.size);
          }
          for (const w of wpisy) {
            expect(wierszeFaktury(e.wiersze, w).map((r) => [r.stawkaPb, r.kwotaGr])).toEqual([[w.stawkaPb, w.kwotaGr]]);
          }
        },
      ),
      opcje(),
    );
  });

  // NZ-KPIR-02: numer kolumny w aplikacji to numer kolumny księgi; B+R to K_13 i zapis w K_16 (rozporządzenie MFiG z 6.09.2025).
  const KOLUMNA: Readonly<Record<string, { kolumna: KolumnaKpir; br: boolean }>> = {
    col_10: { kolumna: 'k10', br: false },
    col_11: { kolumna: 'k11', br: false },
    col_12: { kolumna: 'k12', br: false },
    col_13: { kolumna: 'k13', br: false },
    col_15: { kolumna: 'k13', br: true },
    col_16: { kolumna: 'k13', br: true },
  };

  it('NZ-KPIR-02: koszt trafia do kolumny ze swojej kategorii, a B+R także do K_16; koszt zerowy nie jest wierszem', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ d: dzienRoku, gr: fc.integer({ min: -100_000, max: 1_000_000 }), kol: fc.constantFrom(...Object.keys(KOLUMNA)) }), { maxLength: 12 }),
        (xs) => {
          const koszty = xs.map((x, i) => koszt(i, x.d, x.gr, x.kol));
          const k = kpir({ koszty });
          expect(k.braki).toEqual([]);
          const kolumny: Record<KolumnaKpir, number> = { ...ZERO };
          let br = 0;
          for (const c of koszty) {
            const wiersze = wierszeFaktury(k.wiersze, c);
            if (c.kwotaGr === 0) {
              expect(wiersze).toEqual([]);
              continue;
            }
            const cel = KOLUMNA[c.kolumnaAplikacji ?? ''];
            expect(wiersze).toHaveLength(1);
            expect(wiersze[0].kwoty).toEqual({ ...ZERO, [cel.kolumna]: c.kwotaGr });
            expect(wiersze[0].br?.kwotaGr ?? null).toBe(cel.br ? c.kwotaGr : null);
            kolumny[cel.kolumna] += c.kwotaGr;
            if (cel.br) br += c.kwotaGr;
          }
          const s = sumyKpir(k.wiersze);
          expect(s.kolumny).toEqual(kolumny);
          expect(s.brGr).toBe(br);
        },
      ),
      opcje(),
    );
  });

  // NZ-PIT-08: zapłacone wersje składek społecznych okresu; dopłata nie zmniejsza ani FP, ani części bez FP.
  const okresArb = fc.integer({ min: 0, max: 13 }).map((m) => new Date(Date.UTC(ROK - 1, 10 + m, 1)).toISOString().slice(0, 7));
  const pierwszyDzienPo = (okres: string) => {
    const [r, m] = okres.split('-').map(Number);
    return Date.UTC(r, m, 1);
  };
  const skladkiArb = fc
    .uniqueArray(
      fc.record({
        okres: okresArb,
        dzien: fc.integer({ min: 0, max: 19 }),
        wersje: fc.array(fc.record({ bezFp: fc.integer({ min: 0, max: 200_000 }), fp: fc.integer({ min: 0, max: 20_000 }), dni: fc.integer({ min: 0, max: 40 }) }), { minLength: 1, maxLength: 3 }),
      }),
      { selector: (x) => x.okres, maxLength: 5 },
    )
    .map((okresy) =>
      okresy.flatMap((o): ZaplaconeSkladki[] => {
        let bezFp = 0;
        let fp = 0;
        let dni = o.dzien;
        return o.wersje.map((v, i) => {
          bezFp += v.bezFp;
          fp += v.fp;
          dni += v.dni;
          return { id: `${o.okres}-v${i + 1}`, okres: o.okres, wersja: i + 1, kwotaGr: bezFp + fp, spoleczneBezFpGr: bezFp, zaplaconeO: odDnia(pierwszyDzienPo(o.okres), dni) };
        });
      }),
    );
  const odliczenia = (zaplaty: readonly ZaplaconeSkladki[]) =>
    przyrostyZaplat(zaplaty.map((z) => ({ miesiac: z.okres, rodzaj: 'zus_spoleczne' as const, wersja: z.wersja, kwotaGr: z.kwotaGr, spoleczneBezFpGr: z.spoleczneBezFpGr, zaplaconeO: z.zaplaconeO })));

  it('NZ-PIT-08: FP z zapłat to tylko część FP, przy dopłacie tylko przyrost; FP i odliczenie razem to zapłacona kwota', () => {
    fc.assert(
      fc.property(
        skladkiArb.chain((z) => fc.tuple(fc.constant(z), permutacja(z))),
        ([zaplaty, inaczej]) => {
          const fp = zaplatyFunduszuPracy(zaplaty);
          expect(zaplatyFunduszuPracy(inaczej)).toEqual(fp);
          const wgId = new Map(zaplaty.map((z) => [z.id, z]));
          for (const w of fp) {
            const z = wgId.get(w.id);
            expect(z).toBeDefined();
            expect([w.zaMiesiac, w.data]).toEqual([z?.okres, z?.zaplaconeO]);
            expect(w.fpGr).toBeGreaterThan(0);
          }
          const odl = odliczenia(zaplaty);
          for (const okres of new Set(zaplaty.map((z) => z.okres))) {
            const wersje = zaplaty.filter((z) => z.okres === okres);
            const ostatnia = wersje[wersje.length - 1];
            const fpOkresu = fp.filter((w) => w.zaMiesiac === okres).reduce((s, w) => s + w.fpGr, 0);
            // Razem tyle FP, ile ma ostatnia wersja; część bez FP (odliczana od dochodu) nigdy nie jest kosztem.
            expect(fpOkresu).toBe(ostatnia.kwotaGr - ostatnia.spoleczneBezFpGr);
            const odlOkresu = odl.filter((_, i) => zaplaty[i].okres === okres).reduce((s, o) => s + o.spoleczneBezFpGr, 0);
            expect(fpOkresu + odlOkresu).toBe(ostatnia.kwotaGr);
          }
          // W KPiR: wiersz kolumny 13 w dniu zapłaty z roku księgi, nic poza tym (kolejność wierszy księgi jest inna, więc po id).
          const k = kpir({ zaplatyFp: fp });
          const poId = <T extends readonly unknown[]>(xs: T[]) => xs.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
          expect(poId(k.wiersze.map((w) => [w.zrodlo.id, w.data, w.kwoty] as const))).toEqual(
            poId(fp.filter((w) => wRoku(w.data)).map((w) => [w.id, w.data, { ...ZERO, k13: w.fpGr }] as const)),
          );
        },
      ),
      opcje(),
    );
  });

  it.fails('NZ-PIT-08: nowa wersja z mniejszym FP nie zostawia w kosztach FP, które odliczenie liczy już jako składki (FZ-027)', () => {
    // Zapłata spoza wyliczenia za grudzień 2025 z częścią bez FP równą zero (pomyłka), potem wersja z kwotą z DRA.
    const zaplaty: ZaplaconeSkladki[] = [
      { id: 'v1', okres: '2025-12', wersja: 1, kwotaGr: 100_000, spoleczneBezFpGr: 0, zaplaconeO: '2026-01-10' },
      { id: 'v2', okres: '2025-12', wersja: 2, kwotaGr: 100_000, spoleczneBezFpGr: 90_000, zaplaconeO: '2026-01-20' },
    ];
    const fp = zaplatyFunduszuPracy(zaplaty).reduce((s, w) => s + w.fpGr, 0);
    const odl = odliczenia(zaplaty).reduce((s, o) => s + o.spoleczneBezFpGr, 0);
    // Dziś koszt FP 1000 zł i odliczenie 900 zł z 1000 zł zapłaty.
    expect(fp + odl).toBe(100_000);
  });

  // NZ-KPIR-03: dni od listopada roku poprzedniego do lutego następnego.
  const ksiegaSzerokoArb = fc.record({
    faktury: fc
      .array(fc.record({ d: dzienSzeroko, gr: fc.integer({ min: 1, max: 2_000_000 }), wstecz: fc.integer({ min: 0, max: 40 }), bezDaty: fc.boolean() }), { maxLength: 10 })
      .map((xs) => xs.map((x, i) => faktura(i, { dataWystawienia: x.d, nettoGr: x.gr, dataSprzedazy: x.bezDaty ? null : wstecz(x.d, x.wstecz) }))),
    koszty: fc
      .array(fc.record({ d: dzienSzeroko, gr: fc.integer({ min: 1, max: 1_000_000 }), kol: fc.constantFrom('col_10', 'col_13', 'col_15', null) }), { maxLength: 8 })
      .map((xs) => xs.map((x, i) => koszt(i, x.d, x.gr, x.kol))),
    wpisy: fc
      .array(fc.record({ d: dzienSzeroko, gr: fc.integer({ min: 1, max: 1_000_000 }), kol: fc.constantFrom<KolumnaKpir>('k7', 'k8', 'k13') }), { maxLength: 5 })
      .map((xs) => xs.map((x, i) => wpisKpir(i, x.d, x.gr, x.kol))),
    zaplatyFp: fc
      .array(fc.record({ d: dzienSzeroko, gr: fc.integer({ min: 1, max: 50_000 }) }), { maxLength: 4 })
      .map((xs) => xs.map((x, i): ZaplataFp => ({ id: `z-${i}`, zaMiesiac: x.d.slice(0, 7), data: x.d, fpGr: x.gr }))),
  });

  it('NZ-KPIR-03: dokument z dniem spoza roku nie jest wierszem ani brakiem, a dwanaście miesięcy to cała księga', () => {
    fc.assert(
      fc.property(ksiegaSzerokoArb, (w) => {
        const k = kpir(w);
        expect(k.wiersze.every((r) => wRoku(r.data))).toBe(true);
        expect(k.braki.every((b) => wRoku(b.dzien))).toBe(true);
        for (const f of w.faktury) expect(wierszeFaktury(k.wiersze, f).map((r) => r.data)).toEqual(wRoku(dzienPrzychodu(f)) ? [dzienPrzychodu(f)] : []);
        for (const c of w.koszty) {
          const wRokuKosztu = wRoku(c.data) ? 1 : 0;
          expect([wierszeFaktury(k.wiersze, c).length, brakiDokumentu(k.braki, c.dowod).length]).toEqual(c.kolumnaAplikacji === null ? [0, wRokuKosztu] : [wRokuKosztu, 0]);
        }
        for (const x of [...w.wpisy, ...w.zaplatyFp]) expect(wierszeFaktury(k.wiersze, x)).toHaveLength(wRoku(x.data) ? 1 : 0);

        const miesiace = Array.from({ length: 12 }, (_, i) => miesiac(i + 1));
        const wiersze = miesiace.flatMap(([od, doDnia]) => wierszeKpirOkresu(k, od, doDnia));
        expect(sumyKpir(wiersze)).toEqual(sumyKpir(k.wiersze));
        expect(wiersze.map((r) => r.zrodlo.id).sort()).toEqual(k.wiersze.map((r) => r.zrodlo.id).sort());
        expect(miesiace.flatMap(([od, doDnia]) => brakiKpirOkresu(k, od, doDnia))).toEqual(k.braki);
      }),
      opcje(),
    );
  });

  // NZ-KPIR-04: rodzaje faktur i waluta; kurs NBP po dniu przychodu, wspólny dla obu ksiąg.
  const RODZAJE: readonly RodzajFaktury[] = ['zwykla', 'korekta', 'zaliczka', 'rozliczenie'];
  const fakturyRodzajowArb = fc
    .array(
      fc.record({
        rodzaj: fc.constantFrom(...RODZAJE),
        d: dzienRoku,
        wstecz: fc.integer({ min: 0, max: 40 }),
        gr: fc.integer({ min: 1, max: 2_000_000 }),
        minus: fc.boolean(),
        zaliczki: fc.integer({ min: 0, max: 100 }),
        eur: fc.boolean(),
        mid: fc.integer({ min: 38_000, max: 46_000 }),
        bezKursu: fc.integer({ min: 0, max: 9 }),
        stawki: fc.oneof(fc.constant(null), fc.uniqueArray(fc.tuple(stawkaRyczaltu, fc.integer({ min: 1, max: 500_000 })), { selector: ([pb]) => pb, minLength: 2, maxLength: 3 })),
      }),
      { maxLength: 12 },
    )
    .map((xs) => {
      const kursy = new Map<string, KursPrzychodu>();
      const faktury = xs.map((x, i) => {
        const nettoGr = x.stawki !== null ? x.stawki.reduce((s, [, gr]) => s + gr, 0) : x.rodzaj === 'korekta' && x.minus ? -x.gr : x.gr;
        const f = faktura(i, {
          rodzaj: x.rodzaj,
          dataWystawienia: x.d,
          dataSprzedazy: wstecz(x.d, x.wstecz),
          nettoGr,
          // Rozliczenie: zaliczki od zera do całego netto (wtedy przychodu nie ma).
          rozliczoneZaliczkiGr: x.rodzaj === 'rozliczenie' ? Math.round((nettoGr * x.zaliczki) / 100) : 0,
          waluta: x.eur ? 'EUR' : 'PLN',
          pozycje: x.stawki?.map(([pb, gr]) => ({ nettoGr: gr, stawkaRyczaltu: pb / 100 })) ?? null,
        });
        const klucz = kluczKursu('EUR', dzienPrzychodu(f));
        if (x.eur && !kursy.has(klucz)) kursy.set(klucz, x.bezKursu === 0 ? { znaleziony: false } : { znaleziony: true, mid: x.mid / 10_000, tabela: `${i}/A/NBP/${ROK}`, dataTabeli: dzienPrzychodu(f) });
        return f;
      });
      return { faktury, kursy };
    });

  it('NZ-KPIR-04: korekta, zaliczka, rozliczenie i waluta mają w KPiR i w ewidencji ten sam dzień i przychód', () => {
    fc.assert(
      fc.property(fakturyRodzajowArb, stawkaRyczaltu, ({ faktury, kursy }, pb) => {
        const k = kpir({ faktury, kursy });
        const e = ewidencja({ faktury, kursy, wersje: ryczalt(pb) });
        const roznicaWMiesiacu = new Map<string, number>();
        for (const f of faktury) {
          const dzien = dzienPrzychodu(f);
          const kwota = f.rodzaj === 'rozliczenie' ? f.nettoGr - f.rozliczoneZaliczkiGr : f.nettoGr;
          const wk = wierszeFaktury(k.wiersze, f);
          const we = wierszeFaktury(e.wiersze, f);
          const bk = brakiDokumentu(k.braki, f.numer);
          const be = brakiDokumentu(e.braki, f.numer);
          // Dzień sprzedaży z grudnia poprzedniego roku: przychód tamtego roku, w żadnej z ksiąg tego.
          if (kwota === 0 || !wRoku(dzien)) {
            expect([wk.length, we.length, bk.length, be.length]).toEqual([0, 0, 0, 0]);
            continue;
          }
          const kurs = f.waluta === 'PLN' ? null : kursy.get(kluczKursu(f.waluta, dzien));
          if (kurs !== null && !kurs?.znaleziony) {
            expect([wk.length, we.length, bk.length, be.length]).toEqual([0, 0, 1, 1]);
            continue;
          }
          const pln = kurs === null ? kwota : przeliczNaPln(kwota, kurs.mid);
          expect(bk).toEqual([]);
          expect(wk.map((w) => [w.data, w.kwoty])).toEqual([[dzien, { ...ZERO, k7: pln }]]);
          if (be.length > 0) {
            // Tylko ewidencja: kilka stawek ryczałtu w korekcie, zaliczce albo rozliczeniu to brak z wyjściem.
            expect([we.length, f.rodzaj !== 'zwykla', (f.pozycje?.length ?? 0) > 1]).toEqual([0, true, true]);
            continue;
          }
          expect(we.every((w) => w.dataPrzychodu === dzien)).toBe(true);
          const razem = we.reduce((s, w) => s + w.kwotaGr, 0);
          if (kurs === null || we.length === 1) {
            expect(razem).toBe(pln);
          } else {
            // Każda stawka przeliczona osobno: najwyżej grosz na każde dwie stawki.
            expect(Math.abs(razem - pln)).toBeLessThanOrEqual(Math.floor(we.length / 2));
            roznicaWMiesiacu.set(dzien.slice(0, 7), (roznicaWMiesiacu.get(dzien.slice(0, 7)) ?? 0) + pln - razem);
          }
        }
        for (let m = 1; m <= 12; m++) {
          const [od, doDnia] = miesiac(m);
          if (brakiKpirOkresu(k, od, doDnia).length + e.braki.filter((b) => b.dzien >= od && b.dzien <= doDnia).length > 0) continue;
          expect(sumyKpir(wierszeKpirOkresu(k, od, doDnia)).kolumny.k7).toBe(sumyOkresu(wierszeOkresu(e, od, doDnia)).razemGr + (roznicaWMiesiacu.get(od.slice(0, 7)) ?? 0));
        }
      }),
      opcje(),
    );
  });

  it('NZ-KPIR-04: faktura w walucie z dwiema stawkami: ewidencja przelicza każdą stawkę, KPiR całość (grosz różnicy)', () => {
    const f = faktura(1, {
      dataWystawienia: `${ROK}-03-10`,
      nettoGr: 2,
      waluta: 'EUR',
      pozycje: [
        { nettoGr: 1, stawkaRyczaltu: 8.5 },
        { nettoGr: 1, stawkaRyczaltu: 15 },
      ],
    });
    const kursy = new Map<string, KursPrzychodu>([[kluczKursu('EUR', `${ROK}-03-10`), { znaleziony: true, mid: 4.25, tabela: '047/A/NBP/2026', dataTabeli: `${ROK}-03-09` }]]);
    expect(ewidencja({ faktury: [f], kursy, wersje: ryczalt(1200) }).wiersze.map((w) => [w.stawkaPb, w.kwotaGr])).toEqual([
      [850, 4],
      [1500, 4],
    ]);
    expect(kpir({ faktury: [f], kursy }).wiersze.map((w) => w.kwoty.k7)).toEqual([9]);
  });

  // NZ-WSP-02 przy progu najmu (K4): stawka najmu 8,5 %, ponad próg 12,5 %, profil z najmem przez cały rok.
  const NAJEM = { stawkaNajmuPb: 850, stawkaPonadProgPb: 1250 } as const;
  const najemArb = fc.record({
    progGr: fc.integer({ min: 0, max: 6_000_000 }),
    faktury: fc
      .array(fc.record({ d: dzienRoku, gr: fc.integer({ min: 1, max: 1_000_000 }), korekta: fc.integer({ min: 0, max: 4 }) }), { maxLength: 10 })
      .map((xs) => xs.map((x, i) => faktura(i, { dataWystawienia: x.d, nettoGr: x.korekta === 0 ? -x.gr : x.gr, rodzaj: x.korekta === 0 ? 'korekta' : 'zwykla' }))),
    wpisy: fc
      .array(fc.record({ d: dzienRoku, gr: fc.integer({ min: 1, max: 1_000_000 }), pb: fc.oneof(fc.constant(NAJEM.stawkaNajmuPb), stawkaRyczaltu) }), { maxLength: 6 })
      .map((xs) => xs.map((x, i) => wpisReczny(i, x.d, x.gr, x.pb))),
  });

  it('NZ-WSP-02: przy progu najmu kolejność nie zmienia ewidencji, a ponad próg idzie nadwyżka przychodu z najmu od początku roku', () => {
    const wersje = ryczalt(NAJEM.stawkaNajmuPb, { najem: true });
    fc.assert(
      fc.property(
        najemArb.chain((n) => fc.tuple(fc.constant(n), permutacja(n.faktury), permutacja(n.wpisy))),
        ([n, faktury2, wpisy2]) => {
          const najem: ProgNajmu = { progGr: n.progGr, ...NAJEM };
          const a = ewidencja({ faktury: n.faktury, wpisy: n.wpisy, wersje, najem });
          const b = ewidencja({ faktury: faktury2, wpisy: wpisy2, wersje, najem });
          const stawki = (e: Ewidencja) => [...sumyOkresu(e.wiersze).stawki].sort((x, y) => x[0] - y[0]);
          expect(stawki(b)).toEqual(stawki(a));
          expect(b.braki).toEqual(a.braki);
          expect(a.braki).toEqual([]);
          const zNajmu = n.faktury.reduce((s, f) => s + f.nettoGr, 0) + n.wpisy.filter((w) => w.stawkaPb === NAJEM.stawkaNajmuPb).reduce((s, w) => s + w.kwotaGr, 0);
          const s = sumyOkresu(a.wiersze).stawki;
          const ponad = s.get(NAJEM.stawkaPonadProgPb) ?? 0;
          expect(ponad).toBe(Math.max(0, zNajmu - n.progGr));
          expect((s.get(NAJEM.stawkaNajmuPb) ?? 0) + ponad).toBe(zNajmu);
        },
      ),
      opcje(),
    );
  });
});
