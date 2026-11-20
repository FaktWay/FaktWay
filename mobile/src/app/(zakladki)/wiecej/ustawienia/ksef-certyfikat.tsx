import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { PoleTekstowe } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { PrzyciskPaska } from '@/komponenty/przycisk-paska';
import { StanPusty } from '@/komponenty/stan-pusty';
import type { BladApi } from '@/lib/api/bledy';
import type { CertyfikatKsefOdpowiedz } from '@/lib/api/kontrakt-bezpieczenstwo';
import { dataPelna } from '@/lib/format';
import { useZapisBezpieczenstwa } from '@/stan/bezpieczenstwo';
import { useKontoFirmy } from '@/stan/dane';
import { useUstawienia } from '@/stan/ustawienia';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

/** Plik PEM ma nagłówek `-----BEGIN …-----`; DER (binarny) nie da się wkleić jako tekst. */
const PEM = /-----BEGIN [A-Z0-9 ]+-----/;

/** Tekst pliku na bajty w base64 (PEM to czysty ASCII); `null`, gdy tekst ma inne znaki. */
function naBase64(tekst: string): string | null {
  try {
    return globalThis.btoa(tekst.trim());
  } catch {
    return null;
  }
}

/**
 * Certyfikat KSeF z telefonu (M10c, część 2b): arkusz z „Anuluj” w pasku.
 * Pliki z Aplikacji Podatnika (.crt i .key, format PEM) wkleja się ze
 * schowka: otwierasz plik w aplikacji Pliki, kopiujesz treść i wklejasz tu.
 * Bez nowej paczki natywnej do wyboru pliku (ta dojdzie z nowym buildem).
 * Klucza prywatnego nie pokazujemy na ekranie ani nie zapisujemy: zostaje w
 * pamięci do wysłania i znika po zapisie. Sprawdzenia (pliki, hasło do
 * klucza, ważność, własność NIP w KSeF, limit 5 prób na godzinę, rola
 * właściciela, 2FA) robi serwer tą samą logiką co kreator strony; jego zdanie
 * stoi pod polem albo nad przyciskiem.
 */
