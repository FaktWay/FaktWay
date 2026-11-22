import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';

import { DZIS, FAKTURY } from '@/dane-przykladowe';
import {
  KOSZTY_MIESIAC,
  ODLOZ_NA_PODATEK,
  OPERACJE,
  PRZEPLYWY,
  WPLYNELO_MIESIAC,
  ZRODLA_PRZEPLYWOW,
  type Okres,
  type Operacja,
} from '@/dane-przykladowe/pulpit';
import { Segmenty } from '@/komponenty/formularz';
import { Kafle } from '@/komponenty/kafle';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { StanPusty } from '@/komponenty/stan-pusty';
import { Wykres } from '@/komponenty/wykres';
import { EkranOdczytu } from '@/komponenty/ekran-odczytu';
import { bezDlugichMyslnikow } from '@/lib/api/bledy';
import type { PrzeplywyOdpowiedz } from '@/lib/api/kontrakt-wiecej';
import { grosze } from '@/lib/dane/mapowanie';
import { dzienZnacznika } from '@/lib/wiecej';
import { dataKrotka, kwota, kwotaKrotka, zmiana, znakZmiany } from '@/lib/format';
import { doZaplaty, kiedyTermin } from '@/lib/status-faktury';
import { type Kolory } from '@/wyglad/kolory';
import { IKONY_PASKA } from '@/wyglad/ikony-paska';
import { GRUPY_MENU_W_LINII, useKoloryPaska } from '@/wyglad/naglowki';
import { useOdczyt, type StanOdczytu } from '@/stan/odczyt';

const OKRESY: { klucz: Okres; nazwa: string }[] = [
  { klucz: 'tygodniowo', nazwa: 'Tygodniowo' },
  { klucz: 'miesiecznie', nazwa: 'Miesięcznie' },
  { klucz: 'rocznie', nazwa: 'Rocznie' },
];

const KOLOR_STATUSU: Record<Operacja['status'], keyof Kolory> = {
  'Opłacona': 'sukces',
  'Korekta': 'ostrzezenie',
  'Zatwierdzony': 'sukces',
  'Do akceptacji': 'ostrzezenie',
  'Z KSeF': 'etykietaDrugorzedna',
};

/** Kolor zmiany wpływów wobec poprzedniego miesiąca ze znaku widocznego w napisie (`znakZmiany`): „0%” jest neutralne. */
const ZNAK_ZMIANY_KOLOR: Record<-1 | 0 | 1, keyof Kolory> = { [-1]: 'blad', 0: 'etykietaDrugorzedna', 1: 'sukces' };

const KATEGORIE = ['Wszystkie', 'Sprzedaż', 'Usługi', 'Biuro', 'Paliwo', 'Telefon'] as const;
const STATUSY = ['Wszystkie', 'Opłacona', 'Korekta', 'Zatwierdzony', 'Do akceptacji', 'Z KSeF'] as const;

export default function EkranPrzeplywow() {
  const odczyt = useOdczyt<PrzeplywyOdpowiedz>('przeplywy');
  return odczyt ? <EkranPrzeplywowZBazy odczyt={odczyt} /> : <EkranPrzeplywowPrzyklad />;
}

/** Statusy operacji jak tabela strony (`cashFlowOperations`). */
const NAZWA_STATUSU: Record<OperacjaPrzeplywu['status'], Operacja['status']> = {
  paid: 'Opłacona',
  correction: 'Korekta',
  reviewed: 'Zatwierdzony',
  pending: 'Do akceptacji',
  ksef: 'Z KSeF',
};
type OperacjaPrzeplywu = Extract<PrzeplywyOdpowiedz['operacje'], { ok: true }>['dane'][number];
const KLUCZE_OKRESOW = ['tydzien', 'miesiac', 'rok'] as const;
const zl = (x: number) => kwota(grosze(x));
const zlKrotko = (x: number) => kwotaKrotka(grosze(x));

/** Karta z błędem: zdanie serwera zamiast treści (błąd jednej karty nie zabiera ekranu). */
function BladKarty({ naglowek, blad }: { naglowek: string; blad: string }) {
  return (
    <Sekcja naglowek={naglowek}>
      <Wiersz tytul="Nie udało się policzyć" podtytul={bezDlugichMyslnikow(blad)} ikona="error-warning-line" ikonaKolor="ostrzezenie" />
    </Sekcja>
  );
}

