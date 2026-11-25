import { beforeEach, describe, expect, it, vi } from 'vitest';

import { zbudujEwidencje, type FakturaEwidencji } from '@/lib/ksiegowosc/ewidencja';
import { zbudujKpir, type KosztKpir } from '@/lib/ksiegowosc/kpir';
import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';

/**
 * JPK-01 (nocny zespół, 25.11.2026): pliki JPK_EWP i JPK_PKPIR z modułu
 * księgowości (`lib/ksiegowosc/ewidencja-pliki.ts`, akcje strony i telefon).
 * Błąd odczytu NIP-u albo urzędu skarbowego firmy to błąd odczytu: klient nie
 * ma czego poprawiać w Ustawieniach, a operator dostaje alarm w Sentry. Tak
 * jak F11-A4 przy JPK_V7M (`tests/unit/ksiegowosc-vat-plik-trwale-stany.test.ts`).
 * Prawdziwy brak (pusty NIP, urząd nieustawiony) zostaje komunikatem
 * o Ustawieniach. Niezmiennik: oba pliki × każdy zepsuty odczyt.
 *
 * Atrapy tylko dla bazy, sesji, wyłącznika, odczytu ksiąg, urzędu, audytu
 * i Sentry; walidacja wejścia, braki okresu, generator, XSD i strażnik pliku
 * są prawdziwe.
 */

const mocks = vi.hoisted(() => ({
  firma: { data: { nip: '1234567890' }, error: null } as { data: unknown; error: unknown },
  urzad: 'ok' as 'ok' | 'brak' | 'blad',
  ewidencja: null as unknown,
  kpir: null as unknown,
  zapytania: [] as unknown[][],
  audit: vi.fn(),
  sentryWyjatek: vi.fn(),
  sentryKomunikat: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: mocks.sentryWyjatek, captureMessage: mocks.sentryKomunikat }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('@/lib/format/warsaw-date', async (orig) => ({
  ...(await orig<typeof import('@/lib/format/warsaw-date')>()),
  todayInWarsaw: () => '2027-01-15',
}));
vi.mock('@/lib/supabase/auth-context', async (orig) => ({
  ...(await orig<typeof import('@/lib/supabase/auth-context')>()),
  requireOrgRole: async () => ({ supabase, user: { id: 'u-1' }, tenantId: 'firma-1', role: 'owner' }),
}));
vi.mock('@/lib/ksiegowosc/wylacznik', () => ({
  czyKsiegowoscWlaczona: async () => ({ wlaczony: true }),
  statusObszaru: () => ({ wlaczony: true }),
}));
vi.mock('@/lib/ksiegowosc/ewidencja-dane', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/ewidencja-dane')>()),
  czytajEwidencje: async () => mocks.ewidencja,
}));
vi.mock('@/lib/ksiegowosc/kpir-dane', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/kpir-dane')>()),
  czytajKpir: async () => mocks.kpir,
}));
vi.mock('@/lib/exports/tax-office', async (orig) => ({
  ...(await orig<typeof import('@/lib/exports/tax-office')>()),
  readTenantTaxOffice: async () => {
    if (mocks.urzad === 'blad') throw new Error('Nie można odczytać urzędu skarbowego firmy: timeout');
    return mocks.urzad === 'brak' ? null : '1433';
  },
}));

const supabase = {
  from: (tabela: string) => {
    if (tabela !== 'tenants') throw new Error(`nieoczekiwana tabela ${tabela}`);
    const lancuch: Record<string, unknown> = {};
    lancuch.select = (...args: unknown[]) => {
      mocks.zapytania.push(['select', ...args]);
      return lancuch;
    };
    lancuch.eq = (...args: unknown[]) => {
      mocks.zapytania.push(['eq', ...args]);
      return lancuch;
    };
    lancuch.maybeSingle = async () => mocks.firma;
    return lancuch;
  },
};

const { pobierzJpkEwpAction, pobierzJpkPkpirAction } = await import('@/app/actions/ksiegowosc-ewidencja');

const PROFIL_BAZA = { validFrom: '2026-01-01', zusEtap: 'pelny', zusOd: null, chorobowe: false, nrsZus: null, najem: false } as const;
const RYCZALT: WersjaProfilu = { id: 'p-ryczalt', forma: 'ryczalt', stawkaDomyslna: 1200, ...PROFIL_BAZA };
const SKALA: WersjaProfilu = { id: 'p-skala', forma: 'skala', stawkaDomyslna: null, ...PROFIL_BAZA };

const FAKTURA: FakturaEwidencji = {
  id: 'f1',
  numer: 'FV/1/2026',
  dataWystawienia: '2026-03-10',
  dataSprzedazy: '2026-03-10',
  rodzaj: 'zwykla',
  nettoGr: 1_000_000,
  waluta: 'PLN',
  numerKsef: null,
  fp: false,
  kontrahent: { kraj: 'PL', identyfikator: '1234567890', nazwa: 'Klient', adres: 'Warszawa' },
  rozliczoneZaliczkiGr: 0,
  pozycje: null,
};
const KOSZT: KosztKpir = {
  id: 'k1',
  data: '2026-03-11',
  dowod: 'FZ/1/2026',
  numerKsef: null,
  kontrahent: { nazwa: 'Dostawca', adres: 'Kraków', kraj: 'PL', identyfikator: '1234567890' },
  opis: 'Usługi',
  kolumnaAplikacji: 'col_13',
  kwotaGr: 200_000,
};

