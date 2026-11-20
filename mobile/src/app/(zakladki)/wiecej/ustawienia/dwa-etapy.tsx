import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import { PoleTekstowe } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { potwierdz } from '@/komponenty/potwierdz';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { PrzyciskPaska } from '@/komponenty/przycisk-paska';
import { StanPusty } from '@/komponenty/stan-pusty';
import type { BladApi } from '@/lib/api/bledy';
import type { Wlaczenie2faOdpowiedz } from '@/lib/api/kontrakt-bezpieczenstwo';
import { useZapisBezpieczenstwa, type ZapisBezpieczenstwa } from '@/stan/bezpieczenstwo';
import { useKontoFirmy } from '@/stan/dane';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

/**
 * Weryfikacja dwuetapowa z telefonu (M10c, część 2b): arkusz z „Anuluj” w
 * pasku. Włączanie jak na stronie, ale bez kodu QR: ten sam telefon nie
 * zeskanuje własnego ekranu, więc pokazujemy klucz do wpisania i przycisk
 * otwierający aplikację uwierzytelniającą (adres `otpauth://`). Pierwszy kod
 * kończy włączanie. Wyłączenie wymaga aktualnego hasła. Limity prób, hasło i
 * stan czynników sprawdza serwer tymi samymi zasadami co strona; jego zdanie
 * stoi pod polem. Tryb (włączanie albo wyłączanie) wynika ze stanu konta z
 * chwili otwarcia, żeby wynik pokazać na tym samym ekranie.
 */
export default function EkranDwochEtapow() {
  const router = useRouter();
  const zapis = useZapisBezpieczenstwa();
  const konto = useKontoFirmy();
  const [wlaczone] = useState(konto?.konto?.dwaEtapy.wlaczone);

  const pasek = (
    <>
      <Stack.Screen options={{ title: 'Weryfikacja dwuetapowa' }} />
      <PrzyciskPaska strona="lewa" tytul="Anuluj" onPress={() => router.back()} />
    </>
  );
  if (!zapis || wlaczone === undefined) {
    return (
      <EkranListy>
        {pasek}
        <StanPusty ikona="shield-keyhole-line" tytul="Nie ma czego zmienić" opis="Weryfikację dwuetapową zmienisz na prawdziwym koncie, gdy dane konta są wczytane." />
      </EkranListy>
    );
  }
  return (
    <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      {pasek}
      {wlaczone ? <Wylaczenie zapis={zapis} /> : <Wlaczenie zapis={zapis} />}
    </EkranListy>
  );
}

function Gotowe({ ikona, tytul, opis }: { ikona: 'shield-check-line' | 'shield-keyhole-line'; tytul: string; opis: string }) {
  const router = useRouter();
  return <StanPusty ikona={ikona} tytul={tytul} opis={opis} akcja={{ tytul: 'Gotowe', onPress: () => router.back() }} />;
}

