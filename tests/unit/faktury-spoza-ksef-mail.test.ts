import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 1.6 (2b), zabezpieczenia: wpis spoza KSeF nie idzie mailem do nabywcy.
 * Prawdziwa `emailInvoiceAction`, atrapa tylko loadera, PDF, poczty, limitu i audytu.
 * Odmowa ma nazwę dokumentu i mówi, co zrobić; poczta, kopia i audyt nie ruszają;
 * zwykła faktura (kontrola, że test nie przechodzi „z pustego”) wysyła się dalej.
 */

const m = vi.hoisted(() => ({ buyer: vi.fn(), copy: vi.fn(), audit: vi.fn(), pdf: vi.fn(), verify: vi.fn(), load: vi.fn(), limit: vi.fn() }));

vi.mock('@/lib/supabase/auth-context', () => ({
  ActionAuthError: class ActionAuthError extends Error {},
  requireUserAndActiveOrg: async () => ({ user: { id: 'user-1' }, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'owner', supabase: {} }),
}));
vi.mock('@/lib/pdf/invoice-pdf', () => ({ generateInvoicePdf: m.pdf, verifyInvoicePdfDeliveryState: m.verify }));
vi.mock('@/lib/pdf/invoice-data', () => ({ loadInvoiceForPdf: m.load }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: m.limit }));
vi.mock('@/lib/email/send', () => ({
  sendInvoiceEmail: m.buyer,
  sendEmail: m.copy,
  invoiceEmailFooter: (s: string) => `stopka ${s}`,
}));
vi.mock('@/lib/audit/log', () => ({ logAudit: m.audit }));
vi.mock('@/lib/storage/r2', () => ({ downloadInvoiceXml: vi.fn() }));

import { emailInvoiceAction } from '@/components/invoices/actions-detail';
import { MAIL_SPOZA_KSEF_ODMOWA } from '@/lib/import/outside-ksef-teksty';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INV = '11111111-1111-4111-8111-111111111111';
const BUYER = 'nabywca@example.test';

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.limit.mockResolvedValue({ allowed: true });
  m.pdf.mockResolvedValue({ success: true, pdf: Buffer.from('pdf'), filename: 'f.pdf', qrStateKey: 'qr' });
  m.verify.mockResolvedValue(null);
  m.load.mockResolvedValue({
    tenantId: TENANT,
    invoice: { internalNumber: 'FV/7/2026', type: 'VAT', seller: { name: 'Moja Firma' }, buyer: { name: 'Klient sp. z o.o.' }, grossTotal: 123, payment: { dueDate: '2026-11-30', amountDue: 123 } },
  });
  m.buyer.mockResolvedValue({ sent: true });
  m.copy.mockResolvedValue({ sent: true });
});

const dane = (outsideKsef: boolean) => ({
  tenantId: TENANT,
  outsideKsef,
  invoice: { internalNumber: 'FV/7/2026', type: 'VAT', seller: { name: 'Moja Firma' }, buyer: { name: 'Klient sp. z o.o.' }, grossTotal: 123, payment: { dueDate: '2026-11-30', amountDue: 123 } },
});

describe('mail z fakturą: wpis spoza KSeF', () => {
  it('odmawia z nazwą dokumentu i wskazówką, bez poczty, kopii i audytu wysyłki', async () => {
    m.load.mockResolvedValue(dane(true));
    const r = await emailInvoiceAction(INV, BUYER);
    expect(r).toEqual({ success: false, error: MAIL_SPOZA_KSEF_ODMOWA('FV/7/2026') });
    const blad = (r as { error: string }).error;
    expect(blad).toContain('FV/7/2026');
    expect(blad).toContain('poza KSeF');
    expect(blad).toContain('oryginał');
    expect(m.buyer).not.toHaveBeenCalled();
    expect(m.copy).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('odmawia także, gdy PDF wpisu nie ma kodu QR (komunikat o wpisie, nie o QR)', async () => {
    m.load.mockResolvedValue(dane(true));
    m.pdf.mockResolvedValue({ success: true, pdf: Buffer.from('pdf'), filename: 'f.pdf', qrStateKey: 'qr', missingKodI: true });
    const r = await emailInvoiceAction(INV, BUYER);
    expect((r as { error: string }).error).toContain('poza KSeF');
    expect(m.buyer).not.toHaveBeenCalled();
  });

  it('brak danych faktury odmawia (fail-closed)', async () => {
    m.load.mockResolvedValue(null);
    const r = await emailInvoiceAction(INV, BUYER);
    expect(r.success).toBe(false);
    expect(m.buyer).not.toHaveBeenCalled();
  });

  it('zwykła faktura wysyła się dalej (kontrola, że test nie przechodzi z pustego)', async () => {
    m.load.mockResolvedValue(dane(false));
    expect(await emailInvoiceAction(INV, BUYER)).toEqual({ success: true });
    expect(m.buyer).toHaveBeenCalledTimes(1);
  });
});
