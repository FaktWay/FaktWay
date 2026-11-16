import * as Haptics from 'expo-haptics';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { Share, StyleSheet } from 'react-native';

import { VAT_MIESIACA } from '@/dane-przykladowe/ksiegowosc';
import { PoleDaty, PoleTekstowe } from '@/komponenty/formularz';
import { Kafle } from '@/komponenty/kafle';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { otworzStrone } from '@/komponenty/na-stronie';
import { NaglowekKwoty } from '@/komponenty/naglowek';
import { StanPusty } from '@/komponenty/stan-pusty';
import { SzkieletKwoty, SzkieletListy } from '@/komponenty/szkielet';
import { Tekst } from '@/komponenty/tekst';
import type { PlikVatOdpowiedz, VatTelefonuOdpowiedz } from '@/lib/api/kontrakt-ksiegowosc';
import { dataPelna, kwota, kwotaKrotka } from '@/lib/format';
import { udostepnijXml } from '@/lib/plik-jpk';
import { dzienZnacznika } from '@/lib/wiecej';
import { useKontoFirmy, type KontoFirmy } from '@/stan/dane';
import { nazwaMiesiaca } from '@/stan/ksiegowosc';
import { useOdczyt } from '@/stan/odczyt';
import { IKONY_PASKA } from '@/wyglad/ikony-paska';
import { useKoloryPaska } from '@/wyglad/naglowki';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

export default function EkranVat() {
  const konto = useKontoFirmy();
  if (konto) return <EkranVatZBazy konto={konto} />;
  return <EkranVatPrzyklad />;
}

/** Nadwyżka w pełnych złotych, bez znaku, jak `nadwyzkaZAdresu` strony (sam kształt; kwoty liczy serwer). */
const PELNE_ZLOTE = /^\d{1,13}$/;

/**
 * VAT na prawdziwym koncie (M10d): wszystko z `GET /ksiegowosc/vat`, czyli z tej
 * samej drogi co strona `reports/vat` (część deklaracyjna, termin, dane do
 * przelewu, nadwyżka z poprzedniej deklaracji, lista wysyłek). Nadwyżkę wpisaną
 * tutaj serwer liczy jak `?nadwyzka=` strony. Plik JPK_V7M przychodzi z
 * `POST /ksiegowosc/vat/plik` (ten sam plik co „Pobierz” na stronie) i idzie do
 * arkusza udostępniania. Dane osoby do pliku nie są zapisywane (D9). Wysyłka do
 * MF, status i UPO są na stronie.
 */
