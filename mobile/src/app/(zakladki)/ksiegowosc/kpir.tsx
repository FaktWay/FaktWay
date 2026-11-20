import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet } from 'react-native';

import { KPIR, type WpisKpir } from '@/dane-przykladowe/ksiegowosc';
import { Segmenty } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { NaglowekKwoty } from '@/komponenty/naglowek';
import { StanPusty } from '@/komponenty/stan-pusty';
import { SzkieletKwoty, SzkieletListy } from '@/komponenty/szkielet';
import { Tekst } from '@/komponenty/tekst';
import type { KpirRaportOdpowiedz } from '@/lib/api/kontrakt-ksiegi';
import { grosze } from '@/lib/dane/mapowanie';
import { useKontoFirmy } from '@/stan/dane';
import { nazwaMiesiaca } from '@/stan/ksiegowosc';
import { useOdczyt } from '@/stan/odczyt';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';
import { Wykres } from '@/komponenty/wykres';
import { dataKrotka, kwota } from '@/lib/format';
import { type Kolory } from '@/wyglad/kolory';
import { IKONY_PASKA } from '@/wyglad/ikony-paska';
import { useKoloryPaska } from '@/wyglad/naglowki';

const MIESIACE = ['Listopad 2026', 'Październik 2026', 'Wrzesień 2026'];
const WIDOKI = ['Wszystko', 'Przychody', 'Koszty'] as const;
const KOLUMNY: { kol: WpisKpir['kolumna']; nazwa: string; kolor: keyof Kolory }[] = [
  { kol: '10', nazwa: 'Towary i materiały', kolor: 'akcent' },
  { kol: '11', nazwa: 'Koszty uboczne zakupu', kolor: 'sukces' },
  { kol: '12', nazwa: 'Wynagrodzenia', kolor: 'ostrzezenie' },
  { kol: '13', nazwa: 'Pozostałe wydatki', kolor: 'blad' },
  { kol: '15', nazwa: 'Koszty B+R', kolor: 'etykietaTrzeciorzedna' },
];

const przychod = (w: WpisKpir) => w.kolumna === '7' || w.kolumna === '8';

