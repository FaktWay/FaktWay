import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 1.6, część 2b, import CSV z opcją „wlicz do ksiąg” (D18-D25, R1).
 * Prawdziwe: parsery CSV czterech programów, mapowanie, schemat, zapis przez
 * `dodajFakturaSpozaKsef`, odczyt flagi. Atrapy tylko granic: klient sesji,
 * klucz serwisowy (wiersz flagi), audyt, cache.
 */

const T = 'ten-1';
const U = 'user-1';
const NIP = '5260001246';

const st = vi.hoisted(() => ({
  flaga: true as boolean | undefined,
  audyt: vi.fn(),
  nip: '5260001246' as string | null,
  wstawione: [] as Array<{ tabela: string; wiersz: Record<string, unknown> }>,
  numeryWBazie: new Set<string>(),
  licznik: 0,
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: (...a: unknown[]) => st.audyt(...a) }));
vi.mock('@/lib/ksiegowosc/wylacznik', () => ({ czyKsiegowoscWlaczona: async () => ({ wlaczony: true }) }));
vi.mock('@/lib/ksef/claim-environment', () => ({ requireConfiguredKsefEnvironment: () => 'test' }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    throw new Error('nie w tym teście');
  },
  createAdminClient: () => ({
    from() {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: st.flaga === undefined ? null : { enabled: st.flaga }, error: null }),
      };
      return q;
    },
  }),
}));

function klient() {
  return {
    from(tabela: string) {
      let tryb: 'select' | 'insert' | 'delete' = 'select';
      let wstawiony: Record<string, unknown> = {};
      const q: Record<string, unknown> = {
        select: () => q,
        insert: (wiersz: Record<string, unknown>) => {
          tryb = 'insert';
          wstawiony = wiersz;
          return q;
        },
        delete: () => {
          tryb = 'delete';
          return q;
        },
        eq: () => q,
        single: async () => {
          const numer = String(wstawiony.internal_number);
          if (st.numeryWBazie.has(numer)) return { data: null, error: { code: '23505', message: 'duplicate' } };
          st.numeryWBazie.add(numer);
          st.wstawione.push({ tabela, wiersz: wstawiony });
          return { data: { id: `id-${++st.licznik}` }, error: null };
        },
        maybeSingle: async () =>
          tabela === 'tenants'
            ? { data: st.nip === null ? null : { id: T, nip: st.nip, name: 'Moja Firma', address_json: { countryCode: 'PL', addressLine1: 'ul. Prosta 1', addressLine2: '00-001 Warszawa' } }, error: null }
            : { data: null, error: null },
        then: (res: (v: unknown) => unknown) => {
          if (tryb === 'insert') st.wstawione.push({ tabela, wiersz: wstawiony });
          return Promise.resolve({ data: [], error: null }).then(res);
        },
      };
      return q;
    },
  };
}

const ctx = () => ({ client: klient() as never, tenantId: T, userId: U });

const { przygotujCsvSpozaKsef, odmowaSurowegoPliku } = await import('@/lib/import/outside-ksef-csv');
const { wliczCsvDoKsiegSpozaKsef } = await import('@/lib/import/outside-ksef-csv-zapis');
const { SPOZA_KSEF_WYLACZONE } = await import('@/lib/import/outside-ksef-wylacznik');

const NAGL_F = 'Numer;Data wystawienia;Sprzedawca;NIP sprzedawcy;Nabywca;NIP nabywcy;Netto;VAT;Brutto;Stawka VAT';
const fakturownia = (...wiersze: string[]) => [NAGL_F, ...wiersze].join('\n');
const wierszF = (z: Partial<Record<string, string>> = {}) =>
  [
    z.numer ?? 'FV 1/2026',
    z.data ?? '2026-03-10',
    'Moja Firma',
    z.nipSprz ?? NIP,
    'Klient Sp. z o.o.',
    '1234567890',
    z.netto ?? '100,00',
    z.vat ?? '23,00',
    z.brutto ?? '123,00',
    z.stawka ?? '23',
  ].join(';');

