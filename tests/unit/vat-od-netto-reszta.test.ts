import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoryTables } from './helpers/baza-w-pamieci';

const db = vi.hoisted(() => ({ tables: {} as MemoryTables }));
const TENANT = '11111111-1111-4111-8111-111111111111';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: vi.fn(async () => ({ ok: true })) }));
// Fikcyjny NIP 1234567890 (AGENTS.md) nie ma sumy kontrolnej; reszta kalkulatora prawdziwa.
vi.mock('@/lib/xml/invoice-calculator', async (orig) => ({
  ...(await orig<typeof import('@/lib/xml/invoice-calculator')>()),
  validateNipChecksum: () => true,
}));
vi.mock('@/lib/supabase/admin', async () => {
  const { memoryClient } = await import('./helpers/baza-w-pamieci');
  return { createAdminClient: () => memoryClient(db.tables) };
});
vi.mock('@/lib/supabase/auth-context', async () => {
  const { memoryClient } = await import('./helpers/baza-w-pamieci');
  return {
    requireUserAndActiveOrg: async () => ({ supabase: memoryClient(db.tables), user: { id: 'uzytkownik' }, tenantId: TENANT, role: 'owner' }),
    ActionAuthError: class ActionAuthError extends Error {},
  };
});

import { saveCorrectionDraftAction } from '@/components/invoices/correction-actions';
import { generateComarchOptimaXml } from '@/lib/exports/comarch-optima-generator';
import { amountsOf, generateJpkFa, importedLinesMismatch, type JpkInvoice } from '@/lib/exports/jpk-fa-generator';
import { legacyLineAmounts } from '@/lib/import/fa3-line-amounts';
import type { ParsedLine } from '@/lib/import/fa3-parser';
import { resolveAmountChangeVatRate } from '@/lib/invoices/correction-amount-change';

/**
 * VAT od netto w pozostałych miejscach (FZ-023, FZ-025): VAT = netto × stawka
 * do grosza, od 0,5 grosza w górę (art. 106e ust. 11 ustawy o VAT). Te miejsca
 * liczyły `roundToCents(netto × stawka)` na liczbach zmiennoprzecinkowych,
 * więc połówka grosza szła w dół: 23 % od 35,50 zł = 8,165 dawało 8,16.
 *
 * Wyrocznia: grosze całkowite i dzielenie całkowite, niezależne od kalkulatora.
 */

/** VAT od netto w groszach: (netto × stawka + 50) / 100, całkowicie, dla netto ≥ 0. */
const vatGr = (nettoGr: number, stawka: number) => Math.floor((nettoGr * stawka + 50) / 100);
const zl = (gr: number) => gr / 100;

describe('FZ-025: korekta kwotowa rozpoznaje stawkę przy VAT zaokrąglonym w górę z połówki grosza', () => {
  it.each([
    [35.5, 8.17, 43.67, '23'],
    [42.7, 2.14, 44.84, '5'],
    [1114.5, 256.34, 1370.84, '23'],
    [-35.5, -8.17, -43.67, '23'],
  ])('netto %s, VAT %s, brutto %s: stawka %s', (netDelta, vatDelta, grossDelta, stawka) => {
    expect(resolveAmountChangeVatRate({ netDelta, vatDelta, grossDelta })).toBe(stawka);
  });

  it('niezmiennik: dla każdej trójki z VAT od netto w groszach całkowitych stawka wychodzi, gdy jedna pasuje', () => {
    const stawki = [['23', 23], ['8', 8], ['5', 5], ['0', 0]] as const;
    let sprawdzone = 0;
    for (let netGr = 1; netGr <= 50_000; netGr += 1) {
      for (const [, stopa] of stawki) {
        const v = vatGr(netGr, stopa);
        const pasujace = stawki.filter(([, s]) => vatGr(netGr, s) === v);
        if (pasujace.length !== 1) continue;
        sprawdzone += 1;
        expect(resolveAmountChangeVatRate({ netDelta: zl(netGr), vatDelta: zl(v), grossDelta: zl(netGr + v) })).toBe(pasujace[0]![0]);
      }
    }
    expect(sprawdzone).toBeGreaterThan(100_000);
  }, 120_000);
});

