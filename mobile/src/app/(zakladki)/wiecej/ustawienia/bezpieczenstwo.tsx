import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';

import { KLUCZE_DOSTEPU } from '@/dane-przykladowe/ustawienia';
import { PolePrzelacznik, PoleTekstowe } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { MA_ADRES_STRONY, otworzStrone } from '@/komponenty/na-stronie';
import { potwierdz } from '@/komponenty/potwierdz';
import { dataPelna } from '@/lib/format';
import { useKluczeDostepu, useZapisBezpieczenstwa } from '@/stan/bezpieczenstwo';
import { useKontoFirmy, type KontoFirmy } from '@/stan/dane';
import { useFlaga } from '@/stan/faktury';
import { BLOKADA_PO_MS, useSesja } from '@/stan/sesja';

const WYMAGANIA = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{12,128}$/;

export default function EkranBezpieczenstwaKonta() {
  const konto = useKontoFirmy();
  if (konto) return <EkranBezpieczenstwaZBazy konto={konto} />;
  return <EkranBezpieczenstwa />;
}

/** Blokada tej aplikacji: lokalna, ta sama na danych przykładowych i na koncie. */
function BlokadaAplikacji() {
  const { biometria, blokada, ustawBlokade } = useSesja();
  return biometria ? (
    <Sekcja
      naglowek="Ta aplikacja"
      stopka={`Po włączeniu aplikacja poprosi o ${biometria.nazwa} przy otwarciu i po ${BLOKADA_PO_MS / 60000} minutach w tle. W przełączniku aplikacji kwoty są zawsze zasłonięte.`}>
      <PolePrzelacznik etykieta={`Blokada ${biometria.nazwa}`} wartosc={blokada} onZmiana={(v) => void ustawBlokade(v)} />
    </Sekcja>
  ) : (
    <Sekcja naglowek="Ta aplikacja" stopka="Ten telefon nie ma Face ID ani czytnika odcisków palców, więc blokada aplikacji jest niedostępna. W przełączniku aplikacji kwoty są zawsze zasłonięte." />
  );
}

/**
 * Bezpieczeństwo na prawdziwym koncie (M10b, hasło i klucze od M10c): stan
 * 2FA z `GET /konto`, zmiana hasła w arkuszu `haslo`, klucze dostępu z
 * `GET /ustawienia/klucze` z usunięciem, blokada aplikacji na telefonie.
 * Włączenie i wyłączenie 2FA oraz dodanie klucza dostępu zostają na
 * faktway.pl (klucz w aplikacji wymaga powiązanej domeny w koncie Apple).
 */
function EkranBezpieczenstwaZBazy({ konto }: { konto: KontoFirmy }) {
  const router = useRouter();
  const klucze = useKluczeDostepu();
  const zapis = useZapisBezpieczenstwa();
  const [usuwany, setUsuwany] = useState<string | null>(null);
  const [nota, setNota] = useState<string>();
  const dwaEtapy = konto.konto?.dwaEtapy.wlaczone;
  const naStronie = MA_ADRES_STRONY ? () => otworzStrone('/settings/security', () => void klucze?.odswiez()) : undefined;

  const usun = (id: string, nazwa: string) =>
    potwierdz(
      { tytul: `Usunąć klucz „${nazwa}”?`, opis: 'Na tym urządzeniu nie zalogujesz się już kluczem. Pozostałe sesje konta wylogujemy, ta zostaje.', potwierdz: 'Usuń klucz' },
      () => {
        if (!zapis) return;
        setUsuwany(id);
        setNota(undefined);
        void zapis.usunKlucz(id).then((w) => {
          setUsuwany(null);
          if (w.ok) {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            setNota(w.dane.inneWylogowane ? 'Klucz usunięty. Pozostałe sesje konta wylogowaliśmy.' : 'Klucz usunięty. Pozostałych sesji nie udało się wylogować: zrób to na faktway.pl.');
          } else if (w.blad.kod !== 'not_found') {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
            setNota(w.blad.komunikat);
          }
        });
      },
    );

  const lista = klucze?.dane?.klucze;
  return (
    <EkranListy onOdswiez={klucze?.odswiez}>
      <Sekcja
        naglowek="Weryfikacja dwuetapowa"
        stopka={
          dwaEtapy === undefined
            ? 'Wczytujemy stan konta.'
            : dwaEtapy
              ? 'Włączona: przy logowaniu prosimy o kod z aplikacji TOTP.'
              : 'Włącz, żeby podłączyć KSeF i wejść w ustawienia wrażliwe. Kod QR zeskanujesz na faktway.pl.'
        }>
        <Wiersz
          tytul="Kod z aplikacji (TOTP)"
          wartosc={dwaEtapy === undefined ? undefined : dwaEtapy ? 'Włączona' : 'Wyłączona'}
          wartoscKolor={dwaEtapy ? 'sukces' : 'ostrzezenie'}
        />
        {naStronie ? <Wiersz tytul={dwaEtapy ? 'Zarządzaj na faktway.pl' : 'Włącz na faktway.pl'} ikona="global-line" akcja onPress={naStronie} /> : null}
      </Sekcja>

      <Sekcja naglowek="Hasło">
        <Wiersz tytul="Zmień hasło" ikona="key-line" strzalka onPress={() => router.push('/wiecej/ustawienia/haslo')} />
      </Sekcja>

      <Sekcja
        naglowek="Klucze dostępu"
        stopka={nota ?? 'Klucz dostępu (Face ID, Touch ID, klucz sprzętowy) zastępuje hasło przy logowaniu na faktway.pl. Dotknij klucza, żeby go usunąć; nowy dodasz na faktway.pl.'}>
        {lista ? (
          lista.length === 0 ? (
            <Wiersz tytul="Brak kluczy dostępu" ikona="fingerprint-line" ikonaKolor="etykietaDrugorzedna" />
          ) : (
            lista.map((k) => (
              <Wiersz
                key={k.id}
                tytul={k.nazwa}
                podtytul={`Dodany ${dataPelna(k.dodany.slice(0, 10))}${k.ostatnio ? `, ostatnio ${dataPelna(k.ostatnio.slice(0, 10))}` : ''}`}
                ikona="fingerprint-line"
                wartosc={usuwany === k.id ? 'Usuwamy' : undefined}
                onPress={usuwany ? undefined : () => usun(k.id, k.nazwa)}
              />
            ))
          )
        ) : klucze?.stan === 'blad' ? (
          <Wiersz tytul="Nie udało się wczytać kluczy. Spróbuj ponownie" ikona="error-warning-line" ikonaKolor="ostrzezenie" akcja onPress={() => void klucze.odswiez()} />
        ) : (
          <Wiersz tytul="Wczytujemy klucze dostępu" />
        )}
        {naStronie ? <Wiersz tytul="Dodaj klucz na faktway.pl" ikona="global-line" akcja onPress={naStronie} /> : null}
      </Sekcja>

      <BlokadaAplikacji />
    </EkranListy>
  );
}

