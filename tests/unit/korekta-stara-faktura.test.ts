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

import { getCorrectionParentContextAction, saveCorrectionDraftAction } from '@/components/invoices/correction-actions';
import { fetchInvoicesForExport } from '@/lib/exports/data-fetcher';
import { amountsOf } from '@/lib/exports/jpk-fa-generator';
import { calculateCorrectionTotals } from '@/lib/invoices/calculator';
import { generateCorrectionInvoiceXml } from '@/lib/ksef/fa3-correction-generator';
import { validateInvoiceXml } from '@/lib/xml/validator';
import type { CorrectionInvoiceData } from '@/types/invoice-types';

/**
 * Korekta faktury wystawionej przed naprawą ilość × cena (kwoty z dawnego
 * liczenia na liczbach zmiennoprzecinkowych): 1 × 35,50 zł przy 23 % z VAT
 * 8,16, choć 35,50 × 23 % = 8,165 daje do grosza 8,17 (art. 106e ust. 11).
 * Kalkulator liczy dziś 8,17, a faktura w KSeF ma 8,16. Stan przed korekty
 * to faktura, jak ją wystawiono: kwoty pozycji z zapisu (`invoice_line_items`),
 * nie liczone od nowa. Bez tego `correctionBaseline` odmawiał każdej korekty
 * („Pozycje faktury … nie zgadzają się z jej zaakceptowaną kwotą”), a #828
 * brał pozycję za liczoną od brutto i odmawiał korekty „przed/po”.
 *
 * Prawdziwa ścieżka: akcje strony na bazie w pamięci, koperta z wiersza do
 * generatora FA(3) KOR i XSD MF, JPK z `fetchInvoicesForExport`. Atrapy:
 * sesja, kolejka KSeF, dziennik.
 */

const PARENT = '00000000-0000-4000-8000-000000000001';
const KSEF_RODZICA = '1234567890-20261102-0100001AF601-B1';
const SPRZEDAWCA = { nip: '1234567890', name: 'Firma testowa', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } };
const NABYWCA = { nip: '1234567890', name: 'Klient testowy', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' } };

type Pozycja = { name: string; quantity: number; unitPriceNet: number; net: number; vat: number; gross: number };
/** Pozycja sprzed naprawy: 1 × 35,50 zł, VAT 8,16 (dawne liczenie), brutto 43,66. */
const STARA: Pozycja = { name: 'Usługa', quantity: 1, unitPriceNet: 35.5, net: 35.5, vat: 8.16, gross: 43.66 };

/** Faktura przyjęta w KSeF z pozycjami zapisanymi tak, jak je wtedy policzono (wiersze i dokument). */
function staraFaktura(pozycje: Pozycja[] = [STARA]) {
  const grosze = (k: (p: Pozycja) => number) => pozycje.reduce((a, p) => a + Math.round(k(p) * 100), 0) / 100;
  const lines = pozycje.map((p, i) => ({
    ordinal: i + 1, name: p.name, unit: 'usł.', quantity: p.quantity, unitPriceNet: p.unitPriceNet, vatRate: '23',
    netAmount: p.net, vatAmount: p.vat, grossAmount: p.gross,
  }));
  db.tables.invoices!.push({
    id: PARENT, tenant_id: TENANT, direction: 'outgoing', invoice_kind: 'regular', invoice_type: 'VAT', origin: 'app',
    ksef_status: 'accepted', ksef_environment: 'test', ksef_number: KSEF_RODZICA, currency: 'PLN',
    internal_number: 'FV 1/11/2026', issue_date: '2026-11-02',
    net_total: grosze((p) => p.net), vat_total: grosze((p) => p.vat), gross_total: grosze((p) => p.gross),
    seller_data: SPRZEDAWCA, buyer_data: NABYWCA,
    fa3_data: { internalNumber: 'FV 1/11/2026', lines },
  });
  db.tables.invoice_line_items!.push(...lines.map((l) => ({
    id: `${PARENT}-${l.ordinal}`, invoice_id: PARENT, ordinal: l.ordinal, name: l.name, unit: l.unit, quantity: l.quantity,
    unit_price_net: l.unitPriceNet, net_amount: l.netAmount, vat_rate: '23', vat_amount: l.vatAmount, gross_amount: l.grossAmount,
  })));
}

function payload(o: Record<string, unknown>) {
  return {
    invoiceType: 'correction', internalNumber: 'FK/1/11/2026', issueDate: '2026-11-16', paymentMethod: 'transfer', paymentDueDate: '2026-11-30',
    parentInvoiceId: PARENT, parentInvoiceNumber: 'FV 1/11/2026', parentInvoiceIssueDate: '2026-11-02', parentKsefNumber: KSEF_RODZICA,
    correctionReason: 'Zmiana ilości', typKorekty: '2',
    seller: SPRZEDAWCA, buyer: { type: 'b2b', idType: 'nip', ...NABYWCA },
    ...o,
  } as never;
}

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
  db.tables = { tenants: [{ id: TENANT, nip: '1234567890', name: 'Firma testowa', address_json: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } }], invoices: [], invoice_line_items: [] };
});

