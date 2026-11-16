import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { PolePrzelacznik, PoleTekstowe, PoleWyboru } from '@/komponenty/formularz';
import { EkranListy, Sekcja } from '@/komponenty/lista';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { StanPusty } from '@/komponenty/stan-pusty';
import { SzkieletListy } from '@/komponenty/szkielet';
import type { BladApi } from '@/lib/api/bledy';
import type { UstawieniaOdpowiedz } from '@/lib/api/kontrakt';
import type { PrzypomnieniaZadanie } from '@/lib/api/kontrakt-ustawienia';
import { useKontoFirmy } from '@/stan/dane';
import { useUstawienia, type StanUstawien } from '@/stan/ustawienia';
import { useOchronaZmian, useZapisUstawien, type ZapisUstawien } from '@/stan/ustawienia-zapis';
import { useStanFaktur } from '@/stan/faktury';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

const ETAPY = [
  { klucz: '1', nazwa: 'Etap 1: Uprzejme przypomnienie', dni: '3' },
  { klucz: '2', nazwa: 'Etap 2: Stanowcze przypomnienie', dni: '7' },
  { klucz: '3', nazwa: 'Etap 3: Przedsądowe wezwanie', dni: '14' },
];

const GODZINY = Array.from({ length: 13 }, (_, i) => String(i + 6));

export default function EkranPrzypomnienOZaplacie() {
  const ustawienia = useUstawienia();
  if (ustawienia) return <EkranPrzypomnienZBazy ustawienia={ustawienia} />;
  return <EkranUstawienPrzypomnien />;
}

/**
 * Przypomnienia na prawdziwym koncie (M10b, zapis od M10c): formularz strony
 * z `GET /ustawienia`, tylko dla właściciela (jak zakładka strony). Granice
 * (dni po terminie, godzina, liczba przypomnień) i adres sprawdza serwer tym
 * samym zakresem co strona; jego zdanie stoi pod polem. Bez zapisu FaktWay nie
 * przygotowuje przypomnień, więc formularz pokazuje wtedy „wyłączone”, a zapis
 * je włącza. Same przypomnienia (podgląd, zgoda, wstrzymanie) idą z telefonu
 * od M10a.
 */
function EkranPrzypomnienZBazy({ ustawienia }: { ustawienia: StanUstawien }) {
  const zapis = useZapisUstawien();
  const konto = useKontoFirmy();
  const [firmaEkranu] = useState(konto?.firma?.id ?? null);
  const { dane } = ustawienia;
  if (!dane) {
    return (
      <EkranListy>
        {ustawienia.stan === 'blad' ? (
          <StanPusty ikona="error-warning-line" tytul="Nie udało się wczytać przypomnień" opis={ustawienia.blad ?? 'Spróbuj ponownie za chwilę.'} akcja={{ tytul: 'Spróbuj ponownie', onPress: () => void ustawienia.odswiez() }} />
        ) : (
          <SzkieletListy wiersze={4} etykieta="Wczytujemy przypomnienia" />
        )}
      </EkranListy>
    );
  }
  const p = dane.przypomnienia;
  if (!p || !zapis) {
    return (
      <EkranListy>
        <StanPusty ikona="shield-keyhole-line" tytul="Przypomnienia ustawia właściciel firmy" opis="Etapy, godzinę wysyłki i nadawcę ustawia właściciel firmy." />
      </EkranListy>
    );
  }
  // Klucz: po zmianie firmy formularz zaczyna od jej ustawień (zapis i tak idzie tylko do firmy z otwarcia).
  return <FormularzPrzypomnien key={konto?.firma?.id ?? ''} p={p} zapis={zapis} firmaEkranu={firmaEkranu} />;
}

type Przypomnienia = NonNullable<UstawieniaOdpowiedz['przypomnienia']>;

function zadanie(p: Przypomnienia): PrzypomnieniaZadanie {
  return {
    wlaczone: p.zapisane && p.wlaczone,
    etapy: p.etapy.map((e) => ({ etap: e.etap, wlaczony: e.wlaczony, dniPoTerminie: e.dniPoTerminie })),
    godzina: p.godzina,
    tylkoDniRobocze: p.tylkoDniRobocze,
    najwiecej: p.najwiecej,
    nadawca: p.nadawca ?? '',
    odpowiedzNa: p.odpowiedzNa ?? '',
    wstrzymajPoOdpowiedzi: p.wstrzymajPoOdpowiedzi,
    wstrzymajPoCzesciowej: p.wstrzymajPoCzesciowej,
  };
}

/** Liczba z pola: same cyfry; pusty albo zły tekst idzie jako 0 i serwer mówi, jaki jest zakres. */
const liczba = (t: string) => (/^\d{1,3}$/.test(t.trim()) ? Number(t.trim()) : 0);

