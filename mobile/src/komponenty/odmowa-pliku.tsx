/**
 * Odmowa serwera pod przyciskiem pliku (JPK_V7M, JPK_EWP, JPK_PKPIR, eksport).
 * Zdanie z serwera na czerwono, a gdy odmowa dotyczy braku urzędu skarbowego
 * firmy (U14), pod nim wiersz „Ustaw urząd na faktway.pl”: blokada musi mieć
 * wyjście w aplikacji (protokół naprawy, punkt 4). Stronę z urzędem otwiera
 * tylko właściciel; inne role dostają zdanie, kto urząd ustawia.
 */
import { StyleSheet } from 'react-native';

import { Sekcja, Wiersz } from '@/komponenty/lista';
import { MA_ADRES_STRONY, otworzStrone } from '@/komponenty/na-stronie';
import { Tekst } from '@/komponenty/tekst';
import { jestBrakiemUrzedu, STRONA_URZEDU, TYTUL_USTAW_URZAD, wyjscieBrakUrzedu } from '@/lib/urzad-skarbowy';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

export function OdmowaPliku({ komunikat, rola, poPowrocie }: { komunikat: string; rola: string | undefined; poPowrocie?: () => void }) {
  const wyjscie = jestBrakiemUrzedu(komunikat) ? wyjscieBrakUrzedu(rola, MA_ADRES_STRONY) : null;
  return (
    <>
      <Tekst styl="footnote" kolor="blad" style={styles.nota}>
        {[komunikat, wyjscie?.podpowiedz].filter(Boolean).join(' ')}
      </Tekst>
      {wyjscie?.strona ? (
        <Sekcja>
          <Wiersz tytul={TYTUL_USTAW_URZAD} ikona="global-line" akcja onPress={() => otworzStrone(STRONA_URZEDU, poPowrocie)} />
        </Sekcja>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  nota: { marginHorizontal: MARGINES, marginTop: ODSTEP.s },
});
