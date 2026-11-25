// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan kompletnej aplikacji, krok 2.8: numer zamówienia na szczegółach faktury
 * i czytanie go z dokumentu faktury (`fa3_data.order`). Prawdziwy widok
 * szczegółów i prawdziwe funkcje czytania; atrapy tylko Realtime, routera
 * i paska akcji (jak w `szczegoly-faktury-ekran.test.tsx`).
 */

const realtime = vi.hoisted(() => ({ handlers: [] as Array<(payload: { new: Record<string, unknown> }) => void> }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const ch = {
      on: (_e: unknown, _f: unknown, cb: (payload: { new: Record<string, unknown> }) => void) => { realtime.handlers.push(cb); return ch; },
      subscribe: () => ch,
    };
    return { channel: () => ch, removeChannel: vi.fn() };
  },
}));
// C9: widok woła `useRouter().refresh()` po zmianie statusu / numeru / XML z Realtime
// (QR i „Korekta” liczy serwer) — poza drzewem aplikacji Next hook rzuca, więc stały szpieg.
vi.mock('next/navigation', () => {
  const router = { refresh: vi.fn(), push: vi.fn() };
  return { useRouter: () => router };
});
// Pasek akcji: zapisujemy props, żeby sprawdzić, co widok przekazuje przyciskom po błędzie.
const actions = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));
vi.mock('@/components/invoices/invoice-actions', () => ({
  InvoiceActions: (props: Record<string, unknown>) => {
    actions.props.push(props);
    return null;
  },
}));
vi.mock('@/components/invoices/upo-download', () => ({ UpoDownload: () => null }));
// Karta błędu: tekst błędu w znaczniku — D-A4-1b-3 PR B ukrywa ją obok panelu duplikatu.
vi.mock('@/components/invoices/error-display', () => ({
  InvoiceErrorDisplay: ({ errorMessage }: { errorMessage: string }) => <div data-testid="karta-bledu">{errorMessage}</div>,
}));
// Panel decyzji (D-A4-1b-3 PR B): prawdziwy komponent importuje akcje serwerowe — zapisujemy props.
const decisionPanel = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));
vi.mock('@/components/invoices/ksef-duplicate-decision', () => ({
  KsefDuplicateDecision: (props: Record<string, unknown>) => {
    decisionPanel.props.push(props);
    return <div data-testid="panel-decyzji">panel decyzji</div>;
  },
}));

import { InvoiceDetailView, type InvoiceDetailInitial } from '@/components/invoices/invoice-detail-view';
import { orderFromJson, orderLine, orderReferenceView } from '@/lib/invoices/order-reference';
import type { KsefResendFacts } from '@/lib/invoices/ksef-requeue-event';

/** Kopia danych zapisana, rodzaj niewstrzymany, dziś dzień wystawienia (A4b PR2b). */
const STORED: KsefResendFacts = { sendData: 'stored', kindHeld: false, issueDatePassed: false };

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** Pola PR B (2.5) — przez rozwinięcie, żeby fixture kompilował się także przed zmianą typu. */
const NO_DUPLICATE_DECISION = { ksef_duplicate_decision: null, ksef_retired_draft: null };

const base: InvoiceDetailInitial = {
  ...NO_DUPLICATE_DECISION,
  id: 'inv-1',
  internal_number: 'FV/7/10/2026',
  invoice_type: 'VAT',
  invoice_kind: 'regular',
  issue_date: '2026-10-02',
  sale_date: '2026-10-02',
  ksef_status: 'accepted',
  ksef_number: '5260001246-20261002-0100A0B0C0D0-E1',
  ksef_accepted_at: '2026-10-02T05:12:33.123+00:00',
  xml_storage_path: null,
  net_total: '18000.19',
  vat_total: '4140.04',
  gross_total: '22140.23',
  notes: null,
  last_error: null,
  last_error_code: null,
  last_error_field: null,
  last_error_suggestion: null,
  seller_data: { nip: '5260001246', name: 'Moja Firma', address: { addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
  buyer_data: { nip: '5252241585', name: 'Klient', address: { addressLine1: 'ul. B 2', addressLine2: '02-001 Warszawa' } },
  payment_data: {
    method: 'transfer',
    dueDate: '2026-10-16',
    bankAccount: 'PL61109010140000071219812874',
    currency: 'PLN',
    amountDue: 22140.23,
  },
  lines: [
    { ordinal: 1, name: 'Usługa', unit: 'h', quantity: '1.5', unit_price_net: '100.1234', vat_rate: '23', net_amount: '150.19', vat_amount: '34.54', gross_amount: '184.73' },
  ],
  // E3 / P4: pola pochodne liczone przez stronę (waluta, MPP, „Do zapłaty”, korekta, QR).
  currency: 'PLN',
  split_payment: false,
  amount_due: 22140.23,
  can_correct: false,
  qr: null,
  upo_status: null,
  can_manage_send: false,
  ksef_duplicate_original: null,
  ksef_resend_facts: STORED,
  ksef_environment_known: true,
};

function render(initial: InvoiceDetailInitial) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<InvoiceDetailView initial={initial} />));
  // pl-PL grupuje tysiące spacją nierozdzielającą (U+00A0).
  return (host.textContent ?? '').replace(/\u00a0/g, ' ');
}


describe('czytanie numeru zamówienia z dokumentu faktury', () => {
  it('numer z datą i sam numer; przycięcie; zła data to brak daty', () => {
    expect(orderFromJson({ number: ' ZAM/1 ', date: '2026-11-02' })).toEqual({ number: 'ZAM/1', date: '2026-11-02' });
    expect(orderFromJson({ number: 'ZAM/1' })).toEqual({ number: 'ZAM/1' });
    expect(orderFromJson({ number: 'ZAM/1', date: '02.11.2026' })).toEqual({ number: 'ZAM/1' });
  });

  it('brak numeru, zły kształt albo numer dłuższy niż w XSD: brak zamówienia', () => {
    for (const raw of [null, undefined, {}, { date: '2026-11-02' }, { number: '' }, { number: '   ' }, { number: 7 }, 'ZAM/1', [], { number: 'Z'.repeat(257) }]) {
      expect(orderFromJson(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it('wiersz „Zamówienie: …” z datą po polsku albo bez daty', () => {
    expect(orderLine({ number: 'ZAM/1', date: '2026-11-02' })).toBe('Zamówienie: ZAM/1 z dnia 02.11.2026');
    expect(orderLine({ number: 'ZAM/1' })).toBe('Zamówienie: ZAM/1');
  });

  it('widok szczegółów dostaje sam gotowy tekst z fa3_data, reszta dokumentu zostaje na serwerze', () => {
    expect(orderReferenceView({ order: { number: 'ZAM/1', date: '2026-11-02' }, lines: [{ name: 'tajne' }] })).toBe('Zamówienie: ZAM/1 z dnia 02.11.2026');
    expect(orderReferenceView({ lines: [] })).toBeNull();
    expect(orderReferenceView(null)).toBeNull();
  });
});

describe('szczegóły faktury: numer zamówienia', () => {
  it('z numerem: wiersz „Zamówienie” przy datach faktury', () => {
    const t = render({ ...base, order_reference: 'Zamówienie: ZAM/1 z dnia 02.11.2026' });
    expect(t).toContain('Zamówienie: ZAM/1 z dnia 02.11.2026');
  });

  it('bez numeru (także pole nieobecne w starym podkładzie): bez wiersza', () => {
    expect(render({ ...base, order_reference: null })).not.toContain('Zamówienie');
  });
});
