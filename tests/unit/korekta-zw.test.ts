import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoryTables, Row } from './helpers/baza-w-pamieci';

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
import { generateCorrectionInvoiceXml } from '@/lib/ksef/fa3-correction-generator';
import { validateInvoiceXml } from '@/lib/xml/validator';
import type { CorrectionInvoiceData, InvoiceLine } from '@/types/invoice-types';

/**
 * Plan „zero zgubionych faktur”, karta C3 (W7): korekta ze stawką „zw”.
 * Firma zwolniona z VAT (art. 113) nie wystawiała żadnej korekty: pozycja „zw”
 * kończyła się odmową już przy odczycie faktury pierwotnej, a generator korekt
 * nie pisał bloku Zwolnienie (P_19 i podstawa zwolnienia P_19A/B/C). Korekta
 * przejmuje podstawę zwolnienia z faktury korygowanej (`fa3_data.annotations`,
 * jak P_16 i P_18A, AUD-23), także z faktury K zapisanej z pliku KSeF (C5b,
 * D-A4-1b-3-KORZW).
 *
 * Prawdziwa ścieżka: akcje strony korekty na bazie w pamięci i generator KOR
 * z XSD. Atrapy: sesja, kolejka KSeF, dziennik.
 */

const PODSTAWA = 'art. 113 ust. 1 ustawy o VAT';
const PARENT = '00000000-0000-4000-8000-000000000001';
const KSEF_RODZICA = '1234567890-20261102-0100001AF601-B1';
const SPRZEDAWCA = { nip: '1234567890', name: 'Firma testowa', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } };
const NABYWCA = { nip: '1234567890', name: 'Klient testowy', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' } };

const pozycja = (unitPriceNet: number): InvoiceLine => ({ name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet, vatRate: 'zw' });

function korekta(o: Partial<CorrectionInvoiceData> = {}): CorrectionInvoiceData {
  return {
    invoiceType: 'correction',
    internalNumber: 'FK 1/11/2026',
    issueDate: '2026-11-16',
    paymentMethod: 'transfer',
    paymentDueDate: '2026-11-30',
    parentInvoiceId: PARENT,
    parentInvoiceNumber: 'FV 7/11/2026',
    parentInvoiceIssueDate: '2026-11-02',
    parentKsefNumber: KSEF_RODZICA,
    correctionType: 'before_after',
    correctionReason: 'Zmiana ceny',
    typKorekty: '2',
    seller: SPRZEDAWCA,
    buyer: { type: 'b2b', idType: 'nip', ...NABYWCA },
    linesBefore: [pozycja(1000)],
    linesAfter: [pozycja(900)],
    annotations: { cashMethod: 2, splitPayment: 2, vatExemptionBasis: PODSTAWA },
    ...o,
  } as CorrectionInvoiceData;
}

describe('generator KOR: stawka „zw” z podstawą zwolnienia z faktury korygowanej (C3)', () => {
  it('„przed / po”: P_13_7 z różnicą, P_19 = 1 i P_19A z podstawą, bez P_19N, zgodna z XSD', async () => {
    const xml = generateCorrectionInvoiceXml(korekta(), { prettyPrint: false });
    expect(xml).toContain('<P_13_7>-100.00</P_13_7>');
    expect(xml).toContain(`<Zwolnienie><P_19>1</P_19><P_19A>${PODSTAWA}</P_19A></Zwolnienie>`);
    expect(xml).not.toContain('<P_19N>');
    const wynik = await validateInvoiceXml(xml);
    expect(wynik.errors).toEqual([]);
    expect(wynik.valid).toBe(true);
  });

  it('anulowanie faktury „zw”: P_19 i podstawa, zgodna z XSD', async () => {
    const xml = generateCorrectionInvoiceXml(korekta({ correctionType: 'cancellation', linesAfter: undefined }), { prettyPrint: false });
    expect(xml).toContain('<P_13_7>-1000.00</P_13_7>');
    expect(xml).toContain(`<P_19>1</P_19><P_19A>${PODSTAWA}</P_19A>`);
    expect((await validateInvoiceXml(xml)).valid).toBe(true);
  });

  it('podstawa z pliku KSeF w P_19B (dyrektywa): korekta pisze ten sam rodzaj podstawy', async () => {
    const xml = generateCorrectionInvoiceXml(korekta({
      annotations: { cashMethod: 2, splitPayment: 2, vatExemptionBasis: 'art. 132 ust. 1 lit. i dyrektywy 2006/112/WE', vatExemptionBasisKind: 'P_19B' },
    }), { prettyPrint: false });
    expect(xml).toContain('<P_19>1</P_19><P_19B>art. 132 ust. 1 lit. i dyrektywy 2006/112/WE</P_19B>');
    expect((await validateInvoiceXml(xml)).valid).toBe(true);
  });

  it('„zw” bez podstawy zwolnienia w fakturze korygowanej: odmowa z wyjściem, bez pliku', () => {
    expect(() => generateCorrectionInvoiceXml(korekta({ annotations: { cashMethod: 2, splitPayment: 2 } })))
      .toThrow(/podstawy zwolnienia/);
  });

  it('korekta kwotowa faktury „zw” (ustalenie 29): P_13_7 z różnicą, P_19 z podstawą, zgodna z XSD', async () => {
    const xml = generateCorrectionInvoiceXml(korekta({
      correctionType: 'amount_change',
      linesAfter: undefined,
      amountChange: { netDelta: -100, vatDelta: 0, grossDelta: -100, description: 'Rabat', vatRate: 'zw' },
    } as Partial<CorrectionInvoiceData>), { prettyPrint: false });
    expect(xml).toContain('<P_13_7>-100.00</P_13_7>');
    expect(xml).toContain(`<P_19>1</P_19><P_19A>${PODSTAWA}</P_19A>`);
    expect((await validateInvoiceXml(xml)).valid).toBe(true);
  });

  it('korekta bez „zw” dalej z P_19N', () => {
    const xml = generateCorrectionInvoiceXml(korekta({
      linesBefore: [{ ...pozycja(1000), vatRate: '23' }],
      linesAfter: [{ ...pozycja(900), vatRate: '23' }],
    }), { prettyPrint: false });
    expect(xml).toContain('<P_19N>1</P_19N>');
  });
});

function fakturaZw(fa3: Record<string, unknown>, origin = 'app') {
  db.tables.invoices!.push({
    id: PARENT, tenant_id: TENANT, direction: 'outgoing', invoice_kind: 'regular', invoice_type: 'VAT', origin,
    ksef_status: 'accepted', ksef_environment: 'test', ksef_number: KSEF_RODZICA, currency: 'PLN',
    internal_number: 'FV 7/11/2026', issue_date: '2026-11-02',
    net_total: 1000, vat_total: 0, gross_total: 1000,
    seller_nip: '1234567890', seller_data: SPRZEDAWCA, buyer_data: NABYWCA,
    fa3_data: { internalNumber: 'FV 7/11/2026', ...fa3 },
  });
  db.tables.invoice_line_items!.push({
    id: `${PARENT}-1`, invoice_id: PARENT, ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1,
    unit_price_net: 1000, net_amount: 1000, vat_rate: 'zw', vat_amount: 0, gross_amount: 1000,
  });
}

function przedPo() {
  return {
    invoiceType: 'correction', internalNumber: 'FK/1/11/2026', issueDate: '2026-11-16', paymentMethod: 'transfer', paymentDueDate: '2026-11-30',
    parentInvoiceId: PARENT, parentInvoiceNumber: 'FV 7/11/2026', parentInvoiceIssueDate: '2026-11-02', parentKsefNumber: KSEF_RODZICA,
    correctionReason: 'Rabat', typKorekty: '2', correctionType: 'before_after',
    seller: SPRZEDAWCA, buyer: { type: 'b2b', idType: 'nip', ...NABYWCA },
    linesBefore: [{ name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 1000, vatRate: 'zw' }],
    linesAfter: [{ name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 900, vatRate: 'zw' }],
  } as never;
}

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
  db.tables = {
    tenants: [{ id: TENANT, nip: '1234567890', name: 'Firma testowa', address_json: SPRZEDAWCA.address }],
    invoices: [],
    invoice_line_items: [],
  };
});

