import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';

import { FIRMA, PODSTAWY_ZWOLNIENIA } from '@/dane-przykladowe/ustawienia';
import { PoleDaty, PolePrzelacznik, PoleTekstowe, PoleWyboru } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { SzkieletListy } from '@/komponenty/szkielet';
import { StanPusty } from '@/komponenty/stan-pusty';
import { dataPelna, rachunek } from '@/lib/format';
import { useKontoFirmy } from '@/stan/dane';
import { statusVat, useUstawienia, type StanUstawien } from '@/stan/ustawienia';

export default function EkranFirmyIDanych() {
  const ustawienia = useUstawienia();
  if (ustawienia) return <EkranFirmyZBazy ustawienia={ustawienia} />;
  return <EkranFirmy />;
}

/**
 * Firma na prawdziwym koncie (M10b, zapisy od M10c): dane, rachunek, VAT
 * i start działalności z `GET /ustawienia`. Właściciel i administrator (jak na
 * stronie) zmieniają je w arkuszu `firma-zmiana` tą samą logiką co strona;
 * pozostali widzą dane bez strzałek.
 */
function EkranFirmyZBazy({ ustawienia }: { ustawienia: StanUstawien }) {
  const rola = useKontoFirmy()?.firma?.rola;
  const router = useRouter();
  const { dane } = ustawienia;
  if (!dane) {
    return (
      <EkranListy>
        {ustawienia.stan === 'blad' ? (
          <StanPusty ikona="error-warning-line" tytul="Nie udało się wczytać danych firmy" opis={ustawienia.blad ?? 'Spróbuj ponownie za chwilę.'} akcja={{ tytul: 'Spróbuj ponownie', onPress: () => void ustawienia.odswiez() }} />
        ) : (
          <SzkieletListy wiersze={5} etykieta="Wczytujemy dane firmy" />
        )}
      </EkranListy>
    );
  }
  const f = dane.firma;
  const adres = [f.adres.linia1, f.adres.linia2].filter(Boolean).join(', ');
  const mozeZmienic = rola === 'owner' || rola === 'admin';
  const zmien = (co: 'dane' | 'rachunek' | 'vat' | 'rozpoczecie') =>
    mozeZmienic ? { strzalka: true, onPress: () => router.push({ pathname: '/wiecej/ustawienia/firma-zmiana', params: { co } }) } : {};
  return (
    <EkranListy onOdswiez={ustawienia.odswiez}>
      <Sekcja naglowek="Dane firmy" stopka="NIP zmienia się tylko przez pomoc FaktWay.">
        <Wiersz tytul="NIP" wartosc={f.nip || 'Brak'} zaznaczalna />
        <Wiersz tytul="Nazwa i adres" podtytul={[f.nazwa || 'Brak nazwy', adres || 'Brak adresu'].join('\n')} {...zmien('dane')} />
        <Wiersz tytul="Rachunek do faktur" podtytul={f.rachunek ? rachunek(f.rachunek) : 'Nie podano'} {...zmien('rachunek')} />
      </Sekcja>

      <Sekcja naglowek="Podatek VAT">
        <Wiersz tytul={statusVat(f)} {...zmien('vat')} />
      </Sekcja>

      <Sekcja
        naglowek="Działalność"
        stopka={mozeZmienic ? 'Potrzebna do ulgi na start i limitu zwolnienia z VAT.' : 'Dane firmy, VAT i datę rozpoczęcia zmienia właściciel albo administrator firmy.'}>
        <Wiersz tytul="Data rozpoczęcia" wartosc={f.rozpoczecie ? dataPelna(f.rozpoczecie) : 'Nie podano'} {...zmien('rozpoczecie')} />
      </Sekcja>
    </EkranListy>
  );
}

/** Firma: odpowiednik karty „Firma” w ustawieniach strony (dane, VAT, metoda kasowa, start działalności). */
function EkranFirmy() {
  const [nazwa, setNazwa] = useState(FIRMA.nazwa);
  const [ulica, setUlica] = useState(FIRMA.ulica);
  const [miasto, setMiasto] = useState(FIRMA.miasto);
  const [zwolniona, setZwolniona] = useState(false);
  const [podstawa, setPodstawa] = useState('113-1');
  const [kasowa, setKasowa] = useState(false);
  const [rozpoczecie, setRozpoczecie] = useState(FIRMA.rozpoczecie);
  const [zapisano, setZapisano] = useState<string>();

  const zapisz = (co: string) => {
    setZapisano(co);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const status = zwolniona
    ? `Zwolniona z VAT, ${PODSTAWY_ZWOLNIENIA.find((p) => p.wartosc === podstawa)?.etykieta ?? ''}`
    : kasowa
      ? 'Czynny podatnik VAT, metoda kasowa'
      : 'Czynny podatnik VAT';

  return (
    <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Sekcja naglowek="Dane firmy" stopka={zapisano === 'dane' ? 'Zapisano dane firmy.' : 'NIP zmienia się tylko przez pomoc FaktWay.'}>
        <Wiersz tytul="NIP" wartosc={FIRMA.nip} zaznaczalna />
        <PoleTekstowe etykieta="Nazwa firmy" wartosc={nazwa} onZmiana={setNazwa} />
        <PoleTekstowe etykieta="Ulica i numer" wartosc={ulica} onZmiana={setUlica} />
        <PoleTekstowe etykieta="Kod i miejscowość" wartosc={miasto} onZmiana={setMiasto} podpowiedz="00-001 Warszawa" />
        <Wiersz tytul="Zapisz dane firmy" akcja onPress={() => zapisz('dane')} />
      </Sekcja>

      <Sekcja naglowek="Podatek VAT" stopka={status}>
        <PolePrzelacznik etykieta="Moja firma jest zwolniona z VAT" wartosc={zwolniona} onZmiana={setZwolniona} />
        {zwolniona ? <PoleWyboru etykieta="Podstawa prawna" wartosc={podstawa} opcje={PODSTAWY_ZWOLNIENIA} onZmiana={setPodstawa} /> : null}
        {zwolniona ? null : <PolePrzelacznik etykieta="Rozliczam VAT metodą kasową" wartosc={kasowa} onZmiana={setKasowa} />}
        <Wiersz tytul="Zapisz" akcja onPress={() => zapisz('vat')} />
      </Sekcja>

      <Sekcja naglowek="Działalność" stopka={zapisano === 'start' ? 'Zapisano.' : 'Potrzebna do ulgi na start i limitu zwolnienia z VAT.'}>
        <PoleDaty etykieta="Data rozpoczęcia" wartosc={rozpoczecie} onZmiana={setRozpoczecie} />
        <Wiersz tytul="Zapisz" akcja onPress={() => zapisz('start')} />
      </Sekcja>
    </EkranListy>
  );
}
