import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Domyślne ustawienia firmy dla nowej faktury (plan kompletnej aplikacji,
 * krok 2.8): forma i termin płatności oraz adres księgowej w kopii maila.
 * Tabela `tenant_invoice_defaults` (00209). Atrapa tylko bazy i audytu; kod
 * i akcje prawdziwe. RLS tabeli: tests/rls-ustawienia-domyslne.test.ts.
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

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const m = vi.hoisted(() => ({ role: 'owner' as string, audit: vi.fn() }));

vi.mock('@/lib/supabase/auth-context', () => {
  class ActionAuthError extends Error {}
  const ctx = () => ({ supabase: { from }, user: { id: 'user-1' }, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: m.role });
  return {
    ActionAuthError,
    requireOrgRole: vi.fn(async (roles: string | string[]) => {
      if (!([] as string[]).concat(roles).includes(m.role)) throw new ActionAuthError('Niewystarczające uprawnienia');
      return ctx();
    }),
  };
});
vi.mock('@/lib/audit/log', () => ({ logAudit: m.audit }));

import {
  DEFAULT_PAYMENT_DAYS,
  formDefaultsOf,
  readInvoiceDefaults,
  validateInvoiceDefaults,
} from '@/lib/invoices/invoice-defaults';
import { resetInvoiceDefaultsAction, saveInvoiceDefaultsAction } from '@/app/actions/invoice-defaults';

const wiersze = () => tables.tenant_invoice_defaults ?? [];
const OK = { paymentMethod: 'cash', paymentDays: 30, accountantCopyEmail: 'Ksiegowa@Example.TEST ' };

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  for (const k of Object.keys(failures)) delete failures[k];
  m.role = 'owner';
  m.audit.mockReset();
});

describe('walidacja', () => {
  it('normalizuje: adres małymi literami bez odstępów, puste pola to brak ustawienia', () => {
    expect(validateInvoiceDefaults(OK)).toEqual({ ok: true, paymentMethod: 'cash', paymentDays: 30, accountantCopyEmail: 'ksiegowa@example.test' });
    expect(validateInvoiceDefaults({ paymentMethod: '', paymentDays: null, accountantCopyEmail: '  ' })).toEqual({
      ok: true, paymentMethod: null, paymentDays: null, accountantCopyEmail: null,
    });
  });

  it.each([
    [{ paymentMethod: 'barter' }, /form płatności/i],
    [{ paymentDays: -1 }, /termin/i],
    [{ paymentDays: 91 }, /termin/i],
    [{ paymentDays: 7.5 }, /termin/i],
    [{ paymentDays: '14' }, /termin/i],
    [{ accountantCopyEmail: 'bez-malpy' }, /adres/i],
    [{ accountantCopyEmail: `${'a'.repeat(250)}@x.pl` }, /adres/i],
  ])('odrzuca %j', (zmiana, wzorzec) => {
    const r = validateInvoiceDefaults({ paymentMethod: null, paymentDays: null, accountantCopyEmail: null, ...zmiana });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(wzorzec);
  });

  it('termin 0 dni (płatne od ręki) jest dozwolony', () => {
    expect(validateInvoiceDefaults({ paymentMethod: null, paymentDays: 0, accountantCopyEmail: null }).ok).toBe(true);
  });
});

describe('wartości startowe formularza', () => {
  it('bez ustawień: przelew i 14 dni, jak dotąd', () => {
    expect(DEFAULT_PAYMENT_DAYS).toBe(14);
    expect(formDefaultsOf(null, '2026-11-16')).toEqual({ paymentMethod: 'transfer', paymentDueDate: '2026-11-30' });
  });

  it('z ustawieniami: forma i termin firmy; brakujące pole zostaje domyślne', () => {
    expect(formDefaultsOf({ paymentMethod: 'cash', paymentDays: 30, accountantCopyEmail: null }, '2026-11-16')).toEqual({
      paymentMethod: 'cash', paymentDueDate: '2026-12-16',
    });
    expect(formDefaultsOf({ paymentMethod: null, paymentDays: 7, accountantCopyEmail: null }, '2026-11-16')).toEqual({
      paymentMethod: 'transfer', paymentDueDate: '2026-11-23',
    });
  });
});

