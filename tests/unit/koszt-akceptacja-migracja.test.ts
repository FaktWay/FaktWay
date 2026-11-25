import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Migracja 00214 (plan kompletnej aplikacji, krok 6.2, część 5a): akceptacja
 * kosztu przez księgową. Tekst migracji (uprawnienia, search_path, rola, odcisk
 * treści, klucze idempotencji); zachowanie na prawdziwej bazie sprawdza
 * `tests/rls-akceptacja-kosztow.test.ts` w jobie „RLS isolation”.
 */

const sql = () => readFileSync(join(process.cwd(), 'supabase/migrations/00214_expense_acceptances.sql'), 'utf8');
/** Kod wykonywany przy wgraniu: bez komentarzy i bez ciał funkcji. */
const outsideBodies = (text: string) => text.replace(/--[^\n]*/g, '').replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, '');
/** Ciało funkcji `name` (między `$$`). */
function body(text: string, name: string): string {
  const start = text.indexOf(`FUNCTION public.${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const open = text.indexOf('$$', start);
  return text.slice(open + 2, text.indexOf('$$', open + 2));
}

describe('migracja 00214 (tekst; zachowanie na bazie w tests/rls-akceptacja-kosztow.test.ts)', () => {
  it('nagłówek: PRZED wdrożeniem, po 00197; opis zmiany CHECK; bez DROP tabel i kolumn, bez DML przy wgraniu', () => {
    const tekst = sql();
    expect(tekst).toMatch(/KIEDY WGRAĆ: PRZED wdrożeniem, po 00197/);
    expect(tekst).toMatch(/ZMIANA CHECK: app_notifications_kind_check/);
    expect(outsideBodies(tekst)).not.toMatch(/\b(DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|UPDATE\s+public\.|INSERT\s+INTO)\b/i);
  });

  it('dzwonek: CHECK rodzajów to pełna lista z 00197 i jeden nowy rodzaj, z tą samą nazwą ograniczenia', () => {
    const tekst = outsideBodies(sql());
    expect(tekst).toContain('DROP CONSTRAINT IF EXISTS app_notifications_kind_check');
    expect(tekst).toMatch(
      /ADD CONSTRAINT app_notifications_kind_check CHECK \(kind IN \('inbox_new', 'invoice_accepted', 'invoice_rejected', 'tax_deadline', 'expense_comment', 'expense_document_request', 'payment_received', 'expense_needs_changes'\)\)/,
    );
  });

  it('tabela: jeden wiersz na koszt, RLS jak wątek kosztu, bez zapisu kluczem użytkownika', () => {
    const tekst = sql();
    expect(tekst).toContain('expense_id UUID PRIMARY KEY REFERENCES public.expenses(id) ON DELETE CASCADE');
    expect(tekst).toContain('decided_by UUID REFERENCES public.users(id) ON DELETE SET NULL');
    expect(tekst).toContain("CHECK (decision IN ('accepted', 'needs_changes'))");
    expect(tekst).toContain('ALTER TABLE public.expense_acceptances ENABLE ROW LEVEL SECURITY;');
    expect(tekst).toMatch(/FOR SELECT TO authenticated\s+USING \(\s*tenant_id = public\.get_current_tenant_id\(\)\s+AND EXISTS \(/);
    expect(tekst).toMatch(/FROM public\.expenses AS e\s+WHERE e\.id = expense_acceptances\.expense_id\s+AND e\.tenant_id = expense_acceptances\.tenant_id/);
    expect(tekst).toContain('REVOKE ALL ON public.expense_acceptances FROM PUBLIC, anon, authenticated, service_role;');
    expect(tekst).toContain('GRANT SELECT ON public.expense_acceptances TO authenticated;');
    expect(tekst).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*TO authenticated/);
    expect(tekst).not.toMatch(/GRANT[^;]*TO[^;]*\banon\b/);
  });

  it('odcisk: pola księgowe kosztu z pochodzeniem i danymi z odczytu, bez płatności, notatek, dat zapisu i przeglądu (niezmienniki 3 i 4)', () => {
    const fp = body(sql(), 'expense_acceptance_fingerprint');
    for (const pole of [
      'document_type', 'document_number', 'issue_date', 'seller_name', 'seller_nip', 'seller_address',
      'net_amount', 'vat_amount', 'gross_amount', 'vat_rate', 'vat_deductible_amount', 'is_deductible',
      'kpir_column', 'category_label', 'source_file_path', 'ksef_invoice_id',
      // Rodzaj dokumentu w KPiR i JPK oraz kurs i kwoty w złotych (lib/exports/data-fetcher.ts).
      'source', 'ocr_extracted_data',
    ]) {
      expect(fp, pole).toContain(`p_expense.${pole}`);
    }
    for (const pole of ['paid_at', 'payment_', 'notes', 'updated_at', 'created_at', 'is_reviewed']) {
      expect(fp, pole).not.toContain(`p_expense.${pole}`);
    }
  });

  it('decyzja: SECURITY DEFINER z pustym search_path, tylko księgowa aktywnej firmy z sesji, EXECUTE tylko authenticated', () => {
    const tekst = sql();
    const fn = 'expense_acceptance_decide(UUID, TEXT, TEXT, TEXT)';
    expect(tekst).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated, service_role;`);
    expect(tekst).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO authenticated;`);
    expect(tekst).toMatch(/FUNCTION public\.expense_acceptance_decide\([\s\S]*?SECURITY DEFINER\s+SET search_path = ''/);
    const decide = body(tekst, 'expense_acceptance_decide');
    expect(decide).toContain('v_user UUID := auth.uid();');
    expect(decide).toContain('v_tenant := public.get_current_tenant_id();');
    expect(decide).toMatch(/WHERE m\.organization_id = v_tenant\s+AND m\.user_id = v_user\s+AND m\.status = 'active'/);
    expect(decide).toContain("IF v_role <> 'accountant' THEN");
    // Koszt tylko z aktywnej firmy, z blokadą wiersza (edycja w tej samej chwili idzie po kolei).
    expect(decide).toMatch(/FROM public\.expenses AS e\s+WHERE e\.id = p_expense_id\s+AND e\.tenant_id = v_tenant\s+FOR UPDATE OF e;/);
    // Księgowa decyduje o treści, którą widziała: inny odcisk to odmowa „changed”.
    expect(decide).toContain("'code', 'changed'");
    expect(decide).toContain("'expense.accepted'");
    expect(decide).toContain("'expense.needs_changes'");
    expect(decide).toContain('ON CONFLICT ON CONSTRAINT app_notifications_klucz_unikalny DO NOTHING');
    expect(decide).toContain("'/expenses/' || p_expense_id::text || '#akceptacja'");
  });

  it('stan: SECURITY INVOKER (RLS czytającego), odcisk bieżącej treści i czy decyzja jest aktualna', () => {
    const tekst = sql();
    expect(tekst).toMatch(/FUNCTION public\.expense_acceptance_state\(p_expense_id UUID\)[\s\S]*?SECURITY INVOKER\s+SET search_path = ''/);
    const state = body(tekst, 'expense_acceptance_state');
    expect(state).toContain("'current_fingerprint', public.expense_acceptance_fingerprint(e)");
    expect(state).toContain("'is_current'");
    expect(tekst).toContain('GRANT EXECUTE ON FUNCTION public.expense_acceptance_state(UUID) TO authenticated;');
    expect(tekst).toContain('NOTIFY pgrst, \'reload schema\';');
  });
});
