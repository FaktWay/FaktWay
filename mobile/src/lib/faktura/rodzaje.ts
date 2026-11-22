/**
 * Zaliczka, rozliczenie i korekta z telefonu (etap M8b): pola formularza na
 * treść `POST /api/mobile/v1/faktury` i `POST /faktury/wyliczenie`, błąd
 * serwera z powrotem na pole formularza, kraj firmy z UE z numeru VAT-UE.
 *
 * Telefon kwot nie liczy: liczby z pól idą do serwera bez zaokrąglania,
 * a kwoty dokumentu (netto i VAT zaliczki, różnica korekty, kwota do
 * zapłaty po zaliczkach) przychodzą z `POST /faktury/wyliczenie`.
 *
 * Bez React Native: ten sam plik czytają testy strony
 * (`tests/unit/mobile-faktura-rodzaje.test.ts`), które sprawdzają wynik
 * prawdziwym schematem trasy. Importy względne (patrz `mobile/AGENTS.md`).
 */
import type { MetodaPlatnosci } from '../../dane-przykladowe';
import {
  KRAJE_UE_TELEFONU,
  type KorektaTelefonu,
  type MetodaRodzajuTelefonu,
  type NabywcaRodzajuTelefonu,
  type PozycjaRodzajuTelefonu,
  type RozliczenieTelefonu,
  type WyliczenieZadanie,
  type ZaliczkaTelefonu,
} from '../api/kontrakt';
import { dodajDni, liczbaZPola, type PozycjaFormularza } from './wystawienie';

/** Pola wspólne formularza dokumentu (jak w `faktury/nowa/[rodzaj].tsx`). */
export type DokumentFormularza = {
  numer: string;
  dataWystawienia: string;
  /** Termin w dniach od daty wystawienia (7, 14, 30). */
  terminDni: number;
  metoda: MetodaPlatnosci;
  rachunek: string;
  uwagi: string;
  /** Seria z podpowiedzi serwera i numer, który podpowiedziała; `null` bez serii. */
  seria?: { id: string; podglad: string } | null;
};

export type NabywcaFormularza = { nip: string; nazwa: string; adres1: string; adres2: string; email: string };

const METODY: Record<MetodaPlatnosci, MetodaRodzajuTelefonu> = {
  Przelew: 'transfer',
  Gotówka: 'cash',
  Karta: 'card',
  Kompensata: 'compensation',
  'Płatność mobilna': 'other',
  Inna: 'other',
};

function dokument(d: DokumentFormularza) {
  const metoda = METODY[d.metoda];
  return {
    internalNumber: d.numer.trim(),
    issueDate: d.dataWystawienia,
    paymentMethod: metoda,
    paymentDueDate: dodajDni(d.dataWystawienia, d.terminDni),
    bankAccount: metoda === 'transfer' ? d.rachunek.replace(/\s/g, '').replace(/^PL/i, '') : '',
    notes: d.uwagi.trim(),
    // Numer z licznika serii nadaje baza, gdy w polu została podpowiedź (jak formularz strony).
    numberSeriesId: d.seria?.id ?? '',
    numberPreview: d.seria?.podglad ?? '',
  };
}

function nabywca(n: NabywcaFormularza): NabywcaRodzajuTelefonu {
  return { nip: n.nip.replace(/\D/g, ''), name: n.nazwa.trim(), addressLine1: n.adres1.trim(), addressLine2: n.adres2.trim(), email: n.email.trim() };
}

/** Pozycja z pól; stawka bez zmian (np. „zw” w rozliczeniu odrzuci serwer zdaniem strony). */
export function pozycjaRodzaju(p: PozycjaFormularza): PozycjaRodzajuTelefonu {
  return {
    name: p.nazwa.trim(),
    unit: p.jednostka.trim() || 'szt',
    quantity: liczbaZPola(p.ilosc),
    unitPriceNet: liczbaZPola(p.cena),
    vatRate: p.stawka as PozycjaRodzajuTelefonu['vatRate'],
  };
}

/** Pozycja „przed” z kontekstu korekty w polach formularza („jest” startuje jako jej kopia). */
export function poleZPozycji(p: PozycjaRodzajuTelefonu): PozycjaFormularza {
  return {
    nazwa: p.name,
    ilosc: String(p.quantity).replace('.', ','),
    jednostka: p.unit,
    cena: String(p.unitPriceNet).replace('.', ','),
    stawka: p.vatRate,
  };
}

export type FormularzZaliczki = {
  dokument: DokumentFormularza;
  nabywca: NabywcaFormularza;
  mpp: boolean;
  /** Kwota zaliczki brutto z pola („1 230,00”). */
  kwota: string;
  /** Wartość zamówienia brutto z pola. */
  wartoscUmowy: string;
  stawka: '23' | '8' | '5' | '0';
  /** Planowana realizacja (RRRR-MM-DD) albo pusty tekst. */
  realizacja: string;
  /** Data otrzymania zaliczki, gdy inna niż wystawienia, albo pusty tekst. */
  otrzymana: string;
  opis: string;
};

