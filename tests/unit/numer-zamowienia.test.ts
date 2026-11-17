import PDFDocument from 'pdfkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan kompletnej aplikacji, krok 2.8: numer zamówienia na zwykłej fakturze.
 * XSD FA(3): `Fa/WarunkiTransakcji/Zamowienia` (0..100) z `DataZamowienia`
 * (TDataU, opcjonalna) i `NrZamowienia` (TZnakowy, opcjonalny); w `Fa` po
 * `Platnosc`, przed `Zamowienie` (zamówienie faktury zaliczkowej, inny
 * element). Jeden numer na fakturę (z opcjonalną datą), nie lista.
 *
 * Prawdziwa ścieżka: schemat formularza (klient i serwer), budowanie faktury,
 * plik FA(3) z walidacją XSD, odczyt danych PDF i renderer. Bez numeru plik
 * i PDF są takie jak dotąd (złoty plik `fa3-zwykla.xml` pilnuje
 * `tests/filtr/zlote-pliki/fa3.test.ts`).
 */

const mocks = vi.hoisted(() => ({ row: null as Record<string, unknown> | null, select: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: (cols: string) => {
        mocks.select(cols);
        const query = { eq: () => query, maybeSingle: async () => ({ data: mocks.row, error: null }) };
        return query;
      },
    }),
  }),
}));

import { buildInvoiceFromForm } from '@/lib/invoices/build-from-form';
import { invoiceFormSchema, type InvoiceFormValues } from '@/lib/schemas/invoice-form';
import { loadInvoiceForPdf } from '@/lib/pdf/invoice-data';
import { renderInvoicePdf } from '@/lib/pdf/invoice-renderer';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { validateInvoiceXml } from '@/lib/xml/validator';

const DZIS = '2026-11-14';
const TENANT = {
  id: 'ten-1',
  nip: '5260001246',
  name: 'Moja Firma',
  address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' },
};

const form = (zmiany: Partial<InvoiceFormValues> = {}): InvoiceFormValues => ({
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
  lines: [{ name: 'Szkolenie BHP', unit: 'godz.', quantity: 2, unitPriceNet: 150, vatRate: '23' }],
  ...zmiany,
});

const bledy = (values: InvoiceFormValues) => {
  const wynik = invoiceFormSchema.safeParse(values);
  return wynik.success ? [] : wynik.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

/** Faktura z formularza tak, jak robi to akcja zapisu: schemat, potem budowanie. */
function faktura(zmiany: Partial<InvoiceFormValues> = {}) {
  const parsed = invoiceFormSchema.safeParse(form(zmiany));
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join('; '));
  return buildInvoiceFromForm(parsed.data, TENANT, null, false);
}

const xmlFaktury = (zmiany: Partial<InvoiceFormValues> = {}) =>
  generateFA3Xml(faktura(zmiany), { generatedAt: new Date('2026-11-14T10:00:00Z'), prettyPrint: true });

describe('schemat formularza: numer i data zamówienia', () => {
  it('numer z datą, sam numer, puste pola i brak pól przechodzą', () => {
    for (const zmiany of [
      { orderNumber: 'ZAM/2026/17', orderDate: '2026-11-02' },
      { orderNumber: 'ZAM/2026/17', orderDate: '' },
      { orderNumber: '', orderDate: '' },
      {},
    ]) {
      expect(bledy(form(zmiany))).toEqual([]);
    }
  });

  it('data bez numeru: błąd przy polu numeru z tym, co zrobić', () => {
    expect(bledy(form({ orderNumber: '', orderDate: '2026-11-02' }))).toEqual([
      'orderNumber: Podaj numer zamówienia albo usuń datę zamówienia.',
    ]);
  });

  it('data nieprawdziwa albo bez sensu: błąd przy polu daty', () => {
    for (const orderDate of ['2026-02-30', '02.11.2026', '1999-12-31']) {
      expect(bledy(form({ orderNumber: 'ZAM/1', orderDate })).join(' | '), orderDate).toMatch(/orderDate: /);
    }
  });

  it('numer dłuższy niż w XSD (256), z samych spacji i ze znakiem sterującym odrzucony', () => {
    expect(bledy(form({ orderNumber: 'Z'.repeat(257) })).join(' | ')).toMatch(/orderNumber: Maksymalnie 256/);
    expect(bledy(form({ orderNumber: 'Z'.repeat(256) }))).toEqual([]);
    expect(bledy(form({ orderNumber: '   ', orderDate: '' }))).toEqual([]);
    expect(bledy(form({ orderNumber: 'ZAM\u0007' })).join(' | ')).toMatch(/orderNumber: /);
  });
});

describe('faktura z formularza: dokument faktury (fa3_data)', () => {
  it('numer i data trafiają do faktury, przycięte; bez numeru klucza nie ma', () => {
    expect(faktura({ orderNumber: '  ZAM/2026/17  ', orderDate: '2026-11-02' }).order).toEqual({ number: 'ZAM/2026/17', date: '2026-11-02' });
    expect(faktura({ orderNumber: 'ZAM/2026/17', orderDate: '' }).order).toEqual({ number: 'ZAM/2026/17' });
    for (const zmiany of [{}, { orderNumber: '', orderDate: '' }, { orderNumber: '   ' }]) {
      expect(Object.keys(faktura(zmiany))).not.toContain('order');
    }
  });
});

