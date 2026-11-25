import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '@/types/database';

import { memoryClient, type Row } from './helpers/baza-w-pamieci';

/**
 * FZ-022, decyzja D29 (00215), ekran: kopia faktury z KSeF na stronie kosztu
 * (zadanie „Połącz koszty” z wyborem i „To osobne dokumenty”, „Rozłącz” przy
 * połączeniu, informacja przy kopii i zablokowane „Uwzględnij w KPiR”),
 * dopisek w Skrzynce KSeF i na liście kosztów, akcja decyzji klienta. Odczyt
 * stanu z bazy w pamięci tymi samymi funkcjami co strony.
 */

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  auth: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/app/actions/expenses', () => ({ deleteExpenseAction: vi.fn(), reviewExpenseAction: vi.fn() }));
vi.mock('@/app/actions/receipt-invoice-match', () => ({ decideReceiptMatchAction: vi.fn() }));
vi.mock('@/lib/supabase/auth-context', () => ({ requireUserAndActiveOrg: mocks.auth }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc: mocks.rpc }) }));

const { ExpenseEditForm } = await import('@/components/expenses/expense-edit-form');
const { loadKsefCopyView, loadKsefCopyTasks, loadLinkedKsefCopyIds } = await import('@/lib/expenses/kopia-faktury-ksef-view');
const { buildInboxRows } = await import('@/app/(dashboard)/(koszty)/inbox/_components/inbox-rows');
const { InboxTable, KSEF_COPY_TASK_NOTE } = await import('@/app/(dashboard)/(koszty)/inbox/_components/inbox-table');
const { ExpensesTable } = await import('@/components/expenses/finora/expenses-table');
const { KSEF_COPY_LABEL } = await import('@/components/expenses/expenses-list');
const { decideKsefCopyAction } = await import('@/app/actions/kopia-faktury-ksef');

type ExpenseRow = Database['public']['Tables']['expenses']['Row'];
const TENANT = 'firma-a';
const KSEF_ID = '11111111-1111-4111-8111-111111111111';
const COPY_A = '22222222-2222-4222-8222-222222222221';
const COPY_B = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

function wydatek(id: string, fields: Partial<ExpenseRow> = {}): ExpenseRow {
  return {
    id, tenant_id: TENANT, created_by: null, source: 'ocr_photo', ksef_invoice_id: null,
    is_deductible: true, is_reviewed: true, issue_date: '2027-02-05',
    document_number: 'FV/7/02/2027', document_type: 'invoice',
    seller_name: 'Sklep Przykład', seller_nip: '5260001246', seller_address: null,
    net_amount: 100, vat_amount: 23, gross_amount: 123, vat_deductible_amount: 23, vat_rate: '23',
    kpir_column: 'col_13', category_label: 'Usługi',
    ocr_extracted_data: null,
    categorization_confidence: null, categorization_method: null, notes: null, ocr_job_id: null,
    source_file_mime: null, source_file_path: null,
    created_at: '2027-02-05T10:00:00Z', updated_at: '2027-02-05T10:00:00Z',
    ...fields,
  } as ExpenseRow;
}

const KSEF = wydatek(KSEF_ID, { source: 'ksef_inbox', ksef_invoice_id: 'inv-1', is_reviewed: false });
const KOPIA_A = wydatek(COPY_A);
const KOPIA_B = wydatek(COPY_B, { source: 'manual', issue_date: '2027-02-06' });

function baza(copies: Row[], expenses: ExpenseRow[] = [KSEF, KOPIA_A, KOPIA_B]) {
  return memoryClient({ expenses: expenses as unknown as Row[], expense_ksef_copies: copies });
}

const k = (copy: string, status: string, ksef = KSEF_ID): Row => ({ tenant_id: TENANT, ksef_expense_id: ksef, copy_expense_id: copy, status });

async function ekran(expense: ExpenseRow, copies: Row[]) {
  const ksefCopy = await loadKsefCopyView(baza(copies), TENANT, expense.id);
  return renderToStaticMarkup(<ExpenseEditForm expense={expense} photoUrl={null} ksefCurrency="PLN" ksefCopy={ksefCopy} />);
}

