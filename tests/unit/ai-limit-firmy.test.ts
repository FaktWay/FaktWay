import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AUD-107 (decyzja B7): budżet AI na firmę dla OCR i klasyfikatora —
 * 3 zł miesięcznie (mechanizm `lib/flo/budget.ts`, tabela `flo_usage`),
 * dzienny limit liczby rozpoznań OCR (także w trialu) i alarm w Sentry
 * po przekroczeniu dwukrotności celu. Błąd odczytu zużycia = odmowa.
 */

const mocks = vi.hoisted(() => ({ spend: vi.fn(), record: vi.fn(), sentry: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureMessage: mocks.sentry }));
vi.mock('@/lib/cache/redis', () => ({ isRedisConfigured: () => false, getRedis: () => { throw new Error('brak'); } }));
vi.mock('@/lib/flo/budget', async (orig) => ({
  ...(await orig<typeof import('@/lib/flo/budget')>()),
  readSpend: mocks.spend,
  recordUsage: mocks.record,
}));

import { AI_DAILY_OCR_LIMIT, checkTenantAiBudget, recordTenantAiUsage } from '@/lib/ai/tenant-ai-budget';
import {
  TENANT_AI_BUDGET_DAILY_MESSAGE,
  TENANT_AI_BUDGET_MESSAGES,
  TENANT_AI_BUDGET_MONTHLY_MESSAGE,
  TENANT_AI_BUDGET_UNAVAILABLE_MESSAGE,
} from '@/lib/ai/tenant-ai-budget-messages';
import { USD_PLN } from '@/lib/flo/budget';
import { komunikatBleduOdczytu, POWIADOMIENIE_MAX_ZNAKOW, trescPowiadomienia } from '@/lib/ocr/komunikat-dla-klienta';

const usd = (pln: number) => pln / USD_PLN;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.spend.mockResolvedValue({ monthUsd: 0, todayUsd: 0 });
});

describe('budżet AI firmy', () => {
  it('poniżej limitu — zgoda', async () => {
    expect(await checkTenantAiBudget('t-ok', 'ocr')).toEqual({ allowed: true });
  });

  it('miesięczne 3 zł wykorzystane — odmowa z komunikatem', async () => {
    mocks.spend.mockResolvedValue({ monthUsd: usd(3.01), todayUsd: 0 });
    expect(await checkTenantAiBudget('t-month', 'ocr')).toEqual({ allowed: false, message: expect.stringContaining('miesięczny limit') });
  });

  it('dzienny koszt agenta FLO nie blokuje OCR — liczy się limit liczby rozpoznań', async () => {
    mocks.spend.mockResolvedValue({ monthUsd: usd(1), todayUsd: usd(0.9) });
    expect((await checkTenantAiBudget('t-daycost', 'ocr')).allowed).toBe(true);
  });

  it(`po ${AI_DAILY_OCR_LIMIT} rozpoznaniach w dobie — odmowa`, async () => {
    for (let i = 0; i < AI_DAILY_OCR_LIMIT; i += 1) {
      expect((await checkTenantAiBudget('t-count', 'ocr')).allowed).toBe(true);
    }
    expect(await checkTenantAiBudget('t-count', 'ocr')).toEqual({ allowed: false, message: expect.stringContaining('dzienny limit') });
  });

  it('błąd odczytu zużycia — odmowa (nie wiemy, ile już kosztowało)', async () => {
    mocks.spend.mockRejectedValue(new Error('fixture db'));
    expect((await checkTenantAiBudget('t-err', 'classify')).allowed).toBe(false);
  });

  it('ponad 2× cel miesięczny — alarm w Sentry, ale bez blokady', async () => {
    mocks.spend.mockResolvedValue({ monthUsd: usd(2), todayUsd: 0 });
    expect((await checkTenantAiBudget('t-alert', 'classify')).allowed).toBe(true);
    expect(mocks.sentry).toHaveBeenCalledWith(expect.stringContaining('AI'), expect.objectContaining({ level: 'warning' }));
  });

  it('zapis zużycia idzie do budżetu firmy z cennikiem modelu OCR', async () => {
    await recordTenantAiUsage('t-rec', { inputTokens: 1000, outputTokens: 200 });
    expect(mocks.record).toHaveBeenCalledWith('t-rec', 'claude-sonnet-4-6', { inputTokens: 1000, outputTokens: 200 });
  });
});

