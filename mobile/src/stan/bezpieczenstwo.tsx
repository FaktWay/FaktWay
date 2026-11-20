/**
 * Karta Bezpieczeństwo na prawdziwym koncie (M10c, część 2): zmiana hasła
 * (z kodem z e-maila, gdy serwer go żąda) i klucze dostępu (lista,
 * usunięcie); część 2b: włączenie i wyłączenie 2FA (TOTP) i wgranie
 * certyfikatu KSeF. Konto, nie firma: zapytania z `bezFirmy` (certyfikat
 * idzie do firmy z otwarcia ekranu). Warunki strony (2FA, limity prób, siła
 * hasła, limit zmian kluczy, rola) sprawdza serwer.
 */
import type {
  CertyfikatKsefOdpowiedz,
  CertyfikatKsefZadanie,
  KluczeDostepuOdpowiedz,
  KodHaslaOdpowiedz,
  Potwierdzenie2faOdpowiedz,
  UsuniecieKluczaOdpowiedz,
  Wlaczenie2faOdpowiedz,
  Wylaczenie2faOdpowiedz,
  ZmianaHaslaOdpowiedz,
  ZmianaHaslaZadanie,
} from '@/lib/api/kontrakt-bezpieczenstwo';
import type { Wynik } from '@/lib/api/rdzen';
import { supabase } from '@/lib/supabase';
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
  startDwaEtapy: () => Promise<Wynik<Wlaczenie2faOdpowiedz>>;
  potwierdzDwaEtapy: (idFaktora: string, kod: string) => Promise<Wynik<Potwierdzenie2faOdpowiedz>>;
  wylaczDwaEtapy: (haslo: string) => Promise<Wynik<Wylaczenie2faOdpowiedz>>;
  wgrajCertyfikat: (dane: CertyfikatKsefZadanie, firmaEkranu: string | null) => Promise<Wynik<CertyfikatKsefOdpowiedz>>;
};

/** Certyfikat idzie dłużej niż zwykłe 15 s: serwer loguje się do KSeF (do 2 minut, jak wgranie zdjęcia). */
const LIMIT_CERTYFIKATU_MS = 90 * 1000;

export function useZapisBezpieczenstwa(): ZapisBezpieczenstwa | null {
  const k = useKontoFirmy();
  if (!k) return null;
  const konto = k.konto?.konto.id;
  /**
   * Po włączeniu i wyłączeniu 2FA sesja serwera zmieniła poziom (AAL2, AAL1), a token telefonu jeszcze
   * go nie ma: odświeżenie daje token z nowym poziomem, a stan konta pokazuje wynik. Nieudane odświeżenie
   * nic nie psuje: telefon zapyta o kod albo wejdzie dalej, jak po zwykłym wygaśnięciu tokenu.
   */
  const poZmianie2fa = async () => {
    await supabase?.auth.refreshSession().catch(() => undefined);
    await k.odswiezKonto();
  };
  return {
    startDwaEtapy: () => k.zapytaj<Wlaczenie2faOdpowiedz>('ustawienia/2fa/start', { metoda: 'POST', bezFirmy: true }),
    potwierdzDwaEtapy: async (idFaktora, kod) => {
      const w = await k.zapytaj<Potwierdzenie2faOdpowiedz>('ustawienia/2fa/potwierdzenie', { metoda: 'POST', cialo: { idFaktora, kod }, bezFirmy: true });
      if (w.ok) await poZmianie2fa();
      return w;
    },
    wylaczDwaEtapy: async (haslo) => {
      const w = await k.zapytaj<Wylaczenie2faOdpowiedz>('ustawienia/2fa/wylaczenie', { metoda: 'POST', cialo: { haslo }, bezFirmy: true });
      if (w.ok) await poZmianie2fa();
      return w;
    },
    wgrajCertyfikat: (dane, firmaEkranu) => k.zapytaj<CertyfikatKsefOdpowiedz>('ustawienia/ksef', { metoda: 'POST', cialo: dane, firmaEkranu, limitMs: LIMIT_CERTYFIKATU_MS }),
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