export function doZaliczkiTelefonu(f: FormularzZaliczki): ZaliczkaTelefonu {
  return {
    ...dokument(f.dokument),
    splitPayment: f.mpp,
    buyer: nabywca(f.nabywca),
    advanceAmount: liczbaZPola(f.kwota),
    totalContractAmount: liczbaZPola(f.wartoscUmowy),
    expectedDeliveryDate: f.realizacja,
    advanceReceivedDate: f.otrzymana && f.otrzymana !== f.dokument.dataWystawienia ? f.otrzymana : '',
    vatRate: f.stawka,
    description: f.opis.trim(),
  };
}

export type FormularzRozliczenia = {
  dokument: DokumentFormularza;
  nabywca: NabywcaFormularza;
  mpp: boolean;
  /** Identyfikatory wybranych zaliczek (z `GET /faktury/zaliczki`). */
  zaliczki: string[];
  pozycje: PozycjaFormularza[];
};

export function doRozliczeniaTelefonu(f: FormularzRozliczenia): RozliczenieTelefonu {
  return {
    ...dokument(f.dokument),
    splitPayment: f.mpp,
    buyer: nabywca(f.nabywca),
    advanceInvoiceIds: f.zaliczki,
    lines: f.pozycje.map(pozycjaRodzaju),
  };
}

/** Typ korekty w formularzu telefonu: kwotowa (zwrot, rabat), danych (było, jest), anulowanie. */
export type TypKorektyTelefonu = 'kwotowa' | 'dane' | 'anulowanie';

const TYPY_KOREKTY: Record<TypKorektyTelefonu, KorektaTelefonu['correctionType']> = {
  kwotowa: 'amount_change',
  dane: 'before_after',
  anulowanie: 'cancellation',
};

export type FormularzKorekty = {
  dokument: DokumentFormularza;
  fakturaId: string;
  typ: TypKorektyTelefonu;
  przyczyna: string;
  typKsef: '1' | '2' | '3';
  /** Korekta danych: pozycje po korekcie. */
  pozycje: PozycjaFormularza[];
  /** Korekta kwotowa: zmiana netto, VAT i brutto wpisana przez klienta (jak na stronie) i opis pozycji. */
  zmiana: { netto: string; vat: string; brutto: string; opis: string };
};

export function doKorektyTelefonu(f: FormularzKorekty): KorektaTelefonu {
  const typ = TYPY_KOREKTY[f.typ];
  return {
    ...dokument(f.dokument),
    parentInvoiceId: f.fakturaId,
    correctionType: typ,
    correctionReason: f.przyczyna.trim(),
    typKorekty: f.typKsef,
    linesAfter: typ === 'before_after' ? f.pozycje.map(pozycjaRodzaju) : [],
    amountChange:
      typ === 'amount_change'
        ? { netDelta: liczbaZPola(f.zmiana.netto), vatDelta: liczbaZPola(f.zmiana.vat), grossDelta: liczbaZPola(f.zmiana.brutto), description: f.zmiana.opis.trim() }
        : null,
  };
}

/** Która część treści wyliczenia ma puste albo błędne pole liczbowe (do zdania „Kwoty policzymy po…”). */
export type BrakLiczb = 'zaliczka' | 'wartoscUmowy' | 'zmiana' | 'pozycje' | 'liczby';

const nieSkonczona = (n: number) => !Number.isFinite(n);
const pozycjeBezLiczb = (lista: PozycjaRodzajuTelefonu[]) => lista.some((p) => nieSkonczona(p.quantity) || nieSkonczona(p.unitPriceNet));

function maNieskonczona(wartosc: unknown): boolean {
  if (typeof wartosc === 'number') return nieSkonczona(wartosc);
  if (Array.isArray(wartosc)) return wartosc.some(maNieskonczona);
  if (wartosc && typeof wartosc === 'object') return Object.values(wartosc).some(maNieskonczona);
  return false;
}

/**
 * Pierwsza część treści z liczbą niebędącą skończoną (`liczbaZPola('')` albo
 * samo „-” w polu to `NaN`), `null` dla pełnej treści. Pola tekstowe i pusta
 * korekta danych (`amountChange: null`) nie są liczbami, więc brakiem nie są.
 * `'liczby'`: nieskończona liczba poza znanymi polami (np. nowe pole kontraktu),
 * żeby klucz i zdanie na ekranie zawsze mówiły to samo.
 */
