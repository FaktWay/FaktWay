import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { PoleDaty, PolePrzelacznik, PoleTekstowe, PoleWyboru } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { PrzyciskPaska } from '@/komponenty/przycisk-paska';
import { StanPusty } from '@/komponenty/stan-pusty';
import { SzkieletListy } from '@/komponenty/szkielet';
import type { UstawieniaOdpowiedz } from '@/lib/api/kontrakt';
import type { BladApi } from '@/lib/api/bledy';
import { PODSTAWY_ZWOLNIENIA_VAT, type ZmianaFirmyZadanie } from '@/lib/api/kontrakt-ustawienia';
import { dzienWarszawa } from '@/lib/dane/mapowanie';
import { useKontoFirmy } from '@/stan/dane';
import { useUstawienia } from '@/stan/ustawienia';
import { useOchronaZmian, useZapisUstawien, type ZapisUstawien } from '@/stan/ustawienia-zapis';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

type Co = 'dane' | 'rachunek' | 'vat' | 'rozpoczecie';
const TYTUL: Record<Co, string> = { dane: 'Dane firmy', rachunek: 'Rachunek do faktur', vat: 'Podatek VAT', rozpoczecie: 'Data rozpoczęcia' };
const INNA = 'inna';
const OPCJE_ZWOLNIENIA = [
  ...PODSTAWY_ZWOLNIENIA_VAT.map((p) => ({ wartosc: p.podstawa as string, etykieta: p.etykieta as string })),
  { wartosc: INNA, etykieta: 'Inna podstawa (np. zwolnienie przedmiotowe z art. 43)' },
];

const jakCo = (w: string | undefined): Co | null => (w === 'dane' || w === 'rachunek' || w === 'vat' || w === 'rozpoczecie' ? w : null);
/** Jak `normalizeExemptionBasis` strony: porównujemy po oczyszczeniu, żeby sama spacja nie była zmianą. */
const czysty = (t: string) => t.trim().replace(/\s+/g, ' ');

/**
 * Zmiana karty Firma z telefonu (M10c): arkusz z „Anuluj” w pasku i „Zapisz”
 * w treści, jedna część karty naraz (`co`: dane, rachunek, VAT, data
 * rozpoczęcia), jak osobne formularze strony. Zasady (schemat danych firmy,
 * numer rachunku, data nie z przyszłości, podstawa zwolnienia) i rolę
 * (właściciel albo administrator) sprawdza serwer; jego zdanie stoi pod polem.
 * VAT to dwie zmiany strony (zwolnienie, metoda kasowa), wysyłane po kolei,
 * tylko te, które się zmieniły.
 */
export default function EkranZmianyFirmy() {
  const { co: param } = useLocalSearchParams<{ co?: string }>();
  const co = jakCo(param);
  const ustawienia = useUstawienia();
  const zapis = useZapisUstawien();
  const konto = useKontoFirmy();
  const [firmaEkranu] = useState(konto?.firma?.id ?? null);
  const router = useRouter();

  const pasek = (
    <>
      <Stack.Screen options={{ title: co ? TYTUL[co] : 'Firma' }} />
      <PrzyciskPaska strona="lewa" tytul="Anuluj" onPress={() => router.back()} />
    </>
  );
  if (!co || !ustawienia || !zapis) {
    return (
      <EkranListy>
        {pasek}
        <StanPusty ikona="building2-line" tytul="Nie ma czego zmienić" opis="Dane firmy zmieniasz na prawdziwym koncie, w karcie Firma." />
      </EkranListy>
    );
  }
  const firma = ustawienia.dane?.firma;
  if (!firma) {
    return (
      <EkranListy>
        {pasek}
        {ustawienia.stan === 'blad' ? (
          <StanPusty ikona="error-warning-line" tytul="Nie udało się wczytać danych firmy" opis={ustawienia.blad ?? 'Spróbuj ponownie za chwilę.'} akcja={{ tytul: 'Spróbuj ponownie', onPress: () => void ustawienia.odswiez() }} />
        ) : (
          <SzkieletListy wiersze={3} etykieta="Wczytujemy dane firmy" />
        )}
      </EkranListy>
    );
  }
  return <Formularz co={co} firma={firma} zapis={zapis} firmaEkranu={firmaEkranu} />;
}

