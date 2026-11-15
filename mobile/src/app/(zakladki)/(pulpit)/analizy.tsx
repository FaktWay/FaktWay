import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';

import { FAKTURY, KOSZTY } from '@/dane-przykladowe';
import { ANALIZA_KOSZTY, ANALIZA_SPRZEDAZ, kalendarz } from '@/dane-przykladowe/pulpit';
import { Segmenty } from '@/komponenty/formularz';
import { Kafle } from '@/komponenty/kafle';
import { Kalendarz } from '@/komponenty/kalendarz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { Wykres } from '@/komponenty/wykres';
import { dataKrotka, kwota, kwotaKrotka, zmiana } from '@/lib/format';
import { dni } from '@/lib/status-faktury';
import { EkranOdczytu } from '@/komponenty/ekran-odczytu';
import { bezDlugichMyslnikow } from '@/lib/api/bledy';
import type { AnalizyOdpowiedz } from '@/lib/api/kontrakt-wiecej';
import { grosze } from '@/lib/dane/mapowanie';
import { odmiana } from '@/lib/wiecej';
import { useKontoFirmy } from '@/stan/dane';
import { useOdczyt } from '@/stan/odczyt';
import { IKONY_PASKA } from '@/wyglad/ikony-paska';
import { useKoloryPaska } from '@/wyglad/naglowki';

const MIESIACE = ['Listopad 2026', 'Październik 2026', 'Wrzesień 2026', 'Sierpień 2026', 'Lipiec 2026', 'Czerwiec 2026'];

export default function EkranAnaliz() {
  const zBazy = useKontoFirmy() !== null;
  return zBazy ? <EkranAnalizZBazy /> : <EkranAnalizPrzyklad />;
}

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
 * Analizy na prawdziwym koncie (M10e): karty stron `/analizy/sprzedaz`
 * i `/analizy/koszty` z `GET /analizy`. Kwoty, procenty udziałów i odcienie
 * kalendarza liczy serwer; telefon wybiera widok i miesiąc (jeden z sześciu
 * podanych przez serwer).
 */
