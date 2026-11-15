import { describe, expect, it } from 'vitest';

import { buildInvoiceFromForm } from '@/lib/invoices/build-from-form';
import { GTU_CODES } from '@/lib/invoices/line-codes';
import { invoiceFormSchema, lineItemSchema, type InvoiceFormValues } from '@/lib/schemas/invoice-form';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { validateInvoiceXml } from '@/lib/xml/validator';

/**
 * Plan kompletnej aplikacji, krok 2.6, część 2b-2: oznaczenie GTU w pozycji
 * zwykłej faktury. Kod (GTU_01 do GTU_13, typ `TGTU` schematu FA(3)) idzie
 * z formularza albo katalogu przez schemat (klient i serwer) do faktury
 * (`fa3_data`) i do pliku FA(3): `GTU` po stawce (`P_12`), jak w typie
 * FaWiersz schematu. To samo oznaczenie trafia do wiersza faktury w JPK_V7M
 * (`tests/unit/jpk-v7m-gtu.test.ts`). Który kod się należy, wybiera klient
 * (D8 planu księgowości); FaktWay sprawdza tylko, że kod jest z listy.
 */

const DZIS = '2026-11-14';
const TENANT = {
  id: 'ten-1',
  nip: '5260001246',
  name: 'Moja Firma',
  address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' },
};

const form = (lines: InvoiceFormValues['lines']): InvoiceFormValues => ({
  internalNumber: 'FV/8/11/2026',
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

const pozycja = { name: 'Doradztwo podatkowe', unit: 'godz.', quantity: 2, unitPriceNet: 150, vatRate: '23' as const };
type Pozycja = InvoiceFormValues['lines'][number];

const bledy = (wynik: ReturnType<typeof lineItemSchema.safeParse>) =>
  wynik.success ? [] : wynik.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);

/** Faktura z formularza tak, jak robi to akcja zapisu: schemat, potem budowanie. */
function fakturaZFormularza(lines: InvoiceFormValues['lines']) {
  const parsed = invoiceFormSchema.safeParse(form(lines));
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join('; '));
  return buildInvoiceFromForm(parsed.data, TENANT, null, false);
}

const xmlZ = (lines: InvoiceFormValues['lines']) =>
  generateFA3Xml(fakturaZFormularza(lines), { generatedAt: new Date(`${DZIS}T10:00:00Z`) });
const wierszeFa = (xml: string) => [...xml.matchAll(/<FaWiersz>([\s\S]*?)<\/FaWiersz>/g)].map((m) => m[1]!);

describe('schemat pozycji: GTU', () => {
  it('każdy kod GTU_01 do GTU_13, puste pole i brak pola przechodzą', () => {
    for (const gtuCode of [...GTU_CODES, '']) {
      expect(bledy(lineItemSchema.safeParse({ ...pozycja, gtuCode }))).toEqual([]);
    }
    expect(bledy(lineItemSchema.safeParse(pozycja))).toEqual([]);
    expect(GTU_CODES).toHaveLength(13);
  });

  it('kod spoza listy (także małymi literami albo ze spacją): błąd z tym, co zrobić', () => {
    for (const gtuCode of ['GTU_14', 'GTU_00', 'gtu_12', 'GTU_1', ' GTU_12', 'GTU 12']) {
      expect(bledy(lineItemSchema.safeParse({ ...pozycja, gtuCode }))).toEqual([
        'gtuCode: Wybierz kod GTU z listy albo zostaw pole puste.',
      ]);
    }
  });
});

describe('faktura z formularza: GTU w pozycjach', () => {
  it('kod przechodzi przez schemat formularza i trafia do pozycji faktury; puste pole to brak oznaczenia', () => {
    const invoice = fakturaZFormularza([
      { ...pozycja, gtuCode: 'GTU_12' },
      { ...pozycja, name: 'Materiały', gtuCode: '' },
      { ...pozycja, name: 'Dojazd' },
    ]);
    expect(invoice.lines[0]).toMatchObject({ gtuCode: 'GTU_12' });
    expect(invoice.lines[1]).not.toHaveProperty('gtuCode');
    expect(invoice.lines[2]).not.toHaveProperty('gtuCode');
  });

  it('niesparsowane wartości (akcje przekazują je dalej): kod z listy trafia do pozycji, kod spoza listy nie', () => {
    const zSurowych = buildInvoiceFromForm(
      form([
        { ...pozycja, gtuCode: 'GTU_06' },
        { ...pozycja, name: 'Spreparowane', gtuCode: '<GTU_99>' } as unknown as Pozycja,
      ]),
      TENANT,
      null,
      false,
    );
    expect(zSurowych.lines[0]).toMatchObject({ gtuCode: 'GTU_06' });
    expect(zSurowych.lines[1]).not.toHaveProperty('gtuCode');
    const xml = generateFA3Xml(zSurowych, { generatedAt: new Date(`${DZIS}T10:00:00Z`) });
    expect(xml.match(/<GTU>/g)).toHaveLength(1);
    expect(xml).not.toContain('GTU_99');
  });
});

describe('plik FA(3): GTU w FaWiersz', () => {
  it('GTU po P_12 tej pozycji, z PKWiU w tej samej pozycji; plik zgodny z XSD', async () => {
    const xml = xmlZ([
      { ...pozycja, pkwiuCode: '69.20.2', gtuCode: 'GTU_12' },
      { ...pozycja, name: 'Telefon', vatRate: '8', gtuCode: 'GTU_06' },
      { ...pozycja, name: 'Dojazd' },
    ]);
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
    const [pierwsza, druga, trzecia] = wierszeFa(xml);
    expect(pierwsza).toMatch(/<P_12>23<\/P_12>\s*<GTU>GTU_12<\/GTU>\s*$/);
    expect(pierwsza).toContain('<PKWiU>69.20.2</PKWiU>');
    expect(druga).toMatch(/<P_12>8<\/P_12>\s*<GTU>GTU_06<\/GTU>\s*$/);
    expect(trzecia).not.toContain('<GTU>');
  });

  it('każdy kod z listy przechodzi XSD FA(3) (typ TGTU)', async () => {
    const xml = xmlZ(GTU_CODES.map((gtuCode, i) => ({ ...pozycja, name: `Pozycja ${i + 1}`, gtuCode })));
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
    expect([...xml.matchAll(/<GTU>([^<]+)<\/GTU>/g)].map((m) => m[1])).toEqual([...GTU_CODES]);
  });

  it('pozycja bez GTU: bez elementu GTU, jak dotąd', async () => {
    const xml = xmlZ([pozycja]);
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
    expect(xml).not.toContain('<GTU>');
  });
});
