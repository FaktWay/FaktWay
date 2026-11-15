import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Share } from 'react-native';

import { DOSTEPY_KSIEGOWEJ, FORMATY_KSIEGOWEJ, PACZKI_KSIEGOWEJ } from '@/dane-przykladowe/ustawienia';
import { EkranOdczytu } from '@/komponenty/ekran-odczytu';
import { PolePrzelacznik, PoleTekstowe, PoleWyboru } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { MA_ADRES_STRONY, otworzStrone } from '@/komponenty/na-stronie';
import { potwierdz } from '@/komponenty/potwierdz';
import type { DostepKsiegowej, KsiegowaOdpowiedz } from '@/lib/api/kontrakt-wiecej';
import { dataPelna } from '@/lib/format';
import { dzienZnacznika, odmiana } from '@/lib/wiecej';
import { useStanFaktur } from '@/stan/faktury';
import { useOdczyt, type StanOdczytu } from '@/stan/odczyt';

export default function EkranKsiegowej() {
  const odczyt = useOdczyt<KsiegowaOdpowiedz>('ksiegowa');
  return odczyt ? <EkranKsiegowejZBazy odczyt={odczyt} /> : <EkranKsiegowejPrzyklad />;
}

const STAN_DOSTEPU: Record<DostepKsiegowej['stan'], { etykieta: string; kolor: 'sukces' | 'blad' | 'etykietaDrugorzedna' }> = {
  aktywny: { etykieta: 'Aktywny', kolor: 'sukces' },
  odebrany: { etykieta: 'Odebrany', kolor: 'blad' },
  wygasl: { etykieta: 'Wygasł', kolor: 'etykietaDrugorzedna' },
};

const data = (iso: string | null) => {
  const d = dzienZnacznika(iso);
  return d ? dataPelna(d) : '';
};

/**
 * Księgowa na prawdziwym koncie (M10e): urząd skarbowy, Co-Pilot z ostatnimi
 * paczkami i linki dla księgowej z `GET /ksiegowa`, do odczytu (tylko
 * właściciel, jak zakładka strony). Zmiany, nowy link i odebranie dostępu na
 * faktway.pl (M10c).
 */