function EkranAnalizZBazy() {
  const pasek = useKoloryPaska(false);
  const router = useRouter();
  const { rodzaj } = useLocalSearchParams<{ rodzaj?: string }>();
  const [widok, setWidok] = useState(rodzaj === 'koszty' ? 1 : 0);
  const [ostatniRodzaj, setOstatniRodzaj] = useState(rodzaj);
  if (rodzaj !== ostatniRodzaj) {
    setOstatniRodzaj(rodzaj);
    setWidok(rodzaj === 'koszty' ? 1 : 0);
  }
  const [miesiac, setMiesiac] = useState<string | null>(null);
  const sprzedaz = widok === 0;
  const odczyt = useOdczyt<AnalizyOdpowiedz>(`analizy?widok=${sprzedaz ? 'sprzedaz' : 'koszty'}${miesiac ? `&miesiac=${miesiac}` : ''}`);
  const d = odczyt?.dane;
  const nazwaMiesiaca = d?.miesiace.find((m) => m.klucz === d.miesiac)?.etykieta ?? '';
  if (!odczyt) return null;

  return (
    <>
      {d ? (
        <Stack.Toolbar placement="right" {...pasek.narzedzia}>
          <Stack.Toolbar.Menu icon={IKONY_PASKA.kalendarz} iconRenderingMode="template" tintColor={pasek.ikona} title="Wybierz miesiąc">
            {d.miesiace.map((m) => (
              <Stack.Toolbar.MenuAction key={m.klucz} isOn={d.miesiac === m.klucz} onPress={() => setMiesiac(m.klucz)}>
                {m.etykieta}
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
        </Stack.Toolbar>
      ) : null}
      <EkranOdczytu odczyt={odczyt} tytulBledu="Nie udało się wczytać analiz" szkielet="Wczytujemy analizy">
        {(a) => (
          <>
            <Segmenty wartosci={['Sprzedaż', 'Koszty']} wybrany={widok} onZmiana={setWidok} etykieta="Rodzaj analizy" />
            {a.tryb === 'przyklad' ? <Sekcja stopka="Dane przykładowe: prawdziwe analizy zobaczysz po połączeniu KSeF na faktway.pl." /> : null}
            {a.tryb === 'synchronizacja' ? <Sekcja stopka="Pobieramy faktury z KSeF. Liczby uzupełnią się same." /> : null}
            {a.kafle.ok ? (
              <Sekcja naglowek={sprzedaz ? `Sprzedaż: ${nazwaMiesiaca}` : `Wydatki: ${nazwaMiesiaca}`} bezKarty>
                <Kafle
                  kafle={[
                    { klucz: 'suma', ikona: sprzedaz ? 'line-chart-line' : 'receipt-line', podpis: sprzedaz ? 'Sprzedano (netto)' : 'Dokumenty (brutto)', wartosc: zlKrotko(a.kafle.dane.suma) },
                    { klucz: 'dziennie', ikona: 'calendar-line', podpis: 'Średnio dziennie', wartosc: zlKrotko(a.kafle.dane.srednioDziennie) },
                    { klucz: 'zmiana', ikona: 'percent-line', podpis: 'Wobec poprzedniego miesiąca', wartosc: a.kafle.dane.zmianaPct === null ? 'Brak porównania' : zmiana(a.kafle.dane.zmianaPct) },
                    { klucz: 'najlepszy', ikona: sprzedaz ? 'user-star-line' : 'price-tag3-line', podpis: sprzedaz ? 'Najlepszy klient' : 'Największa kategoria', wartosc: a.kafle.dane.najlepszy ?? 'Brak' },
                  ]}
                />
              </Sekcja>
            ) : (
              <BladKarty naglowek="Ten miesiąc" blad={a.kafle.blad} />
            )}

            {a.trend.ok ? (
              <Sekcja naglowek={sprzedaz ? 'Trend sprzedaży' : 'Trend wydatków'} stopka={sprzedaz ? 'Sprzedaż netto w ostatnich 6 miesiącach.' : 'Z KSeF i wydatków, brutto, 6 miesięcy.'} swobodna>
                <Wykres punkty={a.trend.dane.map((p) => ({ x: p.etykieta, y: p.kwota, opis: zl(p.kwota) }))} etykieta="Trend w ostatnich 6 miesiącach" />
              </Sekcja>
            ) : (
              <BladKarty naglowek={sprzedaz ? 'Trend sprzedaży' : 'Trend wydatków'} blad={a.trend.blad} />
            )}

            {a.podzial.ok ? (
              a.podzial.dane.length === 0 ? (
                <Sekcja naglowek={sprzedaz ? 'Najlepsze produkty i usługi' : 'Największe kategorie'}>
                  <Wiersz tytul={sprzedaz ? 'Brak sprzedaży w tym miesiącu' : 'Brak wydatków w tym miesiącu'} />
                </Sekcja>
              ) : (
                <>
                  <Sekcja naglowek={sprzedaz ? 'Sprzedaż według produktów' : 'Wydatki według kategorii'} swobodna>
                    <Wykres
                      rodzaj="kolo"
                      wysokosc={220}
                      punkty={a.podzial.dane.map((p) => ({ x: p.etykieta, y: p.kwota, opis: zl(p.kwota) }))}
                      etykieta={sprzedaz ? 'Udział produktów w sprzedaży' : 'Udział kategorii w wydatkach'}
                    />
                  </Sekcja>
                  <Sekcja naglowek={sprzedaz ? 'Najlepsze produkty i usługi' : 'Największe kategorie'}>
                    {a.podzial.dane.map((p, i) => (
                      <Wiersz key={p.klucz} tytul={p.pozostale ? p.etykieta : `${i + 1}. ${p.etykieta}`} wartosc={zl(p.kwota)} wartoscKolor="etykieta" wartoscPodpis={`${p.procent}%`} />
                    ))}
                  </Sekcja>
                </>
              )
            ) : (
              <BladKarty naglowek={sprzedaz ? 'Najlepsze produkty i usługi' : 'Największe kategorie'} blad={a.podzial.blad} />
            )}

            {a.ostatnie.ok ? (
              <Sekcja naglowek={sprzedaz ? 'Ostatnie faktury' : 'Ostatnie wydatki'} stopka={sprzedaz ? 'Przyjęte w KSeF w wybranym miesiącu, brutto.' : 'Najnowsze wydatki z wybranego miesiąca.'}>
                {a.ostatnie.dane.length === 0
                  ? [<Wiersz key="brak" tytul="Nic w tym miesiącu" />]
                  : a.ostatnie.dane.map((x) => (
                      <Wiersz
                        key={x.id}
                        tytul={x.nazwa}
                        podtytul={`${x.korekta ? 'Korekta · ' : ''}${x.numer ? `${x.numer} · ` : ''}${dataKrotka(x.data)}`}
                        wartosc={zl(x.kwota)}
                        wartoscKolor="etykieta"
                        strzalka={a.tryb !== 'przyklad'}
                        onPress={a.tryb === 'przyklad' ? undefined : () => router.push(sprzedaz ? { pathname: '/faktury/[id]', params: { id: x.id } } : { pathname: '/koszty/[id]', params: { id: x.id } })}
                      />
                    ))}
              </Sekcja>
            ) : (
              <BladKarty naglowek={sprzedaz ? 'Ostatnie faktury' : 'Ostatnie wydatki'} blad={a.ostatnie.blad} />
            )}

            {a.naleznosci ? (
              a.naleznosci.ok ? (
                <Sekcja naglowek="Należności" stopka={a.naleznosci.dane.pominieteWWalucie > 0 ? `Bez importów i faktur skorygowanych. Pominięto ${odmiana(a.naleznosci.dane.pominieteWWalucie, ['fakturę', 'faktury', 'faktur'])} w walucie obcej.` : 'Bez importów i faktur skorygowanych.'}>
                  <Wiersz tytul="Do zapłaty" podtytul={odmiana(a.naleznosci.dane.liczba, ['faktura', 'faktury', 'faktur'])} wartosc={zl(a.naleznosci.dane.doZaplaty)} />
                  <Wiersz tytul="Po terminie" podtytul={odmiana(a.naleznosci.dane.liczbaPoTerminie, ['faktura', 'faktury', 'faktur'])} wartosc={zl(a.naleznosci.dane.poTerminie)} wartoscKolor={a.naleznosci.dane.poTerminie > 0 ? 'ostrzezenie' : 'etykieta'} />
                  <Wiersz tytul="Najstarsza zaległość" wartosc={a.naleznosci.dane.najstarszaDni ? dni(a.naleznosci.dane.najstarszaDni) : 'Brak zaległości'} />
                </Sekcja>
              ) : (
                <BladKarty naglowek="Należności" blad={a.naleznosci.blad} />
              )
            ) : null}

            {a.vat ? (
              a.vat.ok ? (
                <Sekcja naglowek="VAT z wydatków" stopka="Wybrany miesiąc, VAT do odliczenia według dokumentu.">
                  <Wiersz tytul="VAT naliczony" wartosc={zl(a.vat.dane.vat)} />
                  <Wiersz tytul="VAT do odliczenia" wartosc={zl(a.vat.dane.doOdliczenia)} />
                  <Wiersz tytul="Do opisania" wartosc={odmiana(a.vat.dane.doOpisania, ['dokument', 'dokumenty', 'dokumentów'])} wartoscKolor={a.vat.dane.doOpisania > 0 ? 'ostrzezenie' : 'etykieta'} strzalka onPress={() => router.push('/koszty')} />
                </Sekcja>
              ) : (
                <BladKarty naglowek="VAT z wydatków" blad={a.vat.blad} />
              )
            ) : null}

            {a.wynik.ok ? (
              <Sekcja naglowek="Przychody a koszty" stopka="Wybrany miesiąc: sprzedaż netto i koszty jak w KPiR.">
                <Wiersz tytul="Przychody" wartosc={zl(a.wynik.dane.przychody)} />
                <Wiersz tytul="Koszty" wartosc={zl(a.wynik.dane.koszty)} />
                <Wiersz tytul="Wynik (netto)" wartosc={zl(a.wynik.dane.wynik)} wartoscKolor="etykieta" />
              </Sekcja>
            ) : (
              <BladKarty naglowek="Przychody a koszty" blad={a.wynik.blad} />
            )}

            {a.stali.ok ? (
              <Sekcja naglowek={sprzedaz ? 'Stali klienci' : 'Stałe koszty'} stopka={sprzedaz ? 'Klienci z fakturą w 3 z ostatnich 4 miesięcy.' : 'Dostawcy z kosztem w 3 z ostatnich 4 miesięcy.'}>
                {a.stali.dane.length === 0 ? [<Wiersz key="brak" tytul={sprzedaz ? 'Brak stałych klientów' : 'Brak stałych kosztów'} />] : null}
                {a.stali.dane.map((x) => (
                  <Wiersz key={x.klucz} tytul={x.nazwa} podtytul={`Zwykle ok. ${x.dzien}. dnia miesiąca`} wartosc={zl(x.srednio)} wartoscKolor="etykieta" wartoscPodpis="średnio / mies." />
                ))}
                {sprzedaz && a.stali.dane.length > 0 ? (
                  <Wiersz tytul="Zrób fakturę cykliczną" akcja strzalka onPress={() => router.navigate({ pathname: '/faktury', params: { widok: 'cykliczne' } })} />
                ) : null}
              </Sekcja>
            ) : (
              <BladKarty naglowek={sprzedaz ? 'Stali klienci' : 'Stałe koszty'} blad={a.stali.blad} />
            )}

            {a.kalendarz.ok ? (
              <Sekcja naglowek={sprzedaz ? 'Kalendarz sprzedaży' : 'Kalendarz wydatków'} stopka="Ostatnie 180 dni. Im ciemniej, tym większa kwota w dniu." swobodna>
                <Kalendarz dni={a.kalendarz.dane.map((x) => x.poziom)} etykieta={sprzedaz ? 'Kalendarz sprzedaży z 180 dni' : 'Kalendarz wydatków z 180 dni'} />
              </Sekcja>
            ) : (
              <BladKarty naglowek={sprzedaz ? 'Kalendarz sprzedaży' : 'Kalendarz wydatków'} blad={a.kalendarz.blad} />
            )}
          </>
        )}
      </EkranOdczytu>
    </>
  );
}

/**
 * Analizy sprzedaży i kosztów: odpowiednik `app/(dashboard)/analizy/sprzedaz`
 * i `analizy/koszty` (przełącznik Sprzedaż/Koszty, wybór miesiąca).
 */
function EkranAnalizPrzyklad() {
  const pasek = useKoloryPaska(false);
  const router = useRouter();
  const { rodzaj } = useLocalSearchParams<{ rodzaj?: string }>();
  const [widok, setWidok] = useState(rodzaj === 'koszty' ? 1 : 0);
  // Ekran już otwarty, a link prosi o drugi rodzaj analizy: przełącz widok.
  const [ostatniRodzaj, setOstatniRodzaj] = useState(rodzaj);
  if (rodzaj !== ostatniRodzaj) {
    setOstatniRodzaj(rodzaj);
    setWidok(rodzaj === 'koszty' ? 1 : 0);
  }
  const [miesiac, setMiesiac] = useState(MIESIACE[0] ?? '');
  const sprzedaz = widok === 0;
  const a = ANALIZA_SPRZEDAZ;
  const k = ANALIZA_KOSZTY;

  return (
    <>
      <Stack.Toolbar placement="right" {...pasek.narzedzia}>
        <Stack.Toolbar.Menu icon={IKONY_PASKA.kalendarz} iconRenderingMode="template" tintColor={pasek.ikona} title="Wybierz miesiąc">
          {MIESIACE.map((m) => (
            <Stack.Toolbar.MenuAction key={m} isOn={miesiac === m} onPress={() => setMiesiac(m)}>
              {m}
            </Stack.Toolbar.MenuAction>
          ))}
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>

      <EkranListy>
        <Segmenty wartosci={['Sprzedaż', 'Koszty']} wybrany={widok} onZmiana={setWidok} etykieta="Rodzaj analizy" />

        <Sekcja
          naglowek={sprzedaz ? `Sprzedaż: ${miesiac}` : `Wydatki: ${miesiac}`}
          stopka={sprzedaz ? 'Śledź sprzedaż, należności i stałych klientów miesiąc po miesiącu.' : 'Śledź wydatki, VAT i stałe koszty miesiąc po miesiącu.'}
          bezKarty>
          <Kafle
            kafle={
              sprzedaz
                ? [
                    { klucz: 'sprzedano', ikona: 'line-chart-line', podpis: 'Sprzedano (netto)', wartosc: kwotaKrotka(a.sprzedanoNetto) },
                    { klucz: 'dziennie', ikona: 'calendar-line', podpis: 'Średnio dziennie', wartosc: kwotaKrotka(a.srednioDziennie) },
                    { klucz: 'zmiana', ikona: 'percent-line', podpis: 'Wobec poprzedniego miesiąca', wartosc: zmiana(a.zmiana), opisKolor: 'sukces' },
                    { klucz: 'klient', ikona: 'user-star-line', podpis: 'Najlepszy klient', wartosc: a.najlepszyKlient },
                  ]
                : [
                    { klucz: 'dokumenty', ikona: 'receipt-line', podpis: 'Dokumenty (brutto)', wartosc: kwotaKrotka(k.dokumentyBrutto) },
                    { klucz: 'dziennie', ikona: 'calendar-line', podpis: 'Średnio dziennie', wartosc: kwotaKrotka(k.srednioDziennie) },
                    { klucz: 'zmiana', ikona: 'percent-line', podpis: 'Wobec poprzedniego miesiąca', wartosc: zmiana(k.zmiana) },
                    { klucz: 'kategoria', ikona: 'price-tag3-line', podpis: 'Największa kategoria', wartosc: k.najwiekszaKategoria },
                  ]
            }
          />
        </Sekcja>

        <Sekcja
          naglowek={sprzedaz ? 'Trend sprzedaży' : 'Trend wydatków'}
          stopka={sprzedaz ? 'Sprzedaż netto w ostatnich 6 miesiącach.' : 'Z KSeF i wydatków, brutto, 6 miesięcy.'}
          swobodna>
          <Wykres punkty={(sprzedaz ? a.trend : k.trend).map((p) => ({ ...p, opis: kwota(p.y * 100) }))} etykieta="Trend w ostatnich 6 miesiącach" />
        </Sekcja>

        <Sekcja naglowek={sprzedaz ? 'Sprzedaż według produktów' : 'Wydatki według kategorii'} swobodna>
          <Wykres
            rodzaj="kolo"
            wysokosc={220}
            punkty={(sprzedaz ? a.produkty : k.kategorie).map((p) => ({ ...p, opis: kwota(p.y * 100) }))}
            etykieta={sprzedaz ? 'Udział produktów w sprzedaży' : 'Udział kategorii w wydatkach'}
          />
        </Sekcja>

        <Sekcja naglowek={sprzedaz ? 'Najlepsze produkty i usługi' : 'Największe kategorie'}>
          {(sprzedaz ? a.produkty : k.kategorie)
            .slice()
            .sort((x, y) => y.y - x.y)
            .map((p, i, wszystkie) => {
              const suma = wszystkie.reduce((s, q) => s + q.y, 0);
              return (
                <Wiersz key={p.x} tytul={`${i + 1}. ${p.x}`} wartosc={kwota(p.y * 100)} wartoscKolor="etykieta" wartoscPodpis={`${Math.round((p.y / suma) * 100)}%`} />
              );
            })}
        </Sekcja>

        {sprzedaz ? (
          <>
            <Sekcja naglowek="Ostatnie faktury" stopka="Przyjęte w KSeF w wybranym miesiącu, brutto.">
              {FAKTURY.filter((f) => f.statusKsef === 'przyjeta')
                .slice(0, 4)
                .map((f) => (
                  <Wiersz
                    key={f.id}
                    tytul={f.kontrahent}
                    podtytul={`${f.numer} · ${dataKrotka(f.dataWystawienia)}`}
                    wartosc={kwota(f.brutto)}
                    wartoscKolor="etykieta"
                    strzalka
                    onPress={() => router.push({ pathname: '/faktury/[id]', params: { id: f.id } })}
                  />
                ))}
            </Sekcja>
            <Sekcja naglowek="Należności">
              <Wiersz tytul="Do zapłaty" wartosc={kwota(a.doZaplaty)} />
              <Wiersz tytul="Po terminie" wartosc={kwota(a.poTerminie)} wartoscKolor="ostrzezenie" />
              <Wiersz tytul="Najstarsza zaległość" wartosc={a.najstarszaZaleglosc > 0 ? dni(a.najstarszaZaleglosc) : 'Brak zaległości'} />
            </Sekcja>
          </>
        ) : (
          <>
            <Sekcja naglowek="Ostatnie wydatki">
              {KOSZTY.slice(0, 4).map((x) => (
                <Wiersz
                  key={x.id}
                  tytul={x.dostawca}
                  podtytul={`${x.opis} · ${dataKrotka(x.data)}`}
                  wartosc={kwota(x.brutto)}
                  wartoscKolor="etykieta"
                  strzalka
                  onPress={() => router.push({ pathname: '/koszty/[id]', params: { id: x.id } })}
                />
              ))}
            </Sekcja>
            <Sekcja naglowek="VAT z wydatków">
              <Wiersz tytul="VAT naliczony" wartosc={kwota(k.vatNaliczony)} />
              <Wiersz tytul="VAT do odliczenia" wartosc={kwota(k.vatDoOdliczenia)} />
              <Wiersz tytul="Do opisania" wartosc={`${k.doOpisania} dokumenty`} wartoscKolor="ostrzezenie" strzalka onPress={() => router.push('/koszty')} />
            </Sekcja>
          </>
        )}

        <Sekcja naglowek="Przychody a koszty">
          <Wiersz tytul="Przychody" wartosc={kwota(a.przychody)} />
          <Wiersz tytul="Koszty" wartosc={kwota(a.koszty)} />
          <Wiersz tytul="Wynik (netto)" wartosc={kwota(a.przychody - a.koszty)} wartoscKolor="etykieta" />
        </Sekcja>

        <Sekcja
          naglowek={sprzedaz ? 'Stali klienci' : 'Stałe koszty'}
          stopka={sprzedaz ? 'Klienci z fakturą w 3 z ostatnich 4 miesięcy.' : 'Dostawcy z kosztem w 3 z ostatnich 4 miesięcy.'}>
          {(sprzedaz ? a.staliKlienci : k.staleKoszty).map((s) => (
            <Wiersz
              key={s.nazwa}
              tytul={s.nazwa}
              podtytul={`Zwykle ok. ${s.dzien}. dnia miesiąca`}
              wartosc={kwota(s.srednio)}
              wartoscKolor="etykieta"
              wartoscPodpis="średnio / mies."
            />
          ))}
          {sprzedaz ? (
            <Wiersz tytul="Zrób fakturę cykliczną" akcja strzalka onPress={() => router.navigate({ pathname: '/faktury', params: { widok: 'cykliczne' } })} />
          ) : null}
        </Sekcja>

        <Sekcja naglowek={sprzedaz ? 'Kalendarz sprzedaży' : 'Kalendarz wydatków'} stopka="Ostatnie 180 dni. Im ciemniej, tym więcej dokumentów w dniu." swobodna>
          <Kalendarz dni={kalendarz(sprzedaz ? 3 : 5)} etykieta={sprzedaz ? 'Kalendarz sprzedaży z 180 dni' : 'Kalendarz wydatków z 180 dni'} />
        </Sekcja>
      </EkranListy>
    </>
  );
}
