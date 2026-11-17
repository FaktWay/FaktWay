/**
 * Zapisy ustawień z telefonu (M10c): karta Firma (dane, rachunek, data
 * rozpoczęcia, zwolnienie z VAT, metoda kasowa), Przypomnienia o zapłacie
 * i e-maile z karty Powiadomienia. Zasady (schematy strony, rola, granice)
 * sprawdza serwer; telefon pokazuje jego zdanie, przy złym polu pod tym polem
 * (`blad.pole`).
 *
 * Zapis idzie do firmy, w której otwarto ekran (`firmaEkranu`, jak zapisy M8
 * i M10e). Firma i Przypomnienia: odpowiedź to karty po zapisie, wpisane do
 * magazynu `stan/ustawienia.tsx`, więc ekran pod arkuszem od razu je widzi.
 * Powiadomienia: konto, nie firma; stan z odpowiedzi do magazynu odczytów.
 */
import { usePreventRemove, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';

import { potwierdz } from '@/komponenty/potwierdz';
import type { UstawieniaOdpowiedz } from '@/lib/api/kontrakt';
import type { PowiadomieniaOdpowiedz, PrzypomnieniaZadanie, ZmianaFirmyZadanie, ZmianaPowiadomienZadanie } from '@/lib/api/kontrakt-ustawienia';
import type { Wynik } from '@/lib/api/rdzen';
import { useKontoFirmy } from '@/stan/dane';
import { useOdczyt, wpiszOdczyt, type StanOdczytu } from '@/stan/odczyt';
import { wpiszUstawienia } from '@/stan/ustawienia';

export const SCIEZKA_POWIADOMIEN = 'ustawienia/powiadomienia';

export type ZapisUstawien = {
  firma: (zmiana: ZmianaFirmyZadanie, firmaEkranu: string | null) => Promise<Wynik<UstawieniaOdpowiedz>>;
  przypomnienia: (dane: PrzypomnieniaZadanie, firmaEkranu: string | null) => Promise<Wynik<UstawieniaOdpowiedz>>;
  powiadomienie: (zmiana: ZmianaPowiadomienZadanie) => Promise<Wynik<PowiadomieniaOdpowiedz>>;
};

/** `null` na danych przykładowych (bez konta z bazy). */
export function useZapisUstawien(): ZapisUstawien | null {
  const k = useKontoFirmy();
  if (!k) return null;
  const konto = k.konto?.konto.id;
  const zapiszKarty = async (sciezka: string, cialo: unknown, firmaEkranu: string | null) => {
    const w = await k.zapytaj<UstawieniaOdpowiedz>(sciezka, { metoda: 'POST', cialo, firmaEkranu });
    if (w.ok && konto && firmaEkranu) wpiszUstawienia(konto, firmaEkranu, w.dane);
    return w;
  };
  return {
    firma: (zmiana, firmaEkranu) => zapiszKarty('ustawienia/firma', zmiana, firmaEkranu),
    przypomnienia: (dane, firmaEkranu) => zapiszKarty('ustawienia/przypomnienia', dane, firmaEkranu),
    powiadomienie: async (zmiana) => {
      const firma = k.firma?.id;
      const w = await k.zapytaj<PowiadomieniaOdpowiedz>(SCIEZKA_POWIADOMIEN, { metoda: 'POST', cialo: zmiana, bezFirmy: true });
      if (w.ok && konto && firma) wpiszOdczyt(konto, firma, SCIEZKA_POWIADOMIEN, w.dane);
      return w;
    },
  };
}

export function usePowiadomienia(): StanOdczytu<PowiadomieniaOdpowiedz> | null {
  return useOdczyt<PowiadomieniaOdpowiedz>(SCIEZKA_POWIADOMIEN);
}

/**
 * Formularz z niezapisanymi zmianami: cofnięcie (przeciągnięcie, „Anuluj”,
 * przycisk wstecz Androida) pyta „Odrzucić zmiany?” w arkuszu akcji
 * (ZASADY-DESIGNU.md, sekcja 6). `zamknij()` po udanym zapisie zdejmuje
 * pytanie i zamyka ekran dopiero po przerysowaniu (inaczej ochrona z
 * poprzedniego rysowania zatrzymałaby zamknięcie).
 */
export function useOchronaZmian(zmienione: boolean): { zamknij: () => void } {
  const router = useRouter();
  const [bezPytania, setBezPytania] = useState(false);
  const [zamykanie, setZamykanie] = useState(false);
  usePreventRemove(!bezPytania && !zamykanie && zmienione, ({ repeat }) => {
    potwierdz({ tytul: 'Odrzucić zmiany?', potwierdz: 'Odrzuć zmiany', anuluj: 'Wróć do edycji' }, () => {
      setBezPytania(true);
      repeat();
    });
  });
  useEffect(() => {
    if (zamykanie && router.canGoBack()) router.back();
  }, [zamykanie, router]);
  return { zamknij: () => setZamykanie(true) };
}
