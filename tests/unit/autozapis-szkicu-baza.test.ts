import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Autozapis formularza zwykłej faktury (plan kompletnej aplikacji, krok 2.8):
 * warstwa bazy i akcje serwera. Atrapa tylko bazy (tabele w pamięci), kod
 * i akcje prawdziwe. RLS tabeli sprawdza tests/rls-autozapis-formularza.test.ts.
 */

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};

function from(name: string) {
  const rows = () => (tables[name] ??= []);
  const filters: Array<(r: Row) => boolean> = [];
  let op: 'select' | 'delete' | 'upsert' = 'select';
  let payload: Row | null = null;
  let conflict: string[] = [];
  let limit = Infinity;
  let sortDesc: string | null = null;
  const run = () => {
    if (op === 'upsert') {
      const row = payload!;
      const hit = rows().find((r) => conflict.every((k) => r[k] === row[k]));
      if (hit) Object.assign(hit, row);
      else rows().push({ ...row });
      return { data: null, error: null };
    }
    let hits = rows().filter((r) => filters.every((f) => f(r)));
    if (op === 'delete') {
      tables[name] = rows().filter((r) => !hits.includes(r));
      return { data: null, error: null };
    }
    if (sortDesc) hits = [...hits].sort((a, b) => String(b[sortDesc!]).localeCompare(String(a[sortDesc!])));
    return { data: hits.slice(0, limit), error: null };
  };
  const q: Record<string, unknown> = {
    select: () => q,
    delete: () => ((op = 'delete'), q),
    upsert: (row: Row, opts: { onConflict: string }) => ((op = 'upsert'), (payload = row), (conflict = opts.onConflict.split(',')), q),
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
    in: (k: string, v: unknown[]) => (filters.push((r) => v.includes(r[k])), q),
    gte: (k: string, v: string) => (filters.push((r) => String(r[k]) >= v), q),
    lt: (k: string, v: string) => (filters.push((r) => String(r[k]) < v), q),
    order: (k: string) => ((sortDesc = k), q),
    limit: (n: number) => ((limit = n), q),
    then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, ko),
  };
  return q;
}

const m = vi.hoisted(() => ({ tenant: '', user: '' }));
vi.mock('@/lib/supabase/auth-context', () => ({
  requireUserAndActiveOrg: vi.fn(async (check?: { expectedTenantId?: string }) => {
    if (check?.expectedTenantId && check.expectedTenantId !== m.tenant) throw new Error('Firma w formularzu jest inna niż aktywna');
    return { supabase: { from }, user: { id: m.user }, tenantId: m.tenant };
  }),
}));

import { loadInvoiceAutosave, saveInvoiceAutosave } from '@/lib/invoices/form-autosave';
import { discardInvoiceAutosaveAction, saveInvoiceAutosaveAction } from '@/app/actions/invoice-autosave';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY = '11111111-1111-4111-8111-111111111111';
const KEY2 = '22222222-2222-4222-8222-222222222222';
const dzien = (dni: number) => new Date(Date.now() - dni * 86_400_000).toISOString();
const db = () => ({ from }) as never;
const wiersze = () => tables.invoice_form_drafts ?? [];

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  m.tenant = TENANT;
  m.user = USER;
});

describe('zapis autozapisu', () => {
  it('ten sam klucz zapisany dwa razy to jeden wiersz z ostatnimi wartościami', async () => {
    const a = await saveInvoiceAutosave(db(), { tenantId: TENANT, userId: USER, requestKey: KEY, values: { buyerName: 'Acme' } });
    const b = await saveInvoiceAutosave(db(), { tenantId: TENANT, userId: USER, requestKey: KEY, values: { buyerName: 'Acme sp. z o.o.' } });
    expect(a.ok && b.ok).toBe(true);
    expect(wiersze()).toHaveLength(1);
    expect(wiersze()[0]).toMatchObject({ tenant_id: TENANT, user_id: USER, request_key: KEY, form_values: { buyerName: 'Acme sp. z o.o.' } });
  });

  it('inny klucz to osobny wiersz (drugie otwarcie formularza)', async () => {
    await saveInvoiceAutosave(db(), { tenantId: TENANT, userId: USER, requestKey: KEY, values: { buyerName: 'A' } });
    await saveInvoiceAutosave(db(), { tenantId: TENANT, userId: USER, requestKey: KEY2, values: { buyerName: 'B' } });
    expect(wiersze()).toHaveLength(2);
  });

  it('gdy faktura z tym kluczem już istnieje, nie tworzy wiersza (zapis wyprzedził autozapis)', async () => {
    tables.invoices = [{ tenant_id: TENANT, number_request_key: KEY }];
    const r = await saveInvoiceAutosave(db(), { tenantId: TENANT, userId: USER, requestKey: KEY, values: { buyerName: 'A' } });
    expect(r).toEqual({ ok: false, reason: 'already_saved' });
    expect(wiersze()).toHaveLength(0);
  });

  it('odrzuca wartości, które nie są obiektem, i zbyt duże', async () => {
    for (const values of [null, 'x', [1, 2], { a: 'x'.repeat(200_001) }]) {
      const r = await saveInvoiceAutosave(db(), { tenantId: TENANT, userId: USER, requestKey: KEY, values });
      expect(r.ok).toBe(false);
    }
    expect(wiersze()).toHaveLength(0);
  });

  it('odrzuca klucz, który nie jest identyfikatorem', async () => {
    const r = await saveInvoiceAutosave(db(), { tenantId: TENANT, userId: USER, requestKey: 'abc', values: { a: 1 } });
    expect(r.ok).toBe(false);
  });

  it('nie zapisuje pól faktury cyklicznej i proformy (te tryby mają własną drogę)', async () => {
    await saveInvoiceAutosave(db(), {
      tenantId: TENANT, userId: USER, requestKey: KEY,
      values: { buyerName: 'A', recurringInvoiceId: 'x', recurringPeriod: '2026-11', salesQuoteId: 'y', salesQuoteSeq: '1' },
    });
    expect(wiersze()[0]!.form_values).toEqual({ buyerName: 'A' });
  });

  it('przy zapisie usuwa własne wiersze starsze niż 30 dni', async () => {
    tables.invoice_form_drafts = [
      { tenant_id: TENANT, user_id: USER, request_key: KEY2, form_values: {}, updated_at: dzien(31) },
      { tenant_id: TENANT, user_id: 'inna-osoba', request_key: KEY2, form_values: {}, updated_at: dzien(40) },
    ];
    await saveInvoiceAutosave(db(), { tenantId: TENANT, userId: USER, requestKey: KEY, values: { buyerName: 'A' } });
    expect(wiersze().map((r) => `${r.user_id}:${r.request_key}`).sort()).toEqual([`${USER}:${KEY}`, `inna-osoba:${KEY2}`].sort());
  });
});

