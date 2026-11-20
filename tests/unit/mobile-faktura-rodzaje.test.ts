import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Plan aplikacji mobilnej, M8b: pola formularza telefonu na treść zaliczki,
 * rozliczenia i korekty (`mobile/src/lib/faktura/rodzaje.ts`) oraz zwykłej
 * faktury dla firmy z UE i osoby z PESEL (`wystawienie.ts`). Wynik sprawdza
 * prawdziwy schemat trasy (`lib/api/mobile/schematy*.ts`) i, po zamianie na
 * wartości formularza strony, schemat strony: to, co telefon wysyła, przejdzie
 * te same zasady co formularz na komputerze.
 */

import { doWartosciFormularza, fakturaTelefonuSchema } from '@/lib/api/mobile/schematy';
import type { WyliczenieZadanie } from '@/lib/api/mobile/kontrakt';
import {
  korektaTelefonuSchema,
  rozliczenieDoFormularza,
  rozliczenieTelefonuSchema,
  wyliczenieSchema,
  zaliczkaDoFormularza,
  zaliczkaTelefonuSchema,
} from '@/lib/api/mobile/schematy-rodzaje';
import { invoiceFormSchema } from '@/lib/schemas/invoice-form';
import { advanceInvoiceSchema, finalInvoiceSchema } from '@/lib/validators/invoice-validators';

import {
  brakLiczbWTresci,
  doKorektyTelefonu,
  doRozliczeniaTelefonu,
  doZaliczkiTelefonu,
  kluczWyliczenia,
  krajZVatUe,
  poleRodzaju,
  poleZPozycji,
  trescMaBrakLiczb,
  zdanieBrakuLiczb,
  type BrakLiczb,
  type DokumentFormularza,
} from '../../mobile/src/lib/faktura/rodzaje';
import { doFakturyTelefonu, liczbaZPola, type FormularzZwyklej } from '../../mobile/src/lib/faktura/wystawienie';

