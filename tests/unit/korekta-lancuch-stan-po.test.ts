import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Noc 2026-11-17, KOR-02 (łańcuch korekt K4). `correctionBaseline` opisuje
 * stan pozycji jako „pozycje ostatniej przyjętej korekty »przed/po«, a bez
 * takiej korekty pozycje pierwotne”. Po korekcie kwotowej brał jednak zawsze
 * pozycje pierwotne, także gdy wcześniej w łańcuchu była przyjęta „przed/po”.
 * Reprodukcja: FV 10 × 100 zł w 23%, KOR1 „przed/po” zmienia stawkę na 8%
 * (przyjęta), KOR2 kwotowa −100 zł w 8% (przyjęta). Kolejna korekta kwotowa
 * w 8% (stawka, którą faktura dziś ma) dostawała odmowę „faktura nie ma pozycji
 * w tej stawce”, a kwotowa w 23% (stawki już nie ma) przechodziła.
 * Harness jak w tests/unit/korekta-lancuch.test.ts.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const PARENT = '00000000-0000-4000-8000-000000000001';
const KOR1 = '00000000-0000-4000-8000-000000000101';
const KOR2 = '00000000-0000-4000-8000-000000000102';
type Row = Record<string, unknown>;
const st = vi.hoisted(() => ({
  inserted: [] as Row[],
  corrections: [] as Row[],
  linesByInvoice: {} as Record<string, Row[]>,
  /** Sumy faktury pierwotnej; domyślnie 10 × 100 zł w 23%. */
  sumyRodzica: { net_total: 1000, vat_total: 230, gross_total: 1230 } as Row,
  parentOverride: {} as Row,
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/xml/invoice-calculator', async (orig) => ({
  ...(await orig<typeof import('@/lib/xml/invoice-calculator')>()),
  validateNipChecksum: () => true,
}));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: vi.fn() }));
vi.mock('@/lib/supabase/auth-context', () => ({
  requireUserAndActiveOrg: async () => {
    const { createClient } = await import('@/lib/supabase/server');
    return { supabase: await createClient(), user: { id: 'fixture-user' }, tenantId: TENANT, role: 'owner' };
  },
  ActionAuthError: class ActionAuthError extends Error {},
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const parent = {
        id: PARENT, tenant_id: TENANT, issue_date: '2026-09-30', internal_number: 'FV 1/09/2026', ksef_number: 'KSEF-TEST-1',
        ...st.sumyRodzica, fa3_data: null,
        seller_data: { nip: '1234567890', name: 'Firma testowa', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } },
        buyer_data: { nip: '1234567890', name: 'Nabywca testowy', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' } },
        ...st.parentOverride,
      };
      const result = () => {
        if (table === 'tenants') return { data: { id: TENANT, nip: '1234567890', name: 'Firma testowa', address_json: null }, error: null };
        if (table === 'invoice_line_items') return { data: st.linesByInvoice[String(filters.invoice_id)] ?? [], error: null };
        if (table === 'invoices' && 'parent_invoice_id' in filters) {
          return { data: st.corrections.filter((c) => c.parent_invoice_id === filters.parent_invoice_id), error: null };
        }
        if (table === 'invoices') return { data: filters.id === PARENT ? parent : null, error: null };
        return { data: [], error: null };
      };
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => { filters[k] = v; return q; },
        order: () => q,
        maybeSingle: async () => result(),
        single: async () => result(),
        then: (ok: (v: unknown) => unknown) => Promise.resolve(result()).then(ok),
        insert: (payload: Row) => {
          if (table === 'invoices') st.inserted.push(payload);
          return table === 'invoices'
            ? { select: () => ({ single: async () => ({ data: { id: 'inv-new' }, error: null }) }) }
            : Promise.resolve({ error: null });
        },
        delete: () => q,
      };
      return q;
    },
  }),
}));

import { getCorrectionParentContextAction, saveCorrectionDraftAction } from '@/components/invoices/correction-actions';

vi.stubEnv('KSEF_ENV', 'test');

const line = (quantity: number) => ({ name: 'Usługa', unit: 'szt.', quantity, unitPriceNet: 100, vatRate: '23' });
const dbLine = (quantity: number) => ({ name: 'Usługa', unit: 'szt.', quantity, unit_price_net: 100, vat_rate: '23' });
function payload(o: Record<string, unknown>) {
  return {
    invoiceType: 'correction',
    internalNumber: 'FK/2/10/2026',
    issueDate: '2026-10-03',
    paymentMethod: 'transfer',
    paymentDueDate: '2026-10-17',
    parentInvoiceId: PARENT,
    parentInvoiceNumber: 'FV 1/09/2026',
    parentInvoiceIssueDate: '2026-09-30',
    parentKsefNumber: 'KSEF-TEST-1',
    correctionReason: 'Kolejna reklamacja',
    typKorekty: '2',
    seller: { nip: '1234567890', name: 'Firma testowa', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } },
    buyer: { type: 'b2b', idType: 'nip', nip: '1234567890', name: 'Nabywca testowy', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' } },
    ...o,
  } as never;
}

