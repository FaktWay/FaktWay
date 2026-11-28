import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 1.6, część 2b, PR D (D25 b, D40): oryginał PDF faktury spoza KSeF
 * zostaje przy wpisie, ma okres przechowywania faktury (kasuje go retencja
 * razem z fakturą i usunięcie wpisu) i trafia do archiwum ZIP.
 * Prawdziwe: wyłącznik (odczyt flagi), walidacja pliku, klucz, kolejność
 * kroków. Atrapy granic: magazyn S3, klucz serwisowy, klient sesji, audyt.
 */

const T = 'ten-1';
const ID = '11111111-1111-4111-8111-111111111111';

const st = vi.hoisted(() => ({
  flaga: true as boolean,
  faktura: { data: { id: '11111111-1111-4111-8111-111111111111', internal_number: 'FV/1/2026' } as unknown, error: null as unknown },
  aktualizacja: { data: [{ id: '11111111-1111-4111-8111-111111111111' }] as unknown, error: null as unknown },
  aktualizacje: [] as Array<Record<string, unknown>>,
  magazyn: [] as Array<{ typ: string; klucz: string; typMime?: string; rozmiar?: number }>,
  magazynBlad: null as Error | null,
  audyt: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: (...a: unknown[]) => st.audyt(...a) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    throw new Error('nie w tym teście');
  },
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from(tabela: string) {
      if (tabela === 'global_feature_flags') {
        const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { enabled: st.flaga }, error: null }) };
        return q;
      }
      const q = {
        update: (dane: Record<string, unknown>) => {
          st.aktualizacje.push(dane);
          return q;
        },
        eq: () => q,
        select: async () => st.aktualizacja,
      };
      return q;
    },
  }),
}));
vi.mock('@/lib/storage/r2-client', () => ({
  getR2Config: () => ({ bucketName: 'b' }),
  getR2Client: () => ({
    send: async (cmd: { constructor: { name: string }; input: { Key: string; ContentType?: string; Body?: Buffer } }) => {
      if (st.magazynBlad) throw st.magazynBlad;
      st.magazyn.push({ typ: cmd.constructor.name, klucz: cmd.input.Key, typMime: cmd.input.ContentType, rozmiar: cmd.input.Body?.length });
      return {};
    },
  }),
}));

import {
  dolaczOryginalSpozaKsef,
  kluczOryginaluSpozaKsef,
  usunOryginalSpozaKsef,
} from '@/lib/import/outside-ksef-oryginal';

function klient() {
  const q = {
    select: () => q,
    eq: () => q,
    maybeSingle: async () => st.faktura,
  };
  return { from: () => q } as never;
}

const ctx = () => ({ client: klient(), tenantId: T, userId: 'u1' });
const pdf = (tresc = '%PDF-1.7\nzawartosc') => new File([Buffer.from(tresc)], 'faktura.pdf', { type: 'application/pdf' });

beforeEach(() => {
  st.flaga = true;
  st.faktura = { data: { id: ID, internal_number: 'FV/1/2026' }, error: null };
  st.aktualizacja = { data: [{ id: ID }], error: null };
  st.aktualizacje.length = 0;
  st.magazyn.length = 0;
  st.magazynBlad = null;
  st.audyt.mockReset();
});

describe('klucz oryginału', () => {
  it('leży w katalogu firmy i jest stały dla faktury (ponowienie nadpisuje ten sam obiekt)', () => {
    expect(kluczOryginaluSpozaKsef(T, ID)).toBe(`tenants/${T}/outside-ksef/${ID}.pdf`);
  });
});

