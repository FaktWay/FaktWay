import { afterAll, describe, expect, it, vi } from 'vitest';

import { invoiceRateReferenceDate, nbpRateForInvoice } from '@/lib/invoices/exchange-rate';

import * as kalendarz from '../wyrocznia/terminy';

/**
 * NZ-FA-06 (żelazny filtr, waluty; krok 2.1, decyzja D56), część „dzień kursu”:
 * faktura w walucie obcej dostaje kurs NBP z ostatniego dnia roboczego przed
 * dniem powstania obowiązku podatkowego (art. 31a ust. 1 ustawy o VAT), a gdy
 * jest wystawiona przed obowiązkiem, przed dniem wystawienia (ust. 2).
 *
 * Test symuluje NBP, który publikuje tabelę A w każdy dzień roboczy według
 * niezależnej wyroczni dni wolnych (`tests/filtr/wyrocznia/terminy.ts`), i woła
 * prawdziwe `nbpRateForInvoice` (z klientem NBP aplikacji) dla każdego dnia
 * wystawienia 2026-2030 i obowiązku od 30 dni przed do 30 dni po wystawieniu.
 * Oczekiwany dzień tabeli liczy test sam: wcześniejszy z dni (obowiązek,
 * wystawienie), potem w tył do dnia roboczego. Część o VAT w złotych:
 * `tests/filtr/xsd/fa3-waluta.test.ts`.
 */
const DOBA = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const czas = (d: string) => Date.parse(`${d}T00:00:00.000Z`);

const nbp = vi.fn(async (adres: string | URL | Request) => {
  const m = /\/rates\/a\/([a-z]{3})\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})\//.exec(String(adres));
  if (!m) return new Response('Bad Request', { status: 400 });
  const rates: Array<{ no: string; effectiveDate: string; mid: number }> = [];
  for (let t = czas(m[2]!); t <= czas(m[3]!); t += DOBA) {
    const d = iso(t);
    if (kalendarz.czyDzienTerminu(d)) rates.push({ no: `${d}/A/NBP`, effectiveDate: d, mid: 4.25 });
  }
  if (rates.length === 0) return new Response('Not Found', { status: 404 });
  return new Response(JSON.stringify({ code: m[1]!.toUpperCase(), rates }), { status: 200 });
});
vi.stubGlobal('fetch', nbp);
afterAll(() => vi.unstubAllGlobals());

describe('NZ-FA-06: dzień kursu faktury w walucie (art. 31a ust. 1 i 2)', () => {
  it('każdy dzień wystawienia 2026-2030, obowiązek od -30 do +30 dni: tabela z ostatniego dnia roboczego przed wcześniejszym z dni', async () => {
    // null: bez dnia obowiązku (domyślnie dzień wystawienia).
    const odstepy = [null, -30, -7, -3, -1, 0, 1, 3, 7, 30];
    let sprawdzone = 0;
    for (let t = Date.UTC(2026, 0, 1); t <= Date.UTC(2030, 11, 31); t += DOBA) {
      const issueDate = iso(t);
      for (const o of odstepy) {
        const taxPointDate = o === null ? null : iso(t + o * DOBA);
        const odniesienie = taxPointDate !== null && taxPointDate < issueDate ? taxPointDate : issueDate;
        expect(invoiceRateReferenceDate({ issueDate, taxPointDate })).toBe(odniesienie);

        let oczekiwany = czas(odniesienie) - DOBA;
        while (!kalendarz.czyDzienTerminu(iso(oczekiwany))) oczekiwany -= DOBA;

        const wynik = await nbpRateForInvoice('EUR', { issueDate, taxPointDate });
        expect(wynik, `${issueDate} / ${taxPointDate}`).toMatchObject({ found: true, rate: { effectiveDate: iso(oczekiwany) } });
        sprawdzone++;
      }
    }
    expect(sprawdzone).toBe((Math.round((Date.UTC(2030, 11, 31) - Date.UTC(2026, 0, 1)) / DOBA) + 1) * odstepy.length);
  }, 600_000);
});
