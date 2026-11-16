import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { zbudujEwidencje, type FakturaEwidencji, type WpisReczny } from '@/lib/ksiegowosc/ewidencja';
import { KOMUNIKAT_ODCZYT, KOMUNIKAT_SRODOWISKO } from '@/lib/ksiegowosc/ewidencja-dane';
import { zbudujKpir, type KosztKpir, type Kpir, type WpisKpir } from '@/lib/ksiegowosc/kpir';
import { KOMUNIKAT_WALUTA_KOSZTU, komunikatDublaKosztu } from '@/lib/ksiegowosc/kpir-dane';
import { parametryRoku } from '@/lib/ksiegowosc/parametry';
import { tenMiesiac, type RodzajRozliczenia } from '@/lib/ksiegowosc/ten-miesiac';
import { BLAD_ODCZYTU_ROZLICZEN, KPIR_WYLACZONA } from '@/lib/ksiegowosc/ten-miesiac-dane';
import { BLAD_ODCZYTU_VAT, brakNadwyzki, KOMUNIKAT_SRODOWISKO_VAT, KOMUNIKAT_WALUTA_VAT, komunikatPrzychodowRecznych } from '@/lib/ksiegowosc/vat-dane';

import { profil } from '../generatory/ksiegowosc';

/**
 * NZ-TRESC-04 (żelazny filtr F10, część 7d) dla braków z warstwy danych
 * (`lib/ksiegowosc/*-dane.ts`), dokumentów w ewidencji i KPiR oraz stopki
 * w telefonie; do tego FZ-015 (tryb rozkazujący w tych tekstach). Reguły jak
 * w `braki.test.ts` (część 7c):
 *
 * - brak pozycji (VAT na stronie „Ten miesiąc”, składka zdrowotna za styczeń
 *   przy nieodczytanej KPiR roku poprzedniego): nazwa braku w pierwszym
 *   zdaniu i skutek o tej pozycji;
 * - brak miesiąca (lista pod tytułem „Kwot za {miesiąc} nie liczymy”) i brak
 *   odczytu na stronach VAT, ewidencji i KPiR: nazwa braku;
 * - brak dokumentu (lista z dopiskiem „Dopóki są braki…”): komunikat zaczyna
 *   się od dokumentu, którego dotyczy (reprezentatywne rodzaje braków
 *   ewidencji i KPiR, także każdy powód niepewnego importu z KSeF);
 * - wszystkie bez słów z listy roboczej NZ-TRESC-01, bez form rozkazujących
 *   z tekstów ekranów i bez długich myślników.
 */

// „należy do” z nazwą (= „jest częścią”, np. „dokument należy do KPiR”) to nie tryb rozkazujący;
// „należy” bez tego, także „należy do 25. dnia złożyć”, tak.
const ZAKAZANE = /(?<![\p{L}])(?:zapłać\p{L}*|musisz|musicie|powinieneś|powinnaś|powinniście|należy(?!\s+do\s+[^\d\s])|zalecamy|radzimy|wybierz\p{L}*|opłaca się|lepiej|najkorzystniej\p{L}*|oszczędzisz|zaoszczędzisz)(?![\p{L}])/iu;
const ROZKAZUJACE = /(?<![\p{L}])(?:uzupełnij|sprawdź|dodaj|wpisz|zmień|kliknij|przejdź|otwórz|zostaw|wyłącz|włącz|przygotuj|napisz|zapisz|skontaktuj|pamiętaj|ustaw|podaj|złóż|prześlij|wyślij|popraw|zaznacz)(?![\p{L}])/iu;
const DLUGIE_MYSLNIKI = /[—–]/;
const NAZWA = /parametr|stawk|ustawie|etap|dat[aęy]|ewidencj|KPiR|kwot[ay]|limit|prog|próg|deklaracj|nadwyżk|faktur|koszt|rozlicze|środowisk|wpis/iu;
const SKUTEK = /nie liczy|nie pokazujemy|nie ustalimy|rozlicza księgowa|u księgowej/iu;
const OBIEKT: Readonly<Record<RodzajRozliczenia, RegExp>> = {
  ryczalt: /ryczałt|kwot|nic(?![\p{L}])/iu,
  pit: /zaliczk|kwot|nic(?![\p{L}])/iu,
  zus_spoleczne: /składek|kwot|nic(?![\p{L}])|miesiąc rozlicza księgowa/iu,
  zdrowotna: /zdrowotn|kwot|nic(?![\p{L}])/iu,
  vat: /VAT|kwot|nic(?![\p{L}])/iu,
};
const pierwszeZdanie = (tekst: string) => tekst.split(/\.\s+(?=[\p{Lu}„])/u)[0];