const NAGL_I = 'invoice_number,issue_date,net_total,vat_total,gross_total,client_name,client_tax_id';
const infakt = (...w: string[]) => [NAGL_I, ...w].join('\n');

beforeEach(() => {
  st.flaga = true;
  st.audyt.mockReset();
  st.nip = NIP;
  st.wstawione = [];
  st.numeryWBazie = new Set();
  st.licznik = 0;
});

describe('mapowanie CSV na wpisy spoza KSeF', () => {
  it('Fakturownia, jedna pozycja 23%: wpis z kwotami z pliku', () => {
    const p = przygotujCsvSpozaKsef(fakturownia(wierszF()), 'fakturownia', NIP);
    expect(p.odrzucone).toEqual([]);
    expect(p.wpisy).toHaveLength(1);
    expect(p.wpisy[0]).toMatchObject({
      number: 'FV 1/2026',
      issueDate: '2026-03-10',
      buyerNip: '1234567890',
      currency: 'PLN',
      lines: [{ netAmount: 100, vatRate: '23', vatAmount: 23, grossAmount: 123 }],
    });
  });

  it('inFakt, stawka wyliczona z sum (8%): wpis z 8%', () => {
    const p = przygotujCsvSpozaKsef(infakt('FV/2/2026,2026-04-02,200.00,16.00,216.00,Klient,1234567890'), 'infakt', NIP);
    expect(p.odrzucone).toEqual([]);
    expect(p.wpisy[0]?.lines[0]).toMatchObject({ vatRate: '8', vatAmount: 16, grossAmount: 216 });
  });

  it('VAT 0,00: odmowa, bo plik nie rozróżnia 0, „zw” i „np”', () => {
    const p = przygotujCsvSpozaKsef(fakturownia(wierszF({ vat: '0,00', brutto: '100,00', stawka: '0' })), 'fakturownia', NIP);
    expect(p.wpisy).toEqual([]);
    expect(p.odrzucone[0]?.powod).toContain('zw');
  });

  it('stawka 22: odmowa (domyślna stawka parsera nie wchodzi do ksiąg)', () => {
    const p = przygotujCsvSpozaKsef(fakturownia(wierszF({ vat: '22,00', brutto: '122,00', stawka: '22' })), 'fakturownia', NIP);
    expect(p.wpisy).toEqual([]);
    expect(p.odrzucone[0]?.powod).toContain('23, 8 ani 5');
  });

  it('VAT niezgodny ze stawką z pliku: odmowa', () => {
    const p = przygotujCsvSpozaKsef(fakturownia(wierszF({ vat: '8,00', brutto: '108,00', stawka: '23' })), 'fakturownia', NIP);
    expect(p.wpisy).toEqual([]);
    expect(p.odrzucone[0]?.powod).toContain('stawk');
  });

  it('brutto różne od netto plus VAT: odmowa', () => {
    const p = przygotujCsvSpozaKsef(fakturownia(wierszF({ brutto: '130,00' })), 'fakturownia', NIP);
    expect(p.wpisy).toEqual([]);
    expect(p.odrzucone[0]?.powod).toContain('Brutto');
  });

  it('data spoza 2026 (D21): odmowa, nie wpis', () => {
    const p = przygotujCsvSpozaKsef(fakturownia(wierszF({ data: '2025-12-30' })), 'fakturownia', NIP);
    expect(p.wpisy).toEqual([]);
    expect(p.odrzucone[0]?.powod).toContain('2026');
  });

  it('nierozpoznana data (parser podstawia dzisiejszą): odmowa, nie cicha zmiana daty', () => {
    const p = przygotujCsvSpozaKsef(fakturownia(wierszF({ data: 'jutro' })), 'fakturownia', NIP);
    expect(p.wpisy).toEqual([]);
    expect(p.odrzucone[0]?.powod).toContain('wątpliwość');
  });

  it('kwota z symbolem obcej waluty: odmowa (D22 waluta)', () => {
    const p = przygotujCsvSpozaKsef(fakturownia(wierszF({ netto: '100,00 EUR', brutto: '123,00 EUR', vat: '23,00 EUR' })), 'fakturownia', NIP);
    expect(p.wpisy).toEqual([]);
    expect(p.odrzucone[0]?.powod).toContain('EUR');
  });

  it('sprzedawca z innym NIP niż firma: odmowa, nie wchodzi do ksiąg tej firmy', () => {
    const p = przygotujCsvSpozaKsef(fakturownia(wierszF({ nipSprz: '1234567890' })), 'fakturownia', NIP);
    expect(p.wpisy).toEqual([]);
    expect(p.odrzucone[0]?.powod).toContain('inna firma');
  });

  it('numer korekty: odmowa z komunikatem D22', () => {
    const p = przygotujCsvSpozaKsef(fakturownia(wierszF({ numer: 'KOR 1/2026' })), 'fakturownia', NIP);
    expect(p.wpisy).toEqual([]);
    expect(p.odrzucone[0]?.powod).toContain('nie ujmie w księgach');
  });

  it('dobra i zła faktura w jednym pliku: dobra wchodzi, zła ma powód', () => {
    const p = przygotujCsvSpozaKsef(fakturownia(wierszF(), wierszF({ numer: 'FV 2/2026', data: '2025-01-01' })), 'fakturownia', NIP);
    expect(p.wpisy.map((w) => w.number)).toEqual(['FV 1/2026']);
    expect(p.odrzucone.map((o) => o.numer)).toEqual(['FV 2/2026']);
  });

  it('kolumna Waluta z EUR odrzuca cały plik, nawet bez symbolu przy kwocie', () => {
    const csv = 'Numer;Data wystawienia;Waluta;Netto;VAT;Brutto\nFV 1/2026;2026-03-10;EUR;100,00;23,00;123,00';
    expect(odmowaSurowegoPliku(csv)).toContain('innej walucie');
    expect(przygotujCsvSpozaKsef(csv, 'fakturownia', NIP).wpisy).toEqual([]);
  });

  it('kolumna Rodzaj z korektą odrzuca cały plik; „Faktura VAT” nie', () => {
    expect(odmowaSurowegoPliku('Numer;Rodzaj\nFV 1;Faktura korygująca')).toContain('korekty');
    expect(odmowaSurowegoPliku('Numer;Rodzaj\nFV 1;Faktura VAT')).toBeNull();
    expect(odmowaSurowegoPliku('Numer;Waluta\nFV 1;PLN')).toBeNull();
  });
});

