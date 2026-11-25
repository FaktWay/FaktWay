import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoryTables, Row } from './helpers/baza-w-pamieci';

const db = vi.hoisted(() => ({ tables: {} as MemoryTables }));
const TENANT = '11111111-1111-4111-8111-111111111111';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/components/invoices/actions-detail', () => ({ downloadInvoiceXmlAction: vi.fn() }));
vi.mock('@/components/invoices/draft-actions', () => ({ deleteDraftInvoiceAction: vi.fn(), sendDraftInvoiceAction: vi.fn() }));
vi.mock('@/components/invoices/email-invoice-button', () => ({ EmailInvoiceButton: () => null }));
vi.mock('@/components/invoices/failed-invoice-actions', () => ({ FailedInvoiceActions: () => null }));
vi.mock('@/components/invoices/draft-invoice-actions', () => ({ DraftInvoiceActions: () => null }));
vi.mock('@/lib/download', () => ({ saveBlob: vi.fn() }));
// Fikcyjny NIP 1234567890 (AGENTS.md) nie ma sumy kontrolnej; reszta kalkulatora prawdziwa.
vi.mock('@/lib/xml/invoice-calculator', async (orig) => ({
  ...(await orig<typeof import('@/lib/xml/invoice-calculator')>()),
  validateNipChecksum: () => true,
}));
vi.mock('@/lib/supabase/admin', async () => {
  const { memoryClient } = await import('./helpers/baza-w-pamieci');
  return { createAdminClient: () => memoryClient(db.tables) };
});
vi.mock('@/lib/supabase/auth-context', async () => {
  const { memoryClient } = await import('./helpers/baza-w-pamieci');
  return {
    requireUserAndActiveOrg: async () => ({ supabase: memoryClient(db.tables), user: { id: 'uzytkownik' }, tenantId: TENANT, role: 'owner' }),
    ActionAuthError: class ActionAuthError extends Error {},
  };
});

import { getCorrectionParentContextAction } from '@/components/invoices/correction-actions';
import { InvoiceActions } from '@/components/invoices/invoice-actions';
import { documentGrossPrices } from '@/lib/invoices/document-lines';
import {
  correctionRefusalFromLines,
  loadInvoiceListRowFacts,
  type CorrectionLineFacts,
  type ListRowFactsRow,
} from '@/lib/invoices/list-row-facts';
import type { PageContext } from '@/lib/supabase/page-context';
import { memoryClient } from './helpers/baza-w-pamieci';

/**
 * Ustalenie 17 z dziennika planu (uwaga N3 czytelnika #888): lista faktur
 * i szczegóły faktury proponowały „Korekta” przy fakturze, której formularz
 * korekty zawsze odmawia: pozycja bez ceny netto (faktura w cenach brutto,
 * FaktWay albo plik z KSeF z `P_9B`) albo bez ilości. Klient dowiadywał się
 * o odmowie dopiero po wejściu w formularz.
 *
 * Jeden stan bazy, trzy drogi: odmowa formularza korekty (prawdziwa akcja
 * strony korekty), „Korekta” w menu listy (`loadInvoiceListRowFacts`) i powód
 * w szczegółach faktury (`correctionRefusalFromLines`, ten sam tekst co odmowa).
 * Atrapy: sesja, kolejka KSeF, dziennik.
 */

const PARENT = '00000000-0000-4000-8000-000000000001';
const NUMER = 'FV 7/11/2026';
const SPRZEDAWCA = { nip: '1234567890', name: 'Firma testowa', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } };
const NABYWCA = { nip: '1234567890', name: 'Klient testowy', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' } };

/** 3 × 1,00 zł brutto przy 23 %: VAT stawki 0,56 od 3,00, netto pozycji 0,81 / 0,81 / 0,82 (#835). */
const POZYCJE = [
  { net: 0.81, vat: 0.19, gross: 1 },
  { net: 0.81, vat: 0.19, gross: 1 },
  { net: 0.82, vat: 0.18, gross: 1 },
];
const LINIE_DOKUMENTU = POZYCJE.map((p, i) => ({
  ordinal: i + 1, name: `Kawa ${i + 1}`, unit: 'szt.', quantity: 1, unitPriceGross: 1, vatRate: '23',
  netAmount: p.net, vatAmount: p.vat, grossAmount: p.gross,
}));

function faktura(fa3: Record<string, unknown>, pozycja: (i: number) => { quantity: number | null; unit_price_net: number | null }) {
  db.tables.invoices!.push({
    id: PARENT, tenant_id: TENANT, direction: 'outgoing', invoice_kind: 'regular', invoice_type: 'VAT', origin: 'app',
    ksef_status: 'accepted', ksef_environment: 'test', ksef_number: '1234567890-20261102-0100001AF601-B1', currency: 'PLN',
    internal_number: NUMER, issue_date: '2026-11-02', payment_status: 'unpaid', paid_amount: 0, payment_due_date: '2026-11-16',
    net_total: 2.44, vat_total: 0.56, gross_total: 3, advance_invoice_ids: [],
    seller_data: SPRZEDAWCA, buyer_data: NABYWCA,
    fa3_data: { internalNumber: NUMER, ...fa3 },
  });
  db.tables.invoice_line_items!.push(...POZYCJE.map((p, i) => ({
    id: `${PARENT}-${i + 1}`, invoice_id: PARENT, ordinal: i + 1, name: `Kawa ${i + 1}`, unit: 'szt.',
    ...pozycja(i), net_amount: p.net, vat_rate: '23', vat_amount: p.vat, gross_amount: p.gross,
  })));
}

const CENA_NETTO = (i: number) => POZYCJE[i]!.net;

async function trzyDrogi() {
  const ctx = await getCorrectionParentContextAction(PARENT);
  const row = db.tables.invoices![0]! as Row;
  const lines = db.tables.invoice_line_items! as unknown as CorrectionLineFacts[];
  const refusal = correctionRefusalFromLines(lines, documentGrossPrices(row.fa3_data as Parameters<typeof documentGrossPrices>[0]), NUMER);
  const facts = await loadInvoiceListRowFacts(
    memoryClient(db.tables) as unknown as PageContext['supabase'],
    TENANT,
    [row as unknown as ListRowFactsRow],
  );
  return { ctx, refusal, canCorrect: facts.get(PARENT)!.canCorrect };
}

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
  db.tables = { tenants: [{ id: TENANT, nip: '1234567890', name: 'Firma testowa', address_json: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } }], invoices: [], invoice_line_items: [] };
});

