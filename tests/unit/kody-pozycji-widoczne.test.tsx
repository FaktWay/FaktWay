import PDFDocument from 'pdfkit';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan kompletnej aplikacji, krok 2.6, część 2b-3c: PKWiU i GTU pozycji widoczne
 * po wystawieniu, te same co w pliku FA(3) (`FaWiersz/PKWiU`, `FaWiersz/GTU`).
 * Kody leżą w dokumencie faktury (`fa3_data.lines`, po numerze pozycji), a PDF
 * i strona dla nabywcy czytały tylko `invoice_line_items` bez kodów. Pokazujemy
 * tylko poprawne kody (PKWiU w formacie formularza, GTU z listy), w drugiej
 * linii pod nazwą pozycji; pozycja bez kodów wygląda jak dotąd.
 *
 * Prawdziwa ścieżka: odczyt danych PDF (`loadInvoiceForPdf`) i renderer
 * (`renderInvoicePdf`), strona `/faktura/<token>` z loaderem. Atrapy: baza
 * (klient serwisowy: wiersz faktury i RPC widoku linku), limit prób, IP.
 */

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde';
const TENANT = '00179179-0000-4000-8000-0000000000aa';
const INVOICE = '00179179-1111-4000-8000-0000000000bb';

const mocks = vi.hoisted(() => ({ row: null as Record<string, unknown> | null, select: vi.fn(), rpc: vi.fn() }));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/lib/auth/get-client-ip', () => ({ getClientIp: async () => '203.0.113.7' }));
vi.mock('@/lib/cache/redis', () => ({
  isRedisConfigured: () => true,
  getRedis: () => ({
    pipeline() {
      const pipe = {
        zremrangebyscore: () => pipe,
        zadd: () => pipe,
        zcard: () => pipe,
        expire: () => pipe,
        exec: async () => [0, 1, 1, 1],
      };
      return pipe;
    },
    zrem: async () => 1,
    zrange: async () => ['m', Date.now() - 60_000],
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    rpc: mocks.rpc,
    from: () => ({
      select: (cols: string) => {
        mocks.select(cols);
        const query = {
          eq: () => query,
          maybeSingle: async () => ({ data: mocks.row, error: null }),
        };
        return query;
      },
    }),
  }),
}));

const { loadInvoiceForPdf } = await import('@/lib/pdf/invoice-data');
const { renderInvoicePdf } = await import('@/lib/pdf/invoice-renderer');
const { default: BuyerInvoicePage } = await import('@/app/faktura/[token]/page');

const ADRES = { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' };
const pozycja = (ordinal: number, name: string) => ({
  ordinal, name, unit: 'usł.', quantity: 1, unit_price_net: 100, net_amount: 100, vat_rate: '23', vat_amount: 23, gross_amount: 123,
});

/** Wiersz faktury dla PDF: pozycje z `invoice_line_items`, kody z `fa3_data.lines` (alias `document_lines`). */
function wierszPdf(documentLines: unknown) {
  return {
    id: INVOICE, tenant_id: TENANT, internal_number: 'FV/1/11/2026', invoice_type: 'VAT',
    issue_date: '2026-11-10', sale_date: null, ksef_number: null, net_total: 300, vat_total: 69, gross_total: 369,
    notes: null, updated_at: null, pdf_storage_path: null, pdf_generated_at: null,
    seller_data: { nip: '1234567890', name: 'Sprzedawca', address: ADRES },
    buyer_data: { nip: '1234567890', name: 'Nabywca', address: ADRES },
    payment_data: { currency: 'PLN', method: 'transfer' },
    annotations: null,
    document_lines: documentLines,
    invoice_line_items: [pozycja(1, 'Doradztwo podatkowe'), pozycja(2, 'Dojazd'), pozycja(3, 'Szkolenie')],
  };
}

/** Dokument faktury: kody poprawne (1), zepsute (3, z innego źródła), brak (2). */
const DOKUMENT = [
  { ordinal: 1, name: 'Doradztwo podatkowe', pkwiuCode: ' 69.20.2 ', gtuCode: 'GTU_12' },
  { ordinal: 2, name: 'Dojazd' },
  { ordinal: 3, name: 'Szkolenie', pkwiuCode: 'ABC-1', gtuCode: 'GTU_99' },
];

async function tekstPdf(row: Record<string, unknown>): Promise<string[]> {
  mocks.row = row;
  const data = await loadInvoiceForPdf(INVOICE, TENANT);
  const text = vi.spyOn(PDFDocument.prototype, 'text');
  await renderInvoicePdf(data!.invoice);
  return text.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example.test');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'fixture-token');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('PDF: PKWiU i GTU pozycji pod nazwą, jak w pliku FA(3)', () => {
  it('odczyt bierze kody z dokumentu faktury (fa3_data->lines), nie z invoice_line_items', async () => {
    mocks.row = wierszPdf(DOKUMENT);
    await loadInvoiceForPdf(INVOICE, TENANT);
    expect(String(mocks.select.mock.calls[0]?.[0])).toMatch(/document_lines:fa3_data->lines/);
  });

  it('pozycja z kodami: nazwa i w drugiej linii „PKWiU 69.20.2, GTU_12”; bez kodów i ze złymi kodami sama nazwa', async () => {
    const teksty = await tekstPdf(wierszPdf(DOKUMENT));
    expect(teksty).toContain('Doradztwo podatkowe\nPKWiU 69.20.2, GTU_12');
    expect(teksty).toContain('Dojazd');
    expect(teksty).toContain('Szkolenie');
    expect(teksty.join(' ')).not.toMatch(/ABC-1|GTU_99/);
  });

  it('faktura bez kodów (dokument bez lines, np. import): PDF jak dotąd, same nazwy', async () => {
    const zKodami = await tekstPdf(wierszPdf(null));
    expect(zKodami).toContain('Doradztwo podatkowe');
    expect(zKodami.join(' ')).not.toMatch(/PKWiU|GTU_/);
  });
});

