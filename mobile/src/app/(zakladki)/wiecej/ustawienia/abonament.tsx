import { EkranOdczytu } from '@/komponenty/ekran-odczytu';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { NaglowekKwoty } from '@/komponenty/naglowek';
import { StanPusty } from '@/komponenty/stan-pusty';
import type { AbonamentOdpowiedz, OdcienTelefonu } from '@/lib/api/kontrakt-wiecej';
import { dataPelna } from '@/lib/format';
import { useOdczyt, type StanOdczytu } from '@/stan/odczyt';

export default function EkranAbonamentu() {
  const odczyt = useOdczyt<AbonamentOdpowiedz>('abonament');
  return odczyt ? <EkranAbonamentuZBazy odczyt={odczyt} /> : <EkranAbonamentuPrzyklad />;
}

const KOLOR: Record<OdcienTelefonu, 'sukces' | 'ostrzezenie' | 'blad' | 'etykietaDrugorzedna'> = { ok: 'sukces', ostrzezenie: 'ostrzezenie', blad: 'blad', neutralny: 'etykietaDrugorzedna' };

/**
 * Abonament na prawdziwym koncie (M10e): stan subskrypcji z `GET /abonament`,
 * do odczytu. Plan D5: bez cen, metod płatności i przycisków zakupu.
 */
function EkranAbonamentuZBazy({ odczyt }: { odczyt: StanOdczytu<AbonamentOdpowiedz> }) {
  return (
    <EkranOdczytu odczyt={odczyt} tytulBledu="Nie udało się wczytać abonamentu" szkielet="Wczytujemy abonament">
      {({ subskrypcja: s }) =>
        !s ? (
          <StanPusty ikona="bank-card-line" tytul="Brak aktywnej subskrypcji" opis="Ta firma nie ma teraz aktywnej subskrypcji FaktWay." />
        ) : (
          <>
            <NaglowekKwoty
              podpis="Subskrypcja"
              wartosc={s.statusEtykieta}
              styl="title1"
              status={`Plan ${s.plan.toLocaleLowerCase('pl')}`}
              statusKolor={KOLOR[s.odcien]}
            />
            <Sekcja naglowek="Okres rozliczeniowy">
              {s.okresOd && s.okresDo ? <Wiersz tytul="Okres bieżący" podtytul={`${dataPelna(s.okresOd)} do ${dataPelna(s.okresDo)}`} /> : null}
              {s.dniProby !== null && s.probaDo ? (
                <Wiersz tytul="Okres próbny kończy się" wartosc={dataPelna(s.probaDo)} wartoscPodpis={`za ${s.dniProby} ${s.dniProby === 1 ? 'dzień' : 'dni'}`} wartoscPodpisKolor={s.dniProby <= 3 ? 'ostrzezenie' : 'etykietaDrugorzedna'} />
              ) : s.okresDo ? (
                <Wiersz tytul={s.konczySiePoOkresie ? 'Subskrypcja wygasa' : 'Następne odnowienie'} wartosc={dataPelna(s.okresDo)} />
              ) : null}
            </Sekcja>
            <Sekcja stopka="Wszystkie funkcje FaktWay działają w aplikacji tak samo jak na komputerze." />
          </>
        )
      }
    </EkranOdczytu>
  );
}

/**
 * Abonament: stan subskrypcji tylko do odczytu. Plan, decyzja D5: aplikacja nie
 * sprzedaje abonamentu (bez cen i przycisku zakupu), zgodnie z zasadami App
 * Store 3.1; zakup i zmiana planu odbywają się poza aplikacją.
 */
function EkranAbonamentuPrzyklad() {
  return (
    <EkranListy>
      <NaglowekKwoty podpis="Subskrypcja" wartosc="Aktywna" styl="title1" status="Plan miesięczny" statusKolor="sukces" />
      <Sekcja naglowek="Okres rozliczeniowy">
        <Wiersz tytul="Okres bieżący" podtytul={`${dataPelna('2026-11-01')} do ${dataPelna('2026-11-30')}`} />
        <Wiersz tytul="Następne odnowienie" wartosc={dataPelna('2026-12-01')} />
      </Sekcja>
      <Sekcja stopka="Wszystkie funkcje FaktWay działają w aplikacji tak samo jak na komputerze." />
    </EkranListy>
  );
}