const PARENT = '00000000-0000-4000-8000-000000000001';
const KSEF_RODZICA = '1234567890-20261102-0100001AF601-B1';
const SPRZEDAWCA = { nip: '1234567890', name: 'Firma testowa', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } };
const NABYWCA = { nip: '1234567890', name: 'Klient testowy', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' } };

/** Faktura w cenach netto: 1 × 100 zł przy 5 % (VAT 5,00), zapisana jak wystawiona przez aplikację. */
function fakturaOdNetto() {
  const lines = [{ ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 100, vatRate: '5', netAmount: 100, vatAmount: 5, grossAmount: 105 }];
  db.tables.invoices!.push({
    id: PARENT, tenant_id: TENANT, direction: 'outgoing', invoice_kind: 'regular', invoice_type: 'VAT', origin: 'app',
    ksef_status: 'accepted', ksef_environment: 'test', ksef_number: KSEF_RODZICA, currency: 'PLN',
    internal_number: 'FV 1/11/2026', issue_date: '2026-11-02', net_total: 100, vat_total: 5, gross_total: 105,
    seller_data: SPRZEDAWCA, buyer_data: NABYWCA, fa3_data: { internalNumber: 'FV 1/11/2026', lines },
  });
  db.tables.invoice_line_items!.push({
    id: `${PARENT}-1`, invoice_id: PARENT, ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1,
    unit_price_net: 100, net_amount: 100, vat_rate: '5', vat_amount: 5, gross_amount: 105,
  });
}

function payload(o: Record<string, unknown>) {
  return {
    invoiceType: 'correction', internalNumber: 'FK/1/11/2026', issueDate: '2026-11-16', paymentMethod: 'transfer', paymentDueDate: '2026-11-30',
    parentInvoiceId: PARENT, parentInvoiceNumber: 'FV 1/11/2026', parentInvoiceIssueDate: '2026-11-02', parentKsefNumber: KSEF_RODZICA,
    correctionReason: 'Dopłata', typKorekty: '2',
    seller: SPRZEDAWCA, buyer: { type: 'b2b', idType: 'nip', ...NABYWCA },
    ...o,
  } as never;
}

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
  db.tables = { tenants: [{ id: TENANT, nip: '1234567890', name: 'Firma testowa', address_json: null }], invoices: [], invoice_line_items: [] };
});

describe('FZ-025: akcja korekty kwotowej (prawdziwa ścieżka na bazie w pamięci)', () => {
  // 5 % od 80,30 zł = 4,015: float daje 4,01 (80,3 × 0,05 = 4,0149999…), do grosza z połówką w górę 4,02.
  it('dopłata 80,30 / 4,02 / 84,32 do faktury od netto (5 %): zapisana, bez odmowy „VAT od brutto”', async () => {
    fakturaOdNetto();
    const r = await saveCorrectionDraftAction(
      payload({ correctionType: 'amount_change', amountChange: { netDelta: 80.3, vatDelta: 4.02, grossDelta: 84.32, description: 'Dopłata' } }),
      TENANT,
    );
    if (!r.success) throw new Error(r.error);
    const korekta = db.tables.invoices!.find((row) => row.invoice_kind === 'correction')!;
    expect(korekta).toMatchObject({ net_total: 80.3, vat_total: 4.02, gross_total: 84.32 });
  });

  it('VAT liczony w dół z połówki (4,01 przy netto 80,30) to VAT od brutto: faktura od netto go odrzuca', async () => {
    fakturaOdNetto();
    const r = await saveCorrectionDraftAction(
      payload({ correctionType: 'amount_change', amountChange: { netDelta: 80.3, vatDelta: 4.01, grossDelta: 84.31, description: 'Dopłata' } }),
      TENANT,
    );
    expect(r.success).toBe(false);
  });
});

