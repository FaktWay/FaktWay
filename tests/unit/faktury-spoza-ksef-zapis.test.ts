import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 1.6, część 2b, PR B (D19-D23, D48): zapis i usunięcie faktury
 * wystawionej poza KSeF, za wyłącznikiem `outsideKsefImportEnabled`.
 * Prawdziwe: schemat, budowanie wiersza, akcje zapisu i usunięcia, odczyt
 * flagi (`getGlobalFlagForExecution`). Atrapy tylko granic: klient sesji
 * (tabele z zapisem wywołań), klucz serwisowy (wiersz flagi), audyt, cache.
 */

const T = 'ten-1';
const U = 'user-1';
const ID = '11111111-1111-4111-8111-111111111111';

const st = vi.hoisted(() => ({
  flaga: undefined as boolean | undefined | 'blad',
  audyt: vi.fn(),
  tenant: { id: 'ten-1', nip: '5260001246', name: 'Moja Firma', address_json: { countryCode: 'PL', addressLine1: 'ul. Prosta 1', addressLine2: '00-001 Warszawa' } } as Record<string, unknown> | null,
  insertFaktury: { data: { id: '11111111-1111-4111-8111-111111111111' } as unknown, error: null as { code?: string; message?: string } | null },
  insertPozycji: { error: null as { code?: string; message?: string } | null },
  wstawione: [] as Array<{ tabela: string; wiersz: unknown }>,
  usuniete: [] as Array<{ tabela: string; filtry: Record<string, unknown> }>,
  wiersz: null as Record<string, unknown> | null,
  jpk: [] as Array<{ okres: string }>,
  rozliczenia: [] as Array<{ okres: string }>,
  ksiegowosc: true,
  usuwanieWynik: [{ id: '11111111-1111-4111-8111-111111111111' }] as Array<{ id: string }>,
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: (...a: unknown[]) => st.audyt(...a) }));
vi.mock('@/lib/ksiegowosc/wylacznik', () => ({ czyKsiegowoscWlaczona: async () => ({ wlaczony: st.ksiegowosc }) }));
vi.mock('@/lib/ksef/claim-environment', () => ({ requireConfiguredKsefEnvironment: () => 'test' }));
// PR D (D40): oryginał PDF znika razem z wpisem. Atrapa tylko magazynu; zachowanie pliku: faktury-spoza-ksef-pdf-oryginal.test.ts.
const oryginal = vi.hoisted(() => ({ usun: vi.fn(async (_t: string, _k: string) => true) }));
vi.mock('@/lib/import/outside-ksef-oryginal', () => ({ usunOryginalSpozaKsef: oryginal.usun }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    throw new Error('nie w tym teście');
  },
  createAdminClient: () => ({
    from(table: string) {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => {
          if (table !== 'global_feature_flags') throw new Error('zły odczyt');
          if (st.flaga === 'blad') return { data: null, error: { message: 'x' } };
          return { data: st.flaga === undefined ? null : { enabled: st.flaga }, error: null };
        },
      };
      return q;
    },
  }),
}));

function klient() {
  return {
    from(tabela: string) {
      const filtry: Record<string, unknown> = {};
      let tryb: 'select' | 'insert' | 'delete' = 'select';
      const q: Record<string, unknown> = {
        select: () => q,
        insert: (wiersz: unknown) => {
          tryb = 'insert';
          st.wstawione.push({ tabela, wiersz });
          return q;
        },
        delete: () => {
          tryb = 'delete';
          return q;
        },
        eq: (k: string, v: unknown) => {
          filtry[k] = v;
          return q;
        },
        in: () => q,
        single: async () => (tabela === 'invoices' ? st.insertFaktury : { data: null, error: null }),
        maybeSingle: async () => {
          if (tabela === 'tenants') return { data: st.tenant, error: null };
          if (tabela === 'invoices') return { data: st.wiersz, error: null };
          return { data: null, error: null };
        },
        then: (res: (v: unknown) => unknown) => {
          if (tryb === 'delete') {
            st.usuniete.push({ tabela, filtry });
            return Promise.resolve({ data: tabela === 'invoices' ? st.usuwanieWynik : [], error: null }).then(res);
          }
          if (tryb === 'insert') return Promise.resolve(tabela === 'invoice_line_items' ? st.insertPozycji : { error: null }).then(res);
          const dane = tabela === 'jpk_submissions' ? st.jpk : tabela === 'tax_settlements' ? st.rozliczenia : [];
          return Promise.resolve({ data: dane, error: null }).then(res);
        },
      };
      return q;
    },
  };
}