describe('strona kosztu: kopia faktury z KSeF (D29)', () => {
  it('zadanie przy koszcie z KSeF: obie kopie z wyborem „Połącz koszty”, „To osobne dokumenty” i co z odmową', async () => {
    const markup = await ekran(KSEF, [k(COPY_A, 'candidate'), k(COPY_B, 'candidate')]);
    expect(markup).toContain('Ta faktura jest w kosztach także jako kopia');
    expect(markup).toContain('Zdjęcie FV/7/02/2027 z 05.02.2027, 123,00 zł');
    expect(markup).toContain('Wpis ręczny FV/7/02/2027 z 06.02.2027, 123,00 zł');
    expect(markup.match(/Połącz koszty/g)).toHaveLength(2);
    expect(markup).toContain('To osobne dokumenty');
    expect(markup).toContain('dopóki przy jednym z kosztów nie wyłączy się');
  });

  it('połączona kopia przy koszcie z KSeF: informacja i „Rozłącz”, bez wyboru', async () => {
    const markup = await ekran(KSEF, [k(COPY_A, 'linked'), k(COPY_B, 'dismissed')]);
    expect(markup).toContain('Kopia tej faktury jest połączona');
    expect(markup).toContain('>Rozłącz<');
    expect(markup).not.toContain('Połącz koszty');
    expect(markup).toContain(`href="/expenses/${COPY_A}"`);
    expect(markup).not.toContain(`href="/expenses/${COPY_B}"`);
  });

  it('połączona kopia: informacja z odesłaniem do faktury z KSeF, „Uwzględnij w KPiR” zablokowane, bez przycisków decyzji', async () => {
    const markup = await ekran(wydatek(COPY_A, { is_deductible: false }), [k(COPY_A, 'linked')]);
    expect(markup).toContain('Kopia faktury z KSeF');
    expect(markup).toContain(`href="/expenses/${KSEF_ID}"`);
    expect(markup).toContain('Faktura z KSeF FV/7/02/2027 z 05.02.2027, 123,00 zł');
    expect(markup).not.toContain('>Rozłącz<');
    // Pole „Uwzględnij w KPiR” wyłączone (etykieta jak przy innych blokadach przełącznika).
    expect(markup).toContain('cursor-not-allowed opacity-50');
    expect(await ekran(wydatek(COPY_A, { is_deductible: false }), [])).not.toContain('cursor-not-allowed opacity-50');
  });

  it('kopia w zadaniu: ostrzeżenie z odesłaniem do faktury z KSeF, bez wyboru', async () => {
    const markup = await ekran(KOPIA_A, [k(COPY_A, 'candidate'), k(COPY_B, 'candidate')]);
    expect(markup).toContain('Możliwa kopia faktury z KSeF');
    expect(markup).toContain(`href="/expenses/${KSEF_ID}"`);
    expect(markup).not.toContain('Połącz koszty');
    expect(markup).not.toContain('To osobne dokumenty');
  });

  it('po decyzji „to osobne dokumenty” albo rozłączeniu i bez kopii: bez ostrzeżenia', async () => {
    expect(await ekran(KSEF, [k(COPY_A, 'dismissed')])).not.toContain('kopia');
    expect(await ekran(wydatek('inny'), [])).not.toContain('Kopia faktury z KSeF');
  });
});