/**
 * Przepływy na prawdziwym koncie (M10e): karty strony `/przeplywy` z
 * `GET /przeplywy`. Kwoty, saldo i sumy liczy serwer; telefon tylko filtruje
 * listę operacji po kategorii i statusie.
 */
function EkranPrzeplywowZBazy({ odczyt }: { odczyt: StanOdczytu<PrzeplywyOdpowiedz> }) {
  const pasek = useKoloryPaska(false);
  const router = useRouter();
  const [okres, setOkres] = useState(1);
  const [kategoria, setKategoria] = useState('Wszystkie');
  const [status, setStatus] = useState<'Wszystkie' | Operacja['status']>('Wszystkie');
  const d = odczyt.dane;
  const operacjeWszystkie = d?.operacje.ok ? d.operacje.dane : [];
  const kategorie = ['Wszystkie', ...new Set(operacjeWszystkie.map((o) => o.kategoria))];
  const operacje = operacjeWszystkie
    .filter((o) => kategoria === 'Wszystkie' || o.kategoria === kategoria)
    .filter((o) => status === 'Wszystkie' || NAZWA_STATUSU[o.status] === status);

  return (
    <>
      {d?.operacje.ok ? (
        <Stack.Toolbar placement="right" {...pasek.narzedzia}>
          <Stack.Toolbar.Menu icon={IKONY_PASKA.filtr} iconRenderingMode="template" tintColor={pasek.ikona} title="Filtruj operacje">
            <Stack.Toolbar.Menu title="Kategoria" inline={GRUPY_MENU_W_LINII}>
              {kategorie.map((k) => (
                <Stack.Toolbar.MenuAction key={k} isOn={kategoria === k} onPress={() => setKategoria(k)}>
                  {k}
                </Stack.Toolbar.MenuAction>
              ))}
            </Stack.Toolbar.Menu>
            <Stack.Toolbar.Menu title="Status" inline={GRUPY_MENU_W_LINII}>
              {STATUSY.map((x) => (
                <Stack.Toolbar.MenuAction key={x} isOn={status === x} onPress={() => setStatus(x)}>
                  {x}
                </Stack.Toolbar.MenuAction>
              ))}
            </Stack.Toolbar.Menu>
          </Stack.Toolbar.Menu>
        </Stack.Toolbar>
      ) : null}
      <EkranOdczytu odczyt={odczyt} tytulBledu="Nie udało się wczytać przepływów" szkielet="Wczytujemy przepływy">
        {(dane) => {
          const w = dane.wykres.ok ? dane.wykres.dane[KLUCZE_OKRESOW[okres] ?? 'miesiac'] : null;
          return (
            <>
              {dane.tryb === 'przyklad' ? <Sekcja stopka="Dane przykładowe: prawdziwe przepływy zobaczysz po połączeniu KSeF na faktway.pl." /> : null}
              {dane.tryb === 'synchronizacja' ? <Sekcja stopka="Pobieramy faktury z KSeF. Liczby uzupełnią się same." /> : null}
              <Segmenty wartosci={OKRESY.map((o) => o.nazwa)} wybrany={okres} onZmiana={setOkres} etykieta="Okres przepływów" />
              {!dane.wykres.ok ? (
                <BladKarty naglowek="Przepływy pieniężne" blad={dane.wykres.blad} />
              ) : w ? (
                <>
                  <Kafle
                    kafle={[
                      { klucz: 'wplywy', podpis: 'Suma wpływów', wartosc: zlKrotko(w.sumaWplywow), ikona: 'arrow-down-circle-fill', ikonaKolor: 'sukces' },
                      { klucz: 'koszty', podpis: 'Suma kosztów', wartosc: zlKrotko(w.sumaKosztow), ikona: 'arrow-up-circle-fill', ikonaKolor: 'blad' },
                    ]}
                  />
                  <Sekcja naglowek="Saldo okresów" stopka="Oznaczone wpłaty minus koszty brutto. Zielony to nadwyżka, czerwony to więcej kosztów niż wpłat." swobodna>
                    <Wykres
                      punkty={w.kubelki.map((p) => ({
                        x: p.etykieta,
                        y: p.saldo,
                        kolor: p.saldo >= 0 ? 'sukces' : 'blad',
                        opis: `${p.okres}: wpływy ${zl(p.wplywy)}, koszty ${zl(p.koszty)}`,
                      }))}
                      etykieta="Saldo przepływów w okresach"
                    />
                  </Sekcja>
                </>
              ) : null}

              {dane.miesiac.ok ? (
                <Kafle
                  kafle={[
                    {
                      klucz: 'wplynelo',
                      ikona: 'wallet-line',
                      podpis: 'Wpłynęło w tym miesiącu',
                      wartosc: dane.miesiac.dane.wplywy.liczba > 0 ? zlKrotko(dane.miesiac.dane.wplywy.kwota) : 'Brak wpłat',
                      ...(dane.miesiac.dane.wplywy.zmianaPct !== null
                        ? { opis: `${zmiana(dane.miesiac.dane.wplywy.zmianaPct)} wobec poprzedniego miesiąca`, opisKolor: ZNAK_ZMIANY_KOLOR[znakZmiany(dane.miesiac.dane.wplywy.zmianaPct)] }
                        : {}),
                    },
                    {
                      klucz: 'kosztymies',
                      ikona: 'bank-card-line',
                      podpis: dane.kosztyKsefOd ? `Koszty w tym miesiącu (brutto, KSeF od ${dataKrotka(dzienZnacznika(dane.kosztyKsefOd) ?? dane.kosztyKsefOd.slice(0, 10))})` : 'Koszty w tym miesiącu (brutto)',
                      wartosc: zlKrotko(dane.miesiac.dane.koszty.kwota),
                      ...(dane.miesiac.dane.koszty.zmianaPct !== null ? { opis: `${zmiana(dane.miesiac.dane.koszty.zmianaPct)} wobec poprzedniego miesiąca` } : {}),
                      onPress: () => router.push('/koszty'),
                    },
                  ]}
                />
              ) : (
                <BladKarty naglowek="Ten miesiąc" blad={dane.miesiac.blad} />
              )}

              {dane.pierscien.ok ? (
                <Sekcja naglowek={dane.pierscien.dane.tytul} stopka={bezDlugichMyslnikow(dane.pierscien.dane.podpis)}>
                  <Wiersz
                    tytul={dane.pierscien.dane.linie[1]}
                    podtytul={bezDlugichMyslnikow(dane.pierscien.dane.podtytul)}
                    wartosc={dane.pierscien.dane.linie[0]}
                    wartoscPodpis={dane.pierscien.dane.linie[2]}
                    strzalka
                    onPress={() => router.push('/ksiegowosc')}
                  />
                </Sekcja>
              ) : (
                <BladKarty naglowek="Odłóż na podatek" blad={dane.pierscien.blad} />
              )}

              {dane.spodziewane.ok ? (
                <Sekcja naglowek="Spodziewane wpływy" stopka={`Następne 30 dni${dane.spodziewane.dane.liczba > 0 ? `: razem ${zl(dane.spodziewane.dane.suma)}` : ''}.`}>
                  {dane.spodziewane.dane.pozycje.length === 0
                    ? [<Wiersz key="brak" tytul="Brak faktur z terminem w 30 dni" />]
                    : dane.spodziewane.dane.pozycje.map((f) => (
                        <Wiersz
                          key={f.id}
                          tytul={f.nazwa}
                          podtytul={`${f.numer ? `${f.numer} · ` : ''}termin ${dataKrotka(f.termin)}`}
                          wartosc={zl(f.kwota)}
                          wartoscKolor="etykieta"
                          strzalka
                          onPress={() => router.push({ pathname: '/faktury/[id]', params: { id: f.id } })}
                        />
                      ))}
                </Sekcja>
              ) : (
                <BladKarty naglowek="Spodziewane wpływy" blad={dane.spodziewane.blad} />
              )}

              {dane.zrodla.ok ? (
                <Sekcja naglowek="Największe źródła przepływów" stopka="Ostatnie 12 miesięcy.">
                  {dane.zrodla.dane.length === 0
                    ? [<Wiersz key="brak" tytul="Brak wpływów i kosztów w 12 miesiącach" />]
                    : dane.zrodla.dane.map((z) => (
                        <Wiersz
                          key={`${z.kierunek}:${z.klucz}`}
                          tytul={z.nazwa}
                          podtytul={z.kierunek === 'in' ? 'Wpływy' : 'Koszty'}
                          wartosc={`${z.kierunek === 'in' ? '+' : '-'}${zlKrotko(z.kwota)}`}
                          wartoscKolor={z.kierunek === 'in' ? 'sukces' : 'blad'}
                          wartoscPodpis={`${z.udzial}%`}
                        />
                      ))}
                </Sekcja>
              ) : (
                <BladKarty naglowek="Największe źródła przepływów" blad={dane.zrodla.blad} />
              )}

              {dane.operacje.ok ? (
                <Sekcja
                  naglowek="Wszystkie operacje"
                  stopka={kategoria !== 'Wszystkie' || status !== 'Wszystkie' ? `Filtr: ${kategoria}, ${status}.` : 'Ostatnie 12 miesięcy, najwyżej 100 operacji.'}>
                  {operacje.length === 0
                    ? [<StanPusty key="pusto" ikona="inbox-archive-line" tytul="Brak operacji" opis="Oznacz zapłatę przy fakturze, a pojawi się tutaj." />]
                    : operacje.map((o) => (
                        <Wiersz
                          key={o.id}
                          tytul={o.kontrahent}
                          podtytul={`${o.kategoria} · ${dataKrotka(o.data)}`}
                          wartosc={`${o.kierunek === 'in' ? '+' : '-'}${zl(Math.abs(o.kwota))}`}
                          wartoscKolor={o.kierunek === 'in' ? 'sukces' : 'etykieta'}
                          wartoscPodpis={NAZWA_STATUSU[o.status]}
                          wartoscPodpisKolor={KOLOR_STATUSU[NAZWA_STATUSU[o.status]]}
                        />
                      ))}
                </Sekcja>
              ) : (
                <BladKarty naglowek="Wszystkie operacje" blad={dane.operacje.blad} />
              )}
            </>
          );
        }}
      </EkranOdczytu>
    </>
  );
}