const ctx = () => ({ client: klient() as never, tenantId: T, userId: U });

const wpis = (z: Record<string, unknown> = {}) => ({
  number: 'FV/12/2026',
  issueDate: '2026-03-10',
  buyerName: 'Klient Sp. z o.o.',
  buyerNip: '1234567890',
  currency: 'PLN',
  lines: [{ name: 'Usługa', netAmount: 100, vatRate: '23', vatAmount: 23, grossAmount: 123 }],
  ...z,
});

const { dodajFakturaSpozaKsef, usunFakturaSpozaKsef } = await import('@/lib/import/outside-ksef-zapis');
const { SPOZA_KSEF_WYLACZONE, SPOZA_KSEF_NIEZNANE } = await import('@/lib/import/outside-ksef-wylacznik');
const { outsideKsefCorrectionRefusal } = await import('@/lib/import/outside-ksef-schema');

beforeEach(() => {
  st.flaga = true;
  st.audyt.mockReset();
  st.wstawione = [];
  st.usuniete = [];
  st.tenant = { id: T, nip: '5260001246', name: 'Moja Firma', address_json: { countryCode: 'PL', addressLine1: 'ul. Prosta 1', addressLine2: '00-001 Warszawa' } };
  st.insertFaktury = { data: { id: ID }, error: null };
  st.insertPozycji = { error: null };
  st.wiersz = { id: ID, internal_number: 'FV/12/2026', issue_date: '2026-03-10', sale_date: null, net_total: 100, vat_total: 23, gross_total: 123 };
  st.jpk = [];
  st.rozliczenia = [];
  st.ksiegowosc = true;
  st.usuwanieWynik = [{ id: ID }];
});

