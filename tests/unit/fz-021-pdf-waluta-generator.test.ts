import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  load: vi.fn(), save: vi.fn(), render: vi.fn(),
  exists: vi.fn(), download: vi.fn(), upload: vi.fn(),
  offlineQueueEntry: vi.fn(),
}));
vi.mock('@/lib/pdf/invoice-data', () => ({
  loadInvoiceForPdf: mocks.load, saveInvoicePdfPath: mocks.save,
  invoiceHasOfflineQueueEntry: mocks.offlineQueueEntry,
}));
vi.mock('@/lib/pdf/invoice-renderer', () => ({ renderInvoicePdf: mocks.render }));
vi.mock('@/lib/pdf/pdf-storage', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/pdf/pdf-storage')>(),
  invoicePdfExists: mocks.exists, downloadInvoicePdf: mocks.download, uploadInvoicePdf: mocks.upload,
}));

import { generateInvoicePdf } from '@/lib/pdf/invoice-pdf';
import { buildInvoicePdfKey } from '@/lib/pdf/pdf-storage';

/**
 * FZ-021: wydruk ma kwoty i „Do zapłaty” z dopiskiem PLN na sztywno, więc
 * faktura w każdej innej walucie ze słownika MF (`TKodWaluty` w schemacie
 * FA(3)) dostaje odmowę z numerem, numerem KSeF, walutą i wyjściem, zanim
 * powstanie wydruk albo zostanie wydany zapisany wcześniej plik. PLN (także
 * dane bez pola waluty, jak domyślna kolumny) drukuje się jak dotąd.
 */

const KODY = (() => {
  const xsd = readFileSync(join(process.cwd(), 'lib/xml/schemas/fa3/schemat.xsd'), 'utf8');
  const od = xsd.indexOf('<xsd:simpleType name="TKodWaluty">');
  const typ = xsd.slice(od, xsd.indexOf('</xsd:simpleType>', od));
  return [...typ.matchAll(/<xsd:enumeration value="([A-Z]{3})"/g)].map((m) => m[1]!);
})();

const KSEF = '1234567890-20260909-0100A0B0C0D1-AF';
const ZAPISANY = buildInvoicePdfKey('tenant-a', 'invoice', '2026-09-09');

const dane = (z: Record<string, unknown> = {}) => ({
  invoice: { internalNumber: 'FZ/7/2026' }, tenantId: 'tenant-a', invoiceId: 'invoice', issueDate: '2026-09-09',
  ksefNumber: KSEF, ksefStatus: 'accepted', internalNumberMissing: false, offlineIdempotencyKey: null,
  sellerNip: '1234567890', xmlSha256Hex: null, correctedInvoice: null, receiptInvoiceMarker: false,
  pdfStoragePath: ZAPISANY, pdfGeneratedAt: '2026-09-09T13:00:00Z', updatedAt: '2026-09-09T12:00:00Z',
  ...z,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.exists.mockResolvedValue(true);
  mocks.download.mockResolvedValue(Buffer.from('zapisany-plik'));
  mocks.render.mockResolvedValue(Buffer.from('nowy-wydruk'));
  mocks.offlineQueueEntry.mockResolvedValue(false);
});

describe('FZ-021: PDF faktury tylko w złotych', () => {
  it('słownik walut MF ma PLN i ponad 150 innych kodów (inaczej test nie sprawdza niczego)', () => {
    expect(KODY).toContain('PLN');
    expect(KODY).toContain('EUR');
    expect(KODY.length).toBeGreaterThan(150);
  });

  it('każda waluta ze słownika MF poza PLN: odmowa z numerem, numerem KSeF, walutą i wyjściem, bez wydruku i bez zapisanego pliku', async () => {
    for (const kod of KODY.filter((k) => k !== 'PLN')) {
      vi.clearAllMocks();
      mocks.load.mockResolvedValue(dane({ currency: kod }));
      const wynik = await generateInvoicePdf('invoice', 'tenant-a');
      expect(wynik, kod).toMatchObject({ success: false, code: 'CURRENCY_NOT_SUPPORTED' });
      if (wynik.success) continue;
      for (const tekst of ['Faktura FZ/7/2026', `numer KSeF ${KSEF}`, `w walucie ${kod}`, 'Aplikacji Podatnika KSeF', '„Pobierz XML”']) {
        expect(wynik.error, kod).toContain(tekst);
      }
      for (const m of [mocks.render, mocks.exists, mocks.download, mocks.upload, mocks.save]) expect(m, kod).not.toHaveBeenCalled();
    }
  });

  it('PLN i dane bez pola waluty: PDF jak dotąd', async () => {
    for (const z of [{ currency: 'PLN' }, {}]) {
      mocks.load.mockResolvedValue(dane(z));
      expect(await generateInvoicePdf('invoice', 'tenant-a'), JSON.stringify(z)).toMatchObject({ success: true });
    }
  });

  it('faktura bez numeru własnego: odmowa z numerem KSeF zamiast numeru zastępczego', async () => {
    mocks.load.mockResolvedValue(dane({ currency: 'USD', internalNumberMissing: true, invoice: { internalNumber: 'invoice' } }));
    const wynik = await generateInvoicePdf('invoice', 'tenant-a');
    expect(wynik).toMatchObject({ success: false, code: 'CURRENCY_NOT_SUPPORTED' });
    if (wynik.success) return;
    expect(wynik.error).toContain(`Faktura ${KSEF} jest w walucie USD`);
  });
});
