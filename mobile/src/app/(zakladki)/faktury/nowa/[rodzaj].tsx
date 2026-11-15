import * as Haptics from 'expo-haptics';
import { Stack, useLocalSearchParams, usePreventRemove, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActionSheetIOS, Alert, Platform, StyleSheet, View } from 'react-native';

import {
  bruttoPozycji,
  cenaPozycji,
  DZIS,
  nettoPozycji,
  SPRZEDAWCA,
  stawkaTekst,
  vatPozycji,
  type Faktura,
  type MetodaPlatnosci,
  type Pozycja,
  type RodzajFaktury,
} from '@/dane-przykladowe';
import { KONTRAHENCI, type Kontrahent } from '@/dane-przykladowe/kontrahenci';
import { Dotyk } from '@/komponenty/dotyk';
import { PoleDaty, PolePrzelacznik, PoleTekstowe, PoleWyboru } from '@/komponenty/formularz';
import { Ikona } from '@/komponenty/ikona';
import { useStylKarty } from '@/komponenty/karta';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { NaglowekKwoty } from '@/komponenty/naglowek';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { Tekst } from '@/komponenty/tekst';
import { EkranTylkoNaStronie } from '@/komponenty/na-stronie';
import { PrzyciskPaska } from '@/komponenty/przycisk-paska';
import {
  bladFirmyZapisu,
  dodajDni,
  doFakturyTelefonu,
  kluczZapisu,
  kopiaNaTelefonie,
  kwotyPozycji,
  liczbaZPola,
  najblizszyTermin,
  stawkaTelefonu,
  nabywcyZFaktur,
  poleFormularza,
  type NabywcaZFaktury,
  type PozycjaFormularza,
} from '@/lib/faktura/wystawienie';
import { KRAJE_UE_TELEFONU, type RodzajIdOsobyTelefonu, type WyliczenieZadanie } from '@/lib/api/kontrakt';
import { grosze as groszeZApi } from '@/lib/dane/mapowanie';
import {
  doKorektyTelefonu,
  doRozliczeniaTelefonu,
  doZaliczkiTelefonu,
  krajZVatUe,
  poleRodzaju,
  poleZPozycji,
  type DokumentFormularza,
  type TypKorektyTelefonu,
} from '@/lib/faktura/rodzaje';
import { dataKrotka, dniMiedzy, doPola, groszeZPola as grosze, kwota } from '@/lib/format';
import { useKontoFirmy, usePodpowiedzFaktury, type RodzajPodpowiedzi } from '@/stan/dane';
import { szukajWGus, useKontekstKorekty, useWyliczenie, useZaliczkiDoRozliczenia } from '@/stan/faktury-rodzaje';
import { useStanFaktur, type ZapisNaKoncie } from '@/stan/faktury';
import { useKolory } from '@/wyglad/kolory';
import { CEL_DOTYKU, MARGINES, ODSTEP, PROMIEN_PIGULKI } from '@/wyglad/odstepy';

const TYTUL: Record<RodzajFaktury, string> = {
  vat: 'Nowa faktura',
  zaliczkowa: 'Faktura zaliczkowa',
  rozliczajaca: 'Faktura rozliczająca',
  korygujaca: 'Faktura korygująca',
};

const PREFIKS: Record<RodzajFaktury, string> = { vat: 'FV', zaliczkowa: 'FZ', rozliczajaca: 'FR', korygujaca: 'KOR' };

const STAWKI_ZWYKLE = [
  { wartosc: '23', etykieta: '23%' },
  { wartosc: '8', etykieta: '8%' },
  { wartosc: '5', etykieta: '5%' },
  { wartosc: '0', etykieta: '0%' },
  { wartosc: 'zw', etykieta: 'zw (zwolniona)' },
  { wartosc: 'oo', etykieta: 'oo (odwrotne obciążenie)' },
  { wartosc: 'np', etykieta: 'np (nie podlega)' },
];
const STAWKI_ZALICZKI = STAWKI_ZWYKLE.slice(0, 4);
const STAWKI_ROZLICZENIA = STAWKI_ZWYKLE.filter((s) => s.wartosc !== 'zw');
/** M8b: „np II” (usługa dla firmy z innego kraju UE) tylko przy nabywcy z UE; regułę sprawdza serwer schematem strony. */
const STAWKA_NP_II = { wartosc: 'np_ii', etykieta: 'np II (usługa dla firmy z UE)' };

const RODZAJ_PODPOWIEDZI: Record<RodzajFaktury, RodzajPodpowiedzi> = {
  vat: 'vat',
  zaliczkowa: 'zaliczka',
  rozliczajaca: 'rozliczenie',
  korygujaca: 'korekta',
};

/** Identyfikator osoby prywatnej jak w formularzu strony (`buyerConsumerIdType`). */
const IDENTYFIKATORY_OSOBY: { wartosc: RodzajIdOsobyTelefonu; etykieta: string }[] = [
  { wartosc: 'no_id', etykieta: 'Bez numeru identyfikacyjnego' },
  { wartosc: 'pesel', etykieta: 'PESEL' },
  { wartosc: 'id_card', etykieta: 'Dowód osobisty' },
  { wartosc: 'passport', etykieta: 'Paszport' },
];

/** Tekst w polach wyliczenia, gdy klient jeszcze go nie wpisał: kwoty od tekstu nie zależą (M8b). */
const NA_PODGLAD = { numer: 'PODGLAD', opis: 'Podgląd kwot', pozycja: 'Pozycja' } as const;

function stawkaProcent(s: string): number {
  return /^\d+$/.test(s) ? Number(s) : 0;
}

/**
 * Pozycja do sum i podglądu. Kwoty jak na serwerze (`kwotyPozycji`): ilość
 * razy cena z pola bez zaokrąglania ceny do groszy, „1 000” to tysiąc.
 */
function doPozycji(p: PozycjaFormularza): Pozycja {
  const kwoty = kwotyPozycji(p);
  return {
    nazwa: p.nazwa.trim(),
    ilosc: liczbaZPola(p.ilosc) || 0,
    jednostka: p.jednostka || 'szt',
    cenaNetto: grosze(p.cena) || 0,
    cenaTekst: p.cena.trim() || undefined,
    stawkaVat: stawkaProcent(p.stawka),
    ...(/^\d+$/.test(p.stawka) ? {} : { stawkaOpis: p.stawka }),
    ...kwoty,
  };
}

/** Pozycja zapisanej faktury z powrotem w polach formularza (wzór, korekta, edycja). */
function zPozycji(p: Pozycja): PozycjaFormularza {
  // Stawka bez procentu z bazy („zw”, „np”, „oo”) zostaje sobą, nie 0%; stawka spoza
  // listy (np. „np_ii”) też zostaje sobą, a `sprawdz` jej nie przepuści (M8, przegląd #716).
  const stawka = p.stawkaOpis ?? String(p.stawkaVat);
  // Cena z bazy z 4 miejscami (`cenaTekst`), nie grosze, które ją zaokrąglają.
  return { nazwa: p.nazwa, ilosc: String(p.ilosc).replace('.', ','), jednostka: p.jednostka, cena: p.cenaTekst ?? doPola(p.cenaNetto), stawka };
}

const PUSTA: PozycjaFormularza = { nazwa: '', ilosc: '1', jednostka: 'szt', cena: '', stawka: '23' };

/** Kontrahenci przykładowi w kształcie nabywców z faktur (jedna lista do wyboru w formularzu). */
const NABYWCY_PRZYKLADOWI: NabywcaZFaktury[] = KONTRAHENCI.map((k: Kontrahent) => {
  const [adres1, adres2] = k.adres.split(', ');
  return { nazwa: k.nazwa, nip: k.nip, osoba: false, adres1: adres1 ?? '', adres2: adres2 ?? '', email: k.email ?? '', terminDni: k.terminDni };
});

/**
 * Na prawdziwym koncie z telefonu wystawisz zwykłą fakturę VAT (M8), zaliczkę,
 * rozliczenie zaliczek i korektę (M8b), szkic albo z wysyłką do KSeF. Zmiana
 * szkicu (M8b) jak na stronie: szkic zwykłej faktury, który telefon kopiuje w
 * całości, otwiera się z danymi, a zapis usuwa stary szkic i zapisuje nowy;
 * reszta na stronie.
 */
export default function EkranFormularzaFaktury() {
  const { dane, faktury } = useStanFaktur();
  const { edytuj, wzor } = useLocalSearchParams<{ rodzaj: string; edytuj?: string; wzor?: string }>();
  // Decyzja z otwarcia: zapis zmiany usuwa stary szkic z listy, a formularz ma zostać do końca zapisu.
  const [edycjaNaStronie] = useState(() => {
    if (dane.zrodlo !== 'baza' || !edytuj) return false;
    const szkic = faktury.find((f) => f.id === edytuj);
    return !szkic || szkic.statusKsef !== 'robocza' || szkic.rodzaj !== 'vat' || !kopiaNaTelefonie(szkic);
  });
  if (edycjaNaStronie) return <EkranTylkoNaStronie co="edycja" idFaktury={edytuj} />;
  // Kopia faktury dla firmy z UE, osoby z PESEL, w walucie albo ze stawką spoza telefonu: strona kopiuje ją w całości.
  const wzorFaktury = wzor ? faktury.find((f) => f.id === wzor) : undefined;
  if (dane.zrodlo === 'baza' && wzorFaktury && !kopiaNaTelefonie(wzorFaktury)) {
    return <EkranTylkoNaStronie co="wystawienie" idFaktury={wzor} />;
  }
  return <FormularzFaktury />;
}