describe('plik FA(3): Fa/WarunkiTransakcji/Zamowienia', () => {
  it('numer z datą: element w Fa po Platnosc, DataZamowienia przed NrZamowienia, plik przechodzi XSD', async () => {
    const xml = xmlFaktury({ orderNumber: 'ZAM/2026/17', orderDate: '2026-11-02' });
    expect(xml).toMatch(
      /<\/Platnosc>\s*<WarunkiTransakcji>\s*<Zamowienia>\s*<DataZamowienia>2026-11-02<\/DataZamowienia>\s*<NrZamowienia>ZAM\/2026\/17<\/NrZamowienia>\s*<\/Zamowienia>\s*<\/WarunkiTransakcji>\s*<\/Fa>/,
    );
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
  });

  it('sam numer: bez daty, plik przechodzi XSD', async () => {
    const xml = xmlFaktury({ orderNumber: 'ZAM/2026/17' });
    expect(xml).not.toContain('<DataZamowienia>');
    expect(xml).toMatch(/<Zamowienia>\s*<NrZamowienia>ZAM\/2026\/17<\/NrZamowienia>\s*<\/Zamowienia>/);
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
  });

  it('znaki specjalne XML w numerze są zakodowane, plik przechodzi XSD', async () => {
    const xml = xmlFaktury({ orderNumber: 'ZAM <A&B> "1"' });
    expect(xml).toContain('<NrZamowienia>ZAM &lt;A&amp;B&gt; "1"</NrZamowienia>');
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
  });

  it('bez numeru: plik bez WarunkiTransakcji i taki sam jak przed zmianą (bajt w bajt)', () => {
    const bez = xmlFaktury();
    expect(bez).not.toMatch(/WarunkiTransakcji|Zamowienia|NrZamowienia/);
    expect(xmlFaktury({ orderNumber: '', orderDate: '' })).toBe(bez);
    expect(generateFA3Xml(faktura(), { generatedAt: new Date('2026-11-14T10:00:00Z'), prettyPrint: true })).toBe(bez);
  });

  it('numer dłuższy niż w XSD albo z samych spacji: generator odmawia z nazwą pola, nie walidator z xmllint', () => {
    const z = faktura({ orderNumber: 'ZAM/1' });
    expect(() => generateFA3Xml({ ...z, order: { number: 'Z'.repeat(257) } })).toThrow(/Numer zamówienia/);
    expect(() => generateFA3Xml({ ...z, order: { number: '   ' } })).toThrow(/Numer zamówienia/);
  });
});

describe('PDF: wiersz „Zamówienie” tylko przy fakturze z numerem', () => {
  const ADRES = { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' };
  const wierszPdf = (order: unknown) => ({
    id: 'inv-1', tenant_id: 'ten-1', internal_number: 'FV/1/11/2026', invoice_type: 'VAT',
    issue_date: '2026-11-10', sale_date: null, ksef_number: null, net_total: 100, vat_total: 23, gross_total: 123,
    notes: null, updated_at: null, pdf_storage_path: null, pdf_generated_at: null,
    seller_data: { nip: '1234567890', name: 'Sprzedawca', address: ADRES },
    buyer_data: { nip: '1234567890', name: 'Nabywca', address: ADRES },
    payment_data: { currency: 'PLN', method: 'transfer' },
    annotations: null,
    order_ref: order,
    invoice_line_items: [{ ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unit_price_net: 100, net_amount: 100, vat_rate: '23', vat_amount: 23, gross_amount: 123 }],
  });

  async function tekstPdf(order: unknown): Promise<string[]> {
    mocks.row = wierszPdf(order);
    const data = await loadInvoiceForPdf('inv-1', 'ten-1');
    const text = vi.spyOn(PDFDocument.prototype, 'text');
    await renderInvoicePdf(data!.invoice);
    return text.mock.calls.map((c) => String(c[0]));
  }

  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('odczyt bierze numer z dokumentu faktury (fa3_data->order)', async () => {
    mocks.row = wierszPdf(null);
    await loadInvoiceForPdf('inv-1', 'ten-1');
    expect(String(mocks.select.mock.calls[0]?.[0])).toMatch(/order_ref:fa3_data->order/);
  });

  it('z numerem i datą: „Zamówienie: ZAM/2026/17 z dnia 02.11.2026”; sam numer: bez daty', async () => {
    expect(await tekstPdf({ number: 'ZAM/2026/17', date: '2026-11-02' })).toContain('Zamówienie: ZAM/2026/17 z dnia 02.11.2026');
    expect(await tekstPdf({ number: 'ZAM/2026/17' })).toContain('Zamówienie: ZAM/2026/17');
  });

  it('bez numeru, ze złym kształtem i bez daty bez numeru: PDF bez wiersza „Zamówienie”', async () => {
    for (const order of [null, undefined, {}, { date: '2026-11-02' }, { number: '   ' }, { number: 7 }, 'ZAM/1', []]) {
      expect((await tekstPdf(order)).join(' '), JSON.stringify(order)).not.toMatch(/Zamówienie/);
      vi.restoreAllMocks();
    }
  });
});