describe('Skrzynka KSeF i lista kosztów', () => {
  const invoice = (id: string) => ({
    id, internal_number: 'FV/7/02/2027', ksef_number: `ksef-${id}`, issue_date: '2027-02-05', seller_nip: '5260001246',
    seller_data: { name: 'Sklep Przykład', nip: '5260001246' }, fa3_data: {}, gross_total: 123, currency: 'PLN',
    ksef_accepted_at: '2027-02-05T10:00:00Z', origin: 'ksef_inbox',
  });

  it('zadanie „Połącz koszty”: dopisek przy fakturze w tabeli i w karcie; po połączeniu bez dopisku', async () => {
    const zadania = await loadKsefCopyTasks(
      baza([k(COPY_A, 'candidate'), k(COPY_B, 'candidate'), k(COPY_A, 'linked', 'ksef-2'), k(COPY_B, 'candidate', 'ksef-2')]) as never,
      TENANT,
      [KSEF_ID, 'ksef-2'],
    );
    expect(zadania).toEqual(new Set([KSEF_ID]));
    const rows = buildInboxRows(
      [invoice('inv-1'), invoice('inv-2')],
      [{ id: KSEF_ID, ksef_invoice_id: 'inv-1', is_reviewed: true }, { id: 'ksef-2', ksef_invoice_id: 'inv-2', is_reviewed: true }],
      null,
      zadania,
    );
    expect(rows.map((r) => r.ksefCopyTask)).toEqual([true, false]);
    const markup = renderToStaticMarkup(<InboxTable rows={rows} />);
    expect(markup.split(KSEF_COPY_TASK_NOTE)).toHaveLength(3);
  });

  it('lista kosztów: kopia połączona z fakturą z KSeF ma dopisek', async () => {
    const ids = await loadLinkedKsefCopyIds(baza([k(COPY_A, 'linked'), k(COPY_B, 'candidate')]) as never, TENANT, [KSEF_ID, COPY_A, COPY_B]);
    expect(ids).toEqual([COPY_A]);
    const markup = renderToStaticMarkup(
      <ExpensesTable expenses={[KSEF, { ...KOPIA_A, is_deductible: false, ksef_copy: true }, KOPIA_B]} listVariant="month" />,
    );
    expect(markup.split(KSEF_COPY_LABEL).length - 1).toBeGreaterThanOrEqual(1);
    expect(renderToStaticMarkup(<ExpensesTable expenses={[KSEF, KOPIA_A]} listVariant="month" />)).not.toContain(KSEF_COPY_LABEL);
  });
});

describe('decideKsefCopyAction: decyzja klienta', () => {
  beforeEach(() => {
    vi.stubEnv('KSEF_ENV', 'test');
    mocks.rpc.mockReset();
    mocks.auth.mockReset();
    mocks.auth.mockResolvedValue({ user: { id: USER }, tenantId: TENANT });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('połączenie: funkcja 00215 dostaje firmę, osobę, środowisko KSeF aplikacji i wybraną kopię', async () => {
    mocks.rpc.mockResolvedValue({ data: 'linked', error: null });
    expect(await decideKsefCopyAction(KSEF_ID, COPY_A)).toEqual({ success: true, result: 'linked' });
    expect(mocks.rpc).toHaveBeenCalledWith('decide_ksef_expense_copy', {
      p_tenant_id: TENANT, p_ksef_expense_id: KSEF_ID, p_actor_user_id: USER, p_ksef_environment: 'test', p_copy_expense_id: COPY_A,
    });
  });

  it('„Rozłącz” i „To osobne dokumenty”: bez wybranej kopii', async () => {
    mocks.rpc.mockResolvedValue({ data: 'separated', error: null });
    expect(await decideKsefCopyAction(KSEF_ID, null)).toEqual({ success: true, result: 'separated' });
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_copy_expense_id: null });
  });

  it('nieaktualne dane, błąd bazy, złe identyfikatory, brak sesji i brak środowiska KSeF: odmowa z treścią', async () => {
    mocks.rpc.mockResolvedValue({ data: 'stale', error: null });
    expect(await decideKsefCopyAction(KSEF_ID, COPY_A)).toEqual({ success: false, error: 'Koszty zmieniły się w międzyczasie. Odśwież stronę.' });
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect(await decideKsefCopyAction(KSEF_ID, null)).toMatchObject({ success: false, error: 'Nie udało się zapisać decyzji. Spróbuj ponownie za chwilę.' });
    expect(await decideKsefCopyAction('zly', null)).toMatchObject({ success: false, error: 'Nieprawidłowe dane kosztów' });
    mocks.auth.mockRejectedValue(new Error('brak sesji'));
    expect(await decideKsefCopyAction(KSEF_ID, null)).toMatchObject({ success: false, error: 'Brak autoryzacji' });
    mocks.auth.mockResolvedValue({ user: { id: USER }, tenantId: TENANT });
    vi.stubEnv('KSEF_ENV', '');
    mocks.rpc.mockClear();
    expect(await decideKsefCopyAction(KSEF_ID, null)).toMatchObject({ success: false });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
