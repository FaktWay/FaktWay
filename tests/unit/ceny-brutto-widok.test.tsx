import PDFDocument from 'pdfkit';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Faktura FaktWay w cenach brutto na wydruku i w widokach (plan cen brutto,
 * PR (c); art. 106e ust. 8 ustawy o VAT: cena jednostkowa brutto zamiast netto).
 * Pozycja takiej faktury ma w bazie pustą cenę netto (`unit_price_net` NULL, jak
 * import od brutto, F12-E4), a cenę brutto w dokumencie faktury
 * (`fa3_data.lines[].unitPriceGross`, `fa3_data.pricesGross`). PDF i strona dla
 * nabywcy drukowały cenę netto 0,00 albo „—”; mają pokazać „1,00 brutto”, to
 * samo co plik FA(3) (`P_9B`).
 *
 * Prawdziwa ścieżka: `loadInvoiceForPdf` i `renderInvoicePdf`, strona
 * `/faktura/<token>` z loaderem. Atrapy: baza (wiersz faktury i RPC widoku
 * linku), limit prób, IP.
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
/** Pozycja faktury w cenach brutto tak, jak zapisze ją aplikacja: cena netto pusta, netto i VAT z podziału stawki. */
const pozycjaBrutto = (ordinal: number, name: string, net: number, vat: number, gross: number) => ({
  ordinal, name, unit: 'szt.', quantity: 1, unit_price_net: null, net_amount: net, vat_rate: '23', vat_amount: vat, gross_amount: gross,
});

function wierszPdf(pricesGross: unknown, documentLines: unknown) {
  return {
    id: INVOICE, tenant_id: TENANT, internal_number: 'FV/1/11/2026', invoice_type: 'VAT',
    issue_date: '2026-11-17', sale_date: null, ksef_number: null, net_total: 2.44, vat_total: 0.56, gross_total: 3,
    notes: null, updated_at: null, pdf_storage_path: null, pdf_generated_at: null,
    seller_data: { nip: '1234567890', name: 'Sprzedawca', address: ADRES },
    buyer_data: { nip: '1234567890', name: 'Nabywca', address: ADRES },
    payment_data: { currency: 'PLN', method: 'transfer' },
    annotations: null,
    prices_gross: pricesGross,
    document_lines: documentLines,
    invoice_line_items: [pozycjaBrutto(1, 'Kawa', 0.82, 0.18, 1), pozycjaBrutto(2, 'Herbata', 0.81, 0.19, 1), pozycjaBrutto(3, 'Woda', 0.81, 0.19, 1)],
  };
}

const DOKUMENT = [1, 2, 3].map((ordinal) => ({ ordinal, unitPriceGross: 1, grossAmount: 1 }));

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

describe('PDF faktury FaktWay w cenach brutto', () => {
  it('odczyt bierze metodę cen z dokumentu (fa3_data->pricesGross)', async () => {
    mocks.row = wierszPdf(true, DOKUMENT);
    await loadInvoiceForPdf(INVOICE, TENANT);
    expect(String(mocks.select.mock.calls[0]?.[0])).toMatch(/prices_gross:fa3_data->pricesGross/);
  });

  it('cena pozycji to cena brutto z dokumentu („1,00 brutto”, jak P_9B w pliku), nie netto 0,00', async () => {
    const teksty = await tekstPdf(wierszPdf(true, DOKUMENT));
    expect(teksty.filter((t) => t === '1,00 brutto')).toHaveLength(3);
    expect(teksty).not.toContain('0,00');
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
      internal_number: 'FV/1/11/2026', invoice_type: 'VAT', invoice_kind: 'regular', issue_date: '2026-11-17', sale_date: null,
      currency: 'PLN', net_total: 2.44, vat_total: 0.56, gross_total: 3, notes: null,
      ksef_number: '1234567890-20261117-0A1B2C3D4E5F-6A', ksef_accepted_at: '2026-11-17T09:15:00+00:00', split_payment: false,
      seller: { name: 'Sprzedawca', nip: '1234567890', address_line1: 'ul. A 1', address_line2: '00-001 Warszawa', country_code: 'PL' },
      buyer: { name: 'Nabywca', nip: '1234567890', vat_ue_number: null, address_line1: 'ul. A 1', address_line2: '00-001 Warszawa', country_code: 'PL' },
      payment: { method: 'transfer', due_date: '2026-12-01', bank_account: null, bank_name: null, swift: null },
      lines,
    },
  };
}

const strona = async () => renderToStaticMarkup(await BuyerInvoicePage({ params: Promise.resolve({ token: TOKEN }) }));

describe('strona faktury dla nabywcy: faktura w cenach brutto', () => {
  it('cena pozycji z widoku linku (unit_price_gross) jako „1,00 brutto”', async () => {
    mocks.rpc.mockResolvedValue({
      data: rpcRow([{ ...pozycjaBrutto(1, 'Kawa', 0.82, 0.18, 1), pkwiu_code: null, gtu_code: null, unit_price_gross: 1 }]),
      error: null,
    });
    const html = await strona();
    expect(html).toContain('1,00 brutto');
  });

  it('faktura w cenach netto (bez ceny brutto w widoku): cena netto jak dotąd', async () => {
    mocks.rpc.mockResolvedValue({
      data: rpcRow([{ ordinal: 1, name: 'Usługa', unit: 'szt.', quantity: 1, unit_price_net: 500, vat_rate: '23', net_amount: 500, vat_amount: 115, gross_amount: 615 }]),
      error: null,
    });
    const html = await strona();
    expect(html).toContain('500,00');
    expect(html).not.toContain('brutto</td>');
    expect(html).not.toMatch(/\d brutto/);
  });
});