describe('dolaczOryginalSpozaKsef', () => {
  it('zapisuje plik w magazynie, wskaźnik z sumą kontrolną w wierszu i audyt', async () => {
    const plik = pdf();
    const w = await dolaczOryginalSpozaKsef(ctx(), ID, plik);
    expect(w).toEqual({ success: true });
    expect(st.magazyn).toEqual([
      { typ: 'PutObjectCommand', klucz: kluczOryginaluSpozaKsef(T, ID), typMime: 'application/pdf', rozmiar: plik.size },
    ]);
    expect(st.aktualizacje[0]).toMatchObject({
      outside_ksef_original_path: kluczOryginaluSpozaKsef(T, ID),
      outside_ksef_original_sha256: createHash('sha256').update(Buffer.from('%PDF-1.7\nzawartosc')).digest('hex'),
      outside_ksef_original_size: plik.size,
    });
    expect(st.audyt).toHaveBeenCalledWith(expect.objectContaining({ action: 'invoice.outside_ksef_original_saved', entityId: ID }));
  });

  it('wyłączony wyłącznik: nic nie trafia do magazynu', async () => {
    st.flaga = false;
    expect(await dolaczOryginalSpozaKsef(ctx(), ID, pdf())).toMatchObject({ success: false, status: 403 });
    expect(st.magazyn).toHaveLength(0);
  });

  it('zły identyfikator, nie-PDF i plik ponad limit: odmowa przed magazynem', async () => {
    expect(await dolaczOryginalSpozaKsef(ctx(), 'x', pdf())).toMatchObject({ success: false, status: 400 });
    const jpg = new File([Buffer.from([0xff, 0xd8, 0xff])], 'a.pdf');
    expect(await dolaczOryginalSpozaKsef(ctx(), ID, jpg)).toMatchObject({ success: false, status: 400 });
    const duzy = new File([Buffer.from('%PDF-'), new Uint8Array(10_000_001)], 'duzy.pdf');
    expect(await dolaczOryginalSpozaKsef(ctx(), ID, duzy)).toMatchObject({ success: false, status: 413 });
    expect(st.magazyn).toHaveLength(0);
  });

  it('faktura cudza albo zwykła (nie spoza KSeF) nie istnieje dla klienta: 404 bez magazynu', async () => {
    st.faktura = { data: null, error: null };
    expect(await dolaczOryginalSpozaKsef(ctx(), ID, pdf())).toMatchObject({ success: false, status: 404 });
    expect(st.magazyn).toHaveLength(0);
  });

  it('błąd zapisu wskaźnika usuwa świeżo wgrany plik (bez sierot) i mówi, co zrobić', async () => {
    st.aktualizacja = { data: null, error: { message: 'x' } };
    const w = await dolaczOryginalSpozaKsef(ctx(), ID, pdf());
    expect(w).toMatchObject({ success: false, status: 500 });
    expect(st.magazyn.map((m) => m.typ)).toEqual(['PutObjectCommand', 'DeleteObjectCommand']);
    expect(st.audyt).not.toHaveBeenCalled();
  });

  it('błąd magazynu: komunikat, wiersz bez zmian', async () => {
    st.magazynBlad = new Error('s3');
    expect(await dolaczOryginalSpozaKsef(ctx(), ID, pdf())).toMatchObject({ success: false, status: 500 });
    expect(st.aktualizacje).toHaveLength(0);
  });

  it('ponowienie po sukcesie to ten sam klucz i ta sama suma: drugi zapis nie rozmnaża plików', async () => {
    await dolaczOryginalSpozaKsef(ctx(), ID, pdf());
    await dolaczOryginalSpozaKsef(ctx(), ID, pdf());
    expect(new Set(st.magazyn.map((m) => m.klucz)).size).toBe(1);
  });
});

describe('usunOryginalSpozaKsef', () => {
  it('usuwa obiekt firmy', async () => {
    expect(await usunOryginalSpozaKsef(T, kluczOryginaluSpozaKsef(T, ID))).toBe(true);
    expect(st.magazyn).toEqual([{ typ: 'DeleteObjectCommand', klucz: kluczOryginaluSpozaKsef(T, ID), typMime: undefined, rozmiar: undefined }]);
  });

  it('klucz spoza katalogu firmy nie jest ruszany', async () => {
    expect(await usunOryginalSpozaKsef(T, 'tenants/inna-firma/outside-ksef/x.pdf')).toBe(false);
    expect(st.magazyn).toHaveLength(0);
  });

  it('błąd magazynu nie rzuca: zwraca false (wywołujący zgłasza do Sentry)', async () => {
    st.magazynBlad = new Error('s3');
    expect(await usunOryginalSpozaKsef(T, kluczOryginaluSpozaKsef(T, ID))).toBe(false);
  });
});
