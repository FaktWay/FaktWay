import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { DZIS } from '@/dane-przykladowe';
import { KONTRAHENCI } from '@/dane-przykladowe/kontrahenci';
import { PolePrzelacznik, PoleTekstowe } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { MA_ADRES_STRONY, otworzStrone } from '@/komponenty/na-stronie';
import { NaglowekKwoty } from '@/komponenty/naglowek';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { StanPusty } from '@/komponenty/stan-pusty';
import { SzkieletListy } from '@/komponenty/szkielet';
import { WierszFaktury } from '@/komponenty/wiersz-faktury';
import { potwierdz } from '@/komponenty/potwierdz';
import { PrzyciskPaska } from '@/komponenty/przycisk-paska';
import type { BladApi } from '@/lib/api/bledy';
import type { KontrahentTelefonu } from '@/lib/api/kontrakt-wiecej';
import { kwota } from '@/lib/format';
import { doZaplaty, ileFaktur, statusFaktury } from '@/lib/status-faktury';
import { useKontoFirmy } from '@/stan/dane';
import { useFlaga, useStanFaktur } from '@/stan/faktury';
import { grosze, useKontrahent, useZapisKontrahenta, type ZapisKontrahenta } from '@/stan/kontrahenci';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

export default function EkranKontrahenta() {
  const zapis = useZapisKontrahenta();
  return zapis ? <EkranKontrahentaZBazy zapis={zapis} /> : <EkranKontrahentaPrzyklad />;
}

const cyfry = (nip: string | undefined) => (nip ?? '').replace(/\D/g, '');

/**
 * Karta kontrahenta na prawdziwym koncie (M10e): dane, status VAT i należności
 * z serwera, poprawka nazwy, adresu i e-maila (jak okno edycji strony; NIP się
 * nie zmienia) i usunięcie z bazy podpowiedzi. Faktury tego kontrahenta z
 * listy faktur w telefonie (po NIP nabywcy). Przypomnienia o zapłacie dla
 * kontrahenta zmienia się na faktway.pl.
 */