describe('korekta faktury „zw” w aplikacji: firma zwolniona z VAT (C3)', () => {
  it.each([
    ['faktura FaktWay', 'app', { annotations: { vatExemptionBasis: PODSTAWA } }, 'P_19A', PODSTAWA],
    [
      'faktura K z pliku KSeF (D-A4-1b-3-KORZW)',
      'ksef_import',
      { import: { source: 'ksef' }, annotations: { vatExemptionBasis: 'art. 132 ust. 1 lit. i dyrektywy 2006/112/WE', vatExemptionBasisKind: 'P_19B' } },
      'P_19B',
      'art. 132 ust. 1 lit. i dyrektywy 2006/112/WE',
    ],
  ] as const)('%s: formularz dostaje pozycję „zw”, zapis korekty niesie podstawę, a plik KOR przechodzi XSD', async (_label, origin, fa3, rodzaj, podstawa) => {
    fakturaZw(fa3 as Record<string, unknown>, origin);
    const ctx = await getCorrectionParentContextAction(PARENT);
    expect(ctx.success).toBe(true);
    if (ctx.success) expect(ctx.linesBefore.map((line) => line.vatRate)).toEqual(['zw']);

    const r = await saveCorrectionDraftAction(przedPo(), TENANT);
    expect(r).toMatchObject({ success: true });
    const saved = db.tables.invoices!.find((row) => row.invoice_kind === 'correction') as Row | undefined;
    const correctionData = (saved?.special_data as { correctionData?: CorrectionInvoiceData } | undefined)?.correctionData;
    expect(correctionData?.annotations).toMatchObject({ vatExemptionBasis: podstawa });
    const xml = generateCorrectionInvoiceXml(correctionData!, { prettyPrint: false });
    expect(xml).toContain(`<P_19>1</P_19><${rodzaj}>${podstawa}</${rodzaj}>`);
    expect((await validateInvoiceXml(xml)).valid).toBe(true);
  });

  it('korekta kwotowa faktury „zw” (ustalenie 29): kontekst daje stawkę „zw”, zapis przechodzi, plik KOR z P_19 przechodzi XSD', async () => {
    fakturaZw({ annotations: { vatExemptionBasis: PODSTAWA } });
    const ctx = await getCorrectionParentContextAction(PARENT);
    expect(ctx.success).toBe(true);
    if (ctx.success) expect(ctx.amountChangeVatRate).toBe('zw');
    const r = await saveCorrectionDraftAction({
      ...(przedPo() as Record<string, unknown>),
      correctionType: 'amount_change',
      linesAfter: undefined,
      amountChange: { netDelta: -100, vatDelta: 0, grossDelta: -100, description: 'Rabat', vatRate: 'zw' },
    } as never, TENANT);
    expect(r).toMatchObject({ success: true });
    const saved = db.tables.invoices!.find((row) => row.invoice_kind === 'correction') as Row | undefined;
    const correctionData = (saved?.special_data as { correctionData?: CorrectionInvoiceData } | undefined)?.correctionData;
    const xml = generateCorrectionInvoiceXml(correctionData!, { prettyPrint: false });
    expect(xml).toContain('<P_13_7>-100.00</P_13_7>');
    expect(xml).toContain(`<P_19>1</P_19><P_19A>${PODSTAWA}</P_19A>`);
    expect((await validateInvoiceXml(xml)).valid).toBe(true);
  });

  it('korekta kwotowa faktury „zw” bez podstawy, faktury mieszanej z VAT 0 i z inną stawką od klienta: odmowy z wyjściem (ustalenie 29, uwaga N1)', async () => {
    const kwotowa = (amountChange: Record<string, unknown>) => ({
      ...(przedPo() as Record<string, unknown>),
      correctionType: 'amount_change',
      linesAfter: undefined,
      amountChange: { netDelta: -100, vatDelta: 0, grossDelta: -100, description: 'Rabat', ...amountChange },
    }) as never;

    fakturaZw({});
    const bezPodstawy = await saveCorrectionDraftAction(kwotowa({}), TENANT);
    expect(bezPodstawy.success).toBe(false);
    if (!bezPodstawy.success) expect(bezPodstawy.error).toMatch(/podstawy zwolnienia/);

    // Dalej faktura z podstawą, więc odmowę daje tylko stawka.
    db.tables.invoices![0]!.fa3_data = { internalNumber: 'FV 7/11/2026', annotations: { vatExemptionBasis: PODSTAWA } };
    const inna = await saveCorrectionDraftAction(kwotowa({ vatRate: 'np' }), TENANT);
    expect(inna.success).toBe(false);
    if (!inna.success) expect(inna.error).toMatch(/Stawka korekty kwotowej różni się od stawki faktury pierwotnej/);

    // Faktura mieszana („zw” i 23 %) z VAT 0: stawka nie wynika z kwot, więc odmowa o niejednoznaczności.
    Object.assign(db.tables.invoices![0]!, { net_total: 2000, vat_total: 230, gross_total: 2230 });
    db.tables.invoice_line_items!.push({
      id: `${PARENT}-2`, invoice_id: PARENT, ordinal: 2, name: 'Licencja', unit: 'szt.', quantity: 1,
      unit_price_net: 1000, net_amount: 1000, vat_rate: '23', vat_amount: 230, gross_amount: 1230,
    });
    const mieszana = await saveCorrectionDraftAction(kwotowa({}), TENANT);
    expect(mieszana.success).toBe(false);
    if (!mieszana.success) expect(mieszana.error).toMatch(/w tym np\., np\. II, oo lub zw/);
    expect(db.tables.invoices!.filter((row) => row.invoice_kind === 'correction')).toHaveLength(0);
  });

  it('faktura „zw” bez zapisanej podstawy zwolnienia: odmowa z wyjściem, nic nie zapisane', async () => {
    fakturaZw({});
    const r = await saveCorrectionDraftAction(przedPo(), TENANT);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error).toMatch(/podstawy zwolnienia/);
      expect(r.error).toMatch(/Napisz do nas/);
    }
    expect(db.tables.invoices!.filter((row) => row.invoice_kind === 'correction')).toHaveLength(0);
  });
});