/**
 * Formularz faktury: zwykła, zaliczkowa, rozliczająca, korygująca. Odpowiednik
 * `components/invoices/invoice-form.tsx`, `advance-form.tsx`, `final-form.tsx`
 * i `correction-form.tsx` (pola i różnice jak na stronie). Układ Revolut
 * Business (D14; WZORCE-MOBBIN.md 3.2 i 3.5): najpierw Nabywca i Pozycje,
 * znany kontrahent i wypełniona pozycja zwinięte do wiersza, numer i daty jako
 * wiersze z wartościami, na dole przypięte „Podgląd” i „Wyślij do KSeF” z kwotą.
 */
function FormularzFaktury() {
  const router = useRouter();
  const { rodzaj: rodzajParam, wzor, z, edytuj, wprost } = useLocalSearchParams<{ rodzaj: string; wzor?: string; z?: string; edytuj?: string; wprost?: string }>();
  const rodzaj: RodzajFaktury = (['vat', 'zaliczkowa', 'rozliczajaca', 'korygujaca'] as const).find((r) => r === rodzajParam) ?? 'vat';
  const { faktury, dodajFakture, zastapFakture, usunSzkic, pokazPotwierdzenie, dane, dzis } = useStanFaktur();
  // Prawdziwe konto (M8): zwykła faktura przez API, nabywcy z ostatnich faktur, numer z podpowiedzi serwera.
  // M8b: zaliczka, rozliczenie i korekta też przez API; ich kwoty liczy serwer (`useWyliczenie`).
  const zBazy = dane.zrodlo === 'baza';
  const kwotySerweraWlaczone = zBazy && rodzaj !== 'vat';
  const podpowiedz = usePodpowiedzFaktury(RODZAJ_PODPOWIEDZI[rodzaj]);
  // Firma, w której otwarto formularz (jak `expectedTenantId` na stronie, UX-01): zapis w innej odmawia.
  const konto = useKontoFirmy();
  const firmaTeraz = konto?.firma?.id ?? null;
  const [firmaFormularza, setFirmaFormularza] = useState(firmaTeraz);
  if (!firmaFormularza && firmaTeraz) setFirmaFormularza(firmaTeraz);
  const kolory = useKolory();
  const stylKarty = useStylKarty();
  // Edycja szkicu albo odrzuconej faktury: te same pola, zapis w miejscu starej. Na prawdziwym koncie
  // (M8b) zapis usuwa stary szkic z listy, więc szkic z otwarcia formularza trzymamy w stanie.
  const [edytowana] = useState(() => faktury.find((f) => f.id === edytuj && (f.statusKsef === 'robocza' || f.statusKsef === 'odrzucona')));
  const wzorFaktury = edytowana ?? faktury.find((f) => f.id === wzor);
  const nabywcy = zBazy ? nabywcyZFaktur(faktury) : NABYWCY_PRZYKLADOWI;
  const dzien = zBazy ? dzis : DZIS;

  const startowy = nabywcy.find((k) => k.nazwa === (wzorFaktury?.kontrahent ?? faktury.find((f) => f.id === z)?.kontrahent));
  const [numer, setNumer] = useState(edytowana?.numer ?? (zBazy ? '' : `${PREFIKS[rodzaj]}/11/2026/${faktury.filter((f) => f.rodzaj === rodzaj).length + 1}`));
  const [dataWyst, setDataWyst] = useState(edytowana?.dataWystawienia ?? dzien);
  const [dataSprz, setDataSprz] = useState(edytowana?.dataWystawienia ?? dzien);
  const [termin, setTermin] = useState(
    edytowana ? String(najblizszyTermin(dniMiedzy(edytowana.dataWystawienia, edytowana.terminPlatnosci))) : String(startowy?.terminDni ?? 14),
  );
  const [rodzajNabywcy, setRodzajNabywcy] = useState<'firma' | 'osoba' | 'ue'>(edytowana?.nabywcaTyp === 'osoba' || startowy?.osoba ? 'osoba' : 'firma');
  const [nip, setNip] = useState(edytowana?.nipKontrahenta ?? startowy?.nip ?? '');
  const [nazwa, setNazwa] = useState(edytowana?.kontrahent ?? startowy?.nazwa ?? '');
  const [adres1, setAdres1] = useState(edytowana?.adresKontrahentaLinie?.linia1 ?? startowy?.adres1 ?? '');
  const [adres2, setAdres2] = useState(edytowana?.adresKontrahentaLinie?.linia2 ?? startowy?.adres2 ?? '');
  const [email, setEmail] = useState(edytowana?.emailKontrahenta ?? startowy?.email ?? '');
  // M8b: firma z UE (numer VAT-UE, kraj adresu) i osoba z PESEL albo dokumentem, jak w formularzu strony.
  const [vatUe, setVatUe] = useState('');
  const [kraj, setKraj] = useState('');
  const [idOsoby, setIdOsoby] = useState<RodzajIdOsobyTelefonu>('no_id');
  const [pesel, setPesel] = useState('');
  const [dokumentOsoby, setDokumentOsoby] = useState('');
  const [gusTrwa, setGusTrwa] = useState(false);
  const [metoda, setMetoda] = useState<MetodaPlatnosci>(edytowana?.metodaPlatnosci ?? 'Przelew');
  // Rachunek z ostatniej faktury z rachunkiem (strona podpowiada go tak samo przy „Wypełnij z ostatniej”).
  const [rachunek, setRachunek] = useState(edytowana?.rachunek ?? (zBazy ? (faktury.find((f) => f.rachunek)?.rachunek ?? '') : SPRZEDAWCA.rachunek));
  const [mpp, setMpp] = useState(edytowana?.mpp ?? false);
  const [pozycje, setPozycje] = useState<PozycjaFormularza[]>(
    wzorFaktury ? wzorFaktury.pozycje.map(zPozycji) : [PUSTA],
  );
  const [uwagi, setUwagi] = useState(edytowana?.uwagi ?? '');
  const [bledy, setBledy] = useState<Record<string, string>>({});
  // Jeden klucz zapisu na otwarcie formularza: ponowienie po zerwanym połączeniu nie wystawi drugiej faktury.
  const [klucz] = useState(() => kluczZapisu());
  const [trwa, setTrwa] = useState<'wyslij' | 'szkic' | null>(null);
  // Podpowiedź serwera (numer, zwolnienie z VAT) przychodzi po otwarciu: wpisujemy ją, póki klient nic nie zmienił.
  const [podpowiedzWpisana, setPodpowiedzWpisana] = useState(false);
  if (zBazy && podpowiedz.gotowe && !podpowiedzWpisana && !edytowana) {
    setPodpowiedzWpisana(true);
    if (podpowiedz.numer && !numer) setNumer(podpowiedz.numer);
    if (podpowiedz.zwolnienieVat && !wzorFaktury) setPozycje((l) => l.map((p) => (p === PUSTA ? { ...p, stawka: 'zw' } : p)));
  }
  // Zwinięte części formularza (Revolut Business): rozwija je dotknięcie albo błąd w środku.
  const [edycjaNabywcy, setEdycjaNabywcy] = useState(false);
  const [edycjaSzczegolow, setEdycjaSzczegolow] = useState(false);
  const [rozwinieta, setRozwinieta] = useState<number | null>(wzorFaktury ? null : 0);
  const [podglad, setPodglad] = useState(false);
  // Zaliczka.
  const [wartoscUmowy, setWartoscUmowy] = useState('');
  const [kwotaZaliczki, setKwotaZaliczki] = useState(edytowana?.rodzaj === 'zaliczkowa' ? doPola(edytowana.brutto) : '');
  const [stawkaZaliczki, setStawkaZaliczki] = useState('23');
  const [realizacja, setRealizacja] = useState(dodajDni(dzien, 30));
  const [opisZaliczki, setOpisZaliczki] = useState(edytowana?.rodzaj === 'zaliczkowa' ? (edytowana.pozycje[0]?.nazwa ?? '') : '');
  // Data otrzymania zaliczki (P_6, F12-D1); równa dacie wystawienia idzie jako brak.
  const [otrzymana, setOtrzymana] = useState(dzien);
  // Rozliczenie zaliczek.
  // Na prawdziwym koncie (M8b) lista z serwera: przyjęte w KSeF i jeszcze nierozliczone, z nabywcą.
  const zaliczkiSerwera = useZaliczkiDoRozliczenia(zBazy && rodzaj === 'rozliczajaca', firmaFormularza);
  const nipNabywcy = nip.replace(/\D/g, '');
  const zaliczki: { id: string; numer: string; kontrahent: string; nip: string; brutto: number; netto: number; nabywca?: { nazwa: string; adres1: string; adres2: string; email: string } }[] = zBazy
    ? zaliczkiSerwera.stan === 'gotowe'
      ? zaliczkiSerwera.zaliczki
          // Rozliczenie obejmuje tylko zaliczki tego samego nabywcy (art. 106f ust. 3): przy wpisanym NIP tylko jego.
          .filter((a) => nipNabywcy.length !== 10 || a.nabywca.nip === nipNabywcy)
          .map((a) => ({ id: a.id, numer: a.numer, kontrahent: a.nabywca.nazwa, nip: a.nabywca.nip ?? '', brutto: groszeZApi(a.brutto), netto: 0, nabywca: a.nabywca }))
      : []
    : faktury.filter((f) => f.rodzaj === 'zaliczkowa' && f.statusKsef === 'przyjeta').map((f) => ({ id: f.id, numer: f.numer, kontrahent: f.kontrahent, nip: f.nipKontrahenta, brutto: f.brutto, netto: f.netto }));
  const [wybraneZaliczki, setWybraneZaliczki] = useState<Record<string, boolean>>({});
  // Korekta.
  const [zrodloId, setZrodloId] = useState<string | undefined>(z);
  const [typKorekty, setTypKorekty] = useState<TypKorektyTelefonu>('kwotowa');
  const [typKsef, setTypKsef] = useState<'1' | '2' | '3'>('2');
  const [przyczyna, setPrzyczyna] = useState('');
  // Korekta kwotowa (M8b): zmiana netto, VAT i brutto wpisana jak na stronie, opis pozycji korekty.
  const [zmianaNetto, setZmianaNetto] = useState('');
  const [zmianaVat, setZmianaVat] = useState('');
  const [zmianaBrutto, setZmianaBrutto] = useState('');
  const [opisZmiany, setOpisZmiany] = useState('');
  const zrodlo = faktury.find((f) => f.id === zrodloId);
  // Faktura pierwotna z serwera (stan po przyjętych korektach): nabywca, pozycje „przed”, dozwolone typy.
  const kontekst = useKontekstKorekty(zBazy && rodzaj === 'korygujaca' ? zrodloId : undefined, firmaFormularza);
  const kontekstKorekty = kontekst.stan === 'gotowe' ? kontekst.kontekst : undefined;
  const [kontekstWpisany, setKontekstWpisany] = useState<string | null>(null);
  if (kontekstKorekty && kontekstWpisany !== kontekstKorekty.faktura.id) {
    // „Jest” startuje jako kopia „było” z serwera; po korekcie kwotowej wolno tylko kolejną kwotową.
    setKontekstWpisany(kontekstKorekty.faktura.id);
    setPozycje(kontekstKorekty.pozycje.map(poleZPozycji));
    if (kontekstKorekty.dozwolone === 'amount_change_only') setTypKorekty('kwotowa');
  }
  const stawkaBezVat = kontekstKorekty?.stawkaBezVat ?? null;

  // Zamknięcie ze zmianami pyta „Odrzucić zmiany?” (ZASADY-DESIGNU.md, sekcja 6), także gestem w dół.
  const migawka = JSON.stringify([numer, dataWyst, dataSprz, termin, rodzajNabywcy, nip, nazwa, adres1, adres2, email, metoda, rachunek, mpp, pozycje, uwagi,
    wartoscUmowy, kwotaZaliczki, stawkaZaliczki, realizacja, opisZaliczki, wybraneZaliczki, zrodloId, typKorekty, typKsef, przyczyna,
    vatUe, kraj, idOsoby, pesel, dokumentOsoby, otrzymana, zmianaNetto, zmianaVat, zmianaBrutto, opisZmiany]);
  // Na prawdziwym koncie punkt startowy to formularz po wpisaniu podpowiedzi serwera (to nie zmiana klienta).
  const [migawkaStartowa, setMigawkaStartowa] = useState<string | null>(zBazy && !edytowana ? null : migawka);
  if (migawkaStartowa === null && podpowiedzWpisana) setMigawkaStartowa(migawka);
  const zmienione = migawkaStartowa !== null && migawka !== migawkaStartowa;
  const [bezPytania, setBezPytania] = useState(false);
  const wylaczOchrone = usePreventRemove(!bezPytania && zmienione, ({ repeat }) => {
    const odrzuc = () => {
      setBezPytania(true);
      repeat();
    };
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { title: 'Odrzucić zmiany w fakturze?', options: ['Odrzuć zmiany', 'Wróć do faktury'], destructiveButtonIndex: 0, cancelButtonIndex: 1 },
        (i) => {
          if (i === 0) odrzuc();
        },
      );
    } else {
      Alert.alert('Odrzucić zmiany w fakturze?', undefined, [
        { text: 'Wróć do faktury', style: 'cancel' },
        { text: 'Odrzuć zmiany', style: 'destructive', onPress: odrzuc },
      ]);
    }
  });

  const wypelnijZ = (nazwaK: string) => {
    const k = nabywcy.find((x) => x.nazwa === nazwaK);
    if (!k) {
      // „Nowy nabywca”: czyste pola zamiast danych poprzednio wybranej firmy.
      setNip('');
      setNazwa('');
      setAdres1('');
      setAdres2('');
      setEmail('');
      return;
    }
    setNip(k.nip);
    setNazwa(k.nazwa);
    setAdres1(k.adres1);
    setAdres2(k.adres2);
    setEmail(k.email);
    setTermin(String(k.terminDni));
    if (rodzaj === 'vat') setRodzajNabywcy(k.osoba ? 'osoba' : 'firma');
  };

  const pozycjeGotowe = pozycje.map(doPozycji);
  const sumaNetto = pozycjeGotowe.reduce((s, p) => s + nettoPozycji(p), 0);
  const sumaVat = pozycjeGotowe.reduce((s, p) => s + vatPozycji(p), 0);
  const zaliczkaBrutto = grosze(kwotaZaliczki) || 0;
  // Na prawdziwym koncie kwoty zaliczki liczy serwer (POST /faktury/wyliczenie, M8b); to liczenie zostaje dla danych przykładowych.
  // filtr-wyjatek: kwoty-bez-float podgląd zaliczki tylko w trybie przykładowym; telefon wysyła do serwera wyłącznie zwykłą fakturę VAT (lib/api/mobile/schematy.ts)
  const zaliczkaNetto = Math.round(zaliczkaBrutto / (1 + stawkaProcent(stawkaZaliczki) / 100));
  const wybrane = zaliczki.filter((f) => wybraneZaliczki[f.id]);
  const idWybranych = wybrane.map((f) => f.id);
  const sumaWybranychZaliczek = wybrane.reduce((s, f) => s + f.brutto, 0);
  // Korekta pokazuje i zapisuje różnicę „jest” minus „było”, nie nową sumę.
  const zmianaKorekty = typKorekty === 'anulowanie' ? -(zrodlo?.brutto ?? 0) : sumaNetto + sumaVat - (zrodlo?.brutto ?? 0);

  // Prawdziwe konto (M8b): treść zaliczki, rozliczenia albo korekty dla serwera. `naPodglad` wstawia tekst
  // tam, gdzie klient go jeszcze nie wpisał, bo kwoty od tekstu nie zależą (wyliczenie niczego nie zapisuje).
  const dokumentFormularza = (naPodglad: boolean): DokumentFormularza => ({
    numer: numer.trim() || (naPodglad ? NA_PODGLAD.numer : ''),
    dataWystawienia: dataWyst,
    terminDni: Number(termin),
    metoda,
    rachunek,
    uwagi,
    seria: podpowiedz.seria ?? null,
  });
  const nabywcaFormularza = { nip, nazwa, adres1, adres2, email };
  const trescRodzaju = (naPodglad: boolean): WyliczenieZadanie | null => {
    if (!kwotySerweraWlaczone) return null;
    const tekst = (t: string, zamiast: string) => (naPodglad && t.trim().length < 5 ? zamiast : t);
    const pozycjeTresci = pozycje.map((p) => ({ ...p, nazwa: naPodglad && !p.nazwa.trim() ? NA_PODGLAD.pozycja : p.nazwa }));
    if (rodzaj === 'zaliczkowa') {
      return {
        zaliczka: doZaliczkiTelefonu({
          dokument: dokumentFormularza(naPodglad),
          nabywca: nabywcaFormularza,
          mpp,
          kwota: kwotaZaliczki,
          wartoscUmowy: naPodglad && !wartoscUmowy.trim() ? kwotaZaliczki : wartoscUmowy,
          stawka: stawkaZaliczki as '23' | '8' | '5' | '0',
          realizacja,
          otrzymana,
          opis: tekst(opisZaliczki, NA_PODGLAD.opis),
        }),
      };
    }
    if (rodzaj === 'rozliczajaca') {
      if (idWybranych.length === 0) return null;
      return { rozliczenie: doRozliczeniaTelefonu({ dokument: dokumentFormularza(naPodglad), nabywca: nabywcaFormularza, mpp, zaliczki: idWybranych, pozycje: pozycjeTresci }) };
    }
    if (!kontekstKorekty || !zrodloId) return null;
    return {
      korekta: doKorektyTelefonu({
        dokument: dokumentFormularza(naPodglad),
        fakturaId: zrodloId,
        typ: typKorekty,
        przyczyna: tekst(przyczyna, NA_PODGLAD.opis),
        typKsef,
        pozycje: pozycjeTresci,
        zmiana: { netto: zmianaNetto, vat: zmianaVat, brutto: zmianaBrutto, opis: naPodglad && !opisZmiany.trim() ? NA_PODGLAD.opis : opisZmiany },
      }),
    };
  };
  const wyliczenie = useWyliczenie(trescRodzaju(true), firmaFormularza);
  const kwotySerwera = wyliczenie.stan === 'gotowe' || wyliczenie.stan === 'liczymy' ? wyliczenie.kwoty : undefined;
  /** Kwota z serwera (zł) na ekranie; „…”, póki serwer jej nie policzył. */
  const zKwot = (v: number | undefined) => (v === undefined ? '…' : kwota(groszeZApi(v)));
  /** Brutto pozycji: z serwera dla zaliczki, rozliczenia i korekty (M8b), w zwykłej fakturze jak na serwerze (M8). */
  const bruttoWiersza = (i: number, p: PozycjaFormularza) => (kwotySerweraWlaczone ? zKwot(kwotySerwera?.pozycje[i]?.brutto) : kwota(bruttoPozycji(doPozycji(p))));
  const stopkaKwot = !kwotySerweraWlaczone
    ? undefined
    : wyliczenie.stan === 'blad'
      ? wyliczenie.komunikat
      : wyliczenie.stan === 'liczymy'
        ? 'Liczymy kwoty…'
        : wyliczenie.stan === 'czeka'
          ? rodzaj === 'korygujaca'
            ? 'Kwoty policzymy po wybraniu faktury pierwotnej.'
            : 'Kwoty policzymy po wybraniu zaliczek.'
          : 'Kwoty liczy FaktWay tak samo jak na stronie.';
  // Wysyłka tego rodzaju wstrzymana także na stronie (rozliczenie; korekta na produkcji): przycisk zapisuje szkic.
  const wysylkaWstrzymana = zBazy ? podpowiedz.wysylkaWstrzymana : undefined;

  /** Nazwa i adres firmy z Polski po NIP (kontrahenci firmy, potem GUS), jak „Pobierz z GUS” na stronie (M8b). */
  const pobierzZGus = async () => {
    if (gusTrwa) return;
    setGusTrwa(true);
    const w = await szukajWGus(konto, nip, firmaFormularza);
    setGusTrwa(false);
    if (!w.ok) {
      setBledy((b) => ({ ...b, nip: w.komunikat }));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }
    setBledy(({ nip: _bez, ...reszta }) => reszta);
    setNazwa(w.nabywca.nazwa);
    setAdres1(w.nabywca.adres1);
    setAdres2(w.nabywca.adres2);
  };

  const ustawPozycje = (i: number, zmiana: Partial<PozycjaFormularza>) =>
    setPozycje((lista) => lista.map((p, j) => (j === i ? { ...p, ...zmiana } : p)));

  const sprawdz = (): boolean => {
    const b: Record<string, string> = {};
    if (!numer.trim()) b.numer = 'Wpisz numer faktury.';
    // Nabywcę korekty na prawdziwym koncie bierze serwer z faktury pierwotnej (M8b): telefon go nie zmienia.
    if (rodzaj !== 'korygujaca' || (zrodlo && !zBazy)) {
      if (!nazwa.trim()) b.nazwa = 'Wpisz nazwę nabywcy.';
      if (!adres1.trim() || !adres2.trim()) b.adres = 'Wpisz oba wiersze adresu.';
      if ((rodzajNabywcy === 'firma' || rodzaj !== 'vat') && !/^\d{10}$/.test(nip.replace(/\D/g, ''))) b.nip = 'NIP ma 10 cyfr.';
      if (zBazy && rodzaj === 'vat' && rodzajNabywcy === 'ue' && !krajZVatUe(vatUe)) b.nip = 'Wpisz numer VAT-UE z prefiksem kraju UE, np. DE123456789.';
      if (zBazy && rodzaj === 'vat' && rodzajNabywcy === 'osoba') {
        if (idOsoby === 'pesel' && !/^\d{11}$/.test(pesel.replace(/\D/g, ''))) b.nip = 'PESEL ma 11 cyfr.';
        if ((idOsoby === 'id_card' || idOsoby === 'passport') && dokumentOsoby.trim().length < 3) b.nip = 'Wpisz numer dokumentu.';
      }
    }
    if (rodzaj === 'korygujaca' && !zrodlo) b.zrodlo = 'Wybierz fakturę, którą korygujesz.';
    if (rodzaj === 'korygujaca' && zBazy && zrodlo && !kontekstKorekty)
      b.zrodlo = kontekst.stan === 'blad' ? kontekst.komunikat : 'Poczekaj, aż wczytamy fakturę pierwotną.';
    if (rodzaj === 'korygujaca' && !przyczyna.trim()) b.przyczyna = 'Podaj przyczynę korekty (obowiązkowe).';
    if (rodzaj === 'korygujaca' && zBazy && typKorekty === 'kwotowa') {
      if (![zmianaNetto, zmianaVat, zmianaBrutto].every((t) => Number.isFinite(liczbaZPola(t)))) b.zmiana = 'Wpisz zmianę netto, VAT i brutto (przy zwrocie ze znakiem minus).';
      else if (!opisZmiany.trim()) b.zmiana = 'Opisz zmianę kwoty (to nazwa pozycji korekty).';
    }
    if (rodzaj === 'zaliczkowa' && !(zBazy ? liczbaZPola(kwotaZaliczki) > 0 : zaliczkaBrutto > 0)) b.zaliczka = 'Wpisz kwotę zaliczki brutto.';
    else if (rodzaj === 'zaliczkowa' && zBazy && !(liczbaZPola(wartoscUmowy) > 0)) b.zaliczka = 'Wpisz wartość zamówienia brutto.';
    else if (rodzaj === 'zaliczkowa' && zBazy && opisZaliczki.trim().length < 5) b.zaliczka = 'Opisz, za co jest zaliczka (co najmniej 5 znaków).';
    if (rodzaj === 'rozliczajaca' && wybrane.length === 0)
      b.zaliczki = zaliczki.length === 0 ? 'Najpierw wystaw fakturę zaliczkową.' : 'Zaznacz zaliczki, które rozliczasz.';
    if ((rodzaj === 'vat' || rodzaj === 'rozliczajaca' || (rodzaj === 'korygujaca' && (zBazy ? typKorekty === 'dane' : typKorekty !== 'anulowanie'))) && pozycje.some((p) => !p.nazwa.trim()))
      b.pozycje = 'Każda pozycja potrzebuje nazwy.';
    if (mpp && !rachunek.trim()) b.rachunek = 'MPP wymaga numeru rachunku.';
    // Stawki spoza telefonu (np. „0 WDT” z kopii) wystawia strona: nie zamieniamy ich na inną.
    const zPozycjami = rodzaj === 'vat' || rodzaj === 'rozliczajaca' || (rodzaj === 'korygujaca' && typKorekty === 'dane');
    if (zBazy && zPozycjami && !b.pozycje && pozycje.some((p) => stawkaTelefonu(p.stawka) === null))
      b.pozycje = 'Tę stawkę VAT wystawisz na faktway.pl.';
    // Prawdziwe konto: liczby idą do serwera bez zaokrąglania, więc puste albo błędne pole mówimy od razu.
    if (zBazy && zPozycjami && !b.pozycje && pozycje.some((p) => !(liczbaZPola(p.ilosc) > 0) || !(liczbaZPola(p.cena) >= 0)))
      b.pozycje = 'Każda pozycja potrzebuje ilości i ceny netto.';
    setBledy(b);
    const ok = Object.keys(b).length === 0;
    if (!ok) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    return ok;
  };

  const zapisz = async (wyslij: boolean) => {
    if (trwa || !sprawdz()) return;
    const pozycjeFaktury: Pozycja[] =
      rodzaj === 'zaliczkowa'
        ? [{ nazwa: opisZaliczki.trim() || 'Zaliczka', ilosc: 1, jednostka: 'usł.', cenaNetto: zaliczkaNetto, stawkaVat: stawkaProcent(stawkaZaliczki) }]
        : rodzaj === 'korygujaca' && typKorekty === 'anulowanie'
          ? (zrodlo?.pozycje ?? []).map((p) => ({ ...p, cenaNetto: -p.cenaNetto }))
          : pozycjeGotowe;
    let netto = pozycjeFaktury.reduce((s, p) => s + nettoPozycji(p), 0);
    let brutto = pozycjeFaktury.reduce((s, p) => s + bruttoPozycji(p), 0);
    if (kwotySerweraWlaczone) {
      // Prawdziwe konto (M8b): na liście od razu kwoty z serwera; lista z bazy przychodzi zaraz po zapisie.
      netto = kwotySerwera ? groszeZApi(kwotySerwera.netto) : 0;
      brutto = kwotySerwera ? groszeZApi(rodzaj === 'korygujaca' ? kwotySerwera.brutto : kwotySerwera.doZaplaty) : 0;
    } else if (rodzaj === 'rozliczajaca') {
      // Do zapłaty zostaje tylko to, czego nie pokryły zaliczki.
      netto -= wybrane.reduce((s, f) => s + f.netto, 0);
      brutto -= sumaWybranychZaliczek;
    }
    if (!kwotySerweraWlaczone && rodzaj === 'korygujaca' && typKorekty !== 'anulowanie' && zrodlo) {
      netto -= zrodlo.netto;
      brutto -= zrodlo.brutto;
    }
    const nowa: Faktura = {
      id: '',
      numer: numer.trim(),
      kontrahent: nazwa.trim(),
      nipKontrahenta: nip.replace(/\D/g, '') || '1234567890',
      dataWystawienia: dataWyst,
      terminPlatnosci: dodajDni(dataWyst, Number(termin)),
      netto,
      brutto,
      statusKsef: 'robocza',
      zaplacona: false,
      pozycje: kwotySerweraWlaczone ? [] : pozycjeFaktury,
      rodzaj,
      metodaPlatnosci: metoda,
      rachunek: metoda === 'Przelew' ? rachunek : undefined,
      mpp,
      uwagi: [rodzaj === 'korygujaca' ? `Przyczyna korekty: ${przyczyna.trim()}` : '', uwagi.trim()].filter(Boolean).join('\n') || undefined,
    };
    if (edytowana && !zBazy) {
      setBezPytania(true);
      wylaczOchrone();
      zastapFakture(edytowana.id, nowa, wyslij);
      router.dismissTo('/faktury');
      if (wyslij) {
        pokazPotwierdzenie(edytowana.id);
        router.push({ pathname: '/faktury/[id]', params: { id: edytowana.id } });
      }
      return;
    }
    if (zBazy) {
      const zlaFirma = bladFirmyZapisu(firmaFormularza, firmaTeraz);
      if (zlaFirma) {
        setBledy({ serwer: zlaFirma });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        return;
      }
    }
    const tresc = trescRodzaju(false);
    const naKoncie: ZapisNaKoncie | undefined = !zBazy || !firmaFormularza
      ? undefined
      : tresc
        ? { klucz, firma: firmaFormularza, tresc }
        : {
            klucz,
            firma: firmaFormularza,
            faktura: doFakturyTelefonu({
              numer, dataWystawienia: dataWyst, dataSprzedazy: dataSprz, terminDni: Number(termin), rodzajNabywcy,
              nip, nazwa, adres1, adres2, email, metoda, rachunek, mpp, pozycje, uwagi,
              vatUe, kraj, idOsoby, pesel, dokument: dokumentOsoby,
              // Numer z serii (krok 2.5): podpowiedź serwera; przy zmianie szkicu numer szkicu zapisze się jak wpisany ręcznie.
              seria: edytowana ? null : (podpowiedz.seria ?? null),
            }),
          };
    setTrwa(wyslij ? 'wyslij' : 'szkic');
    if (zBazy && edytowana) {
      // Zmiana szkicu (M8b) jak na stronie: najpierw usunięcie starego szkicu (numer wolny), potem nowy zapis.
      // Ponowienie po nieudanym zapisie usuwa „już usunięty” szkic bez błędu, więc dane z formularza nie giną.
      const usuniety = await usunSzkic(edytowana.id);
      if (!usuniety.ok) {
        setTrwa(null);
        setBledy({ serwer: usuniety.komunikat });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        return;
      }
    }
    const wynik = await dodajFakture(nowa, wyslij, naKoncie);
    setTrwa(null);
    if (!wynik.ok) {
      // Zdanie serwera (te same zasady co strona) pod polem, którego dotyczy, i na liście nad przyciskiem.
      const pole = kwotySerweraWlaczone ? poleRodzaju(wynik.pole) : poleFormularza(wynik.pole);
      setBledy({ [pole === 'ogolny' ? 'serwer' : pole]: wynik.komunikat });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }
    setBezPytania(true);
    wylaczOchrone();
    router.dismissTo('/faktury');
    // Szkic zapisany, ale kolejka KSeF odmówiła: szczegół szkicu mówi dlaczego.
    if (wyslij && !wynik.uwaga) pokazPotwierdzenie(wynik.id);
    if (wyslij || wynik.uwaga) router.push({ pathname: '/faktury/[id]', params: { id: wynik.id, ...(wynik.uwaga ? { uwaga: wynik.uwaga } : {}) } });
  };

  const przyciskWyslij = rodzaj === 'zaliczkowa' ? 'Wyślij zaliczkę' : rodzaj === 'korygujaca' ? 'Wyślij korektę' : 'Wyślij do KSeF';
  const stawki =
    rodzaj === 'rozliczajaca'
      ? STAWKI_ROZLICZENIA
      : rodzaj === 'korygujaca' && zBazy
        ? [...STAWKI_ROZLICZENIA, ...(kontekstKorekty?.npIiDozwolone ? [STAWKA_NP_II] : [])]
        : zBazy && rodzajNabywcy === 'ue'
          ? [...STAWKI_ZWYKLE, STAWKA_NP_II]
          : STAWKI_ZWYKLE;
  // Kwota na przycisku: na prawdziwym koncie dla zaliczki, rozliczenia i korekty z serwera (M8b), `undefined` przed wyliczeniem.
  const doZaplatyFormularza: number | undefined = kwotySerweraWlaczone
    ? kwotySerwera
      ? groszeZApi(rodzaj === 'korygujaca' ? kwotySerwera.brutto : kwotySerwera.doZaplaty)
      : undefined
    : rodzaj === 'zaliczkowa'
      ? zaliczkaBrutto
      : rodzaj === 'rozliczajaca'
        ? sumaNetto + sumaVat - sumaWybranychZaliczek
        : rodzaj === 'korygujaca'
          ? zmianaKorekty
          : sumaNetto + sumaVat;
  const terminData = dodajDni(dataWyst, Number(termin));
  const znanyNabywca = nabywcy.some((k) => k.nazwa === nazwa);
  const nabywcaZwiniety = znanyNabywca && !edycjaNabywcy && !bledy.nazwa && !bledy.nip && !bledy.adres;
  const szczegolyZwiniete = rodzaj !== 'korygujaca' && !edycjaSzczegolow && !bledy.numer;
  const mamPozycje = zBazy && rodzaj === 'korygujaca'
    ? Boolean(kontekstKorekty) && typKorekty === 'dane'
    : !(rodzaj === 'zaliczkowa' || (rodzaj === 'korygujaca' && (!zrodlo || typKorekty === 'anulowanie')));
  // Pozycja bez nazwy zostaje rozwinięta: tam trzeba coś wpisać.
  const rozwinietaPozycja = (i: number) => i === rozwinieta || !(pozycje[i]?.nazwa.trim() ?? '');

  const k = kwotySerwera;
  const podsumowanie = kwotySerweraWlaczone ? (
    // Prawdziwe konto (M8b): kwoty z serwera, tymi samymi funkcjami co zapis na stronie.
    rodzaj === 'zaliczkowa' ? (
      <>
        <Wiersz tytul="Zaliczka netto" wartosc={zKwot(k?.netto)} />
        <Wiersz tytul={`VAT ${stawkaZaliczki}%`} wartosc={zKwot(k?.vat)} />
        <Wiersz tytul="Do zapłaty" wartosc={zKwot(k?.doZaplaty)} wartoscKolor="etykieta" />
      </>
    ) : rodzaj === 'rozliczajaca' ? (
      <>
        <Wiersz tytul="Razem brutto pozycji" wartosc={zKwot(k?.brutto)} />
        {(k?.zaliczki ?? []).map((a) => (
          <Wiersz key={a.id} tytul={`Zaliczka ${a.numer}`} wartosc={zKwot(-a.brutto)} />
        ))}
        <Wiersz tytul="Do zapłaty po odliczeniu zaliczek" wartosc={zKwot(k?.doZaplaty)} wartoscKolor="etykieta" />
      </>
    ) : (
      <>
        <Wiersz tytul="Zmiana netto" wartosc={zKwot(k?.netto)} />
        <Wiersz tytul="Zmiana VAT" wartosc={zKwot(k?.vat)} />
        <Wiersz tytul="Zmiana brutto" wartosc={zKwot(k?.brutto)} wartoscKolor="etykieta" />
      </>
    )
  ) : rodzaj === 'zaliczkowa' ? (
      <>
        <Wiersz tytul="Zaliczka netto" wartosc={kwota(zaliczkaNetto)} />
        <Wiersz tytul={`VAT ${stawkaZaliczki}%`} wartosc={kwota(zaliczkaBrutto - zaliczkaNetto)} />
        <Wiersz tytul="Do zapłaty" wartosc={kwota(zaliczkaBrutto)} wartoscKolor="etykieta" />
      </>
    ) : rodzaj === 'rozliczajaca' ? (
      <>
        <Wiersz tytul="Razem brutto pozycji" wartosc={kwota(sumaNetto + sumaVat)} />
        <Wiersz tytul="Suma wybranych zaliczek" wartosc={kwota(sumaWybranychZaliczek)} />
        <Wiersz tytul="Do zapłaty po odliczeniu zaliczek" wartosc={kwota(sumaNetto + sumaVat - sumaWybranychZaliczek)} wartoscKolor="etykieta" />
      </>
    ) : rodzaj === 'korygujaca' ? (
      <Wiersz tytul="Zmiana brutto" wartosc={kwota(zmianaKorekty)} wartoscKolor="etykieta" />
    ) : (
      <>
        <Wiersz tytul="Razem netto" wartosc={kwota(sumaNetto)} />
        <Wiersz tytul="VAT" wartosc={kwota(sumaVat)} />
        <Wiersz tytul="Razem brutto" wartosc={kwota(sumaNetto + sumaVat)} wartoscKolor="etykieta" />
      </>
    );

  return (
    <>
      <Stack.Screen
        options={{ title: podglad ? 'Podgląd faktury' : edytowana ? (edytowana.statusKsef === 'odrzucona' ? 'Popraw fakturę' : 'Edytuj szkic') : TYTUL[rodzaj] }}
      />
      {wprost ? (
        // Otwarty ze szczegółu albo karty kontrahenta: pod spodem nie ma wyboru rodzaju, więc „Anuluj” zamyka arkusz.
        <PrzyciskPaska strona="lewa" tytul="Anuluj" onPress={() => router.back()} />
      ) : null}
      <PrzyciskPaska strona="prawa" tytul={trwa === 'szkic' ? 'Zapisujemy…' : 'Szkic'} onPress={() => void zapisz(false)} />

      <EkranListy keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets contentContainerStyle={{ paddingBottom: WYSOKOSC_PASKA + ODSTEP.xl }}>
        {podglad ? (
          // Podgląd przed KSeF (WZORCE-MOBBIN.md 3.2): to, co zobaczy nabywca, bez pól.
          <>
            <NaglowekKwoty
              podpis={nazwa.trim() || 'Nabywca bez nazwy'}
              podpisWyrozniony
              wartosc={doZaplatyFormularza === undefined ? '…' : kwota(doZaplatyFormularza)}
              status={`${numer} · termin ${dataKrotka(terminData)}`}
            />
            <Sekcja naglowek="Nabywca">
              <Wiersz tytul={nazwa.trim() || 'Brak nazwy'} podtytul={[nip ? `NIP ${nip}` : '', [adres1, adres2].filter(Boolean).join(', '), email].filter(Boolean).join('\n')} />
            </Sekcja>
            {mamPozycje ? (
              <Sekcja naglowek="Pozycje">
                {pozycjeGotowe.map((p, i) => (
                  <Wiersz key={i} tytul={p.nazwa || `Pozycja ${i + 1}`} podtytul={`${p.ilosc} ${p.jednostka} × ${cenaPozycji(p)} netto · VAT ${stawkaTekst(p)}`} wartosc={bruttoWiersza(i, pozycje[i]!)} wartoscKolor="etykieta" />
                ))}
              </Sekcja>
            ) : null}
            <Sekcja naglowek="Podsumowanie" stopka={[stopkaKwot, 'Po wysłaniu do KSeF fakturę zmienisz tylko korektą.'].filter(Boolean).join(' ')}>
              {podsumowanie}
            </Sekcja>
            <Sekcja naglowek="Płatność">
              <Wiersz tytul="Data wystawienia" wartosc={dataKrotka(dataWyst)} />
              <Wiersz tytul="Termin płatności" wartosc={dataKrotka(terminData)} />
              <Wiersz tytul="Metoda" wartosc={metoda} />
              {metoda === 'Przelew' ? <Wiersz tytul="Rachunek" podtytul={rachunek} /> : null}
              {mpp ? <Wiersz tytul="MPP" wartosc="Podzielona płatność" /> : null}
            </Sekcja>
          </>
        ) : (
          <>
            {rodzaj === 'korygujaca' ? (
              <Sekcja naglowek="Faktura pierwotna" stopka={bledy.zrodlo ?? (zBazy && kontekst.stan === 'blad' ? kontekst.komunikat : 'Korygować można fakturę przyjętą w KSeF.')}>
                {zrodlo && zBazy && kontekst.stan !== 'gotowe' ? (
                  // Faktura pierwotna z serwera (M8b): czekamy na stan po korektach albo mówimy, czemu jej nie skorygujemy.
                  <>
                    <Wiersz
                      tytul={zrodlo.numer}
                      podtytul={kontekst.stan === 'blad' ? 'Tej faktury nie skorygujesz z telefonu' : 'Wczytujemy fakturę pierwotną…'}
                      {...(kontekst.stan === 'blad' ? { ikona: 'alert-fill' as const, ikonaKolor: 'ostrzezenie' as const } : {})}
                    />
                    <Wiersz tytul="Wybierz inną fakturę" akcja onPress={() => setZrodloId(undefined)} />
                  </>
                ) : zrodlo ? (
                  <>
                    <Wiersz
                      tytul={zrodlo.numer}
                      podtytul={`${zrodlo.kontrahent} · ${dataKrotka(zrodlo.dataWystawienia)}${kontekstKorekty?.poprzedniaKorekta ? `\nPo korekcie ${kontekstKorekty.poprzedniaKorekta.numer ?? ''}` : ''}`}
                      wartosc={kontekstKorekty?.faktura.brutto != null ? kwota(groszeZApi(kontekstKorekty.faktura.brutto)) : kwota(zrodlo.brutto)}
                    />
                    <Wiersz tytul="Wybierz inną fakturę" akcja onPress={() => setZrodloId(undefined)} />
                  </>
                ) : (
                  faktury
                    // Na prawdziwym koncie korekta zwykłej faktury VAT, jak lista na stronie (M8b).
                    .filter((f) => f.statusKsef === 'przyjeta' && (zBazy ? f.rodzaj === 'vat' : f.rodzaj !== 'korygujaca'))
                    .slice(0, 8)
                    .map((f) => (
                      <Wiersz
                        key={f.id}
                        tytul={f.numer}
                        podtytul={`${f.kontrahent} · ${dataKrotka(f.dataWystawienia)}`}
                        wartosc={kwota(f.brutto)}
                        wartoscPodpis="Wybierz"
                        wartoscPodpisKolor="akcent"
                        onPress={() => {
                          setZrodloId(f.id);
                          if (zBazy) return; // nabywca i pozycje „przed” przychodzą z serwera (`useKontekstKorekty`)
                          wypelnijZ(f.kontrahent);
                          // „Jest” startuje jako kopia „było”: zmienia się tylko to, co trzeba.
                          setPozycje(f.pozycje.map(zPozycji));
                        }}
                      />
                    ))
                )}
              </Sekcja>
            ) : null}

            {rodzaj === 'korygujaca' && kontekstKorekty ? (
              // Nabywca korekty to nabywca faktury pierwotnej (strona też go nie zmienia).
              <Sekcja naglowek="Nabywca" stopka="Korekta wskazuje nabywcę faktury pierwotnej.">
                <Wiersz
                  tytul={kontekstKorekty.nabywca.nazwa}
                  podtytul={[
                    kontekstKorekty.nabywca.nip ? `NIP ${kontekstKorekty.nabywca.nip}` : kontekstKorekty.nabywca.vatUe ? `VAT-UE ${kontekstKorekty.nabywca.vatUe}` : '',
                    [kontekstKorekty.nabywca.adres1, kontekstKorekty.nabywca.adres2].filter(Boolean).join(', '),
                  ]
                    .filter(Boolean)
                    .join('\n')}
                  zaznaczalna
                />
              </Sekcja>
            ) : null}

            {rodzaj !== 'korygujaca' && nabywcaZwiniety ? (
              <Sekcja naglowek={rodzaj === 'vat' ? 'Nabywca' : 'Nabywca (B2B)'} naglowekAkcja={{ tytul: 'Zmień', onPress: () => setEdycjaNabywcy(true) }}>
                <Wiersz
                  tytul={nazwa}
                  podtytul={[`NIP ${nip}`, [adres1, adres2].filter(Boolean).join(', '), email].filter(Boolean).join('\n')}
                  onPress={() => setEdycjaNabywcy(true)}
                />
              </Sekcja>
            ) : null}
            {rodzaj !== 'korygujaca' && !nabywcaZwiniety ? (
              <Sekcja
                naglowek={rodzaj === 'vat' ? 'Nabywca' : 'Nabywca (B2B)'}
                stopka={zBazy ? 'Na liście są nabywcy z ostatnich faktur. Nazwę i adres firmy z Polski uzupełnisz z GUS po NIP.' : 'Dane firmy z Polski uzupełnimy z GUS po wpisaniu NIP.'}>
                <PoleWyboru
                  etykieta="Kontrahent"
                  wartosc={znanyNabywca ? nazwa : ''}
                  opcje={[{ wartosc: '', etykieta: 'Nowy nabywca' }, ...nabywcy.map((k) => ({ wartosc: k.nazwa, etykieta: k.nazwa }))]}
                  onZmiana={(n) => {
                    wypelnijZ(n);
                    // Wybrany znany kontrahent od razu zwija się do jednego wiersza.
                    if (n) setEdycjaNabywcy(false);
                  }}
                />
                {rodzaj === 'vat' ? (
                  <PoleWyboru
                    etykieta="Rodzaj nabywcy"
                    wartosc={rodzajNabywcy}
                    opcje={[
                      { wartosc: 'firma', etykieta: 'Firma z Polski (NIP)' },
                      { wartosc: 'osoba', etykieta: 'Osoba prywatna' },
                      // Od M8b nabywca z UE (VAT-UE, np. II) także na prawdziwym koncie.
                      { wartosc: 'ue' as const, etykieta: 'Firma z UE (VAT-UE)' },
                    ]}
                    onZmiana={setRodzajNabywcy}
                  />
                ) : null}
                {zBazy && rodzaj === 'vat' && rodzajNabywcy === 'ue' ? (
                  // Firma z UE (M8b): numer VAT-UE i kraj adresu jak na stronie (kraj domyślnie z prefiksu numeru).
                  <>
                    <PoleTekstowe
                      etykieta="Numer VAT-UE"
                      wartosc={vatUe}
                      onZmiana={(t) => {
                        const zNumeru = krajZVatUe(t);
                        if (zNumeru && (!kraj || kraj === krajZVatUe(vatUe))) setKraj(zNumeru);
                        setVatUe(t);
                      }}
                      podpowiedz="DE123456789"
                      blad={bledy.nip}
                      cyfry
                    />
                    <PoleWyboru
                      etykieta="Kraj adresu"
                      wartosc={kraj}
                      opcje={[{ wartosc: '', etykieta: 'Wybierz kraj' }, ...KRAJE_UE_TELEFONU.map((x) => ({ wartosc: x.kod, etykieta: x.nazwa }))]}
                      onZmiana={setKraj}
                    />
                  </>
                ) : zBazy && rodzaj === 'vat' && rodzajNabywcy === 'osoba' ? (
                  // Osoba prywatna (M8b): identyfikator jak na stronie; bez numeru jak dotąd.
                  <>
                    <PoleWyboru etykieta="Identyfikator" wartosc={idOsoby} opcje={IDENTYFIKATORY_OSOBY} onZmiana={setIdOsoby} />
                    {idOsoby === 'pesel' ? (
                      <PoleTekstowe etykieta="PESEL" wartosc={pesel} onZmiana={setPesel} podpowiedz="11 cyfr" klawiatura="number-pad" blad={bledy.nip} cyfry />
                    ) : idOsoby !== 'no_id' ? (
                      <PoleTekstowe etykieta="Numer dokumentu" wartosc={dokumentOsoby} onZmiana={setDokumentOsoby} podpowiedz="np. ABC123456" blad={bledy.nip} cyfry />
                    ) : null}
                  </>
                ) : rodzajNabywcy !== 'osoba' || rodzaj !== 'vat' ? (
                  <PoleTekstowe
                    etykieta={rodzajNabywcy === 'ue' && rodzaj === 'vat' ? 'Numer VAT-UE' : 'NIP nabywcy'}
                    wartosc={nip}
                    onZmiana={setNip}
                    podpowiedz={rodzajNabywcy === 'ue' && rodzaj === 'vat' ? 'DE123456789' : '10 cyfr'}
                    klawiatura={rodzajNabywcy === 'ue' && rodzaj === 'vat' ? 'default' : 'number-pad'}
                    blad={bledy.nip}
                  />
                ) : null}
                {!zBazy && /^\d{10}$/.test(nip.replace(/\D/g, '')) && !nazwa ? (
                  <Wiersz tytul="Uzupełnij danymi z GUS" akcja onPress={() => wypelnijZ(KONTRAHENCI[0]?.nazwa ?? '')} />
                ) : null}
                {zBazy && (rodzajNabywcy === 'firma' || rodzaj !== 'vat') && /^\d{10}$/.test(nip.replace(/\D/g, '')) ? (
                  // „Pobierz z GUS” jak na stronie (M8b): najpierw kontrahenci firmy, potem GUS.
                  <Wiersz tytul={gusTrwa ? 'Szukamy w GUS…' : 'Uzupełnij danymi z GUS'} akcja onPress={() => void pobierzZGus()} />
                ) : null}
                <PoleTekstowe etykieta="Nazwa" wartosc={nazwa} onZmiana={setNazwa} podpowiedz="Nazwa firmy" blad={bledy.nazwa} />
                <PoleTekstowe etykieta="Adres" wartosc={adres1} onZmiana={setAdres1} podpowiedz="Ulica i numer" />
                <PoleTekstowe etykieta="Miejscowość" wartosc={adres2} onZmiana={setAdres2} podpowiedz="00-001 Warszawa" blad={bledy.adres} />
                <PoleTekstowe etykieta="E-mail" wartosc={email} onZmiana={setEmail} podpowiedz="opcjonalnie" klawiatura="email-address" />
              </Sekcja>
            ) : null}

            {rodzaj === 'zaliczkowa' ? (
              <Sekcja naglowek="Zaliczka" stopka={bledy.zaliczka}>
                <PoleTekstowe etykieta={zBazy ? 'Wartość zamówienia (brutto)' : 'Wartość umowy (brutto)'} wartosc={wartoscUmowy} onZmiana={setWartoscUmowy} podpowiedz="zł" klawiatura="decimal-pad" />
                <PoleTekstowe etykieta="Kwota zaliczki (brutto)" wartosc={kwotaZaliczki} onZmiana={setKwotaZaliczki} podpowiedz="zł" klawiatura="decimal-pad" />
                <PoleWyboru etykieta="Stawka VAT zaliczki" wartosc={stawkaZaliczki} opcje={STAWKI_ZALICZKI} onZmiana={setStawkaZaliczki} />
                <PoleDaty etykieta="Planowana realizacja" wartosc={realizacja} onZmiana={setRealizacja} najwczesniej={dataWyst} />
                {zBazy ? <PoleDaty etykieta="Zaliczka otrzymana" wartosc={otrzymana} onZmiana={setOtrzymana} /> : null}
                <PoleTekstowe etykieta="Opis" wartosc={opisZaliczki} onZmiana={setOpisZaliczki} podpowiedz="Za co jest zaliczka" wielowierszowe />
              </Sekcja>
            ) : null}

            {rodzaj === 'rozliczajaca' ? (
              <Sekcja
                naglowek="Faktury zaliczkowe do rozliczenia"
                stopka={bledy.zaliczki ?? (zBazy ? 'Rozliczysz zaliczki przyjęte w KSeF i jeszcze nierozliczone, tego samego nabywcy.' : undefined)}>
                {zBazy && zaliczkiSerwera.stan === 'ladowanie'
                  ? [<Wiersz key="laduje" tytul="Wczytujemy zaliczki…" />]
                  : zBazy && zaliczkiSerwera.stan === 'blad'
                    ? [
                        <Wiersz key="blad" tytul={zaliczkiSerwera.komunikat} ikona="alert-fill" ikonaKolor="ostrzezenie" />,
                        <Wiersz key="ponow" tytul="Spróbuj ponownie" akcja onPress={zaliczkiSerwera.ponow} />,
                      ]
                    : zaliczki.length === 0
                      ? [<Wiersz key="brak" tytul="Brak zaliczek do wyboru" podtytul={nipNabywcy.length === 10 && zBazy ? 'Ten nabywca nie ma zaliczek do rozliczenia.' : 'Najpierw wystaw fakturę zaliczkową.'} />]
                      : zaliczki.map((f) => (
                          <PolePrzelacznik
                            key={f.id}
                            etykieta={f.numer}
                            opis={`${f.kontrahent} · ${kwota(f.brutto)}`}
                            wartosc={Boolean(wybraneZaliczki[f.id])}
                            onZmiana={(v) => {
                              setWybraneZaliczki((w) => ({ ...w, [f.id]: v }));
                              // Pierwsza wybrana zaliczka wpisuje swojego nabywcę (rozliczenie jest dla tego samego nabywcy).
                              if (v && f.nabywca && !nazwa.trim()) {
                                setNip(f.nip);
                                setNazwa(f.nabywca.nazwa);
                                setAdres1(f.nabywca.adres1);
                                setAdres2(f.nabywca.adres2);
                                setEmail(f.nabywca.email);
                              }
                            }}
                          />
                        ))}
              </Sekcja>
            ) : null}

            {rodzaj === 'korygujaca' && zBazy && kontekstKorekty ? (
              // „Było” z serwera (M8b): stan po przyjętych korektach, tak jak liczy go strona.
              <Sekcja naglowek="Było" stopka={kontekstKorekty.poprzedniaKorekta ? `Stan po korekcie ${kontekstKorekty.poprzedniaKorekta.numer ?? ''}.` : 'Pozycje z faktury pierwotnej.'}>
                {kontekstKorekty.pozycje.map((p, i) => (
                  <Wiersz key={i} tytul={p.name} podtytul={`${String(p.quantity).replace('.', ',')} ${p.unit} × ${String(p.unitPriceNet).replace('.', ',')} zł netto, VAT ${STAWKI_ZWYKLE.find((x) => x.wartosc === p.vatRate)?.etykieta ?? p.vatRate}`} />
                ))}
              </Sekcja>
            ) : rodzaj === 'korygujaca' && zrodlo && !zBazy ? (
              <Sekcja naglowek="Było" stopka="Pozycje z faktury pierwotnej.">
                {zrodlo.pozycje.map((p, i) => (
                  <Wiersz key={i} tytul={p.nazwa} podtytul={`${p.ilosc} ${p.jednostka} × ${cenaPozycji(p)} netto, VAT ${stawkaTekst(p)}`} wartosc={kwota(bruttoPozycji(p))} />
                ))}
              </Sekcja>
            ) : null}

            {rodzaj === 'korygujaca' && zBazy && kontekstKorekty && typKorekty === 'kwotowa' ? (
              // Korekta kwotowa jak na stronie (M8b): różnicę wpisuje klient, spójność kwot i stawkę sprawdza serwer.
              <Sekcja
                naglowek="Zmiana kwoty"
                stopka={
                  bledy.zmiana ??
                  (stawkaBezVat
                    ? `Stawka z faktury pierwotnej: ${stawkaBezVat === 'np_ii' ? 'np II' : stawkaBezVat}, bez VAT. Zmiana VAT wynosi 0, a brutto jest równe netto.`
                    : 'Zwrot albo rabat wpisz ze znakiem minus.')
                }>
                <PoleTekstowe
                  etykieta="Zmiana netto (±)"
                  wartosc={zmianaNetto}
                  onZmiana={(t) => {
                    setZmianaNetto(t);
                    // Stawka bez VAT: VAT 0, a brutto przepisane z netto (jak pola tylko do odczytu na stronie).
                    if (stawkaBezVat) {
                      setZmianaVat('0');
                      setZmianaBrutto(t);
                    }
                  }}
                  podpowiedz="zł, np. -100,00"
                  klawiatura="numbers-and-punctuation"
                  cyfry
                />
                {stawkaBezVat ? (
                  <Wiersz tytul="Zmiana VAT" wartosc="0,00 zł" />
                ) : (
                  <PoleTekstowe etykieta="Zmiana VAT (±)" wartosc={zmianaVat} onZmiana={setZmianaVat} podpowiedz="zł" klawiatura="numbers-and-punctuation" cyfry />
                )}
                {stawkaBezVat ? (
                  <Wiersz tytul="Zmiana brutto" wartosc={zmianaBrutto || '0'} />
                ) : (
                  <PoleTekstowe etykieta="Zmiana brutto (±)" wartosc={zmianaBrutto} onZmiana={setZmianaBrutto} podpowiedz="zł" klawiatura="numbers-and-punctuation" cyfry />
                )}
                <PoleTekstowe etykieta="Opis pozycji korekty" wartosc={opisZmiany} onZmiana={setOpisZmiany} podpowiedz="np. Rabat za opóźnienie" />
              </Sekcja>
            ) : null}

            {mamPozycje ? (
              <Sekcja naglowek={rodzaj === 'korygujaca' ? 'Jest: pozycje' : 'Pozycje'} stopka={bledy.pozycje}>
                {pozycje.flatMap((p, i) =>
                  rozwinietaPozycja(i)
                    ? [
                        <Tekst key={`n${i}`} styl="footnote" waga="semibold" kolor="etykietaDrugorzedna" style={styles.numerPozycji}>
                          {`Pozycja ${i + 1}`}
                        </Tekst>,
                        <PoleTekstowe key={`a${i}`} etykieta="Nazwa" wartosc={p.nazwa} onZmiana={(t) => ustawPozycje(i, { nazwa: t })} podpowiedz="np. Projekt graficzny" />,
                        <PoleTekstowe key={`b${i}`} etykieta="Ilość" wartosc={p.ilosc} onZmiana={(t) => ustawPozycje(i, { ilosc: t })} klawiatura="decimal-pad" />,
                        <PoleTekstowe key={`c${i}`} etykieta="Jednostka" wartosc={p.jednostka} onZmiana={(t) => ustawPozycje(i, { jednostka: t })} />,
                        <PoleTekstowe
                          key={`d${i}`}
                          etykieta="Cena netto"
                          wartosc={p.cena}
                          onZmiana={(t) => ustawPozycje(i, { cena: t })}
                          podpowiedz="zł"
                          klawiatura={rodzaj === 'korygujaca' ? 'numbers-and-punctuation' : 'decimal-pad'}
                        />,
                        <PoleWyboru key={`e${i}`} etykieta="VAT" wartosc={p.stawka} opcje={stawki} onZmiana={(v) => ustawPozycje(i, { stawka: v })} />,
                        <Wiersz key={`f${i}`} tytul="Brutto" wartosc={bruttoWiersza(i, p)} wartoscKolor="etykieta" />,
                        ...(p.nazwa.trim() ? [<Wiersz key={`g${i}`} tytul="Gotowe" akcja onPress={() => setRozwinieta(null)} />] : []),
                        ...(pozycje.length > 1
                          ? [
                              <Wiersz
                                key={`h${i}`}
                                tytul="Usuń pozycję"
                                niszczacy
                                onPress={() => {
                                  setPozycje((l) => l.filter((_, j) => j !== i));
                                  setRozwinieta(null);
                                }}
                              />,
                            ]
                          : []),
                      ]
                    : [
                        <Wiersz
                          key={`z${i}`}
                          tytul={p.nazwa}
                          podtytul={`${p.ilosc} ${p.jednostka} × ${cenaPozycji(doPozycji(p))} · VAT ${[...STAWKI_ZWYKLE, STAWKA_NP_II].find((x) => x.wartosc === p.stawka)?.etykieta ?? p.stawka}`}
                          wartosc={bruttoWiersza(i, p)}
                          wartoscKolor="etykieta"
                          onPress={() => setRozwinieta(i)}
                          etykietaDostepnosci={`${p.nazwa}, ${bruttoWiersza(i, p)}. Dotknij, żeby zmienić.`}
                        />,
                      ],
                )}
                <Wiersz
                  tytul="Dodaj pozycję"
                  akcja
                  onPress={() => {
                    setPozycje((l) => [...l, PUSTA]);
                    setRozwinieta(pozycje.length);
                  }}
                />
              </Sekcja>
            ) : null}

            {szczegolyZwiniete ? (
              <Sekcja naglowek="Szczegóły" naglowekAkcja={{ tytul: 'Zmień', onPress: () => setEdycjaSzczegolow(true) }}>
                <Wiersz tytul="Numer" wartosc={numer} wartoscKolor="akcent" onPress={() => setEdycjaSzczegolow(true)} />
                <Wiersz tytul="Data wystawienia" wartosc={dataKrotka(dataWyst)} wartoscKolor="akcent" onPress={() => setEdycjaSzczegolow(true)} />
                {rodzaj === 'vat' ? <Wiersz tytul="Data sprzedaży" wartosc={dataKrotka(dataSprz)} wartoscKolor="akcent" onPress={() => setEdycjaSzczegolow(true)} /> : null}
                <Wiersz tytul="Termin płatności" wartosc={`${termin} dni, ${dataKrotka(terminData)}`} wartoscKolor="akcent" onPress={() => setEdycjaSzczegolow(true)} />
              </Sekcja>
            ) : (
              <Sekcja
                naglowek={rodzaj === 'korygujaca' ? 'Dane korekty' : 'Szczegóły'}
                stopka={rodzaj === 'korygujaca' ? 'Typ KSeF mówi, od kiedy korekta działa. Najczęściej: 2, od daty korekty.' : undefined}>
                <PoleTekstowe etykieta={rodzaj === 'korygujaca' ? 'Numer korekty' : 'Numer faktury'} wartosc={numer} onZmiana={setNumer} blad={bledy.numer} cyfry />
                <PoleDaty etykieta={rodzaj === 'korygujaca' ? 'Data korekty' : 'Data wystawienia'} wartosc={dataWyst} onZmiana={setDataWyst} />
                {rodzaj === 'vat' ? <PoleDaty etykieta="Data sprzedaży" wartosc={dataSprz} onZmiana={setDataSprz} /> : null}
                <PoleWyboru
                  etykieta="Termin płatności"
                  wartosc={termin}
                  opcje={[
                    { wartosc: '7', etykieta: '7 dni' },
                    { wartosc: '14', etykieta: '14 dni' },
                    { wartosc: '30', etykieta: '30 dni' },
                  ]}
                  onZmiana={setTermin}
                />
                {rodzaj === 'korygujaca' ? (
                  <>
                    <PoleWyboru
                      etykieta="Typ korekty"
                      wartosc={typKorekty}
                      opcje={[
                        { wartosc: 'kwotowa' as const, etykieta: 'Kwotowa (zwrot, rabat)' },
                        // Po korekcie kwotowej stan pozycji nie jest jednoznaczny: tylko kolejna kwotowa (jak na stronie, K4).
                        ...(kontekstKorekty?.dozwolone === 'amount_change_only'
                          ? []
                          : [
                              { wartosc: 'dane' as const, etykieta: 'Danych (było, jest)' },
                              { wartosc: 'anulowanie' as const, etykieta: 'Anulowanie faktury' },
                            ]),
                      ]}
                      onZmiana={setTypKorekty}
                    />
                    <PoleWyboru
                      etykieta="Typ KSeF"
                      wartosc={typKsef}
                      opcje={[
                        { wartosc: '1', etykieta: '1: data faktury' },
                        { wartosc: '2', etykieta: '2: data korekty' },
                        { wartosc: '3', etykieta: '3: inna data' },
                      ]}
                      onZmiana={(v) => setTypKsef(v as '1' | '2' | '3')}
                    />
                    <PoleTekstowe etykieta="Przyczyna korekty" wartosc={przyczyna} onZmiana={setPrzyczyna} podpowiedz="np. rabat za opóźnienie" blad={bledy.przyczyna} wielowierszowe />
                  </>
                ) : null}
              </Sekcja>
            )}

            <Sekcja naglowek="Płatność" stopka={mpp ? 'Przy MPP nabywca płaci VAT na rachunek VAT.' : 'MPP obowiązuje m.in. dla faktur firmowych powyżej 15 000 zł brutto z załącznika 15.'}>
              <PoleWyboru
                etykieta="Metoda płatności"
                wartosc={metoda}
                opcje={(['Przelew', 'Gotówka', 'Karta', 'Kompensata', 'Inna'] as const)
                  .filter((m) => m !== 'Kompensata' || rodzaj === 'zaliczkowa' || rodzaj === 'rozliczajaca')
                  .map((m) => ({ wartosc: m, etykieta: m }))}
                onZmiana={setMetoda}
              />
              {metoda === 'Przelew' ? <PoleTekstowe etykieta="Rachunek" wartosc={rachunek} onZmiana={setRachunek} klawiatura="number-pad" blad={bledy.rachunek} /> : null}
              <PolePrzelacznik etykieta="Podzielona płatność (MPP)" wartosc={mpp} onZmiana={setMpp} />
            </Sekcja>

            <Sekcja naglowek="Podsumowanie" stopka={[stopkaKwot, wysylkaWstrzymana].filter(Boolean).join(' ') || undefined}>
              {podsumowanie}
            </Sekcja>

            <Sekcja naglowek="Uwagi">
              <PoleTekstowe etykieta="Uwagi" wartosc={uwagi} onZmiana={setUwagi} podpowiedz="Widoczne na fakturze (do 3500 znaków)" wielowierszowe />
            </Sekcja>
          </>
        )}

        {Object.keys(bledy).length > 0 ? (
          // Błędy stoją pod polami wyżej; tu ich lista nad przyciskiem, żeby nie trzeba było ich szukać.
          <View style={styles.bledy} accessibilityLiveRegion="polite">
            <Tekst styl="subheadline" kolor="blad" pogrubiony>
              {bledy.serwer && Object.keys(bledy).length === 1 ? 'Nie zapisaliśmy faktury:' : 'Do poprawy wyżej:'}
            </Tekst>
            {Object.values(bledy).map((b) => (
              <Tekst key={b} styl="subheadline" kolor="blad">
                {b}
              </Tekst>
            ))}
          </View>
        ) : null}
      </EkranListy>

      {/* Przypięte na dole jak w Revolut Business: podgląd i wysyłka z kwotą (makieta z 12.11.2026). */}
      {/* W arkuszu `useSafeAreaInsets` zawyża dolny margines (sprawdzone w symulatorze), więc stałe 32 pt nad paskiem domowym. */}
      <View style={[styles.pasek, { paddingBottom: ODSTEP.xxl, backgroundColor: kolory.tloGrupowane }]}>
        <Dotyk
          onPress={() => setPodglad((p) => !p)}
          accessibilityRole="button"
          accessibilityLabel={podglad ? 'Wróć do edycji faktury' : 'Podgląd faktury przed wysłaniem'}
          style={[styles.okragly, stylKarty, styles.okraglyKsztalt]}>
          <Ikona nazwa={podglad ? 'pencil-line' : 'eye-line'} rozmiar={22} kolor={kolory.etykieta} />
        </Dotyk>
        <View style={styles.rozciagniety}>
          {wysylkaWstrzymana ? (
            // Wysyłka tego rodzaju wstrzymana także na stronie (zdanie w podsumowaniu): główna akcja to szkic.
            <PrzyciskGlowny tytul="Zapisz szkic" ikona="file-text-line" trwa={trwa === 'szkic'} onPress={() => void zapisz(false)} />
          ) : (
            <PrzyciskGlowny
              tytul={doZaplatyFormularza === undefined ? przyciskWyslij : `${przyciskWyslij} · ${kwota(doZaplatyFormularza)}`}
              ikona="send-plane-line"
              trwa={trwa === 'wyslij'}
              onPress={() => void zapisz(true)}
            />
          )}
        </View>
      </View>
    </>
  );
}

/** Wysokość przypiętego paska z przyciskami (bez bezpiecznego marginesu u dołu). */
const WYSOKOSC_PASKA = CEL_DOTYKU + ODSTEP.xxs + ODSTEP.xs + ODSTEP.xxl;

const styles = StyleSheet.create({
  bledy: { gap: ODSTEP.linia, marginHorizontal: MARGINES + ODSTEP.xxs, marginTop: ODSTEP.l },
  numerPozycji: { paddingHorizontal: MARGINES, paddingTop: ODSTEP.s },
  pasek: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', gap: ODSTEP.s, paddingHorizontal: MARGINES, paddingTop: ODSTEP.xs },
  okragly: { width: CEL_DOTYKU + ODSTEP.xxs, height: CEL_DOTYKU + ODSTEP.xxs, alignItems: 'center', justifyContent: 'center' },
  okraglyKsztalt: { borderRadius: PROMIEN_PIGULKI },
  rozciagniety: { flex: 1 },
});