function Wlaczenie({ zapis }: { zapis: ZapisBezpieczenstwa }) {
  const [faza, setFaza] = useState<'start' | 'kod' | 'gotowe'>('start');
  const [czynnik, setCzynnik] = useState<Wlaczenie2faOdpowiedz>();
  const [kod, setKod] = useState('');
  const [blad, setBlad] = useState<BladApi>();
  const [nota, setNota] = useState<string>();
  const [trwa, setTrwa] = useState(false);

  const odmowa = (b: BladApi) => {
    setBlad(b);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  };

  const zacznij = async () => {
    setTrwa(true);
    setBlad(undefined);
    const w = await zapis.startDwaEtapy();
    setTrwa(false);
    if (!w.ok) return odmowa(w.blad);
    setCzynnik(w.dane);
    setFaza('kod');
  };

  const wlacz = async () => {
    if (!czynnik) return;
    setTrwa(true);
    setBlad(undefined);
    const w = await zapis.potwierdzDwaEtapy(czynnik.idFaktora, kod);
    setTrwa(false);
    if (!w.ok) return odmowa(w.blad);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setFaza('gotowe');
  };

  const otworzAplikacje = async () => {
    if (!czynnik) return;
    setNota(undefined);
    try {
      await Linking.openURL(czynnik.uri);
    } catch {
      setNota('Nie znaleźliśmy aplikacji uwierzytelniającej na tym telefonie. Zainstaluj ją i wpisz klucz ręcznie.');
    }
  };

  const skopiuj = async () => {
    if (!czynnik) return;
    await Clipboard.setStringAsync(czynnik.sekret);
    setNota('Klucz skopiowany. Wklej go w aplikacji uwierzytelniającej.');
  };

  if (faza === 'gotowe') {
    return <Gotowe ikona="shield-check-line" tytul="Weryfikacja dwuetapowa włączona" opis="Przy logowaniu i zmianach wrażliwych poprosimy o kod z aplikacji. Możesz teraz podłączyć KSeF." />;
  }
  if (faza === 'start' || !czynnik) {
    return (
      <>
        <Sekcja stopka="Dodatkowa ochrona konta: oprócz hasła prosimy o kod z aplikacji uwierzytelniającej na tym telefonie (np. Google Authenticator, Microsoft Authenticator, 1Password). Weryfikacja jest wymagana, żeby podłączyć KSeF i zmieniać ustawienia wrażliwe.">{null}</Sekcja>
        {blad ? <Sekcja stopka={blad.komunikat}>{null}</Sekcja> : null}
        <View style={styles.akcja}>
          <PrzyciskGlowny tytul="Zacznij" trwa={trwa} onPress={() => void zacznij()} />
        </View>
      </>
    );
  }
  return (
    <>
      <Sekcja naglowek="1. Dodaj konto w aplikacji uwierzytelniającej" stopka={nota ?? 'Dotknij przycisku poniżej albo wpisz klucz ręcznie, wybierając w aplikacji „Wpisz klucz”.'}>
        <Wiersz tytul="Klucz" podtytul={czynnik.sekret} zaznaczalna />
        <Wiersz tytul="Otwórz w aplikacji uwierzytelniającej" ikona="shield-keyhole-line" akcja onPress={() => void otworzAplikacje()} />
        <Wiersz tytul="Skopiuj klucz" akcja onPress={() => void skopiuj()} />
      </Sekcja>
      <Sekcja naglowek="2. Wpisz kod z aplikacji">
        <PoleTekstowe etykieta="Kod (6 cyfr)" wartosc={kod} onZmiana={setKod} klawiatura="number-pad" cyfry podpowiedz="000000" blad={blad?.pole === 'kod' ? blad.komunikat : undefined} />
      </Sekcja>
      {blad && blad.pole !== 'kod' ? <Sekcja stopka={blad.komunikat}>{null}</Sekcja> : null}
      <View style={styles.akcja}>
        <PrzyciskGlowny tytul="Włącz weryfikację" ikona="check-line" trwa={trwa} onPress={() => void wlacz()} />
      </View>
    </>
  );
}

function Wylaczenie({ zapis }: { zapis: ZapisBezpieczenstwa }) {
  const [haslo, setHaslo] = useState('');
  const [blad, setBlad] = useState<BladApi>();
  const [trwa, setTrwa] = useState(false);
  const [gotowe, setGotowe] = useState(false);

  const wylacz = () =>
    potwierdz(
      { tytul: 'Wyłączyć weryfikację dwuetapową?', opis: 'Konto będzie chronione tylko hasłem, a certyfikatu KSeF nie wgrasz, dopóki jej nie włączysz.', potwierdz: 'Wyłącz' },
      () => {
        setTrwa(true);
        setBlad(undefined);
        void zapis.wylaczDwaEtapy(haslo).then((w) => {
          setTrwa(false);
          if (!w.ok) {
            setBlad(w.blad);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
            return;
          }
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          setHaslo('');
          setGotowe(true);
        });
      },
    );

  if (gotowe) return <Gotowe ikona="shield-keyhole-line" tytul="Weryfikacja dwuetapowa wyłączona" opis="Włączysz ją ponownie w Bezpieczeństwie." />;
  return (
    <>
      <Sekcja naglowek="Potwierdź hasłem" stopka="Wyłączenie usuwa kody z aplikacji uwierzytelniającej z tego konta.">
        <PoleTekstowe etykieta="Aktualne hasło" wartosc={haslo} onZmiana={setHaslo} tajne autouzupelnianie="haslo" blad={blad?.pole === 'obecne' ? blad.komunikat : undefined} />
      </Sekcja>
      {blad && blad.pole !== 'obecne' ? <Sekcja stopka={blad.komunikat}>{null}</Sekcja> : null}
      <View style={styles.akcja}>
        <PrzyciskGlowny tytul="Wyłącz weryfikację" trwa={trwa} onPress={wylacz} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.l },
});