function bledyTresci(tekst: string): string[] {
  const bledy: string[] = [];
  const slowo = ZAKAZANE.exec(tekst) ?? ROZKAZUJACE.exec(tekst);
  if (slowo) bledy.push(`słowo „${slowo[0]}”`);
  if (DLUGIE_MYSLNIKI.test(tekst)) bledy.push('długi myślnik');
  return bledy.map((b) => `${b}: ${tekst}`);
}

function bledyKomunikatu(tekst: string, rodzaj: RodzajRozliczenia | null): string[] {
  const bledy = bledyTresci(tekst);
  if (!NAZWA.test(pierwszeZdanie(tekst))) bledy.push(`bez nazwy braku w pierwszym zdaniu: ${tekst}`);
  if (rodzaj && !SKUTEK.test(tekst)) bledy.push(`bez tego, co z kwotą będzie: ${tekst}`);
  if (rodzaj && SKUTEK.test(tekst) && !OBIEKT[rodzaj].test(tekst)) bledy.push(`skutek nie o pozycji ${rodzaj}: ${tekst}`);
  return bledy;
}

const MIESIACE = ['2026-01', '2026-05', '2027-01', '2027-12'];
const dubel = komunikatDublaKosztu({ numer: 'FV/12/2026', sprzedawca: 'Dostawca Testowy', ile: 2 });
const wpisy = (n: number) => Array.from({ length: n }, (_, i) => ({ rodzaj: i % 2 ? ('inny' as const) : ('raport_kasy' as const), dokument: `RK/${i + 1}` }));

