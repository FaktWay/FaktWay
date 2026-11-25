import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Migracja 00215 (plan kompletnej aplikacji, krok 2.9, część 2, PR A;
 * decyzje D26-D28 w docs/koordynacja/DECYZJE-2026-11-25.md): potwierdzenie
 * salda z kontrahentem. Tekst migracji (uprawnienia, search_path, firma i rola
 * z sesji, wyłącznik, warunek należności, numeracja, niezmienność); zachowanie
 * na prawdziwej bazie sprawdza `tests/rls-saldo.test.ts` w jobie „RLS isolation”.
 */

const sql = () => readFileSync(join(process.cwd(), 'supabase/migrations/00215_balance_confirmations.sql'), 'utf8');
/** Kod wykonywany przy wgraniu: bez komentarzy i bez ciał funkcji. */
const outsideBodies = (text: string) => text.replace(/--[^\n]*/g, '').replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, '');
/** Ciało funkcji `name` (między `$$`). */
function body(text: string, name: string): string {
  const start = text.indexOf(`FUNCTION public.${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const open = text.indexOf('$$', start);
  return text.slice(open + 2, text.indexOf('$$', open + 2));
}
/** Nagłówek funkcji `name` (od nazwy do otwarcia ciała). */
function header(text: string, name: string): string {
  const start = text.indexOf(`FUNCTION public.${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  return text.slice(start, text.indexOf('$$', start));
}

const PUBLIC_RPC = [
  'balance_confirmation_preview(uuid, text)',
  'issue_balance_confirmation(uuid, text, text, boolean)',
  'record_balance_confirmation_email(uuid, text, text, text)',
] as const;

const INTERNAL = [
  'balance_confirmation_session_tenant()',
  'balance_confirmation_lines(uuid, text, text)',
  'balance_confirmation_build(uuid, uuid, text)',
] as const;

describe('migracja 00215 (tekst; zachowanie na bazie w tests/rls-saldo.test.ts)', () => {
  it('nagłówek: PRZED wdrożeniem; bez DROP tabel i kolumn, bez zmiany danych; jedyny INSERT to wyłączony wiersz wyłącznika', () => {
    const tekst = sql();
    expect(tekst).toMatch(/-- KIEDY WGRAĆ: PRZED wdrożeniem/);
    const wykonywane = outsideBodies(tekst);
    expect(wykonywane).not.toMatch(/\b(DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|UPDATE\s+public\.)\b/i);
    const inserty = [...wykonywane.matchAll(/INSERT\s+INTO\s+([\w.]+)/gi)].map((m) => m[1]);
    expect(inserty).toEqual(['public.global_feature_flags']);
    expect(wykonywane).toMatch(
      /INSERT INTO public\.global_feature_flags \(flag, enabled, note\)\s+VALUES \(\s*'balanceConfirmationsEnabled',\s*false,[\s\S]*?\)\s+ON CONFLICT \(flag\) DO NOTHING;/,
    );
    expect(tekst).toContain("NOTIFY pgrst, 'reload schema';");
  });

  it('tabele: RLS, odczyt tylko aktywnej firmy, klient bez zapisu (tylko RPC), service_role czyta (nocna kopia)', () => {
    const tekst = outsideBodies(sql());
    for (const tabela of ['balance_confirmations', 'balance_confirmation_emails']) {
      expect(tekst).toContain(`ALTER TABLE public.${tabela} ENABLE ROW LEVEL SECURITY;`);
      expect(tekst).toMatch(
        new RegExp(`CREATE POLICY "${tabela}_select_own_tenant" ON public\\.${tabela}\\s+FOR SELECT TO authenticated\\s+USING \\(tenant_id = public\\.get_current_tenant_id\\(\\)\\);`),
      );
      expect(tekst).toContain(`REVOKE ALL ON public.${tabela} FROM PUBLIC, anon, authenticated, service_role;`);
      expect(tekst).toContain(`GRANT SELECT ON public.${tabela} TO authenticated;`);
      expect(tekst).toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.${tabela} TO service_role;`);
    }
    expect(tekst).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*TO authenticated/);
    expect(tekst).not.toMatch(/GRANT[^;]*TO[^;]*\banon\b/);
  });

  it('numer PS/n/rok: seria na firmę i rok dnia salda, CHECK zgodności, UNIQUE serii i odcisku, blokada serii przy wystawieniu', () => {
    const tekst = sql();
    expect(tekst).toContain("AND number = 'PS/' || number_seq::text || '/' || number_year::text");
    expect(tekst).toContain('AND number_year = EXTRACT(YEAR FROM as_of)::integer');
    expect(tekst).toContain('CONSTRAINT balance_confirmations_number_unique UNIQUE (tenant_id, number_year, number_seq)');
    expect(tekst).toContain('CONSTRAINT balance_confirmations_fingerprint_unique UNIQUE (tenant_id, fingerprint)');
    expect(tekst).toContain("CONSTRAINT balance_confirmations_currency_check CHECK (currency = 'PLN')");
    const issue = body(tekst, 'issue_balance_confirmation');
    expect(issue).toContain("hashtextextended('balance_confirmation:' || v_tenant_id::text || ':' || v_year::text, 0)");
    expect(issue).toContain("v_number := 'PS/' || v_seq::text || '/' || v_year::text;");
    expect(issue.indexOf('pg_advisory_xact_lock')).toBeLessThan(issue.indexOf('INSERT INTO public.balance_confirmations'));
  });

  it('kontrahent z tej samej firmy (klucz złożony), migawka zostaje po usunięciu kontrahenta', () => {
    const tekst = sql();
    expect(tekst).toMatch(
      /FOREIGN KEY \(tenant_id, contractor_id\)\s+REFERENCES public\.contractors \(tenant_id, id\)\s+ON DELETE SET NULL \(contractor_id\)/,
    );
    expect(tekst).toContain('issued_by uuid REFERENCES public.users(id) ON DELETE SET NULL');
  });

  it('wystawionego dokumentu nie zmienia nikt: wyzwalacz przed UPDATE, wolne tylko zerowania kluczy obcych', () => {
    const tekst = sql();
    const guard = body(tekst, 'guard_balance_confirmation_update');
    expect(guard).toContain("v_free constant text[] := ARRAY['contractor_id', 'issued_by'];");
    expect(guard).toContain('(to_jsonb(NEW) - v_free) IS DISTINCT FROM (to_jsonb(OLD) - v_free)');
    expect(guard).toContain('Balance confirmation % is issued and cannot be changed; issue a new balance confirmation instead');
    expect(tekst).toMatch(
      /CREATE TRIGGER a_guard_balance_confirmation_update\s+BEFORE UPDATE ON public\.balance_confirmations\s+FOR EACH ROW EXECUTE FUNCTION public\.guard_balance_confirmation_update\(\);/,
    );
  });

  it('RPC: SECURITY DEFINER z pustym search_path, firma, osoba i rola z sesji, EXECUTE tylko authenticated', () => {
    const tekst = sql();
    for (const fn of PUBLIC_RPC) {
      const nazwa = fn.slice(0, fn.indexOf('('));
      expect(header(tekst, nazwa), nazwa).toMatch(/SECURITY DEFINER\s+SET search_path = ''/);
      expect(tekst).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated, service_role;`);
      expect(tekst).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO authenticated;`);
      expect(body(tekst, nazwa), nazwa).toContain('v_tenant_id := public.balance_confirmation_session_tenant();');
    }
    const sesja = body(tekst, 'balance_confirmation_session_tenant');
    expect(sesja).toContain('IF auth.uid() IS NULL THEN');
    expect(sesja).toContain('v_tenant_id := public.get_current_tenant_id();');
    for (const rola of ['owner', 'admin', 'member', 'accountant']) {
      expect(sesja).toContain(`public.has_org_role(v_tenant_id, '${rola}')`);
    }
    expect(sesja).toContain("USING ERRCODE = '42501'");
  });

  it('funkcje wewnętrzne (firma z argumentu) bez EXECUTE dla klienta i serwisu', () => {
    const tekst = sql();
    for (const fn of INTERNAL) {
      expect(tekst).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated, service_role;`);
      expect(tekst).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn.replace(/[()]/g, '\\$&')}`));
    }
  });

  it('wyłącznik: podgląd i wystawienie odmawiają bez włączonej flagi balanceConfirmationsEnabled', () => {
    const tekst = sql();
    for (const nazwa of ['balance_confirmation_preview', 'issue_balance_confirmation']) {
      const fn = body(tekst, nazwa);
      expect(fn, nazwa).toMatch(
        /IF NOT EXISTS \(\s*SELECT 1 FROM public\.global_feature_flags AS g\s+WHERE g\.flag = 'balanceConfirmationsEnabled' AND g\.enabled\s*\) THEN\s+RETURN jsonb_build_object\('status', 'refused', 'code', 'disabled'\);/,
      );
      expect(fn, nazwa).toContain("p_ksef_environment NOT IN ('test', 'demo', 'production')");
    }
  });

  it('saldo liczy baza tym samym warunkiem co Pulpit (getReceivables, widok 00145) i nie milczy o pominiętych', () => {
    const lines = body(sql(), 'balance_confirmation_lines');
    for (const fragment of [
      "i.direction = 'outgoing'",
      "i.ksef_status = 'accepted'",
      'i.ksef_environment = p_ksef_environment',
      "i.payment_status IN ('unpaid', 'partial', 'overdue')",
      'i.gross_total > 0',
      'i.paid_amount >= 0',
      "(i.invoice_kind = 'regular' AND i.invoice_type IN ('VAT', 'UPR'))",
      "(i.invoice_kind = 'advance' AND i.invoice_type = 'ZAL')",
      "(i.invoice_kind = 'final' AND i.invoice_type = 'ROZ')",
      // ROZ: reszta po zaliczkach, ten sam wzór co wyzwalacz i widok 00145.
      "(i.payment_data ->> 'amountDue') ~ '^[0-9]+(\\.[0-9]+)?$'",
      "LEAST((i.payment_data ->> 'amountDue')::numeric, i.gross_total)",
      // FP: zapłacona przy kasie (isReceiptInvoiceColumns).
      "i.fa3_data -> 'receipt'",
      "(i.fa3_data -> 'ksefMarkers' ->> 'fp') = 'true'",
      // Dzieci w każdym statusie, jak loadTenantChildIds.
      'c.parent_invoice_id IS NOT NULL',
      'unnest(c.advance_invoice_ids)',
      "i.fa3_data -> 'parsed' ->> 'paidDate'",
      'public.balance_confirmation_buyer_nip(i.buyer_nip, i.buyer_data) = p_nip',
    ]) {
      expect(lines, fragment).toContain(fragment);
    }
    for (const powod of ['imported', 'correction_due', 'corrected', 'advance_settlement', 'foreign_currency']) {
      expect(lines, powod).toContain(`'${powod}'`);
    }
    expect(lines).toContain("WHEN p.currency IS NOT NULL AND p.currency <> 'PLN' THEN 'foreign_currency'");
  });

  it('wystawienie tylko treści, którą klient widział: odcisk, pominięte świadomie, bez pustego dokumentu, ta sama treść to ten sam numer', () => {
    const issue = body(sql(), 'issue_balance_confirmation');
    expect(issue).toContain("IF p_fingerprint IS NULL OR p_fingerprint IS DISTINCT FROM v_snapshot ->> 'fingerprint' THEN");
    expect(issue).toContain("'code', 'changed'");
    expect(issue).toContain("'code', 'nothing_due'");
    expect(issue).toContain('IF v_omitted_count > 0 AND p_without_omitted IS DISTINCT FROM true THEN');
    expect(issue).toContain("'code', 'omitted_not_confirmed'");
    expect(issue).toMatch(/WHERE b\.tenant_id = v_tenant_id\s+AND b\.fingerprint = v_snapshot ->> 'fingerprint';/);
    expect(issue).toContain("'status', 'already_issued'");
    expect(issue).toContain("'balance_confirmation.issued'");
    const build = body(sql(), 'balance_confirmation_build');
    expect(build).toContain("v_today date := (now() AT TIME ZONE 'Europe/Warsaw')::date;");
    expect(build).toMatch(/v_fingerprint := md5\(jsonb_build_object\([\s\S]*'asOf', v_today[\s\S]*'items', v_lines -> 'items'[\s\S]*'omitted', v_lines -> 'omitted'[\s\S]*\)::text\);/);
  });

  it('historia wysyłek: zapis raz na klucz z przedrostkiem saldo/<id>/, audyt w tej samej transakcji', () => {
    const rec = body(sql(), 'record_balance_confirmation_email');
    expect(rec).toContain("v_prefix := 'saldo/' || p_confirmation_id::text || '/';");
    expect(rec).toContain('ON CONFLICT (tenant_id, idempotency_key) DO NOTHING');
    expect(rec).toContain("'balance_confirmation.emailed'");
  });

  it('NIP jak normalizeNip: usuwa te same białe znaki co JS \\s i myślnik, wielkie litery', () => {
    const fn = body(sql(), 'balance_confirmation_strip_space');
    const kody = new Set<number>();
    for (const m of fn.matchAll(/chr\((\d+)\)(?: \|\| '-' \|\| chr\((\d+)\))?/g)) {
      const od = Number(m[1]);
      const doKodu = m[2] ? Number(m[2]) : od;
      for (let k = od; k <= doKodu; k++) kody.add(k);
    }
    const js: number[] = [];
    for (let k = 0; k <= 0xffff; k++) if (/\s/.test(String.fromCharCode(k))) js.push(k);
    expect([...kody].sort((a, b) => a - b)).toEqual(js);
    const nip = body(sql(), 'balance_confirmation_nip');
    expect(nip).toContain("NULLIF(upper(replace(public.balance_confirmation_strip_space(p_value), '-', '')), '')");
  });
});
