import * as Haptics from 'expo-haptics';
import { useRef, useState } from 'react';
import { StyleSheet } from 'react-native';

import { PoleDaty, PoleTekstowe, PoleWyboru } from '@/komponenty/formularz';
import { Sekcja, Wiersz } from '@/komponenty/lista';
import { Tekst } from '@/komponenty/tekst';
import type { ZaplataRozliczeniaOdpowiedz } from '@/lib/api/kontrakt';
import type { ZaplataRecznaOdpowiedz, ZaplataRecznaZadanie } from '@/lib/api/kontrakt-ksiegowosc';
import { miesiaceWstecz } from '@/lib/miesiace';
import type { KontoFirmy } from '@/stan/dane';
import { nazwaMiesiaca, type TenMiesiacTelefonu } from '@/stan/ksiegowosc';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

type Rodzaj = ZaplataRecznaZadanie['rodzaj'];

const RODZAJE: { wartosc: Rodzaj; etykieta: string }[] = [
  { wartosc: 'zus_spoleczne', etykieta: 'Składki społeczne' },
  { wartosc: 'zdrowotna', etykieta: 'Składka zdrowotna' },
];

/**
 * „Zapłaty spoza wyliczenia” w „Ten miesiąc” (M10d, jak `ZaplatySpozaWyliczenia`
 * strony): składki za okres, którego FaktWay nie liczy, z kwotą z PUE ZUS. Lista i
 * zdania z serwera; zapis `POST /ksiegowosc/zaplaty-reczne` tą samą funkcją co
 * strona, data zapłaty przy wierszu przez `POST /ksiegowosc/rozliczenia/{id}/zaplata`.
 * Zasady pól sprawdza serwer schematem strony; zdanie odmowy idzie pod pole.
 */
