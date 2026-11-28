// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Uwaga drugiego czytelnika #973: odświeżenie na żywo brało `row.last_error_suggestion ?? prev`,
 * więc nowa podpowiedź `null` zostawiała starą („Popraw wskazane dane.”) przy odmowie z własnym
 * wyjściem. Nowy stan wiersza zastępuje podpowiedź (i pole błędu) także wartością null.
 */

type Payload = { new: Record<string, unknown> };
type Handler = (payload: Payload) => void;

const realtime = vi.hoisted(() => ({
  registered: [] as Array<{ table: string; cb: (payload: { new: Record<string, unknown> }) => void }>,
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const ch = {
      on: (_e: unknown, filter: { table: string }, cb: (payload: { new: Record<string, unknown> }) => void) => {
        realtime.registered.push({ table: filter.table, cb });
        return ch;
      },
      subscribe: () => ch,
    };
    return { channel: () => ch, removeChannel: vi.fn() };
  },
}));
// Stabilny obiekt routera (jak w Next): `refresh` jako szpieg.
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const m = vi.hoisted(() => ({
  toDataURL: vi.fn(async (text: string) => `data:image/png;base64,${Buffer.from(text).toString('base64')}`),
}));
vi.mock('qrcode', () => ({ default: { toDataURL: m.toDataURL } }));
const actions = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));
vi.mock('@/components/invoices/invoice-actions', () => ({
  InvoiceActions: (props: Record<string, unknown>) => {
    actions.props.push(props);
    return null;
  },
}));
vi.mock('@/components/invoices/upo-download', () => ({ UpoDownload: () => null }));
vi.mock('@/components/invoices/error-display', () => ({
  InvoiceErrorDisplay: (p: { errorMessage: string; errorField?: string | null; errorSuggestion?: string | null }) => (
    <div data-testid="karta-bledu" data-field={p.errorField ?? ''} data-suggestion={p.errorSuggestion ?? ''}>
      {p.errorMessage}
    </div>
  ),
}));
vi.mock('@/components/invoices/ksef-duplicate-decision', () => ({
  KsefDuplicateDecision: () => <div data-testid="panel-decyzji">panel decyzji</div>,
}));

import { InvoiceDetailView, type InvoiceDetailInitial } from '@/components/invoices/invoice-detail-view';
import type { KsefResendFacts } from '@/lib/invoices/ksef-requeue-event';

const STORED: KsefResendFacts = { sendData: 'stored', kindHeld: false, issueDatePassed: false };

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  realtime.registered.length = 0;
  actions.props.length = 0;
  router.refresh.mockClear();
  m.toDataURL.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** Faktura w kolejce: serwer nie ma jeszcze numeru KSeF, pliku XML, kodu QR ani prawa do korekty. */
const queued: InvoiceDetailInitial = {
  id: 'inv-1',
  internal_number: 'FV/7/10/2026',
  invoice_type: 'VAT',
  invoice_kind: 'regular',
  issue_date: '2026-10-02',
  sale_date: '2026-10-01',
  ksef_status: 'queued',
  ksef_number: null,
  ksef_accepted_at: null,
  xml_storage_path: null,
  net_total: '1150',
  vat_total: '257',
  gross_total: '1407',
  notes: null,
  last_error: null,
  last_error_code: null,
  last_error_field: null,
  last_error_suggestion: null,
  seller_data: { nip: '5260001246', name: 'Moja Firma', address: { addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
  buyer_data: { nip: '5252241585', name: 'Klient Sp. z o.o.', address: { addressLine1: 'ul. B 2', addressLine2: '02-001 Warszawa' } },
  payment_data: null,
  lines: [
    { ordinal: 1, name: 'Usługa A', unit: 'szt.', quantity: '1', unit_price_net: '1150', vat_rate: '23', net_amount: '1150', vat_amount: '257', gross_amount: '1407' },
  ],
  currency: 'PLN',
  split_payment: false,
  amount_due: 1407,
  can_correct: false,
  qr: null,
  upo_status: null,
  can_manage_send: true,
  ksef_duplicate_original: null,
  ksef_resend_facts: STORED,
  ksef_environment_known: true,
  ksef_duplicate_decision: null,
  ksef_retired_draft: null,
};

function mount(initial: InvoiceDetailInitial, strict = false) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const view = <InvoiceDetailView initial={initial} />;
  act(() => root!.render(strict ? <StrictMode>{view}</StrictMode> : view));
  return host;
}

/** Ostatnio zarejestrowany uchwyt UPDATE tabeli `invoices` (StrictMode montuje efekt dwa razy). */
function invoiceUpdate(): Handler {
  const entry = [...realtime.registered].reverse().find((r) => r.table === 'invoices');
  if (!entry) throw new Error('brak uchwytu Realtime dla tabeli invoices');
  return entry.cb;
}

function emit(row: Record<string, unknown>) {
  const handler = invoiceUpdate();
  act(() => handler({ new: row }));
}



const rejected: InvoiceDetailInitial = {
  ...queued,
  ksef_status: 'rejected',
  last_error: 'Odmowa A',
  last_error_code: 'X1',
  last_error_field: 'buyer_data.nip',
  last_error_suggestion: 'Popraw wskazane dane.',
};

describe('podpowiedź błędu na żywo', () => {
  it('nowy stan z podpowiedzią null zastępuje starą podpowiedź i pole', () => {
    const el = mount(rejected);
    expect(el.querySelector('[data-testid="karta-bledu"]')?.getAttribute('data-suggestion')).toBe('Popraw wskazane dane.');
    emit({ ksef_status: 'rejected', last_error: 'Odmowa B', last_error_code: 'X2', last_error_field: null, last_error_suggestion: null });
    const card = el.querySelector('[data-testid="karta-bledu"]');
    expect(card?.textContent).toBe('Odmowa B');
    expect(card?.getAttribute('data-suggestion')).toBe('');
    expect(card?.getAttribute('data-field')).toBe('');
  });

  it('wiersz bez pola podpowiedzi zostawia dotychczasową', () => {
    const el = mount(rejected);
    emit({ ksef_status: 'rejected' });
    expect(el.querySelector('[data-testid="karta-bledu"]')?.getAttribute('data-suggestion')).toBe('Popraw wskazane dane.');
  });
});