function EkranKsiegowejZBazy({ odczyt }: { odczyt: StanOdczytu<KsiegowaOdpowiedz> }) {
  return (
    <EkranOdczytu odczyt={odczyt} tytulBledu="Nie udało się wczytać karty Księgowa" szkielet="Wczytujemy dostęp dla księgowej">
      {(d) => (
        <>
          <Sekcja naglowek="Urząd skarbowy firmy" stopka="Potrzebny do pliku JPK_FA.">
            <Wiersz tytul={d.urzad ? (d.urzad.nazwa ?? d.urzad.kod) : 'Nie wybrano'} />
          </Sekcja>

          <Sekcja
            naglowek="Co-Pilot"
            stopka={
              d.coPilot?.wlaczony
                ? `Wysyłamy paczkę ${d.coPilot.dzienWysylki ?? ''}. dnia każdego miesiąca za poprzedni miesiąc.`
                : 'Co-Pilot wyłączony: paczki dla księgowej nie wychodzą.'
            }>
            <Wiersz tytul="Co-Pilot" wartosc={d.coPilot?.wlaczony ? 'Aktywny' : 'Wyłączony'} wartoscKolor={d.coPilot?.wlaczony ? 'sukces' : 'etykietaDrugorzedna'} />
            {d.coPilot?.wlaczony ? (
              <>
                {d.coPilot.ksiegowa ? <Wiersz tytul="Księgowa" podtytul={[d.coPilot.ksiegowa, d.coPilot.biuro].filter(Boolean).join('\n')} /> : null}
                {d.coPilot.email ? <Wiersz tytul="E-mail" podtytul={[d.coPilot.email, ...d.coPilot.dw].join('\n')} zaznaczalna /> : null}
                <Wiersz tytul="Formaty" podtytul={d.coPilot.formaty.join(', ') || 'Brak'} />
                <Wiersz
                  tytul="W paczce"
                  podtytul={[d.coPilot.zakres.wystawione ? 'faktury wystawione' : null, d.coPilot.zakres.otrzymane ? 'faktury otrzymane' : null, d.coPilot.zakres.korekty ? 'faktury korygujące' : null].filter(Boolean).join(', ') || 'Nic'}
                />
              </>
            ) : null}
          </Sekcja>

          {d.paczki.length > 0 ? (
            <Sekcja naglowek="Ostatnie paczki">
              {d.paczki.map((p) => (
                <Wiersz
                  key={p.id}
                  tytul={`${p.format}${p.okresOd && p.okresDo ? `, ${dataPelna(p.okresOd)} do ${dataPelna(p.okresDo)}` : ''}`}
                  podtytul={p.wyslano ? `Wysłano ${data(p.wyslano)}` : `Utworzono ${data(p.utworzono)}`}
                  wartoscPodpis={p.statusEtykieta}
                  wartoscPodpisKolor={p.status === 'completed' ? 'sukces' : p.status === 'failed' ? 'blad' : 'akcent'}
                />
              ))}
            </Sekcja>
          ) : null}

          <Sekcja naglowek={`Udostępnione dostępy (${d.dostepy.length})`} stopka="Księgowa nie potrzebuje konta w FaktWay. Nowy link i odebranie dostępu na faktway.pl.">
            {d.dostepy.length === 0 ? <Wiersz tytul="Brak udostępnionych dostępów" /> : null}
            {d.dostepy.map((a) => (
              <Wiersz
                key={a.id}
                tytul={a.nazwa || a.email}
                podtytul={[a.email, `${a.poziom}${a.wygasa ? ` · wygasa ${data(a.wygasa)}` : ''} · ${odmiana(a.uzycia, ['użycie', 'użycia', 'użyć'])}`, a.ostatnio ? `ostatnio ${data(a.ostatnio)}` : null].filter(Boolean).join('\n')}
                wartoscPodpis={STAN_DOSTEPU[a.stan].etykieta}
                wartoscPodpisKolor={STAN_DOSTEPU[a.stan].kolor}
              />
            ))}
            {MA_ADRES_STRONY ? <Wiersz tytul="Zmień na faktway.pl" ikona="global-line" akcja onPress={() => otworzStrone('/settings/accountant', () => void odczyt.odswiez())} /> : null}
          </Sekcja>
        </>
      )}
    </EkranOdczytu>
  );
}

/**
 * Księgowa: odpowiednik `settings/accountant` (urząd skarbowy, Co-Pilot
 * z paczkami dla księgowej, udostępnione dostępy z linkiem).
 */
