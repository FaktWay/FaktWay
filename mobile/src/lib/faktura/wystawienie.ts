/**
 * Szybka faktura z telefonu (etap M8): pola formularza na treść
 * `POST /api/mobile/v1/faktury`, błąd serwera z powrotem na pole formularza,
 * nabywcy z ostatnich faktur i klucz zapisu.
 *
 * Bez React Native: ten sam plik czytają testy strony
 * (`tests/unit/mobile-faktura-wystawienie.test.ts`), które sprawdzają wynik
 * prawdziwym schematem formularza strony. Importy względne (patrz `mobile/AGENTS.md`).
 *
 * Zasady faktury sprawdza serwer tym samym schematem co strona; telefon robi
 * tylko szybkie sprawdzenie przed wysłaniem (`sprawdz` w formularzu).
 */
import type { Faktura, MetodaPlatnosci, Pozycja } from '../../dane-przykladowe';
import type { FakturaTelefonu, RodzajIdOsobyTelefonu, StawkaVatTelefonu } from '../api/kontrakt';
import { dniMiedzy } from '../format';

/** Pozycja w polach formularza: tekst z klawiatury („1500,50”, „1,5”). */
export type PozycjaFormularza = { nazwa: string; ilosc: string; jednostka: string; cena: string; stawka: string };

/** Zwykła faktura VAT z formularza telefonu (pola jak w `faktury/nowa/[rodzaj].tsx`). */
export type FormularzZwyklej = {
  numer: string;
  dataWystawienia: string;
  dataSprzedazy: string;
  /** Termin w dniach od daty wystawienia (7, 14, 30). */
  terminDni: number;
  /** `ue` od M8b: firma z innego kraju UE (numer VAT-UE i kraj adresu). */
  rodzajNabywcy: 'firma' | 'osoba' | 'ue';
  nip: string;
  /** M8b, firma z UE: numer VAT-UE z prefiksem kraju i kod kraju adresu. */
  vatUe?: string;
  kraj?: string;
  /** M8b, osoba prywatna: identyfikator (brak = bez numeru) i jego numer. */
  idOsoby?: RodzajIdOsobyTelefonu;
  pesel?: string;
  dokument?: string;
  nazwa: string;
  adres1: string;
  adres2: string;
  email: string;
  metoda: MetodaPlatnosci;
  rachunek: string;
  mpp: boolean;
  pozycje: PozycjaFormularza[];
  uwagi: string;
  /** Seria numeracji z podpowiedzi serwera (krok 2.5) i numer, który podpowiedziała; `null` bez serii. */
  seria?: { id: string; podglad: string } | null;
};

/** „np_ii” od M8b: tylko dla firmy z innego kraju UE (regułę sprawdza serwer schematem strony). */
const STAWKI: readonly StawkaVatTelefonu[] = ['23', '8', '5', '0', 'zw', 'oo', 'np', 'np_ii'];

const METODY: Partial<Record<MetodaPlatnosci, FakturaTelefonu['paymentMethod']>> = {
  Przelew: 'transfer',
  Gotówka: 'cash',
  Karta: 'card',
};

/** Stawka, którą telefon wystawia (`StawkaVatTelefonu`); inna (np. „0 WDT”) to `null`: na stronie, nigdy jako 0% ani 23%. */
export function stawkaTelefonu(stawka: string): StawkaVatTelefonu | null {
  return STAWKI.find((s) => s === stawka) ?? null;
}

/**
 * Liczba z pola („1 500,5” → 1500.5) bez zaokrąglania: cena i ilość mogą mieć 4 miejsca po przecinku.
 * Puste pole, samo „-” i zapis spoza zakresu („1e999”, wklejony) to `NaN`: w JSON `Infinity` też
 * staje się `null`, a serwer odrzuca taką treść jako błąd kontraktu (obchód U7).
 */
export function liczbaZPola(tekst: string): number {
  const t = tekst.replace(/\s/g, '').replace(',', '.');
  const liczba = t ? Number(t) : NaN;
  return Number.isFinite(liczba) ? liczba : NaN;
}

/** RRRR-MM-DD plus dni (kalendarzowo, bez strefy). */
export function dodajDni(iso: string, dni: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dni);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Treść faktury dla serwera. Wartości jak z formularza strony: data sprzedaży
 * równa wystawieniu to pusty tekst, rachunek tylko przy przelewie (bez spacji),
 * NIP same cyfry, stawka tekstem (`zw`, `np` nie zamieniają się w 0%).
 */
