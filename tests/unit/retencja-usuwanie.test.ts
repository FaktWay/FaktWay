import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

/**
 * FZ-005: `cron.retention-delete` a to, co blokuje usunięcie wiersza faktury.
 * Atrapa bazy odrzuca DELETE jak PostgreSQL: oryginał z istniejącą korektą
 * (`parent_invoice_id ... ON DELETE RESTRICT`), fakturę z kosztem
 * (`expenses.ksef_invoice_id` bez `ON DELETE`) i fakturę, której płatność
 * trzyma import z banku (`payment_imports.matched_payment_id`), kodem 23503,
 * a fakturę wysłaną do KSeF strażnikiem cyklu (00132) kodem 42501. Ten sam
 * scenariusz na prawdziwej bazie: `tests/rls-retencja-usuwanie.test.ts`.
 */

type Row = Record<string, unknown>;
const m = vi.hoisted(() => ({
  tabele: { invoices: [] as Row[], expenses: [] as Row[], payments: [] as Row[], payment_imports: [] as Row[] } as Record<string, Row[]>,
  pliki: [] as string[],
  dziennik: [] as Array<{ action: string; entityId: string }>,
}));

vi.mock('@/lib/retention/invoice-files', () => ({
  collectInvoiceStorageKeys: async (_c: unknown, invoice: { id: string }) => ({ r2: [invoice.id], glacier: [], foreign: 0 }),
  deleteInvoiceStorage: async (keys: { r2: string[] }) => {
    m.pliki.push(...keys.r2);
    return keys.r2.length;
  },
}));
vi.mock('@/lib/audit/log-system', () => ({
  logAuditSystem: async (e: { action: string; entityId: string }) => {
    m.dziennik.push({ action: e.action, entityId: e.entityId });
  },
}));

/** Kto trzyma wiersz `invoices` kluczem bez kaskady: korekta (RESTRICT), koszt albo import płatności (NO ACTION). */
function trzymajacy(id: unknown, usuwane: Set<unknown>): boolean {
  const platnosci = new Set(m.tabele.payments.filter((p) => p.invoice_id === id).map((p) => p.id));
  return (
    m.tabele.invoices.some((r) => r.parent_invoice_id === id && !usuwane.has(r.id)) ||
    m.tabele.expenses.some((r) => r.ksef_invoice_id === id) ||
    m.tabele.payment_imports.some((r) => platnosci.has(r.matched_payment_id))
  );
}

/** Gałąź DELETE strażnika cyklu KSeF (00132): żadna rola nie usunie faktury wysłanej do KSeF. */
const strazKsef = (r: Row) =>
  ['queued', 'offline_queued', 'sending'].includes(String(r.ksef_status)) || r.submitted_to_ksef_at != null || r.offline_idempotency_key != null;

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const predicates: Array<(r: Row) => boolean> = [];
      let tryb: 'select' | 'update' | 'delete' = 'select';
      let patch: Row = {};
      let kolejnosc: string | null = null;
      let limit = Infinity;
      const q = {
        select: () => q,
        update: (p: Row) => { tryb = 'update'; patch = p; return q; },
        delete: () => { tryb = 'delete'; return q; },
        not: (k: string, op: string, v: unknown) => { expect([op, v]).toEqual(['is', null]); predicates.push((r) => r[k] != null); return q; },
        lt: (k: string, v: string) => { predicates.push((r) => r[k] != null && Date.parse(String(r[k])) < Date.parse(v)); return q; },
        gt: (k: string, v: string) => { predicates.push((r) => String(r[k]) > v); return q; },
        eq: (k: string, v: unknown) => { predicates.push((r) => r[k] === v); return q; },
        in: (k: string, v: unknown[]) => { expect(v.length).toBeLessThanOrEqual(100); predicates.push((r) => v.includes(r[k])); return q; },
        order: (k: string) => { kolejnosc = k; return q; },
        limit: (n: number) => { limit = n; return q; },
        then: (ok: (v: unknown) => unknown) => {
          const wiersze = m.tabele[table] ?? [];
          const trafione = wiersze.filter((r) => predicates.every((p) => p(r)));
          if (tryb === 'delete') {
            const usuwane = new Set(trafione.map((r) => r.id));
            if (table === 'invoices' && trafione.some(strazKsef)) {
              return Promise.resolve({ data: null, error: { code: '42501', message: 'KSeF document cannot be deleted by this role' } }).then(ok);
            }
            if (table === 'invoices' && trafione.some((r) => trzymajacy(r.id, usuwane))) {
              return Promise.resolve({
                data: null,
                error: { code: '23503', message: 'update or delete on table "invoices" violates foreign key constraint on table "invoices"' },
              }).then(ok);
            }
            m.tabele[table] = wiersze.filter((r) => !usuwane.has(r.id));
            // Płatności faktury znikają kaskadą (00014).
            if (table === 'invoices') m.tabele.payments = m.tabele.payments.filter((p) => !usuwane.has(p.invoice_id));
            return Promise.resolve({ data: null, error: null }).then(ok);
          }
          if (tryb === 'update') {
            for (const r of trafione) Object.assign(r, patch);
            return Promise.resolve({ data: null, error: null }).then(ok);
          }
          const posortowane = kolejnosc ? [...trafione].sort((a, b) => String(a[kolejnosc!]).localeCompare(String(b[kolejnosc!]))) : trafione;
          return Promise.resolve({ data: posortowane.slice(0, limit).map((r) => ({ ...r })), error: null }).then(ok);
        },
      };
      return q;
    },
  }),
}));

