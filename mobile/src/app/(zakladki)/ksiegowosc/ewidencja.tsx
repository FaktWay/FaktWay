import * as Haptics from 'expo-haptics';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { Share, StyleSheet } from 'react-native';

import { DZIS } from '@/dane-przykladowe';
import { KPIR } from '@/dane-przykladowe/ksiegowosc';
import { PoleDaty, PoleTekstowe, PoleWyboru } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { otworzStrone } from '@/komponenty/na-stronie';
import { ZapisyKsiegi } from '@/komponenty/zapisy-ksiegi';
import { StanPusty } from '@/komponenty/stan-pusty';
import { SzkieletKwoty, SzkieletListy } from '@/komponenty/szkielet';
import { Tekst } from '@/komponenty/tekst';
import { NaglowekKwoty } from '@/komponenty/naglowek';
import type { KsiegaTelefonuOdpowiedz, PlikKsiegiOdpowiedz } from '@/lib/api/kontrakt-ksiegi';
import { dataKrotka, kwota } from '@/lib/format';
import { udostepnijXml } from '@/lib/plik-jpk';
import { useKontoFirmy, type KontoFirmy } from '@/stan/dane';
import { nazwaMiesiaca } from '@/stan/ksiegowosc';
import { useOdczyt } from '@/stan/odczyt';
import { IKONY_PASKA } from '@/wyglad/ikony-paska';
import { useKoloryPaska } from '@/wyglad/naglowki';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

const KOLUMNY_RECZNE = [
  { wartosc: '7', etykieta: 'Przychód: sprzedaż (7)' },
  { wartosc: '8', etykieta: 'Przychód: pozostałe (8)' },
  { wartosc: '10', etykieta: 'Zakup towarów i materiałów (10)' },
  { wartosc: '11', etykieta: 'Koszty uboczne zakupu (11)' },
  { wartosc: '12', etykieta: 'Wynagrodzenia (12)' },
  { wartosc: '13', etykieta: 'Pozostałe wydatki (13)' },
];

/**
 * Ewidencja na danych przykładowych (KPiR przy skali i liniowym): odpowiednik
 * `reports/ewidencja` (księga miesiąca, spis z natury, wpisy ręczne, plik JPK_PKPIR).
 */
