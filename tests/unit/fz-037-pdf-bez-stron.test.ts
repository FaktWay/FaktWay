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

import { generateInvoicePdf } from '@/lib/pdf/invoice-pdf';
import { buildInvoicePdfKey } from '@/lib/pdf/pdf-storage';

/**
 * FZ-037: faktura zakupu ze Skrzynki KSeF nie ma w wierszu `invoices` danych
 * stron ani płatności (`inbox-polling.ts` ich nie zapisuje), więc prawdziwy
 * renderer padał na `invoice.seller.name` i trasa PDF dawała 500. Teraz
 * odmowa z numerem, numerem KSeF i wyjściem, zanim powstanie wydruk albo
 * zostanie wydany zapisany wcześniej plik. Renderer jest tu prawdziwy.
 */

const KSEF = '1234567890-20261001-0100A0B0C0D1-AF';
const ZAPISANY = buildInvoicePdfKey('tenant-a', 'invoice', '2026-10-01', null, KSEF);
const STRONA = { nip: '1234567890', name: 'Firma', address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } };

const dane = (invoice: Record<string, unknown>) => ({
  invoice: { internalNumber: 'FZ/7/2026', type: 'VAT', issueDate: '2026-10-01', lines: [], netTotal: 100, vatTotal: 23, grossTotal: 123, ...invoice },
  tenantId: 'tenant-a', invoiceId: 'invoice', issueDate: '2026-10-01', ksefNumber: KSEF, ksefStatus: 'accepted',
  internalNumberMissing: false, offlineIdempotencyKey: null, sellerNip: '1234567890', xmlSha256Hex: null,
  correctedInvoice: null, receiptInvoiceMarker: false, currency: 'PLN',
  pdfStoragePath: ZAPISANY, pdfGeneratedAt: '2026-10-02T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z',
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.exists.mockResolvedValue(true);
  mocks.download.mockResolvedValue(Buffer.from('zapisany-plik'));
  mocks.offlineQueueEntry.mockResolvedValue(false);
});

describe('FZ-037: PDF faktury bez danych stron (faktura zakupu ze Skrzynki KSeF)', () => {
  it.each([
    ['bez sprzedawcy i nabywcy (wiersz ze Skrzynki)', { seller: null, buyer: null }],
    ['bez nabywcy', { seller: STRONA, buyer: null }],
    ['sprzedawca bez adresu', { seller: { nip: '1234567890', name: 'Firma' }, buyer: STRONA }],
  ])('%s: odmowa z numerem, numerem KSeF i wyjściem, bez wydruku i bez zapisanego pliku, a nie wyjątek', async (_opis, strony) => {
    mocks.load.mockResolvedValue(dane(strony));
    const wynik = await generateInvoicePdf('invoice', 'tenant-a');
    expect(wynik).toMatchObject({ success: false, code: 'PARTY_DATA_MISSING' });
    if (wynik.success) return;
    for (const tekst of ['Faktura FZ/7/2026', `numer KSeF ${KSEF}`, 'Aplikacji Podatnika KSeF', '„Pobierz XML”']) expect(wynik.error).toContain(tekst);
    for (const m of [mocks.exists, mocks.download, mocks.upload, mocks.save]) expect(m).not.toHaveBeenCalled();
  });

  it('obie strony z adresem: PDF jak dotąd (zapisany plik jest ważny)', async () => {
    mocks.load.mockResolvedValue(dane({ seller: STRONA, buyer: STRONA }));
    expect(await generateInvoicePdf('invoice', 'tenant-a')).toMatchObject({ success: true, pdf: Buffer.from('zapisany-plik') });
  });
});