/** Przepływy pieniężne na danych przykładowych: odpowiednik `app/(dashboard)/przeplywy`. */
function EkranPrzeplywowPrzyklad() {
  const pasek = useKoloryPaska(false);
  const router = useRouter();
  const [okres, setOkres] = useState(1);
  const [kategoria, setKategoria] = useState<(typeof KATEGORIE)[number]>('Wszystkie');
  const [status, setStatus] = useState<(typeof STATUSY)[number]>('Wszystkie');
  const dane = PRZEPLYWY[OKRESY[okres]?.klucz ?? 'miesiecznie'];
  const sumaWplywow = dane.reduce((s, p) => s + p.wplywy, 0);
  const sumaKosztow = dane.reduce((s, p) => s + p.koszty, 0);

  const spodziewane = FAKTURY.filter((f) => doZaplaty(f) && f.terminPlatnosci >= DZIS).sort((a, b) =>
    a.terminPlatnosci.localeCompare(b.terminPlatnosci),
  );
  const operacje = OPERACJE.filter((o) => kategoria === 'Wszystkie' || o.kategoria === kategoria).filter(
    (o) => status === 'Wszystkie' || o.status === status,
  );

  return (
    <>
      <Stack.Toolbar placement="right" {...pasek.narzedzia}>
        <Stack.Toolbar.Menu icon={IKONY_PASKA.filtr} iconRenderingMode="template" tintColor={pasek.ikona} title="Filtruj operacje">
          <Stack.Toolbar.Menu title="Kategoria" inline={GRUPY_MENU_W_LINII}>
            {KATEGORIE.map((k) => (
              <Stack.Toolbar.MenuAction key={k} isOn={kategoria === k} onPress={() => setKategoria(k)}>
                {k}
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.Menu title="Status" inline={GRUPY_MENU_W_LINII}>
            {STATUSY.map((s) => (
              <Stack.Toolbar.MenuAction key={s} isOn={status === s} onPress={() => setStatus(s)}>
                {s}
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>

      <EkranListy>
        <Segmenty wartosci={OKRESY.map((o) => o.nazwa)} wybrany={okres} onZmiana={setOkres} etykieta="Okres przepływów" />
        <Kafle
          kafle={[
            { klucz: 'wplywy', podpis: 'Suma wpływów', wartosc: kwotaKrotka(sumaWplywow * 100), ikona: 'arrow-down-circle-fill', ikonaKolor: 'sukces' },
            { klucz: 'koszty', podpis: 'Suma kosztów', wartosc: kwotaKrotka(sumaKosztow * 100), ikona: 'arrow-up-circle-fill', ikonaKolor: 'blad' },
          ]}
        />
        <Sekcja
          naglowek="Saldo okresów"
          stopka="Oznaczone wpłaty minus koszty brutto. Zielony to nadwyżka, czerwony to więcej kosztów niż wpłat."
          swobodna>
          <Wykres
            punkty={dane.map((p) => ({
              x: p.x,
              y: p.wplywy - p.koszty,
              kolor: p.wplywy >= p.koszty ? 'sukces' : 'blad',
              opis: `wpływy ${kwota(p.wplywy * 100)}, koszty ${kwota(p.koszty * 100)}`,
            }))}
            etykieta="Saldo przepływów w okresach"
          />
        </Sekcja>

        <Kafle
          kafle={[
            { klucz: 'wplynelo', ikona: 'wallet-line', podpis: 'Wpłynęło w tym miesiącu', wartosc: kwotaKrotka(WPLYNELO_MIESIAC.kwota), opis: `${zmiana(WPLYNELO_MIESIAC.zmiana)} wobec poprzedniego miesiąca`, opisKolor: WPLYNELO_MIESIAC.zmiana < 0 ? 'blad' : 'sukces' },
            { klucz: 'kosztymies', ikona: 'bank-card-line', podpis: 'Koszty w tym miesiącu (brutto)', wartosc: kwotaKrotka(KOSZTY_MIESIAC.kwota), opis: `${zmiana(KOSZTY_MIESIAC.zmiana)} wobec poprzedniego miesiąca`, onPress: () => router.push('/koszty') },
            { klucz: 'podatek', podpis: 'Odłóż na podatek', wartosc: kwotaKrotka(ODLOZ_NA_PODATEK.kwota), opis: `${ODLOZ_NA_PODATEK.procent}%, szacunek: liniowy, bez ZUS`, ikona: 'cash-line', onPress: () => router.push('/ksiegowosc') },
          ]}
        />

        <Sekcja naglowek="Spodziewane wpływy" stopka="Następne 30 dni.">
          {spodziewane.length === 0
            ? [<Wiersz key="brak" tytul="Brak faktur z terminem w 30 dni" />]
            : spodziewane.map((f) => (
                <Wiersz
                  key={f.id}
                  tytul={f.kontrahent}
                  podtytul={`Termin ${kiedyTermin(DZIS, f.terminPlatnosci)}`}
                  wartosc={kwota(f.brutto)}
                  wartoscKolor="etykieta"
                  strzalka
                  onPress={() => router.push({ pathname: '/faktury/[id]', params: { id: f.id } })}
                />
              ))}
        </Sekcja>

        <Sekcja naglowek="Największe źródła przepływów" stopka="Ostatnie 12 miesięcy.">
          {ZRODLA_PRZEPLYWOW.map((z) => (
            <Wiersz
              key={z.nazwa}
              tytul={z.nazwa}
              podtytul={z.opis}
              wartosc={`${z.kwota > 0 ? '+' : '−'}${kwotaKrotka(Math.abs(z.kwota))}`}
              wartoscKolor={z.kwota > 0 ? 'sukces' : 'blad'}
              wartoscPodpis={`${z.udzial}%`}
            />
          ))}
        </Sekcja>

        <Sekcja
          naglowek="Wszystkie operacje"
          stopka={kategoria !== 'Wszystkie' || status !== 'Wszystkie' ? `Filtr: ${kategoria}, ${status}.` : undefined}>
          {operacje.length === 0
            ? [<StanPusty key="pusto" ikona="inbox-archive-line" tytul="Brak operacji" opis="Oznacz zapłatę przy fakturze, a pojawi się tutaj." />]
            : operacje.map((o) => (
                <Wiersz
                  key={o.id}
                  tytul={o.kontrahent}
                  podtytul={`${o.kategoria} · ${dataKrotka(o.data)}`}
                  wartosc={`${o.kwota > 0 ? '+' : '−'}${kwota(Math.abs(o.kwota))}`}
                  wartoscKolor={o.kwota > 0 ? 'sukces' : 'etykieta'}
                  wartoscPodpis={o.status}
                  wartoscPodpisKolor={KOLOR_STATUSU[o.status]}
                />
              ))}
        </Sekcja>
      </EkranListy>
    </>
  );
}
