import { describe, expect, it } from 'vitest';

import type { FakturaEwidencji } from '@/lib/ksiegowosc/ewidencja';
import { sumyKpir, wierszeKpirOkresu, zaplatyFunduszuPracy, zbudujKpir, zmianyPodzialu, type KosztKpir, type WejscieKpir, type WersjaPodzialu } from '@/lib/ksiegowosc/kpir';
import { parametryRoku } from '@/lib/ksiegowosc/parametry';
import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';
import { tenMiesiac, type Platnosc } from '@/lib/ksiegowosc/ten-miesiac';

/**
 * KPiR według wzoru 2026 (plan księgowości JDG, K7): wiersze K_1-K_17
 * z faktur, kosztów i wpisów ręcznych na zasadach ewidencji z K3, oraz
 * „Ten miesiąc” przy skali z KPiR (zaliczka i zdrowotna od dochodu).
 */

const SKALA: WersjaProfilu = {
  id: 'p1',
  validFrom: '2026-01-01',
  forma: 'skala',
  stawkaDomyslna: null,
  zusEtap: 'pelny',
  zusOd: null,
  chorobowe: true,
  nrsZus: null,
  najem: false,
};

function faktura(dzien: string, gr: number, z: Partial<FakturaEwidencji> = {}): FakturaEwidencji {
  return {
    id: `f-${dzien}-${gr}`,
    numer: `FV/${dzien}`,
    dataWystawienia: dzien,
    dataSprzedazy: dzien,
    rodzaj: 'zwykla',
    nettoGr: gr,
    waluta: 'PLN',
    numerKsef: null,
    fp: false,
    kontrahent: { kraj: 'PL', identyfikator: '5252241585', nazwa: 'Klient Sp. z o.o.', adres: 'ul. Prosta 1, 00-001 Warszawa' },
    rozliczoneZaliczkiGr: 0,
    pozycje: null,
    ...z,
  };
}

function koszt(dzien: string, gr: number, z: Partial<KosztKpir> = {}): KosztKpir {
  return {
    id: `k-${dzien}-${gr}`,
    data: dzien,
    dowod: `FZ/${dzien}`,
    numerKsef: null,
    kontrahent: { nazwa: 'Dostawca', adres: null, kraj: 'PL', identyfikator: '5260001246' },
    opis: 'Usługi księgowe',
    kolumnaAplikacji: 'col_13',
    kwotaGr: gr,
    ...z,
  };
}

const wejscie = (z: Partial<WejscieKpir> = {}): WejscieKpir => ({ rok: 2026, faktury: [], koszty: [], wpisy: [], wersje: [SKALA], kursy: new Map(), ...z });