export function ZaplatySpozaWyliczenia({
  konto,
  d,
  firmaEkranu,
  poZapisie,
}: {
  konto: KontoFirmy;
  d: TenMiesiacTelefonu;
  firmaEkranu: string | null;
  poZapisie: () => void;
}) {
  const f = d.zaplataReczna;
  const [otwarty, setOtwarty] = useState(false);
  const [rodzaj, setRodzaj] = useState<Rodzaj>('zus_spoleczne');
  const [zaMiesiac, setZaMiesiac] = useState(f?.domyslnyMiesiac ?? '');
  const [kwota, setKwota] = useState('');
  const [bezFp, setBezFp] = useState('');
  const [dataZaplaty, setDataZaplaty] = useState(f?.domyslnaData ?? d.dzis);
  const [bledy, setBledy] = useState<Record<string, string>>({});
  const [blad, setBlad] = useState<string>();
  const [wybrana, setWybrana] = useState<string>();
  const [dzienWiersza, setDzienWiersza] = useState(d.dzis);
  const [trwa, setTrwa] = useState(false);
  const wToku = useRef(false);

  if (!f && d.zaplatyReczne.length === 0) return null;

  const zapisz = async (sciezka: string, cialo: unknown, poSukcesie: () => void) => {
    if (wToku.current) return;
    wToku.current = true;
    setTrwa(true);
    setBlad(undefined);
    setBledy({});
    const w = await konto.zapytaj<ZaplataRecznaOdpowiedz | ZaplataRozliczeniaOdpowiedz>(sciezka, { metoda: 'POST', cialo, firmaEkranu });
    wToku.current = false;
    setTrwa(false);
    if (!w.ok) {
      if (w.blad.pole) setBledy({ [w.blad.pole]: w.blad.komunikat });
      else setBlad(w.blad.komunikat);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      // Zerwane połączenie mogło zapisać: lista od nowa, zanim klient dotknie jeszcze raz.
      if (w.blad.rodzaj !== 'odmowa') poZapisie();
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    poSukcesie();
    poZapisie();
  };

  const dodaj = () => {
    const cialo: ZaplataRecznaZadanie = { zaMiesiac, rodzaj, kwota: kwota.trim(), bezFp: rodzaj === 'zus_spoleczne' ? bezFp.trim() : '', dataZaplaty };
    void zapisz('ksiegowosc/zaplaty-reczne', cialo, () => {
      setOtwarty(false);
      setKwota('');
      setBezFp('');
    });
  };

  const miesiace = f ? miesiaceWstecz(f.od, f.doMiesiaca) : [];

  return (
    <Sekcja
      naglowek="Zapłaty spoza wyliczenia"
      stopka={
        f
          ? 'Składki za okres, którego FaktWay nie liczy (np. za grudzień 2025 r. albo niepełny miesiąc), zapisuje się tutaj z kwotą z PUE ZUS. Zapisana zapłata pomniejsza podatek tak samo jak składki z wyliczenia oznaczone jako zapłacone.'
          : 'Zapłaty zapisuje właściciel albo administrator firmy.'
      }
    >
      {d.zaplatyReczne.flatMap((z) => {
        const rozwiniety = f && wybrana === z.id;
        const wiersz = (
          <Wiersz
            key={z.id}
            tytul={z.tytul}
            podtytul={z.szczegoly}
            ikona={z.zaplacone ? 'checkbox-circle-fill' : 'time-line'}
            ikonaKolor={z.zaplacone ? 'sukces' : 'ostrzezenie'}
            onPress={f ? () => setWybrana(rozwiniety ? undefined : z.id) : undefined}
            etykietaDostepnosci={`${z.opis}${f ? ` Dotknij, żeby ${z.zaplacone ? 'cofnąć zapłatę' : 'ustawić datę zapłaty'}.` : ''}`}
          />
        );
        if (!rozwiniety) return [wiersz];
        return z.zaplacone
          ? [
              wiersz,
              <Wiersz key={`${z.id}-cofnij`} tytul="Cofnij zapłatę" ikona="arrow-go-back-line" niszczacy akcja onPress={trwa ? undefined : () => void zapisz(`ksiegowosc/rozliczenia/${z.id}/zaplata`, { zaplacone: false, dzien: null }, () => setWybrana(undefined))} />,
            ]
          : [
              wiersz,
              <PoleDaty key={`${z.id}-dzien`} etykieta="Data zapłaty" wartosc={dzienWiersza} onZmiana={setDzienWiersza} najwczesniej={z.najwczesniej} />,
              <Wiersz key={`${z.id}-zapisz`} tytul="Oznacz jako zapłacone" ikona="checkbox-circle-fill" akcja onPress={trwa ? undefined : () => void zapisz(`ksiegowosc/rozliczenia/${z.id}/zaplata`, { zaplacone: true, dzien: dzienWiersza }, () => setWybrana(undefined))} />,
            ];
      })}

      {f && otwarty ? (
        <>
          <PoleWyboru etykieta="Rodzaj składek" wartosc={rodzaj} opcje={RODZAJE} onZmiana={setRodzaj} />
          <PoleWyboru etykieta="Za miesiąc" wartosc={zaMiesiac} opcje={miesiace.map((m) => ({ wartosc: m, etykieta: nazwaMiesiaca(m) }))} onZmiana={setZaMiesiac} />
          {bledy.zaMiesiac ? <Tekst styl="footnote" kolor="blad" style={styles.blad}>{bledy.zaMiesiac}</Tekst> : null}
          <PoleTekstowe etykieta="Zapłacona kwota (z PUE ZUS)" wartosc={kwota} onZmiana={setKwota} podpowiedz="zł" klawiatura="decimal-pad" blad={bledy.kwota} />
          {rodzaj === 'zus_spoleczne' ? (
            <PoleTekstowe etykieta="W tym bez Funduszu Pracy i FS (z DRA)" wartosc={bezFp} onZmiana={setBezFp} podpowiedz="zł" klawiatura="decimal-pad" blad={bledy.bezFp} />
          ) : null}
          <PoleDaty etykieta="Data zapłaty" wartosc={dataZaplaty} onZmiana={setDataZaplaty} najwczesniej={`${zaMiesiac}-01`} />
          {bledy.dataZaplaty ? <Tekst styl="footnote" kolor="blad" style={styles.blad}>{bledy.dataZaplaty}</Tekst> : null}
          <Wiersz tytul={trwa ? 'Zapisujemy' : 'Zapisz zapłatę'} ikona="checkbox-circle-fill" akcja onPress={trwa ? undefined : dodaj} />
        </>
      ) : f ? (
        // Pola dopiero po dotknięciu, żeby ekran przeglądu nie był formularzem (WZORCE-MOBBIN.md 5.3).
        <Wiersz tytul="Dodaj zapłatę" ikona="add-line" akcja onPress={() => setOtwarty(true)} />
      ) : null}
      {blad ? <Tekst styl="footnote" kolor="blad" style={styles.blad}>{blad}</Tekst> : null}
    </Sekcja>
  );
}

const styles = StyleSheet.create({
  blad: { marginHorizontal: MARGINES, marginBottom: ODSTEP.s },
});