function EkranKontrahentaZBazy({ zapis }: { zapis: ZapisKontrahenta }) {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const konto = useKontoFirmy();
  // Ekran na wierzchu stosu: zapis do firmy, w której go otwarto.
  const [firmaEkranu] = useState(konto?.firma?.id ?? null);
  const odczyt = useKontrahent(id);
  const { faktury } = useStanFaktur();
  const [edycja, setEdycja] = useState(false);
  const [pola, setPola] = useState({ nazwa: '', adres1: '', adres2: '', email: '' });
  const [blad, setBlad] = useState<BladApi>();
  const [trwa, setTrwa] = useState(false);

  const dane = odczyt?.dane;
  if (!dane) {
    return (
      <EkranListy>
        {odczyt?.stan === 'blad' ? (
          <StanPusty ikona="user-search-line" tytul="Nie udało się otworzyć kontrahenta" opis={odczyt.blad ?? 'Spróbuj ponownie za chwilę.'} akcja={{ tytul: 'Spróbuj ponownie', onPress: () => void odczyt.odswiez() }} />
        ) : (
          <SzkieletListy wiersze={5} etykieta="Wczytujemy kontrahenta" />
        )}
      </EkranListy>
    );
  }
  const k: KontrahentTelefonu = dane.kontrahent;
  const n = k.naleznosci;
  const jego = faktury.filter((f) => cyfry(f.nipKontrahenta) === cyfry(k.nip));

  const zacznijEdycje = () => {
    setPola({ nazwa: k.nazwa, adres1: k.adres.linia1, adres2: k.adres.linia2, email: k.email ?? '' });
    setBlad(undefined);
    setEdycja(true);
  };
  const zapiszZmiany = async () => {
    setTrwa(true);
    const w = await zapis.zmien(k.id, pola, firmaEkranu);
    setTrwa(false);
    if (!w.ok) {
      setBlad(w.blad);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    setEdycja(false);
    setBlad(undefined);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };
  const wykonajUsuniecie = async () => {
    setTrwa(true);
    const w = await zapis.usun(k.id, firmaEkranu);
    setTrwa(false);
    if (!w.ok) {
      setBlad(w.blad);
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  };
  const usun = () =>
    potwierdz({ tytul: `Usunąć kontrahenta ${k.nazwa}?`, opis: 'Wystawione faktury się nie zmienią.', potwierdz: 'Usuń kontrahenta' }, () => void wykonajUsuniecie());
  const bladPola = (pole: string) => (blad?.pole === pole ? blad.komunikat : undefined);
  const bladOgolny = blad && !blad.pole ? blad.komunikat : undefined;

  return (
    <>
      {dane.mozeEdytowac ? <PrzyciskPaska strona="prawa" tytul={edycja ? 'Anuluj' : 'Edytuj'} naGradiencie onPress={() => (edycja ? setEdycja(false) : zacznijEdycje())} /> : null}
      <EkranListy gradient keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets onOdswiez={edycja ? undefined : odczyt.odswiez}>
        <NaglowekKwoty
          podpis={k.nazwa || `NIP ${k.nip}`}
          podpisWyrozniony
          wartosc={n ? kwota(grosze(n.doZaplaty)) : 'Brak danych'}
          status={
            !n
              ? `Nie policzyliśmy należności${dane.bladNaleznosci ? `: ${dane.bladNaleznosci}` : ''}`
              : n.poTerminie > 0
                ? `Należności, w tym ${ileFaktur(n.poTerminie)} po terminie`
                : n.doZaplaty > 0
                  ? 'Należności, nic po terminie'
                  : 'Nic do zapłaty'
          }
          statusKolor={n && n.poTerminie > 0 ? 'ostrzezenie' : 'etykietaDrugorzedna'}
        />
        {jego[0] ? (
          <View style={styles.akcja}>
            <PrzyciskGlowny
              tytul="Wystaw fakturę"
              ikona="add-line"
              onPress={() => router.push({ pathname: '/faktury/nowa/[rodzaj]', params: { rodzaj: 'vat', wzor: jego[0]!.id, wprost: '1' } })}
            />
          </View>
        ) : null}

        <Sekcja naglowek="Dane" stopka={edycja ? 'NIP nie da się zmienić: to identyfikator kontrahenta. Wystawione faktury mają własną kopię danych i się nie zmienią.' : undefined}>
          {edycja ? (
            <>
              <Wiersz tytul="NIP" wartosc={k.nip} />
              <PoleTekstowe etykieta="Nazwa" wartosc={pola.nazwa} onZmiana={(nazwa) => setPola((p) => ({ ...p, nazwa }))} blad={bladPola('nazwa')} />
              <PoleTekstowe etykieta="Ulica i numer" wartosc={pola.adres1} onZmiana={(adres1) => setPola((p) => ({ ...p, adres1 }))} blad={bladPola('adres1')} />
              <PoleTekstowe etykieta="Kod i miejscowość" wartosc={pola.adres2} onZmiana={(adres2) => setPola((p) => ({ ...p, adres2 }))} blad={bladPola('adres2')} podpowiedz="00-001 Warszawa" />
              <PoleTekstowe etykieta="E-mail do faktur" wartosc={pola.email} onZmiana={(email) => setPola((p) => ({ ...p, email }))} klawiatura="email-address" blad={bladPola('email')} />
            </>
          ) : (
            <>
              <Wiersz tytul="NIP" wartosc={k.nip} zaznaczalna />
              <Wiersz tytul="Status VAT" wartosc={k.statusVatEtykieta} wartoscKolor={k.vatDoSprawdzenia ? 'ostrzezenie' : 'sukces'} />
              {k.ostrzezenie ? <Wiersz tytul="Uwaga" podtytul={k.ostrzezenie} /> : null}
              <Wiersz tytul="Adres" podtytul={[k.adres.linia1, k.adres.linia2].filter(Boolean).join('\n') || 'Nie podano'} zaznaczalna />
              {k.email ? <Wiersz tytul="E-mail do faktur" podtytul={k.email} zaznaczalna /> : null}
              {k.telefon ? <Wiersz tytul="Telefon" podtytul={k.telefon} zaznaczalna /> : null}
            </>
          )}
        </Sekcja>
        {bladOgolny ? <Sekcja stopka={bladOgolny} /> : null}
        {edycja ? (
          <View style={styles.akcja}>
            <PrzyciskGlowny tytul="Zapisz zmiany" trwa={trwa} onPress={() => void zapiszZmiany()} />
          </View>
        ) : null}

        <Sekcja
          naglowek="Przypomnienia"
          stopka={k.przypomnieniaWylaczone ? `Wyłączone dla tego kontrahenta${k.powodWylaczenia ? `: ${k.powodWylaczenia}` : ''}.` : 'Przypomnienia o zapłacie obejmują faktury tego kontrahenta.'}>
          <Wiersz tytul="Przypominaj o zapłacie" wartosc={k.przypomnieniaWylaczone ? 'Wyłączone' : 'Włączone'} />
          {MA_ADRES_STRONY && dane.mozeEdytowac ? <Wiersz tytul="Zmień na faktway.pl" ikona="global-line" akcja onPress={() => otworzStrone('/contractors', () => void odczyt.odswiez())} /> : null}
        </Sekcja>

        {jego.length > 0 ? (
          <Sekcja naglowek="Faktury" stopka="Z ostatnich faktur w telefonie.">
            {jego.map((f) => (
              <WierszFaktury key={f.id} faktura={f} />
            ))}
          </Sekcja>
        ) : null}

        {dane.mozeEdytowac ? (
          <Sekcja stopka="Usuwamy kontrahenta z bazy podpowiedzi. Wystawione faktury się nie zmienią.">
            <Wiersz tytul="Usuń kontrahenta" niszczacy onPress={trwa ? undefined : usun} />
          </Sekcja>
        ) : (
          <Sekcja stopka="Księgowa widzi kontrahentów, ale ich nie zmienia." />
        )}
      </EkranListy>
    </>
  );
}

/** Karta kontrahenta na danych przykładowych: dane, należności, faktury, przypomnienia, edycja i usunięcie. */
function EkranKontrahentaPrzyklad() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { faktury, ustawFlage } = useStanFaktur();
  const k = KONTRAHENCI.find((x) => x.id === id);
  const [ulica, miasto] = k?.adres.split(', ') ?? [];
  const [nazwa, setNazwa] = useState(k?.nazwa ?? '');
  const [adres1, setAdres1] = useState(ulica ?? '');
  const [adres2, setAdres2] = useState(miasto ?? '');
  const [email, setEmail] = useState(k?.email ?? '');
  const [edycja, setEdycja] = useState(false);
  const [przypomnienia, setPrzypomnienia] = useFlaga(`przypomnienia-kontrahent-${id}`, k?.przypomnienia ?? true);

  if (!k) return <StanPusty ikona="user-search-line" tytul="Nie ma takiego kontrahenta" opis="Mógł zostać usunięty na komputerze." />;
  const jego = faktury.filter((f) => f.kontrahent === k.nazwa);
  const otwarte = jego.filter(doZaplaty);
  const zalegle = otwarte.filter((f) => statusFaktury(f, DZIS).zalegla);

  return (
    <>
      <PrzyciskPaska strona="prawa" tytul={edycja ? 'Gotowe' : 'Edytuj'} naGradiencie onPress={() => setEdycja(!edycja)} />
      <EkranListy gradient keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        <NaglowekKwoty
          podpis={nazwa}
          podpisWyrozniony
          wartosc={kwota(otwarte.reduce((s, f) => s + f.brutto, 0))}
          status={zalegle.length > 0 ? `W tym po terminie ${kwota(zalegle.reduce((s, f) => s + f.brutto, 0))}` : 'Należności, nic po terminie'}
          statusKolor={zalegle.length > 0 ? 'ostrzezenie' : 'etykietaDrugorzedna'}
        />
        <View style={styles.akcja}>
          <PrzyciskGlowny tytul="Wystaw fakturę" ikona="add-line" onPress={() => router.push({ pathname: '/faktury/nowa/[rodzaj]', params: { rodzaj: 'vat', wzor: jego[0]?.id ?? '', wprost: '1' } })} />
        </View>

        <Sekcja naglowek="Dane" stopka={edycja ? 'NIP nie da się zmienić: to identyfikator kontrahenta.' : undefined}>
          {edycja ? (
            <>
              <PoleTekstowe etykieta="Nazwa" wartosc={nazwa} onZmiana={setNazwa} />
              <PoleTekstowe etykieta="Ulica i numer" wartosc={adres1} onZmiana={setAdres1} />
              <PoleTekstowe etykieta="Kod i miejscowość" wartosc={adres2} onZmiana={setAdres2} />
              <PoleTekstowe etykieta="E-mail do faktur" wartosc={email} onZmiana={setEmail} klawiatura="email-address" />
              <Wiersz
                tytul="Zapisz"
                akcja
                onPress={() => {
                  setEdycja(false);
                  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                }}
              />
            </>
          ) : (
            <>
              <Wiersz tytul="NIP" wartosc={k.nip} zaznaczalna />
              <Wiersz tytul="Status VAT" wartosc="Czynny VAT" wartoscKolor="sukces" />
              <Wiersz tytul="Adres" podtytul={`${adres1}\n${adres2}`} zaznaczalna />
              {email ? <Wiersz tytul="E-mail do faktur" podtytul={email} zaznaczalna /> : null}
              {k.telefon ? <Wiersz tytul="Telefon" podtytul={k.telefon} zaznaczalna /> : null}
              <Wiersz tytul="Termin płatności" wartosc={`${k.terminDni} dni`} />
            </>
          )}
        </Sekcja>

        <Sekcja naglowek="Przypomnienia" stopka="Przypomnienia o zapłacie dla faktur tego kontrahenta.">
          <PolePrzelacznik etykieta="Przypominaj o zapłacie" wartosc={przypomnienia} onZmiana={setPrzypomnienia} />
        </Sekcja>

        {jego.length > 0 ? (
          <Sekcja naglowek="Faktury">
            {jego.map((f) => (
              <WierszFaktury key={f.id} faktura={f} />
            ))}
          </Sekcja>
        ) : null}

        <Sekcja stopka="Wystawione faktury się nie zmienią.">
          <Wiersz
            tytul="Usuń kontrahenta"
            niszczacy
            onPress={() =>
              potwierdz({ tytul: `Usunąć kontrahenta ${k.nazwa}?`, opis: 'Wystawione faktury się nie zmienią.', potwierdz: 'Usuń kontrahenta' }, () => {
                ustawFlage(`kontrahent-usuniety-${k.id}`, true);
                router.back();
              })
            }
          />
        </Sekcja>
      </EkranListy>
    </>
  );
}

const styles = StyleSheet.create({
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.l },
});