describe('KPiR 2026', () => {
  it('sprzedaż w K_7 z kontrahentem (K_4-K_5), koszt w kolumnie z kategorii; przychody przed kosztami w tym samym dniu', () => {
    const k = zbudujKpir(
      wejscie({
        faktury: [faktura('2026-03-10', 1_000_000, { numerKsef: '5260001246-20260310-0100001AF629-AF' })],
        koszty: [koszt('2026-03-10', 20_000), koszt('2026-03-05', 50_000, { kolumnaAplikacji: 'col_10' })],
      }),
    );
    expect(k.braki).toEqual([]);
    expect(k.wiersze.map((w) => [w.lp, w.data, w.zrodlo.typ])).toEqual([
      [1, '2026-03-05', 'koszt'],
      [2, '2026-03-10', 'faktura'],
      [3, '2026-03-10', 'koszt'],
    ]);
    expect(k.wiersze[1]).toMatchObject({
      dowod: 'FV/2026-03-10',
      numerKsef: '5260001246-20260310-0100001AF629-AF',
      krajKontrahenta: 'PL',
      idKontrahenta: '5252241585',
      nazwaKontrahenta: 'Klient Sp. z o.o.',
      adresKontrahenta: 'ul. Prosta 1, 00-001 Warszawa',
      opis: 'Sprzedaż towarów i usług',
      kwoty: { k7: 1_000_000, k8: 0, k10: 0, k11: 0, k12: 0, k13: 0 },
    });
    // Kontrahent bez adresu: pole obowiązkowe K_5B dostaje „BRAK”.
    expect(k.wiersze[0]).toMatchObject({ adresKontrahenta: 'BRAK', kwoty: { k10: 50_000 } });
    expect(sumyKpir(k.wiersze)).toMatchObject({ przychodGr: 1_000_000, kosztyGr: 70_000, liczbaWierszy: 3 });
  });

  it('korekta w dniu wystawienia, rozliczenie bez zaliczek, faktura do paragonu poza przychodem z brakiem', () => {
    // Krok 1.2 planu kompletnej aplikacji: FP nie jest przychodem. Wpis niżej
    // nie ma rodzaju dowodu, więc nie jest raportem kasy i FP zostaje brakiem
    // (reguła pokrycia z części 2: `faktura-do-paragonu-pokrycie-kasy.test.ts`).
    const k = zbudujKpir(
      wejscie({
        faktury: [
          faktura('2026-04-15', -20_000, { rodzaj: 'korekta', dataSprzedazy: '2026-03-10', numer: 'KOR/1' }),
          faktura('2026-04-20', 300_000, { rodzaj: 'rozliczenie', rozliczoneZaliczkiGr: 100_000, numer: 'ROZ/1' }),
          faktura('2026-04-21', 50_000, { fp: true, numer: 'FP/1' }),
        ],
        wpisy: [{ id: 'rk-4', data: '2026-04-30', dokument: 'RK/04/2026', kolumna: 'k7', kwotaGr: 80_000, opis: null }],
      }),
    );
    expect(k.wiersze.map((w) => [w.dowod, w.data, w.kwoty.k7, w.uwagi])).toEqual([
      ['KOR/1', '2026-04-15', -20_000, 'Korekta (różnica)'],
      ['ROZ/1', '2026-04-20', 200_000, 'Rozliczenie, pomniejszone o zaliczki 1000,00 PLN'],
      ['RK/04/2026', '2026-04-30', 80_000, null],
    ]);
    expect(k.pominiete).toEqual([]);
    expect(k.braki).toEqual([expect.objectContaining({ dokument: 'FP/1', dzien: '2026-04-21' })]);
  });

  it('waluta po kursie NBP, bez kursu brak; dzień z ryczałtem poza KPiR bez braku, dzień bez profilu z brakiem', () => {
    const ryczaltOdMaja: WersjaProfilu = { ...SKALA, id: 'p2', validFrom: '2026-05-01', forma: 'ryczalt', stawkaDomyslna: 1200 };
    const k = zbudujKpir(
      wejscie({
        wersje: [{ ...SKALA, validFrom: '2026-02-01' }, ryczaltOdMaja],
        faktury: [
          faktura('2026-03-02', 10_000, { waluta: 'EUR', numer: 'EUR/1' }),
          faktura('2026-03-03', 10_000, { waluta: 'EUR', numer: 'EUR/2' }),
          faktura('2026-05-04', 10_000, { numer: 'RYCZ/1' }),
          faktura('2026-01-15', 10_000, { numer: 'STYCZEN/1' }),
        ],
        kursy: new Map([['EUR|2026-03-02', { znaleziony: true, mid: 4.2586, tabela: '041/A/NBP/2026', dataTabeli: '2026-02-27' }]]),
      }),
    );
    expect(k.wiersze.map((w) => [w.dowod, w.kwoty.k7])).toEqual([['EUR/1', 42_586]]);
    expect(k.braki.map((b) => b.dokument)).toEqual(['STYCZEN/1', 'EUR/2']);
    expect(k.braki[1].komunikat).toContain('brak kursu średniego NBP');
  });

  it('koszt B+R w K_13 i K_16; koszt bez kolumny albo z kolumną przychodu to brak z wyjściem', () => {
    const k = zbudujKpir(
      wejscie({
        koszty: [
          koszt('2026-06-01', 30_000, { kolumnaAplikacji: 'col_15', opis: 'Badania' }),
          koszt('2026-06-02', 10_000, { kolumnaAplikacji: null, dowod: 'BEZ/1' }),
          koszt('2026-06-03', 10_000, { kolumnaAplikacji: 'col_7', dowod: 'PRZ/1' }),
        ],
      }),
    );
    expect(k.wiersze).toHaveLength(1);
    expect(k.wiersze[0]).toMatchObject({ kwoty: { k13: 30_000 }, br: { opis: 'Badania', kwotaGr: 30_000 } });
    expect(k.braki.map((b) => [b.dokument, b.komunikat])).toEqual([
      ['BEZ/1', expect.stringContaining('nie ma kolumny KPiR')],
      ['PRZ/1', expect.stringContaining('ma kolumnę przychodu')],
    ]);
    expect(sumyKpir(k.wiersze)).toMatchObject({ kosztyGr: 30_000, brGr: 30_000 });
  });

  it('wpis ręczny w swojej kolumnie (raport kasy w K_7, inny przychód w K_8)', () => {
    const k = zbudujKpir(
      wejscie({
        wpisy: [
          { id: 'w1', data: '2026-07-31', dokument: 'RK/07', kolumna: 'k7', kwotaGr: 123_456, opis: 'Raport miesięczny' },
          { id: 'w2', data: '2026-07-15', dokument: 'NOTA/1', kolumna: 'k8', kwotaGr: 5_000, opis: null },
        ],
      }),
    );
    expect(k.wiersze.map((w) => [w.dowod, w.kwoty.k7, w.kwoty.k8, w.opis, w.nazwaKontrahenta])).toEqual([
      ['NOTA/1', 0, 5_000, 'Przychód', 'BRAK'],
      ['RK/07', 123_456, 0, 'Raport miesięczny', 'BRAK'],
    ]);
    expect(wierszeKpirOkresu(k, '2026-07-20', '2026-07-31').map((w) => [w.lp, w.dowod])).toEqual([[1, 'RK/07']]);
  });
});