function FormularzPrzypomnien({ p, zapis, firmaEkranu }: { p: Przypomnienia; zapis: ZapisUstawien; firmaEkranu: string | null }) {
  const [start, setStart] = useState(() => zadanie(p));
  const [f, setF] = useState(start);
  const [dni, setDni] = useState(() => start.etapy.map((e) => String(e.dniPoTerminie)));
  const [maks, setMaks] = useState(String(start.najwiecej));
  const [blad, setBlad] = useState<BladApi>();
  const [trwa, setTrwa] = useState(false);
  const [zapisane, setZapisane] = useState(p.zapisane);

  const tresc: PrzypomnieniaZadanie = {
    ...f,
    etapy: f.etapy.map((e, i) => ({ ...e, dniPoTerminie: liczba(dni[i] ?? '') })),
    najwiecej: liczba(maks),
  };
  const zmienione = JSON.stringify(tresc) !== JSON.stringify(start) || !zapisane;
  useOchronaZmian(JSON.stringify(tresc) !== JSON.stringify(start));
  const ustaw = <K extends keyof PrzypomnieniaZadanie>(k: K, w: PrzypomnieniaZadanie[K]) => setF((x) => ({ ...x, [k]: w }));
  const ustawEtap = (i: number, wlaczony: boolean) => setF((x) => ({ ...x, etapy: x.etapy.map((e, j) => (j === i ? { ...e, wlaczony } : e)) }));
  const bladPola = (pole: string) => (blad?.pole === pole ? blad.komunikat : undefined);

  const zapisz = async () => {
    setTrwa(true);
    setBlad(undefined);
    const w = await zapis.przypomnienia(tresc, firmaEkranu);
    setTrwa(false);
    if (!w.ok) {
      setBlad(w.blad);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const po = w.dane.przypomnienia;
    if (po) {
      const nowy = zadanie(po);
      setStart(nowy);
      setF(nowy);
      setDni(nowy.etapy.map((e) => String(e.dniPoTerminie)));
      setMaks(String(nowy.najwiecej));
      setZapisane(po.zapisane);
    }
  };

  return (
    <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Sekcja
        stopka={
          zapisane
            ? 'Przypomnienia przygotowujemy do Twojego zatwierdzenia. Nic nie wychodzi samo.'
            : 'Firma nie zapisała jeszcze ustawień, więc FaktWay nie przygotowuje przypomnień. Włącz je i zapisz; każde przypomnienie i tak czeka na Twoje zatwierdzenie.'
        }>
        <PolePrzelacznik etykieta="Przypomnienia o zapłacie" wartosc={f.wlaczone} onZmiana={(v) => ustaw('wlaczone', v)} />
      </Sekcja>

      {f.wlaczone ? (
        <>
          <Sekcja naglowek="Etapy przypomnień">
            {f.etapy.map((e, i) => (
              <View key={e.etap}>
                <PolePrzelacznik etykieta={ETAPY[i]?.nazwa ?? `Etap ${e.etap}`} wartosc={e.wlaczony} onZmiana={(v) => ustawEtap(i, v)} />
                {e.wlaczony ? (
                  <PoleTekstowe
                    etykieta="Dni po terminie"
                    wartosc={dni[i] ?? ''}
                    onZmiana={(t) => setDni((d) => d.map((x, j) => (j === i ? t : x)))}
                    klawiatura="number-pad"
                    cyfry
                    blad={bladPola(`etapy.${i}.dniPoTerminie`)}
                  />
                ) : null}
              </View>
            ))}
          </Sekcja>

          <Sekcja naglowek="Inteligentne reguły">
            <PolePrzelacznik etykieta="Pauza po odpowiedzi klienta" wartosc={f.wstrzymajPoOdpowiedzi} onZmiana={(v) => ustaw('wstrzymajPoOdpowiedzi', v)} />
            <PolePrzelacznik etykieta="Pauza po częściowej płatności" wartosc={f.wstrzymajPoCzesciowej} onZmiana={(v) => ustaw('wstrzymajPoCzesciowej', v)} />
            <PolePrzelacznik etykieta="Wysyłaj tylko w dni robocze" wartosc={f.tylkoDniRobocze} onZmiana={(v) => ustaw('tylkoDniRobocze', v)} />
            <PoleWyboru etykieta="Godzina wysyłki" wartosc={String(f.godzina)} opcje={GODZINY.map((g) => ({ wartosc: g, etykieta: `${g}:00` }))} onZmiana={(g) => ustaw('godzina', Number(g))} />
            <PoleTekstowe etykieta="Maks. przypomnień na fakturę" wartosc={maks} onZmiana={setMaks} klawiatura="number-pad" cyfry blad={bladPola('najwiecej')} />
          </Sekcja>

          <Sekcja naglowek="Dane nadawcy" stopka="Pusty nadawca: nazwa firmy. Odpowiedzi klientów trafią na podany adres.">
            <PoleTekstowe etykieta="Nadawca" wartosc={f.nadawca} onZmiana={(t) => ustaw('nadawca', t)} blad={bladPola('nadawca')} />
            <PoleTekstowe etykieta="Odpowiedzi na adres" wartosc={f.odpowiedzNa} onZmiana={(t) => ustaw('odpowiedzNa', t)} klawiatura="email-address" blad={bladPola('odpowiedzNa')} />
          </Sekcja>
        </>
      ) : null}

      {blad && !(blad.pole && f.wlaczone) ? <Sekcja stopka={blad.komunikat}>{null}</Sekcja> : null}

      <View style={styles.akcja}>
        <PrzyciskGlowny tytul={zmienione ? 'Zapisz ustawienia' : 'Zapisano'} ikona="check-line" trwa={trwa} onPress={() => void zapisz()} />
      </View>
    </EkranListy>
  );
}

/** Przypomnienia o zapłacie: odpowiednik `reminder-settings-form.tsx` (etapy, reguły, nadawca). */
function EkranUstawienPrzypomnien() {
  const { flagi, ustawFlage } = useStanFaktur();
  const wl = (k: string, d: boolean) => flagi[`przyp-${k}`] ?? d;
  const glowny = wl('wlaczone', true);
  const [dni, setDni] = useState<Record<string, string>>(Object.fromEntries(ETAPY.map((e) => [e.klucz, e.dni])));
  const [godzina, setGodzina] = useState('9');
  const [maks, setMaks] = useState('3');
  const [nadawca, setNadawca] = useState('Jan Kowalski');
  const [replyTo, setReplyTo] = useState('jan@przyklad.pl');
  const [zapisano, setZapisano] = useState(false);

  return (
    <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Sekcja stopka="Przypomnienia przygotowujemy do Twojego zatwierdzenia. Nic nie wychodzi samo.">
        <PolePrzelacznik etykieta="Przypomnienia o zapłacie" wartosc={glowny} onZmiana={(v) => ustawFlage('przyp-wlaczone', v)} />
      </Sekcja>

      {glowny ? (
        <>
          <Sekcja naglowek="Etapy przypomnień">
            {ETAPY.map((e) => (
              <View key={e.klucz}>
                <PolePrzelacznik etykieta={e.nazwa} wartosc={wl(`etap-${e.klucz}`, true)} onZmiana={(v) => ustawFlage(`przyp-etap-${e.klucz}`, v)} />
                {wl(`etap-${e.klucz}`, true) ? (
                  <PoleTekstowe etykieta="Dni po terminie" wartosc={dni[e.klucz] ?? ''} onZmiana={(t) => setDni((d) => ({ ...d, [e.klucz]: t }))} klawiatura="number-pad" />
                ) : null}
              </View>
            ))}
          </Sekcja>

          <Sekcja naglowek="Inteligentne reguły">
            <PolePrzelacznik etykieta="Pauza po odpowiedzi klienta" wartosc={wl('pauza-odp', true)} onZmiana={(v) => ustawFlage('przyp-pauza-odp', v)} />
            <PolePrzelacznik etykieta="Pauza po częściowej płatności" wartosc={wl('pauza-czesc', true)} onZmiana={(v) => ustawFlage('przyp-pauza-czesc', v)} />
            <PolePrzelacznik etykieta="Wysyłaj tylko w dni robocze" wartosc={wl('robocze', true)} onZmiana={(v) => ustawFlage('przyp-robocze', v)} />
            <PoleWyboru etykieta="Godzina wysyłki" wartosc={godzina} opcje={GODZINY.map((g) => ({ wartosc: g, etykieta: `${g}:00` }))} onZmiana={setGodzina} />
            <PoleTekstowe etykieta="Maks. przypomnień na fakturę" wartosc={maks} onZmiana={setMaks} klawiatura="number-pad" />
          </Sekcja>

          <Sekcja naglowek="Dane nadawcy">
            <PoleTekstowe etykieta="Nadawca" wartosc={nadawca} onZmiana={setNadawca} />
            <PoleTekstowe etykieta="Odpowiedzi na adres" wartosc={replyTo} onZmiana={setReplyTo} klawiatura="email-address" />
          </Sekcja>
        </>
      ) : null}

      <View style={styles.akcja}>
        <PrzyciskGlowny
          tytul={zapisano ? 'Zapisano' : 'Zapisz ustawienia'}
          ikona="check-line"
          onPress={() => {
            setZapisano(true);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }}
        />
      </View>
    </EkranListy>
  );
}

const styles = StyleSheet.create({
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.xl },
});
