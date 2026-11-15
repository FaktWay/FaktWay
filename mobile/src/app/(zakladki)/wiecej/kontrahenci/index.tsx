import { Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';

import { DZIS } from '@/dane-przykladowe';
import { KONTRAHENCI } from '@/dane-przykladowe/kontrahenci';
import { Kafle, type Kafel } from '@/komponenty/kafle';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { PrzyciskPaska } from '@/komponenty/przycisk-paska';
import { StanPusty } from '@/komponenty/stan-pusty';
import { SzkieletListy } from '@/komponenty/szkielet';
import type { CzescTelefonu, KafleKontrahentow, KontrahentTelefonu } from '@/lib/api/kontrakt-wiecej';
import { kwota } from '@/lib/format';
import { doZaplaty, ileFaktur, statusFaktury } from '@/lib/status-faktury';
import { useStanFaktur } from '@/stan/faktury';
import { grosze, useKontrahenci, useZapisKontrahenta } from '@/stan/kontrahenci';
import { useOpcjeWyszukiwarki } from '@/wyglad/naglowki';

/** Prawdziwe konto (M10e): lista z bazy przez API; dane przykładowe: wersja z M4. */
export default function EkranKontrahentow() {
  const zapis = useZapisKontrahenta();
  return zapis ? <EkranKontrahentowZBazy /> : <EkranKontrahentowPrzyklad />;
}

/** Szukanie w bazie po nazwie i NIP, jak na stronie: pytamy po chwili od ostatniej litery. */
const OPOZNIENIE_SZUKANIA_MS = 350;

function kafelZ<T extends { wartosc: number }>(c: CzescTelefonu<T>, klucz: string, podpis: string, ostrzezenie = false): Kafel {
  if (!c.ok) return { klucz, podpis, wartosc: 'Brak', opis: 'Nie policzyliśmy', opisKolor: 'ostrzezenie' };
  return { klucz, podpis, wartosc: c.dane.wartosc.toLocaleString('pl-PL'), ...(ostrzezenie && c.dane.wartosc > 0 ? { opisKolor: 'ostrzezenie' as const } : {}) };
}

function kafleKontrahentow(k: KafleKontrahentow): Kafel[] {
  return [
    kafelZ(k.wszyscy, 'wszyscy', 'Kontrahenci'),
    kafelZ(k.aktywni, 'aktywni', 'Aktywni (90 dni)'),
    kafelZ(k.zZaleglosciami, 'zalegli', 'Z zaległościami', true),
    kafelZ(k.vatDoSprawdzenia, 'vat', 'Status VAT do sprawdzenia'),
  ];
}

/** Wiersz jak tabela strony: nazwa, NIP i status VAT, należności i faktury po terminie. */
function WierszKontrahenta({ k, onPress }: { k: KontrahentTelefonu; onPress: () => void }) {
  const n = k.naleznosci;
  return (
    <Wiersz
      tytul={k.nazwa || `NIP ${k.nip}`}
      podtytul={`NIP ${k.nip} · ${k.statusVatEtykieta}`}
      wartosc={n && n.doZaplaty > 0 ? kwota(grosze(n.doZaplaty)) : undefined}
      wartoscKolor="etykieta"
      wartoscPodpis={n && n.poTerminie > 0 ? `${ileFaktur(n.poTerminie)} po terminie` : n && n.doZaplaty > 0 ? 'Należności' : undefined}
      wartoscPodpisKolor={n && n.poTerminie > 0 ? 'ostrzezenie' : 'etykietaDrugorzedna'}
      strzalka
      onPress={onPress}
    />
  );
}

function EkranKontrahentowZBazy() {
  const wyszukiwarka = useOpcjeWyszukiwarki();
  const router = useRouter();
  const [szukaj, setSzukaj] = useState('');
  const [fraza, setFraza] = useState('');
  useEffect(() => {
    const zegar = setTimeout(() => setFraza(szukaj.trim()), OPOZNIENIE_SZUKANIA_MS);
    return () => clearTimeout(zegar);
  }, [szukaj]);
  const odczyt = useKontrahenci(fraza);
  const dane = odczyt?.dane;
  const otworz = (id: string) => router.push({ pathname: '/wiecej/kontrahenci/[id]', params: { id } });
  const dodaj = () => router.push('/wiecej/kontrahenci/nowy');

  return (
    <>
      <Stack.SearchBar {...wyszukiwarka} placeholder="Nazwa albo NIP" onChangeText={(e) => setSzukaj(e.nativeEvent.text)} />
      {dane?.mozeEdytowac ? <PrzyciskPaska strona="prawa" tytul="Dodaj" naGradiencie onPress={dodaj} /> : null}
      <EkranListy gradient={!fraza} keyboardShouldPersistTaps="handled" onOdswiez={odczyt?.odswiez}>
        {!dane ? (
          odczyt?.stan === 'blad' ? (
            <StanPusty ikona="error-warning-line" tytul="Nie udało się wczytać kontrahentów" opis={odczyt.blad ?? 'Spróbuj ponownie za chwilę.'} akcja={{ tytul: 'Spróbuj ponownie', onPress: () => void odczyt.odswiez() }} />
          ) : (
            <SzkieletListy wiersze={6} etykieta="Wczytujemy kontrahentów" />
          )
        ) : (
          <>
            {dane.kafle ? <Kafle kafle={kafleKontrahentow(dane.kafle)} /> : null}
            {odczyt?.blad ? <Sekcja stopka={`Nie udało się odświeżyć: ${odczyt.blad}`} /> : null}
            {dane.bladNaleznosci ? <Sekcja stopka={`Nie udało się policzyć należności: ${dane.bladNaleznosci}`} /> : null}
            {dane.lista.length === 0 ? (
              dane.fraza ? (
                <StanPusty ikona="user-search-line" tytul="Nic nie znaleźliśmy" opis={`Brak kontrahentów dla „${dane.fraza}”.`} />
              ) : (
                <StanPusty
                  ikona="contacts-book3-line"
                  tytul="Brak kontrahentów"
                  opis="Kontrahentów zapisujemy sami przy wystawianiu faktur. Możesz też dodać kontrahenta z NIP."
                  akcja={dane.mozeEdytowac ? { tytul: 'Dodaj kontrahenta', onPress: dodaj } : undefined}
                />
              )
            ) : (
              <Sekcja naglowek={dane.fraza ? 'Wyniki' : 'Wszyscy'} stopka={dane.nota}>
                {dane.lista.map((k) => (
                  <WierszKontrahenta key={k.id} k={k} onPress={() => otworz(k.id)} />
                ))}
              </Sekcja>
            )}
          </>
        )}
      </EkranListy>
    </>
  );
}

/**
 * Kontrahenci na danych przykładowych: odpowiednik `contractors` (zapisani z
 * faktur, dane z GUS, należności, zaległości, status VAT).
 */
function EkranKontrahentowPrzyklad() {
  const wyszukiwarka = useOpcjeWyszukiwarki();
  const router = useRouter();
  const { faktury, flagi } = useStanFaktur();
  const [szukaj, setSzukaj] = useState('');
  const fraza = szukaj.trim().toLocaleLowerCase('pl');
  const lista = KONTRAHENCI.filter((k) => !flagi[`kontrahent-usuniety-${k.id}`]).filter((k) => !fraza || k.nazwa.toLocaleLowerCase('pl').includes(fraza) || k.nip.includes(fraza));
  const naleznosci = (nazwa: string) => faktury.filter((f) => f.kontrahent === nazwa && doZaplaty(f));
  const zZaleglosciami = KONTRAHENCI.filter((k) => naleznosci(k.nazwa).some((f) => statusFaktury(f, DZIS).zalegla)).length;

  return (
    <>
      <Stack.SearchBar {...wyszukiwarka} placeholder="Nazwa albo NIP" onChangeText={(e) => setSzukaj(e.nativeEvent.text)} />
      <EkranListy gradient={!szukaj} keyboardShouldPersistTaps="handled">
        {szukaj ? null : (
          <Kafle
            kafle={[
              { klucz: 'wszyscy', ikona: 'contacts-book3-line', podpis: 'Kontrahenci', wartosc: String(KONTRAHENCI.length) },
              { klucz: 'aktywni', ikona: 'team-line', podpis: 'Aktywni (90 dni)', wartosc: String(KONTRAHENCI.length - 1) },
              { klucz: 'zalegli', ikona: 'alarm-warning-line', podpis: 'Z zaległościami', wartosc: String(zZaleglosciami), opisKolor: 'ostrzezenie' },
              { klucz: 'vat', ikona: 'verified-badge-line', podpis: 'Status VAT do sprawdzenia', wartosc: '0' },
            ]}
          />
        )}
        {lista.length === 0 ? (
          <StanPusty ikona="contacts-book3-line" tytul="Brak kontrahentów" opis={szukaj ? `Nic nie pasuje do „${szukaj}”.` : 'Kontrahentów zapisujemy z wystawionych faktur.'} />
        ) : (
          <Sekcja naglowek="Wszyscy" stopka="Zapisani automatycznie z faktur. Dane pobieramy z bazy GUS REGON.">
            {lista.map((k) => {
              const otwarte = naleznosci(k.nazwa);
              const zalegle = otwarte.filter((f) => statusFaktury(f, DZIS).zalegla);
              return (
                <Wiersz
                  key={k.id}
                  tytul={k.nazwa}
                  podtytul={`NIP ${k.nip} · Czynny VAT`}
                  wartosc={otwarte.length > 0 ? kwota(otwarte.reduce((s, f) => s + f.brutto, 0)) : undefined}
                  wartoscKolor="etykieta"
                  wartoscPodpis={zalegle.length > 0 ? `${ileFaktur(zalegle.length)} po terminie` : otwarte.length > 0 ? 'Należności' : undefined}
                  wartoscPodpisKolor={zalegle.length > 0 ? 'ostrzezenie' : 'etykietaDrugorzedna'}
                  strzalka
                  onPress={() => router.push({ pathname: '/wiecej/kontrahenci/[id]', params: { id: k.id } })}
                />
              );
            })}
          </Sekcja>
        )}
      </EkranListy>
    </>
  );
}