describe('„Ten miesiąc” przy skali z KPiR', () => {
  const zaplata = (miesiac: string, rodzaj: Platnosc['rodzaj'], kwotaGr: number, zaplaconeO: string, spoleczneBezFpGr = 0): Platnosc => ({
    miesiac,
    rodzaj,
    wersja: 1,
    kwotaGr,
    spoleczneBezFpGr,
    zaplaconeO,
  });

  it('marzec: zaliczka narastająco od stycznia, zdrowotna 9 % dochodu z lutego po zapłaconych społecznych', () => {
    const miesiace = ['2026-01-31', '2026-02-28', '2026-03-31'];
    const kpir = zbudujKpir(
      wejscie({
        faktury: miesiace.map((d) => faktura(d, 2_000_000)),
        koszty: miesiace.map((d) => koszt(d, 500_000)),
      }),
    );
    const w = tenMiesiac({
      miesiac: '2026-03',
      kpir: { rok: kpir, poprzedni: null },
      wersje: [SKALA],
      // Składki za styczeń i luty zapłacone w lutym i marcu (społeczne bez FP 1 788,29 zł).
      platnosci: [zaplata('2026-01', 'zus_spoleczne', 192_676, '2026-02-16', 178_829), zaplata('2026-02', 'zus_spoleczne', 192_676, '2026-03-16', 178_829)],
      parametry: parametryRoku,
    });
    if (!w.ok) throw new Error(w.braki.join(' '));
    const pozycje = Object.fromEntries(w.wynik.pozycje.map((p) => [p.rodzaj, p.ok ? p.kwotaGr : p.brak]));
    // Dochód I-III: 45 000 zł, społeczne 3 576,58 zł → podstawa 41 423 zł → 12 % = 4 970,76 − 3 600 = 1 370,76 zł.
    // Styczeń: 15 000 → 1 800 − 3 600 < 0; luty: 30 000 − 1 788,29 = 28 212 → 3 385,44 − 3 600 < 0; marzec: 1 371 zł.
    expect(pozycje.pit).toBe(137_100);
    expect(w.wynik.pit).toMatchObject({ dochodNarastajacoGr: 4_500_000, spoleczneNarastajacoGr: 357_658, podstawaNarastajacoGr: 4_142_300 });
    // Zdrowotna za marzec: dochód lutego 15 000 − 1 788,29 = 13 211,71 zł → 9 % = 1 189,05 zł.
    expect(pozycje.zdrowotna).toBe(118_905);
    expect(w.wynik.zdrowotnaOdDochodu).toMatchObject({ dochodGr: 1_321_171, minimalna: false });
    expect(w.wynik).toMatchObject({ przychodGr: 2_000_000, kosztyGr: 500_000 });
    expect(w.wynik.pozycje.find((p) => p.rodzaj === 'pit')?.termin?.faktyczny).toBe('2026-04-20');
  });

  it('styczeń bierze dochód z grudnia z KPiR roku poprzedniego; bez niej brak zdrowotnej', () => {
    const grudzien = zbudujKpir(wejscie({ faktury: [faktura('2026-12-31', 300_000)] }));
    const styczen = zbudujKpir(wejscie({ rok: 2027, faktury: [faktura('2027-01-31', 300_000)] }));
    const w = tenMiesiac({ miesiac: '2027-01', kpir: { rok: styczen, poprzedni: grudzien }, wersje: [SKALA], platnosci: [], parametry: parametryRoku });
    if (!w.ok) throw new Error(w.braki.join(' '));
    // Styczeń 2027 należy do roku składkowego od lutego 2026 r.: grudniowe 3 000 zł × 9 % = 270 zł, więc minimalna 432,54 zł.
    expect(w.wynik.pozycje.find((p) => p.rodzaj === 'zdrowotna')).toMatchObject({ ok: true, kwotaGr: 43_254, wejscia: { dochodGr: 300_000, zMiesiaca: '2026-12' } });

    const bezGrudnia = tenMiesiac({ miesiac: '2027-01', kpir: { rok: styczen, poprzedni: null }, wersje: [SKALA], platnosci: [], parametry: parametryRoku });
    if (!bezGrudnia.ok) throw new Error(bezGrudnia.braki.join(' '));
    expect(bezGrudnia.wynik.pozycje.find((p) => p.rodzaj === 'zdrowotna')).toMatchObject({ ok: false, brak: expect.stringContaining('grudzień 2026') });
  });

  it('brak w KPiR od stycznia zabiera zaliczkę, a składki społeczne zostają', () => {
    const kpir = zbudujKpir(wejscie({ koszty: [koszt('2026-02-10', 10_000, { kolumnaAplikacji: null })], faktury: [faktura('2026-03-31', 100_000)] }));
    const w = tenMiesiac({ miesiac: '2026-03', kpir: { rok: kpir, poprzedni: null }, wersje: [SKALA], platnosci: [], parametry: parametryRoku });
    if (!w.ok) throw new Error(w.braki.join(' '));
    const pit = w.wynik.pozycje.find((p) => p.rodzaj === 'pit');
    expect(pit).toMatchObject({ ok: false, brak: expect.stringContaining('KPiR ma braki w miesiącach: luty 2026') });
    expect(w.wynik.pozycje.find((p) => p.rodzaj === 'zus_spoleczne')).toMatchObject({ ok: true });
  });
});

