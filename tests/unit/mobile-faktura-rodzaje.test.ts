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
import {
  korektaTelefonuSchema,
  rozliczenieDoFormularza,
  rozliczenieTelefonuSchema,
  zaliczkaDoFormularza,
  zaliczkaTelefonuSchema,
} from '@/lib/api/mobile/schematy-rodzaje';
import { invoiceFormSchema } from '@/lib/schemas/invoice-form';
import { advanceInvoiceSchema, finalInvoiceSchema } from '@/lib/validators/invoice-validators';

import {
  doKorektyTelefonu,
  doRozliczeniaTelefonu,
  doZaliczkiTelefonu,
  krajZVatUe,
  poleRodzaju,
  poleZPozycji,
  type DokumentFormularza,
} from '../../mobile/src/lib/faktura/rodzaje';
import { doFakturyTelefonu, type FormularzZwyklej } from '../../mobile/src/lib/faktura/wystawienie';

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
