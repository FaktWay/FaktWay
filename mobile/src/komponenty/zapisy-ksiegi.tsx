import * as Haptics from 'expo-haptics';
import { useRef, useState } from 'react';
import { StyleSheet } from 'react-native';

import { PoleDaty, PoleTekstowe, PoleWyboru } from '@/komponenty/formularz';
import { Sekcja, Wiersz } from '@/komponenty/lista';
import { potwierdz } from '@/komponenty/potwierdz';
import { Tekst } from '@/komponenty/tekst';
import type { KsiegaTelefonuOdpowiedz, SpisZadanie, UsuniecieKsiegiOdpowiedz, WpisKsiegiZadanie, ZapisKsiegiOdpowiedz } from '@/lib/api/kontrakt-ksiegi';
import type { KontoFirmy } from '@/stan/dane';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

type Props = {
  konto: KontoFirmy;
  d: KsiegaTelefonuOdpowiedz;
  /** Firma, w której otwarto ekran: zapis dla innej firmy telefon odrzuca bez żądania. */
  firmaEkranu: string | null;
  /** Odświeża księgę po zapisie i po błędzie połączenia (zapis mógł dojść do serwera). */
  poZapisie: () => void;
};

type Zapytanie = (sciezka: string, cialo: unknown, poSukcesie: () => void, odswiezPoOdmowie?: boolean) => Promise<void>;

/**
 * Wspólny zapis: jedno żądanie naraz (ref, nie stan), zdanie serwera pod polem albo pod formularzem,
 * lista od nowa po sukcesie i po błędzie połączenia. Wyjątek z `zapytaj` nie blokuje przycisku.
 */