describe('Fundusz Pracy w KPiR (K7.3, D21)', () => {
  const zaplata = (okres: string, wersja: number, kwotaGr: number, bezFpGr: number, zaplaconeO: string, id = `${okres}-${wersja}`) => ({
    id,
    okres,
    wersja,
    kwotaGr,
    spoleczneBezFpGr: bezFpGr,
    zaplaconeO,
  });

  it('FP z przyrostów zapłaconych wersji: dopłata daje tylko różnicę FP, zapłata bez FP nic', () => {
    expect(
      zaplatyFunduszuPracy([
        zaplata('2026-01', 1, 192_676, 178_829, '2026-02-10'),
        zaplata('2026-01', 2, 200_000, 185_000, '2026-03-05'),
        zaplata('2026-02', 1, 45_618, 45_618, '2026-03-10'),
      ]),
    ).toEqual([
      { id: '2026-01-1', zaMiesiac: '2026-01', data: '2026-02-10', fpGr: 13_847 },
      { id: '2026-01-2', zaMiesiac: '2026-01', data: '2026-03-05', fpGr: 1_153 },
    ]);
  });

  it('wiersz kolumny 13 w dniu zapłaty, z opisem okresu; dzień z ryczałtem pomijany, bez ustawień brak', () => {
    const k = zbudujKpir(wejscie({ zaplatyFp: [{ id: 'z1', zaMiesiac: '2026-02', data: '2026-03-10', fpGr: 13_847 }] }));
    const w = k.wiersze.find((x) => x.zrodlo.typ === 'zaplata');
    expect(w).toMatchObject({
      data: '2026-03-10',
      dowod: 'Składki ZUS za 02/2026',
      nazwaKontrahenta: 'Zakład Ubezpieczeń Społecznych',
      opis: 'Fundusz Pracy i Fundusz Solidarnościowy za luty 2026',
      kwoty: { k13: 13_847 },
      zrodlo: { typ: 'zaplata', id: 'z1' },
    });
    expect(sumyKpir(wierszeKpirOkresu(k, '2026-03-01', '2026-03-31')).kosztyGr).toBe(13_847);
    const ryczalt = zbudujKpir(wejscie({ wersje: [{ ...SKALA, forma: 'ryczalt', stawkaDomyslna: 1200 }], zaplatyFp: [{ id: 'z1', zaMiesiac: '2026-02', data: '2026-03-10', fpGr: 13_847 }] }));
    expect(ryczalt.wiersze).toEqual([]);
    expect(ryczalt.braki).toEqual([]);
    const bezUstawien = zbudujKpir(wejscie({ wersje: [{ ...SKALA, validFrom: '2026-06-01' }], zaplatyFp: [{ id: 'z1', zaMiesiac: '2026-02', data: '2026-03-10', fpGr: 13_847 }] }));
    expect(bezUstawien.braki.map((b) => b.dokument)).toEqual(['Składki ZUS za 02/2026']);
  });
});