describe('NZ-TRESC-04 i FZ-015: braki z warstwy danych, dokumentów i telefonu', () => {
  it('sprawdzenie działa na przykładach (żeby test nie był pusty)', () => {
    expect(bledyKomunikatu('JPK_V7M przygotuj poza FaktWay, więc kwot VAT nie pokazujemy.', 'vat')).not.toEqual([]);
    expect(bledyKomunikatu('Do wyliczenia VAT potrzebna jest nadwyżka z deklaracji.', 'vat')).not.toEqual([]);
    expect(bledyKomunikatu('Składka zdrowotna liczy się od dochodu za grudzień 2026. Brak KPiR, więc jej nie liczymy.', 'zdrowotna')).not.toEqual([]);
    expect(bledyTresci('Uzupełnij brakujące dane na faktway.pl.')).not.toEqual([]);
    expect(bledyTresci('Należy złożyć JPK_V7M do 25 listopada.')).not.toEqual([]);
    expect(bledyTresci('Dokument należy do KPiR za marzec.')).toEqual([]);
    expect(bledyTresci('Należy do 25. dnia złożyć deklarację.')).not.toEqual([]);
  });

  it('pozycja VAT na stronie „Ten miesiąc”: każdy brak z odczytu VAT ma nazwę i skutek', () => {
    const teksty = [
      BLAD_ODCZYTU_VAT,
      KOMUNIKAT_WALUTA_VAT,
      KOMUNIKAT_SRODOWISKO_VAT,
      ...MIESIACE.flatMap((m) => [brakNadwyzki(m), ...[1, 3, 5].map((n) => komunikatPrzychodowRecznych(m, wpisy(n)))]),
    ];
    expect(teksty.flatMap((t) => bledyKomunikatu(t, 'vat'))).toEqual([]);
  });

  it('brak miesiąca i brak odczytu ksiąg: nazwa braku, bez trybu rozkazującego', () => {
    const teksty = [KPIR_WYLACZONA, BLAD_ODCZYTU_ROZLICZEN, KOMUNIKAT_ODCZYT, KOMUNIKAT_SRODOWISKO, KOMUNIKAT_WALUTA_KOSZTU, dubel];
    expect(teksty.flatMap((t) => bledyKomunikatu(t, null))).toEqual([]);
  });

  it('składka zdrowotna za styczeń bez KPiR roku poprzedniego: nazwa braku i skutek przy każdym powodzie odczytu', () => {
    const pustaKpir = (rok: number): Kpir => ({ rok, wiersze: [], braki: [], pominiete: [] });
    const bledy: string[] = [];
    for (const forma of ['skala', 'liniowy'] as const) {
      for (const powod of [KOMUNIKAT_ODCZYT, KOMUNIKAT_SRODOWISKO, KOMUNIKAT_WALUTA_KOSZTU, dubel]) {
        const w = tenMiesiac({
          miesiac: '2027-01',
          wersje: [profil({ forma, validFrom: '2026-01-01' })],
          platnosci: [],
          parametry: parametryRoku,
          kpir: { rok: pustaKpir(2027), poprzedni: null, brakPoprzedniego: powod },
        });
        if (!w.ok) throw new Error(w.braki.join(' '));
        const zdrowotna = w.wynik.pozycje.find((p) => p.rodzaj === 'zdrowotna');
        if (!zdrowotna || zdrowotna.ok) throw new Error('oczekiwany brak składki zdrowotnej');
        bledy.push(...bledyKomunikatu(zdrowotna.brak, 'zdrowotna'));
      }
    }
    expect(bledy).toEqual([]);
  });

  it('braki dokumentów w ewidencji i KPiR zaczynają się od dokumentu, bez trybu rozkazującego', () => {
    const faktura = (numer: string, dzien: string, z: Partial<FakturaEwidencji> = {}): FakturaEwidencji => ({
      id: `f-${numer}`, numer, dataWystawienia: dzien, dataSprzedazy: dzien, rodzaj: 'zwykla', nettoGr: 100_000, waluta: 'PLN',
      numerKsef: null, fp: false, kontrahent: { kraj: null, identyfikator: null }, rozliczoneZaliczkiGr: 0, pozycje: null, ...z,
    });
    const ryczalt = [profil({ forma: 'ryczalt', validFrom: '2026-03-01' }), profil({ id: 'p2', forma: 'skala', validFrom: '2026-06-01' })];
    const wpisReczny = (dokument: string, dzien: string): WpisReczny => ({
      id: `w-${dokument}`, rodzaj: 'inny', dataPrzychodu: dzien, dataWpisu: dzien, dokument, kwotaGr: 50_000, stawkaPb: 1200, opis: null,
    });
    const ewidencja = zbudujEwidencje({
      rok: 2026,
      wersje: ryczalt,
      kursy: new Map(),
      faktury: [
        faktura('FV/1', '2026-02-10'),
        faktura('FV/2', '2026-04-10', { waluta: 'EUR' }),
        faktura('FV/3', '2026-04-11', { niepewnyImport: 'sumy' }),
        faktura('FV/4', '2026-04-12', { fp: true }),
        faktura('FV/7', '2026-04-13', { niepewnyImport: 'przed_odczytem' }),
        faktura('FV/8', '2026-04-14', { niepewnyImport: 'daty_sprzedazy' }),
        faktura('FV/9', '2026-05-12', { fp: true, nettoGr: 500_000 }),
      ],
      wpisy: [wpisReczny('W/1', '2026-02-05'), wpisReczny('W/2', '2026-07-05'), { ...wpisReczny('RK/5', '2026-05-31'), rodzaj: 'raport_kasy', kwotaGr: 1_000 }],
    });
    const skala = [profil({ forma: 'skala', validFrom: '2026-03-01' }), profil({ id: 'p2', forma: 'ryczalt', validFrom: '2026-06-01' })];
    const koszt = (dowod: string, data: string, kolumnaAplikacji: string | null): KosztKpir => ({
      id: `k-${dowod}`, data, dowod, numerKsef: null, kontrahent: { nazwa: 'Dostawca', adres: null, kraj: null, identyfikator: null },
      opis: 'Usługa', kolumnaAplikacji, kwotaGr: 20_000,
    });
    const wpisKpir = (dokument: string, data: string): WpisKpir => ({ id: `wk-${dokument}`, data, dokument, kolumna: 'k8', kwotaGr: 10_000, opis: null });
    const kpir = zbudujKpir({
      rok: 2026,
      wersje: skala,
      kursy: new Map(),
      faktury: [faktura('FV/5', '2026-02-10'), faktura('FV/6', '2026-04-10', { waluta: 'EUR' })],
      koszty: [koszt('K/1', '2026-04-01', null), koszt('K/2', '2026-04-02', 'col_7'), koszt('K/3', '2026-02-01', 'col_13')],
      wpisy: [wpisKpir('WK/1', '2026-07-01')],
    });
    const braki = [...ewidencja.braki, ...kpir.braki];
    // Każdy rodzaj braku z listy wyżej rzeczywiście powstał (inaczej test byłby pusty).
    expect(new Set(braki.map((b) => b.dokument))).toEqual(
      new Set(['FV/1', 'FV/2', 'FV/3', 'FV/4', 'FV/7', 'FV/8', 'FV/9', 'W/1', 'W/2', 'FV/5', 'FV/6', 'K/1', 'K/2', 'K/3', 'WK/1']),
    );
    const bledy = braki.flatMap((b) => [
      ...bledyTresci(b.komunikat),
      ...(pierwszeZdanie(b.komunikat).includes(b.dokument) ? [] : [`brak dokumentu ${b.dokument} w pierwszym zdaniu: ${b.komunikat}`]),
    ]);
    expect(bledy).toEqual([]);
  });

  it('telefon: stopki list na ekranie księgowości bez trybu rozkazującego', () => {
    const plik = readFileSync(join(process.cwd(), 'mobile/src/app/(zakladki)/ksiegowosc/index.tsx'), 'utf8');
    const stopki = [...plik.matchAll(/stopka=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g)].map((d) => d[1] ?? d[2] ?? d[3]);
    expect(stopki.length).toBeGreaterThan(0);
    expect(stopki.flatMap(bledyTresci)).toEqual([]);
  });
});
