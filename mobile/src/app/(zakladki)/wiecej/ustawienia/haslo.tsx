import { Stack, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { PoleTekstowe } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { PrzyciskPaska } from '@/komponenty/przycisk-paska';
import { StanPusty } from '@/komponenty/stan-pusty';
import type { BladApi } from '@/lib/api/bledy';
import { useZapisBezpieczenstwa } from '@/stan/bezpieczenstwo';
import { useOchronaZmian } from '@/stan/ustawienia-zapis';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

/**
 * Zmiana hasła z telefonu (M10c, część 2): arkusz z „Anuluj” w pasku, jak
 * karta hasła strony. Aktualne hasło (wspólny ze stroną limit prób), nowe
 * (siła i znane wycieki) i, gdy serwer tego żąda, kod z e-maila sprawdza
 * serwer; jego zdanie stoi pod polem. Sesja na telefonie zostaje.
 */
export default function EkranZmianyHasla() {
  const router = useRouter();
  const zapis = useZapisBezpieczenstwa();
  const [obecne, setObecne] = useState('');
  const [nowe, setNowe] = useState('');
  const [kod, setKod] = useState('');
  const [potrzebnyKod, setPotrzebnyKod] = useState(false);
  const [kodWyslany, setKodWyslany] = useState(false);
  const [blad, setBlad] = useState<BladApi>();
  const [trwa, setTrwa] = useState<'zapis' | 'kod' | null>(null);
  const ochrona = useOchronaZmian(obecne !== '' || nowe !== '');

  const pasek = (
    <>
      <Stack.Screen options={{ title: 'Zmień hasło' }} />
      <PrzyciskPaska strona="lewa" tytul="Anuluj" onPress={() => router.back()} />
    </>
  );
  if (!zapis) {
    return (
      <EkranListy>
        {pasek}
        <StanPusty ikona="key-line" tytul="Dane przykładowe" opis="Hasło zmienisz na prawdziwym koncie." />
      </EkranListy>
    );
  }

  const bladPola = (pole: string) => (blad?.pole === pole ? blad.komunikat : undefined);
  const odmowa = (b: BladApi) => {
    setBlad(b);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  };

  const zapisz = async () => {
    setTrwa('zapis');
    setBlad(undefined);
    const w = await zapis.zmienHaslo({ obecne, nowe, ...(potrzebnyKod && kod ? { kod } : {}) });
    setTrwa(null);
    if (!w.ok) {
      if (w.blad.kod === 'password_code_required') setPotrzebnyKod(true);
      odmowa(w.blad);
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    ochrona.zamknij();
  };

  const wyslijKod = async () => {
    setTrwa('kod');
    setBlad(undefined);
    const w = await zapis.wyslijKod(obecne);
    setTrwa(null);
    if (!w.ok) {
      odmowa(w.blad);
      return;
    }
    setKodWyslany(true);
  };

  return (
    <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      {pasek}
      <Sekcja stopka="Nowe hasło: co najmniej 12 znaków, mała i wielka litera, cyfra i znak specjalny. Sprawdzamy też, czy nie było w znanych wyciekach.">
        <PoleTekstowe etykieta="Aktualne hasło" wartosc={obecne} onZmiana={setObecne} tajne autouzupelnianie="haslo" blad={bladPola('obecne')} />
        <PoleTekstowe etykieta="Nowe hasło" wartosc={nowe} onZmiana={setNowe} tajne autouzupelnianie="nowe-haslo" blad={bladPola('nowe')} />
      </Sekcja>

      {potrzebnyKod ? (
        <Sekcja
          naglowek="Kod z e-maila"
          stopka={kodWyslany ? 'Wysłaliśmy kod na adres konta. Wpisz go i zapisz hasło.' : 'Ze względów bezpieczeństwa potrzebny jest kod z e-maila. Wyślemy go na adres konta.'}>
          <Wiersz tytul={kodWyslany ? 'Wyślij kod jeszcze raz' : 'Wyślij kod na e-mail'} akcja onPress={() => void wyslijKod()} />
          {kodWyslany ? <PoleTekstowe etykieta="Kod" wartosc={kod} onZmiana={setKod} klawiatura="number-pad" cyfry blad={bladPola('kod')} /> : null}
        </Sekcja>
      ) : null}

      {blad && !blad.pole && blad.kod !== 'password_code_required' ? <Sekcja stopka={blad.komunikat}>{null}</Sekcja> : null}

      <View style={styles.akcja}>
        <PrzyciskGlowny tytul="Zmień hasło" ikona="check-line" trwa={trwa === 'zapis'} onPress={() => void zapisz()} />
      </View>
    </EkranListy>
  );
}

const styles = StyleSheet.create({
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.l },
});