export function brakLiczbWTresci(tresc: WyliczenieZadanie): BrakLiczb | null {
  if ('zaliczka' in tresc) {
    if (nieSkonczona(tresc.zaliczka.advanceAmount)) return 'zaliczka';
    if (nieSkonczona(tresc.zaliczka.totalContractAmount)) return 'wartoscUmowy';
  } else if ('rozliczenie' in tresc) {
    if (pozycjeBezLiczb(tresc.rozliczenie.lines)) return 'pozycje';
  } else {
    const zmiana = tresc.korekta.amountChange;
    if (zmiana && [zmiana.netDelta, zmiana.vatDelta, zmiana.grossDelta].some(nieSkonczona)) return 'zmiana';
    if (pozycjeBezLiczb(tresc.korekta.linesAfter)) return 'pozycje';
  }
  return maNieskonczona(tresc) ? 'liczby' : null;
}

/**
 * Czy gdziekolwiek w treści jest liczba niebędąca skończoną. W JSON `NaN` i
 * `Infinity` stają się `null`, a schemat trasy (`z.number()`) odpowiada na to
 * 400 `invalid_request`: serwer nie dostaje takiej treści (obchód U7).
 */
export function trescMaBrakLiczb(tresc: WyliczenieZadanie): boolean {
  return brakLiczbWTresci(tresc) !== null;
}

/**
 * Klucz (JSON) treści, którą wolno wysłać do `POST /faktury/wyliczenie`;
 * `null`, gdy nie ma treści albo któreś pole liczbowe jest puste lub błędne
 * (ekran mówi wtedy, czego brakuje, zamiast pytać serwer o niepełne dane).
 * Liczby skończone, ale nie do przyjęcia (zero, zaliczka większa od zamówienia),
 * idą do serwera: odpowiada zdaniem strony z polem (422 `invoice_invalid`).
 */
export function kluczWyliczenia(tresc: WyliczenieZadanie | null): string | null {
  return tresc && !trescMaBrakLiczb(tresc) ? JSON.stringify(tresc) : null;
}

const ZDANIA_BRAKU_LICZB: Record<BrakLiczb, string> = {
  zaliczka: 'Kwoty policzymy po wpisaniu kwoty zaliczki.',
  wartoscUmowy: 'Kwoty policzymy po wpisaniu wartości zamówienia.',
  zmiana: 'Kwoty policzymy, gdy wpiszesz zmianę netto, VAT i brutto.',
  pozycje: 'Kwoty policzymy po wpisaniu ilości i cen netto pozycji.',
  liczby: 'Kwoty policzymy po uzupełnieniu liczb w formularzu.',
};

/** Zdanie w „Podsumowaniu” dla klienta, gdy brakuje liczby (zamiast fałszywej awarii serwera). */
export function zdanieBrakuLiczb(brak: BrakLiczb): string {
  return ZDANIA_BRAKU_LICZB[brak];
}

/** Klucze błędów formularza telefonu dla zaliczki, rozliczenia i korekty. */
export type PoleBleduRodzaju =
  | 'numer'
  | 'nazwa'
  | 'nip'
  | 'adres'
  | 'pozycje'
  | 'rachunek'
  | 'termin'
  | 'zaliczka'
  | 'zaliczki'
  | 'zrodlo'
  | 'przyczyna'
  | 'zmiana'
  | 'ogolny';

/** Pole formularza strony z odpowiedzi `invoice_invalid` (`buyer.nip`, `advanceAmount`, `linesAfter.0.name`) na pole telefonu. */
export function poleRodzaju(pole: string | undefined): PoleBleduRodzaju {
  const [glowa, druga] = (pole ?? '').split('.');
  switch (glowa) {
    case 'internalNumber':
    case 'issueDate':
      return 'numer';
    case 'buyer':
      return druga === 'nip' ? 'nip' : druga === 'address' ? 'adres' : 'nazwa';
    case 'lines':
    case 'linesAfter':
    case 'linesBefore':
      return 'pozycje';
    case 'bankAccount':
    case 'splitPayment':
      return 'rachunek';
    case 'paymentDueDate':
      return 'termin';
    case 'advanceAmount':
    case 'totalContractAmount':
    case 'description':
    case 'vatRate':
    case 'expectedDeliveryDate':
    case 'advanceReceivedDate':
      return 'zaliczka';
    case 'advanceInvoiceIds':
      return 'zaliczki';
    case 'parentInvoiceId':
      return 'zrodlo';
    case 'correctionReason':
      return 'przyczyna';
    case 'amountChange':
      return 'zmiana';
    default:
      return 'ogolny';
  }
}

/**
 * Kraj adresu firmy z UE z prefiksu numeru VAT-UE (jak formularz strony:
 * Grecja ma w numerze `EL`, w adresie `GR`); `null`, gdy prefiks nie jest
 * krajem z listy (Polska też nie jest).
 */
export function krajZVatUe(numer: string): string | null {
  const prefiks = numer.replace(/[\s.-]/g, '').slice(0, 2).toUpperCase();
  const kod = prefiks === 'EL' ? 'GR' : prefiks;
  return KRAJE_UE_TELEFONU.some((k) => k.kod === kod) ? kod : null;
}
