import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { IMPORT } from '@/dane-przykladowe/ustawienia';
import { Kafle } from '@/komponenty/kafle';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { MA_ADRES_STRONY, otworzStrone } from '@/komponenty/na-stronie';
import { StanPusty } from '@/komponenty/stan-pusty';
import { SzkieletListy } from '@/komponenty/szkielet';
import { Tekst } from '@/komponenty/tekst';
import { Znacznik } from '@/komponenty/znacznik';
import { bezDlugichMyslnikow } from '@/lib/api/bledy';
import type { GrupaStatusuImportu, ImportOdpowiedz, OdcienTelefonu, SekcjaHistoriiKsef } from '@/lib/api/kontrakt-wiecej';
import { dataPelna } from '@/lib/format';
import { useFlaga } from '@/stan/faktury';
import { useOdczyt, type StanOdczytu } from '@/stan/odczyt';
import type { Kolory, Ton } from '@/wyglad/kolory';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

export default function EkranImportu() {
  const odczyt = useOdczyt<ImportOdpowiedz>('import');
  return odczyt ? <EkranImportuZBazy odczyt={odczyt} /> : <EkranImportuPrzyklad />;
}

const TON: Record<OdcienTelefonu, Ton> = { ok: 'sukces', ostrzezenie: 'ostrzezenie', blad: 'blad', neutralny: 'neutralny' };
const KOLOR: Record<OdcienTelefonu, keyof Kolory> = { ok: 'sukces', ostrzezenie: 'ostrzezenie', blad: 'blad', neutralny: 'etykietaDrugorzedna' };
const KOLOR_STATUSU: Record<GrupaStatusuImportu, keyof Kolory> = { completed: 'sukces', running: 'akcent', failed: 'blad', cancelled: 'etykietaDrugorzedna' };

/** Zdania strony mają długie myślniki; w aplikacji ich nie piszemy (ZASADY-DESIGNU.md, sekcja 8). */
const t = bezDlugichMyslnikow;

function SekcjaHistorii({ s }: { s: SekcjaHistoriiKsef }) {
  return (
    <View style={styles.strumien}>
      <Tekst styl="headline">{s.tytul}</Tekst>
      {s.linie.map((l) => (
        <Tekst key={l} styl="footnote" kolor="etykietaDrugorzedna">
          {t(l)}
        </Tekst>
      ))}
      {s.stoi ? (
        <Tekst styl="footnote" kolor="ostrzezenie">
          {t(s.stoi)}
        </Tekst>
      ) : null}
      {s.postep ? (
        <Tekst styl="footnote" cyfry>
          {`${t(s.postep.podpis)} (${s.postep.procent}%)`}
        </Tekst>
      ) : null}
      {s.tempo.map((l) => (
        <Tekst key={l} styl="caption1" kolor="etykietaDrugorzedna">
          {t(l)}
        </Tekst>
      ))}
      {s.nota ? (
        <Tekst styl="caption1" kolor="etykietaDrugorzedna">
          {t(s.nota)}
        </Tekst>
      ) : null}
    </View>
  );
}

/**
 * Import danych na prawdziwym koncie (M10e): kafle, „Historia z KSeF” i
 * „Historia importów” z `GET /import`, zdaniami strony. Wgranie pliku CSV
 * i wstrzymanie pobierania zostają na faktway.pl.
 */
