import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';
import type { DailyMetrics } from '@/lib/observability/business-metrics';

/**
 * LIM-05, punkt 10 (plan skalowania 3000): nieudany odczyt OCR nie dawał
 * operatorowi żadnego sygnału. Silnik OCR łapie błąd SDK i zwraca porażkę,
 * job zapisuje tylko `ocr_jobs.status = 'failed'`, a metryki i raport dzienny
 * liczyły wyłącznie udane odczyty (po dobie wgrania). Teraz raport 06:00 (mail
 * i Telegram) pokazuje udane i nieudane odczyty z doby, w której się skończyły,
 * i osobno limity czasu (`error_message` z „timed out”). Same liczby: bez
 * treści błędu, w której bywa treść paragonu.
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
/** Klient SDK, którego używa silnik OCR (test komunikatu limitu czasu). */
const sdk = vi.hoisted(() => ({ client: null as unknown }));

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
        // `%` tylko na brzegach wzorca, bez wielkości liter. Zakotwiczenie się
        // liczy: `timed out%` nie pasuje do „Request timed out.”, jak w Postgresie.
        ilike: (k: string, pattern: string) => {
          const p = pattern.toLowerCase();
          const core = p.replace(/^%|%$/g, '');
          predicates.push((r) => {
            const text = String(r[k] ?? '').toLowerCase();
            if (p.startsWith('%') && p.endsWith('%')) return text.includes(core);
            if (p.startsWith('%')) return text.endsWith(core);
            if (p.endsWith('%')) return text.startsWith(core);
            return text === core;
          });
          return q;
        },
        order: () => q,
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => {
          db.queries.push(query);
          if (db.failing.has(table)) {
            const error = { code: '57014', message: 'canceling statement due to statement timeout' };
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

// Silnik OCR bierze klienta stąd; test podstawia prawdziwy klient SDK z atrapą `fetch`.
vi.mock('@/lib/anthropic/client', () => ({ OCR_MODEL: 'claude-test', getAnthropic: () => sdk.client }));

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

import Anthropic from '@anthropic-ai/sdk';

import { buildTelegramReport, runDailySummaryEmail } from '@/lib/jobs/runners/daily-summary-email';
import { getDailyMetrics, OCR_TIMEOUT_ERROR_PATTERN } from '@/lib/observability/business-metrics';
import { extractInvoiceFromImage } from '@/lib/ocr/engine';

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** Odczyty jak na produkcji: wszystkie zapisy końca odczytu ustawiają `completed_at`. */
function ocrJobs(): Row[] {
  return [
    // Udany odczyt w dobie.
    { id: 'ok', tenant_id: 't1', status: 'completed', error_message: null, created_at: ago(2 * HOUR), completed_at: ago(2 * HOUR) },
    // Udany po zatkanej kolejce: wgrany przed oknem, skończony w nim.
    { id: 'ok-old-upload', tenant_id: 't2', status: 'completed', error_message: null, created_at: ago(24 * HOUR + 5 * 60_000), completed_at: ago(23 * HOUR + 55 * 60_000) },
    // Udany sprzed okna: był w poprzednim raporcie.
    { id: 'ok-old', tenant_id: 't1', status: 'completed', error_message: null, created_at: ago(30 * HOUR), completed_at: ago(30 * HOUR) },
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

/** Kafelek maila po etykiecie: wartość i kolor z atrybutu `style`. */
function tile(html: string, label: string): { value?: string; color?: string } {
  const at = html.indexOf(`<p class="stat-label">${label}</p>`);
  if (at === -1) return {};
  const m = html.slice(at).match(/<p class="stat-value"(?: style="color:([^"]*)")?>([^<]*)<\/p>/);
  return { value: m?.[2], color: m?.[1] };
}

/** ILIKE jak w Postgresie: `%` to dowolny ciąg, `_` jeden znak, bez wielkości liter. */
function ilike(text: string, pattern: string): boolean {
  const body = [...pattern]
    .map((ch) => (ch === '%' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`, 'is').test(text);
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
  sdk.client = null;
});

describe('metryki dzienne: odczyty OCR', () => {
  it('liczy odczyty w dobie, w której się skończyły: udane, nieudane i osobno limit czasu', async () => {
    const metrics = await getDailyMetrics(24);

    expect(metrics.ocrJobsCompleted).toBe(2);
    expect(metrics.ocrJobsFailed).toBe(3);
    expect(metrics.ocrJobsTimedOut).toBe(2);
  });

  it('o ocr_jobs pyta tylko o liczby: bez wierszy i bez treści błędu', async () => {
    await getDailyMetrics(24);

    const ocr = db.queries.filter((q) => q.table === 'ocr_jobs');
    expect(ocr).toHaveLength(3);
    expect(ocr.every((q) => q.head && q.columns === 'id')).toBe(true);
  });

  it('błąd bazy to brak danych, nie zero, a przyczyna idzie do logu workera', async () => {
    db.failing.add('ocr_jobs');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const metrics = await getDailyMetrics(24);

    expect(metrics.ocrJobsCompleted).toBeNull();
    expect(metrics.ocrJobsFailed).toBeNull();
    expect(metrics.ocrJobsTimedOut).toBeNull();
    const logged = warn.mock.calls.map(([, ctx]) => (ctx as { metric: string }).metric);
    expect(logged.sort()).toEqual(['ocr_jobs.completed', 'ocr_jobs.failed', 'ocr_jobs.timed_out']);
    expect(warn).toHaveBeenCalledWith('[business-metrics] licznik bez danych', {
      metric: 'ocr_jobs.failed',
      code: '57014',
      message: 'canceling statement due to statement timeout',
    });
    warn.mockRestore();
  });
});

describe('raport dzienny 06:00: odczyty OCR', () => {
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

  it('mail i Telegram pokazują udane, nieudane i limit czasu, bez treści paragonu', async () => {
    const { result, telegram, html } = await runReport();

    expect(result).toMatchObject({ sent: 1, failed: 0, telegramDelivered: 1 });
    expect(telegram).toHaveLength(1);
    expect(telegram[0]).toContain('Odczyty OCR: udane 2, nieudane 3, w tym limit czasu 2 ⚠️');
    expect(html).toHaveLength(1);
    expect(tile(html[0]!, 'OCR jobs')).toEqual({ value: '2', color: '#111' });
    // Porażek więcej niż udanych i są limity czasu: oba kafelki czerwone.
    expect(tile(html[0]!, 'OCR nieudane')).toEqual({ value: '3', color: '#dc2626' });
    expect(tile(html[0]!, 'OCR nieudane: limit czasu')).toEqual({ value: '2', color: '#dc2626' });
    for (const text of [...telegram, ...html]) expect(text).not.toContain('Kowalski');
  });

  it('przy błędzie bazy raport mówi „brak danych”, nie 0', async () => {
    db.failing.add('ocr_jobs');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { telegram, html } = await runReport();

    expect(telegram[0]).toContain(
      'Odczyty OCR: udane ⚠️ brak danych, nieudane ⚠️ brak danych, w tym limit czasu ⚠️ brak danych',
    );
    for (const label of ['OCR jobs', 'OCR nieudane', 'OCR nieudane: limit czasu']) {
      expect(tile(html[0]!, label)).toEqual({ value: 'brak danych', color: '#f59e0b' });
    }
    warn.mockRestore();
  });

  it('awaria bez limitu czasu (np. brak środków u dostawcy): ostrzeżenie i czerwony kafelek', async () => {
    const outage = (id: string, minutesAgo: number): Row => ({
      id, tenant_id: 't1', status: 'failed',
      error_message: 'Your credit balance is too low to access the Anthropic API.',
      created_at: ago(minutesAgo * 60_000), completed_at: ago(minutesAgo * 60_000),
    });
    db.tables = { ocr_jobs: [outage('a', 30), outage('b', 20), outage('c', 10)] };

    const { telegram, html } = await runReport();

    expect(telegram[0]).toContain('Odczyty OCR: udane 0, nieudane 3, w tym limit czasu 0 ⚠️');
    expect(tile(html[0]!, 'OCR nieudane')).toEqual({ value: '3', color: '#dc2626' });
    expect(tile(html[0]!, 'OCR nieudane: limit czasu')).toEqual({ value: '0', color: '#111' });
  });
});

describe('raport na Telegram: ostrzeżenie w linii OCR', () => {
  const metrics: DailyMetrics = {
    period: { from: '2026-11-14T05:00:00.000Z', to: '2026-11-15T05:00:00.000Z' },
    signups: 0, newTenants: 0, onboardingCompletions: 0, firstInvoiceCount: 0,
    invoicesIssued: 0, invoicesAccepted: 0, invoicesFailed: 0, invoicesOfflineQueued: 0,
    ocrJobsCompleted: 0, ocrJobsFailed: 0, ocrJobsTimedOut: 0,
    ksefDowntimeMinutes: 0, ksefMaxConsecutiveFailures: 0,
    totalAuditErrors: 0, totalInngestFailures: 0, paymentsSucceeded: 0, paymentsFailed: 0,
    paymentsTotalGrossPln: 0,
  };

  it.each([
    { label: 'zwykłe porażki (np. nieczytelne zdjęcie) bez ostrzeżenia', completed: 9, failed: 2, timedOut: 0, warn: false },
    { label: 'remis: połowa padła, bez ostrzeżenia', completed: 2, failed: 2, timedOut: 0, warn: false },
    { label: 'więcej porażek niż udanych: ostrzeżenie', completed: 1, failed: 2, timedOut: 0, warn: true },
    { label: 'żaden odczyt się nie udał: ostrzeżenie', completed: 0, failed: 5, timedOut: 0, warn: true },
    { label: 'limit czasu: ostrzeżenie', completed: 9, failed: 1, timedOut: 1, warn: true },
  ])('$label', ({ completed, failed, timedOut, warn }) => {
    const report = buildTelegramReport({
      ...metrics,
      ocrJobsCompleted: completed,
      ocrJobsFailed: failed,
      ocrJobsTimedOut: timedOut,
    });

    expect(report).toContain(`Odczyty OCR: udane ${completed}, nieudane ${failed}, w tym limit czasu ${timedOut}`);
    expect(report.includes('⚠️')).toBe(warn);
  });
});

describe('limit czasu: komunikat SDK Anthropic trafia pod wzorzec raportu', () => {
  // Raport liczy limit czasu po napisie w `error_message`. Prawdziwy klient SDK
  // (bez sieci, bez ponowień) i silnik OCR muszą dać napis, który ten wzorzec
  // łapie. Inny komunikat w nowej wersji SDK zaczerwieni ten test.
  type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  const clientWith = (fetch: Fetch) =>
    new Anthropic({ apiKey: 'syntetyczny-klucz', fetch, timeout: 20, maxRetries: 0 });
  /** `fetch`, który nigdy nie odpowiada: SDK przerywa go po `timeout`. */
  const hanging: Fetch = (_url, init) =>
    new Promise<Response>((_ok, fail) => {
      init?.signal?.addEventListener('abort', () => fail(init.signal?.reason), { once: true });
    });
  /** `fetch` jak undici przy zerwanym połączeniu: `TypeError` z przyczyną. */
  const failing = (cause: string): Fetch => async () => {
    throw new TypeError('fetch failed', { cause: new Error(cause) });
  };
  // Minimalny PDF: ścieżka PDF idzie do API bez obróbki obrazu.
  const PDF = 'JVBERi0xLjQK';

  beforeEach(() => vi.stubEnv('E2E_MOCK_ANTHROPIC', ''));
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { label: 'brak odpowiedzi w czasie (przerwanie po `timeout`)', fetch: hanging },
    { label: 'limit połączenia undici', fetch: failing('Connect Timeout Error (attempted address: api.anthropic.com:443, timeout: 10000ms)') },
  ])('$label: odczyt nieudany z napisem, który łapie wzorzec', async ({ fetch }) => {
    sdk.client = clientWith(fetch);

    const result = await extractInvoiceFromImage(PDF, 'application/pdf');

    expect(result).toMatchObject({ success: false, error: 'Request timed out.' });
    expect(ilike(result.error!, OCR_TIMEOUT_ERROR_PATTERN)).toBe(true);
  });

  it('zerwane połączenie bez limitu czasu to zwykła porażka, nie limit czasu', async () => {
    sdk.client = clientWith(failing('getaddrinfo ENOTFOUND api.anthropic.com'));

    const result = await extractInvoiceFromImage(PDF, 'application/pdf');

    expect(result).toMatchObject({ success: false, error: 'Connection error.' });
    expect(ilike(result.error!, OCR_TIMEOUT_ERROR_PATTERN)).toBe(false);
  });
});