function EkranKsiegowejPrzyklad() {
  const { flagi, ustawFlage } = useStanFaktur();
  const wl = (k: string, d: boolean) => flagi[`ksieg-${k}`] ?? d;
  const copilot = wl('copilot', true);
  const [urzad, setUrzad] = useState('Urząd Skarbowy Warszawa-Śródmieście');
  const [imie, setImie] = useState('Anna Sowa');
  const [biuro, setBiuro] = useState('Biuro Rachunkowe Sowa');
  const [email, setEmail] = useState('sowa@przyklad.pl');
  const [dzien, setDzien] = useState('5');
  const [dostepy, setDostepy] = useState(DOSTEPY_KSIEGOWEJ);
  const [paczki, setPaczki] = useState(PACZKI_KSIEGOWEJ);

  return (
    <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Sekcja naglowek="Urząd skarbowy firmy" stopka="Potrzebny do pliku JPK_FA.">
        <PoleTekstowe etykieta="Urząd" wartosc={urzad} onZmiana={setUrzad} />
      </Sekcja>

      <Sekcja naglowek="Co-Pilot" stopka={copilot ? `Wysyłamy paczkę ${dzien}. dnia każdego miesiąca o 8:00 za poprzedni miesiąc.` : 'Co-Pilot wyłączony: paczki dla księgowej nie wychodzą.'}>
        <PolePrzelacznik etykieta={copilot ? 'Co-Pilot aktywny' : 'Co-Pilot wyłączony'} wartosc={copilot} onZmiana={(v) => ustawFlage('ksieg-copilot', v)} />
        {copilot ? (
          <>
            <PoleTekstowe etykieta="Imię i nazwisko" wartosc={imie} onZmiana={setImie} />
            <PoleTekstowe etykieta="Nazwa biura" wartosc={biuro} onZmiana={setBiuro} podpowiedz="opcjonalnie" />
            <PoleTekstowe etykieta="E-mail księgowego" wartosc={email} onZmiana={setEmail} klawiatura="email-address" />
            <PoleWyboru etykieta="Dzień wysyłki" wartosc={dzien} opcje={Array.from({ length: 28 }, (_, i) => ({ wartosc: String(i + 1), etykieta: `${i + 1}. dnia` }))} onZmiana={setDzien} />
          </>
        ) : null}
      </Sekcja>

      {copilot ? (
        <>
          <Sekcja naglowek="Formaty plików">
            {FORMATY_KSIEGOWEJ.map((f) => (
              <PolePrzelacznik key={f} etykieta={f} wartosc={wl(`format-${f}`, f === 'JPK_FA(4)' || f === 'KPiR Excel')} onZmiana={(v) => ustawFlage(`ksieg-format-${f}`, v)} />
            ))}
          </Sekcja>
          <Sekcja naglowek="Co dołączać do paczki">
            <PolePrzelacznik etykieta="Faktury wystawione" wartosc={wl('sprzedaz', true)} onZmiana={(v) => ustawFlage('ksieg-sprzedaz', v)} />
            <PolePrzelacznik etykieta="Faktury otrzymane" wartosc={wl('zakupy', true)} onZmiana={(v) => ustawFlage('ksieg-zakupy', v)} />
            <PolePrzelacznik etykieta="Faktury korygujące" wartosc={wl('korekty', true)} onZmiana={(v) => ustawFlage('ksieg-korekty', v)} />
          </Sekcja>
          <Sekcja naglowek="Ostatnie paczki">
            {paczki.map((p) => (
              <Wiersz key={p.id} tytul={p.okres} podtytul={`Wysłano ${dataPelna(p.data)}`} wartoscPodpis={p.status} wartoscPodpisKolor={p.status === 'Wysłane' ? 'sukces' : 'akcent'} />
            ))}
            <Wiersz
              tytul="Wyślij teraz (za poprzedni miesiąc)"
              ikona="send-plane-line"
              akcja
              onPress={() => {
                setPaczki((l) => [{ id: `k${Date.now()}`, okres: 'Październik 2026', status: 'Wysłane', data: '2026-11-09' }, ...l]);
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              }}
            />
          </Sekcja>
        </>
      ) : null}

      <Sekcja naglowek={`Udostępnione dostępy (${dostepy.length})`} stopka="Link pokazujemy tylko raz. Księgowa nie potrzebuje konta w FaktWay.">
        {dostepy.map((d) => (
          <Wiersz
            key={d.id}
            tytul={d.nazwa}
            podtytul={`${d.poziom} · wygasa ${dataPelna(d.wygasa)} · ${d.uzycia} użyć`}
            wartoscPodpis="Odbierz"
            wartoscPodpisKolor="blad"
            onPress={() =>
              potwierdz({ tytul: `Odebrać dostęp: ${d.nazwa}?`, opis: 'Link przestanie działać od razu.', potwierdz: 'Odbierz dostęp' }, () =>
                setDostepy((l) => l.filter((x) => x.id !== d.id)),
              )
            }
          />
        ))}
        <Wiersz
          tytul="Nowy dostęp"
          ikona="link-m"
          akcja
          onPress={() => {
            setDostepy((l) => [...l, { id: `d${Date.now()}`, nazwa: biuro || imie, email, poziom: 'Tylko podgląd', status: 'Aktywny', wygasa: '2026-12-09', uzycia: 0 }]);
            void Share.share({ message: 'Link dostępu dla księgowej (przykładowy): https://faktway.pl/ksiegowa/...' });
          }}
        />
      </Sekcja>
    </EkranListy>
  );
}
