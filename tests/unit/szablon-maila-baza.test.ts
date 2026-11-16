import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Własny szablon maila z fakturą (plan kompletnej aplikacji, krok 2.8):
 * odczyt, zapis i powrót do domyślnego (tabela `invoice_email_templates`,
 * 00208), akcje z kontrolą roli i wpisem w audycie, oraz przekazanie szablonu
 * z akcji wysyłki do maila. Atrapa tylko bazy, poczty i PDF; kod prawdziwy.
 * RLS tabeli sprawdza tests/rls-szablon-maila.test.ts.
 */

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
const failures: Record<string, boolean> = {};

function from(name: string) {
  const rows = () => (tables[name] ??= []);
  const filters: Array<(r: Row) => boolean> = [];
  let op: 'select' | 'delete' | 'upsert' = 'select';
  let payload: Row | null = null;
  let conflict: string[] = [];
  const run = () => {
    if (failures[`${name}:${op}`]) return { data: null, error: { code: '42P01', message: 'boom' } };
    if (op === 'upsert') {
      const row = payload!;
      const hit = rows().find((r) => conflict.every((k) => r[k] === row[k]));
      if (hit) Object.assign(hit, row);
      else rows().push({ ...row });
      return { data: null, error: null };
    }
    const hits = rows().filter((r) => filters.every((f) => f(r)));
    if (op === 'delete') {
      tables[name] = rows().filter((r) => !hits.includes(r));
      return { data: null, error: null };
    }
    return { data: hits, error: null };
  };
  const q: Record<string, unknown> = {
    select: () => q,
    delete: () => ((op = 'delete'), q),
    upsert: (row: Row, opts: { onConflict: string }) => ((op = 'upsert'), (payload = row), (conflict = opts.onConflict.split(',')), q),
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
    maybeSingle: () => Promise.resolve(run()).then((r) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data })),
    then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, ko),
  };
  return q;
}

const m = vi.hoisted(() => ({
  role: 'owner' as string,
  audit: vi.fn(),
  pdf: vi.fn(),
  verify: vi.fn(),
  loadInvoice: vi.fn(),
  send: vi.fn(),
}));

vi.mock('@/lib/supabase/auth-context', () => {
  class ActionAuthError extends Error {}
  const ctx = () => ({ supabase: { from }, user: { id: 'user-1' }, tenantId: TENANT_ID, role: m.role });
  return {
    ActionAuthError,
    requireUserAndActiveOrg: vi.fn(async () => ctx()),
    requireOrgRole: vi.fn(async (roles: string | string[]) => {
      if (!([] as string[]).concat(roles).includes(m.role)) throw new ActionAuthError('Niewystarczające uprawnienia');
      return ctx();
    }),
  };
});
vi.mock('@/lib/audit/log', () => ({ logAudit: m.audit }));
vi.mock('@/lib/pdf/invoice-pdf', () => ({ generateInvoicePdf: m.pdf, verifyInvoicePdfDeliveryState: m.verify }));
vi.mock('@/lib/pdf/invoice-data', () => ({ loadInvoiceForPdf: m.loadInvoice }));
vi.mock('@/lib/email/send', () => ({ sendInvoiceEmail: m.send }));
vi.mock('@/lib/storage/r2', () => ({ downloadInvoiceXml: vi.fn() }));

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

import { readInvoiceEmailTemplate } from '@/lib/email/invoice-email-template-store';
import { resetInvoiceEmailTemplateAction, saveInvoiceEmailTemplateAction } from '@/app/actions/invoice-email-template';
import { emailInvoiceAction } from '@/components/invoices/actions-detail';

const wiersze = () => tables.invoice_email_templates ?? [];
const SZABLON = { subject: 'Faktura {numer}', body: 'Dzień dobry,\n\nFaktura {numer} na {kwota}.' };

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  for (const k of Object.keys(failures)) delete failures[k];
  m.role = 'owner';
  m.audit.mockReset();
  m.pdf.mockReset().mockResolvedValue({ success: true, pdf: Buffer.from('pdf'), filename: 'f.pdf', qrStateKey: 'qr' });
  m.verify.mockReset().mockResolvedValue(null);
  m.loadInvoice.mockReset().mockResolvedValue({
    tenantId: TENANT_ID,
    invoice: { internalNumber: 'FV/1/11', type: 'VAT', seller: { name: 'Moja Firma' }, grossTotal: 123, payment: { dueDate: '2026-11-30', amountDue: 123 } },
  });
  m.send.mockReset().mockResolvedValue({ sent: true });
});