describe('odczyt', () => {
  it('zwraca ustawienia firmy, null gdy brak wiersza albo błąd bazy; niepoprawny zapis jest pomijany', async () => {
    const db = { from } as never;
    expect(await readInvoiceDefaults(db, TENANT_ID)).toBeNull();
    tables.tenant_invoice_defaults = [
      { tenant_id: TENANT_ID, payment_method: 'card', payment_days: 21, accountant_copy_email: 'k@example.test' },
      { tenant_id: 'inna-firma', payment_method: 'cash', payment_days: 1, accountant_copy_email: null },
    ];
    expect(await readInvoiceDefaults(db, TENANT_ID)).toEqual({ paymentMethod: 'card', paymentDays: 21, accountantCopyEmail: 'k@example.test' });
    tables.tenant_invoice_defaults = [{ tenant_id: TENANT_ID, payment_method: 'barter', payment_days: 21, accountant_copy_email: null }];
    expect(await readInvoiceDefaults(db, TENANT_ID)).toBeNull();
    failures['tenant_invoice_defaults:select'] = true;
    expect(await readInvoiceDefaults(db, TENANT_ID)).toBeNull();
    expect(await readInvoiceDefaults({} as never, TENANT_ID)).toBeNull();
  });
});

describe('akcje', () => {
  it('właściciel zapisuje, drugi zapis nadpisuje ten sam wiersz, audyt bez adresu w treści wpisu o polu', async () => {
    const r = await saveInvoiceDefaultsAction(OK);
    expect(r).toEqual({ success: true, defaults: { paymentMethod: 'cash', paymentDays: 30, accountantCopyEmail: 'ksiegowa@example.test' } });
    await saveInvoiceDefaultsAction({ ...OK, paymentDays: 7 });
    expect(wiersze()).toHaveLength(1);
    expect(wiersze()[0]).toMatchObject({ tenant_id: TENANT_ID, payment_days: 7, updated_by: 'user-1', accountant_copy_email: 'ksiegowa@example.test' });
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'tenant.updated', tenantId: TENANT_ID, userId: 'user-1', metadata: expect.objectContaining({ field: 'invoice_defaults', change: 'updated' }) }),
    );
  });

  it('administrator tak; członek i księgowa dostają komunikat z wyjściem i nic nie zapisują', async () => {
    m.role = 'admin';
    expect((await saveInvoiceDefaultsAction(OK)).success).toBe(true);
    for (const role of ['member', 'accountant']) {
      m.role = role;
      const r = await saveInvoiceDefaultsAction({ ...OK, paymentDays: 1 });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error).toMatch(/właściciel|administrator/i);
      expect((await resetInvoiceDefaultsAction()).success).toBe(false);
    }
    expect(wiersze()).toHaveLength(1);
    expect(wiersze()[0]).toMatchObject({ payment_days: 30 });
  });

  it('zły adres albo termin: błąd po polsku, brak zapisu', async () => {
    const r = await saveInvoiceDefaultsAction({ ...OK, accountantCopyEmail: 'zly' });
    expect(r.success).toBe(false);
    expect(wiersze()).toHaveLength(0);
  });

  it('błąd bazy to komunikat, bez audytu', async () => {
    failures['tenant_invoice_defaults:upsert'] = true;
    const r = await saveInvoiceDefaultsAction(OK);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/nie udało się zapisać/i);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('powrót do domyślnych kasuje tylko wiersz własnej firmy i trafia do audytu', async () => {
    tables.tenant_invoice_defaults = [
      { tenant_id: TENANT_ID, payment_method: 'cash', payment_days: 1, accountant_copy_email: null },
      { tenant_id: 'inna-firma', payment_method: 'cash', payment_days: 1, accountant_copy_email: null },
    ];
    expect(await resetInvoiceDefaultsAction()).toEqual({ success: true });
    expect(wiersze().map((r) => r.tenant_id)).toEqual(['inna-firma']);
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ metadata: { field: 'invoice_defaults', change: 'reset' } }));
  });
});
