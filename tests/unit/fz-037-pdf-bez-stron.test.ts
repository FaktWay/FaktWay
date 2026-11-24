import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  load: vi.fn(), save: vi.fn(), exists: vi.fn(), download: vi.fn(), upload: vi.fn(), offlineQueueEntry: vi.fn(),
}));
vi.mock('@/lib/pdf/invoice-data', () => ({
  loadInvoiceForPdf: mocks.load, saveInvoicePdfPath: mocks.save, invoiceHasOfflineQueueEntry: mocks.offlineQueueEntry,
}));
vi.mock('@/lib/pdf/pdf-storage', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/pdf/pdf-storage')>(),
  invoicePdfExists: mocks.exists, downloadInvoicePdf: mocks.download, uploadInvoicePdf: mocks.upload,
}));
// Firma bez logo, więc wydruk nie czyta bazy ani magazynu logo.
vi.mock('@/lib/pdf/logo-odczyt', () => ({ readTenantLogoKey: async () => null, loadPdfLogo: async () => null }));

import { generateInvoicePdf } from '@/lib/pdf/invoice-pdf';
import { buildInvoicePdfKey } from '@/lib/pdf/pdf-storage';

/**
 * FZ-037: faktura zakupu ze Skrzynki KSeF nie ma w wierszu `invoices` danych
 * stron ani płatności (`inbox-polling.ts` ich nie zapisuje) i nie ma
 * zapisanego PDF (wydruk zawsze padał), więc renderer padał na
 * `invoice.seller.name` (bez płatności na `payment.method`), a trasa PDF dawała
 * 500. Teraz odmowa z numerem, numerem KSeF i wyjściem, zanim powstanie wydruk
 * albo zostanie wydany zapisany wcześniej plik. Renderer jest prawdziwy (bez
 * atrapy), więc na kodzie sprzed naprawy przypadki bez zapisanego PDF kończą
 * się wyjątkiem renderera.
 */

const KSEF = '1234567890-20261001-0100A0B0C0D1-AF';
const ZAPISANY = buildInvoicePdfKey('tenant-a', 'invoice', '2026-10-01', null, KSEF);
const STRONA = { nip: '1234567890', name: 'Firma', address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } };
const PLATNOSC = { amountDue: 123, currency: 'PLN', method: 'transfer', dueDate: '2026-10-15' };
const POZYCJA = { ordinal: 1, name: 'Usługa', unit: 'szt', quantity: 1, unitPriceNet: 100, netAmount: 100, vatRate: '23', vatAmount: 23, grossAmount: 123 };

const BEZ_ZAPISU = { pdfStoragePath: null, pdfGeneratedAt: null };
const ZAPISANY_PLIK = { pdfStoragePath: ZAPISANY, pdfGeneratedAt: '2026-10-02T10:00:00Z' };

const dane = (invoice: Record<string, unknown>, zapis: Record<string, unknown>) => ({
  invoice: { internalNumber: 'FZ/7/2026', type: 'VAT', issueDate: '2026-10-01', lines: [POZYCJA], netTotal: 100, vatTotal: 23, grossTotal: 123, ...invoice },
  tenantId: 'tenant-a', invoiceId: 'invoice', issueDate: '2026-10-01', ksefNumber: KSEF, ksefStatus: 'accepted',
  internalNumberMissing: false, offlineIdempotencyKey: null, sellerNip: '1234567890', xmlSha256Hex: null,
  correctedInvoice: null, receiptInvoiceMarker: false, currency: 'PLN', updatedAt: '2026-10-01T10:00:00Z',
  ...zapis,
});

const BRAKI: Array<[string, Record<string, unknown>]> = [
  ['wiersz ze Skrzynki: bez stron i płatności', { seller: null, buyer: null, payment: null }],
  ['bez nabywcy', { seller: STRONA, buyer: null, payment: PLATNOSC }],
  ['sprzedawca bez adresu', { seller: { nip: '1234567890', name: 'Firma' }, buyer: STRONA, payment: PLATNOSC }],
  ['strony z adresem, bez płatności', { seller: STRONA, buyer: STRONA, payment: null }],
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.exists.mockResolvedValue(true);
  mocks.download.mockResolvedValue(Buffer.from('zapisany-plik'));
  mocks.upload.mockResolvedValue(undefined);
  mocks.save.mockResolvedValue(undefined);
  mocks.offlineQueueEntry.mockResolvedValue(false);
});

describe('FZ-037: PDF faktury bez danych stron albo płatności (faktura zakupu ze Skrzynki KSeF)', () => {
  it.each(BRAKI)('%s, bez zapisanego PDF: odmowa z numerem, numerem KSeF i wyjściem zamiast wyjątku renderera', async (_opis, braki) => {
    mocks.load.mockResolvedValue(dane(braki, BEZ_ZAPISU));
    const wynik = await generateInvoicePdf('invoice', 'tenant-a');
    expect(wynik).toMatchObject({ success: false, code: 'PRINT_DATA_MISSING' });
    if (wynik.success) return;
    for (const tekst of [
      'Faktura FZ/7/2026',
      `numer KSeF ${KSEF}`,
      'pełnych danych sprzedawcy, nabywcy albo płatności',
      'Aplikacji Podatnika KSeF',
      '„Pobierz XML”',
    ]) expect(wynik.error).toContain(tekst);
    for (const m of [mocks.exists, mocks.download, mocks.upload, mocks.save]) expect(m).not.toHaveBeenCalled();
  });

  it.each(BRAKI)('%s, z zapisanym PDF: ta sama odmowa, bez wydania zapisanego pliku', async (_opis, braki) => {
    mocks.load.mockResolvedValue(dane(braki, ZAPISANY_PLIK));
    expect(await generateInvoicePdf('invoice', 'tenant-a')).toMatchObject({ success: false, code: 'PRINT_DATA_MISSING' });
    for (const m of [mocks.exists, mocks.download, mocks.upload, mocks.save]) expect(m).not.toHaveBeenCalled();
  });

  it('pełne dane, bez zapisanego PDF: wydruk z prawdziwego renderera trafia do magazynu', async () => {
    mocks.load.mockResolvedValue(dane({ seller: STRONA, buyer: STRONA, payment: PLATNOSC }, BEZ_ZAPISU));
    const wynik = await generateInvoicePdf('invoice', 'tenant-a');
    expect(wynik.success).toBe(true);
    if (!wynik.success) return;
    expect(wynik.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(mocks.upload).toHaveBeenCalledWith(ZAPISANY, wynik.pdf);
    expect(mocks.save).toHaveBeenCalledWith('invoice', ZAPISANY);
  });

  it('pełne dane, z ważnym zapisanym PDF: zapisany plik jak dotąd', async () => {
    mocks.load.mockResolvedValue(dane({ seller: STRONA, buyer: STRONA, payment: PLATNOSC }, ZAPISANY_PLIK));
    expect(await generateInvoicePdf('invoice', 'tenant-a')).toMatchObject({ success: true, pdf: Buffer.from('zapisany-plik') });
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});