import { runRetentionDelete } from '@/lib/jobs/runners/retention-delete';
import { DNI_ODROCZENIA, planUsuniecia } from '@/lib/retention/plan-usuniecia';

const ctx = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n: string, fn: () => unknown) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
} as unknown as JobContext;

const TERAZ = '2034-11-20T03:00:00.000Z';
const PO_TERMINIE = '2034-11-19T23:00:00.000Z';
const TERMIN_KOREKTY = '2036-05-01T22:00:00.000Z';
const DZIEN = 86_400_000;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const faktura = (n: number, z: Row = {}): Row => ({
  id: id(n), tenant_id: 't-1', internal_number: `FV/${n}`, issue_date: '2024-11-15', xml_storage_path: `t-1/${n}.xml`,
  pdf_storage_path: null, archive_storage_path: null, parent_invoice_id: null, scheduled_deletion_at: PO_TERMINIE,
  ksef_status: 'draft', submitted_to_ksef_at: null, offline_idempotency_key: null, ...z,
});
const zostaly = () => m.tabele.invoices.map((r) => r.id).sort();
const termin = (n: number) => m.tabele.invoices.find((r) => r.id === id(n))?.scheduled_deletion_at as string;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(TERAZ));
  m.pliki = [];
  m.dziennik = [];
  m.tabele.payments = [];
  m.tabele.payment_imports = [];
});
afterEach(() => vi.useRealTimers());

describe('retention-delete a korekty i koszty (FZ-005)', () => {
  it('faktury bez blokad usuwa (pliki i wiersz), zablokowane zostają z plikami i odroczonym terminem', async () => {
    m.tabele.invoices = [
      faktura(1), // oryginał z korektą przed terminem
      faktura(2, { parent_invoice_id: id(1), scheduled_deletion_at: TERMIN_KOREKTY }),
      faktura(3), // zwykła
      faktura(4), // z kosztem
      faktura(5), // oryginał, którego korekta też jest po terminie
      faktura(6, { parent_invoice_id: id(5) }),
    ];
    m.tabele.expenses = [{ id: id(90), ksef_invoice_id: id(4) }];

    await expect(runRetentionDelete(ctx)).resolves.toMatchObject({ deleted: 3, postponed: 2 });

    expect(zostaly()).toEqual([id(1), id(2), id(4)]);
    expect(m.pliki.sort()).toEqual([id(3), id(5), id(6)]);
    // Oryginał czeka do terminu korekty; faktura z kosztem 30 dni.
    expect(termin(1)).toBe(TERMIN_KOREKTY);
    expect(Date.parse(termin(4))).toBe(Date.parse(TERAZ) + 30 * DZIEN);
    expect(m.dziennik.filter((d) => d.action === 'retention.deletion_executed').map((d) => d.entityId).sort()).toEqual([id(3), id(5), id(6)]);
    expect(m.dziennik.filter((d) => d.action === 'retention.deletion_postponed').map((d) => d.entityId).sort()).toEqual([id(1), id(4)]);
  });

  it('łańcuch korekt po terminie (korekta korekty): usuwa od najmłodszej, bez błędu klucza', async () => {
    m.tabele.invoices = [faktura(10), faktura(11, { parent_invoice_id: id(10) }), faktura(12, { parent_invoice_id: id(11) })];
    m.tabele.expenses = [];

    await expect(runRetentionDelete(ctx)).resolves.toMatchObject({ deleted: 3, postponed: 0 });
    expect(zostaly()).toEqual([]);
  });

  it('korekta z kosztem blokuje też oryginał: oba czekają, plików nie rusza', async () => {
    m.tabele.invoices = [faktura(20), faktura(21, { parent_invoice_id: id(20) })];
    m.tabele.expenses = [{ id: id(91), ksef_invoice_id: id(21) }];

    await expect(runRetentionDelete(ctx)).resolves.toMatchObject({ deleted: 0, postponed: 2 });
    expect(zostaly()).toEqual([id(20), id(21)]);
    expect(m.pliki).toEqual([]);
  });
});

