/**
 * Kontrahenci na prawdziwym koncie (M10e): lista i karta z
 * `GET /api/mobile/v1/kontrahenci` (magazyn `stan/odczyt.tsx`), dodanie,
 * poprawka i usunięcie przez API. Zasady (NIP z sumą kontrolną, granice pól,
 * rola) sprawdza serwer tą samą logiką co strona; telefon pokazuje jego
 * zdanie, przy złym polu pod tym polem (`blad.pole`).
 *
 * Zapis idzie do firmy, w której otwarto ekran (`firmaEkranu`, jak zapisy M8
 * i M10a). Po zapisie lista tej firmy pobiera się od nowa, a karta dostaje
 * kontrahenta prosto z odpowiedzi.
 */
import type { Wynik } from '@/lib/api/rdzen';
import type {
  DaneKontrahentaZadanie,
  KontrahenciOdpowiedz,
  KontrahentOdpowiedz,
  NowyKontrahentOdpowiedz,
  NowyKontrahentZadanie,
  UsuniecieKontrahentaOdpowiedz,
  ZmianaKontrahentaOdpowiedz,
} from '@/lib/api/kontrakt-wiecej';
import { useKontoFirmy } from '@/stan/dane';
import { oznaczNieaktualne, useOdczyt, wpiszOdczyt, type StanOdczytu } from '@/stan/odczyt';

export const SCIEZKA_KONTRAHENTOW = 'kontrahenci';

/** Lista kontrahentów z wyszukiwaniami, bez kart pojedynczych kontrahentów. */
const listaKontrahentow = (sciezka: string) => sciezka === SCIEZKA_KONTRAHENTOW || sciezka.startsWith(`${SCIEZKA_KONTRAHENTOW}?`);

/** Lista firmy; `fraza` szuka w bazie po nazwie i NIP (jak strona), `null` w trakcie pisania. */
export function useKontrahenci(fraza: string | null): StanOdczytu<KontrahenciOdpowiedz> | null {
  const sciezka = fraza === null ? null : fraza ? `${SCIEZKA_KONTRAHENTOW}?q=${encodeURIComponent(fraza)}` : SCIEZKA_KONTRAHENTOW;
  return useOdczyt<KontrahenciOdpowiedz>(sciezka);
}

export function useKontrahent(id: string | undefined): StanOdczytu<KontrahentOdpowiedz> | null {
  return useOdczyt<KontrahentOdpowiedz>(id ? `${SCIEZKA_KONTRAHENTOW}/${id}` : null);
}

export type ZapisKontrahenta = {
  dodaj: (dane: NowyKontrahentZadanie, firmaEkranu: string | null) => Promise<Wynik<NowyKontrahentOdpowiedz>>;
  zmien: (id: string, dane: DaneKontrahentaZadanie, firmaEkranu: string | null) => Promise<Wynik<ZmianaKontrahentaOdpowiedz>>;
  usun: (id: string, firmaEkranu: string | null) => Promise<Wynik<UsuniecieKontrahentaOdpowiedz>>;
  /** Kontrahent zapisany pod tym NIP (po odmowie `contractor_exists`): szukanie w bazie jak lista; `null`, gdy nie ma. */
  znajdzPoNip: (nip: string, firmaEkranu: string | null) => Promise<string | null>;
};

export function useZapisKontrahenta(): ZapisKontrahenta | null {
  const k = useKontoFirmy();
  if (!k) return null;
  const konto = k.konto?.konto.id;

  /** Lista firmy od nowa; karta z kontrahentem z odpowiedzi (należności liczy serwer). */
  const poZapisie = (firma: string | null, id: string, karta?: KontrahentOdpowiedz) => {
    if (!konto || !firma) return;
    if (karta) wpiszOdczyt(konto, firma, `${SCIEZKA_KONTRAHENTOW}/${id}`, karta);
    oznaczNieaktualne(konto, firma, listaKontrahentow);
  };

  return {
    dodaj: async (dane, firmaEkranu) => {
      const w = await k.zapytaj<NowyKontrahentOdpowiedz>(SCIEZKA_KONTRAHENTOW, { metoda: 'POST', cialo: dane, firmaEkranu });
      if (w.ok) poZapisie(firmaEkranu, w.dane.kontrahent.id, { kontrahent: w.dane.kontrahent, bladNaleznosci: null, mozeEdytowac: true });
      return w;
    },
    zmien: async (id, dane, firmaEkranu) => {
      const w = await k.zapytaj<ZmianaKontrahentaOdpowiedz>(`${SCIEZKA_KONTRAHENTOW}/${id}`, { metoda: 'POST', cialo: dane, firmaEkranu });
      if (w.ok) poZapisie(firmaEkranu, id, { kontrahent: w.dane.kontrahent, bladNaleznosci: null, mozeEdytowac: true });
      return w;
    },
    usun: async (id, firmaEkranu) => {
      const w = await k.zapytaj<UsuniecieKontrahentaOdpowiedz>(`${SCIEZKA_KONTRAHENTOW}/${id}/usuniecie`, { metoda: 'POST', firmaEkranu });
      // Ponowienie po zerwanym połączeniu: kontrahenta już nie ma, czyli usunięcie się udało.
      const wynik: Wynik<UsuniecieKontrahentaOdpowiedz> = !w.ok && w.blad.kod === 'not_found' ? { ok: true, dane: { usuniety: true }, status: 200 } : w;
      // Tylko lista: karta zamyka się w animacji i pytałaby w tle o usuniętego (404).
      if (wynik.ok && konto && firmaEkranu) oznaczNieaktualne(konto, firmaEkranu, listaKontrahentow);
      return wynik;
    },
    znajdzPoNip: async (nip, firmaEkranu) => {
      const cyfry = nip.replace(/\D/g, '');
      if (!cyfry) return null;
      const w = await k.zapytaj<KontrahenciOdpowiedz>(`${SCIEZKA_KONTRAHENTOW}?q=${cyfry}`, { firmaEkranu });
      return w.ok ? (w.dane.lista.find((x) => x.nip.replace(/\D/g, '') === cyfry)?.id ?? null) : null;
    },
  };
}

/** Należności z API są w złotych; model telefonu i `kwota()` liczą w groszach. */
export { grosze } from '@/lib/dane/mapowanie';
