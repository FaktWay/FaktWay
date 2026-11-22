import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, memoryDb, type MemoryDb, type Row } from '../helpers/fake-supabase-memory';

/**
 * Podkład z faktury w cenach brutto (plan cen brutto, PR (b); uwaga N1
 * czytelnika (c)): „Duplikuj”, „Wystaw teraz” z faktury cyklicznej
 * (`prefillFromInvoiceAction`) i „Wypełnij z ostatniej faktury”
 * (`prefillFromLastInvoiceAction`). Pozycja faktury w cenach brutto ma w bazie
 * pustą cenę netto (NULL), a cenę brutto w dokumencie faktury. Podkład brał
 * `Number(unit_price_net) || 0`, więc nowa faktura dostawała cenę 0 zł. Ma
 * wrócić w cenach brutto z ceną brutto pozycji; brak ceny nie staje się ceną 0.
 *
 * Prawdziwe akcje i schemat formularza; atrapy: sesja i baza w pamięci.
 */

const TENANT = 'ten-1';
const ID = '7f1c2d3e-4b5a-4c6d-8e7f-901234567890';

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));

vi.mock('@/lib/supabase/auth-context', () => ({ requireUserAndActiveOrg: mocks.auth }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: vi.fn() }));
vi.mock('@/lib/gus/client', () => ({ lookupCompanyByNip: vi.fn() }));

import { prefillFromInvoiceAction, prefillFromLastInvoiceAction } from '@/components/invoices/actions';
import { buildInvoiceFromForm } from '@/lib/invoices/build-from-form';
import { invoiceFormSchema, type InvoiceFormValues } from '@/lib/schemas/invoice-form';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';
import type { Invoice } from '@/types/invoice';

const SELLER = { nip: '5260001246', name: 'ACME', address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } };
const BUYER = { nip: '5252241585', name: 'Klient sp. z o.o.', address: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '00-002 Warszawa' } };

/** Faktura w cenach brutto tak, jak ją liczy i zapisuje FaktWay (#835): trzy pozycje po 1,00 zł przy 23 %, 8 % obiad. */
const faktura: Invoice = finalizeInvoice({
  internalNumber: 'FV/7/11/2026',
  type: 'VAT',
  issueDate: '2026-11-10',
  seller: SELLER,
  buyer: BUYER,
  pricesGross: true,
  lines: [
    { ordinal: 1, name: 'Kawa', unit: 'szt.', quantity: 1, unitPriceNet: 0, unitPriceGross: 1, vatRate: '23' },
    { ordinal: 2, name: 'Herbata', unit: 'szt.', quantity: 1, unitPriceNet: 0, unitPriceGross: 1, vatRate: '23' },
    { ordinal: 3, name: 'Woda', unit: 'szt.', quantity: 1, unitPriceNet: 0, unitPriceGross: 1, vatRate: '23' },
    { ordinal: 4, name: 'Obiad', unit: 'szt.', quantity: 2, unitPriceNet: 0, unitPriceGross: 20.99, vatRate: '8' },
  ],
  payment: { currency: 'PLN', dueDate: '2026-11-24', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
});

/** Wiersze pozycji w bazie jak przy zapisie faktury w cenach brutto: cena netto pusta, kwoty z podziału stawki. */
const wierszeBrutto = (invoiceId: string, f: Invoice): Row[] =>
  f.lines.map((l) => ({
    id: `l${l.ordinal}`, invoice_id: invoiceId, ordinal: l.ordinal, name: l.name, unit: l.unit, quantity: l.quantity,
    unit_price_net: null, vat_rate: l.vatRate, net_amount: l.netAmount, vat_amount: l.vatAmount, gross_amount: l.grossAmount,
  }));

function wiersz(fa3: unknown, extra: Row = {}): Row {
  return {
    id: ID, tenant_id: TENANT, direction: 'outgoing', invoice_kind: 'regular', internal_number: 'FV/7/11/2026',
    issue_date: '2026-11-10', payment_due_date: '2026-11-24', days_to_payment: 14, created_at: '2026-11-10T08:00:00Z',
    is_b2c: false, buyer_id_type: 'nip', buyer_pesel: null, buyer_id_number: null,
    fa3_data: JSON.parse(JSON.stringify(fa3)),
    ...extra,
  };
}

let db: MemoryDb;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-17T08:00:00Z'));
  db = memoryDb({
    tenants: [{ id: TENANT, nip: '5260001246', name: 'ACME', address_json: null }],
    invoices: [wiersz(faktura)],
    invoice_line_items: wierszeBrutto(ID, faktura),
  });
  mocks.auth.mockResolvedValue({ supabase: fakeSupabase(db), user: { id: 'user-1' }, tenantId: TENANT, role: 'owner' });
});

