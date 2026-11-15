import type { ReactNode } from 'react';

import { EkranListy, Sekcja } from '@/komponenty/lista';
import { StanPusty } from '@/komponenty/stan-pusty';
import { SzkieletListy } from '@/komponenty/szkielet';
import type { NazwaIkony } from '@/komponenty/ikona';
import type { StanOdczytu } from '@/stan/odczyt';

/**
 * Ekran karty do odczytu z API (M10e, stany z M4f): szkielet przy pierwszym
 * pobraniu, błąd z „Spróbuj ponownie”, potem treść z odświeżaniem
 * pociągnięciem. Błąd przy starych danych zostawia treść i dopisuje zdanie
 * nad nią.
 */
export function EkranOdczytu<T>({
  odczyt,
  tytulBledu,
  szkielet,
  ikona = 'error-warning-line',
  children,
}: {
  odczyt: StanOdczytu<T>;
  tytulBledu: string;
  szkielet: string;
  ikona?: NazwaIkony;
  children: (dane: T) => ReactNode;
}) {
  const { dane } = odczyt;
  if (dane === undefined) {
    return (
      <EkranListy>
        {odczyt.stan === 'blad' ? (
          <StanPusty ikona={ikona} tytul={tytulBledu} opis={odczyt.blad ?? 'Spróbuj ponownie za chwilę.'} akcja={{ tytul: 'Spróbuj ponownie', onPress: () => void odczyt.odswiez() }} />
        ) : (
          <SzkieletListy wiersze={5} etykieta={szkielet} />
        )}
      </EkranListy>
    );
  }
  return (
    <EkranListy onOdswiez={odczyt.odswiez}>
      {odczyt.blad ? <Sekcja stopka={`Nie udało się odświeżyć: ${odczyt.blad}`} /> : null}
      {children(dane)}
    </EkranListy>
  );
}