describe('FZ-027: zmiana podziału zapłaconych składek przy skali', () => {
  // Składki za styczeń zapłacone 10.02 z podziałem z wyliczenia, a 16.02 ta sama kwota zapisana cała bez FP (pomyłka).
  const zmiana: Platnosc[] = [
    { miesiac: '2026-01', rodzaj: 'zus_spoleczne', wersja: 1, kwotaGr: 192_676, spoleczneBezFpGr: 178_829, zaplaconeO: '2026-02-10' },
    { miesiac: '2026-01', rodzaj: 'zus_spoleczne', wersja: 2, kwotaGr: 192_676, spoleczneBezFpGr: 192_676, zaplaconeO: '2026-02-16' },
  ];
  const skladki = zmiana.map((p, i) => ({ id: `r${i + 1}`, okres: p.miesiac, wersja: p.wersja, kwotaGr: p.kwotaGr, spoleczneBezFpGr: p.spoleczneBezFpGr, zaplaconeO: p.zaplaconeO }));
  const ksiega = (z: Partial<WejscieKpir> = {}) =>
    zbudujKpir(wejscie({ faktury: ['2026-01-31', '2026-02-28', '2026-03-31'].map((d) => faktura(d, 2_000_000)), zaplatyFp: zaplatyFunduszuPracy(skladki), ...z }));
  const pozycja = (miesiac: string, kpir: ReturnType<typeof zbudujKpir>, rodzaj: string) => {
    const w = tenMiesiac({ miesiac, kpir: { rok: kpir, poprzedni: null }, wersje: [SKALA], platnosci: zmiana, parametry: parametryRoku });
    if (!w.ok) throw new Error(w.braki.join(' '));
    return w.wynik.pozycje.find((p) => p.rodzaj === rodzaj);
  };

  it('KPiR: brak z okresem w dniu obu zapłat, z obiema wersjami w komunikacie, więc zaliczka za luty to brak', () => {
    const kpir = ksiega({ zmianyPodzialu: zmianyPodzialu(skladki) });
    expect(kpir.braki.map((b) => [b.dzien, b.dokument])).toEqual([
      ['2026-02-10', 'Składki ZUS za 01/2026'],
      ['2026-02-16', 'Składki ZUS za 01/2026'],
    ]);
    expect(kpir.braki[0].komunikat).toContain('wersja 1 zapłacona 10.02.2026 (1926,76 zł, w tym bez Funduszu Pracy i FS 1788,29 zł)');
    expect(kpir.braki[0].komunikat).toContain('wersja 2 zapłacona 16.02.2026 (1926,76 zł, w tym bez Funduszu Pracy i FS 1926,76 zł)');
    expect(kpir.braki[0].komunikat).toContain('„Cofnij”');
    expect(pozycja('2026-02', kpir, 'pit')).toMatchObject({ ok: false, brak: expect.stringContaining('luty 2026') });
  });

  it('zdrowotna od dochodu ma brak za miesiąc po pierwszej zapłacie okresu, także gdy wersja ze zmianą jest zapłacona później', () => {
    const pozniej: Platnosc[] = [
      { miesiac: '2026-01', rodzaj: 'zus_spoleczne', wersja: 1, kwotaGr: 192_676, spoleczneBezFpGr: 192_676, zaplaconeO: '2026-02-10' },
      { miesiac: '2026-01', rodzaj: 'zus_spoleczne', wersja: 2, kwotaGr: 192_676, spoleczneBezFpGr: 178_829, zaplaconeO: '2026-03-05' },
    ];
    const kpir = ksiega();
    const zdrowotna = (miesiac: string) => {
      const w = tenMiesiac({ miesiac, kpir: { rok: kpir, poprzedni: null }, wersje: [SKALA], platnosci: pozniej, parametry: parametryRoku });
      if (!w.ok) throw new Error(w.braki.join(' '));
      return w.wynik.pozycje.find((p) => p.rodzaj === 'zdrowotna');
    };
    // Marzec liczy się z dochodu z lutego, a w lutym jest pierwsza zapłata okresu.
    expect(zdrowotna('2026-03')).toMatchObject({ ok: false, brak: expect.stringContaining('wersja 1 zapłacona 10.02.2026') });
    expect(zdrowotna('2026-02')).toMatchObject({ ok: true });
  });

  it('okres zapłacony w dwóch latach: brak w księdze każdego roku z zapłatą', () => {
    const wersje = [{ ...SKALA, validFrom: '2025-01-01' }];
    const przelom = [
      { id: 'r1', okres: '2025-12', wersja: 1, kwotaGr: 100_000, spoleczneBezFpGr: 0, zaplaconeO: '2025-12-29' },
      { id: 'r2', okres: '2025-12', wersja: 2, kwotaGr: 100_000, spoleczneBezFpGr: 90_000, zaplaconeO: '2026-01-15' },
    ];
    const zmiany = zmianyPodzialu(przelom);
    for (const [rok, dzien] of [[2025, '2025-12-29'], [2026, '2026-01-15']] as const) {
      const k = zbudujKpir(wejscie({ rok, wersje, zaplatyFp: zaplatyFunduszuPracy(przelom), zmianyPodzialu: zmiany }));
      expect(k.braki.map((b) => [b.dzien, b.dokument]), String(rok)).toEqual([[dzien, 'Składki ZUS za 12/2025']]);
    }
  });

  it('brak należy do księgi roku dnia zapłaty tej wersji, a dzień z ryczałtem nie ma braku w KPiR', () => {
    const w = { kwotaGr: 100_000, bezFpGr: 90_000 };
    const zmiany = [{ okres: '2025-11', dni: ['2025-12-20'], wersje: [{ wersja: 1, data: '2025-12-20', ...w }, { wersja: 2, data: '2025-12-20', ...w, bezFpGr: 100_000 }] as [WersjaPodzialu, WersjaPodzialu] }];
    const wersje = [{ ...SKALA, validFrom: '2025-01-01' }];
    expect(zbudujKpir(wejscie({ wersje, zmianyPodzialu: zmiany })).braki).toEqual([]);
    const k2025 = zbudujKpir(wejscie({ rok: 2025, wersje, zmianyPodzialu: zmiany }));
    expect(k2025.braki.map((b) => [b.dzien, b.dokument, b.komunikat.includes('„Cofnij”')])).toEqual([['2025-12-20', 'Składki ZUS za 11/2025', true]]);
    expect(zbudujKpir(wejscie({ rok: 2025, wersje: [{ ...SKALA, validFrom: '2025-01-01', forma: 'ryczalt' }], zmianyPodzialu: zmiany })).braki).toEqual([]);
  });

  it('„Ten miesiąc” sam odmawia zaliczki od lutego i składki zdrowotnej od dochodu z lutego, także gdy KPiR braku nie ma', () => {
    const kpir = ksiega();
    expect(kpir.braki).toEqual([]);
    for (const [miesiac, rodzaj] of [['2026-02', 'pit'], ['2026-03', 'pit'], ['2026-04', 'pit'], ['2026-03', 'zdrowotna']]) {
      expect(pozycja(miesiac, kpir, rodzaj), `${miesiac} ${rodzaj}`).toMatchObject({ ok: false, brak: expect.stringContaining('Składki ZUS za styczeń 2026') });
    }
    // Styczeń jest przed tą zapłatą, a zdrowotna za kwiecień liczy się z dochodu z marca.
    for (const [miesiac, rodzaj] of [['2026-01', 'pit'], ['2026-02', 'zdrowotna'], ['2026-04', 'zdrowotna']]) {
      expect(pozycja(miesiac, kpir, rodzaj), `${miesiac} ${rodzaj}`).toMatchObject({ ok: true });
    }
  });
});
