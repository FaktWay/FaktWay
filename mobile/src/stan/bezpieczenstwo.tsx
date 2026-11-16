/**
 * Karta Bezpieczeństwo na prawdziwym koncie (M10c, część 2): zmiana hasła
 * (z kodem z e-maila, gdy serwer go żąda) i klucze dostępu (lista,
 * usunięcie). Konto, nie firma: zapytania z `bezFirmy`. Warunki strony (2FA,
 * limit prób hasła, siła hasła, limit zmian kluczy) sprawdza serwer.
 */
import type { KluczeDostepuOdpowiedz, KodHaslaOdpowiedz, UsuniecieKluczaOdpowiedz, ZmianaHaslaOdpowiedz, ZmianaHaslaZadanie } from '@/lib/api/kontrakt-bezpieczenstwo';
import type { Wynik } from '@/lib/api/rdzen';
import { useKontoFirmy } from '@/stan/dane';
import { oznaczNieaktualne, useOdczyt, type StanOdczytu } from '@/stan/odczyt';

export const SCIEZKA_KLUCZY = 'ustawienia/klucze';

export function useKluczeDostepu(): StanOdczytu<KluczeDostepuOdpowiedz> | null {
  return useOdczyt<KluczeDostepuOdpowiedz>(SCIEZKA_KLUCZY);
}

export type ZapisBezpieczenstwa = {
  zmienHaslo: (dane: ZmianaHaslaZadanie) => Promise<Wynik<ZmianaHaslaOdpowiedz>>;
  wyslijKod: (obecne: string) => Promise<Wynik<KodHaslaOdpowiedz>>;
  usunKlucz: (id: string) => Promise<Wynik<UsuniecieKluczaOdpowiedz>>;
};

export function useZapisBezpieczenstwa(): ZapisBezpieczenstwa | null {
  const k = useKontoFirmy();
  if (!k) return null;
  const konto = k.konto?.konto.id;
  return {
    zmienHaslo: (dane) => k.zapytaj<ZmianaHaslaOdpowiedz>('ustawienia/haslo', { metoda: 'POST', cialo: dane, bezFirmy: true }),
    wyslijKod: (obecne) => k.zapytaj<KodHaslaOdpowiedz>('ustawienia/haslo/kod', { metoda: 'POST', cialo: { obecne }, bezFirmy: true }),
    usunKlucz: async (id) => {
      const w = await k.zapytaj<UsuniecieKluczaOdpowiedz>(`${SCIEZKA_KLUCZY}/${id}/usuniecie`, { metoda: 'POST', bezFirmy: true });
      // Lista pobiera się od nowa (klucz zniknął także, gdy ponowienie dało 404).
      const firma = k.firma?.id;
      if (konto && firma && (w.ok || (!w.ok && w.blad.kod === 'not_found'))) oznaczNieaktualne(konto, firma, (s) => s === SCIEZKA_KLUCZY);
      return w;
    },
  };
}
