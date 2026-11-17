import * as Haptics from 'expo-haptics';
import { useState } from 'react';

import { POWIADOMIENIA_PUSH, URZADZENIA_PUSH } from '@/dane-przykladowe/ustawienia';
import { PolePrzelacznik } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { MA_ADRES_STRONY, otworzStrone } from '@/komponenty/na-stronie';
import { StanPusty } from '@/komponenty/stan-pusty';
import { SzkieletListy } from '@/komponenty/szkielet';
import type { KategoriaEmaila } from '@/lib/api/kontrakt-ustawienia';
import { dataPelna } from '@/lib/format';
import { useStanFaktur } from '@/stan/faktury';
import { usePowiadomienia, useZapisUstawien, type ZapisUstawien } from '@/stan/ustawienia-zapis';

export default function EkranPowiadomienIEmaili() {
  const powiadomienia = usePowiadomienia();
  const zapis = useZapisUstawien();
  if (powiadomienia && zapis) return <EkranPowiadomienZBazy powiadomienia={powiadomienia} zapis={zapis} />;
  return <EkranPowiadomien />;
}

/** Opisy jak na stronie (`email-preferences.tsx`): to treść zgody, którą klient wyraża przełącznikiem. */
const EMAILE: { kategoria: KategoriaEmaila; etykieta: string; opis: string }[] = [
  {
    kategoria: 'porady',
    etykieta: 'Porady i nowości',
    opis: 'Porady na start (pierwsze dni po rejestracji) i informacje o nowych funkcjach. Włączenie oznacza zgodę na takie e-maile; możesz ją wycofać w każdej chwili.',
  },
  {
    kategoria: 'oferty',
    etykieta: 'Oferty i kampanie',
    opis: 'Oferty FaktWay, artykuły z bloga, przypomnienia, gdy dawno nie zaglądałeś. Włączenie oznacza zgodę na takie e-maile; możesz ją wycofać w każdej chwili.',
  },
];

/**
 * Powiadomienia na prawdziwym koncie (M10c): e-maile porad i ofert jak karta
 * strony. Włączenie przełącznika to zgoda na tę kategorię, wyłączenie to jej
 * wycofanie; zapis od razu, jak na stronie, a przy błędzie przełącznik wraca.
 * Powiadomienia push w aplikacji dojdą z M11; dziś włącza się je w
 * przeglądarce na faktway.pl.
 */
function EkranPowiadomienZBazy({ powiadomienia, zapis }: { powiadomienia: NonNullable<ReturnType<typeof usePowiadomienia>>; zapis: ZapisUstawien }) {
  const [trwa, setTrwa] = useState<KategoriaEmaila | null>(null);
  const [blad, setBlad] = useState<string>();
  const email = powiadomienia.dane?.email;

  const przelacz = async (kategoria: KategoriaEmaila, wlaczone: boolean) => {
    if (trwa) return;
    setTrwa(kategoria);
    setBlad(undefined);
    const w = await zapis.powiadomienie({ kategoria, wlaczone });
    setTrwa(null);
    if (!w.ok) {
      setBlad(w.blad.komunikat);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  return (
    <EkranListy onOdswiez={powiadomienia.odswiez}>
      <Sekcja naglowek="Na tym telefonie" stopka="Powiadomienia push w aplikacji FaktWay jeszcze nie działają. Na faktway.pl włączysz je w przeglądarce.">
        {MA_ADRES_STRONY ? <Wiersz tytul="Powiadomienia na faktway.pl" ikona="global-line" akcja onPress={() => otworzStrone('/settings/notifications')} /> : null}
      </Sekcja>

      {email ? (
        <Sekcja naglowek="Powiadomienia e-mail" stopka={blad ?? 'Powiadomień transakcyjnych (np. o fakturze odrzuconej przez KSeF) nie da się wyłączyć.'}>
          <Wiersz tytul="Powiadomienia transakcyjne" wartosc="Wymagane" />
          {EMAILE.map((e) => (
            <PolePrzelacznik
              key={e.kategoria}
              etykieta={e.etykieta}
              opis={e.opis}
              wartosc={trwa === e.kategoria ? !email[e.kategoria] : email[e.kategoria]}
              onZmiana={(v) => void przelacz(e.kategoria, v)}
            />
          ))}
        </Sekcja>
      ) : powiadomienia.stan === 'ladowanie' ? (
        <SzkieletListy wiersze={3} etykieta="Wczytujemy powiadomienia" />
      ) : (
        <StanPusty
          ikona="error-warning-line"
          tytul="Nie udało się wczytać ustawień e-mail"
          opis={powiadomienia.blad ?? 'Spróbuj ponownie, zanim je zmienisz.'}
          akcja={{ tytul: 'Spróbuj ponownie', onPress: () => void powiadomienia.odswiez() }}
        />
      )}
    </EkranListy>
  );
}

/** Powiadomienia (dane przykładowe): push na tym urządzeniu (rodzaje), urządzenia, e-mail. */
function EkranPowiadomien() {
  const { flagi, ustawFlage } = useStanFaktur();
  const wl = (k: string, d = true) => flagi[`push-${k}`] ?? d;
  const wlaczone = wl('wlaczone');

  return (
    <EkranListy>
      <Sekcja naglowek="Na tym urządzeniu" stopka={wlaczone ? 'Powiadomienia włączone na tym urządzeniu. Nie pokazujemy w nich kwot ani nazw kontrahentów.' : 'Powiadomienia wyłączone na tym urządzeniu.'}>
        <PolePrzelacznik etykieta="Powiadomienia" wartosc={wlaczone} onZmiana={(v) => ustawFlage('push-wlaczone', v)} />
        {wlaczone
          ? POWIADOMIENIA_PUSH.map((p) => (
              <PolePrzelacznik key={p.klucz} etykieta={p.etykieta} opis={p.opis} wartosc={wl(p.klucz)} onZmiana={(v) => ustawFlage(`push-${p.klucz}`, v)} />
            ))
          : null}
      </Sekcja>

      <Sekcja naglowek={`Twoje urządzenia (${URZADZENIA_PUSH.length})`}>
        {URZADZENIA_PUSH.map((u) => (
          <Wiersz key={u.id} tytul={u.nazwa} podtytul={`Dodane ${dataPelna(u.dodane)}`} ikona={u.nazwa.includes('iPhone') ? 'smartphone-line' : 'macbook-line'} />
        ))}
      </Sekcja>

      <Sekcja naglowek="Powiadomienia e-mail" stopka="Powiadomień transakcyjnych (np. o fakturze odrzuconej przez KSeF) nie da się wyłączyć.">
        <Wiersz tytul="Powiadomienia transakcyjne" wartosc="Wymagane" />
        <PolePrzelacznik etykieta="Porady i nowości" wartosc={wl('email-porady', false)} onZmiana={(v) => ustawFlage('push-email-porady', v)} />
        <PolePrzelacznik etykieta="Oferty i kampanie" wartosc={wl('email-oferty', false)} onZmiana={(v) => ustawFlage('push-email-oferty', v)} />
      </Sekcja>
    </EkranListy>
  );
}
