import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SubscriptionInvoices } from '@/components/settings/subscription-invoices';
import { listSubscriptionInvoices, subscriptionInvoiceRow, type SubscriptionInvoiceRow } from '@/lib/billing/faktury-abonamentu';

/**
 * Krok 8.1 planu kompletnej aplikacji: lista faktur za abonament FaktWay
 * w Ustawieniach → Abonament. Płatności klienta czyta sesja (RLS: własna firma),
 * numery faktur operatora (sprzedawcy) tylko z identyfikatorów z TYCH płatności
 * i tylko kilka kolumn (numer, numer KSeF, status), klientem serwisowym.
 * Atrapa tylko bazy; kod i komponent prawdziwe.
 */

type Row = Record<string, unknown>;
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OBCA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function baza(tables: Record<string, Row[]>, opcje: { blad?: string } = {}) {
  const zapytania: Array<{ tabela: string; kolumny: string; filtry: string[] }> = [];
  return {
    zapytania,
    from(tabela: string) {
      const filtry: Array<(r: Row) => boolean> = [];
      const opisy: string[] = [];
      let kolumny = '';
      let limit = Infinity;
      const q: Record<string, unknown> = {
        select: (c: string) => ((kolumny = c), q),
        eq: (k: string, v: unknown) => (filtry.push((r) => r[k] === v), opisy.push(`${k}=${String(v)}`), q),
        in: (k: string, v: unknown[]) => (filtry.push((r) => v.includes(r[k])), opisy.push(`${k} in`), q),
        order: () => q,
        limit: (n: number) => ((limit = n), q),
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
          zapytania.push({ tabela, kolumny, filtry: opisy });
          if (opcje.blad) return Promise.resolve({ data: null, error: { message: opcje.blad } }).then(ok, ko);
          const data = (tables[tabela] ?? []).filter((r) => filtry.every((f) => f(r))).slice(0, limit);
          return Promise.resolve({ data, error: null }).then(ok, ko);
        },
      };
      return q;
    },
  } as never;
}

const platnosci = (): Row[] => [
  { id: 'p1', tenant_id: TENANT, status: 'succeeded', amount_cents: 4900, paid_at: '2026-11-02T10:00:00Z', vat_invoice_id: 'f1' },
  { id: 'p2', tenant_id: TENANT, status: 'succeeded', amount_cents: 4900, paid_at: '2026-10-02T10:00:00Z', vat_invoice_id: 'f2' },
  { id: 'p3', tenant_id: TENANT, status: 'succeeded', amount_cents: 4900, paid_at: '2026-12-02T10:00:00Z', vat_invoice_id: null },
  { id: 'p4', tenant_id: TENANT, status: 'failed', amount_cents: 4900, paid_at: null, vat_invoice_id: null },
  { id: 'px', tenant_id: OBCA, status: 'succeeded', amount_cents: 1, paid_at: '2026-11-03T10:00:00Z', vat_invoice_id: 'fx' },
];
const faktury = (): Row[] => [
  { id: 'f1', internal_number: 'FF/2026/11/ABC12345', ksef_number: '5260001246-20261102-AAAAAAAAAAAA-01', ksef_status: 'accepted' },
  { id: 'f2', internal_number: 'FF/2026/10/ZZZ99999', ksef_number: null, ksef_status: 'sending', tajne: 'nie wychodzi' },
  { id: 'fx', internal_number: 'FF/2026/11/OBCA0000', ksef_number: null, ksef_status: 'accepted' },
];