/** KPiR na danych przykładowych: odpowiednik `reports/kpir` (wynik, koszty według kolumn, księga z filtrami). */
function EkranKpirPrzyklad() {
  const pasek = useKoloryPaska(false);
  const router = useRouter();
  const [miesiac, setMiesiac] = useState(MIESIACE[0] ?? '');
  const [widok, setWidok] = useState(0);
  const [kolumna, setKolumna] = useState<WpisKpir['kolumna'] | null>(null);

  const przychody = KPIR.filter(przychod).reduce((s, w) => s + w.kwota, 0);
  const koszty = KPIR.filter((w) => !przychod(w)).reduce((s, w) => s + w.kwota, 0);
  const dochod = przychody - koszty;
  const marza = przychody > 0 ? Math.round((dochod / przychody) * 100) : 0;

  // Narastająco po dniach (kilka faktur jednego dnia to jeden punkt).
  const dni = [...new Set(KPIR.filter(przychod).map((w) => w.data))].sort();
  const wykres = dni.map((d) => {
    const doTejPory = KPIR.filter((w) => przychod(w) && w.data <= d).reduce((s, w) => s + w.kwota, 0);
    return { x: dataKrotka(d), y: doTejPory / 100, opis: kwota(doTejPory) };
  });
  const doSprawdzenia = KPIR.filter((w) => w.doSprawdzenia);

  const wpisy = KPIR.filter((w) => {
    if (kolumna) return w.kolumna === kolumna;
    if (WIDOKI[widok] === 'Przychody') return przychod(w);
    if (WIDOKI[widok] === 'Koszty') return !przychod(w);
    return true;
  });
  const wedlugKolumn = KOLUMNY.map((k) => ({ ...k, suma: KPIR.filter((w) => w.kolumna === k.kol).reduce((s, w) => s + w.kwota, 0) })).filter((k) => k.suma > 0);

  return (
    <>
      <Stack.Toolbar placement="right" {...pasek.narzedzia}>
        <Stack.Toolbar.Menu icon={IKONY_PASKA.kalendarz} iconRenderingMode="template" tintColor={pasek.ikona} title="Miesiąc">
          {MIESIACE.map((m) => (
            <Stack.Toolbar.MenuAction key={m} isOn={miesiac === m} onPress={() => setMiesiac(m)}>
              {m}
            </Stack.Toolbar.MenuAction>
          ))}
        </Stack.Toolbar.Menu>
        <Stack.Toolbar.Button icon={IKONY_PASKA.udostepnij} iconRenderingMode="template" tintColor={pasek.ikona} accessibilityLabel="Eksport KPiR" onPress={() => router.push('/ksiegowosc/eksport')} />
      </Stack.Toolbar>

      <EkranListy>
        <NaglowekKwoty podpis={`${dochod >= 0 ? 'Dochód' : 'Strata'}, ${miesiac.toLowerCase()}`} wartosc={kwota(dochod)} styl="title1" status={`Marża ${marza}%`} statusKolor="sukces" />

        <Sekcja naglowek="Przychody narastająco" stopka={`Przychody ${kwota(przychody)} (faktury przyjęte w KSeF), koszty ${kwota(koszty)}.`} swobodna>
          <Wykres punkty={wykres} rodzaj="pole" etykieta="Przychody narastająco w miesiącu" />
        </Sekcja>

        <Sekcja naglowek="Koszty według kolumn" stopka="Dotknij kolumny, żeby zobaczyć tylko jej wpisy.">
          {wedlugKolumn.map((k) => (
            <Wiersz
              key={k.kol}
              tytul={`Kol. ${k.kol}: ${k.nazwa}`}
              wartosc={kwota(k.suma)}
              wartoscPodpis={`${Math.round((k.suma / Math.max(1, koszty)) * 100)}%`}
              strzalka
              onPress={() => setKolumna(kolumna === k.kol ? null : k.kol)}
            />
          ))}
        </Sekcja>

        {doSprawdzenia.length > 0 ? (
          <Sekcja naglowek="Do sprawdzenia" stopka="Wydatki z KSeF, które trzeba opisać, zanim trafią do księgi na stałe.">
            {doSprawdzenia.map((w) => (
              <Wiersz key={w.lp} tytul={w.kontrahent} podtytul={`${w.dowod} · ${dataKrotka(w.data)}`} wartosc={kwota(w.kwota)} strzalka onPress={() => router.push('/koszty')} />
            ))}
          </Sekcja>
        ) : null}

        <Segmenty
          wartosci={[...WIDOKI]}
          wybrany={widok}
          onZmiana={(i) => {
            setWidok(i);
            setKolumna(null);
          }}
          etykieta="Wpisy księgi"
        />
        {wpisy.length === 0 ? (
          <StanPusty ikona="book2-line" tytul="Brak wpisów" opis="Brak przychodów i wydatków w tym widoku." />
        ) : (
          <Sekcja linie naglowek={kolumna ? `Księga: kolumna ${kolumna}` : 'Księga'} stopka={kolumna ? 'Dotknij kolumny jeszcze raz, żeby wyłączyć filtr.' : undefined}>
            {wpisy.map((w) => (
              <Wiersz
                key={w.lp}
                tytul={`${w.lp}. ${w.kontrahent}`}
                podtytul={`${w.dowod} · ${dataKrotka(w.data)} · ${przychod(w) ? '7 · Sprzedaż' : `Kol. ${w.kolumna}`}`}
                wartosc={kwota(w.kwota)}
                wartoscKolor={przychod(w) ? 'sukces' : 'etykieta'}
                wartoscPodpis={w.doSprawdzenia ? 'Do sprawdzenia' : w.opis}
                wartoscPodpisKolor={w.doSprawdzenia ? 'ostrzezenie' : 'etykietaDrugorzedna'}
              />
            ))}
          </Sekcja>
        )}
      </EkranListy>
    </>
  );
}

export default function EkranKpir() {
  const konto = useKontoFirmy();
  // Klucz firmy: filtr kolumny i miesiąc nie przechodzą na inną firmę wybraną w Więcej.
  if (konto) return <EkranKpirZBazy key={konto.firma?.id ?? ''} />;
  return <EkranKpirPrzyklad />;
}