/**
 * Plan kompletnej aplikacji, 2.6: komunikaty odmowy kazały „wprowadzić dane
 * ręcznie”, a formularza kosztu bez zdjęcia nie ma. Komunikat mówi, kiedy
 * limit wraca. Trafia do zadania OCR (`error_message`), stamtąd bez zmian do
 * przycisku „Dodaj wydatek” i do telefonu, a powiadomienie bierze z niego
 * pełne zdania do 80 znaków (`trescPowiadomienia`). Limity mieszczą się
 * w jednym zdaniu tej długości, więc powiadomienie mówi to samo co ekran.
 */
describe('komunikaty odmowy mówią, kiedy limit wraca', () => {
  const odmowa = async (tenantId: string) => {
    const verdict = await checkTenantAiBudget(tenantId, 'ocr');
    if (verdict.allowed) throw new Error('oczekiwano odmowy');
    return verdict.message;
  };

  it('miesięczny: wróci od następnego miesiąca, bez wpisu ręcznego, w 80 znakach', async () => {
    mocks.spend.mockResolvedValue({ monthUsd: usd(3.01), todayUsd: 0 });
    const message = await odmowa('t-msg-month');

    expect(message).not.toMatch(/ręcznie/i);
    expect(message).toContain('miesięczny limit odczytu dokumentów, wróci od następnego miesiąca.');
    expect(message.length).toBeLessThanOrEqual(80);
  });

  it('dzienny: wróci w ciągu 24 godzin, bez wpisu ręcznego, w 80 znakach', async () => {
    for (let i = 0; i < AI_DAILY_OCR_LIMIT; i += 1) await checkTenantAiBudget('t-msg-day', 'ocr');
    const message = await odmowa('t-msg-day');

    expect(message).not.toMatch(/ręcznie/i);
    expect(message).toContain('dzienny limit odczytu dokumentów, wróci w ciągu 24 godzin.');
    expect(message.length).toBeLessThanOrEqual(80);
  });

  it('dzienny limit liczy odczyty z ostatnich 24 godzin: tak mówią komunikat, cennik i pomoc', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-08T10:00:00Z'));
      for (let i = 0; i < AI_DAILY_OCR_LIMIT; i += 1) expect((await checkTenantAiBudget('t-24h', 'ocr')).allowed).toBe(true);
      expect((await checkTenantAiBudget('t-24h', 'ocr')).allowed).toBe(false);

      vi.setSystemTime(new Date('2026-11-09T09:59:00Z'));
      expect((await checkTenantAiBudget('t-24h', 'ocr')).allowed).toBe(false);

      vi.setSystemTime(new Date('2026-11-09T10:01:00Z'));
      expect((await checkTenantAiBudget('t-24h', 'ocr')).allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * LIM-05, punkt 9 (#782): tłumaczenie błędu odczytu przepuszcza odmowę budżetu
 * bez zmian tylko wtedy, gdy job zapisał dokładnie zdanie z listy. Ten opis
 * pilnuje, że `checkTenantAiBudget` zwraca te same stałe, a powiadomienie
 * z każdej odmowy to pełne zdania z jej początku.
 */
describe('odmowa budżetu to zdanie dla klienta (LIM-05)', () => {
  it('chwilowa niedostępność, miesięczny i dzienny: dokładnie stałe z listy zdań', async () => {
    mocks.spend.mockRejectedValueOnce(new Error('fixture db'));
    expect(await checkTenantAiBudget('t-lista-blad', 'ocr')).toEqual({
      allowed: false,
      message: TENANT_AI_BUDGET_UNAVAILABLE_MESSAGE,
    });

    mocks.spend.mockResolvedValueOnce({ monthUsd: usd(3.01), todayUsd: 0 });
    expect(await checkTenantAiBudget('t-lista-miesiac', 'ocr')).toEqual({
      allowed: false,
      message: TENANT_AI_BUDGET_MONTHLY_MESSAGE,
    });

    for (let i = 0; i < AI_DAILY_OCR_LIMIT; i += 1) await checkTenantAiBudget('t-lista-dzien', 'ocr');
    expect(await checkTenantAiBudget('t-lista-dzien', 'ocr')).toEqual({
      allowed: false,
      message: TENANT_AI_BUDGET_DAILY_MESSAGE,
    });
  });

  it.each(TENANT_AI_BUDGET_MESSAGES)('„%s”: klient widzi całość, powiadomienie pełne zdania z początku', (komunikat) => {
    expect(komunikatBleduOdczytu(komunikat)).toBe(komunikat);

    const tresc = trescPowiadomienia(komunikat);
    expect(tresc.length).toBeLessThanOrEqual(POWIADOMIENIE_MAX_ZNAKOW);
    expect(komunikat.startsWith(tresc)).toBe(true);
    expect(tresc.endsWith('.')).toBe(true);
  });
});