describe('lista faktur za abonament', () => {
  it('zwraca tylko udane płatności własnej firmy, od najnowszej, z numerami faktur operatora', async () => {
    const lista = await listSubscriptionInvoices(baza({ stripe_payments: platnosci() }), baza({ invoices: faktury() }), TENANT);
    expect(lista).not.toBeNull();
    expect(lista!.map((r) => r.paymentId)).toEqual(['p3', 'p1', 'p2']);
    expect(lista!.find((r) => r.paymentId === 'p1')).toMatchObject({
      amountLabel: expect.stringContaining('49,00'),
      number: 'FF/2026/11/ABC12345',
      ksefNumber: '5260001246-20261102-AAAAAAAAAAAA-01',
      state: 'in_ksef',
    });
  });

  it('stan wiersza: w KSeF, wystawiona i czeka na KSeF, w przygotowaniu (brak faktury po płatności)', async () => {
    const lista = (await listSubscriptionInvoices(baza({ stripe_payments: platnosci() }), baza({ invoices: faktury() }), TENANT))!;
    expect(lista.find((r) => r.paymentId === 'p2')).toMatchObject({ number: 'FF/2026/10/ZZZ99999', ksefNumber: null, state: 'issued' });
    expect(lista.find((r) => r.paymentId === 'p3')).toMatchObject({ number: null, state: 'preparing' });
  });

  it('numery faktur czyta tylko dla faktur z własnych płatności i tylko potrzebne kolumny', async () => {
    const admin = baza({ invoices: faktury() });
    await listSubscriptionInvoices(baza({ stripe_payments: platnosci() }), admin, TENANT);
    const zapytanie = (admin as unknown as { zapytania: Array<{ tabela: string; kolumny: string }> }).zapytania[0]!;
    expect(zapytanie.tabela).toBe('invoices');
    expect(zapytanie.kolumny.split(',').map((c) => c.trim()).sort()).toEqual(['id', 'internal_number', 'ksef_number', 'ksef_status']);
  });

  it('płatność obcej firmy nie trafia na listę, a jej faktura nie jest pobierana', async () => {
    const admin = baza({ invoices: faktury() });
    const lista = (await listSubscriptionInvoices(baza({ stripe_payments: platnosci() }), admin, TENANT))!;
    expect(lista.some((r) => r.paymentId === 'px')).toBe(false);
    expect(JSON.stringify(lista)).not.toContain('OBCA0000');
  });

  it('nie przepuszcza pól spoza widoku (np. tajne kolumny faktury)', async () => {
    const lista = (await listSubscriptionInvoices(baza({ stripe_payments: platnosci() }), baza({ invoices: faktury() }), TENANT))!;
    expect(JSON.stringify(lista)).not.toContain('nie wychodzi');
  });

  it('błąd odczytu płatności albo faktur to null (strona pokazuje komunikat, nie 500)', async () => {
    expect(await listSubscriptionInvoices(baza({}, { blad: 'boom' }), baza({}), TENANT)).toBeNull();
    expect(await listSubscriptionInvoices(baza({ stripe_payments: platnosci() }), baza({}, { blad: 'boom' }), TENANT)).toBeNull();
    const zepsuta = { from: () => { throw new Error('PGRST205'); } } as never;
    expect(await listSubscriptionInvoices(zepsuta, baza({}), TENANT)).toBeNull();
  });

  it('brak płatności to pusta lista, nie null', async () => {
    expect(await listSubscriptionInvoices(baza({ stripe_payments: [] }), baza({}), TENANT)).toEqual([]);
  });

  it('wiersz: kwota z groszy z walutą, data w czasie polskim', () => {
    const w = subscriptionInvoiceRow({ id: 'p', status: 'succeeded', amount_cents: 12345, currency: 'PLN', paid_at: '2026-12-31T23:30:00Z', vat_invoice_id: null }, undefined);
    expect(w.amountLabel.replace(/\s/g, ' ')).toContain('123,45');
    expect(w.paidOn).toBe('2027-01-01');
  });
});

describe('sekcja „Faktury za abonament”', () => {
  const wiersze: SubscriptionInvoiceRow[] = [
    { paymentId: 'p1', paidOn: '2026-11-02', amountLabel: '49,00 PLN', number: 'FF/2026/11/ABC12345', ksefNumber: '5260001246-20261102-AAAAAAAAAAAA-01', state: 'in_ksef' },
    { paymentId: 'p3', paidOn: '2026-12-02', amountLabel: '49,00 PLN', number: null, ksefNumber: null, state: 'preparing' },
  ];
  const html = (rows: SubscriptionInvoiceRow[] | null) => renderToStaticMarkup(<SubscriptionInvoices rows={rows} />);

  it('pokazuje datę, kwotę, numer i stan oraz gdzie szukać faktury', () => {
    const h = html(wiersze);
    expect(h).toContain('FF/2026/11/ABC12345');
    expect(h).toContain('49,00 PLN');
    expect(h).toContain('02.11.2026');
    expect(h).toMatch(/w KSeF/i);
    expect(h).toMatch(/w przygotowaniu/i);
    expect(h).toMatch(/Koszty|skrzynk/i);
  });

  it('pusta lista: wyjaśnienie, że faktura pojawi się po pierwszej płatności', () => {
    expect(html([])).toMatch(/po pierwszej płatności/i);
  });

  it('błąd odczytu: komunikat z poleceniem odświeżenia i pomocą, bez tabeli', () => {
    const h = html(null);
    expect(h).toMatch(/Nie udało się wczytać/i);
    expect(h).toMatch(/pomoc/i);
    expect(h).not.toContain('<table');
  });

  it('tabela ma opisane kolumny (nagłówki)', () => {
    expect(html(wiersze)).toMatch(/<th[^>]*>Numer faktury/);
  });
});
