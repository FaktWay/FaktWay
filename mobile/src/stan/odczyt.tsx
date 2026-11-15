/**
 * Odczyty z API dla ekranów Więcej (M10e): kontrahenci, import danych i karty
 * Księgowa, Zespół, Abonament, Dziennik. Jeden magazyn na konto, firmę i
 * ścieżkę (wzór `stan/ustawienia.tsx`): lista i szczegół otwarte razem pytają
 * raz i widzą tę samą odpowiedź.
 *
 * Każde otwarcie ekranu pyta serwer od nowa, a do odpowiedzi pokazuje dane z
 * poprzedniego pytania (stan importu, dziennik i zmiany ze strony nie stoją
 * przez całą sesję). Po zapisie ekran oznacza odczyty jako nieaktualne
 * (`oznaczNieaktualne`): magazyn pyta jeszcze raz, a odpowiedź na pytanie
 * wysłane przed zapisem odrzuca (`wersja`), żeby nowy kontrahent nie zniknął
 * z listy.
 *
 * Na danych przykładowych `useOdczyt` zwraca `null`: ekran pokazuje wtedy swoją
 * wersję przykładową. Czyszczenie przy końcu sesji: `stan/czyszczenie.ts`.
 */
import { useEffect, useEffectEvent, useSyncExternalStore } from 'react';

import { czyscPrzyKoncuSesji } from '@/stan/czyszczenie';
import { useKontoFirmy } from '@/stan/dane';

export type StanOdczytu<T> = {
  stan: 'ladowanie' | 'gotowe' | 'blad';
  dane?: T;
  /** Zdanie dla klienta, gdy ostatnie pytanie się nie udało (przy starych danych też). */
  blad?: string;
  odswiez: () => Promise<void>;
};

/** `wersja` rośnie przy każdym `oznaczNieaktualne`: odpowiedź z wcześniejszej wersji jest nieaktualna. */
type Wpis = { stan: StanOdczytu<unknown>['stan']; dane?: unknown; blad?: string; wersja: number };

const wpisy = new Map<string, Wpis>();
const sluchacze = new Set<() => void>();
const LADOWANIE: Wpis = { stan: 'ladowanie', wersja: 0 };
/** Klucze, dla których zapytanie już idzie. */
const wToku = new Set<string>();
/** Rośnie przy końcu sesji: odpowiedź na pytanie poprzedniego konta niczego nie zapisze. */
let epoka = 0;

function ustaw(klucz: string, wpis: Wpis): void {
  wpisy.set(klucz, wpis);
  for (const s of sluchacze) s();
}

function subskrybuj(sluchacz: () => void): () => void {
  sluchacze.add(sluchacz);
  return () => sluchacze.delete(sluchacz);
}

czyscPrzyKoncuSesji(() => {
  epoka += 1;
  wpisy.clear();
  wToku.clear();
  for (const s of sluchacze) s();
});

function kluczOdczytu(konto: string, firma: string, sciezka: string): string {
  return `${konto}:${firma}:${sciezka}`;
}

/**
 * Po zapisie: odczyty tej firmy, których ścieżka spełnia `ktore` (np. lista
 * kontrahentów z wyszukiwaniami), pobiorą się od nowa.
 */
export function oznaczNieaktualne(konto: string, firma: string, ktore: (sciezka: string) => boolean): void {
  const poczatek = kluczOdczytu(konto, firma, '');
  let zmiana = false;
  for (const [klucz, wpis] of wpisy) {
    if (klucz.startsWith(poczatek) && ktore(klucz.slice(poczatek.length))) {
      wpisy.set(klucz, { ...wpis, wersja: wpis.wersja + 1 });
      zmiana = true;
    }
  }
  if (zmiana) for (const s of sluchacze) s();
}

/** Wynik zapisu od razu w odczycie (np. kontrahent po poprawce), bez czekania na drugie pytanie. */
export function wpiszOdczyt<T>(konto: string, firma: string, sciezka: string, dane: T): void {
  const klucz = kluczOdczytu(konto, firma, sciezka);
  ustaw(klucz, { stan: 'gotowe', dane, wersja: (wpisy.get(klucz)?.wersja ?? 0) + 1 });
}

/**
 * `GET /api/mobile/v1/{sciezka}` w wybranej firmie. `sciezka: null`: jeszcze
 * nie pytamy. Błąd przy starych danych zostawia dane i dopisuje zdanie
 * (`blad`), bez szkieletu.
 */
export function useOdczyt<T>(sciezka: string | null): StanOdczytu<T> | null {
  const k = useKontoFirmy();
  const firma = k?.firma?.id;
  const klucz = k?.konto && firma && sciezka !== null ? kluczOdczytu(k.konto.konto.id, firma, sciezka) : undefined;
  const wpis = useSyncExternalStore(subskrybuj, () => (klucz ? (wpisy.get(klucz) ?? LADOWANIE) : LADOWANIE));

  const pobierz = async (kl: string, sc: string): Promise<void> => {
    if (!k || wToku.has(kl)) return;
    const start = { epoka, wersja: (wpisy.get(kl) ?? LADOWANIE).wersja };
    wToku.add(kl);
    let jeszczeRaz = false;
    try {
      const w = await k.zapytaj<T>(sc);
      if (start.epoka !== epoka) return;
      const teraz = wpisy.get(kl) ?? LADOWANIE;
      // Zapis w trakcie pytania: odpowiedź jest sprzed zapisu, pytamy jeszcze raz.
      if (teraz.wersja !== start.wersja) {
        jeszczeRaz = true;
        return;
      }
      if (w.ok) ustaw(kl, { stan: 'gotowe', dane: w.dane, wersja: teraz.wersja });
      else ustaw(kl, { stan: teraz.dane !== undefined ? 'gotowe' : 'blad', dane: teraz.dane, blad: w.blad.komunikat, wersja: teraz.wersja });
    } finally {
      if (start.epoka === epoka) wToku.delete(kl);
    }
    if (jeszczeRaz) await pobierz(kl, sc);
  };
  const pobierzTeraz = useEffectEvent((kl: string, sc: string) => pobierz(kl, sc));
  const wersja = wpis.wersja;
  // Każde otwarcie ekranu i każdy zapis (nowa wersja) pyta serwer; do odpowiedzi zostają stare dane.
  useEffect(() => {
    if (!klucz || sciezka === null) return;
    void pobierzTeraz(klucz, sciezka);
  }, [klucz, sciezka, wersja]);

  if (!k) return null;
  return {
    stan: wpis.stan,
    dane: wpis.dane as T | undefined,
    blad: wpis.blad,
    odswiez: async () => {
      if (klucz && sciezka !== null) await pobierz(klucz, sciezka);
    },
  };
}