export function doFakturyTelefonu(f: FormularzZwyklej): FakturaTelefonu {
  const osoba = f.rodzajNabywcy === 'osoba';
  const ue = f.rodzajNabywcy === 'ue';
  const metoda = METODY[f.metoda] ?? 'other';
  const idOsoby = f.idOsoby ?? 'no_id';
  return {
    internalNumber: f.numer.trim(),
    issueDate: f.dataWystawienia,
    saleDate: f.dataSprzedazy && f.dataSprzedazy !== f.dataWystawienia ? f.dataSprzedazy : '',
    buyerNip: osoba || ue ? '' : f.nip.replace(/\D/g, ''),
    buyerName: f.nazwa.trim(),
    buyerAddressLine1: f.adres1.trim(),
    buyerAddressLine2: f.adres2.trim(),
    buyerEmail: f.email.trim(),
    buyerIsConsumer: osoba,
    lines: f.pozycje.map((p) => ({
      name: p.nazwa.trim(),
      unit: p.jednostka.trim() || 'szt',
      quantity: liczbaZPola(p.ilosc),
      unitPriceNet: liczbaZPola(p.cena),
      // Stawka spoza telefonu idzie bez zmian i serwer ją odrzuci; formularz zatrzymuje ją wcześniej (`sprawdz`).
      vatRate: (stawkaTelefonu(p.stawka) ?? p.stawka) as StawkaVatTelefonu,
    })),
    paymentMethod: metoda,
    paymentDueDate: dodajDni(f.dataWystawienia, f.terminDni),
    bankAccount: metoda === 'transfer' ? f.rachunek.replace(/\s/g, '') : '',
    notes: f.uwagi.trim(),
    splitPayment: f.mpp,
    // Numer z licznika serii nadaje baza, gdy w polu została podpowiedź (jak formularz strony).
    numberSeriesId: f.seria?.id ?? '',
    numberPreview: f.seria?.podglad ?? '',
    // M8b: osoba z identyfikatorem i firma z UE jak pola formularza strony (bez nich treść jak w M8).
    ...(osoba && idOsoby !== 'no_id'
      ? {
          buyerConsumerIdType: idOsoby,
          buyerPesel: idOsoby === 'pesel' ? (f.pesel ?? '').replace(/\D/g, '') : '',
          buyerIdDocument: idOsoby === 'pesel' ? '' : (f.dokument ?? '').trim(),
        }
      : {}),
    ...(ue ? { buyerIsEu: true, buyerVatUe: (f.vatUe ?? '').replace(/[\s.-]/g, '').toUpperCase(), buyerCountryCode: f.kraj ?? '' } : {}),
  };
}

/** Klucze błędów formularza telefonu (`bledy` w `faktury/nowa/[rodzaj].tsx`). */
export type PoleBledu = 'numer' | 'nazwa' | 'nip' | 'adres' | 'pozycje' | 'rachunek' | 'termin' | 'ogolny';

/** Pole formularza strony z odpowiedzi `invoice_invalid` (`buyerName`, `lines.0.name`) na pole telefonu. */
export function poleFormularza(pole: string | undefined): PoleBledu {
  const glowa = pole?.split('.')[0] ?? '';
  switch (glowa) {
    case 'internalNumber':
    case 'issueDate':
    case 'saleDate':
      return 'numer';
    case 'buyerName':
      return 'nazwa';
    case 'buyerNip':
    case 'buyerIsConsumer':
    case 'buyerConsumerIdType':
    // M8b: numer VAT-UE, kraj, PESEL i dokument stoją w polu identyfikatora nabywcy.
    case 'buyerIsEu':
    case 'buyerVatUe':
    case 'buyerCountryCode':
    case 'buyerPesel':
    case 'buyerIdDocument':
      return 'nip';
    case 'buyerAddressLine1':
    case 'buyerAddressLine2':
      return 'adres';
    case 'lines':
      return 'pozycje';
    case 'bankAccount':
    case 'splitPayment':
      return 'rachunek';
    case 'paymentDueDate':
      return 'termin';
    default:
      return 'ogolny';
  }
}

const ZAPIS_DZIESIETNY = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/;