function useZapis({ konto, firmaEkranu, poZapisie }: Pick<Props, 'konto' | 'firmaEkranu' | 'poZapisie'>) {
  const [trwa, setTrwa] = useState(false);
  const [bledy, setBledy] = useState<Record<string, string>>({});
  const [blad, setBlad] = useState<string>();
  const wToku = useRef(false);
  const zapisz: Zapytanie = async (sciezka, cialo, poSukcesie, odswiezPoOdmowie = false) => {
    if (wToku.current) return;
    wToku.current = true;
    setTrwa(true);
    setBlad(undefined);
    setBledy({});
    try {
      const w = await konto.zapytaj<ZapisKsiegiOdpowiedz | UsuniecieKsiegiOdpowiedz>(sciezka, { metoda: 'POST', cialo, firmaEkranu });
      if (!w.ok) {
        if (w.blad.pole) setBledy({ [w.blad.pole]: w.blad.komunikat });
        else setBlad(w.blad.komunikat);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        // Zerwane połączenie mogło zapisać: lista od nowa, zanim klient dotknie jeszcze raz.
        // Odmowa usunięcia („już nie ma na liście”) też znaczy, że lista jest nieaktualna.
        if (w.blad.rodzaj !== 'odmowa' || odswiezPoOdmowie) poZapisie();
        return;
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      poSukcesie();
      poZapisie();
    } finally {
      wToku.current = false;
      setTrwa(false);
    }
  };
  return { trwa, bledy, blad, zapisz };
}

/**
 * Zapisy ksiąg na prawdziwym koncie (M10d część 3): wpis ręczny w ewidencji ryczałtu i w KPiR (dodanie
 * i usunięcie) oraz spis z natury (KPiR). Tylko właściciel i administrator (`d.formularz`); pozostali
 * widzą listy do odczytu. Opcje i granice z serwera, walidacja schematami strony po stronie serwera
 * (zdanie błędu wraca pod pole). Usunięcie przez arkusz akcji z cofnięciem w postaci „dodaj nowy”.
 */
export function ZapisyKsiegi({ konto, d, firmaEkranu, poZapisie }: Props) {
  const f = d.formularz;
  // Osobny zapis na wpisy i na spisy: błędy pól (`kwota`, `opis`) jednego formularza nie pokazują się pod drugim.
  const wpisy = useZapis({ konto, firmaEkranu, poZapisie });
  const spisy = useZapis({ konto, firmaEkranu, poZapisie });
  const [otwarty, setOtwarty] = useState(false);
  // Jak formularz strony: rodzaj od raportu z kasy, kolumna KPiR pusta (klient wybiera świadomie).
  const [rodzaj, setRodzaj] = useState<'raport_kasy' | 'inny'>('raport_kasy');
  const [data, setData] = useState(f?.domyslnaData ?? d.dzis);
  const [dokument, setDokument] = useState('');
  const [kwotaWpisu, setKwotaWpisu] = useState('');
  const [stawka, setStawka] = useState(f?.domyslnaStawkaPb ? String(f.domyslnaStawkaPb) : '');
  const [kolumna, setKolumna] = useState('');
  const [opis, setOpis] = useState('');
  const [spisOtwarty, setSpisOtwarty] = useState(false);
  const [spisData, setSpisData] = useState(f?.domyslnaDataSpisu ?? d.dzis);
  const [spisKwota, setSpisKwota] = useState('');
  const [spisOpis, setSpisOpis] = useState('');

  const dodajWpis = () => {
    const wspolne = { rodzaj, dataPrzychodu: data, dokument: dokument.trim(), kwota: kwotaWpisu.trim(), opis: opis.trim() || null };
    const cialo: WpisKsiegiZadanie = d.rodzaj === 'kpir' ? { typ: 'kpir', ...wspolne, kolumna } : { typ: 'ewidencja', ...wspolne, stawkaPb: Number(stawka) };
    void wpisy.zapisz('ksiegowosc/ewidencja/wpisy', cialo, () => {
      setOtwarty(false);
      setDokument('');
      setKwotaWpisu('');
      setOpis('');
    });
  };
  const usunWpis = (id: string, tytul: string) =>
    potwierdz({ tytul: `Usunąć wpis ${tytul}?`, opis: 'Poprawka to usunięcie wpisu i dodanie nowego. Usunięcie zapisuje się w dzienniku zmian.', potwierdz: 'Usuń' }, () => void wpisy.zapisz(`ksiegowosc/ewidencja/wpisy/${id}/usuniecie`, undefined, () => undefined, true));
  const dodajSpis = () => {
    const cialo: SpisZadanie = { data: spisData, kwota: spisKwota.trim(), opis: spisOpis.trim() || null };
    void spisy.zapisz('ksiegowosc/ewidencja/spisy', cialo, () => {
      setSpisOtwarty(false);
      setSpisKwota('');
      setSpisOpis('');
    });
  };
  const usunSpis = (id: string, tytul: string) =>
    potwierdz({ tytul: `Usunąć ${tytul.toLowerCase()}?`, opis: 'Poprawka to usunięcie spisu i dodanie nowego.', potwierdz: 'Usuń' }, () => void spisy.zapisz(`ksiegowosc/ewidencja/spisy/${id}/usuniecie`, undefined, () => undefined, true));

  const kpir = d.rodzaj === 'kpir';
  const blokada = (b: Record<string, string>, pole: string) =>
    b[pole] ? (
      <Tekst styl="footnote" kolor="blad" style={styles.nota}>
        {b[pole]}
      </Tekst>
    ) : null;

  return (
    <>
      <Sekcja naglowek="Wpisy ręczne" stopka={f ? 'Przychody bez faktury w KSeF, np. sprzedaż z kasy rejestrującej. Zwrot zapisuje się kwotą ujemną; poprawka to usunięcie wpisu i dodanie nowego.' : 'Wpisy dodaje i usuwa właściciel albo administrator firmy.'}>
        {d.wpisyReczne.length === 0 ? (
          <Wiersz tytul="W tym miesiącu nie ma wpisów ręcznych" />
        ) : (
          d.wpisyReczne.map((w) => (
            <Wiersz
              key={w.id}
              tytul={w.tytul}
              podtytul={w.szczegoly}
              onPress={f && !wpisy.trwa ? () => usunWpis(w.id, w.tytul) : undefined}
              etykietaDostepnosci={`${w.tytul}. ${w.szczegoly}${f ? ' Dotknij, żeby usunąć wpis.' : ''}`}
            />
          ))
        )}
        {f && otwarty ? (
          <>
            <PoleWyboru etykieta="Rodzaj dowodu" wartosc={rodzaj} opcje={f.rodzajeDowodu.map((r) => ({ wartosc: r.wartosc, etykieta: r.nazwa }))} onZmiana={setRodzaj} />
            {blokada(wpisy.bledy, 'rodzaj')}
            <PoleDaty etykieta={kpir ? 'Data zdarzenia' : 'Data przychodu'} wartosc={data} onZmiana={setData} najwczesniej={f.wpisOd} />
            {blokada(wpisy.bledy, 'dataPrzychodu')}
            <PoleTekstowe etykieta="Numer dowodu" wartosc={dokument} onZmiana={setDokument} blad={wpisy.bledy.dokument} />
            <PoleTekstowe etykieta="Kwota" wartosc={kwotaWpisu} onZmiana={setKwotaWpisu} podpowiedz="zł" klawiatura="numbers-and-punctuation" blad={wpisy.bledy.kwota} />
            {kpir ? (
              <PoleWyboru etykieta="Kolumna KPiR" wartosc={kolumna} opcje={f.kolumny.map((k) => ({ wartosc: k.kolumna, etykieta: k.nazwa }))} onZmiana={setKolumna} />
            ) : (
              <PoleWyboru etykieta="Stawka ryczałtu" wartosc={stawka} opcje={f.stawki.map((s) => ({ wartosc: String(s.pb), etykieta: s.nazwa }))} onZmiana={setStawka} />
            )}
            {blokada(wpisy.bledy, kpir ? 'kolumna' : 'stawkaPb')}
            <PoleTekstowe etykieta="Opis (opcjonalnie)" wartosc={opis} onZmiana={setOpis} blad={wpisy.bledy.opis} />
            <Wiersz tytul={wpisy.trwa ? 'Zapisujemy' : 'Zapisz wpis'} ikona="checkbox-circle-fill" akcja onPress={wpisy.trwa ? undefined : dodajWpis} />
          </>
        ) : f ? (
          // Pola dopiero po dotknięciu, żeby ekran przeglądu nie był formularzem (WZORCE-MOBBIN.md 5.3).
          <Wiersz tytul="Dodaj wpis" ikona="add-line" akcja onPress={() => setOtwarty(true)} />
        ) : null}
      </Sekcja>

      {kpir ? (
        <Sekcja naglowek="Spis z natury" stopka={f ? 'Spis z natury robi się na 1 stycznia (albo na dzień rozpoczęcia działalności) i na 31 grudnia, a także np. przy zmianie formy opodatkowania. Plik JPK_PKPIR bierze z niego spis na początek roku (z 31 grudnia poprzedniego roku albo z 1 stycznia) i na koniec roku. Poprawka to usunięcie spisu i dodanie nowego.' : 'Spisy dodaje i usuwa właściciel albo administrator firmy.'}>
          {d.spisy.length === 0 ? (
            <Wiersz tytul="Brak spisów z natury" />
          ) : (
            d.spisy.map((s) => (
              <Wiersz
                key={s.id}
                tytul={s.tytul}
                podtytul={s.szczegoly}
                onPress={f && !spisy.trwa ? () => usunSpis(s.id, s.tytul) : undefined}
                etykietaDostepnosci={`${s.tytul}. ${s.szczegoly}${f ? ' Dotknij, żeby usunąć spis.' : ''}`}
              />
            ))
          )}
          {f && spisOtwarty ? (
            <>
              <PoleDaty etykieta="Data spisu" wartosc={spisData} onZmiana={setSpisData} najwczesniej={f.spisOd} />
              {blokada(spisy.bledy, 'data')}
              <PoleTekstowe etykieta="Wartość" wartosc={spisKwota} onZmiana={setSpisKwota} podpowiedz="zł" klawiatura="decimal-pad" blad={spisy.bledy.kwota} />
              <PoleTekstowe etykieta="Opis (opcjonalnie)" wartosc={spisOpis} onZmiana={setSpisOpis} blad={spisy.bledy.opis} />
              <Wiersz tytul={spisy.trwa ? 'Zapisujemy' : 'Zapisz spis'} ikona="checkbox-circle-fill" akcja onPress={spisy.trwa ? undefined : dodajSpis} />
            </>
          ) : f ? (
            <Wiersz tytul="Dodaj spis" ikona="add-line" akcja onPress={() => setSpisOtwarty(true)} />
          ) : null}
        </Sekcja>
      ) : null}
      {wpisy.blad || spisy.blad ? (
        <Tekst styl="footnote" kolor="blad" style={styles.nota}>
          {wpisy.blad ?? spisy.blad}
        </Tekst>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  nota: { marginHorizontal: MARGINES, marginTop: ODSTEP.s },
});