const zapisana = () => db.tables.invoices!.find((r) => r.invoice_kind === 'correction')!;
const koperta = () => (zapisana().special_data as { correctionData: CorrectionInvoiceData }).correctionData;
const pozycjeKorekty = () => db.tables.invoice_line_items!.filter((r) => r.invoice_id === zapisana().id)
  .map((r) => [Number(r.quantity), Number(r.net_amount), Number(r.vat_amount), Number(r.gross_amount)]);
const pole = (xml: string, nazwa: string) => new RegExp(`<${nazwa}>([^<]*)</${nazwa}>`).exec(xml)?.[1];
const plik = () => generateCorrectionInvoiceXml(koperta(), { generatedAt: new Date('2026-11-16T10:00:00Z') });
/** Wiersze FaWiersz pliku: [StanPrzed?, P_8B, P_11]. */
const wierszePliku = (xml: string) => [...xml.matchAll(/<FaWiersz>([\s\S]*?)<\/FaWiersz>/g)].map((m) => [
  m[1]!.includes('<StanPrzed>1</StanPrzed>') ? 'przed' : 'po', pole(m[1]!, 'P_8B'), pole(m[1]!, 'P_11'),
]);

/** Korekta przyjęta w KSeF i jej kwoty w JPK (`amountsOf`, ten sam wynik dla JPK_FA i JPK_V7M). */
async function jpkKorekty() {
  Object.assign(zapisana(), { ksef_status: 'accepted', ksef_environment: 'test', ksef_number: '1234567890-20261116-0100001AF602-B2', currency: 'PLN', origin: 'app' });
  const { issuedInvoices } = await fetchInvoicesForExport({ tenantId: TENANT, periodStart: '2026-11-01', periodEnd: '2026-11-30', direction: 'issued' });
  return amountsOf(issuedInvoices.find((i) => i.invoiceNumber === 'FK/1/11/2026')!);
}

async function kontekst() {
  const ctx = await getCorrectionParentContextAction(PARENT);
  if (!ctx.success) throw new Error(ctx.error);
  return ctx;
}