const pelne = (values: Partial<InvoiceFormValues>): InvoiceFormValues =>
  ({ notes: '', buyerIsEu: false, buyerVatUe: '', buyerCountryCode: '', buyerIsConsumer: false, buyerPesel: '', buyerIdDocument: '', ...values }) as InvoiceFormValues;

const kwotyPozycji = (f: Invoice) => f.lines.map((l) => [l.name, l.netAmount, l.vatAmount, l.grossAmount]);

describe('podkład z faktury w cenach brutto (uwaga N1)', () => {
  it('„Duplikuj” i „Wystaw teraz”: metoda i ceny brutto z dokumentu, nie cena 0 zł; nowa faktura ma te same kwoty co wzór', async () => {
    const p = await prefillFromInvoiceAction(ID);
    expect(p?.values.pricesGross).toBe(true);
    expect(p?.values.lines.map((l) => [l.name, l.quantity, l.unitPriceGross, l.vatRate])).toEqual([
      ['Kawa', 1, 1, '23'],
      ['Herbata', 1, 1, '23'],
      ['Woda', 1, 1, '23'],
      ['Obiad', 2, 20.99, '8'],
    ]);
    // Podkład przechodzi schemat formularza i daje fakturę z kwotami wzoru (VAT stawek od sum brutto).
    const parsed = invoiceFormSchema.safeParse(pelne(p!.values));
    expect(parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)).toEqual([]);
    const nowa = buildInvoiceFromForm(parsed.data!, { id: TENANT, ...SELLER }, null, false);
    expect(nowa.pricesGross).toBe(true);
    expect(kwotyPozycji(nowa)).toEqual(kwotyPozycji(faktura));
    expect([nowa.netTotal, nowa.vatTotal, nowa.grossTotal]).toEqual([faktura.netTotal, faktura.vatTotal, faktura.grossTotal]);
    expect([faktura.vatTotal, faktura.grossTotal]).toEqual([3.67, 44.98]);
  });

  it('„Wypełnij z ostatniej faktury”: ten sam podkład w cenach brutto', async () => {
    const p = await prefillFromLastInvoiceAction();
    expect(p?.values.pricesGross).toBe(true);
    expect(p?.values.lines.map((l) => l.unitPriceGross)).toEqual([1, 1, 1, 20.99]);
  });

  it('import faktury w cenach brutto (P_9B w pliku, cena netto pusta): podkład w cenach brutto z ceną z pliku', async () => {
    db.tables.invoices = [wiersz({
      buyer: BUYER,
      payment: { method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
      ksefLineFields: [{ ordinal: 1, P_8B: 1, P_9B: 12.3, P_11A: 12.3 }],
    })];
    db.tables.invoice_line_items = [
      { id: 'l1', invoice_id: ID, ordinal: 1, name: 'Towar', unit: 'szt.', quantity: 1, unit_price_net: null, vat_rate: '23' },
    ];
    const p = await prefillFromLastInvoiceAction();
    expect(p?.values.pricesGross).toBe(true);
    expect(p?.values.lines).toEqual([{ name: 'Towar', unit: 'szt.', quantity: 1, unitPriceNet: 0, unitPriceGross: 12.3, vatRate: '23' }]);
  });

  it('pozycja bez ceny netto i bez ceny brutto w dokumencie: bez podkładu zamiast ceny 0 zł', async () => {
    db.tables.invoices = [wiersz({ buyer: BUYER, payment: { method: 'transfer' } })];
    db.tables.invoice_line_items = [
      { id: 'l1', invoice_id: ID, ordinal: 1, name: 'Usługa', unit: 'szt.', quantity: 1, unit_price_net: 100, vat_rate: '23' },
      { id: 'l2', invoice_id: ID, ordinal: 2, name: 'Towar', unit: 'szt.', quantity: 1, unit_price_net: null, vat_rate: '23' },
    ];
    await expect(prefillFromLastInvoiceAction()).resolves.toBeNull();
    await expect(prefillFromInvoiceAction(ID)).resolves.toBeNull();
  });

  it('faktura w cenach netto: podkład jak dotąd, bez metody cen w wartościach', async () => {
    db.tables.invoices = [wiersz({ buyer: BUYER, payment: { method: 'transfer', bankAccount: 'PL61109010140000071219812874' } })];
    db.tables.invoice_line_items = [
      { id: 'l1', invoice_id: ID, ordinal: 1, name: 'Usługa', unit: 'szt.', quantity: 1, unit_price_net: 100, vat_rate: '23' },
    ];
    const p = await prefillFromInvoiceAction(ID);
    expect(p?.values).not.toHaveProperty('pricesGross');
    expect(p?.values.lines).toEqual([{ name: 'Usługa', unit: 'szt.', quantity: 1, unitPriceNet: 100, vatRate: '23' }]);
  });
});