const w8 = (quantity: number) => ({ ...line(quantity), vatRate: '8' });
const db8 = (quantity: number) => ({ ...dbLine(quantity), vat_rate: '8' });

/** KOR1 „przed/po”: 10 × 100 zł z 23% na 8% (różnica 0 / −150 / −150), przyjęta. */
const kor1 = (o: Row = {}): Row => ({
  id: KOR1, tenant_id: TENANT, parent_invoice_id: PARENT, invoice_kind: 'correction', internal_number: 'FK/1/10/2026',
  correction_type: 'before_after', ksef_status: 'accepted', ksef_accepted_at: '2026-10-02T10:00:00Z', created_at: '2026-10-02T09:00:00Z',
  net_total: 0, vat_total: -150, gross_total: -150, ...o,
});
/** KOR2 kwotowa: −100 zł netto w 8% (−100 / −8 / −108), przyjęta po KOR1. */
const kor2 = (o: Row = {}): Row => ({
  id: KOR2, tenant_id: TENANT, parent_invoice_id: PARENT, invoice_kind: 'correction', internal_number: 'FK/2/10/2026',
  correction_type: 'amount_change', ksef_status: 'accepted', ksef_accepted_at: '2026-10-05T10:00:00Z', created_at: '2026-10-05T09:00:00Z',
  net_total: -100, vat_total: -8, gross_total: -108, ...o,
});

beforeEach(() => {
  st.inserted = [];
  st.corrections = [kor1(), kor2()];
  st.sumyRodzica = { net_total: 1000, vat_total: 230, gross_total: 1230 };
  st.parentOverride = {};
  st.linesByInvoice = { [PARENT]: [dbLine(10)], [KOR1]: [db8(10)] };
});

describe('łańcuch korekt (K4): po korekcie kwotowej pozycje to stan po ostatniej „przed/po”', () => {
  it('formularz dostaje „stan przed” = pozycje po KOR1 (8%), nie pozycje pierwotne (23%)', async () => {
    const ctx = await getCorrectionParentContextAction(PARENT);
    expect(ctx).toMatchObject({ success: true, allowedCorrectionTypes: 'amount_change_only', grossTotal: 972 });
    if (ctx.success) expect(ctx.linesBefore).toEqual([w8(10)]);
  });

  it('kolejna korekta kwotowa w 8% (stawka faktury po KOR1) przechodzi', async () => {
    const r = await saveCorrectionDraftAction(payload({
      internalNumber: 'FK/3/10/2026',
      correctionType: 'amount_change',
      amountChange: { netDelta: -50, vatDelta: -4, grossDelta: -54, description: 'Rabat' },
    }), TENANT);
    expect(r).toMatchObject({ success: true });
    expect(st.inserted[0]).toEqual(expect.objectContaining({ net_total: -50, vat_total: -4, gross_total: -54 }));
  });

  it('korekta kwotowa w 23% (stawki po KOR1 już nie ma): odmowa', async () => {
    const r = await saveCorrectionDraftAction(payload({
      internalNumber: 'FK/3/10/2026',
      correctionType: 'amount_change',
      amountChange: { netDelta: -50, vatDelta: -11.5, grossDelta: -61.5, description: 'Rabat' },
    }), TENANT);
    expect(r).toMatchObject({ success: false, error: expect.stringContaining('23%') });
    expect(st.inserted).toHaveLength(0);
  });

  it('pozycje KOR1 niezgodne z sumami do KOR1 włącznie: odmowa, bez zgadywania', async () => {
    st.corrections = [kor1({ vat_total: -100, gross_total: -100 }), kor2()]; // wiersze KOR1 mówią 8% (VAT 80), różnica mówi VAT 130
    const r = await saveCorrectionDraftAction(payload({
      internalNumber: 'FK/3/10/2026',
      correctionType: 'amount_change',
      amountChange: { netDelta: -50, vatDelta: -4, grossDelta: -54, description: 'Rabat' },
    }), TENANT);
    expect(r).toMatchObject({ success: false, error: expect.stringContaining('nie zgadza się z sumami') });
    expect(st.inserted).toHaveLength(0);
  });

  it('bez „przed/po” w łańcuchu (tylko kwotowe) pozycje zostają pierwotne', async () => {
    st.corrections = [kor2({ net_total: -100, vat_total: -23, gross_total: -123 })];
    const ctx = await getCorrectionParentContextAction(PARENT);
    expect(ctx).toMatchObject({ success: true, allowedCorrectionTypes: 'amount_change_only', grossTotal: 1107 });
    if (ctx.success) expect(ctx.linesBefore).toEqual([line(10)]);
  });
});