function EkranVatZBazy({ konto }: { konto: KontoFirmy }) {
  const pasek = useKoloryPaska(false);
  const parametry = useLocalSearchParams<{ miesiac?: string; nadwyzka?: string }>();
  const [miesiac, setMiesiac] = useState(parametry.miesiac);
  const [nadwyzka, setNadwyzka] = useState(parametry.nadwyzka && PELNE_ZLOTE.test(parametry.nadwyzka) ? parametry.nadwyzka : undefined);
  const zapytanie = [miesiac ? `miesiac=${miesiac}` : '', nadwyzka ? `nadwyzka=${nadwyzka}` : ''].filter(Boolean).join('&');
  const vat = useOdczyt<VatTelefonuOdpowiedz>(zapytanie ? `ksiegowosc/vat?${zapytanie}` : 'ksiegowosc/vat');
  const d = vat?.dane;
  const [firmaEkranu] = useState(konto.firma?.id ?? null);

  const [poleNadwyzki, setPoleNadwyzki] = useState(nadwyzka ?? '');
  const [bladNadwyzki, setBladNadwyzki] = useState<string>();
  const [imie, setImie] = useState('');
  const [nazwisko, setNazwisko] = useState('');
  const [urodzenie, setUrodzenie] = useState('');
  const [email, setEmail] = useState<string>();
  const [bledy, setBledy] = useState<Record<string, string>>({});
  const [bladPliku, setBladPliku] = useState<string>();
  const [trwa, setTrwa] = useState(false);
  const wToku = useRef(false);

  const zmienMiesiac = (m: string) => {
    setMiesiac(m);
    // Nadwyżka dotyczy deklaracji za miesiąc wcześniej: przy innym miesiącu liczymy bez niej.
    setNadwyzka(undefined);
    setPoleNadwyzki('');
    setBladNadwyzki(undefined);
    setBladPliku(undefined);
    setBledy({});
  };

  const przelicz = () => {
    const tekst = poleNadwyzki.trim();
    if (!PELNE_ZLOTE.test(tekst)) {
      setBladNadwyzki('Nadwyżkę wpisuje się w pełnych złotych, bez znaku (także 0).');
      return;
    }
    setBladNadwyzki(undefined);
    setNadwyzka(String(Number(tekst)));
  };

  const pobierz = async () => {
    if (!d || wToku.current) return;
    wToku.current = true;
    setTrwa(true);
    setBladPliku(undefined);
    setBledy({});
    const cialo = { miesiac: d.miesiac, nadwyzka: d.nadwyzka?.wpisana ?? null, imie, nazwisko, dataUrodzenia: urodzenie.trim(), email: email ?? d.plik.email ?? '' };
    const w = await konto.zapytaj<PlikVatOdpowiedz>('ksiegowosc/vat/plik', { metoda: 'POST', cialo, firmaEkranu });
    try {
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
      <Stack.Toolbar.Menu icon={IKONY_PASKA.kalendarz} iconRenderingMode="template" tintColor={pasek.ikona} title="Miesiąc rozliczenia VAT">
        {d.miesiace.map((m) => (
          <Stack.Toolbar.MenuAction key={m} isOn={d.miesiac === m} onPress={() => zmienMiesiac(m)}>
            {nazwaMiesiaca(m)}
          </Stack.Toolbar.MenuAction>
        ))}
      </Stack.Toolbar.Menu>
    </Stack.Toolbar>
  ) : null;

  if (!d) {
    return (
      <EkranListy>
        {vat?.stan === 'blad' ? (
          <StanPusty ikona="error-warning-line" tytul="Nie udało się wczytać VAT" opis={vat.blad ?? 'Spróbuj ponownie za chwilę.'} akcja={{ tytul: 'Spróbuj ponownie', onPress: () => void vat.odswiez() }} />
        ) : (
          <>
            <SzkieletKwoty />
            <SzkieletListy wiersze={4} etykieta="Wczytujemy VAT" />
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
          tytul="VAT nie jest jeszcze włączony"
          opis="Dla tej firmy VAT w Księgowości jest wyłączony. Stan modułu sprawdzisz na faktway.pl w zakładce Księgowość."
          akcja={{ tytul: 'Otwórz faktway.pl', onPress: () => otworzStrone('/reports') }}
        />
      </EkranListy>
    );
  }

  const k = d.kwoty;
  const tytul = nazwaMiesiaca(d.miesiac);
  // Jak kafle strony: P_51, a przy nadwyżce na następny miesiąc i braku wpłaty P_62.
  const doWplaty = k ? k.doZaplatyGr > 0 || k.nadwyzkaNaNastepnyGr === 0 : true;
  const adresStrony = `/reports/vat?month=${Number(d.miesiac.slice(5, 7))}&year=${d.miesiac.slice(0, 4)}`;

  return (
    <>
      {menu}
      <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets onOdswiez={vat.odswiez}>
        {k ? (
          <NaglowekKwoty
            podpis={doWplaty ? `VAT za ${tytul}, do wpłaty (P_51)` : `VAT za ${tytul}, nadwyżka na następny miesiąc (P_62)`}
            wartosc={kwota(doWplaty ? k.doZaplatyGr : k.nadwyzkaNaNastepnyGr)}
            styl="title1"
            status={d.termin ? `Termin ${dataPelna(d.termin.faktyczny)}` : undefined}
          />
        ) : null}

        {d.komunikat ? (
          <Sekcja naglowek={`Kwot VAT za ${tytul} nie liczymy`}>
            <Wiersz tytul={d.komunikat} ikona="error-warning-line" ikonaKolor="ostrzezenie" />
          </Sekcja>
        ) : null}

        {d.nadwyzka && (d.nadwyzka.pole || d.nadwyzka.opis) ? (
          <Sekcja naglowek="Nadwyżka z poprzedniej deklaracji" stopka={d.nadwyzka.opis ?? undefined}>
            {d.nadwyzka.pole ? (
              <>
                <PoleTekstowe
                  etykieta={`Nadwyżka z deklaracji za ${d.nadwyzka.poprzedni} (P_62 tamtej deklaracji)`}
                  wartosc={poleNadwyzki}
                  onZmiana={setPoleNadwyzki}
                  podpowiedz="zł"
                  klawiatura="number-pad"
                  blad={bladNadwyzki}
                  klawiszZatwierdz="done"
                  onZatwierdz={przelicz}
                />
                <Wiersz tytul="Przelicz z tą nadwyżką" ikona="refresh-line" akcja onPress={przelicz} />
              </>
            ) : null}
          </Sekcja>
        ) : null}

        {k ? (
          <>
            <Kafle
              kafle={[
                { klucz: 'p38', ikona: 'arrow-right-up-line', podpis: 'Podatek należny (P_38)', wartosc: kwotaKrotka(k.naleznyGr) },
                { klucz: 'p48', ikona: 'arrow-right-down-line', podpis: 'Podatek naliczony (P_48)', wartosc: kwotaKrotka(k.naliczonyGr) },
              ]}
            />
            {d.podpis ? (
              <Tekst styl="footnote" kolor="etykietaDrugorzedna" style={styles.nota}>
                {d.podpis}
              </Tekst>
            ) : null}
          </>
        ) : null}

        <Sekcja naglowek="Termin i przelew" stopka="Przytrzymaj tekst, żeby go zaznaczyć i skopiować.">
          {d.termin ? (
            <Wiersz
              tytul="Złożenie JPK_V7M i zapłata VAT"
              podtytul={d.termin.przesuniety ? `Ustawowo ${dataPelna(d.termin.nominalny)}, przesunięty na dzień roboczy` : undefined}
              wartosc={dataPelna(d.termin.faktyczny)}
              wartoscKolor="etykieta"
            />
          ) : null}
          <Wiersz tytul="Rachunek i opis" podtytul={d.przelew} zaznaczalna />
          {k ? <Wiersz tytul="Kwota" wartosc={kwota(k.doZaplatyGr)} wartoscKolor="etykieta" zaznaczalna /> : null}
        </Sekcja>

        {k ? (
          <Sekcja
            naglowek="Plik JPK_V7M"
            stopka={
              d.plik.mozna
                ? 'Ewidencja sprzedaży i zakupów z deklaracją VAT-7 według schematu JPK_V7M(3). Imię, nazwisko i data urodzenia trafiają tylko do pliku, nie zapisujemy ich.'
                : (d.plik.powod ?? undefined)
            }
          >
            {d.plik.mozna ? (
              <>
                <PoleTekstowe etykieta="Pierwsze imię" wartosc={imie} onZmiana={setImie} blad={bledy.imie} />
                <PoleTekstowe etykieta="Nazwisko" wartosc={nazwisko} onZmiana={setNazwisko} blad={bledy.nazwisko} />
                <PoleTekstowe etykieta="Data urodzenia" wartosc={urodzenie} onZmiana={setUrodzenie} podpowiedz="RRRR-MM-DD" klawiatura="numbers-and-punctuation" cyfry blad={bledy.dataUrodzenia} />
                <PoleTekstowe etykieta="E-mail w pliku" wartosc={email ?? d.plik.email ?? ''} onZmiana={setEmail} klawiatura="email-address" blad={bledy.email} />
                <Wiersz tytul={trwa ? 'Przygotowujemy plik' : 'Pobierz JPK_V7M'} ikona="file-download-line" akcja onPress={trwa ? undefined : () => void pobierz()} />
              </>
            ) : null}
          </Sekcja>
        ) : null}
        {bladPliku || bledy.miesiac || bledy.nadwyzka ? (
          <Tekst styl="footnote" kolor="blad" style={styles.nota}>
            {bladPliku ?? bledy.miesiac ?? bledy.nadwyzka}
          </Tekst>
        ) : null}

        {d.wysylkaWlaczona || d.wysylki.length > 0 ? (
          <Sekcja
            naglowek="Wysyłka do Ministerstwa Finansów"
            stopka={
              d.wysylkaWlaczona
                ? 'Plik z danymi autoryzującymi wysyła się na faktway.pl; po przyjęciu MF wydaje urzędowe poświadczenie odbioru (UPO).'
                : 'Wysyłka z FaktWay nie jest jeszcze włączona. Plik można złożyć w e-Urzędzie Skarbowym.'
            }
          >
            {d.wysylki.map((w) => {
              const dzien = dzienZnacznika(w.utworzonoO);
              return (
                <Wiersz
                  key={w.id}
                  tytul={`${w.stan}${w.testowe ? ' (środowisko testowe)' : ''}`}
                  podtytul={[dzien ? `Wysłano ${dataPelna(dzien)}` : '', w.numer ? `nr ${w.numer}` : '', w.odmowa ?? ''].filter(Boolean).join(' · ')}
                  wartosc={kwota(w.doWplatyGr)}
                  wartoscKolor="etykieta"
                />
              );
            })}
            {d.wysylkaWlaczona || d.wysylki.some((w) => w.przyjeta) ? (
              <Wiersz tytul={d.wysylkaWlaczona ? 'Wyślij albo pobierz UPO na faktway.pl' : 'Pobierz UPO na faktway.pl'} strzalka onPress={() => otworzStrone(adresStrony, () => void vat.odswiez())} />
            ) : null}
          </Sekcja>
        ) : null}
      </EkranListy>
    </>
  );
}

type Wysylka = { wyslano: string; stan: string; numer: string; doWplaty: number };

/**
 * VAT na danych przykładowych: odpowiednik `reports/vat` (P_38, P_48, P_51,
 * termin i przelew, plik JPK_V7M, wysyłka do Ministerstwa Finansów z UPO).
 */
function EkranVatPrzyklad() {
  const v = VAT_MIESIACA;
  const doWplaty = v.nalezny - v.naliczony;
  const [imie, setImie] = useState('Jan');
  const [nazwisko, setNazwisko] = useState('Kowalski');
  const [urodzenie, setUrodzenie] = useState('1990-05-14');
  const [email, setEmail] = useState('jan@przyklad.pl');
  const [wysylki, setWysylki] = useState<Wysylka[]>(v.wysylki);

  const wyslij = () => {
    const nowa: Wysylka = { wyslano: '2026-11-09', stan: 'Wysyłanie', numer: 'f7e6d5c4b3a2', doWplaty };
    setWysylki((l) => [nowa, ...l]);
    setTimeout(() => setWysylki((l) => l.map((w) => (w.numer === nowa.numer ? { ...w, stan: 'MF sprawdza plik' } : w))), 1200);
    setTimeout(() => {
      setWysylki((l) => l.map((w) => (w.numer === nowa.numer ? { ...w, stan: 'Przyjęty, UPO gotowe' } : w)));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }, 3000);
  };

  return (
    <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <NaglowekKwoty podpis={`VAT za ${v.miesiac}, do wpłaty (P_51)`} wartosc={kwota(doWplaty)} styl="title1" status={`Termin ${dataPelna(v.termin)}`} />
      <Kafle
        kafle={[
          { klucz: 'p38', ikona: 'arrow-right-up-line', podpis: 'Podatek należny (P_38)', wartosc: kwotaKrotka(v.nalezny) },
          { klucz: 'p48', ikona: 'arrow-right-down-line', podpis: 'Podatek naliczony (P_48)', wartosc: kwotaKrotka(v.naliczony) },
        ]}
      />

      <Sekcja naglowek="Termin i przelew" stopka={`Złożenie JPK_V7M i zapłata VAT za ${v.miesiac}: do ${dataPelna(v.termin)}.`}>
        <Wiersz tytul="Mikrorachunek podatkowy" podtytul={v.mikrorachunek} zaznaczalna />
        <Wiersz tytul="Kwota" wartosc={kwota(doWplaty)} wartoscKolor="etykieta" />
      </Sekcja>

      <Sekcja naglowek="Plik JPK_V7M">
        <PoleTekstowe etykieta="Pierwsze imię" wartosc={imie} onZmiana={setImie} />
        <PoleTekstowe etykieta="Nazwisko" wartosc={nazwisko} onZmiana={setNazwisko} />
        <PoleDaty etykieta="Data urodzenia" wartosc={urodzenie} onZmiana={setUrodzenie} />
        <PoleTekstowe etykieta="E-mail w pliku" wartosc={email} onZmiana={setEmail} klawiatura="email-address" />
        <Wiersz tytul="Pobierz JPK_V7M" ikona="file-download-line" akcja onPress={() => void Share.share({ message: `JPK_V7M za ${v.miesiac} (dane przykładowe).` })} />
      </Sekcja>

      <Sekcja naglowek="Wysyłka do Ministerstwa Finansów" stopka="Plik podpisujemy danymi autoryzującymi (przychód z zeznania za poprzedni rok).">
        <Wiersz tytul="Wyślij do MF" ikona="send-plane-line" akcja onPress={wyslij} />
        {wysylki.map((w) => (
          <Wiersz
            key={w.numer}
            tytul={w.stan}
            podtytul={`Wysłano ${dataPelna(w.wyslano)} · nr ${w.numer}`}
            wartosc={kwota(w.doWplaty)}
            wartoscPodpis={w.stan.startsWith('Przyjęty') ? 'Pobierz UPO' : undefined}
            wartoscPodpisKolor="akcent"
            onPress={w.stan.startsWith('Przyjęty') ? () => void Share.share({ message: `UPO dla wysyłki ${w.numer}.` }) : undefined}
          />
        ))}
      </Sekcja>
    </EkranListy>
  );
}

const styles = StyleSheet.create({
  nota: { marginHorizontal: MARGINES, marginTop: ODSTEP.s },
});
