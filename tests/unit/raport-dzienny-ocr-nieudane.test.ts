import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';
import type { DailyMetrics } from '@/lib/observability/business-metrics';

/**
 * LIM-05, punkt 10 (plan skalowania 3000): nieudany odczyt OCR nie dawał
 * operatorowi żadnego sygnału. Silnik OCR łapie błąd SDK i zwraca porażkę,
 * job zapisuje tylko `ocr_jobs.status = 'failed'`, a metryki i raport dzienny
 * liczyły wyłącznie udane odczyty. Teraz raport 06:00 (mail i Telegram)
 * pokazuje liczbę nieudanych i osobno limity czasu SDK („Request timed out.”).
 * Same liczby: bez treści błędu, w której bywa treść paragonu.
 */

vi.mock('server-only', () => ({}));

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  /** Tabele, na których każde zapytanie kończy się błędem bazy. */
  failing: new Set<string>(),
  queries: [] as Array<{ table: string; columns: string; head: boolean }>,
}));
const mail = vi.hoisted(() => ({ sendEmail: vi.fn() }));

/** Atrapa PostgREST z filtrami, których używa `getDailyMetrics`. */
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const predicates: Array<(r: Row) => boolean> = [];
      const query = { table, columns: '', head: false };
      const q = {
        select: (columns: string, opts?: { head?: boolean }) => {
          query.columns = columns;
          query.head = Boolean(opts?.head);
          return q;
        },
        eq: (k: string, v: unknown) => { predicates.push((r) => r[k] === v); return q; },
        neq: (k: string, v: unknown) => { predicates.push((r) => r[k] != null && r[k] !== v); return q; },
        in: (k: string, vs: unknown[]) => { predicates.push((r) => vs.includes(r[k])); return q; },
        // Jak w Postgresie: NULL nie spełnia porównania.
        gte: (k: string, v: string) => { predicates.push((r) => r[k] != null && String(r[k]) >= v); return q; },
        // Jak w tests/helpers/fake-supabase-memory.ts: wzorce `%tekst%`, bez wielkości liter.
        ilike: (k: string, pattern: string) => {
          const needle = pattern.replace(/%/g, '').toLowerCase();
          predicates.push((r) => String(r[k] ?? '').toLowerCase().includes(needle));
          return q;
        },
        order: () => q,
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => {
          db.queries.push(query);
          if (db.failing.has(table)) {
            const error = { message: 'canceling statement due to statement timeout' };
            return Promise.resolve({ data: null, count: null, error }).then(ok, fail);
          }
          const rows = (db.tables[table] ?? []).filter((r) => predicates.every((p) => p(r)));
          return Promise.resolve({ data: query.head ? null : rows, count: rows.length, error: null }).then(ok, fail);
        },
      };
      return q;
    },
  }),
}));

vi.mock('@/lib/email/send', () => ({ sendEmail: mail.sendEmail }));

// Stan bazy do Telegrama czyta przez połączenie pg-boss: zdrowa baza.
vi.mock('@/lib/jobs/boss', () => ({
  startBoss: async () => ({
    getDb: () => ({
      executeSql: async () => ({
        rows: [{ db_bytes: '207618048', slot_wal_bytes: '0', slot_name: null, backup_at: new Date(), backup_failed_24h: '0' }],
      }),
    }),
  }),
}));

import { buildTelegramReport, runDailySummaryEmail } from '@/lib/jobs/runners/daily-summary-email';
import { getDailyMetrics } from '@/lib/observability/business-metrics';

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** Odczyty jak na produkcji: oba zapisy porażki ustawiają `completed_at`. */
function ocrJobs(): Row[] {
  return [
    // Udany odczyt w dobie.
    { id: 'ok', tenant_id: 't1', status: 'completed', error_message: null, created_at: ago(2 * HOUR), completed_at: ago(2 * HOUR) },
    // Limit czasu SDK: silnik OCR przepisuje `e.message` do `error_message`.
    { id: 'timeout', tenant_id: 't1', status: 'failed', error_message: 'Request timed out.', created_at: ago(3 * HOUR), completed_at: ago(3 * HOUR - 241_000) },
    // Wgrany przed oknem, padł w oknie (kolejka zatkana awarią dostawcy).
    // Liczy się w dobie porażki, inaczej nie trafiłby do żadnego raportu.
    { id: 'timeout-old-upload', tenant_id: 't2', status: 'failed', error_message: 'Request timed out.', created_at: ago(24 * HOUR + 10 * 60_000), completed_at: ago(23 * HOUR + 50 * 60_000) },
    // Inna porażka, z treścią paragonu w komunikacie.
    { id: 'bad-json', tenant_id: 't2', status: 'failed', error_message: 'Claude zwrócił nieprawidłowy JSON: {"sprzedawca":"Jan Kowalski, ul. Polna 1"', created_at: ago(HOUR), completed_at: ago(HOUR) },
    // Porażka sprzed okna: była w poprzednim raporcie.
    { id: 'old', tenant_id: 't1', status: 'failed', error_message: 'Request timed out.', created_at: ago(50 * HOUR), completed_at: ago(49 * HOUR) },
    // W toku: bez `completed_at`.
    { id: 'pending', tenant_id: 't1', status: 'pending', error_message: null, created_at: ago(10 * 60_000), completed_at: null },
    { id: 'processing', tenant_id: 't2', status: 'processing', error_message: null, created_at: ago(5 * 60_000), completed_at: null },
  ];
}