type Firma = UstawieniaOdpowiedz['firma'];

function Formularz({ co, firma, zapis, firmaEkranu }: { co: Co; firma: Firma; zapis: ZapisUstawien; firmaEkranu: string | null }) {
  const router = useRouter();
  const [nazwa, setNazwa] = useState(firma.nazwa);
  const [adres1, setAdres1] = useState(firma.adres.linia1);
  const [adres2, setAdres2] = useState(firma.adres.linia2);
  const [rachunekTekst, setRachunek] = useState(firma.rachunek ?? '');
  const [data, setData] = useState<string | null>(firma.rozpoczecie);
  const znana = PODSTAWY_ZWOLNIENIA_VAT.find((p) => p.podstawa === firma.zwolnienie)?.podstawa;
  const [zwolniona, setZwolniona] = useState(firma.zwolnienie !== null);
  const [wybor, setWybor] = useState<string>(znana ?? (firma.zwolnienie ? INNA : PODSTAWY_ZWOLNIENIA_VAT[0].podstawa));
  const [inna, setInna] = useState(znana ? '' : (firma.zwolnienie ?? ''));
  const [kasowa, setKasowa] = useState(firma.metodaKasowa);
  const [blad, setBlad] = useState<BladApi>();
  const [trwa, setTrwa] = useState(false);

  const podstawa = zwolniona ? (wybor === INNA ? inna : wybor) : '';
  const zmiany: ZmianaFirmyZadanie[] = [];
  if (co === 'dane' && (czysty(nazwa) !== firma.nazwa || czysty(adres1) !== firma.adres.linia1 || czysty(adres2) !== firma.adres.linia2)) {
    zmiany.push({ zmiana: 'dane', nazwa, adres1, adres2 });
  }
  if (co === 'rachunek' && rachunekTekst.replace(/\s/g, '') !== (firma.rachunek ?? '').replace(/\s/g, '')) zmiany.push({ zmiana: 'rachunek', rachunek: rachunekTekst });
  if (co === 'rozpoczecie' && data !== firma.rozpoczecie) zmiany.push({ zmiana: 'rozpoczecie', data: data ?? '' });
  if (co === 'vat' && czysty(podstawa) !== (firma.zwolnienie ?? '')) zmiany.push({ zmiana: 'zwolnienie', podstawa });
  if (co === 'vat' && kasowa !== firma.metodaKasowa) zmiany.push({ zmiana: 'metodaKasowa', wlaczona: kasowa });

  const ochrona = useOchronaZmian(zmiany.length > 0);
  /** Pola z miejscem na zdanie serwera; reszta odmów (także daty, bez pola tekstowego) stoi nad przyciskiem. */
  const polaNaEkranie: string[] = { dane: ['nazwa', 'adres1', 'adres2'], rachunek: ['rachunek'], rozpoczecie: [], vat: zwolniona && wybor === INNA ? ['podstawa'] : [] }[co];
  const bladPola = (pole: string) => (blad?.pole === pole ? blad.komunikat : undefined);

  const zapisz = async () => {
    if (zmiany.length === 0) {
      router.back();
      return;
    }
    setTrwa(true);
    setBlad(undefined);
    // Po kolei: przy odmowie drugiej zmiany pierwsza jest już zapisana i karta pod arkuszem ją pokazuje.
    for (const z of zmiany) {
      const w = await zapis.firma(z, firmaEkranu);
      if (!w.ok) {
        setTrwa(false);
        setBlad(w.blad);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    ochrona.zamknij();
  };

  return (
    <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Stack.Screen options={{ title: TYTUL[co] }} />
      <PrzyciskPaska strona="lewa" tytul="Anuluj" onPress={() => router.back()} />

      {co === 'dane' ? (
        <Sekcja stopka="Trafia na każdą kolejną fakturę i do JPK. Wystawione faktury zostają z dotychczasowymi danymi. NIP zmienia się tylko przez pomoc FaktWay.">
          <Wiersz tytul="NIP" wartosc={firma.nip || 'Brak'} zaznaczalna />
          <PoleTekstowe etykieta="Nazwa firmy" wartosc={nazwa} onZmiana={setNazwa} blad={bladPola('nazwa')} />
          <PoleTekstowe etykieta="Ulica i numer" wartosc={adres1} onZmiana={setAdres1} blad={bladPola('adres1')} />
          <PoleTekstowe etykieta="Kod i miejscowość" wartosc={adres2} onZmiana={setAdres2} podpowiedz="00-001 Warszawa" blad={bladPola('adres2')} />
        </Sekcja>
      ) : null}

      {co === 'rachunek' ? (
        <Sekcja stopka="Numer na fakturach i rachunek, z którego plik przelewów zleca zapłaty za wydatki. Pusty: bez rachunku.">
          <PoleTekstowe etykieta="Numer rachunku" wartosc={rachunekTekst} onZmiana={setRachunek} klawiatura="number-pad" cyfry podpowiedz="26 cyfr" blad={bladPola('rachunek')} />
        </Sekcja>
      ) : null}

      {co === 'rozpoczecie' ? (
        <Sekcja stopka="Od tej daty liczymy limit zwolnienia z VAT w pierwszym roku i ulgę na start.">
          {data ? <PoleDaty etykieta="Data rozpoczęcia działalności" wartosc={data} onZmiana={setData} /> : null}
          {data ? (
            <Wiersz tytul="Usuń datę" niszczacy onPress={() => setData(null)} />
          ) : (
            <Wiersz tytul="Podaj datę rozpoczęcia" akcja onPress={() => setData(firma.rozpoczecie ?? dzienWarszawa())} />
          )}
        </Sekcja>
      ) : null}

      {co === 'vat' ? (
        <>
          <Sekcja stopka="Zmienia treść każdej kolejnej faktury wysyłanej do KSeF.">
            <PolePrzelacznik etykieta="Moja firma jest zwolniona z VAT" wartosc={zwolniona} onZmiana={setZwolniona} />
            {zwolniona ? <PoleWyboru etykieta="Podstawa prawna zwolnienia" wartosc={wybor} opcje={OPCJE_ZWOLNIENIA} onZmiana={setWybor} /> : null}
            {zwolniona && wybor === INNA ? (
              <PoleTekstowe etykieta="Inna podstawa prawna" wartosc={inna} onZmiana={setInna} podpowiedz="np. art. 43 ust. 1 pkt 29 lit. c ustawy o VAT" blad={bladPola('podstawa')} />
            ) : null}
          </Sekcja>
          <Sekcja stopka="Na fakturach pojawią się wtedy wymagane wyrazy „metoda kasowa”. Nie dotyczy firm zwolnionych z VAT.">
            <PolePrzelacznik etykieta="Rozliczam VAT metodą kasową" wartosc={kasowa} onZmiana={setKasowa} />
          </Sekcja>
        </>
      ) : null}

      {blad && !(blad.pole && polaNaEkranie.includes(blad.pole)) ? <Sekcja stopka={blad.komunikat}>{null}</Sekcja> : null}

      <View style={styles.akcja}>
        <PrzyciskGlowny tytul="Zapisz" ikona="check-line" trwa={trwa} onPress={() => void zapisz()} />
      </View>
    </EkranListy>
  );
}

const styles = StyleSheet.create({
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.l },
});