function EkranImportuZBazy({ odczyt }: { odczyt: StanOdczytu<ImportOdpowiedz> }) {
  const router = useRouter();
  const dane = odczyt.dane;
  if (!dane) {
    return (
      <EkranListy>
        {odczyt.stan === 'blad' ? (
          <StanPusty ikona="error-warning-line" tytul="Nie udało się wczytać importu" opis={odczyt.blad ?? 'Spróbuj ponownie za chwilę.'} akcja={{ tytul: 'Spróbuj ponownie', onPress: () => void odczyt.odswiez() }} />
        ) : (
          <SzkieletListy wiersze={6} etykieta="Wczytujemy import danych" />
        )}
      </EkranListy>
    );
  }
  const h = dane.historiaKsef;
  return (
    <EkranListy onOdswiez={odczyt.odswiez}>
      {dane.kafle ? <Kafle kafle={dane.kafle.map((k, i) => ({ klucz: String(i), podpis: k.podpis, wartosc: k.wartosc ?? 'Brak' }))} /> : null}
      {dane.kafle ? <Sekcja stopka={dane.kafle.map((k) => (k.nota ? `${k.podpis}: ${k.nota}` : null)).filter(Boolean).join('. ')} /> : null}
      {odczyt.blad ? <Sekcja stopka={`Nie udało się odświeżyć: ${odczyt.blad}`} /> : null}

      <Sekcja naglowek="Historia z KSeF" opis={t(h.podtytul)} stopka={h.blad ? t(h.blad) : undefined}>
        <View style={styles.odznaka}>
          <Znacznik ton={TON[h.odznaka.odcien]}>{h.odznaka.etykieta}</Znacznik>
        </View>
        {h.komunikaty.map((k) => (
          <Wiersz key={k.tekst} tytul={t(k.tekst)} ikona={k.odcien === 'neutralny' ? 'information-line' : 'error-warning-line'} ikonaKolor={KOLOR[k.odcien]} />
        ))}
        {h.sekcje.map((s) => (
          <SekcjaHistorii key={s.kierunek} s={s} />
        ))}
        {h.certyfikat !== 'gotowy' ? (
          <Wiersz tytul={h.certyfikat === 'brak' ? 'Wgraj certyfikat KSeF' : 'Wgraj certyfikat ponownie'} akcja onPress={() => router.push('/wiecej/ustawienia/ksef')} />
        ) : h.komunikaty.some((k) => k.doUstawienKsef) ? (
          <Wiersz tytul="Przejdź do ustawień KSeF" akcja onPress={() => router.push('/wiecej/ustawienia/ksef')} />
        ) : null}
      </Sekcja>

      <Sekcja
        naglowek="Przeprowadzka z innego programu"
        stopka={`Plik CSV z eksportu programu: ${dane.programy.join(', ')}. Plik wgrasz na faktway.pl, a faktury i kontrahenci pojawią się tu sami.`}>
        {MA_ADRES_STRONY ? <Wiersz tytul="Wgraj plik na faktway.pl" ikona="global-line" akcja onPress={() => otworzStrone('/import-danych', () => void odczyt.odswiez())} /> : null}
      </Sekcja>

      {dane.importy === null ? (
        <Sekcja naglowek="Historia importów" stopka="Nie udało się wczytać historii importów. Pociągnij w dół, żeby spróbować ponownie." />
      ) : dane.importy.length === 0 ? null : (
        <Sekcja naglowek="Historia importów">
          {dane.importy.map((i) => (
            <Wiersz
              key={i.id}
              tytul={i.zrodlo}
              podtytul={[i.szczegol ? t(i.szczegol) : null, `Rozpoczęto ${i.data}`, i.opis ? t(i.opis) : null, i.procent !== null ? `${i.procent}%` : null].filter(Boolean).join('\n')}
              wartoscPodpis={i.statusEtykieta}
              wartoscPodpisKolor={KOLOR_STATUSU[i.status]}
            />
          ))}
        </Sekcja>
      )}
    </EkranListy>
  );
}

/**
 * Import danych na danych przykładowych: odpowiednik `import-danych` (historia
 * z KSeF, przeprowadzka z innego programu przez CSV, historia importów).
 */
