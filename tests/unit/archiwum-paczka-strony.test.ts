import { inflateRawSync } from 'node:zlib';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * FZ-033 (`docs/filtr/USTALENIA.md`): odczyty paczki archiwum bez licznika.
 * `readPeriodRows` czytał faktury i koszty okresu zakresami po 1000 i kończył na
 * krótszej stronie, a `readByInvoice` czytał pliki (XML, UPO) jednym `in()` na
 * 200 faktur. Produkcja ucina każdą odpowiedź do 1000 wierszy bez błędu
 * (`POSTGREST_MAX_ROWS`), więc przy dłuższej historii UPO albo niższym limicie
 * serwera paczka po cichu traciła dokumenty. Teraz odczyt idzie helperami
 * z licznikiem i stronami po `id` (`readCompletePagesByKey`, `readAllByIdInList`):
 * komplet albo wyjątek.
 *
 * Prawdziwa ścieżka `buildArchivePackage`; atrapy: serwer PostgREST (filtry,
 * `order('id')`, `gt`, `limit`, `count`, ucinanie do limitu serwera), magazyn,
 * PDF i JPK.
 */

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  /** Limit wierszy jednej odpowiedzi serwera (PostgREST `max-rows`). */
  maxRows: 1000,
  /** Kolejne zapytania o tabelę (licznik) i zapis „w trakcie” przed zapytaniem o numerze `n`. */
  zapytania: {} as Record<string, number>,
  przedZapytaniem: null as null | ((table: string, n: number) => void),
  xml: vi.fn(),
  r2: vi.fn(),
  photo: vi.fn(),
  pdf: vi.fn(),
  fetchJpk: vi.fn(),
  office: vi.fn(),
  address: vi.fn(),
  jpk: vi.fn(),
  xsd: vi.fn(),
}));

/** Atrapa PostgREST: filtry, `order('id')`, `gt`, `limit`/`range`, `count`/`head`, odpowiedź ucięta do `maxRows` bez błędu. */
class Query implements PromiseLike<{ data: Row[] | null; count: number | null; error: null }> {
  private rows: Row[];
  private countMode = false;
  private headMode = false;
  private sortById = false;
  private take: number | null = null;
  private skip = 0;
  constructor(rows: Row[]) {
    this.rows = [...rows];
  }
  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    this.countMode = opts?.count === 'exact';
    this.headMode = opts?.head === true;
    return this;
  }
  order(column: string) {
    if (column === 'id') this.sortById = true;
    return this;
  }
  eq(column: string, value: unknown) {
    this.rows = this.rows.filter((r) => r[column] === value);
    return this;
  }
  in(column: string, values: readonly unknown[]) {
    this.rows = this.rows.filter((r) => values.includes(r[column]));
    return this;
  }
  gte(column: string, value: string) {
    this.rows = this.rows.filter((r) => String(r[column]) >= value);
    return this;
  }
  lte(column: string, value: string) {
    this.rows = this.rows.filter((r) => String(r[column]) <= value);
    return this;
  }
  gt(column: string, value: string) {
    this.rows = this.rows.filter((r) => String(r[column]) > value);
    return this;
  }
  limit(n: number) {
    this.take = n;
    return this;
  }
  range(from: number, to: number) {
    this.skip = from;
    this.take = to - from + 1;
    return this;
  }
  maybeSingle() {
    return Promise.resolve({ data: this.rows[0] ?? null, error: null });
  }
  private result() {
    const all = this.sortById ? [...this.rows].sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0)) : this.rows;
    const count = this.countMode ? all.length : null;
    if (this.headMode) return { data: null, count, error: null as null };
    const page = all.slice(this.skip, this.take === null ? undefined : this.skip + this.take).slice(0, h.maxRows);
    return { data: page, count, error: null as null };
  }
  then<A, B>(
    ok?: ((v: { data: Row[] | null; count: number | null; error: null }) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ) {
    return Promise.resolve(this.result()).then(ok, bad);
  }
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      h.zapytania[table] = (h.zapytania[table] ?? 0) + 1;
      h.przedZapytaniem?.(table, h.zapytania[table]);
      return new Query(h.tables[table] ?? []);
    },
  }),
}));
vi.mock('@/lib/storage/r2', () => ({ downloadInvoiceXml: h.xml, downloadFromR2: h.r2 }));
vi.mock('@/lib/storage/expenses', () => ({ downloadExpensePhoto: h.photo }));
vi.mock('@/lib/pdf/invoice-pdf', () => ({ generateInvoicePdf: h.pdf }));
vi.mock('@/lib/exports/data-fetcher', () => ({ fetchInvoicesForExport: h.fetchJpk }));
vi.mock('@/lib/exports/tax-office', async (orig) => ({ ...(await orig<object>()), readTenantTaxOffice: h.office }));
vi.mock('@/lib/exports/issuer-address', async (orig) => ({ ...(await orig<object>()), readIssuerRegisteredAddress: h.address }));
vi.mock('@/lib/exports/jpk-fa-generator', async (orig) => ({ ...(await orig<object>()), generateJpkFa: h.jpk }));
vi.mock('@/lib/exports/jpk-schema-check', async (orig) => ({ ...(await orig<object>()), assertJpkMatchesSchema: h.xsd }));

