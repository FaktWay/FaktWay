/**
 * Dane formularza zaliczki, rozliczenia i korekty na prawdziwym koncie (M8b):
 * kwoty z serwera (`POST /faktury/wyliczenie`, telefon ich nie liczy),
 * faktura pierwotna korekty (`GET /faktury/{id}/korekta`), zaliczki do
 * rozliczenia (`GET /faktury/zaliczki`) i nabywca z GUS (`GET /gus/{nip}`).
 *
 * Wywołania idą przez `useKontoFirmy().zapytaj`: firma z wyboru, reakcje na
 * koniec sesji, kod 2FA i utratę firmy jak przy innych zapisach. Formularz
 * trzyma firmę z otwarcia (`firmaEkranu`), więc zmiana firmy w trakcie to
 * odmowa bez żądania.
 */
import { useEffect, useState } from 'react';

import type {
  GusOdpowiedz,
  KontekstKorektyOdpowiedz,
  WyliczenieOdpowiedz,
  WyliczenieZadanie,
  ZaliczkaDoRozliczenia,
  ZaliczkiOdpowiedz,
} from '@/lib/api/kontrakt';
import { bezDlugichMyslnikow } from '@/lib/api/bledy';
import { kluczWyliczenia } from '@/lib/faktura/rodzaje';
import { useKontoFirmy, type KontoFirmy } from '@/stan/dane';

/** Po tylu ms bez zmian w polach serwer liczy kwoty (pisanie nie wysyła żądania po każdej literze). */
const ZWLOKA_WYLICZENIA_MS = 450;

export type StanWyliczenia =
  /** Brak treści do policzenia (np. nie wybrano faktury pierwotnej albo pole z kwotą jest puste). */
  | { stan: 'czeka' }
  /** Serwer liczy; `kwoty` z poprzedniego wyliczenia, póki nie ma nowych. */
  | { stan: 'liczymy'; kwoty?: WyliczenieOdpowiedz }
  | { stan: 'gotowe'; kwoty: WyliczenieOdpowiedz }
  /** Dane jeszcze się nie zgadzają (zdanie strony z polem) albo brak połączenia. */
  | { stan: 'blad'; komunikat: string; pole?: string };

type Wpis = { klucz: string; wynik: StanWyliczenia };

/**
 * Kwoty dokumentu z serwera dla bieżących pól. Każda zmiana pól liczy się od
 * nowa po chwili; odpowiedź do starych pól nie nadpisze nowych. Treść z pustym
 * albo błędnym polem liczbowym nie idzie do serwera (stan „czeka”): serwer
 * odrzuciłby ją jako błąd kontraktu, a ekran pokazałby fałszywą awarię (U7).
 */