function rpcRow(lines: unknown[]) {
  return {
    link_id: '00179179-2222-4000-8000-0000000000cc',
    tenant_id: TENANT,
    invoice_id: INVOICE,
    expires_at: '2027-02-07T10:00:00+00:00',
    ksef_environment: 'test',
    xml_storage_path: `${TENANT}/2026/11/${INVOICE}.xml`,
    xml_sha256: 'ab'.repeat(32),
    invoice: {
      internal_number: 'FV/1/11/2026', invoice_type: 'VAT', invoice_kind: 'regular', issue_date: '2026-11-10', sale_date: null,
      currency: 'PLN', net_total: 300, vat_total: 69, gross_total: 369, notes: null,
      ksef_number: '1234567890-20261110-0A1B2C3D4E5F-6A', ksef_accepted_at: '2026-11-10T09:15:00+00:00', split_payment: false,
      seller: { name: 'Sprzedawca', nip: '1234567890', address_line1: 'ul. A 1', address_line2: '00-001 Warszawa', country_code: 'PL' },
      buyer: { name: 'Nabywca', nip: '1234567890', vat_ue_number: null, address_line1: 'ul. A 1', address_line2: '00-001 Warszawa', country_code: 'PL' },
      payment: { method: 'transfer', due_date: '2026-11-24', bank_account: null, bank_name: null, swift: null },
      lines,
    },
  };
}

const strona = async () => renderToStaticMarkup(await BuyerInvoicePage({ params: Promise.resolve({ token: TOKEN }) }));

describe('strona faktury dla nabywcy: PKWiU i GTU pozycji pod nazwą', () => {
  it('kody z widoku linku (pkwiu_code, gtu_code) pod nazwą; zły kod nie trafia na stronę', async () => {
    mocks.rpc.mockResolvedValue({
      data: rpcRow([
        { ...pozycja(1, 'Doradztwo podatkowe'), pkwiu_code: '69.20.2', gtu_code: 'GTU_12' },
        { ...pozycja(2, 'Dojazd'), pkwiu_code: null, gtu_code: null },
        { ...pozycja(3, 'Szkolenie'), pkwiu_code: 'ABC-1', gtu_code: 'GTU_99' },
      ]),
      error: null,
    });
    const html = await strona();
    expect(html).toContain('PKWiU 69.20.2, GTU_12');
    expect(html).not.toMatch(/ABC-1|GTU_99/);
  });

  it('pozycje bez kodów (także widok sprzed migracji, bez pól kodów): strona bez dopisku kodów', async () => {
    mocks.rpc.mockResolvedValue({ data: rpcRow([pozycja(1, 'Doradztwo podatkowe')]), error: null });
    const html = await strona();
    expect(html).toContain('Doradztwo podatkowe');
    expect(html).not.toMatch(/PKWiU|GTU_|data-kody-pozycji/);
  });
});
