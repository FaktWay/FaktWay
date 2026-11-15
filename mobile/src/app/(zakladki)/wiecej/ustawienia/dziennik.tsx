import { DZIENNIK } from '@/dane-przykladowe/ustawienia';
import { EkranOdczytu } from '@/komponenty/ekran-odczytu';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { StanPusty } from '@/komponenty/stan-pusty';
import type { DziennikOdpowiedz } from '@/lib/api/kontrakt-wiecej';
import { useOdczyt, type StanOdczytu } from '@/stan/odczyt';

export default function EkranDziennika() {
  const odczyt = useOdczyt<DziennikOdpowiedz>('dziennik');
  return odczyt ? <EkranDziennikaZBazy odczyt={odczyt} /> : <EkranDziennikaPrzyklad />;
}

/** Dziennik na prawdziwym koncie (M10e): ostatnie 200 wpisów `GET /dziennik`, jak zakładka strony. */
function EkranDziennikaZBazy({ odczyt }: { odczyt: StanOdczytu<DziennikOdpowiedz> }) {
  return (
    <EkranOdczytu odczyt={odczyt} tytulBledu="Nie udało się wczytać dziennika" szkielet="Wczytujemy dziennik zdarzeń">
      {(d) =>
        d.wpisy.length === 0 ? (
          <StanPusty ikona="history-line" tytul="Brak wpisów" opis="Tu zobaczysz logowania i zmiany w firmie." />
        ) : (
          <Sekcja naglowek="Historia aktywności" stopka={`${d.wpisy.length} ${d.wpisy.length === 1 ? 'wpis' : 'wpisów'} (najwyżej 200), od najnowszych.`}>
            {d.wpisy.map((w) => (
              <Wiersz key={w.id} tytul={w.akcja} podtytul={[w.kiedy, w.zasob, w.ip ? `IP ${w.ip}` : null].filter(Boolean).join(' · ')} zaznaczalna />
            ))}
          </Sekcja>
        )
      }
    </EkranOdczytu>
  );
}

/** Dziennik zdarzeń: historia aktywności (`settings/audit`), od najnowszych. */
function EkranDziennikaPrzyklad() {
  return (
    <EkranListy>
      <Sekcja naglowek="Historia aktywności" stopka={`${DZIENNIK.length} wpisów (najwyżej 200), od najnowszych.`}>
        {DZIENNIK.map((d) => (
          <Wiersz key={d.id} tytul={d.akcja} podtytul={`${d.data} · ${d.zasob} · IP ${d.ip}`} zaznaczalna />
        ))}
      </Sekcja>
    </EkranListy>
  );
}