const DZIS = '2026-11-13';
const KLUCZ = '0c4e5f1a-7b2d-4c3e-9f10-111111111111';
const SPRZEDAWCA = { nip: '5260001246', name: 'Firma A', address: { addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa', countryCode: 'PL' } };
const dokument: DokumentFormularza = { numer: 'FZ/1/11/2026', dataWystawienia: DZIS, terminDni: 14, metoda: 'Przelew', rachunek: 'PL61 1090 1014 0000 0712 1981 2874', uwagi: '' };
const nabywca = { nip: '525-224-15-85', nazwa: 'Klient Sp. z o.o.', adres1: 'ul. Kliencka 3', adres2: '00-003 Warszawa', email: '' };

describe('zaliczka z formularza telefonu', () => {
  it('liczby z pól bez zaokrąglania, rachunek bez spacji i PL, termin od daty wystawienia', () => {
    const z = doZaliczkiTelefonu({ dokument, nabywca, mpp: false, kwota: '1 230,50', wartoscUmowy: '4920', stawka: '23', realizacja: '2026-12-13', otrzymana: DZIS, opis: ' Zaliczka na projekt ' });
    expect(z).toMatchObject({
      internalNumber: 'FZ/1/11/2026',
      paymentDueDate: '2026-11-27',
      bankAccount: '61109010140000071219812874',
      advanceAmount: 1230.5,
      totalContractAmount: 4920,
      // Otrzymana w dniu wystawienia: brak osobnej daty P_6.
      advanceReceivedDate: '',
      description: 'Zaliczka na projekt',
      buyer: { nip: '5252241585', name: 'Klient Sp. z o.o.', email: '' },
    });
    expect(zaliczkaTelefonuSchema.safeParse(z).success).toBe(true);
    const web = advanceInvoiceSchema.safeParse(zaliczkaDoFormularza(z, SPRZEDAWCA, KLUCZ));
    expect(web.success, JSON.stringify(web.error?.issues)).toBe(true);
  });

  it('gotówka: bez rachunku; inna data otrzymania zostaje', () => {
    const z = doZaliczkiTelefonu({ dokument: { ...dokument, metoda: 'Gotówka' }, nabywca, mpp: false, kwota: '100', wartoscUmowy: '100', stawka: '8', realizacja: '', otrzymana: '2026-11-20', opis: 'Zaliczka testowa' });
    expect(z).toMatchObject({ paymentMethod: 'cash', bankAccount: '', advanceReceivedDate: '2026-11-20' });
  });
});

describe('rozliczenie z formularza telefonu', () => {
  it('zaliczki po identyfikatorze, pozycje z pól; sumę zaliczek liczy serwer', () => {
    const r = doRozliczeniaTelefonu({
      dokument: { ...dokument, numer: 'FR/1/11/2026' },
      nabywca,
      mpp: false,
      zaliczki: ['11111111-2222-4333-8444-000000000002'],
      pozycje: [{ nazwa: 'Projekt', ilosc: '1,5', jednostka: 'h', cena: '33,3333', stawka: '23' }],
    });
    expect(r.lines).toEqual([{ name: 'Projekt', unit: 'h', quantity: 1.5, unitPriceNet: 33.3333, vatRate: '23' }]);
    expect(rozliczenieTelefonuSchema.safeParse(r).success).toBe(true);
    const values = rozliczenieDoFormularza(r, SPRZEDAWCA, KLUCZ);
    expect(values.totalAdvances).toBe(0);
    expect(finalInvoiceSchema.safeParse(values).success).toBe(true);
  });
});

describe('korekta z formularza telefonu', () => {
  const baza = { dokument: { ...dokument, numer: 'KOR/1/11/2026' }, fakturaId: '11111111-2222-4333-8444-000000000001', przyczyna: 'Rabat za opóźnienie', typKsef: '2' as const };
  const pozycje = [poleZPozycji({ name: 'Projekt', unit: 'szt', quantity: 2, unitPriceNet: 500.5, vatRate: '23' })];

  it('kwotowa: różnica wpisana przez klienta (ze znakiem), bez pozycji', () => {
    const k = doKorektyTelefonu({ ...baza, typ: 'kwotowa', pozycje, zmiana: { netto: '-100', vat: '-23', brutto: '-123,00', opis: 'Rabat' } });
    expect(k).toMatchObject({ correctionType: 'amount_change', linesAfter: [], amountChange: { netDelta: -100, vatDelta: -23, grossDelta: -123, description: 'Rabat' } });
    expect(korektaTelefonuSchema.safeParse(k).success).toBe(true);
  });

  it('danych: pozycje „jest” (kopia „było” z serwera bez utraty miejsc po przecinku); anulowanie bez pozycji', () => {
    const dane = doKorektyTelefonu({ ...baza, typ: 'dane', pozycje, zmiana: { netto: '', vat: '', brutto: '', opis: '' } });
    expect(dane).toMatchObject({ correctionType: 'before_after', amountChange: null, linesAfter: [{ quantity: 2, unitPriceNet: 500.5, vatRate: '23' }] });
    const anul = doKorektyTelefonu({ ...baza, typ: 'anulowanie', pozycje, zmiana: { netto: '', vat: '', brutto: '', opis: '' } });
    expect(anul).toMatchObject({ correctionType: 'cancellation', linesAfter: [], amountChange: null });
    expect(korektaTelefonuSchema.safeParse(anul).success).toBe(true);
  });
});

describe('zwykła faktura: firma z UE i osoba z PESEL (M8b)', () => {
  const formularz = (extra: Partial<FormularzZwyklej>): FormularzZwyklej => ({
    numer: 'FV/1/11/2026',
    dataWystawienia: DZIS,
    dataSprzedazy: DZIS,
    terminDni: 14,
    rodzajNabywcy: 'firma',
    nip: '',
    nazwa: 'Kunde GmbH',
    adres1: 'Hauptstr. 1',
    adres2: '10115 Berlin',
    email: '',
    metoda: 'Przelew',
    rachunek: 'PL61109010140000071219812874',
    mpp: false,
    pozycje: [{ nazwa: 'Usługa', ilosc: '1', jednostka: 'szt', cena: '1000', stawka: 'np_ii' }],
    uwagi: '',
    ...extra,
  });

  it('firma z UE: numer VAT-UE bez spacji, kraj, „np II”; przechodzi schemat strony', () => {
    const f = doFakturyTelefonu(formularz({ rodzajNabywcy: 'ue', vatUe: 'de 123 456 789', kraj: 'DE', nip: '5252241585' }));
    expect(f).toMatchObject({ buyerIsEu: true, buyerVatUe: 'DE123456789', buyerCountryCode: 'DE', buyerNip: '', buyerIsConsumer: false });
    expect(fakturaTelefonuSchema.safeParse(f).success).toBe(true);
    const web = invoiceFormSchema.safeParse(doWartosciFormularza(f));
    expect(web.success, JSON.stringify(web.error?.issues)).toBe(true);
  });

  it('osoba z PESEL i z dowodem; bez numeru jak w M8 (bez nowych pól)', () => {
    const zPeselem = doFakturyTelefonu(formularz({ rodzajNabywcy: 'osoba', nazwa: 'Jan Kowalski', idOsoby: 'pesel', pesel: '440514 01359', pozycje: [{ nazwa: 'Usługa', ilosc: '1', jednostka: 'szt', cena: '10', stawka: '23' }] }));
    expect(zPeselem).toMatchObject({ buyerIsConsumer: true, buyerConsumerIdType: 'pesel', buyerPesel: '44051401359', buyerIdDocument: '' });
    expect(invoiceFormSchema.safeParse(doWartosciFormularza(zPeselem)).success).toBe(true);

    const zDowodem = doFakturyTelefonu(formularz({ rodzajNabywcy: 'osoba', nazwa: 'Jan Kowalski', idOsoby: 'id_card', dokument: ' ABC123456 ' }));
    expect(zDowodem).toMatchObject({ buyerConsumerIdType: 'id_card', buyerIdDocument: 'ABC123456', buyerPesel: '' });

    const bezNumeru = doFakturyTelefonu(formularz({ rodzajNabywcy: 'osoba', nazwa: 'Jan Kowalski' }));
    expect(bezNumeru).not.toHaveProperty('buyerConsumerIdType');
    expect(bezNumeru).not.toHaveProperty('buyerIsEu');
  });
});

describe('pomocnicze', () => {
  it('kraj adresu z prefiksu VAT-UE (Grecja EL → GR), Polska i śmieci to brak', () => {
    expect(krajZVatUe('DE123456789')).toBe('DE');
    expect(krajZVatUe('el 123456789')).toBe('GR');
    expect(krajZVatUe('XI123456789')).toBe('XI');
    expect(krajZVatUe('PL5252241585')).toBeNull();
    expect(krajZVatUe('12')).toBeNull();
  });

  it('pole błędu serwera na pole formularza telefonu', () => {
    expect(poleRodzaju('buyer.nip')).toBe('nip');
    expect(poleRodzaju('buyer.address.addressLine1')).toBe('adres');
    expect(poleRodzaju('buyer.name')).toBe('nazwa');
    expect(poleRodzaju('advanceAmount')).toBe('zaliczka');
    expect(poleRodzaju('linesAfter.0.name')).toBe('pozycje');
    expect(poleRodzaju('amountChange')).toBe('zmiana');
    expect(poleRodzaju('correctionReason')).toBe('przyczyna');
    expect(poleRodzaju(undefined)).toBe('ogolny');
  });
});

/**
 * Obchód U7 (20.11.2026): w podglądzie kwot telefon co 450 ms wysyłał do
 * `POST /faktury/wyliczenie` treść z pustymi polami liczbowymi. `liczbaZPola('')`
 * daje `NaN`, w JSON zostaje `null`, a schemat trasy (`z.number()`) odpowiada 400
 * `invalid_request`, który ekran pokazywał jako awarię serwera. Telefon nie pyta
 * serwera o niepełne liczby (stan „czeka” z konkretnym zdaniem).
 */
describe('treść wyliczenia z niepełnych pól (U7)', () => {
  const dok = { ...dokument, numer: 'PODGLAD' };
  const pelnaZaliczka = { dokument: dok, nabywca, mpp: false, kwota: '1230', wartoscUmowy: '4920', stawka: '23' as const, realizacja: '2026-12-13', otrzymana: DZIS, opis: 'Podgląd kwot' };
  const pelneRozliczenie = {
    dokument: dok,
    nabywca,
    mpp: false,
    zaliczki: ['11111111-2222-4333-8444-000000000002'],
    pozycje: [{ nazwa: 'Projekt', ilosc: '1', jednostka: 'szt', cena: '100', stawka: '23' }],
  };
  const pelnaKorekta = {
    dokument: dok,
    fakturaId: '11111111-2222-4333-8444-000000000001',
    typ: 'kwotowa' as const,
    przyczyna: 'Podgląd kwot',
    typKsef: '2' as const,
    pozycje: [poleZPozycji({ name: 'Projekt', unit: 'szt', quantity: 2, unitPriceNet: 500.5, vatRate: '23' })],
    zmiana: { netto: '-100', vat: '-23', brutto: '-123', opis: 'Podgląd kwot' },
  };
  /** Treść tak, jak idzie do serwera: przez JSON (`useWyliczenie` wysyła `JSON.parse(JSON.stringify(...))`). */
  const poJson = (t: WyliczenieZadanie) => JSON.parse(JSON.stringify(t)) as unknown;

  const niepelne: { opis: string; tresc: WyliczenieZadanie; brak: BrakLiczb }[] = [
    { opis: 'korekta kwotowa: wpisane tylko „Zmiana netto”, VAT i brutto puste', tresc: { korekta: doKorektyTelefonu({ ...pelnaKorekta, zmiana: { netto: '-100', vat: '', brutto: '', opis: 'x' } }) }, brak: 'zmiana' },
    { opis: 'korekta kwotowa: samo „-” w polu (początek wpisywania zwrotu)', tresc: { korekta: doKorektyTelefonu({ ...pelnaKorekta, zmiana: { netto: '-', vat: '0', brutto: '-', opis: 'x' } }) }, brak: 'zmiana' },
    { opis: 'korekta danych: pusta cena „jest”', tresc: { korekta: doKorektyTelefonu({ ...pelnaKorekta, typ: 'dane', pozycje: [{ nazwa: 'P', ilosc: '1', jednostka: 'szt', cena: '', stawka: '23' }] }) }, brak: 'pozycje' },
    { opis: 'zaliczka: pusta kwota zaliczki', tresc: { zaliczka: doZaliczkiTelefonu({ ...pelnaZaliczka, kwota: '' }) }, brak: 'zaliczka' },
    { opis: 'zaliczka: wpisana kwota, błędna wartość zamówienia', tresc: { zaliczka: doZaliczkiTelefonu({ ...pelnaZaliczka, wartoscUmowy: 'abc' }) }, brak: 'wartoscUmowy' },
    { opis: 'rozliczenie: pusta cena pozycji', tresc: { rozliczenie: doRozliczeniaTelefonu({ ...pelneRozliczenie, pozycje: [{ nazwa: 'P', ilosc: '1', jednostka: 'szt', cena: '', stawka: '23' }] }) }, brak: 'pozycje' },
    { opis: 'rozliczenie: pusta ilość drugiej pozycji', tresc: { rozliczenie: doRozliczeniaTelefonu({ ...pelneRozliczenie, pozycje: [...pelneRozliczenie.pozycje, { nazwa: 'Q', ilosc: '', jednostka: 'szt', cena: '5', stawka: '23' }] }) }, brak: 'pozycje' },
  ];

  it.each(niepelne)('$opis: serwer odrzuci treść (przyczyna), a telefon jej nie wysyła', ({ tresc, brak }) => {
    // Przyczyna: liczba niebędąca skończoną zamienia się w JSON w null, a schemat trasy wymaga liczby.
    const wynik = wyliczenieSchema.safeParse(poJson(tresc));
    expect(wynik.success).toBe(false);
    // Naprawa: telefon wykrywa to przed wysłaniem i nie buduje treści do serwera.
    expect(trescMaBrakLiczb(tresc)).toBe(true);
    expect(brakLiczbWTresci(tresc)).toBe(brak);
    expect(kluczWyliczenia(tresc)).toBeNull();
  });

  const pelne: { opis: string; tresc: WyliczenieZadanie }[] = [
    { opis: 'zaliczka', tresc: { zaliczka: doZaliczkiTelefonu(pelnaZaliczka) } },
    { opis: 'rozliczenie', tresc: { rozliczenie: doRozliczeniaTelefonu(pelneRozliczenie) } },
    { opis: 'korekta kwotowa (ujemne i zero to liczby)', tresc: { korekta: doKorektyTelefonu({ ...pelnaKorekta, zmiana: { netto: '-100', vat: '0', brutto: '-100', opis: 'x' } }) } },
    { opis: 'korekta danych (amountChange: null to nie brak liczby)', tresc: { korekta: doKorektyTelefonu({ ...pelnaKorekta, typ: 'dane' }) } },
    { opis: 'anulowanie (bez pozycji i kwot)', tresc: { korekta: doKorektyTelefonu({ ...pelnaKorekta, typ: 'anulowanie' }) } },
  ];

  it.each(pelne)('pełna treść ($opis) przechodzi schemat trasy i idzie do serwera bez zmian', ({ tresc }) => {
    expect(wyliczenieSchema.safeParse(poJson(tresc)).success).toBe(true);
    expect(trescMaBrakLiczb(tresc)).toBe(false);
    expect(brakLiczbWTresci(tresc)).toBeNull();
    expect(kluczWyliczenia(tresc)).toBe(JSON.stringify(tresc));
  });

  it('brak treści (np. nie wybrano faktury pierwotnej) to brak klucza', () => {
    expect(kluczWyliczenia(null)).toBeNull();
  });

  it('nieskończoność też jest brakiem liczby (w JSON staje się null jak NaN)', () => {
    const tresc: WyliczenieZadanie = { zaliczka: { ...doZaliczkiTelefonu(pelnaZaliczka), advanceAmount: Infinity } };
    expect(wyliczenieSchema.safeParse(poJson(tresc)).success).toBe(false);
    expect(trescMaBrakLiczb(tresc)).toBe(true);
    expect(kluczWyliczenia(tresc)).toBeNull();
  });

  it('jedno źródło prawdy: gdy liczby brakuje poza znanymi polami, klucz też jest pusty i zdanie jest ogólne', () => {
    const zNowymPolem = { zaliczka: { ...doZaliczkiTelefonu(pelnaZaliczka), nowePoleLiczbowe: NaN } } as unknown as WyliczenieZadanie;
    expect(trescMaBrakLiczb(zNowymPolem)).toBe(true);
    expect(brakLiczbWTresci(zNowymPolem)).toBe('liczby');
    expect(kluczWyliczenia(zNowymPolem)).toBeNull();
    for (const { tresc } of [...niepelne, ...pelne]) expect(trescMaBrakLiczb(tresc)).toBe(brakLiczbWTresci(tresc) !== null);
  });

  it('pole z liczbą: puste, samo „-” i zapis spoza zakresu to NaN (nie Infinity, które w JSON też staje się null)', () => {
    expect(liczbaZPola('')).toBeNaN();
    expect(liczbaZPola('-')).toBeNaN();
    expect(liczbaZPola('1e999')).toBeNaN();
    expect(liczbaZPola('-1e999')).toBeNaN();
    expect(liczbaZPola('1 500,5')).toBe(1500.5);
    expect(liczbaZPola('-100')).toBe(-100);
    expect(liczbaZPola('0')).toBe(0);
  });

  it('zdania dla klienta: konkretne pole, nazwa produktu bez „serwera”, bez długich myślników', () => {
    expect(zdanieBrakuLiczb('zmiana')).toBe('Kwoty policzymy, gdy wpiszesz zmianę netto, VAT i brutto.');
    expect(zdanieBrakuLiczb('zaliczka')).toBe('Kwoty policzymy po wpisaniu kwoty zaliczki.');
    expect(zdanieBrakuLiczb('wartoscUmowy')).toBe('Kwoty policzymy po wpisaniu wartości zamówienia.');
    expect(zdanieBrakuLiczb('pozycje')).toBe('Kwoty policzymy po wpisaniu ilości i cen netto pozycji.');
    expect(zdanieBrakuLiczb('liczby')).toBe('Kwoty policzymy po uzupełnieniu liczb w formularzu.');
    for (const brak of ['zmiana', 'zaliczka', 'wartoscUmowy', 'pozycje', 'liczby'] as const) {
      expect(zdanieBrakuLiczb(brak)).not.toMatch(/[—–]|serwer|FaktWay/i);
    }
  });

  // Hook i ekran importują React Native, więc nie da się ich uruchomić w Vitest; pilnujemy podłączenia w źródle:
  // cofnięcie `kluczWyliczenia` do `JSON.stringify(tresc)` albo zdania w „Podsumowaniu” przywraca błąd U7.
  it('podłączenie: hook liczy klucz przez kluczWyliczenia, a ekran mówi zdaniem zdanieBrakuLiczb', () => {
    const korzen = join(__dirname, '..', '..', 'mobile', 'src');
    const hook = readFileSync(join(korzen, 'stan', 'faktury-rodzaje.tsx'), 'utf8');
    expect(hook).toContain('const klucz = kluczWyliczenia(tresc);');
    expect(hook).not.toMatch(/JSON\.stringify\(tresc\)/);
    const ekran = readFileSync(join(korzen, 'app', '(zakladki)', 'faktury', 'nowa', '[rodzaj].tsx'), 'utf8');
    expect(ekran).toContain('zdanieBrakuLiczb(brakLiczb)');
  });
});