describe('dodanie faktury spoza KSeF', () => {
  it('wyłącznik wyłączony (brak wiersza): nic się nie zapisuje, komunikat z wyjściem', async () => {
    st.flaga = undefined;
    const w = await dodajFakturaSpozaKsef(ctx(), wpis());
    expect(w).toEqual({ success: false, error: SPOZA_KSEF_WYLACZONE });
    expect(st.wstawione).toEqual([]);
  });

  it('błąd odczytu wyłącznika to „nie wiem”, a nie „tak”', async () => {
    st.flaga = 'blad';
    const w = await dodajFakturaSpozaKsef(ctx(), wpis());
    expect(w).toEqual({ success: false, error: SPOZA_KSEF_NIEZNANE });
    expect(st.wstawione).toEqual([]);
  });

  it('odmowa rodzaju dokumentu (D22) pada przed wyłącznikiem i zapisem', async () => {
    for (const rodzaj of ['korekta', 'zaliczka', 'faktura_do_paragonu', 'procedura_marzy']) {
      const w = await dodajFakturaSpozaKsef(ctx(), wpis(), rodzaj);
      expect(w).toMatchObject({ success: false, error: 'Tej faktury FaktWay nie ujmie w księgach; ujmuje się ją w księgach poza FaktWay.' });
    }
    expect(st.wstawione).toEqual([]);
  });

  it('schemat: data z 2025 r. i waluta obca są odrzucone przed zapisem', async () => {
    expect(await dodajFakturaSpozaKsef(ctx(), wpis({ issueDate: '2025-12-31' }))).toMatchObject({ success: false, pole: 'issueDate' });
    expect(await dodajFakturaSpozaKsef(ctx(), wpis({ currency: 'EUR' }))).toMatchObject({ success: false });
    expect(st.wstawione).toEqual([]);
  });

  it('zapis: wiersz ma kształt z 00221, bez numeru KSeF i XML, a audyt rejestruje wpis', async () => {
    const w = await dodajFakturaSpozaKsef(ctx(), wpis({ saleDate: '2026-02-28' }));
    expect(w).toEqual({ success: true, id: ID });
    const naglowek = st.wstawione.find((x) => x.tabela === 'invoices')!.wiersz as Record<string, unknown>;
    expect(naglowek).toMatchObject({
      tenant_id: T,
      direction: 'outgoing',
      origin: 'outside_ksef',
      internal_number: 'FV/12/2026',
      ksef_status: 'accepted',
      ksef_environment: 'test',
      ksef_number: null,
      invoice_kind: 'regular',
      issue_date: '2026-03-10',
      sale_date: '2026-02-28',
      seller_nip: '5260001246',
      buyer_nip: '1234567890',
      is_b2c: false,
      buyer_id_type: 'nip',
      currency: 'PLN',
      net_total: 100,
      vat_total: 23,
      gross_total: 123,
    });
    expect(naglowek).not.toHaveProperty('xml_storage_path');
    expect(naglowek).not.toHaveProperty('submitted_to_ksef_at');
    const pozycje = st.wstawione.find((x) => x.tabela === 'invoice_line_items')!.wiersz as Array<Record<string, unknown>>;
    expect(pozycje).toHaveLength(1);
    expect(pozycje[0]).toMatchObject({ invoice_id: ID, ordinal: 1, name: 'Usługa', net_amount: 100, vat_rate: '23', vat_amount: 23, gross_amount: 123 });
    expect(st.audyt).toHaveBeenCalledWith(expect.objectContaining({ action: 'invoice.outside_ksef_created', tenantId: T, userId: U, entityId: ID }));
  });

  it('GTU i TP z pozycji trafiają do dokumentu faktury (zmieniają tylko wiersz w JPK_V7M)', async () => {
    await dodajFakturaSpozaKsef(ctx(), wpis({ lines: [{ name: 'Telefon', netAmount: 100, vatRate: '23', vatAmount: 23, grossAmount: 123, gtuCode: 'GTU_06', tp: true }] }));
    const naglowek = st.wstawione.find((x) => x.tabela === 'invoices')!.wiersz as { fa3_data: { lines: Array<{ gtuCode?: string }>; ksefMarkers?: { tp?: boolean; gtu?: string[] } } };
    expect(naglowek.fa3_data.lines[0]!.gtuCode).toBe('GTU_06');
    expect(naglowek.fa3_data.ksefMarkers).toEqual({ tp: true, gtu: ['GTU_06'] });
  });

  it('nabywca bez NIP to konsument bez identyfikatora', async () => {
    await dodajFakturaSpozaKsef(ctx(), wpis({ buyerNip: undefined }));
    const naglowek = st.wstawione.find((x) => x.tabela === 'invoices')!.wiersz as Record<string, unknown>;
    expect(naglowek).toMatchObject({ is_b2c: true, buyer_id_type: 'no_id', buyer_nip: null });
  });

  it('firma bez adresu: odmowa z wyjściem, bez zapisu', async () => {
    st.tenant = { id: T, nip: '5260001246', name: 'Moja Firma', address_json: null };
    const w = await dodajFakturaSpozaKsef(ctx(), wpis());
    expect(w).toMatchObject({ success: false, error: expect.stringContaining('Uzupełnij dane firmy') });
    expect(st.wstawione).toEqual([]);
  });

  it('ten sam numer drugi raz (23505): komunikat, nie drugi wpis', async () => {
    st.insertFaktury = { data: null, error: { code: '23505', message: 'duplicate key' } };
    const w = await dodajFakturaSpozaKsef(ctx(), wpis());
    expect(w).toMatchObject({ success: false, error: expect.stringContaining('o tym numerze jest już w historii') });
    expect(st.wstawione.some((x) => x.tabela === 'invoice_line_items')).toBe(false);
    expect(st.audyt).not.toHaveBeenCalled();
  });

  it('błąd zapisu pozycji usuwa nagłówek (bez sierot) i nie audytuje', async () => {
    st.insertPozycji = { error: { message: 'x' } };
    const w = await dodajFakturaSpozaKsef(ctx(), wpis());
    expect(w).toMatchObject({ success: false });
    expect(st.usuniete).toEqual([{ tabela: 'invoices', filtry: { id: ID, tenant_id: T } }]);
    expect(st.audyt).not.toHaveBeenCalled();
  });
});

