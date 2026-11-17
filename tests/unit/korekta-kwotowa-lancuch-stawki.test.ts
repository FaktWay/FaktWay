import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * KOR-03 (noc 2026-11-17, po KOR-01 i KOR-02): „nie poniżej zera w stawce”
 * także po przyjętej korekcie kwotowej. Każda korekta kwotowa ma jedną stawkę,
 * wyznaczoną z jej kwot (`resolveAmountChangeVatRate`), więc stan stawki po
 * łańcuchu to pozycje (ostatnia „przed/po” albo faktura pierwotna) plus różnice
 * przyjętych korekt kwotowych w ich stawkach. Reprodukcja: FV 1 000 zł w 23%
 * i 1 000 zł w 8%, KOR1 kwotowa −600 zł w 23% przyjęta; KOR2 −600 zł w 23%
 * przechodziła (suma 800 zł), a stawka 23% schodziła do −200 zł.
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

import { saveCorrectionDraftAction } from '@/components/invoices/correction-actions';

vi.stubEnv('KSEF_ENV', 'test');

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

const db8 = (quantity: number) => ({ ...dbLine(quantity), vat_rate: '8' });

/** Przyjęta korekta w łańcuchu: domyślnie kwotowa −600 zł w 23% (−600 / −138 / −738). */
const kor = (id: string, nr: number, o: Row = {}): Row => ({
  id, tenant_id: TENANT, parent_invoice_id: PARENT, invoice_kind: 'correction', internal_number: `FK/${nr}/10/2026`,
  correction_type: 'amount_change', ksef_status: 'accepted',
  ksef_accepted_at: `2026-10-0${nr}T10:00:00Z`, created_at: `2026-10-0${nr}T09:00:00Z`,
  net_total: -600, vat_total: -138, gross_total: -738, ...o,
});

const kwotowa = (netDelta: number, vatDelta: number, grossDelta: number) => payload({
  internalNumber: 'FK/9/10/2026',
  correctionType: 'amount_change',
  amountChange: { netDelta, vatDelta, grossDelta, description: 'Rabat' },
});

beforeEach(() => {
  st.inserted = [];
  st.corrections = [];
  st.sumyRodzica = { net_total: 2000, vat_total: 310, gross_total: 2310 };
  st.parentOverride = {};
  st.linesByInvoice = { [PARENT]: [dbLine(10), db8(10)] };
});

describe('KOR-03: po przyjętej korekcie kwotowej stawka też nie schodzi poniżej zera', () => {
  it('KOR1 −600 zł w 23%, KOR2 −600 zł w 23%: odmowa (23% schodzi do −200 zł, suma 800 zł)', async () => {
    st.corrections = [kor(KOR1, 1)];
    const r = await saveCorrectionDraftAction(kwotowa(-600, -138, -738), TENANT);
    expect(r).toMatchObject({ success: false, error: expect.stringContaining('stawce 23%') });
    expect(r).toMatchObject({ error: expect.stringContaining('poniżej zera') });
    // Po korekcie kwotowej wolno tylko kwotową: komunikat nie odsyła do „przed / po”.
    expect(r).toMatchObject({ error: expect.stringContaining('osobna korekta kwotowa') });
    expect(st.inserted).toHaveLength(0);
  });

  it('KOR1 −600 zł w 23%, KOR2 −400 zł w 23% (stawka do zera): przechodzi', async () => {
    st.corrections = [kor(KOR1, 1)];
    const r = await saveCorrectionDraftAction(kwotowa(-400, -92, -492), TENANT);
    expect(r).toMatchObject({ success: true });
  });

  it('KOR1 +500 zł w 23% (podwyżka), KOR2 −1 200 zł w 23%: przechodzi (w 23% zostaje 300 zł)', async () => {
    st.corrections = [kor(KOR1, 1, { net_total: 500, vat_total: 115, gross_total: 615 })];
    const r = await saveCorrectionDraftAction(kwotowa(-1200, -276, -1476), TENANT);
    expect(r).toMatchObject({ success: true });
  });

  it('KOR1 −600 zł w 8%, KOR2 −600 zł w 23%: przechodzi (każda stawka zostaje dodatnia)', async () => {
    st.corrections = [kor(KOR1, 1, { net_total: -600, vat_total: -48, gross_total: -648 })];
    const r = await saveCorrectionDraftAction(kwotowa(-600, -138, -738), TENANT);
    expect(r).toMatchObject({ success: true });
  });

  it('„przed/po” 23% 10 → 5, potem kwotowa −300 zł w 23%, potem −300 zł w 23%: odmowa', async () => {
    st.corrections = [
      kor(KOR1, 1, { correction_type: 'before_after', net_total: -500, vat_total: -115, gross_total: -615 }),
      kor(KOR2, 2, { net_total: -300, vat_total: -69, gross_total: -369 }),
    ];
    st.linesByInvoice = { [PARENT]: [dbLine(10), db8(10)], [KOR1]: [dbLine(5), db8(10)] };
    const r = await saveCorrectionDraftAction(kwotowa(-300, -69, -369), TENANT);
    expect(r).toMatchObject({ success: false, error: expect.stringContaining('stawce 23%') });
    expect(st.inserted).toHaveLength(0);
  });

  it('kwoty przyjętej korekty kwotowej bez jednej stawki: odmowa z numerem korekty, bez zgadywania', async () => {
    st.corrections = [kor(KOR1, 1, { net_total: -600, vat_total: -100, gross_total: -700 })];
    const r = await saveCorrectionDraftAction(kwotowa(-10, -2.3, -12.3), TENANT);
    expect(r).toMatchObject({ success: false, error: expect.stringContaining('FK/1/10/2026') });
    expect(st.inserted).toHaveLength(0);
  });

  it('stary łańcuch ze stawką już ujemną (KOR1 −1 500 zł w 23%): podwyżka +200 zł w 23% przechodzi', async () => {
    // Taki stan mógł powstać przed tą regułą (KSeF TEST). Podwyżka go nie
    // pogarsza, więc nie dostaje odmowy „obniżyłaby”.
    st.corrections = [kor(KOR1, 1, { net_total: -1500, vat_total: -345, gross_total: -1845 })];
    const r = await saveCorrectionDraftAction(kwotowa(200, 46, 246), TENANT);
    expect(r).toMatchObject({ success: true });
  });
});