export function useWyliczenie(tresc: WyliczenieZadanie | null, firmaEkranu: string | null): StanWyliczenia {
  const konto = useKontoFirmy();
  const klucz = kluczWyliczenia(tresc);
  const [wpis, setWpis] = useState<Wpis | null>(null);
  const [ostatnie, setOstatnie] = useState<WyliczenieOdpowiedz | undefined>(undefined);

  useEffect(() => {
    if (!klucz || !konto) return;
    let biezace = true;
    const czas = setTimeout(() => {
      void konto.zapytaj<WyliczenieOdpowiedz>('faktury/wyliczenie', { metoda: 'POST', cialo: JSON.parse(klucz) as unknown, firmaEkranu }).then((w) => {
        if (!biezace) return;
        if (w.ok) {
          setOstatnie(w.dane);
          setWpis({ klucz, wynik: { stan: 'gotowe', kwoty: w.dane } });
        } else {
          setWpis({ klucz, wynik: { stan: 'blad', komunikat: bezDlugichMyslnikow(w.blad.komunikat), ...(w.blad.pole ? { pole: w.blad.pole } : {}) } });
        }
      });
    }, ZWLOKA_WYLICZENIA_MS);
    return () => {
      biezace = false;
      clearTimeout(czas);
    };
    // `konto` zmienia się przy każdym rysowaniu dostawcy; liczymy od nowa tylko po zmianie pól albo firmy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [klucz, firmaEkranu]);

  // Pole wyczyszczone: kwoty sprzed czyszczenia nie wrócą jako „poprzednie” przy dalszym wpisywaniu.
  if (!klucz && ostatnie) setOstatnie(undefined);
  if (!klucz) return { stan: 'czeka' };
  if (wpis?.klucz === klucz) return wpis.wynik;
  return { stan: 'liczymy', ...(ostatnie ? { kwoty: ostatnie } : {}) };
}

export type StanKontekstuKorekty =
  | { stan: 'brak' }
  | { stan: 'ladowanie' }
  | { stan: 'gotowe'; kontekst: KontekstKorektyOdpowiedz }
  | { stan: 'blad'; komunikat: string };

/** Faktura pierwotna korekty z serwera (stan po przyjętych korektach), raz na wybraną fakturę. */
export function useKontekstKorekty(idFaktury: string | undefined, firmaEkranu: string | null): StanKontekstuKorekty {
  const konto = useKontoFirmy();
  const [wpis, setWpis] = useState<{ id: string; wynik: StanKontekstuKorekty } | null>(null);

  useEffect(() => {
    if (!idFaktury || !konto) return;
    let biezace = true;
    void konto.zapytaj<KontekstKorektyOdpowiedz>(`faktury/${encodeURIComponent(idFaktury)}/korekta`, { firmaEkranu }).then((w) => {
      if (!biezace) return;
      setWpis({ id: idFaktury, wynik: w.ok ? { stan: 'gotowe', kontekst: w.dane } : { stan: 'blad', komunikat: bezDlugichMyslnikow(w.blad.komunikat) } });
    });
    return () => {
      biezace = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idFaktury, firmaEkranu]);

  if (!idFaktury) return { stan: 'brak' };
  return wpis?.id === idFaktury ? wpis.wynik : { stan: 'ladowanie' };
}

export type StanZaliczek =
  | { stan: 'ladowanie' }
  | { stan: 'gotowe'; zaliczki: ZaliczkaDoRozliczenia[] }
  | { stan: 'blad'; komunikat: string; ponow: () => void };

/** Zaliczki przyjęte w KSeF i jeszcze nierozliczone (formularz rozliczenia), raz na otwarcie. */
export function useZaliczkiDoRozliczenia(wlaczone: boolean, firmaEkranu: string | null): StanZaliczek {
  const konto = useKontoFirmy();
  const [proba, setProba] = useState(0);
  const [wynik, setWynik] = useState<{ proba: number; stan: StanZaliczek } | null>(null);

  useEffect(() => {
    if (!wlaczone || !konto) return;
    let biezace = true;
    void konto.zapytaj<ZaliczkiOdpowiedz>('faktury/zaliczki', { firmaEkranu }).then((w) => {
      if (!biezace) return;
      setWynik({
        proba,
        stan: w.ok
          ? { stan: 'gotowe', zaliczki: w.dane.zaliczki }
          : { stan: 'blad', komunikat: bezDlugichMyslnikow(w.blad.komunikat), ponow: () => setProba((p) => p + 1) },
      });
    });
    return () => {
      biezace = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wlaczone, firmaEkranu, proba]);

  return wynik?.proba === proba ? wynik.stan : { stan: 'ladowanie' };
}

export type WynikGus = { ok: true; nabywca: GusOdpowiedz['nabywca']; zrodlo: GusOdpowiedz['zrodlo'] } | { ok: false; komunikat: string };

/** Nazwa i adres nabywcy po NIP (kontrahenci firmy, potem GUS), jak „Pobierz z GUS” na stronie. */
export async function szukajWGus(konto: KontoFirmy | null, nip: string, firmaEkranu: string | null): Promise<WynikGus> {
  if (!konto) return { ok: false, komunikat: 'Dane z GUS pobierzesz po zalogowaniu do firmy.' };
  const w = await konto.zapytaj<GusOdpowiedz>(`gus/${encodeURIComponent(nip.replace(/\D/g, ''))}`, { firmaEkranu });
  if (w.ok) return { ok: true, nabywca: w.dane.nabywca, zrodlo: w.dane.zrodlo };
  // 503: GUS nie odpowiada (serwer mówi to samo zdaniem strony, ale klient API daje przy 503 zdanie ogólne).
  if (w.blad.kod === 'service_unavailable') return { ok: false, komunikat: 'GUS chwilowo nie odpowiada. Spróbuj ponownie za chwilę albo wpisz dane ręcznie.' };
  return { ok: false, komunikat: bezDlugichMyslnikow(w.blad.komunikat) };
}
