import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildInvoiceFromForm } from '@/lib/invoices/build-from-form';
import { KODY_KRAJOW } from '@/lib/invoices/kody-krajow';
import { parseVatUeInput } from '@/lib/invoices/vat-ue';
import { invoiceFormSchema, type InvoiceFormValues } from '@/lib/schemas/invoice-form';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { validateInvoice } from '@/lib/xml/invoice-calculator';
import { validateFA3 } from '@/lib/xml/validator';

/**
 * Plan zero zgubionych faktur, karta C2: S7 (kraj nabywcy z dokumentem
 * tożsamości z formularza, nie `PL` na sztywno) i S8 (numer VAT-UE według
 * wzorca kraju). Jedna pozycja planu = jeden blok; XSD i złoty plik w S7.
 */

const NOW = new Date('2026-11-27T10:00:00Z');
const TENANT = {
  id: 'ten-1',
  nip: '5260001246',
  name: 'Moja Firma',
  address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' },
};

function paszport(o: Partial<InvoiceFormValues> = {}): InvoiceFormValues {
  return {
    internalNumber: 'FV/1/11/2026',
    issueDate: '2026-11-27',
    saleDate: '',
    buyerNip: '',
    buyerName: 'Hans Meier',
    buyerAddressLine1: 'Hauptstraße 1',
    buyerAddressLine2: '10115 Berlin',
    buyerEmail: '',
    buyerIsConsumer: true,
    buyerConsumerIdType: 'passport',
    buyerPesel: '',
    buyerIdDocument: 'C01X00T47',
    paymentMethod: 'transfer',
    paymentDueDate: '2026-12-11',
    bankAccount: 'PL61109010140000071219812874',
    notes: '',
    splitPayment: false,
    lines: [{ name: 'Usługa', unit: 'szt', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
    ...o,
  } as InvoiceFormValues;
}

function bledy(v: unknown): string[] {
  const r = invoiceFormSchema.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

async function plik(v: InvoiceFormValues) {
  const invoice = buildInvoiceFromForm(invoiceFormSchema.parse(v), TENANT, null, false);
  expect(validateInvoice(invoice, NOW)).toEqual([]);
  const xml = generateFA3Xml(invoice, { generatedAt: NOW });
  expect((await validateFA3(xml)).errors.map((b) => b.message)).toEqual([]);
  return { invoice, xml };
}

const podmiot2 = (xml: string) => /<Podmiot2>[\s\S]*?<\/Podmiot2>/.exec(xml)![0];

describe('C2 S7: kraj nabywcy z paszportem i dowodem pochodzi z formularza', () => {
  it('lista kodów zgadza się z TKodKraju z XSD FA(3)', () => {
    const xsd = readFileSync('lib/xml/schemas/fa3/KodyKrajow_v10-0E.xsd', 'utf8');
    const start = xsd.indexOf('name="TKodKraju"');
    const end = xsd.indexOf('</xsd:simpleType>', start);
    const zXsd = [...xsd.slice(start, end).matchAll(/enumeration value="([A-Z]{2})"/g)].map((m) => m[1]);
    expect([...KODY_KRAJOW].sort()).toEqual(zXsd.sort());
  });

  it('paszport z Niemiec: KodKraju DE w identyfikatorze i w adresie, plik przechodzi XSD', async () => {
    const v = paszport({ buyerCountryCode: 'DE' });
    expect(bledy(v)).toEqual([]);
    const { invoice, xml } = await plik(v);
    expect(invoice.buyer.address.countryCode).toBe('DE');
    const p2 = podmiot2(xml);
    expect(p2).toContain('<DaneIdentyfikacyjne><KodKraju>DE</KodKraju><NrID>C01X00T47</NrID>');
    expect(p2).toContain('<Adres><KodKraju>DE</KodKraju>');
    expect(p2).not.toContain('<KodKraju>PL</KodKraju>');
  });

  it('dowód osobisty z Ukrainy (kraj spoza UE) też bierze kraj z formularza', async () => {
    const { xml } = await plik(paszport({ buyerConsumerIdType: 'id_card', buyerCountryCode: 'UA' }));
    expect(podmiot2(xml)).toContain('<KodKraju>UA</KodKraju><NrID>C01X00T47</NrID>');
  });

  it('bez wybranego kraju zostaje Polska (dotychczasowe zachowanie, aplikacja mobilna)', async () => {
    const { xml } = await plik(paszport());
    expect(podmiot2(xml)).toContain('<KodKraju>PL</KodKraju><NrID>C01X00T47</NrID>');
  });

  it('kraj spoza listy XSD jest odrzucony przed zapisem, z nazwą pola', () => {
    expect(bledy(paszport({ buyerCountryCode: 'ZZ' }))).toEqual([
      'buyerCountryCode: Wybierz kraj nabywcy z listy',
    ]);
    expect(bledy(paszport({ buyerCountryCode: 'de' }))).toHaveLength(1);
  });

  it('PESEL i brak numeru nie biorą kraju z formularza (zawsze PL)', async () => {
    const { invoice } = await plik(
      paszport({ buyerConsumerIdType: 'pesel', buyerPesel: '44051401359', buyerIdDocument: '', buyerCountryCode: 'DE' }),
    );
    expect(invoice.buyer.address.countryCode).toBe('PL');
  });
});

describe('C2 S8: numer VAT-UE według wzorca kraju', () => {
  it.each([
    ['AT U12345678', 'ATU12345678'],
    ['DE 123 456 789', 'DE123456789'],
    ['EL123456789', 'EL123456789'],
    ['FR12345678901', 'FR12345678901'],
    ['FRXX123456789', 'FRXX123456789'],
    ['NL123456789B01', 'NL123456789B01'],
    ['IE1234567WA', 'IE1234567WA'],
    ['IE1A23456B', 'IE1A23456B'],
    ['ES A1234567B', 'ESA1234567B'],
    ['CZ12345678', 'CZ12345678'],
    ['CY12345678X', 'CY12345678X'],
    ['SE123456789012', 'SE123456789012'],
    ['BE0123456789', 'BE0123456789'],
    ['LT123456789012', 'LT123456789012'],
  ])('przyjmuje %s', (raw, normalized) => {
    expect(parseVatUeInput(raw)?.normalized).toBe(normalized);
  });

  it.each([
    ['AT bez litery U', 'AT123456789'],
    ['AT z U, ale za krótki', 'ATU1234567'],
    ['podwójny prefiks DE', 'DEDE123456789'],
    ['podwójny prefiks z AT', 'ATATU12345678'],
    ['DE za krótki', 'DE12345678'],
    ['DE z literą', 'DE12345678A'],
    ['NL bez B', 'NL123456789001'],
    ['BE zaczyna się od 2', 'BE2123456789'],
    ['FR za krótki', 'FR1234567'],
    ['prefiks GR zamiast EL', 'GR123456789'],
    ['SE za krótki', 'SE12345678901'],
  ])('odrzuca %s', (_opis, raw) => {
    expect(parseVatUeInput(raw)).toBeNull();
  });

  it('formularz odrzuca numer o złym wzorcu kraju i pokazuje wzór', () => {
    const v = paszport({
      buyerIsConsumer: false,
      buyerConsumerIdType: undefined,
      buyerIdDocument: '',
      buyerIsEu: true,
      buyerVatUe: 'DEDE123456789',
      buyerCountryCode: 'DE',
    });
    const e = bledy(v).filter((x) => x.startsWith('buyerVatUe'));
    expect(e).toHaveLength(1);
    expect(e[0]).toMatch(/DE123456789/);
    // Komunikat wspomina wzorce krajów z wyjątkami: Austria z U, Holandia z B.
    expect(e[0]).toMatch(/ATU/);
    expect(e[0]).toMatch(/B01/);
  });
});