function EkranEwidencjiPrzyklad() {
  const przychody = KPIR.filter((w) => w.kolumna === '7' || w.kolumna === '8').reduce((s, w) => s + w.kwota, 0);
  const koszty = KPIR.filter((w) => w.kolumna !== '7' && w.kolumna !== '8').reduce((s, w) => s + w.kwota, 0);
  const [wpisy, setWpisy] = useState<string[]>([]);
  const [rodzajDowodu, setRodzajDowodu] = useState('inny');
  const [dataZdarzenia, setDataZdarzenia] = useState(DZIS);
  const [numer, setNumer] = useState('');
  const [kwotaWpisu, setKwotaWpisu] = useState('');
  const [kol, setKol] = useState('13');
  const [spisData, setSpisData] = useState('2026-12-31');
  const [spisWartosc, setSpisWartosc] = useState('');
  const [spisZapisany, setSpisZapisany] = useState(false);
  const [imie, setImie] = useState('Jan');
  const [nazwisko, setNazwisko] = useState('Kowalski');
  const [urodzenie, setUrodzenie] = useState('1990-05-14');

  return (
    <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Sekcja linie naglowek="KPiR, listopad 2026" stopka={`Dochód w miesiącu (przychód minus koszty): ${kwota(przychody - koszty)}.`}>
        {KPIR.map((w) => (
          <Wiersz
            key={w.lp}
            tytul={`${w.lp}. ${w.opis}`}
            podtytul={`${dataKrotka(w.data)} · ${w.dowod} · ${w.kontrahent}`}
            wartosc={kwota(w.kwota)}
            wartoscKolor={w.kolumna === '7' ? 'sukces' : 'etykieta'}
            wartoscPodpis={w.kolumna === '7' ? 'Przychód' : 'Koszt'}
          />
        ))}
        {wpisy.map((t, i) => (
          <Wiersz key={`r${i}`} tytul={t} ikona="edit-circle-line" />
        ))}
      </Sekcja>

      <Sekcja naglowek="Wpisy ręczne w KPiR" stopka="Zwrot zapisuje się kwotą ujemną.">
        <PoleWyboru
          etykieta="Rodzaj dowodu"
          wartosc={rodzajDowodu}
          opcje={[
            { wartosc: 'kasa', etykieta: 'Raport z kasy rejestrującej' },
            { wartosc: 'inny', etykieta: 'Inny dowód' },
          ]}
          onZmiana={setRodzajDowodu}
        />
        <PoleDaty etykieta="Data zdarzenia" wartosc={dataZdarzenia} onZmiana={setDataZdarzenia} />
        <PoleTekstowe etykieta="Numer dowodu" wartosc={numer} onZmiana={setNumer} />
        <PoleTekstowe etykieta="Kwota" wartosc={kwotaWpisu} onZmiana={setKwotaWpisu} podpowiedz="zł" klawiatura="numbers-and-punctuation" />
        <PoleWyboru etykieta="Kolumna KPiR" wartosc={kol} opcje={KOLUMNY_RECZNE} onZmiana={setKol} />
        <Wiersz
          tytul="Dodaj wpis"
          akcja
          onPress={() => {
            if (!numer.trim() || !kwotaWpisu.trim()) return;
            setWpisy((l) => [...l, `${numer.trim()}: ${kwotaWpisu} zł, kol. ${kol}, ${dataKrotka(dataZdarzenia)}`]);
            setNumer('');
            setKwotaWpisu('');
          }}
        />
      </Sekcja>

      <Sekcja naglowek="Spis z natury" stopka={spisZapisany ? 'Spis zapisany.' : 'Na koniec roku albo przy zmianie formy opodatkowania.'}>
        <PoleDaty etykieta="Data spisu" wartosc={spisData} onZmiana={setSpisData} />
        <PoleTekstowe etykieta="Wartość" wartosc={spisWartosc} onZmiana={setSpisWartosc} podpowiedz="zł" klawiatura="decimal-pad" />
        <Wiersz tytul="Zapisz spis" akcja onPress={() => setSpisZapisany(Boolean(spisWartosc.trim()))} />
      </Sekcja>

      <Sekcja naglowek="Plik JPK_PKPIR" stopka="Od 1 stycznia do wybranego miesiąca. Dane osoby trafiają do nagłówka pliku.">
        <PoleTekstowe etykieta="Pierwsze imię" wartosc={imie} onZmiana={setImie} />
        <PoleTekstowe etykieta="Nazwisko" wartosc={nazwisko} onZmiana={setNazwisko} />
        <PoleDaty etykieta="Data urodzenia" wartosc={urodzenie} onZmiana={setUrodzenie} />
        <Wiersz tytul="Pobierz JPK_PKPIR" ikona="file-download-line" akcja onPress={() => void Share.share({ message: 'JPK_PKPIR od stycznia do listopada 2026 (dane przykładowe).' })} />
      </Sekcja>
    </EkranListy>
  );
}

export default function EkranEwidencji() {
  const konto = useKontoFirmy();
  // Klucz firmy: wpisane dane osoby i miesiąc nie przechodzą na inną firmę wybraną w Więcej.
  if (konto) return <EkranEwidencjiZBazy key={konto.firma?.id ?? ''} konto={konto} />;
  return <EkranEwidencjiPrzyklad />;
}

/**
 * Ewidencja ryczałtu albo KPiR modułu na prawdziwym koncie (M10d część 2): wszystko
 * z `GET /ksiegowosc/ewidencja` (ta sama droga co strona `reports/ewidencja`: wyłącznik,
 * forma z ustawień, braki, sumy okresu, wpisy ręczne, spis z natury, stan pliku). Plik
 * JPK_EWP albo JPK_PKPIR z `POST /ksiegowosc/ewidencja/plik` (ten sam plik co „Pobierz”
 * na stronie) idzie do arkusza udostępniania; dane osoby nie są zapisywane (D9). Wpisy ręczne
 * i spis z natury (M10d część 3): lista, dodanie i usunięcie dla właściciela i administratora
 * (`komponenty/zapisy-ksiegi.tsx`), pozostali widzą listy do odczytu.
 */