describe('„Korekta” tylko przy fakturze, którą przyjmie formularz korekty (ustalenie 17)', () => {
  it.each([
    ['faktura FaktWay w cenach brutto', { pricesGross: true, lines: LINIE_DOKUMENTU }, () => ({ quantity: 1, unit_price_net: null }), /w cenach brutto/],
    ['plik z KSeF z ceną brutto pozycji (P_9B)', { ksefLineFields: POZYCJE.map((_, i) => ({ ordinal: i + 1, P_9B: 1 })) }, () => ({ quantity: 1, unit_price_net: null }), /w cenach brutto/],
    ['pozycja bez ceny netto i bez ceny brutto w dokumencie', { lines: LINIE_DOKUMENTU.map(({ unitPriceGross: _cena, ...l }) => l) }, () => ({ quantity: 1, unit_price_net: null }), /bez pełnej ilości lub ceny/],
    ['pozycja bez ilości', { lines: LINIE_DOKUMENTU }, (i: number) => ({ quantity: i === 1 ? null : 1, unit_price_net: CENA_NETTO(i) }), /bez pełnej ilości lub ceny/],
  ] as const)('%s: formularz odmawia, lista bez „Korekta”, szczegóły mówią to samo co odmowa', async (_label, fa3, pozycja, przyczyna) => {
    faktura(fa3, pozycja);
    const { ctx, refusal, canCorrect } = await trzyDrogi();
    expect(ctx.success).toBe(false);
    const error = ctx.success ? '' : ctx.error;
    expect(error).toMatch(przyczyna);
    expect(error).toContain(NUMER);
    expect(error).toMatch(/Napisz do nas/);
    expect(refusal).toBe(error);
    expect(canCorrect).toBe(false);
  });

  it('faktura w cenach netto z pełnymi pozycjami: formularz przyjmuje, lista ma „Korekta”, szczegóły bez powodu', async () => {
    faktura({ lines: LINIE_DOKUMENTU }, (i) => ({ quantity: 1, unit_price_net: CENA_NETTO(i) }));
    const { ctx, refusal, canCorrect } = await trzyDrogi();
    expect(ctx.success).toBe(true);
    expect(refusal).toBeNull();
    expect(canCorrect).toBe(true);
  });

  it('lista czyta pozycje tylko kandydatów na korektę, z filtrem braków; szkic bez odczytu', async () => {
    faktura({ pricesGross: true, lines: LINIE_DOKUMENTU }, () => ({ quantity: 1, unit_price_net: null }));
    const draft = { ...(db.tables.invoices![0] as Row), id: '00000000-0000-4000-8000-000000000002', ksef_status: 'draft', ksef_number: null };
    const reads: string[] = [];
    const client = memoryClient(db.tables);
    const spy = { from: (table: string) => { reads.push(table); return client.from(table); } };
    const facts = await loadInvoiceListRowFacts(spy as unknown as PageContext['supabase'], TENANT, [draft as unknown as ListRowFactsRow]);
    expect(facts.get(draft.id as string)!.canCorrect).toBe(false);
    expect(reads).not.toContain('invoice_line_items');
  });
});

describe('szczegóły faktury: powód zamiast linku „Korekta” (ustalenie 17)', () => {
  const FACTS = { sendData: 'stored', kindHeld: false, issueDatePassed: false } as const;
  const render = (invoice: { can_correct: boolean; correction_refusal?: string | null }) =>
    renderToStaticMarkup(
      <InvoiceActions
        section="secondary"
        invoice={{
          id: PARENT,
          ksef_status: 'accepted',
          xml_storage_path: null,
          invoice_type: 'VAT',
          invoice_kind: 'regular',
          ksef_resend_facts: FACTS,
          ksef_environment_known: true,
          ...invoice,
        }}
      />,
    );

  it('faktura z odmową: powód z wyjściem, bez linku do formularza korekty', () => {
    const html = render({ can_correct: false, correction_refusal: 'Faktura FV 7/11/2026 jest w cenach brutto. Napisz do nas, a przygotujemy korektę z Tobą.' });
    expect(html).toContain('Napisz do nas, a przygotujemy korektę z Tobą.');
    expect(html).not.toContain('/invoices/new/correction');
  });

  it('faktura do korekty: link „Korekta”, bez powodu', () => {
    const html = render({ can_correct: true, correction_refusal: null });
    expect(html).toContain(`/invoices/new/correction?parentId=${PARENT}`);
    expect(html).not.toContain('Napisz do nas');
  });
});
