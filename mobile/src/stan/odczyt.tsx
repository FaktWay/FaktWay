/**
 * Odczyty z API dla ekranów Więcej (M10e): kontrahenci, import danych i karty
 * Księgowa, Zespół, Abonament, Dziennik. Jeden magazyn na konto, firmę i
 * ścieżkę (wzór `stan/ustawienia.tsx`): lista i szczegół otwarte razem pytają
 * raz i widzą tę samą odpowiedź; po zapisie ekran oznacza odczyt jako
 * nieaktualny (`oznaczNieaktualne`) i magazyn pyta od nowa, pokazując do tego
 * czasu poprzednie dane.
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

type Wpis = { stan: StanOdczytu<unknown>['stan']; dane?: unknown; blad?: string; nieaktualne?: boolean };

const wpisy = new Map<string, Wpis>();
const sluchacze = new Set<() => void>();
const LADOWANIE: Wpis = { stan: 'ladowanie' };
/** Klucze, dla których zapytanie już idzie. */
const wToku = new Set<string>();

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

function kluczOdczytu(konto: string, firma: string, sciezka: string): string {
  return `${konto}:${firma}:${sciezka}`;
}

/**
 * Po zapisie: odczyty tej firmy, których ścieżka spełnia `ktore` (np. lista
 * kontrahentów z wyszukiwaniami), pobiorą się od nowa przy najbliższym rysowaniu.
 */
export function oznaczNieaktualne(konto: string, firma: string, ktore: (sciezka: string) => boolean): void {
  const poczatek = kluczOdczytu(konto, firma, '');
  let zmiana = false;
  for (const [klucz, wpis] of wpisy) {
    if (klucz.startsWith(poczatek) && ktore(klucz.slice(poczatek.length)) && !wpis.nieaktualne) {
      wpisy.set(klucz, { ...wpis, nieaktualne: true });
      zmiana = true;
    }
  }
  if (zmiana) for (const s of sluchacze) s();
}

/** Wynik zapisu od razu w odczycie (np. kontrahent po poprawce), bez czekania na drugie pytanie. */
export function wpiszOdczyt<T>(konto: string, firma: string, sciezka: string, dane: T): void {
  ustaw(kluczOdczytu(konto, firma, sciezka), { stan: 'gotowe', dane });
}

/**
 * `GET /api/mobile/v1/{sciezka}` w wybranej firmie. `sciezka: null`: jeszcze
 * nie pytamy (np. fraza wyszukiwania w trakcie pisania). Błąd przy starych
 * danych zostawia dane i dopisuje zdanie (`blad`), bez szkieletu.
 */
export function useOdczyt<T>(sciezka: string | null): StanOdczytu<T> | null {
  const k = useKontoFirmy();
  const firma = k?.firma?.id;
  const klucz = k?.konto && firma && sciezka !== null ? kluczOdczytu(k.konto.konto.id, firma, sciezka) : undefined;
  const wpis = useSyncExternalStore(subskrybuj, () => (klucz ? (wpisy.get(klucz) ?? LADOWANIE) : LADOWANIE));

  const pobierz = async (kl: string, sc: string) => {
    if (!k || wToku.has(kl)) return;
    wToku.add(kl);
    try {
      const w = await k.zapytaj<T>(sc);
      const byl = wpisy.get(kl);
      if (w.ok) ustaw(kl, { stan: 'gotowe', dane: w.dane });
      else ustaw(kl, { stan: byl?.dane ? 'gotowe' : 'blad', dane: byl?.dane, blad: w.blad.komunikat });
    } finally {
      wToku.delete(kl);
    }
  };
  const pobierzTeraz = useEffectEvent((kl: string, sc: string) => pobierz(kl, sc));
  const nieaktualne = Boolean(wpis.nieaktualne);
  useEffect(() => {
    if (!klucz || sciezka === null) return;
    // Pierwsze otwarcie, nieaktualne po zapisie albo powrót do odczytu z błędem.
    if (wpisy.get(klucz)?.stan === 'gotowe' && !wpisy.get(klucz)?.nieaktualne) return;
    void pobierzTeraz(klucz, sciezka);
  }, [klucz, sciezka, nieaktualne]);

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