function jpkFaktura(o: Partial<JpkInvoice> = {}): JpkInvoice {
  return {
    invoiceNumber: 'FV/1/11', currency: 'PLN', invoiceType: 'regular', issueDate: '2026-11-10',
    buyerName: 'Klient Sp. z o.o.', buyerNip: '5252241585', buyerAddress: 'ul. Klienta 10, 02-001 Warszawa',
    netTotal: 80.3, vatTotal: 4.02, grossTotal: 84.32, ksefNumber: '5260001246-20261110-0100001AF629-AF',
    // Pozycja bez `vatAmount`: zapas liczy VAT z netto.
    lines: [{ position: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 80.3, netAmount: 80.3, vatRate: '5' }],
    ...o,
  };
}

describe('JPK_FA: zapas VAT pozycji bez vatAmount', () => {
  it('amountsOf: VAT 5 % od 80,30 to 4,02 (P_14_3 i P_15 zgodne z fakturą)', () => {
    expect(amountsOf(jpkFaktura())).toEqual({ rates: [{ rate: '5', net: 80.3, vat: 4.02 }], p15: 84.32 });
  });

  it('generateJpkFa: P_14_3 = 4,02', () => {
    const xml = generateJpkFa({
      issuer: { nip: '5260001246', name: 'ACME sp. z o.o.', taxOfficeCode: '1433', registeredAddress: {
        voivodeship: 'MAZOWIECKIE', county: 'Warszawa', commune: 'Mokotów', street: 'ul. Puławska', buildingNumber: '12', city: 'Warszawa', postCode: '02-566',
      } },
      periodStart: '2026-11-01', periodEnd: '2026-11-30', issuedInvoices: [jpkFaktura()], generatedAt: new Date('2026-12-01T08:00:00Z'),
    });
    expect(/<P_14_3>([^<]*)<\/P_14_3>/.exec(xml)?.[1]).toBe('4.02');
  });

  it('importedLinesMismatch: faktura z KSeF z VAT 4,02 i pozycją bez vatAmount nie jest „niezgodna”', () => {
    expect(importedLinesMismatch({ ...jpkFaktura(), importedFromKsef: true })).toBe(false);
  });
});

describe('Comarch Optima: VAT pozycji', () => {
  it('pozycja 80,30 zł przy 5 %: WartoscVAT 4,02, WartoscBrutto 84,32', () => {
    const xml = generateComarchOptimaXml({
      issuer: { nip: '5260001246', name: 'ACME sp. z o.o.', taxOfficeCode: '1433' } as never,
      periodStart: '2026-11-01', periodEnd: '2026-11-30', issuedInvoices: [jpkFaktura()], receivedInvoices: [],
    });
    const pozycja = xml.slice(xml.indexOf('<Pozycja '));
    expect(/<WartoscVAT>([^<]*)<\/WartoscVAT>/.exec(pozycja)?.[1]).toBe('4.02');
    expect(/<WartoscBrutto>([^<]*)<\/WartoscBrutto>/.exec(pozycja)?.[1]).toBe('84.32');
  });
});

describe('import: VAT z netto, gdy pliku go nie ma (legacyLineAmounts)', () => {
  const linia = (netAmount: number, vatRate: string): ParsedLine => ({ position: 1, name: 'Usługa', unit: 'szt.', quantity: 1, unitPriceNet: netAmount, vatRate, netAmount });

  it.each([
    [35.5, '23', 8.17, 43.67],
    [80.3, '5', 4.02, 84.32],
    [42.7, '5', 2.14, 44.84],
    [1114.5, '23', 256.34, 1370.84],
    [-35.5, '23', -8.17, -43.67],
  ])('netto %s, stawka %s: VAT %s, brutto %s', (net, stawka, vat, brutto) => {
    expect(legacyLineAmounts(linia(net, stawka))).toMatchObject({ netAmount: net, vatAmount: vat, grossAmount: brutto });
  });

  it('niezmiennik: VAT z netto do 500 zł równy wyroczni w groszach całkowitych, każda stawka', () => {
    for (let netGr = 1; netGr <= 50_000; netGr += 1) {
      for (const stawka of [23, 8, 5]) {
        expect(legacyLineAmounts(linia(zl(netGr), String(stawka))).vatAmount, `${netGr} gr, ${stawka} %`).toBe(zl(vatGr(netGr, stawka)));
      }
    }
  }, 60_000);
});
