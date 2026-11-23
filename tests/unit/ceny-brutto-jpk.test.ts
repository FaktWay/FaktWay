import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoryTables, Row } from './helpers/baza-w-pamieci';

const db = vi.hoisted(() => ({ tables: {} as MemoryTables }));
vi.mock('@/lib/supabase/admin', async () => {
  const { memoryClient } = await import('./helpers/baza-w-pamieci');
  return { createAdminClient: () => memoryClient(db.tables) };
});

import { fetchInvoicesForExport } from '@/lib/exports/data-fetcher';
import { generateJpkFa } from '@/lib/exports/jpk-fa-generator';
import { validateJpkFa } from '@/lib/exports/jpk-fa-validator';
import { generateJpkV7m } from '@/lib/exports/jpk-v7m-generator';
import { validateJpkV7m } from '@/lib/exports/jpk-v7m-validator';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';

/**
 * Faktura FaktWay w cenach brutto w plikach JPK (plan cen brutto, PR (c)).
 * JPK_FA(4) `FakturaWiersz` ma podać to, co faktura: cenę i wartość brutto
 * (`P_9B`, `P_11A`) zamiast netto (art. 106e ust. 8), jak przy imporcie faktur
 * od brutto (C5c); dotąd wiersz dostałby `P_9A` 0 i wyliczone netto. JPK_V7M
 * bierze sumy stawek z pozycji, a podział VAT stawki sumuje się do KP od sumy
 * brutto, więc VAT stawki w JPK = VAT z faktury.
 *
 * Prawdziwa ścieżka: faktura z `finalizeInvoice` (ceny brutto) w bazie w pamięci,
 * `fetchInvoicesForExport`, generatory i XSD MF. Atrapa tylko bazy.
 */

const T = 'firma-brutto';
const NIP = '1234567890';
const ADRES_FIRMY = { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' };
const ADRES_URZEDOWY = {
  voivodeship: 'MAZOWIECKIE', county: 'Warszawa', commune: 'Mokotów', street: 'ul. Testowa',
  buildingNumber: '1', city: 'Warszawa', postCode: '00-001',
};

function fakturaBrutto(): Row {
  const invoice = finalizeInvoice({
    internalNumber: 'FV/1/11/2026', type: 'VAT', issueDate: '2026-11-17',
    seller: { nip: NIP, name: 'Firma testowa', address: ADRES_FIRMY },
    buyer: { nip: '5252241585', name: 'Klient Sp. z o.o.', address: ADRES_FIRMY },
    pricesGross: true,
    lines: ['Kawa', 'Herbata', 'Woda'].map((name, i) => ({ ordinal: i + 1, name, unit: 'szt.', quantity: 1, unitPriceNet: 0, unitPriceGross: 1, vatRate: '23' as const })),
    payment: { currency: 'PLN', dueDate: '2026-12-01', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
  });
  return {
    id: 'inv-brutto', tenant_id: T, direction: 'outgoing', invoice_kind: 'regular', invoice_type: 'VAT', origin: 'app',
    ksef_status: 'accepted', ksef_environment: 'test', currency: 'PLN', internal_number: invoice.internalNumber,
    ksef_number: `${NIP}-20261117-0100001AF601-B1`, issue_date: invoice.issueDate, sale_date: null,
    buyer_nip: '5252241585', buyer_data: invoice.buyer, seller_data: invoice.seller,
    net_total: invoice.netTotal, vat_total: invoice.vatTotal, gross_total: invoice.grossTotal,
    fa3_data: invoice, parent_invoice_id: null, correction_type: null, special_data: null, advance_invoice_ids: [],
  };
}

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
  db.tables = { tenants: [{ id: T, nip: NIP, name: 'Firma testowa', address_json: null }], invoices: [fakturaBrutto()], invoice_line_items: [], expenses: [] };
});

const wiersze = (xml: string, znacznik: string) => [...xml.matchAll(new RegExp(`<${znacznik}>([\\s\\S]*?)</${znacznik}>`, 'g'))].map((m) => m[1]!);
const pola = (xml: string, nazwa: string) => [...xml.matchAll(new RegExp(`<${nazwa}>([^<]*)</${nazwa}>`, 'g'))].map((m) => m[1]!);

describe('JPK faktury FaktWay w cenach brutto', () => {
  it('JPK_FA(4): wiersze z P_9B i P_11A z faktury, bez P_9A i P_11; plik zgodny z XSD', async () => {
    const { issuer, issuedInvoices } = await fetchInvoicesForExport({ tenantId: T, periodStart: '2026-11-01', periodEnd: '2026-11-30', direction: 'issued' });
    const xml = generateJpkFa({
      issuer: { ...issuer, taxOfficeCode: '1433', registeredAddress: ADRES_URZEDOWY },
      periodStart: '2026-11-01', periodEnd: '2026-11-30', issuedInvoices, generatedAt: new Date('2026-12-05T10:00:00Z'),
    });
    expect((await validateJpkFa(xml)).errors).toEqual([]);
    const rows = wiersze(xml, 'FakturaWiersz');
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(pola(row, 'P_9B')).toEqual(['1.00']);
      expect(pola(row, 'P_11A')).toEqual(['1.00']);
      expect(pola(row, 'P_9A')).toEqual([]);
      expect(pola(row, 'P_11')).toEqual([]);
    }
  });

  it('JPK_V7M: VAT stawki w wierszu i w deklaracji = VAT z faktury (0,56 od 3,00), nie suma VAT pozycji liczonych osobno', async () => {
    const { issuedInvoices } = await fetchInvoicesForExport({ tenantId: T, periodStart: '2026-11-01', periodEnd: '2026-11-30', direction: 'issued' });
    const xml = generateJpkV7m({
      issuer: { nip: NIP, name: 'Firma testowa', email: 'biuro@example.test', taxOfficeCode: '1433' },
      periodStart: '2026-11-01', periodEnd: '2026-11-30', generatedAt: new Date('2026-12-05T10:00:00Z'),
      issuedInvoices, expenses: [], previousSurplus: 0,
    });
    expect((await validateJpkV7m(xml)).errors).toEqual([]);
    const row = wiersze(xml, 'SprzedazWiersz')[0] ?? '';
    expect([pola(row, 'K_19'), pola(row, 'K_20')]).toEqual([['2.44'], ['0.56']]);
  });
});
