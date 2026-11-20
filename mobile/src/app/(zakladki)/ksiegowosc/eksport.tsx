import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { Share, StyleSheet, View } from 'react-native';

import { EKSPORTY, FORMATY, type FormatEksportu } from '@/dane-przykladowe/ksiegowosc';
import { PolePrzelacznik, PoleWyboru, Segmenty } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { StanPusty } from '@/komponenty/stan-pusty';
import { SzkieletListy } from '@/komponenty/szkielet';
import { Tekst } from '@/komponenty/tekst';
import type { EksportPlikOdpowiedz, EksportStartOdpowiedz, EksportTelefonuOdpowiedz } from '@/lib/api/kontrakt-ksiegi';
import { dataPelna } from '@/lib/format';
import { udostepnijBase64 } from '@/lib/plik-jpk';
import { dzienZnacznika } from '@/lib/wiecej';
import { useKontoFirmy, type KontoFirmy } from '@/stan/dane';
import { nazwaMiesiaca } from '@/stan/ksiegowosc';
import { useOdczyt } from '@/stan/odczyt';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

const MIESIACE = ['Październik 2026', 'Wrzesień 2026', 'Sierpień 2026', 'Listopad 2026 (w trakcie)'];
const KWARTALY = ['III kw. 2026', 'II kw. 2026', 'IV kw. 2026 (w trakcie)'];

/** Eksport na danych przykładowych: odpowiednik `reports/exports` (format, okres, zakres, historia plików). */
function EkranEksportuPrzyklad() {
  const [format, setFormat] = useState<FormatEksportu>('kpir');
  const [rodzajOkresu, setRodzajOkresu] = useState(0);
  const [miesiac, setMiesiac] = useState(MIESIACE[0] ?? '');
  const [kwartal, setKwartal] = useState(KWARTALY[0] ?? '');
  const [wystawione, setWystawione] = useState(true);
  const [otrzymane, setOtrzymane] = useState(true);
  const [korekty, setKorekty] = useState(true);
  const [historia, setHistoria] = useState(EKSPORTY);

  const generuj = () => {
    const id = `e${Date.now()}`;
    const plik = FORMATY.find((f) => f.klucz === format)?.nazwa ?? '';
    const okres = rodzajOkresu === 0 ? miesiac : kwartal;
    setHistoria((h) => [{ id, plik, okres, utworzono: '2026-11-09', status: 'Generowanie' }, ...h]);
    setTimeout(() => {
      setHistoria((h) => h.map((e) => (e.id === id ? { ...e, status: 'Gotowe' } : e)));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }, 1800);
  };

  return (
    <EkranListy>
      <Sekcja naglowek="Format" stopka="Wyłączone na razie: JPK_V7M (jest w zakładce VAT), Optima, Subiekt, Symfonia, Wapro.">
        {FORMATY.map((f) => (
          <Wiersz
            key={f.klucz}
            tytul={f.nazwa}
            podtytul={f.opis}
            zaznaczony={format === f.klucz}
            onPress={() => setFormat(f.klucz)}
            etykietaDostepnosci={`${f.nazwa}${format === f.klucz ? ', wybrany' : ''}`}
          />
        ))}
      </Sekcja>

      <Segmenty wartosci={['Miesiąc', 'Kwartał']} wybrany={rodzajOkresu} onZmiana={setRodzajOkresu} etykieta="Rodzaj okresu" />
      <Sekcja naglowek="Okres">
        {rodzajOkresu === 0 ? (
          <PoleWyboru etykieta="Miesiąc" wartosc={miesiac} opcje={MIESIACE.map((m) => ({ wartosc: m, etykieta: m }))} onZmiana={setMiesiac} />
        ) : (
          <PoleWyboru etykieta="Kwartał" wartosc={kwartal} opcje={KWARTALY.map((k) => ({ wartosc: k, etykieta: k }))} onZmiana={setKwartal} />
        )}
      </Sekcja>

      <Sekcja naglowek="Zakres" stopka={format === 'jpk' ? 'JPK_FA zawiera tylko faktury wystawione.' : format === 'kpir' ? 'KPiR zawiera zawsze sprzedaż, koszty (faktury i paragony) i korekty.' : undefined}>
        {format === 'csv' ? (
          <>
            <PolePrzelacznik etykieta="Faktury wystawione" wartosc={wystawione} onZmiana={setWystawione} />
            <PolePrzelacznik etykieta="Faktury otrzymane" wartosc={otrzymane} onZmiana={setOtrzymane} />
          </>
        ) : null}
        {format !== 'kpir' ? <PolePrzelacznik etykieta="Korekty" wartosc={korekty} onZmiana={setKorekty} /> : null}
        {format === 'kpir' ? <Wiersz tytul="Sprzedaż, koszty i korekty" /> : null}
      </Sekcja>

      <View style={styles.akcja}>
        <PrzyciskGlowny tytul="Wygeneruj plik" ikona="file-upload-line" onPress={generuj} />
      </View>

      <Sekcja naglowek="Historia" stopka="Pliki są dostępne 30 dni.">
        {historia.map((e) => (
          <Wiersz
            key={e.id}
            tytul={e.plik}
            podtytul={`${e.okres} · utworzono ${dataPelna(e.utworzono)}`}
            wartoscPodpis={e.status === 'Gotowe' ? 'Pobierz' : e.status}
            wartoscPodpisKolor={e.status === 'Gotowe' ? 'akcent' : 'etykietaDrugorzedna'}
            onPress={e.status === 'Gotowe' ? () => void Share.share({ message: `${e.plik}, ${e.okres} (dane przykładowe).` }) : undefined}
          />
        ))}
      </Sekcja>
    </EkranListy>
  );
}