describe('wliczenie CSV do ksiąg (zapis)', () => {
  const wejscie = () => ({ content: fakturownia(wierszF(), wierszF({ numer: 'FV 2/2026', data: '2025-01-01' })), source: 'fakturownia' as const });

  it('wyłącznik wyłączony: nic się nie zapisuje, komunikat z wyjściem', async () => {
    st.flaga = undefined;
    const w = await wliczCsvDoKsiegSpozaKsef(ctx(), wejscie(), { potwierdzam: true });
    expect(w).toEqual({ success: false, error: SPOZA_KSEF_WYLACZONE });
    expect(st.wstawione).toEqual([]);
  });

  it('bez potwierdzenia: tylko podgląd, zero zapisów i audytu', async () => {
    const w = await wliczCsvDoKsiegSpozaKsef(ctx(), wejscie());
    expect(w).toMatchObject({ success: true, wliczone: 1, zapisano: false });
    expect(w.success && w.odrzucone).toHaveLength(1);
    expect(st.wstawione).toEqual([]);
    expect(st.audyt).not.toHaveBeenCalled();
  });

  it('z potwierdzeniem: zapis jako outside_ksef w środowisku firmy, audyt zbiorczy', async () => {
    const w = await wliczCsvDoKsiegSpozaKsef(ctx(), wejscie(), { potwierdzam: true });
    expect(w).toMatchObject({ success: true, wliczone: 1, zapisano: true });
    const naglowek = st.wstawione.find((x) => x.tabela === 'invoices')?.wiersz;
    expect(naglowek).toMatchObject({ origin: 'outside_ksef', ksef_status: 'accepted', ksef_environment: 'test', ksef_number: null, internal_number: 'FV 1/2026', gross_total: 123 });
    expect(st.audyt).toHaveBeenCalledWith(expect.objectContaining({ action: 'invoice.outside_ksef_csv_imported', metadata: expect.objectContaining({ included: 1, notIncluded: 1 }) }));
  });

  it('ponowienie tego samego pliku: nic się nie dubluje, numer jest już w historii', async () => {
    await wliczCsvDoKsiegSpozaKsef(ctx(), wejscie(), { potwierdzam: true });
    const drugi = await wliczCsvDoKsiegSpozaKsef(ctx(), wejscie(), { potwierdzam: true });
    expect(drugi).toMatchObject({ success: true, wliczone: 0 });
    expect(st.wstawione.filter((x) => x.tabela === 'invoices')).toHaveLength(1);
    expect(drugi.success && drugi.odrzucone.some((o) => o.powod.includes('jest już w historii'))).toBe(true);
  });

  it('firma bez NIP: odmowa z wyjściem, bez zapisu', async () => {
    st.nip = '';
    const w = await wliczCsvDoKsiegSpozaKsef(ctx(), wejscie(), { potwierdzam: true });
    expect(w).toMatchObject({ success: false });
    expect(st.wstawione).toEqual([]);
  });

  it('plik z walutą: odmowa całego pliku, bez zapisu', async () => {
    const w = await wliczCsvDoKsiegSpozaKsef(ctx(), { content: 'Numer;Data wystawienia;Waluta;Netto;VAT;Brutto\nFV 1/2026;2026-03-10;USD;100,00;23,00;123,00', source: 'fakturownia' }, { potwierdzam: true });
    expect(w).toMatchObject({ success: false });
    expect(st.wstawione).toEqual([]);
  });
});

