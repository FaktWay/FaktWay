import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  formProps: [] as Array<Record<string, unknown>>,
  loadSeller: vi.fn(),
  loadAutosave: vi.fn(),
}));

vi.mock('@/lib/supabase/page-context', () => ({
  getPageContext: vi.fn().mockResolvedValue({ supabase: {}, user: { id: 'user-a' }, tenantId: 'tenant-a' }),
}));
vi.mock('@/components/invoices/actions', () => ({
  prefillFromLastInvoiceAction: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/invoices/vat-exemption', () => ({
  readTenantVatExemption: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/invoices/next-number', () => ({
  suggestNextInvoiceNumberForTenant: vi.fn().mockResolvedValue('FV/1/10/2026'),
}));
vi.mock('@/lib/invoices/form-autosave', () => ({ loadInvoiceAutosave: m.loadAutosave }));
vi.mock('@/lib/invoices/load-tenant-seller', () => ({ loadTenantSellerForForms: m.loadSeller }));
vi.mock('@/components/invoices/invoice-form', () => ({
  InvoiceForm: (props: Record<string, unknown>) => {
    m.formProps.push(props);
    return null;
  },
}));

import NewRegularInvoicePage from '@/app/(dashboard)/invoices/new/regular/page';

/**
 * C1 (E9): propsy strony nie mogą być opcjonalne jako całość (`= {}`) —
 * Next generuje `.next/types/.../page.ts` z ograniczeniem `PageProps`,
 * a `{…} | undefined` go nie spełnia (TS2344, „Next build” czerwone).
 * `pnpm typecheck` tych typów nie widzi bez builda, więc pilnujemy tu:
 * przy `= {}` poniższe przypisanie jest błędem kompilacji.
 */
type RegularPageProps = Parameters<typeof NewRegularInvoicePage>[0];
export const propsStronyWymagane: undefined extends RegularPageProps ? 'opcjonalne' : 'wymagane' = 'wymagane';

/**
 * P5: strona faktury zwykłej dokłada sprzedawcę do nagłówka dokumentu.
 * To tylko wyświetlanie — błąd odczytu nie może zablokować formularza,
 * a numer, podkład i zwolnienie z VAT idą do formularza jak przed P5.
 */
describe('strona /invoices/new/regular — sprzedawca w nagłówku', () => {
  beforeEach(() => {
    m.formProps.length = 0;
    m.loadSeller.mockReset();
    m.loadAutosave.mockReset();
    m.loadAutosave.mockResolvedValue(null);
  });

  it('przekazuje sprzedawcę z profilu firmy obok numeru i podkładu', async () => {
    const seller = {
      nip: '1234567890', name: 'Firma',
      address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' },
    };
    m.loadSeller.mockResolvedValue({ tenantId: 'tenant-a', seller });
    renderToStaticMarkup(await NewRegularInvoicePage({}));
    expect(m.formProps.at(-1)).toMatchObject({
      seller,
      suggestedNumber: 'FV/1/10/2026',
      prefill: null,
      vatExempt: false,
      // UX-01: firma tej strony idzie do formularza, a zapis odsyła ją akcji.
      tenantId: 'tenant-a',
    });
  });

  it('błąd odczytu sprzedawcy nie blokuje formularza (seller = null)', async () => {
    m.loadSeller.mockRejectedValue(new Error('admin client unavailable'));
    renderToStaticMarkup(await NewRegularInvoicePage({}));
    expect(m.formProps.at(-1)).toMatchObject({ seller: null, suggestedNumber: 'FV/1/10/2026', tenantId: 'tenant-a' });
  });
});

/** Krok 2.8: niezakończona praca z autozapisu tylko przy pustym formularzu, dla osoby z sesji. */
describe('strona /invoices/new/regular — przywracanie autozapisu', () => {
  const kopia = { requestKey: '11111111-1111-4111-8111-111111111111', values: { buyerName: 'Acme' }, savedAt: '2026-11-15T17:30:00.000Z' };

  beforeEach(() => {
    m.formProps.length = 0;
    m.loadSeller.mockReset();
    m.loadSeller.mockResolvedValue(null);
    m.loadAutosave.mockReset();
    m.loadAutosave.mockResolvedValue(kopia);
  });

  it('pusty formularz dostaje kopię roboczą osoby z sesji w aktywnej firmie', async () => {
    renderToStaticMarkup(await NewRegularInvoicePage({ searchParams: Promise.resolve({}) }));
    expect(m.loadAutosave).toHaveBeenCalledWith(expect.anything(), 'tenant-a', 'user-a');
    expect(m.formProps.at(-1)).toMatchObject({ restoredDraft: kopia });
  });

  it('z parametrem podkładu (?wzor=) niczego nie proponuje i nie czyta kopii', async () => {
    renderToStaticMarkup(await NewRegularInvoicePage({ searchParams: Promise.resolve({ wzor: 'nieistniejacy' }) }));
    expect(m.loadAutosave).not.toHaveBeenCalled();
    expect(m.formProps.at(-1)).toMatchObject({ restoredDraft: null });
  });
});
