import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Kopia maila z fakturą do księgowej (plan kompletnej aplikacji, krok 2.8, R1/R2).
 * Prawdziwa `emailInvoiceAction` i kod kopii, atrapa tylko bazy, PDF, poczty
 * i audytu. Niezmienniki: kopia to OSOBNA wiadomość do księgowej (nabywca nie
 * widzi jej adresu, księgowa nie dostaje adresu nabywcy), błąd kopii nie
 * cofa wysyłki do nabywcy, każda kopia jest w audycie.
 */

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
const failures: Record<string, boolean> = {};

function from(name: string) {
  const filters: Array<(r: Row) => boolean> = [];
  const q: Record<string, unknown> = {
    select: () => q,
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
    maybeSingle: async () => {
      if (failures[`${name}:select`]) return { data: null, error: { message: 'boom' } };
      return { data: (tables[name] ?? []).filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null };
    },
  };
  return q;
}

const m = vi.hoisted(() => ({ buyer: vi.fn(), copy: vi.fn(), audit: vi.fn(), pdf: vi.fn(), verify: vi.fn(), load: vi.fn() }));

vi.mock('@/lib/supabase/auth-context', () => ({
  ActionAuthError: class ActionAuthError extends Error {},
  requireUserAndActiveOrg: async () => ({ user: { id: 'user-1' }, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'owner', supabase: { from } }),
}));
vi.mock('@/lib/pdf/invoice-pdf', () => ({ generateInvoicePdf: m.pdf, verifyInvoicePdfDeliveryState: m.verify }));
vi.mock('@/lib/pdf/invoice-data', () => ({ loadInvoiceForPdf: m.load }));
vi.mock('@/lib/email/send', () => ({
  sendInvoiceEmail: m.buyer,
  sendEmail: m.copy,
  invoiceEmailFooter: (s: string) => `stopka ${s}`,
}));
vi.mock('@/lib/audit/log', () => ({ logAudit: m.audit }));
vi.mock('@/lib/storage/r2', () => ({ downloadInvoiceXml: vi.fn() }));

import { emailInvoiceAction } from '@/components/invoices/actions-detail';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INV = '11111111-1111-4111-8111-111111111111';
const BUYER = 'nabywca@example.test';
const ACC = 'ksiegowa@example.test';

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  for (const k of Object.keys(failures)) delete failures[k];
  for (const f of Object.values(m)) f.mockReset();
  m.pdf.mockResolvedValue({ success: true, pdf: Buffer.from('pdf'), filename: 'f.pdf', qrStateKey: 'qr' });
  m.verify.mockResolvedValue(null);
  m.load.mockResolvedValue({
    tenantId: TENANT,
    invoice: { internalNumber: 'FV/1/11', type: 'VAT', seller: { name: 'Moja Firma' }, buyer: { name: 'Klient sp. z o.o.' }, grossTotal: 123, payment: { dueDate: '2026-11-30', amountDue: 123 } },
  });
  m.buyer.mockResolvedValue({ sent: true });
  m.copy.mockResolvedValue({ sent: true });
  tables.tenant_invoice_defaults = [{ tenant_id: TENANT, payment_method: null, payment_days: null, accountant_copy_email: ACC }];
});

describe('kopia maila z fakturą do księgowej', () => {
  it('wysyła osobną wiadomość do księgowej z tym samym PDF, a nabywca dostaje swoją bez zmian', async () => {
    expect(await emailInvoiceAction(INV, BUYER)).toEqual({ success: true });
    expect(m.buyer).toHaveBeenCalledTimes(1);
    expect(m.buyer.mock.calls[0]![0].to).toBe(BUYER);
    expect(m.copy).toHaveBeenCalledTimes(1);
    const kopia = m.copy.mock.calls[0]![0];
    expect(kopia.to).toBe(ACC);
    expect(kopia.attachments).toEqual([expect.objectContaining({ filename: 'f.pdf' })]);
    expect(kopia.subject).toMatch(/kopia/i);
    expect(kopia.subject).toContain('FV/1/11');
    expect(kopia.html).toContain('123,00 PLN');
    expect(kopia.html).toContain('2026-11-30');
  });

  it('adres nabywcy nie trafia do księgowej, adres księgowej nie trafia do nabywcy', async () => {
    await emailInvoiceAction(INV, BUYER);
    const kopia = m.copy.mock.calls[0]![0];
    expect(JSON.stringify(kopia)).not.toContain(BUYER);
    expect(JSON.stringify(m.buyer.mock.calls[0]![0])).not.toContain(ACC);
    expect(kopia.to).not.toContain(BUYER);
  });

  it('kopia to wiadomość tylko do jednego odbiorcy (bez ukrytej kopii z adresami innych)', async () => {
    await emailInvoiceAction(INV, BUYER);
    const kopia = m.copy.mock.calls[0]![0];
    expect(typeof kopia.to).toBe('string');
    expect(kopia).not.toHaveProperty('bcc');
    expect(kopia).not.toHaveProperty('cc');
  });

  it('każda kopia jest w audycie (kto, co, do kogo) osobnym wpisem', async () => {
    await emailInvoiceAction(INV, BUYER);
    const wpisy = m.audit.mock.calls.map((c) => c[0]);
    expect(wpisy).toContainEqual(expect.objectContaining({ action: 'invoice.emailed', entityId: INV, metadata: { recipient: BUYER } }));
    expect(wpisy).toContainEqual(
      expect.objectContaining({ action: 'invoice.emailed', tenantId: TENANT, userId: 'user-1', entityId: INV, metadata: { recipient: ACC, copy: true } }),
    );
  });

  it('błąd kopii nie cofa wysyłki do nabywcy: wynik sukces z informacją o kopii, audyt tylko wysyłki do nabywcy', async () => {
    m.copy.mockResolvedValue({ sent: false, reason: 'error' });
    const r = await emailInvoiceAction(INV, BUYER);
    expect(r).toEqual({ success: true, copyFailed: true });
    expect(m.audit.mock.calls.map((c) => c[0].metadata)).toEqual([{ recipient: BUYER }]);
  });

  it('wyjątek poczty przy kopii też nie psuje wysyłki', async () => {
    m.copy.mockRejectedValue(new Error('sieć'));
    expect(await emailInvoiceAction(INV, BUYER)).toEqual({ success: true, copyFailed: true });
  });

  it('bez ustawionego adresu albo przy błędzie odczytu ustawień: bez kopii, wysyłka działa jak dotąd', async () => {
    tables.tenant_invoice_defaults = [{ tenant_id: TENANT, payment_method: 'cash', payment_days: 7, accountant_copy_email: null }];
    expect(await emailInvoiceAction(INV, BUYER)).toEqual({ success: true });
    expect(m.copy).not.toHaveBeenCalled();
    failures['tenant_invoice_defaults:select'] = true;
    expect(await emailInvoiceAction(INV, BUYER)).toEqual({ success: true });
    expect(m.copy).not.toHaveBeenCalled();
  });

  it('gdy wysyłka do nabywcy się nie udała, kopii nie ma', async () => {
    m.buyer.mockResolvedValue({ sent: false, reason: 'error' });
    const r = await emailInvoiceAction(INV, BUYER);
    expect(r.success).toBe(false);
    expect(m.copy).not.toHaveBeenCalled();
  });

  it('księgowa podana jako nabywca nie dostaje dwóch takich samych maili', async () => {
    await emailInvoiceAction(INV, ACC);
    expect(m.buyer).toHaveBeenCalledTimes(1);
    expect(m.copy).not.toHaveBeenCalled();
  });
});
