import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { PoleTekstowe } from '@/komponenty/formularz';
import { EkranListy, Sekcja } from '@/komponenty/lista';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { PrzyciskPaska } from '@/komponenty/przycisk-paska';
import { StanPusty } from '@/komponenty/stan-pusty';
import type { BladApi } from '@/lib/api/bledy';
import { useKontoFirmy } from '@/stan/dane';
import { useZapisKontrahenta } from '@/stan/kontrahenci';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

/**
 * Nowy kontrahent (M10e): polski NIP i dane wpisane ręcznie. NIP (suma
 * kontrolna), granice pól i rolę sprawdza serwer tymi samymi zasadami co
 * strona; jego zdanie stoi pod polem. Ten sam NIP z tymi samymi danymi
 * (ponowienie po zerwanym połączeniu) otwiera zapisanego kontrahenta.
 * Kontrahentów z faktur zapisujemy sami, ten ekran jest dla tych, którym
 * faktury jeszcze nie wystawiono.
 */
export default function EkranNowegoKontrahenta() {
  const router = useRouter();
  const zapis = useZapisKontrahenta();
  const konto = useKontoFirmy();
  const [firmaEkranu] = useState(konto?.firma?.id ?? null);
  const [pola, setPola] = useState({ nip: '', nazwa: '', adres1: '', adres2: '', email: '' });
  const [blad, setBlad] = useState<BladApi>();
  const [trwa, setTrwa] = useState(false);

  if (!zapis) {
    return (
      <EkranListy>
        <StanPusty ikona="contacts-book3-line" tytul="Dane przykładowe" opis="Na danych przykładowych kontrahentów zapisujemy z faktur." />
      </EkranListy>
    );
  }

  const ustaw = (pole: keyof typeof pola) => (wartosc: string) => setPola((p) => ({ ...p, [pole]: wartosc }));
  const bladPola = (pole: string) => (blad?.pole === pole ? blad.komunikat : undefined);
  const zapisz = async () => {
    setTrwa(true);
    const w = await zapis.dodaj(pola, firmaEkranu);
    setTrwa(false);
    if (!w.ok) {
      setBlad(w.blad);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.replace({ pathname: '/wiecej/kontrahenci/[id]', params: { id: w.dane.kontrahent.id } });
  };

  return (
    <>
      <PrzyciskPaska strona="lewa" tytul="Anuluj" onPress={() => router.back()} />
      <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        <Sekcja naglowek="Kontrahent" stopka="NIP to identyfikator kontrahenta: później go nie zmienisz.">
          <PoleTekstowe etykieta="NIP" wartosc={pola.nip} onZmiana={ustaw('nip')} klawiatura="number-pad" podpowiedz="10 cyfr" blad={bladPola('nip')} />
          <PoleTekstowe etykieta="Nazwa" wartosc={pola.nazwa} onZmiana={ustaw('nazwa')} blad={bladPola('nazwa')} />
          <PoleTekstowe etykieta="Ulica i numer" wartosc={pola.adres1} onZmiana={ustaw('adres1')} blad={bladPola('adres1')} />
          <PoleTekstowe etykieta="Kod i miejscowość" wartosc={pola.adres2} onZmiana={ustaw('adres2')} podpowiedz="00-001 Warszawa" blad={bladPola('adres2')} />
          <PoleTekstowe etykieta="E-mail do faktur" wartosc={pola.email} onZmiana={ustaw('email')} klawiatura="email-address" blad={bladPola('email')} />
        </Sekcja>
        {blad && !blad.pole ? <Sekcja stopka={blad.komunikat} /> : null}
        <View style={styles.akcja}>
          <PrzyciskGlowny tytul="Dodaj kontrahenta" trwa={trwa} onPress={() => void zapisz()} />
        </View>
      </EkranListy>
    </>
  );
}

const styles = StyleSheet.create({
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.l },
});
