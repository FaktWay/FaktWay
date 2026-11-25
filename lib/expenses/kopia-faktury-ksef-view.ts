/**
 * Stan kopii faktury z KSeF (FZ-022, decyzja D29, 00215) dla strony kosztu
 * (`/expenses/[id]`), Skrzynki KSeF i listy kosztów. Odczyt klientem z sesji
 * (RLS: tylko aktywna firma). Błąd odczytu to brak informacji, a nie błąd
 * strony: koszt dalej da się przejrzeć, a odmowa odczytu z #839 i tak chroni
 * KPiR i JPK.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface KsefCopyDoc {
  expenseId: string;
  number: string | null;
  issueDate: string;
  gross: number;
  /** Źródło kosztu (`ocr_photo`, `manual`, `import`, `ksef_inbox`). */
  source: string;
}

export interface KsefCopyView {
  /** Ten koszt to koszt z KSeF (`ksef`) albo kopia spoza KSeF (`copy`). */
  role: 'ksef' | 'copy';
  /** `linked`: kopia poza KPiR, koszt z faktury z KSeF; `candidates`: zadanie „Połącz koszty”. */
  state: 'linked' | 'candidates';
  /** Koszt z KSeF, przy którym zapada decyzja (przy kopii `null`: decyzja na stronie faktury z KSeF). */
  ksefExpenseId: string | null;
  /** Koszty z drugiej strony (przy kopii: koszt z KSeF). */
  docs: KsefCopyDoc[];
}

type CopyRow = { ksef_expense_id: string; copy_expense_id: string; status: string };

const OPEN = ['linked', 'candidate'];
/** Kawałki listy id do filtra `in` (adres zapytania PostgREST ma limit długości). */
const ID_CHUNK = 100;

/** Tabela 00215 jeszcze nie jest w wygenerowanych typach bazy (types/database.ts po wgraniu migracji). */
const db = (supabase: unknown) => supabase as SupabaseClient;

export async function loadKsefCopyView(supabase: unknown, tenantId: string, expenseId: string): Promise<KsefCopyView | null> {
  const client = db(supabase);
  const kolumny = 'ksef_expense_id, copy_expense_id, status';
  const [asKsef, asCopy] = await Promise.all([
    client.from('expense_ksef_copies').select(kolumny).eq('tenant_id', tenantId).eq('ksef_expense_id', expenseId).in('status', OPEN),
    client.from('expense_ksef_copies').select(kolumny).eq('tenant_id', tenantId).eq('copy_expense_id', expenseId).in('status', OPEN),
  ]);
  if (asKsef.error || asCopy.error) {
    console.error('[expenses] odczyt kopii faktury z KSeF', asKsef.error ?? asCopy.error);
    return null;
  }

  const ksefRows = (asKsef.data ?? []) as CopyRow[];
  const copyRows = (asCopy.data ?? []) as CopyRow[];
  const role: KsefCopyView['role'] | null = ksefRows.length ? 'ksef' : copyRows.length ? 'copy' : null;
  if (!role) return null;
  const rows = role === 'ksef' ? ksefRows : copyRows;
  const linked = rows.find((r) => r.status === 'linked');
  const other = (r: CopyRow) => (role === 'ksef' ? r.copy_expense_id : r.ksef_expense_id);
  const ids = linked ? [other(linked)] : [...new Set(rows.map(other))];

  const { data, error } = await client
    .from('expenses')
    .select('id, document_number, issue_date, gross_amount, source')
    .eq('tenant_id', tenantId)
    .in('id', ids);
  if (error) {
    console.error('[expenses] odczyt kosztów kopii faktury z KSeF', error);
    return null;
  }
  const docs = ((data ?? []) as Array<Record<string, unknown>>)
    .map((d) => ({
      expenseId: String(d.id),
      number: typeof d.document_number === 'string' ? d.document_number.trim() || null : null,
      issueDate: String(d.issue_date),
      gross: Number(d.gross_amount ?? 0),
      source: String(d.source),
    }))
    .sort((a, b) => a.issueDate.localeCompare(b.issueDate) || a.expenseId.localeCompare(b.expenseId));
  return { role, state: linked ? 'linked' : 'candidates', ksefExpenseId: role === 'ksef' ? expenseId : null, docs };
}

/**
 * Koszty z KSeF z otwartym zadaniem „Połącz koszty” (kandydatki bez połączenia)
 * wśród `expenseIds` (Skrzynka KSeF). Błąd odczytu: `null`, tabela zostaje bez
 * dopisku, a zadanie widać dalej na stronie kosztu.
 */
export async function loadKsefCopyTasks(supabase: unknown, tenantId: string, expenseIds: readonly string[]): Promise<Set<string> | null> {
  const client = db(supabase);
  const zadania = new Set<string>();
  const polaczone = new Set<string>();
  for (let i = 0; i < expenseIds.length; i += ID_CHUNK) {
    const { data, error } = await client
      .from('expense_ksef_copies')
      .select('ksef_expense_id, status')
      .eq('tenant_id', tenantId)
      .in('ksef_expense_id', expenseIds.slice(i, i + ID_CHUNK))
      .in('status', OPEN);
    if (error) {
      console.error('[inbox] odczyt zadań kopii faktur z KSeF', error);
      return null;
    }
    for (const row of (data ?? []) as Array<{ ksef_expense_id: string; status: string }>) {
      (row.status === 'linked' ? polaczone : zadania).add(row.ksef_expense_id);
    }
  }
  return new Set([...zadania].filter((id) => !polaczone.has(id)));
}

/**
 * Kopie połączone z kosztem z KSeF wśród `expenseIds` (lista kosztów: dopisek
 * „Kopia faktury z KSeF”). Błąd odczytu: pusta lista, lista zostaje bez dopisku.
 */
export async function loadLinkedKsefCopyIds(supabase: unknown, tenantId: string, expenseIds: readonly string[]): Promise<string[]> {
  const client = db(supabase);
  const out: string[] = [];
  for (let i = 0; i < expenseIds.length; i += ID_CHUNK) {
    const { data, error } = await client
      .from('expense_ksef_copies')
      .select('copy_expense_id')
      .eq('tenant_id', tenantId)
      .in('copy_expense_id', expenseIds.slice(i, i + ID_CHUNK))
      .eq('status', 'linked');
    if (error) {
      console.error('[expenses] odczyt kopii faktur z KSeF na liście', error);
      return [];
    }
    for (const row of (data ?? []) as Array<{ copy_expense_id: string }>) out.push(row.copy_expense_id);
  }
  return out;
}