/** 10 do potęgi `n` jako BigInt, bez operatora `**` (Babel potrafi zamienić go na `Math.pow`, który BigInt odrzuca). */
function dziesiecDo(n: number): bigint {
  return BigInt(`1${'0'.repeat(n)}`);
}

/**
 * Liczba jako dokładny ułamek dziesiętny (cyfry / 10^miejsca), jak `decimalParts`
 * serwera (`lib/xml/invoice-calculator.ts`, którego telefon nie importuje).
 * `String(liczba)` to najkrótszy zapis, który wraca do tej samej liczby, więc
 * cena 3,33 to cyfry 333 i 2 miejsca, a nie rozwinięcie dwójkowe 3,3299….
 * Serwer dostaje te same liczby w treści żądania (`doFakturyTelefonu`).
 * `null` dla NaN i nieskończoności.
 */
function czesciDziesietne(liczba: number): { cyfry: bigint; miejsca: number } | null {
  const dopasowanie = ZAPIS_DZIESIETNY.exec(String(liczba));
  if (!dopasowanie) return null;
  const [, znak, calosc = '0', ulamek = '', wykladnik = '+0'] = dopasowanie;
  const miejsca = ulamek.length - Number(wykladnik);
  const cyfry = BigInt(calosc + ulamek) * (miejsca < 0 ? dziesiecDo(-miejsca) : BigInt(1));
  return { cyfry: znak === '-' ? -cyfry : cyfry, miejsca: Math.max(miejsca, 0) };
}

/** a / b do liczby całkowitej, połówka od zera (b > 0), jak `divRoundHalfAway` serwera. */
function podzielOdZera(a: bigint, b: bigint): bigint {
  const ujemna = a < BigInt(0);
  const wynik = ((ujemna ? -a : a) * BigInt(2) + b) / (b * BigInt(2));
  return ujemna ? -wynik : wynik;
}

/** Ilość × cena w groszach jak `multiplyToGrosze` serwera: dokładnie, od 0,5 grosza w górę; `null` przy polu pustym albo błędnym. */
function iloczynWGroszach(a: number, b: number): bigint | null {
  const x = czesciDziesietne(a);
  const y = czesciDziesietne(b);
  if (!x || !y) return null;
  const iloczyn = x.cyfry * y.cyfry;
  const miejsca = x.miejsca + y.miejsca;
  return miejsca <= 2 ? iloczyn * dziesiecDo(2 - miejsca) : podzielOdZera(iloczyn, dziesiecDo(miejsca - 2));
}

/**
 * Netto, VAT i brutto pozycji w groszach tak, jak policzy je serwer
 * (`calculateLineItem`): netto = ilość × cena z pola bez zaokrąglania ceny,
 * VAT = netto × stawka, każde do grosza od 0,5 grosza w górę (art. 106e
 * ust. 11 ustawy o VAT), na liczbach całkowitych. Na liczbach
 * zmiennoprzecinkowych część połówek schodziła w dół (5 % od 80,30 zł dawało
 * 4,01 zamiast 4,02, a 2,5 × 3,33 zł 8,32 zamiast 8,33), więc podgląd i kwota
 * na przycisku różniły się od wystawionej faktury (TEL-01). Pole puste albo
 * błędne liczy się jako 0 (formularz i tak je zatrzyma).
 */
export function kwotyPozycji(p: PozycjaFormularza): { netto: number; vat: number; brutto: number } {
  const netto = iloczynWGroszach(liczbaZPola(p.ilosc), liczbaZPola(p.cena)) ?? BigInt(0);
  const procent = /^\d+$/.test(p.stawka) ? BigInt(p.stawka) : BigInt(0);
  const vat = podzielOdZera(netto * procent, BigInt(100));
  return { netto: Number(netto), vat: Number(vat), brutto: Number(netto + vat) };
}

/**
 * Zapis z formularza otwartego w innej firmie niż wybrana teraz (np. po
 * odmowie firmy serwer odświeżył konto): odmowa, jak `expectedTenantId` na
 * stronie (UX-01). `null`, gdy firma ta sama.
 */
export function bladFirmyZapisu(firmaFormularza: string | null | undefined, firmaTeraz: string | null | undefined): string | null {
  if (firmaFormularza && firmaFormularza === firmaTeraz) return null;
  return 'Formularz był otwarty w innej firmie niż wybrana teraz. Zamknij formularz i wystaw fakturę od nowa w wybranej firmie.';
}