/** Bezpieczeństwo: hasło, weryfikacja dwuetapowa, logowanie biometrią, blokada Face ID. */
function EkranBezpieczenstwa() {
  const [stare, setStare] = useState('');
  const [nowe, setNowe] = useState('');
  const [komunikat, setKomunikat] = useState<string>();
  const [dwaEtapy, setDwaEtapy] = useFlaga('2fa', true);
  const [klucze, setKlucze] = useState(KLUCZE_DOSTEPU);

  const zmienHaslo = () => {
    if (!stare) return setKomunikat('Wpisz aktualne hasło.');
    if (!WYMAGANIA.test(nowe)) return setKomunikat('Nowe hasło: 12 do 128 znaków, mała i duża litera, cyfra oraz znak specjalny.');
    setStare('');
    setNowe('');
    setKomunikat('Hasło zmienione.');
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  return (
    <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Sekcja naglowek="Hasło" stopka={komunikat ?? '12 do 128 znaków, mała i duża litera, cyfra oraz znak specjalny.'}>
        <PoleTekstowe etykieta="Aktualne hasło" wartosc={stare} onZmiana={setStare} tajne />
        <PoleTekstowe etykieta="Nowe hasło" wartosc={nowe} onZmiana={setNowe} tajne autouzupelnianie="nowe-haslo" />
        <Wiersz tytul="Zmień hasło" akcja onPress={zmienHaslo} />
      </Sekcja>

      <Sekcja naglowek="Weryfikacja dwuetapowa" stopka={dwaEtapy ? 'Włączone: przy logowaniu poprosimy o kod z aplikacji TOTP.' : 'Włącz, żeby podłączyć KSeF i wejść w ustawienia wrażliwe.'}>
        <PolePrzelacznik
          etykieta="Kod z aplikacji (TOTP)"
          wartosc={dwaEtapy}
          onZmiana={(v) =>
            v
              ? setDwaEtapy(true)
              : potwierdz({ tytul: 'Wyłączyć aplikację TOTP?', opis: 'Bez drugiego kroku nie podłączysz KSeF.', potwierdz: 'Wyłącz' }, () => setDwaEtapy(false))
          }
        />
      </Sekcja>

      <Sekcja naglowek="Logowanie biometrią" stopka="Klucze dostępu z Face ID albo Touch ID zamiast hasła.">
        {klucze.map((k) => (
          <Wiersz
            key={k.id}
            tytul={k.nazwa}
            podtytul={`Ostatnio użyte: ${dataPelna(k.ostatnio)}`}
            wartoscPodpis="Usuń"
            wartoscPodpisKolor="blad"
            onPress={() =>
              potwierdz({ tytul: `Usunąć ${k.nazwa}?`, opis: 'Na tym urządzeniu zalogujesz się znowu hasłem.', potwierdz: 'Usuń klucz' }, () =>
                setKlucze((l) => l.filter((x) => x.id !== k.id)),
              )
            }
          />
        ))}
        <Wiersz
          tytul="Dodaj urządzenie"
          ikona="fingerprint-line"
          akcja
          onPress={() => setKlucze((l) => [...l, { id: `p${Date.now()}`, nazwa: 'Ten iPhone, Face ID', ostatnio: '2026-11-09' }])}
        />
      </Sekcja>

      <BlokadaAplikacji />
    </EkranListy>
  );
}