const styles = StyleSheet.create({
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.xl },
  nota: { marginHorizontal: MARGINES, marginTop: ODSTEP.s },
});

export default function EkranEksportu() {
  const konto = useKontoFirmy();
  // Klucz firmy: wybrany format i miesiąc nie przechodzą na inną firmę wybraną w Więcej.
  if (konto) return <EkranEksportuZBazy key={konto.firma?.id ?? ''} konto={konto} />;
  return <EkranEksportuPrzyklad />;
}

/** Co ile ms odświeżamy historię, gdy któryś plik jeszcze powstaje. */
const CO_ILE_MS = 4000;

/**
 * Eksport na prawdziwym koncie (M10d część 2): formaty i historia z `GET /eksport` (te same
 * formaty i ten sam odczyt co strona `reports/exports`), zlecenie przez `POST /eksport` (ta sama
 * funkcja co przycisk „Wygeneruj” na stronie, zakres z reguły formatu), gotowy plik z
 * `GET /eksport/pliki/{id}` w arkuszu udostępniania. Telefon wybiera format i miesiąc; kwartał i
 * dowolny okres zostają na stronie. Plik powstaje w tle: historia odświeża się sama.
 */
function EkranEksportuZBazy({ konto }: { konto: KontoFirmy }) {
  const ek = useOdczyt<EksportTelefonuOdpowiedz>('eksport');
  const d = ek?.dane;
  const [firmaEkranu] = useState(konto.firma?.id ?? null);
  const [format, setFormat] = useState<string>();
  const [miesiac, setMiesiac] = useState<string>();
  const [trwa, setTrwa] = useState(false);
  const [pobieranie, setPobieranie] = useState<string>();
  const [blad, setBlad] = useState<string>();
  const wToku = useRef(false);
  const wPobraniu = useRef(false);
  const odswiez = ek?.odswiez;
  const wGenerowaniu = d?.historia.some((z) => z.stan === 'pending' || z.stan === 'generating') ?? false;

  // Plik powstaje w tle (worker): odświeżamy historię, dopóki któryś job trwa; sprzątanie przy zamknięciu ekranu.
  useEffect(() => {
    if (!wGenerowaniu || !odswiez) return;
    const id = setInterval(() => void odswiez(), CO_ILE_MS);
    return () => clearInterval(id);
  }, [wGenerowaniu, odswiez]);

  if (!d) {
    return (
      <EkranListy>
        {ek?.stan === 'blad' ? (
          <StanPusty ikona="error-warning-line" tytul="Nie udało się wczytać eksportu" opis={ek.blad ?? 'Spróbuj ponownie za chwilę.'} akcja={{ tytul: 'Spróbuj ponownie', onPress: () => void ek.odswiez() }} />
        ) : (
          <SzkieletListy wiersze={5} etykieta="Wczytujemy eksport" />
        )}
      </EkranListy>
    );
  }

  const wybranyFormat = format ?? d.formaty[0]?.format;
  const wybranyMiesiac = miesiac ?? d.miesiac;
  const bezUrzedu = wybranyFormat === 'jpk_fa' && d.urzadUstawiony === false;

  const generuj = async () => {
    if (!wybranyFormat || wToku.current) return;
    wToku.current = true;
    setTrwa(true);
    setBlad(undefined);
    try {
      const w = await konto.zapytaj<EksportStartOdpowiedz>('eksport', { metoda: 'POST', cialo: { format: wybranyFormat, miesiac: wybranyMiesiac }, firmaEkranu });
      if (!w.ok) {
        setBlad(w.blad.komunikat);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        // Zerwane połączenie mogło zlecić eksport: historia od nowa, zanim klient dotknie jeszcze raz.
        if (w.blad.rodzaj !== 'odmowa') void ek.odswiez();
        return;
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void ek.odswiez();
    } finally {
      // Wyjątek z `zapytaj` nie zostawia przycisku zablokowanego do zamknięcia ekranu.
      wToku.current = false;
      setTrwa(false);
    }
  };

  const pobierz = async (id: string) => {
    // Ref, nie stan: dwa szybkie dotknięcia przed ponownym narysowaniem nie pobierają dwa razy (licznik pobrań, dwa arkusze).
    if (wPobraniu.current) return;
    wPobraniu.current = true;
    setPobieranie(id);
    setBlad(undefined);
    try {
      const w = await konto.zapytaj<EksportPlikOdpowiedz>(`eksport/pliki/${encodeURIComponent(id)}`);
      if (!w.ok) {
        setBlad(w.blad.komunikat);
        return;
      }
      await udostepnijBase64(w.dane.nazwa, w.dane.base64);
    } catch {
      setBlad('Nie udało się zapisać pliku na telefonie. Zwolnij trochę miejsca i spróbuj ponownie.');
    } finally {
      wPobraniu.current = false;
      setPobieranie(undefined);
    }
  };

  return (
    <EkranListy onOdswiez={ek.odswiez}>
      <Sekcja naglowek="Format" stopka={d.wstrzymane ?? undefined}>
        {d.formaty.map((f) => (
          <Wiersz
            key={f.format}
            tytul={f.nazwa}
            podtytul={f.opis}
            zaznaczony={wybranyFormat === f.format}
            onPress={() => setFormat(f.format)}
            etykietaDostepnosci={`${f.nazwa}${wybranyFormat === f.format ? ', wybrany' : ''}`}
          />
        ))}
      </Sekcja>

      <Sekcja naglowek="Okres" stopka="Miesiąc. Kwartał i dowolny zakres dat wybierzesz na faktway.pl.">
        <PoleWyboru etykieta="Miesiąc" wartosc={wybranyMiesiac} opcje={d.miesiace.map((m) => ({ wartosc: m, etykieta: nazwaMiesiaca(m) }))} onZmiana={setMiesiac} />
      </Sekcja>

      <View style={styles.akcja}>
        <PrzyciskGlowny tytul="Wygeneruj plik" ikona="file-upload-line" trwa={trwa} onPress={bezUrzedu ? () => setBlad('Najpierw ustaw urząd skarbowy. Urząd ustawia się w Ustawieniach, w części Księgowa.') : () => void generuj()} />
      </View>
      {blad ? (
        <Tekst styl="footnote" kolor="blad" style={styles.nota}>
          {blad}
        </Tekst>
      ) : null}

      <Sekcja naglowek="Historia" stopka="Ostatnie 20 ręcznych eksportów.">
        {d.historia.length === 0 ? (
          <Wiersz tytul="Nie ma jeszcze eksportów" />
        ) : (
          d.historia.map((z) => {
            const dzien = dzienZnacznika(z.utworzonoO);
            return (
              <Wiersz
                key={z.id}
                tytul={z.nazwaFormatu}
                podtytul={[z.okres, dzien ? `utworzono ${dataPelna(dzien)}` : '', z.podsumowanie, z.notatka?.tekst].filter(Boolean).join(' · ')}
                wartoscPodpis={z.plik ? (pobieranie === z.plik.id ? 'Pobieramy' : 'Pobierz') : z.stanNazwa}
                wartoscPodpisKolor={z.plik ? 'akcent' : z.notatka?.blad ? 'blad' : 'etykietaDrugorzedna'}
                onPress={z.plik ? () => void pobierz(z.plik!.id) : undefined}
                etykietaDostepnosci={`${z.nazwaFormatu}, ${z.okres}, ${z.stanNazwa}${z.plik ? '. Dotknij, żeby pobrać plik.' : ''}`}
              />
            );
          })
        )}
      </Sekcja>
    </EkranListy>
  );
}
