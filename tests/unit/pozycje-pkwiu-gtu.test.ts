import { describe, expect, it } from 'vitest';

import { buildInvoiceFromForm } from '@/lib/invoices/build-from-form';
import { GTU_CODES } from '@/lib/invoices/line-codes';
import { invoiceFormSchema, lineItemSchema, type InvoiceFormValues } from '@/lib/schemas/invoice-form';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { validateInvoiceXml } from '@/lib/xml/validator';

/**
 * Plan kompletnej aplikacji, krok 2.6, część 2b-1: PKWiU i GTU w pozycji
 * zwykłej faktury. Kod ma jawny typ (pole PKWiU, pole GTU), nie jest
 * zgadywany po długości. Kody idą z formularza (albo katalogu) przez schemat
 * (klient i serwer) do faktury (`fa3_data`) i do pliku FA(3): `PKWiU` po
 * nazwie (P_7), `GTU` po stawce (P_12), jak w typie FaWiersz schematu.
 */

const DZIS = '2026-11-14';
const TENANT = {
  id: 'ten-1',
  nip: '5260001246',
  name: 'Moja Firma',
  address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' },
};

const form = (lines: InvoiceFormValues['lines']): InvoiceFormValues => ({
  internalNumber: 'FV/7/11/2026',
  issueDate: DZIS,
  saleDate: '',
  buyerNip: '5252241585',
  buyerName: 'Klient Sp. z o.o.',
  buyerAddressLine1: 'ul. B 2',
  buyerAddressLine2: '00-002 Warszawa',
  buyerEmail: 'klient@example.test',
  buyerIsConsumer: false,
  buyerPesel: '',
  buyerIdDocument: '',
  paymentMethod: 'transfer',
  paymentDueDate: '2026-11-27',
  bankAccount: 'PL61109010140000071219812874',
  notes: '',
  splitPayment: false,
  lines,
});

const pozycja = { name: 'Szkolenie BHP', unit: 'godz.', quantity: 2, unitPriceNet: 150, vatRate: '23' as const };

const bledy = (wynik: ReturnType<typeof lineItemSchema.safeParse>) =>
  wynik.success ? [] : wynik.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);

describe('schemat pozycji: PKWiU i GTU', () => {
  it('PKWiU z kropkami i każdy kod GTU z listy przechodzą; puste pola to brak kodu', () => {
    for (const gtuCode of GTU_CODES) {
      expect(bledy(lineItemSchema.safeParse({ ...pozycja, pkwiuCode: '85.59.13.0', gtuCode }))).toEqual([]);
    }
    expect(bledy(lineItemSchema.safeParse({ ...pozycja, pkwiuCode: '', gtuCode: '' }))).toEqual([]);
    expect(bledy(lineItemSchema.safeParse(pozycja))).toEqual([]);
  });

  it('PKWiU z literami albo dłuższe niż 20 znaków i GTU spoza listy: błąd z tym, co zrobić', () => {
    expect(bledy(lineItemSchema.safeParse({ ...pozycja, pkwiuCode: '85.59.A' }))).toEqual([
      'pkwiuCode: PKWiU: tylko cyfry i kropki, na przykład 62.01.11.0.',
    ]);
    expect(bledy(lineItemSchema.safeParse({ ...pozycja, pkwiuCode: '1'.repeat(21) }))).toEqual([
      'pkwiuCode: PKWiU: najwyżej 20 znaków.',
    ]);
    expect(bledy(lineItemSchema.safeParse({ ...pozycja, gtuCode: 'GTU_14' }))).toEqual([
      'gtuCode: Wybierz kod GTU z listy albo zostaw pole puste.',
    ]);
  });
});

describe('faktura z formularza: kody w pozycjach', () => {
  it('kody przechodzą przez schemat formularza i trafiają do pozycji faktury bez spacji; puste nie', () => {
    const parsed = invoiceFormSchema.safeParse(form([
      { ...pozycja, pkwiuCode: ' 85.59.13.0 ', gtuCode: 'GTU_12' },
      { ...pozycja, name: 'Materiały', pkwiuCode: '', gtuCode: '' },
    ]));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const invoice = buildInvoiceFromForm(parsed.data, TENANT, null, false);
    expect(invoice.lines[0]).toMatchObject({ pkwiuCode: '85.59.13.0', gtuCode: 'GTU_12' });
    expect(invoice.lines[1]).not.toHaveProperty('pkwiuCode');
    expect(invoice.lines[1]).not.toHaveProperty('gtuCode');
  });
});

describe('plik FA(3): PKWiU i GTU w FaWiersz', () => {
  const xmlZ = (lines: InvoiceFormValues['lines']) =>
    generateFA3Xml(buildInvoiceFromForm(form(lines), TENANT, null, false), { generatedAt: new Date(`${DZIS}T10:00:00Z`) });

  it('PKWiU po P_7, GTU po P_12, plik zgodny z XSD', async () => {
    const xml = xmlZ([{ ...pozycja, pkwiuCode: '85.59.13.0', gtuCode: 'GTU_12' }]);
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
    const wiersz = xml.slice(xml.indexOf('<FaWiersz>'), xml.indexOf('</FaWiersz>'));
    expect(wiersz).toContain('<PKWiU>85.59.13.0</PKWiU>');
    expect(wiersz).toContain('<GTU>GTU_12</GTU>');
    expect(wiersz.indexOf('<P_7>')).toBeLessThan(wiersz.indexOf('<PKWiU>'));
    expect(wiersz.indexOf('<PKWiU>')).toBeLessThan(wiersz.indexOf('<P_8A>'));
    expect(wiersz.indexOf('<P_12>')).toBeLessThan(wiersz.indexOf('<GTU>'));
  });

  it('PKWiU bez kropek zostaje PKWiU (nie CN ani GTIN, jak przy zgadywaniu po długości)', async () => {
    const xml = xmlZ([{ ...pozycja, pkwiuCode: '85591300' }]);
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
    expect(xml).toContain('<PKWiU>85591300</PKWiU>');
    expect(xml).not.toContain('<GTIN>');
    expect(xml).not.toContain('<CN>');
  });

  it('pozycja bez kodów: bez PKWiU i GTU, jak dotąd', async () => {
    const xml = xmlZ([pozycja]);
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
    expect(xml).not.toContain('<PKWiU>');
    expect(xml).not.toContain('<GTU>');
  });
});