describe('zapis szablonu', () => {
  it('właściciel zapisuje szablon; drugi zapis nadpisuje ten sam wiersz', async () => {
    expect(await saveInvoiceEmailTemplateAction(SZABLON)).toEqual({ success: true, template: SZABLON });
    await saveInvoiceEmailTemplateAction({ subject: 'Inny {numer}', body: 'Treść {numer}' });
    expect(wiersze()).toHaveLength(1);
    expect(wiersze()[0]).toMatchObject({ tenant_id: TENANT_ID, subject: 'Inny {numer}', body: 'Treść {numer}', updated_by: 'user-1' });
  });

  it('administrator też; członek i księgowa dostają komunikat z wyjściem', async () => {
    m.role = 'admin';
    expect((await saveInvoiceEmailTemplateAction(SZABLON)).success).toBe(true);
    for (const role of ['member', 'accountant']) {
      m.role = role;
      const r = await saveInvoiceEmailTemplateAction({ subject: 'x {numer}', body: 'x' });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error).toMatch(/właściciel|administrator/i);
    }
    expect(wiersze()).toHaveLength(1);
  });

  it('zły szablon (nieznane pole) nie jest zapisywany, błąd po polsku', async () => {
    const r = await saveInvoiceEmailTemplateAction({ subject: 'Faktura {numr}', body: 'x' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain('{numr}');
    expect(wiersze()).toHaveLength(0);
  });

  it('błąd bazy to komunikat, nie wyjątek', async () => {
    failures['invoice_email_templates:upsert'] = true;
    const r = await saveInvoiceEmailTemplateAction(SZABLON);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/nie udało się zapisać/i);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('zapis i powrót do domyślnego trafiają do audytu', async () => {
    await saveInvoiceEmailTemplateAction(SZABLON);
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'tenant.updated', tenantId: TENANT_ID, userId: 'user-1', metadata: expect.objectContaining({ field: 'invoice_email_template', change: 'updated' }) }));
    await resetInvoiceEmailTemplateAction();
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'tenant.updated', metadata: { field: 'invoice_email_template', change: 'reset' } }));
  });
});

describe('powrót do domyślnego', () => {
  it('kasuje wiersz firmy i nic więcej', async () => {
    tables.invoice_email_templates = [
      { tenant_id: TENANT_ID, subject: 'a', body: 'b' },
      { tenant_id: 'inna-firma', subject: 'c', body: 'd' },
    ];
    expect(await resetInvoiceEmailTemplateAction()).toEqual({ success: true });
    expect(wiersze().map((r) => r.tenant_id)).toEqual(['inna-firma']);
  });

  it('członek nie resetuje', async () => {
    tables.invoice_email_templates = [{ tenant_id: TENANT_ID, subject: 'a', body: 'b' }];
    m.role = 'member';
    expect((await resetInvoiceEmailTemplateAction()).success).toBe(false);
    expect(wiersze()).toHaveLength(1);
  });
});

describe('odczyt szablonu', () => {
  it('zwraca szablon firmy, null gdy brak, null przy błędzie bazy', async () => {
    const db = { from } as never;
    expect(await readInvoiceEmailTemplate(db, TENANT_ID)).toBeNull();
    tables.invoice_email_templates = [{ tenant_id: TENANT_ID, ...SZABLON }, { tenant_id: 'inna-firma', subject: 'c', body: 'd' }];
    expect(await readInvoiceEmailTemplate(db, TENANT_ID)).toEqual(SZABLON);
    failures['invoice_email_templates:select'] = true;
    expect(await readInvoiceEmailTemplate(db, TENANT_ID)).toBeNull();
    expect(await readInvoiceEmailTemplate({} as never, TENANT_ID)).toBeNull();
  });

  it('zapisany w bazie, ale niepoprawny szablon (nieznane pole) jest pomijany: mail idzie domyślny', async () => {
    tables.invoice_email_templates = [{ tenant_id: TENANT_ID, subject: 'Faktura {numr}', body: 'x' }];
    expect(await readInvoiceEmailTemplate({ from } as never, TENANT_ID)).toBeNull();
  });
});

describe('wysyłka faktury mailem z szablonem firmy', () => {
  it('akcja przekazuje szablon firmy do maila, kwota i termin bez zmian', async () => {
    tables.invoice_email_templates = [{ tenant_id: TENANT_ID, ...SZABLON }];
    expect(await emailInvoiceAction('11111111-1111-4111-8111-111111111111', 'nabywca@example.test')).toEqual({ success: true });
    const payload = m.send.mock.calls[0]![0];
    expect(payload.customTemplate).toEqual(SZABLON);
    expect(payload.dueDate).toBe('2026-11-30');
    expect(payload.amountCaption).toBe('Kwota brutto');
    expect(payload.amountLabel.replace(/\s/g, ' ')).toBe('123,00 PLN');
  });

  it('bez szablonu albo przy błędzie odczytu mail idzie domyślny, wysyłka się nie psuje', async () => {
    expect((await emailInvoiceAction('11111111-1111-4111-8111-111111111111', 'nabywca@example.test')).success).toBe(true);
    expect(m.send.mock.calls[0]![0].customTemplate ?? null).toBeNull();
    failures['invoice_email_templates:select'] = true;
    expect((await emailInvoiceAction('11111111-1111-4111-8111-111111111111', 'nabywca@example.test')).success).toBe(true);
    expect(m.send.mock.calls[1]![0].customTemplate ?? null).toBeNull();
  });
});