describe('odczyt do przywrócenia', () => {
  it('zwraca najnowszy wiersz tej osoby w tej firmie', async () => {
    tables.invoice_form_drafts = [
      { tenant_id: TENANT, user_id: USER, request_key: KEY, form_values: { buyerName: 'Starszy' }, updated_at: dzien(2) },
      { tenant_id: TENANT, user_id: USER, request_key: KEY2, form_values: { buyerName: 'Nowszy' }, updated_at: dzien(1) },
      { tenant_id: TENANT, user_id: 'inna-osoba', request_key: KEY, form_values: { buyerName: 'Cudzy' }, updated_at: dzien(0) },
    ];
    const r = await loadInvoiceAutosave(db(), TENANT, USER);
    expect(r).toMatchObject({ requestKey: KEY2, values: { buyerName: 'Nowszy' } });
  });

  it('pomija i usuwa wiersz, z którego faktura już jest zapisana', async () => {
    tables.invoice_form_drafts = [
      { tenant_id: TENANT, user_id: USER, request_key: KEY2, form_values: { buyerName: 'Zapisany' }, updated_at: dzien(0) },
      { tenant_id: TENANT, user_id: USER, request_key: KEY, form_values: { buyerName: 'Otwarty' }, updated_at: dzien(1) },
    ];
    tables.invoices = [{ tenant_id: TENANT, number_request_key: KEY2 }];
    const r = await loadInvoiceAutosave(db(), TENANT, USER);
    expect(r?.requestKey).toBe(KEY);
    expect(wiersze().map((x) => x.request_key)).toEqual([KEY]);
  });

  it('ignoruje wiersze starsze niż 30 dni i zwraca null, gdy nic nie ma', async () => {
    tables.invoice_form_drafts = [{ tenant_id: TENANT, user_id: USER, request_key: KEY, form_values: { a: 1 }, updated_at: dzien(31) }];
    expect(await loadInvoiceAutosave(db(), TENANT, USER)).toBeNull();
  });

  it('błąd bazy to null, nie wyjątek (formularz otwiera się pusty)', async () => {
    const zepsuta = { from: () => { throw new Error('PGRST205'); } } as never;
    expect(await loadInvoiceAutosave(zepsuta, TENANT, USER)).toBeNull();
  });
});

describe('akcje serwera', () => {
  it('zapis idzie na osobę i firmę z sesji, klucz z pola numberRequestKey', async () => {
    const r = await saveInvoiceAutosaveAction({ buyerName: 'Acme', numberRequestKey: KEY }, TENANT);
    expect(r.ok).toBe(true);
    expect(wiersze()[0]).toMatchObject({ tenant_id: TENANT, user_id: USER, request_key: KEY });
  });

  it('bez klucza zapisu nic nie zapisuje', async () => {
    const r = await saveInvoiceAutosaveAction({ buyerName: 'Acme' }, TENANT);
    expect(r.ok).toBe(false);
    expect(wiersze()).toHaveLength(0);
  });

  it('odmawia, gdy firma formularza nie jest aktywną (przełączono firmę w innej karcie)', async () => {
    const r = await saveInvoiceAutosaveAction({ buyerName: 'Acme', numberRequestKey: KEY }, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    expect(r.ok).toBe(false);
    expect(wiersze()).toHaveLength(0);
  });

  it('porzucenie kasuje tylko własny wiersz o tym kluczu', async () => {
    tables.invoice_form_drafts = [
      { tenant_id: TENANT, user_id: USER, request_key: KEY, form_values: {}, updated_at: dzien(0) },
      { tenant_id: TENANT, user_id: USER, request_key: KEY2, form_values: {}, updated_at: dzien(0) },
      { tenant_id: TENANT, user_id: 'inna-osoba', request_key: KEY, form_values: {}, updated_at: dzien(0) },
    ];
    await discardInvoiceAutosaveAction(KEY, TENANT);
    expect(wiersze().map((r) => `${r.user_id}:${r.request_key}`).sort()).toEqual([`${USER}:${KEY2}`, `inna-osoba:${KEY}`].sort());
  });
});