describe('korekta faktury z kwotami z dawnego liczenia (35,50 zł, VAT 8,16)', () => {
  it('kontekst formularza: bez odmowy, wszystkie rodzaje korekty, stan przed z kwotami z zapisu', async () => {
    staraFaktura();
    const ctx = await kontekst();
    expect(ctx).toMatchObject({ grossTotal: 43.66, allowedCorrectionTypes: 'all' });
    expect(ctx).not.toHaveProperty('beforeAfterRefusal');
    expect(ctx.linesBefore).toEqual([expect.objectContaining({ quantity: 1, unitPriceNet: 35.5, recordedAmounts: { netAmount: 35.5, vatAmount: 8.16, grossAmount: 43.66 } })]);
    expect(ctx.linesBefore[0]).not.toHaveProperty('unitPriceGross');
  });

  it('korekta „przed/po” 1 → 2: różnica 35,50 / 8,17 / 43,67 od stanu przed 35,50 / 8,16 / 43,66; plik, XSD i JPK tak samo', async () => {
    staraFaktura();
    const ctx = await kontekst();
    const r = await saveCorrectionDraftAction(
      payload({ correctionType: 'before_after', linesBefore: ctx.linesBefore, linesAfter: [{ ...ctx.linesAfter[0]!, quantity: 2 }] }),
      TENANT,
    );
    if (!r.success) throw new Error(r.error);
    expect(zapisana()).toMatchObject({ net_total: 35.5, vat_total: 8.17, gross_total: 43.67 });
    // Stan przed bez zmian: kwoty pozycji faktury, jak w KSeF.
    expect(koperta().linesBefore?.[0]?.recordedAmounts).toEqual({ netAmount: 35.5, vatAmount: 8.16, grossAmount: 43.66 });
    expect(pozycjeKorekty()).toEqual([[2, 71, 16.33, 87.33]]);
    const xml = plik();
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
    expect(wierszePliku(xml)).toEqual([['przed', '1.0000', '35.50'], ['po', '2.0000', '71.00']]);
    expect([pole(xml, 'P_13_1'), pole(xml, 'P_14_1'), pole(xml, 'P_15')]).toEqual(['35.50', '8.17', '43.67']);
    expect(await jpkKorekty()).toEqual({ rates: [{ rate: '23', net: 35.5, vat: 8.17 }], p15: 43.67 });
  });

  it('anulowanie: różnica to kwoty faktury z minusem (−35,50 / −8,16 / −43,66); plik, XSD i JPK tak samo', async () => {
    staraFaktura();
    const ctx = await kontekst();
    const r = await saveCorrectionDraftAction(payload({ correctionType: 'cancellation', linesBefore: ctx.linesBefore, linesAfter: ctx.linesAfter }), TENANT);
    if (!r.success) throw new Error(r.error);
    expect(zapisana()).toMatchObject({ net_total: -35.5, vat_total: -8.16, gross_total: -43.66 });
    expect(pozycjeKorekty()).toEqual([[-1, -35.5, -8.16, -43.66]]);
    const xml = plik();
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
    expect([pole(xml, 'P_11'), pole(xml, 'P_13_1'), pole(xml, 'P_14_1'), pole(xml, 'P_15')]).toEqual(['-35.50', '-35.50', '-8.16', '-43.66']);
    expect(await jpkKorekty()).toEqual({ rates: [{ rate: '23', net: -35.5, vat: -8.16 }], p15: -43.66 });
  });

  it('korekta kwotowa (rabat −10,00 / −2,30 / −12,30) przechodzi; plik ma te kwoty', async () => {
    staraFaktura();
    const r = await saveCorrectionDraftAction(
      payload({ correctionType: 'amount_change', amountChange: { netDelta: -10, vatDelta: -2.3, grossDelta: -12.3, description: 'Rabat' } }),
      TENANT,
    );
    if (!r.success) throw new Error(r.error);
    expect(zapisana()).toMatchObject({ net_total: -10, vat_total: -2.3, gross_total: -12.3 });
    const xml = plik();
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
    expect([pole(xml, 'P_13_1'), pole(xml, 'P_14_1'), pole(xml, 'P_15')]).toEqual(['-10.00', '-2.30', '-12.30']);
  });

  it('„przed/po” z pozycją bez zmian: pozycja bez zmian ma w stanie po kwoty z zapisu, różnica tylko z pozycji zmienionej', async () => {
    staraFaktura([STARA, { name: 'Szkolenie', quantity: 1, unitPriceNet: 100, net: 100, vat: 23, gross: 123 }]);
    const ctx = await kontekst();
    const r = await saveCorrectionDraftAction(
      payload({ correctionType: 'before_after', linesBefore: ctx.linesBefore, linesAfter: [ctx.linesAfter[0]!, { ...ctx.linesAfter[1]!, quantity: 2 }] }),
      TENANT,
    );
    if (!r.success) throw new Error(r.error);
    expect(zapisana()).toMatchObject({ net_total: 100, vat_total: 23, gross_total: 123 });
    // Stan po z kwotami: pozycja bez zmian jak na fakturze (8,16), nie 8,17 z kalkulatora.
    expect(pozycjeKorekty()).toEqual([[1, 35.5, 8.16, 43.66], [2, 200, 46, 246]]);
    const xml = plik();
    expect(wierszePliku(xml)).toEqual([['przed', '1.0000', '100.00'], ['po', '2.0000', '200.00']]);
    expect([pole(xml, 'P_13_1'), pole(xml, 'P_14_1'), pole(xml, 'P_15')]).toEqual(['100.00', '23.00', '123.00']);
    expect(await jpkKorekty()).toEqual({ rates: [{ rate: '23', net: 100, vat: 23 }], p15: 123 });
  });

  it('6,75 × 4216,86 z netto 28 463,80 (dawne liczenie, dziś 28 463,81): anulowanie i „przed/po” bez odmowy, stan przed z zapisu', async () => {
    const pozycja: Pozycja = { name: 'Montaż', quantity: 6.75, unitPriceNet: 4216.86, net: 28463.8, vat: 6546.67, gross: 35010.47 };
    staraFaktura([pozycja]);
    const ctx = await kontekst();
    expect(ctx.linesBefore[0]?.recordedAmounts).toEqual({ netAmount: 28463.8, vatAmount: 6546.67, grossAmount: 35010.47 });
    const anulowanie = await saveCorrectionDraftAction(payload({ correctionType: 'cancellation', linesBefore: ctx.linesBefore, linesAfter: ctx.linesAfter }), TENANT);
    if (!anulowanie.success) throw new Error(anulowanie.error);
    expect(zapisana()).toMatchObject({ net_total: -28463.8, vat_total: -6546.67, gross_total: -35010.47 });
    expect([pole(plik(), 'P_13_1'), pole(plik(), 'P_14_1')]).toEqual(['-28463.80', '-6546.67']);

    db.tables.invoices = db.tables.invoices!.filter((row) => row.invoice_kind !== 'correction');
    const r = await saveCorrectionDraftAction(
      payload({ correctionType: 'before_after', linesBefore: ctx.linesBefore, linesAfter: [{ ...ctx.linesAfter[0]!, quantity: 7 }] }),
      TENANT,
    );
    if (!r.success) throw new Error(r.error);
    // 7 × 4216,86 = 29 518,02, VAT 6789,14; różnica od stanu przed z zapisu.
    expect(zapisana()).toMatchObject({ net_total: 1054.22, vat_total: 242.47, gross_total: 1296.69 });
    expect(wierszePliku(plik())).toEqual([['przed', '6.7500', '28463.80'], ['po', '7.0000', '29518.02']]);
  });

  it('połówka grosza w dół z innego programu (import: cena 10,125, netto 10,12): pozycja od netto, „przed/po” bez odmowy, stan przed z zapisu', async () => {
    staraFaktura([{ name: 'Usługa z importu', quantity: 1, unitPriceNet: 10.125, net: 10.12, vat: 2.33, gross: 12.45 }]);
    const ctx = await kontekst();
    expect(ctx).not.toHaveProperty('beforeAfterRefusal');
    expect(ctx.linesBefore[0]).not.toHaveProperty('unitPriceGross');
    const r = await saveCorrectionDraftAction(
      payload({ correctionType: 'before_after', linesBefore: ctx.linesBefore, linesAfter: [{ ...ctx.linesAfter[0]!, quantity: 2 }] }),
      TENANT,
    );
    if (!r.success) throw new Error(r.error);
    // 2 × 10,125 = 20,25, VAT 4,66 (20,25 × 23 % = 4,6575); stan przed 10,12 / 2,33 / 12,45 z zapisu.
    expect(zapisana()).toMatchObject({ net_total: 10.13, vat_total: 2.33, gross_total: 12.46 });
  });

  it('podgląd w formularzu (calculateCorrectionTotals z danych kontekstu) = zapis korekty', async () => {
    staraFaktura();
    const ctx = await kontekst();
    const totals = calculateCorrectionTotals({
      correctionType: 'before_after', linesBefore: ctx.linesBefore, linesAfter: [{ ...ctx.linesAfter[0]!, quantity: 2 }],
    } as unknown as CorrectionInvoiceData);
    // Różnice to odejmowanie złotych (jak przy zapisie, który zaokrągla je do grosza).
    const doGrosza = (v: number) => Math.round(v * 100) / 100;
    expect([totals.netBefore, totals.vatBefore, totals.grossBefore]).toEqual([35.5, 8.16, 43.66]);
    expect([totals.netDelta, totals.vatDelta, totals.grossDelta].map(doGrosza)).toEqual([35.5, 8.17, 43.67]);
  });
});