export default function EkranCertyfikatuKsef() {
  const router = useRouter();
  const zapis = useZapisBezpieczenstwa();
  const konto = useKontoFirmy();
  const ustawienia = useUstawienia();
  const [firmaEkranu] = useState(konto?.firma?.id ?? null);
  const [certyfikat, setCertyfikat] = useState('');
  const [klucz, setKlucz] = useState('');
  const [haslo, setHaslo] = useState('');
  const [blad, setBlad] = useState<BladApi>();
  const [lokalny, setLokalny] = useState<{ pole: 'certyfikat' | 'klucz'; zdanie: string }>();
  const [trwa, setTrwa] = useState(false);
  const [wynik, setWynik] = useState<CertyfikatKsefOdpowiedz>();

  const pasek = (
    <>
      <Stack.Screen options={{ title: 'Certyfikat KSeF' }} />
      <PrzyciskPaska strona="lewa" tytul="Anuluj" onPress={() => router.back()} />
    </>
  );
  if (!zapis) {
    return (
      <EkranListy>
        {pasek}
        <StanPusty ikona="upload2-line" tytul="Dane przykładowe" opis="Certyfikat KSeF wgrasz na prawdziwym koncie." />
      </EkranListy>
    );
  }
  if (wynik) {
    return (
      <EkranListy>
        {pasek}
        <StanPusty
          ikona="shield-check-line"
          tytul={wynik.pierwszePolaczenie ? 'Połączono z KSeF' : 'Certyfikat zaktualizowany'}
          opis={`${wynik.komunikat} Certyfikat ważny do ${dataPelna(wynik.wazneDo)}.`}
          akcja={{ tytul: 'Gotowe', onPress: () => router.back() }}
        />
      </EkranListy>
    );
  }

  const wklej = async (pole: 'certyfikat' | 'klucz') => {
    setLokalny(undefined);
    setBlad(undefined);
    const tekst = await Clipboard.getStringAsync().catch(() => '');
    if (!PEM.test(tekst)) {
      setLokalny({ pole, zdanie: 'W schowku nie ma pliku w formacie PEM (zaczyna się od „-----BEGIN”). Otwórz plik w aplikacji Pliki, skopiuj całą treść i spróbuj ponownie.' });
      return;
    }
    if (pole === 'certyfikat') setCertyfikat(tekst);
    else setKlucz(tekst);
  };

  const wgraj = async () => {
    const c = naBase64(certyfikat);
    const k = naBase64(klucz);
    if (!c || !k) {
      setLokalny({ pole: c ? 'klucz' : 'certyfikat', zdanie: 'Wklejony tekst zawiera znaki spoza pliku PEM. Skopiuj plik jeszcze raz.' });
      return;
    }
    setTrwa(true);
    setBlad(undefined);
    setLokalny(undefined);
    const w = await zapis.wgrajCertyfikat({ certyfikat: c, klucz: k, ...(haslo ? { haslo } : {}) }, firmaEkranu);
    setTrwa(false);
    if (!w.ok) {
      setBlad(w.blad);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    // Klucz prywatny i hasło znikają z pamięci ekranu od razu po zapisie.
    setCertyfikat('');
    setKlucz('');
    setHaslo('');
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    void ustawienia?.odswiez();
    setWynik(w.dane);
  };

  const bladPola = (pole: string) => (blad?.pole === pole ? blad.komunikat : lokalny?.pole === pole ? lokalny.zdanie : undefined);
  const polaNaEkranie = ['certyfikat', 'klucz', 'haslo'];
  return (
    <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      {pasek}
      <Sekcja stopka="Pobierz certyfikat w Aplikacji Podatnika KSeF (pliki .crt i .key). Otwórz każdy plik w aplikacji Pliki, skopiuj całą treść i wklej ją tutaj. Klucza nie pokazujemy na ekranie.">{null}</Sekcja>

      <Sekcja naglowek="Certyfikat (.crt)">
        <Wiersz tytul={certyfikat ? 'Wklejono' : 'Brak'} ikona="file-text-line" wartosc={certyfikat ? 'Wklej ponownie' : undefined} akcja onPress={() => void wklej('certyfikat')} />
        {bladPola('certyfikat') ? <Wiersz tytul={bladPola('certyfikat') ?? ''} ikona="error-warning-line" ikonaKolor="blad" /> : null}
      </Sekcja>

      <Sekcja naglowek="Klucz prywatny (.key)">
        <Wiersz tytul={klucz ? 'Wklejono' : 'Brak'} ikona="file-text-line" wartosc={klucz ? 'Wklej ponownie' : undefined} akcja onPress={() => void wklej('klucz')} />
        {bladPola('klucz') ? <Wiersz tytul={bladPola('klucz') ?? ''} ikona="error-warning-line" ikonaKolor="blad" /> : null}
      </Sekcja>

      <Sekcja stopka="Tylko gdy klucz jest zaszyfrowany (nagłówek „ENCRYPTED PRIVATE KEY”). Hasła nigdzie nie zapisujemy.">
        <PoleTekstowe etykieta="Hasło do klucza" wartosc={haslo} onZmiana={setHaslo} tajne blad={bladPola('haslo')} />
      </Sekcja>

      {blad && !(blad.pole && polaNaEkranie.includes(blad.pole)) ? <Sekcja stopka={blad.komunikat}>{null}</Sekcja> : null}

      <View style={styles.akcja}>
        <PrzyciskGlowny tytul="Wgraj certyfikat" ikona="upload2-line" trwa={trwa} onPress={() => void wgraj()} />
      </View>
    </EkranListy>
  );
}

const styles = StyleSheet.create({
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.l },
});