const PROCENT = new Intl.NumberFormat('pl-PL', { style: 'percent', maximumFractionDigits: 0 });
const WIDOKI_RAPORTU = ['Wszystko', 'Przychody', 'Koszty'] as const;

/**
 * KPiR raportu na prawdziwym koncie (M10d część 2): wszystko z `GET /raport-kpir`,
 * czyli z tej samej drogi co strona `reports/kpir` (sumy, marża, koszty według kolumn,
 * seria narastająco, księga z kolumnami, baner wstrzymanego raportu i dane przykładowe
 * przed weryfikacją KSeF). Telefon tylko pokazuje i filtruje wpisy; kwot nie liczy.
 * Kwoty raportu przychodzą w złotych (jak model strony).
 */
function EkranKpirZBazy() {
  const pasek = useKoloryPaska(false);
  const router = useRouter();
  const parametry = useLocalSearchParams<{ miesiac?: string }>();
  const [miesiac, setMiesiac] = useState(parametry.miesiac);
  const [widok, setWidok] = useState(0);
  const [kolumna, setKolumna] = useState<string | null>(null);
  const kpir = useOdczyt<KpirRaportOdpowiedz>(miesiac ? `raport-kpir?miesiac=${miesiac}` : 'raport-kpir');
  const d = kpir?.dane;

  const menu = d ? (
    <Stack.Toolbar placement="right" {...pasek.narzedzia}>
      <Stack.Toolbar.Menu icon={IKONY_PASKA.kalendarz} iconRenderingMode="template" tintColor={pasek.ikona} title="Miesiąc">
        {d.miesiace.map((m) => (
          <Stack.Toolbar.MenuAction
            key={m}
            isOn={d.miesiac === m}
            onPress={() => {
              setMiesiac(m);
              setKolumna(null);
            }}>
            {nazwaMiesiaca(m)}
          </Stack.Toolbar.MenuAction>
        ))}
      </Stack.Toolbar.Menu>
      <Stack.Toolbar.Button icon={IKONY_PASKA.udostepnij} iconRenderingMode="template" tintColor={pasek.ikona} accessibilityLabel="Eksport KPiR" onPress={() => router.push('/ksiegowosc/eksport')} />
    </Stack.Toolbar>
  ) : null;

  if (!d) {
    return (
      <EkranListy>
        {kpir?.stan === 'blad' ? (
          <StanPusty ikona="error-warning-line" tytul="Nie udało się wczytać KPiR" opis={kpir.blad ?? 'Spróbuj ponownie za chwilę.'} akcja={{ tytul: 'Spróbuj ponownie', onPress: () => void kpir.odswiez() }} />
        ) : (
          <>
            <SzkieletKwoty />
            <SzkieletListy wiersze={5} etykieta="Wczytujemy KPiR" />
          </>
        )}
      </EkranListy>
    );
  }

  const tytul = nazwaMiesiaca(d.miesiac);
  if (d.blokada !== null) {
    return (
      <>
        {menu}
        <EkranListy onOdswiez={kpir.odswiez}>
          <Sekcja naglowek={`Raport KPiR za ${tytul} wstrzymany`} swobodna>
            <Tekst styl="body">{d.blokada}</Tekst>
            {d.blokujace.length > 0 ? <Tekst styl="footnote" kolor="etykietaDrugorzedna">{`Faktury sprzedaży: ${d.blokujace.join(', ')}.`}</Tekst> : null}
          </Sekcja>
        </EkranListy>
      </>
    );
  }

  const przychod = (w: KpirRaportOdpowiedz['wpisy'][number]) => w.rodzaj === 'przychod';
  const wpisy = d.wpisy.filter((w) => {
    if (kolumna) return w.kolumna === kolumna;
    if (WIDOKI_RAPORTU[widok] === 'Przychody') return przychod(w);
    if (WIDOKI_RAPORTU[widok] === 'Koszty') return !przychod(w);
    return true;
  });
  const s = d.sumy;
  const wykres = d.seria.map((p) => ({ x: dataKrotka(p.data), y: p.przychod, opis: kwota(grosze(p.przychod)) }));

  return (
    <>
      {menu}
      <EkranListy onOdswiez={kpir.odswiez}>
        {s ? (
          <NaglowekKwoty
            podpis={`${s.dochod >= 0 ? 'Dochód' : 'Strata'}, ${tytul}`}
            wartosc={kwota(grosze(s.dochod))}
            styl="title1"
            status={s.marza === null ? undefined : `Marża ${s.marza}%`}
            statusKolor="sukces"
          />
        ) : null}

        {d.tryb === 'przyklad' ? (
          <Tekst styl="footnote" kolor="ostrzezenie" style={styles.nota}>
            Dane przykładowe: księga pokazuje prawdziwe dane po potwierdzeniu połączenia z KSeF.
          </Tekst>
        ) : null}
        {d.odeslanie ? (
          <Tekst styl="footnote" kolor="etykietaDrugorzedna" style={styles.nota}>
            {d.odeslanie}
          </Tekst>
        ) : null}
        {d.zaliczkiBlad ? (
          <Tekst styl="footnote" kolor="ostrzezenie" style={styles.nota}>
            {d.zaliczkiBlad}
          </Tekst>
        ) : null}

        {s ? (
          <Sekcja naglowek="Przychody narastająco" stopka={`Przychody ${kwota(grosze(s.przychod))}, koszty ${kwota(grosze(s.koszty))}.`} swobodna>
            <Wykres punkty={wykres} rodzaj="pole" etykieta="Przychody narastająco w miesiącu" />
          </Sekcja>
        ) : null}

        {d.kolumny.length > 0 ? (
          <Sekcja naglowek="Koszty według kolumn" stopka="Dotknij kolumny, żeby zobaczyć tylko jej wpisy.">
            {d.kolumny.map((k) => (
              <Wiersz
                key={k.kolumna}
                tytul={`Kol. ${k.kolumna}: ${k.nazwa}`}
                wartosc={kwota(grosze(k.kwota))}
                wartoscPodpis={k.udzial === null ? undefined : PROCENT.format(k.udzial)}
                strzalka
                zaznaczony={kolumna === k.kolumna}
                onPress={() => setKolumna(kolumna === k.kolumna ? null : k.kolumna)}
              />
            ))}
          </Sekcja>
        ) : null}

        {d.doOpisania ? (
          <Sekcja naglowek="Do opisania" stopka="Koszty z KSeF, które trzeba opisać, zanim wejdą do sum.">
            <Wiersz tytul={`${d.doOpisania.liczba} kosztów poza sumą`} wartosc={kwota(grosze(d.doOpisania.kwota))} strzalka onPress={() => router.push('/koszty')} />
          </Sekcja>
        ) : null}

        <Segmenty
          wartosci={[...WIDOKI_RAPORTU]}
          wybrany={widok}
          onZmiana={(i) => {
            setWidok(i);
            setKolumna(null);
          }}
          etykieta="Wpisy księgi"
        />
        {wpisy.length === 0 ? (
          <StanPusty ikona="book2-line" tytul="Brak wpisów" opis="W tym miesiącu nie ma wpisów w tym widoku." />
        ) : (
          <Sekcja linie naglowek={kolumna ? `Księga: kolumna ${kolumna}` : 'Księga'} stopka={kolumna ? 'Dotknij kolumny jeszcze raz, żeby wyłączyć filtr.' : d.vatBezOdliczenia > 0 ? `VAT w kosztach bez odliczenia: ${kwota(grosze(d.vatBezOdliczenia))}.` : undefined}>
            {wpisy.map((w) => (
              <Wiersz
                key={w.id}
                tytul={`${w.lp}. ${w.kontrahent}`}
                podtytul={[w.dokument, dataKrotka(w.data), w.uwagaDaty, w.kolumnaNazwa].filter(Boolean).join(' · ')}
                wartosc={kwota(grosze(w.kwota))}
                wartoscKolor={przychod(w) ? 'sukces' : 'etykieta'}
                wartoscPodpis={w.dopisek ?? (w.wSumie ? w.opis : 'Poza sumą')}
                wartoscPodpisKolor={w.dopisekOstrzezenie || !w.wSumie ? 'ostrzezenie' : 'etykietaDrugorzedna'}
              />
            ))}
          </Sekcja>
        )}
      </EkranListy>
    </>
  );
}

const styles = StyleSheet.create({
  nota: { marginHorizontal: MARGINES, marginTop: ODSTEP.s },
});