describe('retention-delete a strażnik KSeF i importy płatności (FZ-005, FZ-016)', () => {
  it('faktura wysłana do KSeF i faktura z płatnością z importu zostają z plikami, reszta idzie', async () => {
    m.tabele.invoices = [
      faktura(30, { ksef_status: 'accepted', submitted_to_ksef_at: '2024-11-15T10:00:00.000Z' }),
      faktura(31),
      faktura(32),
    ];
    m.tabele.expenses = [];
    m.tabele.payments = [{ id: id(80), invoice_id: id(32) }];
    m.tabele.payment_imports = [{ id: id(81), matched_payment_id: id(80) }];

    await expect(runRetentionDelete(ctx)).resolves.toMatchObject({ deleted: 1, postponed: 2 });
    expect(zostaly()).toEqual([id(30), id(32)]);
    expect(m.pliki).toEqual([id(31)]);
    expect(m.dziennik.filter((d) => d.action === 'retention.deletion_executed').map((d) => d.entityId)).toEqual([id(31)]);
  });

  it('oryginał czeka do nowego terminu korekty, która sama czeka na swoją korektę (Z3)', async () => {
    const DALEKO = '2040-01-01T00:00:00.000Z';
    m.tabele.invoices = [
      faktura(40),
      faktura(41, { parent_invoice_id: id(40) }),
      faktura(42, { parent_invoice_id: id(41), scheduled_deletion_at: DALEKO }),
    ];
    m.tabele.expenses = [];

    await expect(runRetentionDelete(ctx)).resolves.toMatchObject({ deleted: 0, postponed: 2 });
    expect([termin(40), termin(41)]).toEqual([DALEKO, DALEKO]);
  });
});

describe('plan usunięcia (FZ-005, funkcja czysta)', () => {
  const teraz = new Date(TERAZ);
  const za30 = new Date(Date.parse(TERAZ) + DNI_ODROCZENIA * DZIEN).toISOString();
  const k = (idK: string, rodzic: string, termin: string | null) => ({ id: idK, parent_invoice_id: rodzic, scheduled_deletion_at: termin });

  it('korekta bez terminu albo z terminem bliżej niż 30 dni: oryginał czeka 30 dni', () => {
    expect(planUsuniecia({ kandydaci: ['o'], korekty: [k('k', 'o', null)], blokady: [], teraz }).odroczone).toEqual([{ id: 'o', termin: za30, powod: 'korekta' }]);
    expect(planUsuniecia({ kandydaci: ['o'], korekty: [k('k', 'o', '2034-11-25T00:00:00.000Z')], blokady: [], teraz }).odroczone[0].termin).toBe(za30);
  });

  it('blokada w głębi łańcucha (koszt przy korekcie korekty) zatrzymuje cały łańcuch', () => {
    const plan = planUsuniecia({ kandydaci: ['o', 'k1', 'k2'], korekty: [k('k1', 'o', null), k('k2', 'k1', null)], blokady: [{ id: 'k2', powod: 'koszt' }], teraz });
    expect(plan.kolejnosc).toEqual([]);
    expect(plan.odroczone.map((x) => [x.id, x.powod]).sort()).toEqual([['k1', 'korekta'], ['k2', 'koszt'], ['o', 'korekta']]);
  });

  it('pętla w parent_invoice_id (dane niespójne): nic z niej nie usuwa', () => {
    const plan = planUsuniecia({ kandydaci: ['a', 'b', 'c'], korekty: [k('a', 'b', null), k('b', 'a', null)], blokady: [], teraz });
    expect(plan.kolejnosc).toEqual(['c']);
    expect(plan.odroczone.map((x) => x.id).sort()).toEqual(['a', 'b']);
  });

  it('korekta przed oryginałem także przy odwrotnej kolejności kandydatów', () => {
    expect(planUsuniecia({ kandydaci: ['o', 'k'], korekty: [k('k', 'o', PO_TERMINIE)], blokady: [], teraz }).kolejnosc).toEqual(['k', 'o']);
  });
});
