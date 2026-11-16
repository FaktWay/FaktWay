/**
 * Księgowość na prawdziwym koncie (M10b): „Ten miesiąc” z
 * `GET /api/mobile/v1/ksiegowosc`, to samo wyliczenie co strona
 * `reports/ten-miesiac` (terminy, kwoty, dane do przelewu, stan wersji i zapłat).
 *
 * Jeden magazyn dla konta, firmy i miesiąca (wzór `stan/naleznosci.tsx`): lista
 * i arkusz „Dane do przelewu” widzą tę samą wersję, a zapis na jednym ekranie
 * od razu widać na drugim. Odpowiedź dla miesiąca domyślnego (poprzedniego,
 * jak strona) trafia też pod klucz właściwego miesiąca. Kwoty są w groszach.
 * Na danych przykładowych `useTenMiesiac` zwraca `null`.
 *
 * Od M10d z nadwyżką VAT wpisaną przy pozycji VAT (`?nadwyzka=` jak strona; klucz
 * magazynu ją zawiera, więc arkusz przelewu dostaje ją w parametrach trasy) oraz
 * z listą i formularzem zapłat spoza wyliczenia (`TenMiesiacDodatki`).
 */
import { useEffect, useEffectEvent, useSyncExternalStore } from 'react';

import type { PozycjaRozliczeniaTelefonu, TenMiesiacOdpowiedz } from '@/lib/api/kontrakt';
import type { TenMiesiacDodatki } from '@/lib/api/kontrakt-ksiegowosc';
import type { Wynik } from '@/lib/api/rdzen';
import { czyscPrzyKoncuSesji } from '@/stan/czyszczenie';
import { useKontoFirmy } from '@/stan/dane';

/** Odpowiedź „Ten miesiąc” z dodatkami M10d (nadwyżka VAT, zapłaty spoza wyliczenia). */
export type TenMiesiacTelefonu = TenMiesiacOdpowiedz & TenMiesiacDodatki;

export type StanTenMiesiac = {
  stan: 'ladowanie' | 'gotowe' | 'blad';
  dane?: TenMiesiacTelefonu;
  blad?: string;
  odswiez: () => Promise<void>;
};

type Wpis = { stan: StanTenMiesiac['stan']; dane?: TenMiesiacTelefonu; blad?: string };

const wpisy = new Map<string, Wpis>();
const sluchacze = new Set<() => void>();
const LADOWANIE: Wpis = { stan: 'ladowanie' };

function ustaw(klucz: string, wpis: Wpis): void {
  wpisy.set(klucz, wpis);
  for (const s of sluchacze) s();
}

function subskrybuj(sluchacz: () => void): () => void {
  sluchacze.add(sluchacz);
  return () => sluchacze.delete(sluchacz);
}

czyscPrzyKoncuSesji(() => {
  wpisy.clear();
  for (const s of sluchacze) s();
});

function przyjmij(baza: string, klucz: string, nadwyzka: string, w: Wynik<TenMiesiacTelefonu>): void {
  const byl = wpisy.get(klucz);
  if (w.ok) {
    ustaw(klucz, { stan: 'gotowe', dane: w.dane });
    ustaw(`${baza}:${w.dane.miesiac}:${nadwyzka}`, { stan: 'gotowe', dane: w.dane });
  } else {
    ustaw(klucz, { stan: byl?.dane ? 'gotowe' : 'blad', dane: byl?.dane, blad: w.blad.komunikat });
  }
}

/**
 * `miesiac`: RRRR-MM albo `undefined` (domyślny, poprzedni miesiąc). `nadwyzka`:
 * P_39 w pełnych złotych wpisane przy pozycji VAT (same cyfry) albo `undefined`.
 */
export function useTenMiesiac(miesiac?: string, nadwyzka?: string): StanTenMiesiac | null {
  const k = useKontoFirmy();
  const firma = k?.firma?.id;
  const baza = k?.konto && firma ? `${k.konto.konto.id}:${firma}` : undefined;
  const n = nadwyzka ?? '';
  const klucz = baza ? `${baza}:${miesiac ?? 'domyslny'}:${n}` : undefined;
  const wpis = useSyncExternalStore(subskrybuj, () => (klucz ? (wpisy.get(klucz) ?? LADOWANIE) : LADOWANIE));
  const zapytanie = [miesiac ? `miesiac=${miesiac}` : '', n ? `nadwyzka=${n}` : ''].filter(Boolean).join('&');
  const sciezka = zapytanie ? `ksiegowosc?${zapytanie}` : 'ksiegowosc';

  const zapytaj = k?.zapytaj;
  const pobierzTeraz = useEffectEvent(() => zapytaj?.<TenMiesiacTelefonu>(sciezka));
  useEffect(() => {
    if (!baza || !klucz) return;
    void pobierzTeraz()?.then((w) => przyjmij(baza, klucz, n, w));
  }, [baza, klucz, n]);

  if (!k) return null;
  return {
    stan: wpis.stan,
    dane: wpis.dane,
    blad: wpis.blad,
    odswiez: async () => {
      if (!baza || !klucz) return;
      przyjmij(baza, klucz, n, await k.zapytaj<TenMiesiacTelefonu>(sciezka));
    },
  };
}

const MIESIAC = new Intl.DateTimeFormat('pl-PL', { month: 'long', year: 'numeric' });

/** „październik 2026” z RRRR-MM. */
export function nazwaMiesiaca(miesiac: string): string {
  return MIESIAC.format(new Date(`${miesiac}-15T12:00:00Z`));
}

/** Ile zostało do zapłaty z pozycji: kwota minus to, co już zapłacono (dopłata po nowej wersji). */
export function doZaplatyGr(p: PozycjaRozliczeniaTelefonu): number {
  return p.kwotaGr === null ? 0 : Math.max(0, p.kwotaGr - p.zaplaconoGr);
}
