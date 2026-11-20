import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Retencja kopii roboczych formularza faktury (plan kompletnej aplikacji,
 * krok 2.8, 00207): wiersz z danymi nabywcy znika po 30 dniach także wtedy,
 * gdy nikt nie wraca do formularza. Nocny job `cron.cleanup-invoice-form-drafts`.
 * Atrapa tylko bazy (tabela w pamięci stosuje filtr `lt`), runner prawdziwy.
 */

type Row = { tenant_id: string; user_id: string; request_key: string; updated_at: string };
const s = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, error: null as null | string, calls: 0 }));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table !== 'invoice_form_drafts') throw new Error(`nieoczekiwana tabela ${table}`);
      return {
        delete: (_opts?: { count?: string }) => ({
          lt: async (col: string, value: string) => {
            s.calls += 1;
            if (s.error) return { count: null, error: { message: s.error } };
            const before = s.rows.length;
            s.rows = s.rows.filter((r) => !(String(r[col]) < value));
            return { count: before - s.rows.length, error: null };
          },
        }),
      };
    },
  }),
}));
vi.mock('@sentry/nextjs', () => ({ addBreadcrumb: vi.fn(), captureMessage: vi.fn() }));

import { runCleanupInvoiceFormDrafts } from '@/lib/jobs/runners/cleanup-invoice-form-drafts';
import { CRON_JOBS } from '@/lib/jobs/queues';
import { AUTOSAVE_RETENTION_DAYS } from '@/lib/invoices/form-autosave';
import type { JobContext } from '@/lib/jobs/registry';

const ctx = { step: { run: async <T,>(_n: string, fn: () => Promise<T>) => fn() } } as unknown as JobContext;
const NOW = new Date('2026-11-16T03:30:00.000Z');
const dni = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const wiersz = (key: string, wiek: number): Row => ({ tenant_id: 't', user_id: 'u', request_key: key, updated_at: dni(wiek) });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  s.rows = [wiersz('a', 31), wiersz('b', 45), wiersz('c', 29), wiersz('d', 0)];
  s.error = null;
  s.calls = 0;
});

describe('nocne sprzątanie kopii roboczych formularza faktury', () => {
  it('okres 30 dni jest wspólny z odczytem i autozapisem', () => {
    expect(AUTOSAVE_RETENTION_DAYS).toBe(30);
  });

  it('usuwa wiersze starsze niż 30 dni i zostawia świeże', async () => {
    const out = await runCleanupInvoiceFormDrafts(ctx);
    expect(out).toEqual({ removed: 2 });
    expect(s.rows.map((r) => r.request_key)).toEqual(['c', 'd']);
  });

  it('jest idempotentny: drugi przebieg nic nie usuwa', async () => {
    await runCleanupInvoiceFormDrafts(ctx);
    expect(await runCleanupInvoiceFormDrafts(ctx)).toEqual({ removed: 0 });
    expect(s.rows).toHaveLength(2);
  });

  it('błąd bazy kończy przebieg błędem (pg-boss ponowi), nic nie jest zgłaszane jako sukces', async () => {
    s.error = 'db down';
    await expect(runCleanupInvoiceFormDrafts(ctx)).rejects.toThrow(/db down/);
  });

  it('kolejka ma nocny cron w strefie Warszawy', () => {
    const cron = CRON_JOBS.find((c) => c.queue === 'cron.cleanup-invoice-form-drafts');
    expect(cron).toMatchObject({ cron: '30 3 * * *', tz: 'Europe/Warsaw' });
  });
});