describe('usunięcie faktury spoza KSeF (D23)', () => {
  it('bez śladu w JPK i rozliczeniach: usuwa od razu, z audytem', async () => {
    const w = await usunFakturaSpozaKsef(ctx(), ID);
    expect(w).toEqual({ success: true });
    expect(st.usuniete[0]).toEqual({ tabela: 'invoices', filtry: { id: ID, tenant_id: T, origin: 'outside_ksef' } });
    expect(st.audyt).toHaveBeenCalledWith(expect.objectContaining({ action: 'invoice.outside_ksef_deleted', entityId: ID, metadata: expect.objectContaining({ number: 'FV/12/2026', monthsNeedingCorrection: [] }) }));
  });

  it('miesiąc z wysłanym JPK_V7M: ostrzeżenie z nazwą miesiąca, bez usunięcia; po potwierdzeniu usuwa', async () => {
    st.jpk = [{ okres: '2026-03-01' }];
    const bez = await usunFakturaSpozaKsef(ctx(), ID);
    expect(bez).toMatchObject({ success: false, wymagaPotwierdzenia: true, miesiace: ['2026-03'] });
    expect((bez as { error: string }).error).toContain('marzec 2026');
    expect((bez as { error: string }).error).toContain('JPK_V7M');
    expect(st.usuniete).toEqual([]);

    const z = await usunFakturaSpozaKsef(ctx(), ID, { potwierdzam: true });
    expect(z).toEqual({ success: true });
    expect(st.audyt).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ monthsNeedingCorrection: ['2026-03'] }) }));
  });

  it('moduł księgowości wyłączony dla firmy: brak plików i rozliczeń do pokazania, usuwa bez ostrzeżenia', async () => {
    st.ksiegowosc = false;
    st.jpk = [{ okres: '2026-03-01' }];
    expect(await usunFakturaSpozaKsef(ctx(), ID)).toEqual({ success: true });
  });

  it('zatwierdzone rozliczenie miesiąca sprzedaży też wymaga potwierdzenia', async () => {
    st.wiersz = { ...st.wiersz, issue_date: '2026-04-02', sale_date: '2026-03-30' };
    st.rozliczenia = [{ okres: '2026-03-01' }];
    const w = await usunFakturaSpozaKsef(ctx(), ID);
    expect(w).toMatchObject({ success: false, wymagaPotwierdzenia: true, miesiace: ['2026-03'] });
  });

  it('wyłącznik wyłączony: nic nie usuwa', async () => {
    st.flaga = false;
    expect(await usunFakturaSpozaKsef(ctx(), ID)).toEqual({ success: false, error: SPOZA_KSEF_WYLACZONE });
    expect(st.usuniete).toEqual([]);
  });

  it('wpisu nie ma albo to nie wpis spoza KSeF: komunikat, bez audytu', async () => {
    st.wiersz = null;
    expect(await usunFakturaSpozaKsef(ctx(), ID)).toEqual({ success: false, error: 'Tej faktury już nie ma w historii.' });
    expect(st.audyt).not.toHaveBeenCalled();
  });

  it('usuwanie, które nic nie usunęło (0 wierszy), nie udaje sukcesu i nie audytuje', async () => {
    st.usuwanieWynik = [];
    const w = await usunFakturaSpozaKsef(ctx(), ID);
    expect(w).toMatchObject({ success: false });
    expect(st.audyt).not.toHaveBeenCalled();
  });
});

describe('usunięcie wpisu z oryginałem PDF (D40)', () => {
  const KLUCZ = `tenants/${T}/outside-ksef/${ID}.pdf`;

  it('po usunięciu wiersza kasuje też plik oryginału i zapisuje to w audycie', async () => {
    oryginal.usun.mockClear();
    st.wiersz = { ...(st.wiersz as Record<string, unknown>), outside_ksef_original_path: KLUCZ };
    expect(await usunFakturaSpozaKsef(ctx(), ID)).toEqual({ success: true });
    expect(oryginal.usun).toHaveBeenCalledWith(T, KLUCZ);
    expect(st.audyt).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ originalDeleted: true }) }));
  });

  it('wpis bez oryginału nie dotyka magazynu', async () => {
    oryginal.usun.mockClear();
    expect(await usunFakturaSpozaKsef(ctx(), ID)).toEqual({ success: true });
    expect(oryginal.usun).not.toHaveBeenCalled();
  });

  it('nieudane kasowanie pliku nie cofa usunięcia wpisu (D23 usuwa zawsze), ale audyt to pokazuje', async () => {
    oryginal.usun.mockResolvedValueOnce(false);
    st.wiersz = { ...(st.wiersz as Record<string, unknown>), outside_ksef_original_path: KLUCZ };
    expect(await usunFakturaSpozaKsef(ctx(), ID)).toEqual({ success: true });
    expect(st.audyt).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ originalDeleted: false, originalPath: KLUCZ }) }));
  });
});

describe('korekta do faktury spoza KSeF (D22, D48)', () => {
  it('odmowa nazywa fakturę i podaje wyjście przez Aplikację Podatnika KSeF', () => {
    const t = outsideKsefCorrectionRefusal('FV/12/2026');
    expect(t).toContain('FV/12/2026');
    expect(t).toContain('Aplikacji Podatnika KSeF');
    expect(t).toContain('usuń wpis i dodaj go od nowa');
  });
});