/** Wartość kafelka maila po jego etykiecie. */
function tileValue(html: string, label: string): string | undefined {
  const at = html.indexOf(`<p class="stat-label">${label}</p>`);
  if (at === -1) return undefined;
  return html.slice(at).match(/<p class="stat-value"[^>]*>([^<]*)<\/p>/)?.[1];
}

function jobContext(): JobContext {
  const step = { run: async <T>(_name: string, fn: () => Promise<T> | T): Promise<T> => fn() };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { step: step as unknown as JobContext['step'], logger, attempt: 0 };
}

beforeEach(() => {
  db.tables = { ocr_jobs: ocrJobs() };
  db.failing.clear();
  db.queries.length = 0;
  mail.sendEmail.mockReset();
});

describe('metryki dzienne: nieudane odczyty OCR', () => {
  it('liczy porażki w dobie, w której padły, i osobno limit czasu', async () => {
    const metrics = await getDailyMetrics(24);

    expect(metrics.ocrJobsFailed).toBe(3);
    expect(metrics.ocrJobsTimedOut).toBe(2);
    expect(metrics.ocrJobsCompleted).toBe(1);
  });

  it('o ocr_jobs pyta tylko o liczby: bez wierszy i bez treści błędu', async () => {
    await getDailyMetrics(24);

    const ocr = db.queries.filter((q) => q.table === 'ocr_jobs');
    expect(ocr).toHaveLength(3);
    expect(ocr.every((q) => q.head && q.columns === 'id')).toBe(true);
  });

  it('błąd bazy to brak danych, nie zero', async () => {
    db.failing.add('ocr_jobs');

    const metrics = await getDailyMetrics(24);

    expect(metrics.ocrJobsFailed).toBeNull();
    expect(metrics.ocrJobsTimedOut).toBeNull();
  });
});

describe('raport dzienny 06:00: nieudane odczyty OCR', () => {
  beforeEach(() => {
    vi.stubEnv('ADMIN_EMAILS', 'operator@example.com');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'syntetyczny-token-bota');
    vi.stubEnv('TELEGRAM_ALERT_CHAT_IDS', '111');
    mail.sendEmail.mockResolvedValue({ sent: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function runReport() {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const result = await runDailySummaryEmail(jobContext());
    const telegram = fetchMock.mock.calls.map(
      ([, init]) => (JSON.parse((init as { body: string }).body) as { text: string }).text,
    );
    const html = mail.sendEmail.mock.calls.map(([arg]) => (arg as { html: string }).html);
    return { result, telegram, html };
  }

  it('mail i Telegram pokazują nieudane i limit czasu, bez treści paragonu', async () => {
    const { result, telegram, html } = await runReport();

    expect(result).toMatchObject({ sent: 1, failed: 0, telegramDelivered: 1 });
    expect(telegram).toHaveLength(1);
    expect(telegram[0]).toContain('Odczyty OCR: nieudane 3, w tym limit czasu 2 ⚠️');
    expect(html).toHaveLength(1);
    expect(tileValue(html[0]!, 'OCR nieudane')).toBe('3');
    expect(tileValue(html[0]!, 'OCR nieudane: limit czasu')).toBe('2');
    for (const text of [...telegram, ...html]) expect(text).not.toContain('Kowalski');
  });

  it('przy błędzie bazy raport mówi „brak danych”, nie 0', async () => {
    db.failing.add('ocr_jobs');

    const { telegram, html } = await runReport();

    expect(telegram[0]).toContain('Odczyty OCR: nieudane ⚠️ brak danych, w tym limit czasu ⚠️ brak danych');
    expect(tileValue(html[0]!, 'OCR nieudane')).toBe('brak danych');
    expect(tileValue(html[0]!, 'OCR nieudane: limit czasu')).toBe('brak danych');
  });
});

describe('raport na Telegram: linia OCR', () => {
  const metrics: DailyMetrics = {
    period: { from: '2026-11-14T05:00:00.000Z', to: '2026-11-15T05:00:00.000Z' },
    signups: 0, newTenants: 0, onboardingCompletions: 0, firstInvoiceCount: 0,
    invoicesIssued: 0, invoicesAccepted: 0, invoicesFailed: 0, invoicesOfflineQueued: 0,
    ocrJobsCompleted: 9, ocrJobsFailed: 2, ocrJobsTimedOut: 0,
    ksefDowntimeMinutes: 0, ksefMaxConsecutiveFailures: 0,
    totalAuditErrors: 0, totalInngestFailures: 0, paymentsSucceeded: 0, paymentsFailed: 0,
    paymentsTotalGrossPln: 0,
  };

  it('porażki bez limitu czasu (np. nieczytelne zdjęcie) są bez ostrzeżenia', () => {
    const report = buildTelegramReport(metrics);

    expect(report).toContain('Odczyty OCR: nieudane 2, w tym limit czasu 0');
    expect(report).not.toContain('⚠️');
  });
});