describe('wiele pozycji', () => {
  const nagl = 'Numer;Data wystawienia;Sprzedawca;NIP sprzedawcy;Nabywca;NIP nabywcy;Netto;VAT;Brutto;Stawka VAT;Pozycje';
  const poz = (a: string) => `"${a.replace(/"/g, '""')}"`;
  const wiersz = (vat: string, brutto: string, pozycje: string) =>
    ['FV 7/2026', '2026-05-05', 'Moja Firma', NIP, 'Klient', '1234567890', '300,00', vat, brutto, '23', poz(pozycje)].join(';');

  it('stawki pozycji dają dokładnie VAT z pliku: wpis z dwiema stawkami', () => {
    const json = JSON.stringify([
      { name: 'A', quantity: 1, price_net: 100, total_price_net: 100, vat: '23' },
      { name: 'B', quantity: 1, price_net: 200, total_price_net: 200, vat: '8' },
    ]);
    const p = przygotujCsvSpozaKsef([nagl, wiersz('39,00', '339,00', json)].join('\n'), 'fakturownia', NIP);
    expect(p.odrzucone).toEqual([]);
    expect(p.wpisy[0]?.lines.map((l) => [l.vatRate, l.vatAmount])).toEqual([['23', 23], ['8', 16]]);
  });

  it('VAT z pliku nie zgadza się ze stawkami pozycji: odmowa', () => {
    const json = JSON.stringify([
      { name: 'A', quantity: 1, price_net: 100, total_price_net: 100, vat: '23' },
      { name: 'B', quantity: 1, price_net: 200, total_price_net: 200, vat: '23' },
    ]);
    const p = przygotujCsvSpozaKsef([nagl, wiersz('39,00', '339,00', json)].join('\n'), 'fakturownia', NIP);
    expect(p.wpisy).toEqual([]);
    expect(p.odrzucone[0]?.powod).toContain('stawkami pozycji');
  });
});