function EkranEwidencjiZBazy({ konto }: { konto: KontoFirmy }) {
  const pasek = useKoloryPaska(false);
  const parametry = useLocalSearchParams<{ miesiac?: string }>();
  const [miesiac, setMiesiac] = useState(parametry.miesiac);
  const ks = useOdczyt<KsiegaTelefonuOdpowiedz>(miesiac ? `ksiegowosc/ewidencja?miesiac=${miesiac}` : 'ksiegowosc/ewidencja');
  const d = ks?.dane;
  const [firmaEkranu] = useState(konto.firma?.id ?? null);
  const [imie, setImie] = useState('');
  const [nazwisko, setNazwisko] = useState('');
  const [urodzenie, setUrodzenie] = useState('');
  const [bledy, setBledy] = useState<Record<string, string>>({});
  const [bladPliku, setBladPliku] = useState<string>();
  const [trwa, setTrwa] = useState(false);
  const wToku = useRef(false);

  const pobierz = async () => {
    if (!d?.plik || wToku.current) return;
    wToku.current = true;
    setTrwa(true);
    setBladPliku(undefined);
    setBledy({});
    const cialo = { plik: d.plik.plik, rok: d.plik.rok, doMiesiaca: d.plik.doMiesiaca, imie, nazwisko, dataUrodzenia: urodzenie.trim() };
    try {
      const w = await konto.zapytaj<PlikKsiegiOdpowiedz>('ksiegowosc/ewidencja/plik', { metoda: 'POST', cialo, firmaEkranu });
      if (!w.ok) {
        if (w.blad.pole) setBledy({ [w.blad.pole]: w.blad.komunikat });
        else setBladPliku(w.blad.komunikat);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        return;
      }
      await udostepnijXml(w.dane.nazwa, w.dane.xml);
    } catch {
      setBladPliku('Nie udało się zapisać pliku na telefonie. Zwolnij trochę miejsca i spróbuj ponownie.');
    } finally {
      wToku.current = false;
      setTrwa(false);
    }
  };

  const menu = d ? (
    <Stack.Toolbar placement="right" {...pasek.narzedzia}>
      <Stack.Toolbar.Menu icon={IKONY_PASKA.kalendarz} iconRenderingMode="template" tintColor={pasek.ikona} title="Miesiąc">
        {d.miesiace.map((m) => (
          <Stack.Toolbar.MenuAction key={m} isOn={d.miesiac === m} onPress={() => setMiesiac(m)}>
            {nazwaMiesiaca(m)}
          </Stack.Toolbar.MenuAction>
        ))}
      </Stack.Toolbar.Menu>
    </Stack.Toolbar>
  ) : null;

  if (!d) {
    return (
      <EkranListy>
        {ks?.stan === 'blad' ? (
          <StanPusty ikona="error-warning-line" tytul="Nie udało się wczytać księgi" opis={ks.blad ?? 'Spróbuj ponownie za chwilę.'} akcja={{ tytul: 'Spróbuj ponownie', onPress: () => void ks.odswiez() }} />
        ) : (
          <>
            <SzkieletKwoty />
            <SzkieletListy wiersze={5} etykieta="Wczytujemy księgę" />
          </>
        )}
      </EkranListy>
    );
  }

  if (!d.wlaczona) {
    return (
      <EkranListy>
        <StanPusty
          ikona="book2-line"
          tytul="Ewidencja nie jest jeszcze włączona"
          opis="Dla tej firmy ten obszar księgowości jest wyłączony. Stan modułu sprawdzisz na faktway.pl w zakładce Księgowość."
          akcja={{ tytul: 'Otwórz faktway.pl', onPress: () => otworzStrone('/reports') }}
        />
      </EkranListy>
    );
  }

  const tytul = nazwaMiesiaca(d.miesiac);
  const nazwa = d.rodzaj === 'kpir' ? 'KPiR' : 'Ewidencja przychodów';
  if (d.komunikat) {
    return (
      <>
        {menu}
        <EkranListy onOdswiez={ks.odswiez}>
          <Sekcja naglowek={`${nazwa}, ${tytul}`} swobodna>
            <Tekst styl="body">{d.komunikat}</Tekst>
          </Sekcja>
        </EkranListy>
      </>
    );
  }

  const wynik = d.sumy?.at(-1);
  const pominiete = d.pominiete;
  return (
    <>
      {menu}
      <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets onOdswiez={ks.odswiez}>
        {wynik ? (
          <NaglowekKwoty podpis={`${d.rodzaj === 'kpir' ? 'Dochód' : 'Przychód razem'}, ${tytul}`} wartosc={kwota(wynik.kwotaGr)} styl="title1" />
        ) : (
          <NaglowekKwoty podpis={`${nazwa}, ${tytul}`} wartosc="Bez sum" styl="title1" status={d.braki.length > 0 ? 'Są braki w księdze' : undefined} statusKolor="ostrzezenie" />
        )}

        {d.uwaga ? (
          <Tekst styl="footnote" kolor="ostrzezenie" style={styles.nota}>
            {d.uwaga}
          </Tekst>
        ) : null}

        {d.braki.length > 0 ? (
          // Całe zdania z tym, co zrobić (bez ucinania wiersza listy).
          <Sekcja
            naglowek={`Braki w ${d.rodzaj === 'kpir' ? 'KPiR' : 'ewidencji'} za ${tytul}`}
            stopka={
              d.rodzaj === 'kpir'
                ? 'Dopóki są braki, KPiR nie pokazuje sum za ten miesiąc, zaliczki PIT nie liczymy, a plik JPK_PKPIR nie powstaje.'
                : 'Dopóki są braki, ewidencja nie pokazuje sum za ten miesiąc, a plik JPK_EWP nie powstaje.'
            }
            swobodna>
            {d.braki.map((b) => (
              <Tekst key={b} styl="body">
                {b}
              </Tekst>
            ))}
          </Sekcja>
        ) : null}

        {pominiete ? (
          <Tekst styl="footnote" kolor="etykietaDrugorzedna" style={styles.nota}>
            {pominiete}
          </Tekst>
        ) : null}

        {d.wiersze.length === 0 ? (
          <StanPusty ikona="book2-line" tytul="Brak wpisów" opis={`W tym miesiącu ${d.rodzaj === 'kpir' ? 'KPiR' : 'ewidencja'} nie ma ${d.rodzaj === 'kpir' ? 'wpisów' : 'przychodów'}.`} />
        ) : (
          <Sekcja linie naglowek={`${nazwa}, ${tytul}`} stopka={d.podpisSum ?? undefined}>
            {d.wiersze.map((w) => (
              <Wiersz
                key={`${w.lp}-${w.dowod}`}
                tytul={`${w.lp}. ${w.kontrahent || w.dowod}`}
                podtytul={[dataKrotka(w.data), w.dataWpisu ? `wpis ${dataKrotka(w.dataWpisu)}` : null, w.dowod, w.numerKsef, w.identyfikator, w.kolumna, w.opis, w.uwagi].filter(Boolean).join(' · ')}
                wartosc={kwota(w.kwotaGr)}
                wartoscKolor={w.przychod ? 'sukces' : 'etykieta'}
                wartoscPodpis={w.przychod ? 'Przychód' : 'Koszt'}
              />
            ))}
          </Sekcja>
        )}

        {d.sumy && d.sumy.length > 1 ? (
          <Sekcja naglowek="Sumy w miesiącu">
            {d.sumy.map((s) => (
              <Wiersz key={s.podpis} tytul={s.podpis} wartosc={kwota(s.kwotaGr)} wartoscKolor="etykieta" />
            ))}
          </Sekcja>
        ) : null}

        <ZapisyKsiegi key={d.miesiac} konto={konto} d={d} firmaEkranu={firmaEkranu} poZapisie={() => void ks.odswiez()} />

        {d.plik ? (
          <Sekcja
            naglowek={`Plik ${d.plik.plik}`}
            opis={d.plik.opis}
            stopka={d.plik.mozna ? [d.plik.spis, 'Imię, nazwisko i data urodzenia trafiają tylko do pliku: FaktWay ich nie zapisuje, a plik w telefonie usuwa wylogowanie.'].filter(Boolean).join(' ') : (d.plik.powod ?? d.plik.spis ?? undefined)}>
            {d.plik.mozna ? (
              <>
                <PoleTekstowe etykieta="Pierwsze imię" wartosc={imie} onZmiana={setImie} blad={bledy.imie} />
                <PoleTekstowe etykieta="Nazwisko" wartosc={nazwisko} onZmiana={setNazwisko} blad={bledy.nazwisko} />
                <PoleTekstowe etykieta="Data urodzenia" wartosc={urodzenie} onZmiana={setUrodzenie} podpowiedz="RRRR-MM-DD" klawiatura="numbers-and-punctuation" cyfry blad={bledy.dataUrodzenia} />
                <Wiersz tytul={trwa ? 'Przygotowujemy plik' : `Pobierz ${d.plik.plik}`} ikona="file-download-line" akcja onPress={trwa ? undefined : () => void pobierz()} />
              </>
            ) : null}
          </Sekcja>
        ) : null}
        {bladPliku || bledy.rok || bledy.doMiesiaca ? (
          <Tekst styl="footnote" kolor="blad" style={styles.nota}>
            {bladPliku ?? bledy.rok ?? bledy.doMiesiaca}
          </Tekst>
        ) : null}
      </EkranListy>
    </>
  );
}

const styles = StyleSheet.create({
  nota: { marginHorizontal: MARGINES, marginTop: ODSTEP.s },
});