/** Stawka pozycji z bazy w zapisie telefonu albo `null`, gdy telefon jej nie wystawia. */
function stawkaPozycji(p: Pozycja): StawkaVatTelefonu | null {
  return stawkaTelefonu(p.stawkaOpis ?? String(p.stawkaVat));
}

/**
 * Czy „Duplikuj” tej faktury da się zrobić z telefonu: zwykła faktura VAT
 * w złotych, nabywca firma z NIP albo osoba bez numeru, stawki z listy
 * telefonu. Reszta (firma z UE, PESEL, np. II, waluta) na stronie, która
 * kopiuje te dane w całości (`prefillCore`).
 */
export function kopiaNaTelefonie(f: Faktura): boolean {
  return (
    f.rodzaj === 'vat' &&
    (f.waluta ?? 'PLN') === 'PLN' &&
    (f.nabywcaTyp === 'firma' || f.nabywcaTyp === 'osoba') &&
    // „np II” tylko z firmą z UE, a tej kopii telefon nie robi (nabywca `inny`): strona kopiuje całość.
    f.pozycje.every((p) => {
      const stawka = stawkaPozycji(p);
      return stawka !== null && stawka !== 'np_ii';
    })
  );
}

export type NabywcaZFaktury = {
  nazwa: string;
  nip: string;
  osoba: boolean;
  adres1: string;
  adres2: string;
  email: string;
  /** Dni do zapłaty z ostatniej faktury dla tego nabywcy (7, 14 albo 30). */
  terminDni: number;
};

/** Najbliższa opcja terminu (7, 14, 30 dni) dla zapisanej faktury. */
export function najblizszyTermin(dni: number): number {
  return [7, 14, 30].reduce((a, b) => (Math.abs(b - dni) < Math.abs(a - dni) ? b : a));
}

/**
 * Nabywcy z ostatnich faktur sprzedaży (najnowsze pierwsze, bez powtórzeń):
 * „wystaw dla ostatniego kontrahenta” (plan 3). Tylko faktury z adresem w dwóch
 * wierszach, bo bez adresu faktury nie da się wystawić.
 */
export function nabywcyZFaktur(faktury: readonly Faktura[], najwyzej = 20): NabywcaZFaktury[] {
  const widziani = new Set<string>();
  const wynik: NabywcaZFaktury[] = [];
  for (const f of faktury) {
    const linie = f.adresKontrahentaLinie;
    if (!linie?.linia1 || !linie.linia2 || !f.kontrahent || f.rodzaj !== 'vat') continue;
    // Firma z UE i osoba z PESEL albo dokumentem nie trafiają na listę: telefon wystawiłby je jako osobę bez numeru.
    if (f.nabywcaTyp !== 'firma' && f.nabywcaTyp !== 'osoba') continue;
    const osoba = f.nabywcaTyp === 'osoba';
    const nip = osoba ? '' : f.nipKontrahenta.replace(/\D/g, '');
    if (!osoba && nip.length !== 10) continue;
    const klucz = nip || `osoba:${f.kontrahent.toLowerCase()}`;
    if (widziani.has(klucz)) continue;
    widziani.add(klucz);
    wynik.push({
      nazwa: f.kontrahent,
      nip,
      osoba,
      adres1: linie.linia1,
      adres2: linie.linia2,
      email: f.emailKontrahenta ?? '',
      terminDni: najblizszyTermin(dniMiedzy(f.dataWystawienia, f.terminPlatnosci)),
    });
    if (wynik.length >= najwyzej) break;
  }
  return wynik;
}

/**
 * Klucz zapisu (`Idempotency-Key`): UUID v4, jeden na otwarcie formularza.
 * `crypto.getRandomValues`, gdy jest; inaczej `Math.random` (klucz jest
 * unikalny w obrębie konta i firmy, nie jest sekretem).
 */
export function kluczZapisu(losuj?: (bajty: Uint8Array) => void): string {
  const b = new Uint8Array(16);
  const zrodlo = losuj ?? (globalThis as { crypto?: { getRandomValues?: (t: Uint8Array) => void } }).crypto?.getRandomValues?.bind(
    (globalThis as { crypto?: object }).crypto,
  );
  if (zrodlo) zrodlo(b);
  else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