import { buildArchivePackage } from '@/lib/archiwum/paczka';

const T = '0178aaaa-0000-4000-8000-000000000001';
const ORDER = { id: '0178bbbb-0000-4000-8000-000000000001', tenantId: T, periodStart: '2026-03-01', periodEnd: '2026-03-31', kind: 'archive' as const };
const NOW = new Date('2026-11-09T13:35:00Z');
const ADRES = { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' };

/** Wpisy ZIP z katalogu centralnego (nazwy i treść). */
function rozpakuj(zip: Buffer): Map<string, Buffer> {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(eocd + 10);
  let cd = zip.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(cd + 10);
    const size = zip.readUInt32LE(cd + 20);
    const nameLen = zip.readUInt16LE(cd + 28);
    const extraLen = zip.readUInt16LE(cd + 30);
    const commentLen = zip.readUInt16LE(cd + 32);
    const name = zip.subarray(cd + 46, cd + 46 + nameLen).toString('utf8');
    const lh = zip.readUInt32LE(cd + 42);
    const start = lh + 30 + zip.readUInt16LE(lh + 26) + zip.readUInt16LE(lh + 28);
    const raw = zip.subarray(start, start + size);
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    cd += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const pad = (n: number) => String(n).padStart(6, '0');
const invoiceId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Faktura sprzedaży przyjęta w KSeF w marcu, z plikiem XML w magazynie. */
function sprzedaz(n: number): Row {
  const day = String((n % 28) + 1).padStart(2, '0');
  return {
    id: invoiceId(n), tenant_id: T, direction: 'outgoing', internal_number: `FV/${n}/2026`, ksef_number: `1234567890-202603${day}-${pad(n)}-AB`,
    ksef_status: 'accepted', ksef_environment: 'test', origin: 'manual', issue_date: `2026-03-${day}`, sale_date: `2026-03-${day}`,
    payment_due_date: null, net_total: 100, vat_total: 23, gross_total: 123, currency: 'PLN',
    seller_data: { name: 'Firma Testowa', address: ADRES }, buyer_data: { name: 'Nabywca', nip: '1234567890', address: ADRES },
    seller_nip: '1234567890', buyer_nip: '1234567890', xml_storage_path: `${T}/2026/03/${n}.xml`,
  };
}

function plikXml(n: number): Row {
  return { id: `x-${pad(n)}`, tenant_id: T, invoice_id: invoiceId(n), storage_path: `${T}/2026/03/${n}.xml`, sha256_hash: `h-${n}` };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.maxRows = 1000;
  h.zapytania = {};
  h.przedZapytaniem = null;
  h.xml.mockImplementation(async (path: string) => `<Faktura>${path}</Faktura>`);
  h.r2.mockImplementation(async (key: string) => Buffer.from(`<UPO>${key}</UPO>`));
  h.photo.mockImplementation(async () => ({ buffer: Buffer.from('JPEG'), mimeType: 'image/jpeg' }));
  h.pdf.mockImplementation(async (id: string) => ({ success: true, pdf: Buffer.from(`%PDF ${id}`), filename: 'x.pdf', qrStateKey: 'k', missingKodI: false }));
  h.office.mockResolvedValue('1471');
  h.address.mockResolvedValue({ wojewodztwo: 'mazowieckie' });
  h.xsd.mockResolvedValue(undefined);
});

describe('FZ-033: paczka archiwum czyta komplet wierszy albo rzuca', () => {
  it('historia UPO ponad limitem serwera (1302 wiersze dla dwóch faktur): UPO obu faktur jest w paczce', async () => {
    // Nieudane próby pobrania UPO zostają w historii; pobrane UPO drugiej faktury jest na końcu.
    const upo: Row[] = [];
    let u = 0;
    for (const [n, proby] of [[1, 700], [2, 600]] as const) {
      for (let i = 0; i < proby; i++) {
        upo.push({ id: `u-${pad(++u)}`, tenant_id: T, invoice_id: invoiceId(n), status: 'failed', upo_xml_path: null, created_at: '2026-03-10T10:00:00Z' });
      }
    }
    for (const n of [1, 2]) {
      upo.push({ id: `u-${pad(++u)}`, tenant_id: T, invoice_id: invoiceId(n), status: 'downloaded', upo_xml_path: `upo/${T}/${n}.xml`, created_at: '2026-03-11T10:00:00Z' });
    }
    h.tables = {
      tenants: [{ id: T, nip: '1234567890', name: 'Firma Testowa' }],
      invoices: [sprzedaz(1), sprzedaz(2)],
      xml_documents: [plikXml(1), plikXml(2)],
      upo_receipts: upo,
      expenses: [],
    };

    const built = await buildArchivePackage(ORDER, { now: NOW });
    const files = rozpakuj(built.zip);

    expect([...files.keys()].filter((f) => f.endsWith('.upo.xml'))).toHaveLength(2);
    expect(built.missing.filter((m) => m.plik === 'UPO')).toEqual([]);
  });

  it('serwer ucina odpowiedź do 500 wierszy bez błędu: paczka ma wszystkie 700 faktur okresu, nie 500', async () => {
    h.maxRows = 500;
    const n = Array.from({ length: 700 }, (_, i) => i + 1);
    h.tables = {
      tenants: [{ id: T, nip: '1234567890', name: 'Firma Testowa' }],
      invoices: n.map(sprzedaz),
      xml_documents: n.map(plikXml),
      upo_receipts: n.map((i) => ({ id: `u-${pad(i)}`, tenant_id: T, invoice_id: invoiceId(i), status: 'downloaded', upo_xml_path: `upo/${T}/${i}.xml`, created_at: '2026-03-11T10:00:00Z' })),
      expenses: [],
    };

    const built = await buildArchivePackage(ORDER, { now: NOW });
    const files = rozpakuj(built.zip);

    const wiersze = files.get('faktury.csv')!.toString('utf8').trim().split(/\r\n/).slice(1);
    expect(wiersze).toHaveLength(700);
    expect([...files.keys()].filter((f) => f.startsWith('faktury-sprzedazy/') && f.endsWith('.xml') && !f.endsWith('.upo.xml'))).toHaveLength(700);
    expect(built.missing).toEqual([]);
  }, 120_000);

  it('faktura zapisana w trakcie budowania paczki (między stronami odczytu): wyjątek i ponowienie joba, nie paczka z dublem albo brakiem', async () => {
    // Uwaga N3 czytelnika: helper odczytu (licznik i strony po `id`) nie przepuszcza zmiany w trakcie.
    const n = Array.from({ length: 600 }, (_, i) => i + 1);
    h.tables = {
      tenants: [{ id: T, nip: '1234567890', name: 'Firma Testowa' }],
      invoices: n.map(sprzedaz),
      xml_documents: n.map(plikXml),
      upo_receipts: [],
      expenses: [],
    };
    h.przedZapytaniem = (table, ktore) => {
      if (table === 'invoices' && ktore === 2) h.tables.invoices!.push(sprzedaz(9999));
    };

    await expect(buildArchivePackage(ORDER, { now: NOW })).rejects.toThrow(/invoices: (nie można potwierdzić liczby rekordów|niepełna strona danych)/);
  }, 120_000);
});

