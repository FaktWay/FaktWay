import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wyłącznik faktury w cenach brutto (`lib/invoices/ceny-brutto-wylacznik.ts`):
 * flaga `grossPricesEnabled` w `global_feature_flags`, domyślnie wyłączona
 * (brak wiersza), czytana wprost z bazy przy każdej fakturze w cenach brutto.
 * Atrapa tylko bazy (klucz serwisowy, tabela flag). Drogi wystawienia sprawdzają
 * `ceny-brutto-wylacznik-zapis`, `-kolejka` i `-job`.
 */

const st = vi.hoisted(() => ({
  flaga: undefined as boolean | undefined | 'blad' | 'zly-typ',
  odczyty: 0,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    throw new Error('wyłącznik czyta kluczem serwisowym');
  },
  createAdminClient: () => ({
    from(table: string) {
      const filtry: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq: (kolumna: string, wartosc: unknown) => {
          filtry[kolumna] = wartosc;
          return q;
        },
        maybeSingle: async () => {
          if (table !== 'global_feature_flags' || filtry.flag !== 'grossPricesEnabled') throw new Error('zły odczyt');
          st.odczyty += 1;
          if (st.flaga === 'blad') return { data: null, error: { message: 'connection refused' } };
          if (st.flaga === 'zly-typ') return { data: { enabled: 'true' }, error: null };
          return { data: st.flaga === undefined ? null : { enabled: st.flaga }, error: null };
        },
      };
      return q;
    },
  }),
}));

import {
  CENY_BRUTTO_PODKLAD,
  CENY_BRUTTO_WYLACZONE,
  cenyBruttoDostepne,
  czyCenyBruttoWlaczone,
  czyFakturaWCenachBrutto,
  FLAGA_CEN_BRUTTO,
  odmowaCenBrutto,
  tekstOdmowyCenBrutto,
  type EtapOdmowyCenBrutto,
} from '@/lib/invoices/ceny-brutto-wylacznik';
import { GLOBAL_FLAGS } from '@/lib/feature-flags/global-flags';

beforeEach(() => {
  st.flaga = undefined;
  st.odczyty = 0;
});

describe('flaga', () => {
  it('to globalna flaga grossPricesEnabled na liście flag (włącznik, nie hamulec)', () => {
    expect(FLAGA_CEN_BRUTTO).toBe('grossPricesEnabled');
    expect(GLOBAL_FLAGS).toContain('grossPricesEnabled');
  });

  it('brak wiersza i false: wyłączony; true: włączony', async () => {
    await expect(czyCenyBruttoWlaczone()).resolves.toBe(false);
    st.flaga = false;
    await expect(czyCenyBruttoWlaczone()).resolves.toBe(false);
    st.flaga = true;
    await expect(czyCenyBruttoWlaczone()).resolves.toBe(true);
  });

  it('odczyt rozstrzygający: błąd bazy albo zły typ rzuca („nie wiem” to nie „tak”), bez pamięci podręcznej', async () => {
    st.flaga = 'blad';
    await expect(czyCenyBruttoWlaczone()).rejects.toThrow();
    st.flaga = 'zly-typ';
    await expect(czyCenyBruttoWlaczone()).rejects.toThrow();
    st.flaga = true;
    st.odczyty = 0;
    await czyCenyBruttoWlaczone();
    await czyCenyBruttoWlaczone();
    expect(st.odczyty).toBe(2);
  });

  it('dla formularza i podkładu (b): błąd odczytu = niedostępne, nigdy wyjątek', async () => {
    st.flaga = 'blad';
    await expect(cenyBruttoDostepne()).resolves.toBe(false);
    st.flaga = true;
    await expect(cenyBruttoDostepne()).resolves.toBe(true);
  });
});

describe('czy dokument jest fakturą w cenach brutto', () => {
  it('tylko pricesGross === true; napis, liczba, brak i null to faktura w cenach netto (tak czytają ją generator i bramka wysyłki)', () => {
    expect(czyFakturaWCenachBrutto({ pricesGross: true })).toBe(true);
    for (const inny of [{ pricesGross: 'true' }, { pricesGross: 1 }, { pricesGross: false }, {}, null, undefined, 'x', []]) {
      expect(czyFakturaWCenachBrutto(inny)).toBe(false);
    }
  });
});

describe('odmowa', () => {
  const ETAPY: EtapOdmowyCenBrutto[] = ['zapis', 'wysylka', 'ponowienie'];

  it('faktura w cenach netto: brak odmowy i brak odczytu flagi', async () => {
    for (const etap of ETAPY) await expect(odmowaCenBrutto(etap, { pricesGross: undefined }, {})).resolves.toBeNull();
    expect(st.odczyty).toBe(0);
  });

  it('wyłączony: tekst z wyjściem dla każdego etapu, z kodem do dziennika prób', async () => {
    for (const etap of ETAPY) {
      await expect(odmowaCenBrutto(etap, { pricesGross: true })).resolves.toEqual({ powod: 'wylaczone', tekst: tekstOdmowyCenBrutto(etap, 'wylaczone') });
    }
  });

  it('włączony: brak odmowy; kilka dokumentów (wartości formularza i faktura) to jeden odczyt', async () => {
    st.flaga = true;
    await expect(odmowaCenBrutto('zapis', { pricesGross: true }, { pricesGross: true })).resolves.toBeNull();
    expect(st.odczyty).toBe(1);
  });

  it('błąd odczytu: odmowa „spróbuj ponownie”', async () => {
    st.flaga = 'blad';
    await expect(odmowaCenBrutto('wysylka', { pricesGross: true })).resolves.toEqual({ powod: 'nieznany', tekst: tekstOdmowyCenBrutto('wysylka', 'nieznany') });
  });

  it('teksty: FaktWay, wyjście w cenach netto, bez długich myślników i bez słów z listy NZ-TRESC-01', () => {
    const teksty = [
      CENY_BRUTTO_WYLACZONE,
      CENY_BRUTTO_PODKLAD,
      ...ETAPY.flatMap((etap) => [tekstOdmowyCenBrutto(etap, 'wylaczone'), tekstOdmowyCenBrutto(etap, 'nieznany')]),
    ];
    const zakazane = /(?<![\p{L}])(?:zapłać\p{L}*|musisz|musicie|powinieneś|powinnaś|powinniście|należy|zalecamy|radzimy|wybierz\p{L}*|opłaca się|lepiej|najkorzystniej\p{L}*|oszczędzisz|zaoszczędzisz)(?![\p{L}])/iu;
    for (const tekst of teksty) {
      expect(tekst).toContain('FaktWay');
      expect(tekst).not.toMatch(/[—–]/);
      expect(tekst).not.toMatch(zakazane);
      expect(tekst).not.toMatch(/FaktFlow/);
    }
    for (const etap of ETAPY) expect(tekstOdmowyCenBrutto(etap, 'wylaczone')).toMatch(/Wystaw fakturę (od nowa )?w cenach netto/);
    expect(CENY_BRUTTO_WYLACZONE).toMatch(/Wystaw fakturę od nowa w cenach netto\.$/);
  });
});
