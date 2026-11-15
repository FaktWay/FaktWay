import { describe, expect, it } from 'vitest';

import { buildInvoiceFromForm } from '@/lib/invoices/build-from-form';
import { invoiceFormSchema, lineItemSchema, type InvoiceFormValues } from '@/lib/schemas/invoice-form';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { validateInvoiceXml } from '@/lib/xml/validator';

/**
 * Plan kompletnej aplikacji, krok 2.6, część 2b-1: PKWiU w pozycji zwykłej
 * faktury z jawnym typem kodu (nie zgadywanym po długości). Kod idzie
 * z formularza (albo katalogu) przez schemat (klient i serwer) do faktury
 * (`fa3_data`) i do pliku FA(3): `PKWiU` po nazwie (P_7), przed jednostką
 * (P_8A), jak w typie FaWiersz schematu. GTU pozycji (część 2b-2):
 * `tests/unit/pozycje-gtu.test.ts`.
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

/** Faktura z formularza tak, jak robi to akcja zapisu: schemat, potem budowanie. */
function fakturaZFormularza(lines: InvoiceFormValues['lines']) {
  const parsed = invoiceFormSchema.safeParse(form(lines));
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join('; '));
  return buildInvoiceFromForm(parsed.data, TENANT, null, false);
}

describe('schemat pozycji: PKWiU', () => {
  it('PKWiU z kropkami i bez przechodzi; puste pole i brak pola to brak kodu', () => {
    for (const pkwiuCode of ['85.59.13.0', '85591300', ' 62.01.11.0 ', '', '   ']) {
      expect(bledy(lineItemSchema.safeParse({ ...pozycja, pkwiuCode }))).toEqual([]);
    }
    expect(bledy(lineItemSchema.safeParse(pozycja))).toEqual([]);
  });

  it('PKWiU z literami albo dłuższe niż 20 znaków: błąd z tym, co zrobić', () => {
    expect(bledy(lineItemSchema.safeParse({ ...pozycja, pkwiuCode: '85.59.A' }))).toEqual([
      'pkwiuCode: PKWiU: tylko cyfry i kropki, na przykład 62.01.11.0.',
    ]);
    expect(bledy(lineItemSchema.safeParse({ ...pozycja, pkwiuCode: '.85.59' }))).toEqual([
      'pkwiuCode: PKWiU: tylko cyfry i kropki, na przykład 62.01.11.0.',
    ]);
    expect(bledy(lineItemSchema.safeParse({ ...pozycja, pkwiuCode: '1'.repeat(21) }))).toEqual([
      'pkwiuCode: PKWiU: najwyżej 20 znaków.',
    ]);
  });
});

describe('faktura z formularza: PKWiU w pozycjach', () => {
  it('kod przechodzi przez schemat formularza i trafia do pozycji faktury bez spacji; puste i same spacje nie', () => {
    const invoice = fakturaZFormularza([
      { ...pozycja, pkwiuCode: ' 85.59.13.0 ' },
      { ...pozycja, name: 'Materiały', pkwiuCode: '' },
      { ...pozycja, name: 'Dojazd', pkwiuCode: '   ' },
    ]);
    expect(invoice.lines[0]).toMatchObject({ pkwiuCode: '85.59.13.0' });
    expect(invoice.lines[1]).not.toHaveProperty('pkwiuCode');
    expect(invoice.lines[2]).not.toHaveProperty('pkwiuCode');
  });
});

describe('plik FA(3): PKWiU w FaWiersz', () => {
  const xmlZ = (lines: InvoiceFormValues['lines']) =>
    generateFA3Xml(fakturaZFormularza(lines), { generatedAt: new Date(`${DZIS}T10:00:00Z`) });

  it('PKWiU po P_7, przed P_8A; plik zgodny z XSD', async () => {
    const xml = xmlZ([{ ...pozycja, pkwiuCode: '85.59.13.0' }]);
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
    const wiersz = xml.slice(xml.indexOf('<FaWiersz>'), xml.indexOf('</FaWiersz>'));
    expect(wiersz).toContain('<PKWiU>85.59.13.0</PKWiU>');
    expect(wiersz.indexOf('<P_7>')).toBeLessThan(wiersz.indexOf('<PKWiU>'));
    expect(wiersz.indexOf('<PKWiU>')).toBeLessThan(wiersz.indexOf('<P_8A>'));
  });

  it('PKWiU bez kropek zostaje PKWiU (nie CN ani GTIN, jak przy zgadywaniu po długości)', async () => {
    const xml = xmlZ([{ ...pozycja, pkwiuCode: '85591300' }]);
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
    expect(xml).toContain('<PKWiU>85591300</PKWiU>');
    expect(xml).not.toContain('<GTIN>');
    expect(xml).not.toContain('<CN>');
  });

  it('pozycja bez kodu: bez PKWiU, jak dotąd', async () => {
    const xml = xmlZ([pozycja]);
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
    expect(xml).not.toContain('<PKWiU>');
  });
});
