import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';
import type { TerminNaDzis } from '@/lib/ksiegowosc/przypomnienia';
import type { Rozliczenie } from '@/lib/ksiegowosc/ten-miesiac-dane';

/**
 * D64 pkt 2 (FZ-030) na prawdziwej ścieżce `przypomnijOTerminie`: VAT 0 zł w miesiącu bez kwot (`pozycje: null`)
 * z przyjętym JPK_V7M to cisza (bez pusha, maila i wpisu `tax_notifications`); bez przyjęcia i przy błędzie
 * odczytu wysyłek (fail-closed) przypomnienie wychodzi bez kwoty.
 */

const m = vi.hoisted(() => ({
  rozliczenia: [] as unknown[],
  przyjete: true,
  bladWysylek: false,
  maile: [] as Array<{ tresc: string }>,
  pushe: [] as Array<{ body: string }>,
  zajete: 0,
}));

vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('@/lib/ksiegowosc/wylacznik', () => ({
  czyKsiegowoscWlaczona: vi.fn(async () => ({ wlaczony: true })),
  statusObszaru: vi.fn(() => ({ wlaczony: true })),
}));
vi.mock('@/lib/ksiegowosc/profil', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/profil')>()),
  czytajWersjeProfilu: vi.fn(async () => [PROFIL]),
}));
vi.mock('@/lib/ksiegowosc/ten-miesiac-dane', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/ten-miesiac-dane')>()),
  // Miesiąc, który się nie liczy: `pozycje: null` w `niezaplacone`.
  czytajTenMiesiac: vi.fn(async () => ({ ok: false, rozliczenia: m.rozliczenia, braki: [] })),
}));
vi.mock('@/lib/ksiegowosc/powiadomienia', () => ({
  firmyWPilotazu: vi.fn(async () => []),
  wlasciciel: vi.fn(async () => ({ email: 'wlasciciel@example.test', userId: 'u-1' })),
  zajmij: vi.fn(async () => { m.zajete++; return 'nowe'; }),
  zamknij: vi.fn(async () => undefined),
}));
vi.mock('@/lib/invoices/vat-exemption', async (orig) => ({
  ...(await orig<typeof import('@/lib/invoices/vat-exemption')>()),
  readTenantVatExemption: vi.fn(async () => null),
}));
vi.mock('@/lib/ksiegowosc/wysylka-jpk/certyfikaty', () => ({ srodowiskoMf: vi.fn(() => 'test') }));
vi.mock('@/lib/ksiegowosc/wysylka-jpk/zapis', () => ({
  czytajWysylki: vi.fn(async () => {
    if (m.bladWysylek) throw new Error('baza niedostępna');
    return [];
  }),
  nadwyzkaPrzyjetej: vi.fn(() => (m.przyjete ? 1 : null)),
}));
vi.mock('@/lib/email/send', () => ({
  sendTerminRozliczeniaEmail: vi.fn(async (_do: string, d: { tresc: string }) => { m.maile.push({ tresc: d.tresc }); return { sent: true }; }),
}));
vi.mock('@/lib/push/sender', () => ({
  sendPushToTenant: vi.fn(async (_t: string, _k: string, d: { body: string }) => { m.pushe.push({ body: d.body }); return { sent: 1 }; }),
}));
vi.mock('@/lib/app-notifications/publish', () => ({ publishAppNotification: vi.fn(async () => undefined) }));

import { przypomnijOTerminie } from '@/lib/jobs/runners/ksiegowosc-terminy';

const PROFIL: WersjaProfilu = {
  id: 'p1', validFrom: '2026-01-01', forma: 'ryczalt', stawkaDomyslna: 1200, zusEtap: 'pelny',
  zusOd: null, chorobowe: true, nrsZus: null, najem: false,
};

const vatZero: Rozliczenie = {
  id: 'vat-1', miesiac: '2026-10', rodzaj: 'vat', wersja: 1, kwotaGr: 0, termin: '2026-11-25', status: 'zatwierdzone',
  wejsciaHash: 'a'.repeat(64), zatwierdzoneO: '2026-11-02T10:00:00Z', zaplaconeO: null, spoleczneBezFpGr: 0, reczna: false,
};

const terminVat = {
  miesiac: '2026-10',
  termin: { rodzaj: 'vat', nominalny: '2026-11-25', faktyczny: '2026-11-25', przesuniety: false },
  dni: 5,
  etap: 'termin-5:2026-11-25',
  grupy: ['vat'],
} as unknown as TerminNaDzis;

const admin = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  m.rozliczenia = [vatZero];
  m.przyjete = true;
  m.bladWysylek = false;
  m.maile = [];
  m.pushe = [];
  m.zajete = 0;
});

describe('D64 pkt 2 w przypomnijOTerminie: VAT 0 zł, miesiąc bez kwot', () => {
  it('JPK_V7M przyjęty: cisza, bez pusha, maila i wpisu tax_notifications', async () => {
    await expect(przypomnijOTerminie(admin, 'ten-1', terminVat)).resolves.toBe('pominiete');
    expect(m.pushe).toEqual([]);
    expect(m.maile).toEqual([]);
    expect(m.zajete).toBe(0);
  });

  it('JPK_V7M nieprzyjęty: przypomnienie o VAT bez kwoty', async () => {
    m.przyjete = false;
    await expect(przypomnijOTerminie(admin, 'ten-1', terminVat)).resolves.toBe('wyslane');
    expect(m.pushe).toHaveLength(1);
    expect(m.pushe[0].body).toContain('VAT');
    expect(m.zajete).toBe(1);
  });

  it('błąd odczytu wysyłek: fail-closed, przypomnienie bez kwoty', async () => {
    m.bladWysylek = true;
    await expect(przypomnijOTerminie(admin, 'ten-1', terminVat)).resolves.toBe('wyslane');
    expect(m.pushe).toHaveLength(1);
    expect(m.zajete).toBe(1);
  });
});