function EkranImportuPrzyklad() {
  const router = useRouter();
  const [wstrzymane, setWstrzymane] = useFlaga('historia-ksef-wstrzymana', false);
  const [historia, setHistoria] = useState(IMPORT.historia);
  const licznik = useRef(0);
  const s = IMPORT.historiaSprzedaz;
  const z = IMPORT.historiaZakupy;

  const importuj = (zrodlo: string) => {
    licznik.current += 1;
    const id = `nowy-${licznik.current}`;
    setHistoria((h) => [{ id, zrodlo: `${zrodlo} (CSV)`, rozpoczeto: '2026-11-09', wynik: 'Wczytywanie danych', status: 'W toku' }, ...h]);
    setTimeout(() => {
      setHistoria((h) => h.map((x) => (x.id === id ? { ...x, wynik: '41 faktur, 9 kontrahentów', status: 'Gotowe' } : x)));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }, 2200);
  };

  return (
    <EkranListy>
      <Kafle
        kafle={[
          { klucz: 'ksef', ikona: 'shield-check-line', podpis: 'Historia z KSeF', wartosc: `${s.pobrano + z.pobrano}`, opis: 'sprzedaż i zakupy' },
          { klucz: 'pliki', ikona: 'file-upload-line', podpis: 'Z plików', wartosc: String(IMPORT.zPlikow) },
          { klucz: 'kontrahenci', ikona: 'contacts-book3-line', podpis: 'Nowi kontrahenci', wartosc: String(IMPORT.nowiKontrahenci) },
          { klucz: 'pobranie', ikona: 'refresh-line', podpis: 'Ostatnie pobranie z KSeF', wartosc: IMPORT.ostatniePobranie },
        ]}
      />

      <Sekcja naglowek="Historia z KSeF" stopka={wstrzymane ? 'Wstrzymane. Wznów, żeby dociągnąć resztę faktur.' : 'Pobieramy automatycznie wszystkie faktury z KSeF od początku.'}>
        <Wiersz tytul="Sprzedaż" wartosc={`Pobrano ${s.pobrano} z ${s.z}`} wartoscPodpis={s.pobrano === s.z ? 'Gotowe' : 'W toku'} wartoscPodpisKolor="sukces" />
        <Wiersz tytul="Zakupy" wartosc={`Pobrano ${z.pobrano} z ${z.z}`} wartoscPodpis={wstrzymane ? 'Wstrzymane' : 'W toku'} wartoscPodpisKolor={wstrzymane ? 'etykietaDrugorzedna' : 'akcent'} />
        <Wiersz tytul={wstrzymane ? 'Wznów pobieranie' : 'Wstrzymaj pobieranie historii'} akcja onPress={() => setWstrzymane(!wstrzymane)} />
        <Wiersz tytul="Certyfikat KSeF" strzalka onPress={() => router.push('/wiecej/ustawienia/ksef')} />
      </Sekcja>

      <Sekcja naglowek="Przeprowadzka z innego programu" stopka="Plik CSV z eksportu programu, do 1 MB. Faktury i kontrahentów dopiszemy do Twoich danych.">
        {IMPORT.zrodla.map((zr) => (
          <Wiersz key={zr} tytul={zr} wartoscPodpis="Wgraj plik" wartoscPodpisKolor="akcent" onPress={() => importuj(zr)} />
        ))}
      </Sekcja>

      <Sekcja naglowek="Historia importów">
        {historia.map((hh) => (
          <Wiersz
            key={hh.id}
            tytul={hh.zrodlo}
            podtytul={`Rozpoczęto ${dataPelna(hh.rozpoczeto)} · ${hh.wynik}`}
            wartoscPodpis={hh.status}
            wartoscPodpisKolor={hh.status === 'Gotowe' ? 'sukces' : 'akcent'}
          />
        ))}
      </Sekcja>
    </EkranListy>
  );
}

const styles = StyleSheet.create({
  odznaka: { flexDirection: 'row', paddingHorizontal: MARGINES, paddingTop: ODSTEP.s },
  strumien: { paddingHorizontal: MARGINES, paddingVertical: ODSTEP.s, gap: ODSTEP.xxs },
});
