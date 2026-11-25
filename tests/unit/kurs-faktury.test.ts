import { afterEach, describe, expect, it, vi } from 'vitest';

import { exchangeRateFromNbp, invoiceRateReferenceDate, nbpRateForInvoice } from '@/lib/invoices/exchange-rate';

/**
 * Dzień kursu NBP dla faktury w walucie obcej (plan kompletnej aplikacji,
 * krok 2.1, decyzja D56; art. 31a ust. 1 i 2 ustawy o VAT): kurs z ostatniego
 * dnia roboczego przed dniem obowiązku podatkowego, a przy fakturze wystawionej
 * przed obowiązkiem przed dniem wystawienia. Domyślny obowiązek (art. 19a ust. 1):
 * dzień dostawy albo wykonania usługi (`P_6`), bez niego dzień wystawienia.
 * Niezmiennik na każdym dniu 2026-2030: `tests/filtr/roznicowe/kurs-dzien-faktury.test.ts`.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dzień, przed którym bierze się kurs (art. 31a ust. 1 i 2)', () => {
  it('sprzedaż przed wystawieniem: przed dniem sprzedaży (obowiązek z art. 19a ust. 1)', () => {
    expect(invoiceRateReferenceDate({ issueDate: '2026-11-25', taxPointDate: '2026-11-20' })).toBe('2026-11-20');
  });

  it('faktura wystawiona przed obowiązkiem: przed dniem wystawienia (ust. 2)', () => {
    expect(invoiceRateReferenceDate({ issueDate: '2026-11-25', taxPointDate: '2026-12-03' })).toBe('2026-11-25');
  });

  it('bez dnia obowiązku albo ten sam dzień: przed dniem wystawienia', () => {
    expect(invoiceRateReferenceDate({ issueDate: '2026-11-25' })).toBe('2026-11-25');
    expect(invoiceRateReferenceDate({ issueDate: '2026-11-25', taxPointDate: null })).toBe('2026-11-25');
    expect(invoiceRateReferenceDate({ issueDate: '2026-11-25', taxPointDate: '2026-11-25' })).toBe('2026-11-25');
  });

  it('zła data to błąd programu, nie cichy kurs z innego dnia', () => {
    expect(() => invoiceRateReferenceDate({ issueDate: '2026-02-30' })).toThrow(RangeError);
    expect(() => invoiceRateReferenceDate({ issueDate: '2026-11-25', taxPointDate: '25.11.2026' })).toThrow(RangeError);
  });
});

describe('kurs NBP do faktury', () => {
  it('pyta NBP o tabele z 10 dni przed dniem odniesienia i bierze ostatnią przed nim; kurs do faktury z numerem i dniem tabeli', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 'EUR',
          rates: [
            { no: '222/A/NBP/2026', effectiveDate: '2026-11-16', mid: 4.2101 },
            { no: '223/A/NBP/2026', effectiveDate: '2026-11-17', mid: 4.2202 },
            { no: '224/A/NBP/2026', effectiveDate: '2026-11-18', mid: 4.2303 },
            { no: '225/A/NBP/2026', effectiveDate: '2026-11-19', mid: 4.2404 },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    // Sprzedaż w piątek 20.11, faktura 25.11: obowiązek 20.11, kurs z czwartku 19.11.
    const wynik = await nbpRateForInvoice('eur', { issueDate: '2026-11-25', taxPointDate: '2026-11-20' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('https://api.nbp.pl/api/exchangerates/rates/a/eur/2026-11-10/2026-11-19/?format=json');
    expect(wynik).toMatchObject({ found: true, rate: { currency: 'EUR', mid: 4.2404, tableNo: '225/A/NBP/2026', effectiveDate: '2026-11-19' } });
    if (wynik.found) {
      expect(exchangeRateFromNbp(wynik.rate)).toEqual({ rate: 4.2404, tableNo: '225/A/NBP/2026', tableDate: '2026-11-19' });
    }
  });

  it('brak tabel (404) to brak kursu z powodem, błąd sieci rzuca (do ponowienia), nic nie zgaduje', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Not Found', { status: 404 })));
    expect(await nbpRateForInvoice('EUR', { issueDate: '2026-11-25' })).toEqual({ found: false, reason: 'unknown_currency' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('err', { status: 503 })));
    await expect(nbpRateForInvoice('EUR', { issueDate: '2026-11-25' })).rejects.toThrow(/NBP: HTTP 503/);
  });
});
