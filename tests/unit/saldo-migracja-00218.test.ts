import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Migracja 00218 (D57 i uwaga N1 drugiego czytelnika #958): tekst migracji.
 * Zachowanie na prawdziwej bazie sprawdza `tests/rls-saldo.test.ts` (job „RLS isolation”).
 */
const sql = () => readFileSync(join(process.cwd(), 'supabase/migrations/00218_balance_confirmations_d57_n1.sql'), 'utf8');

describe('00218: potwierdzenie salda, D57 i N1', () => {
  it('nagłówek mówi, kiedy wgrać', () => {
    expect(sql()).toMatch(/^-- KIEDY WGRAĆ: PRZED wdrożeniem/m);
  });

  it('N1: wyzwalacz BEFORE DELETE odrzuca usunięcie, wolna tylko kaskada z firmy i flaga operatora', () => {
    const t = sql();
    expect(t).toContain('BEFORE DELETE ON public.balance_confirmations');
    expect(t).toContain('IF pg_trigger_depth() > 1 THEN');
    expect(t).toContain("current_setting('app.allow_balance_confirmation_delete', true) = 'on'");
    expect(t).toContain("USING ERRCODE = '42501'");
    expect(t).toMatch(/REVOKE ALL ON FUNCTION public\.guard_balance_confirmation_delete\(\) FROM PUBLIC, anon, authenticated;/);
  });

  it('D57: dwa nowe powody w CHECK pominiętych i w liniach, bez DROP/DELETE/UPDATE w kodzie migracji', () => {
    const t = sql();
    for (const powod of ['advance_settled', 'awaiting_ksef_number']) {
      expect(t.match(new RegExp(`'${powod}'`, 'g'))?.length, powod).toBeGreaterThanOrEqual(2);
    }
    expect(t).toContain("i.ksef_status IN ('queued', 'sending', 'offline_queued')");
    expect(t).toContain("WHEN p.ma_rozliczenie THEN CASE WHEN p.rozliczenie_w_ksef THEN 'advance_settled' ELSE 'advance_settlement' END");
    const kod = t.replace(/--[^\n]*/g, '').replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, '');
    expect(kod).not.toMatch(/\b(DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|UPDATE\s+public)\b/i);
  });
});