const POBRANIE = { rok: 2026, doMiesiaca: 12, imie: 'Jan', nazwisko: 'Testowy', dataUrodzenia: '1980-01-01' };

const PLIKI = [
  ['JPK_EWP', () => pobierzJpkEwpAction(POBRANIE)],
  ['JPK_PKPIR', () => pobierzJpkPkpirAction(POBRANIE)],
] as const;

const BLAD_BAZY = { message: 'canceling statement due to statement timeout', code: '57014' };

const ZEPSUTE_ODCZYTY = [
  [
    'NIP-u firmy',
    () => {
      mocks.firma = { data: null, error: BLAD_BAZY };
    },
  ],
  [
    'urzędu skarbowego',
    () => {
      mocks.urzad = 'blad';
    },
  ],
  [
    'NIP-u i urzędu naraz',
    () => {
      mocks.firma = { data: null, error: BLAD_BAZY };
      mocks.urzad = 'blad';
    },
  ],
] as const;

beforeEach(() => {
  mocks.firma = { data: { nip: '1234567890' }, error: null };
  mocks.urzad = 'ok';
  mocks.zapytania = [];
  mocks.ewidencja = {
    ok: true,
    ewidencja: zbudujEwidencje({ rok: 2026, faktury: [FAKTURA], wpisy: [], wersje: [RYCZALT], kursy: new Map() }),
    wpisy: [],
    wersje: [RYCZALT],
  };
  mocks.kpir = {
    ok: true,
    kpir: zbudujKpir({ rok: 2026, faktury: [FAKTURA], koszty: [KOSZT], wpisy: [], wersje: [SKALA], kursy: new Map() }),
    wpisy: [],
    wersje: [SKALA],
    spisy: [],
  };
  mocks.audit.mockReset();
  mocks.sentryWyjatek.mockReset();
  mocks.sentryKomunikat.mockReset();
});

describe('JPK-01: błąd odczytu danych firmy przy pliku JPK z modułu księgowości', () => {
  describe.each(PLIKI)('%s', (plik, pobierz) => {
    it('dane firmy odczytane: plik powstaje (atrapy prowadzą aż do pliku)', async () => {
      const wynik = await pobierz();
      if (!wynik.success) throw new Error(wynik.error);
      expect(wynik.nazwa).toContain(plik);
      expect(mocks.zapytania).toEqual([
        ['select', 'nip'],
        ['eq', 'id', 'firma-1'],
      ]);
      expect(mocks.sentryWyjatek).not.toHaveBeenCalled();
    });

    it.each(ZEPSUTE_ODCZYTY)(
      'błąd odczytu %s: komunikat o błędzie odczytu bez odsyłania do Ustawień, alarm w Sentry, bez pliku i audytu',
      async (_odczyt, zepsuj) => {
        zepsuj();
        const wynik = await pobierz();
        expect(wynik.success).toBe(false);
        const komunikat = wynik.success ? '' : wynik.error;
        expect(komunikat).not.toMatch(/Ustawieni/);
        expect(komunikat).toMatch(/^Nie udało się odczytać/);
        expect(komunikat).toContain(plik);
        expect(mocks.sentryWyjatek).toHaveBeenCalledTimes(1);
        expect(mocks.sentryWyjatek.mock.calls[0]?.[1]).toEqual({
          tags: { area: 'ksiegowosc.jpk' },
          extra: { tenantId: 'firma-1', plik, etap: 'dane_firmy' },
        });
        expect(JSON.stringify(mocks.sentryWyjatek.mock.calls)).not.toContain('1234567890');
        expect(mocks.audit).not.toHaveBeenCalled();
      },
    );

    it('zły NIP odczytany bez błędu i błąd odczytu urzędu: zostaje zdanie o NIP-ie, jak dotąd (najpierw NIP, potem urząd)', async () => {
      mocks.firma = { data: { nip: '123' }, error: null };
      mocks.urzad = 'blad';
      expect(await pobierz()).toMatchObject({ success: false, error: expect.stringContaining('NIP jest w Ustawieniach') });
      expect(mocks.sentryWyjatek).not.toHaveBeenCalled();
      expect(mocks.audit).not.toHaveBeenCalled();
    });

    it('prawdziwy brak zostaje komunikatem o Ustawieniach, bez alarmu: pusty NIP i urząd nieustawiony', async () => {
      mocks.firma = { data: { nip: null }, error: null };
      expect(await pobierz()).toMatchObject({ success: false, error: expect.stringContaining('NIP jest w Ustawieniach') });
      mocks.firma = { data: null, error: null };
      expect(await pobierz()).toMatchObject({ success: false, error: expect.stringContaining('NIP jest w Ustawieniach') });
      mocks.firma = { data: { nip: '1234567890' }, error: null };
      mocks.urzad = 'brak';
      expect(await pobierz()).toMatchObject({ success: false, error: expect.stringContaining('Urząd ustawia się w Ustawieniach') });
      expect(mocks.sentryWyjatek).not.toHaveBeenCalled();
      expect(mocks.audit).not.toHaveBeenCalled();
    });
  });
});
