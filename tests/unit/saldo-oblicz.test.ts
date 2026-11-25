import { describe, expect, it, vi } from 'vitest';

import { balancePreviewFromRpc, type BalanceItem } from '@/lib/saldo/model';
import { balanceArithmeticHolds, matchesReceivables, readBalancePreview } from '@/lib/saldo/oblicz';

/**
 * Obliczenie potwierdzenia salda (krok 2.9, część 2, PR B; D26 i D27): wynik
 * podglądu z bazy (00215) w ścisłym kształcie, arytmetyka w groszach i ta sama
 * lista i kwota co należności kontrahenta na Pulpicie. Zgodność warunku bazy
 * z `getReceivables` na prawdziwym Postgresie: tests/rls-saldo.test.ts.
 */

const NIP = '1234567890';
const F1 = '00215215-2222-4000-8000-000000000001';
const F2 = '00215215-2222-4000-8000-000000000002';
const R1 = '00215215-2222-4000-8000-000000000003';

function pozycja(zmiany: Partial<BalanceItem> = {}): BalanceItem {
  return {
    invoiceId: F1, number: 'FV/1/2026', ksefNumber: null, issueDate: '2026-10-01', dueDate: '2026-10-15',
    kind: 'regular', type: 'VAT', gross: 1230, amountDue: 1230, paid: 0, outstanding: 1230, ...zmiany,
  };
}

const STRONA = { name: 'Kontrahent', nip: NIP, countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa', email: null };

function wynikBazy(zmiany: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'ok', contractor_id: '00215215-1111-4000-8000-00000000000a', as_of: '2026-11-25', environment: 'test', currency: 'PLN',
    counterparty: STRONA, issuer: { ...STRONA, name: 'Moja Firma' },
    items: [
      pozycja(),
      pozycja({ invoiceId: F2, number: 'FV/2/2026', gross: 0.3, amountDue: 0.3, paid: 0.1, outstanding: 0.2 }),
      pozycja({ invoiceId: R1, number: 'ROZ/1/2026', kind: 'final', type: 'ROZ', gross: 10000, amountDue: 7000, paid: 0, outstanding: 7000 }),
    ],
    omitted: [],
    total: 8230.2,
    fingerprint: 'a'.repeat(32),
    ...zmiany,
  };
}

function klient(odpowiedz: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn().mockResolvedValue(odpowiedz);
  return { rpc, client: { rpc } };
}

describe('wynik podglądu z bazy: ścisły kształt', () => {
  it('poprawny wynik daje podgląd z pozycjami, pominiętymi i odciskiem', () => {
    const r = balancePreviewFromRpc(wynikBazy());
    expect(r).toMatchObject({ ok: true, preview: { asOf: '2026-11-25', total: 8230.2, fingerprint: 'a'.repeat(32) } });
  });

  it('odmowa z kodem bazy (z liczbą pominiętych) i nieznany kod albo kształt to null', () => {
    expect(balancePreviewFromRpc({ status: 'refused', code: 'omitted_not_confirmed', omitted_count: 2 })).toEqual({
      ok: false, code: 'omitted_not_confirmed', omittedCount: 2,
    });
    expect(balancePreviewFromRpc({ status: 'refused', code: 'cos_nowego' })).toBeNull();
    expect(balancePreviewFromRpc(null)).toBeNull();
    expect(balancePreviewFromRpc(wynikBazy({ currency: 'EUR' }))).toBeNull();
    expect(balancePreviewFromRpc(wynikBazy({ items: [pozycja({ kind: 'final', type: 'VAT' })] }))).toBeNull();
    expect(balancePreviewFromRpc(wynikBazy({ items: [{ ...pozycja(), outstanding: 'dużo' }] }))).toBeNull();
    expect(balancePreviewFromRpc(wynikBazy({ omitted: [{ reason: 'inny' }] }))).toBeNull();
  });
});

describe('arytmetyka w groszach', () => {
  it('saldo to suma pozycji co do grosza (0,30 − 0,10 = 0,20 bez błędu liczb zmiennoprzecinkowych)', () => {
    const r = balancePreviewFromRpc(wynikBazy());
    expect(r?.ok && balanceArithmeticHolds(r.preview)).toBe(true);
  });

  it.each([
    ['saldo różne od sumy o grosz', { total: 8230.21 }],
    ['do zapłaty różne od kwoty minus wpłaty', { items: [pozycja({ outstanding: 1229.99 })], total: 1229.99 }],
    ['do zapłaty powyżej brutto', { items: [pozycja({ amountDue: 1300, outstanding: 1300 })], total: 1300 }],
    ['pozycja bez kwoty do zapłaty', { items: [pozycja({ paid: 1230, outstanding: 0 })], total: 0 }],
  ])('%s: arytmetyka się nie zgadza', (_nazwa, zmiany) => {
    const r = balancePreviewFromRpc(wynikBazy(zmiany));
    expect(r?.ok && balanceArithmeticHolds(r.preview)).toBe(false);
  });
});

describe('zgodność z należnościami Pulpitu (getReceivables po NIP)', () => {
  const pulpit = (byInvoice: Array<{ id: string; buyerNip: string | null; outstanding: number }>) => ({
    byInvoice: byInvoice.map((i) => ({ ...i, internalNumber: null, buyerName: null, paymentDueDate: null, daysOverdue: 0 })),
  });
  const tresc = { counterparty: { ...STRONA, nip: '123-456-78-90' }, items: [pozycja(), pozycja({ invoiceId: F2, outstanding: 0.2, amountDue: 0.3, paid: 0.1, gross: 0.3 })] };

  it('te same faktury i kwoty (NIP po normalizacji jak normalizeNip, faktury innych nabywców obok)', () => {
    expect(matchesReceivables(tresc, pulpit([
      { id: F1, buyerNip: NIP, outstanding: 1230 },
      { id: F2, buyerNip: ' 1234567890', outstanding: 0.1 + 0.1 },
      { id: R1, buyerNip: '9876543210', outstanding: 5 },
    ]))).toBe(true);
  });

  it.each([
    ['inna kwota o grosz', [{ id: F1, buyerNip: NIP, outstanding: 1230 }, { id: F2, buyerNip: NIP, outstanding: 0.21 }]],
    ['brak faktury na Pulpicie', [{ id: F1, buyerNip: NIP, outstanding: 1230 }]],
    ['dodatkowa faktura na Pulpicie', [{ id: F1, buyerNip: NIP, outstanding: 1230 }, { id: F2, buyerNip: NIP, outstanding: 0.2 }, { id: R1, buyerNip: NIP, outstanding: 1 }]],
  ])('%s: niezgodne', (_nazwa, faktury) => {
    expect(matchesReceivables(tresc, pulpit(faktury))).toBe(false);
  });

  it('powtórzona pozycja w zestawieniu: niezgodne', () => {
    expect(matchesReceivables({ ...tresc, items: [pozycja(), pozycja()] }, pulpit([
      { id: F1, buyerNip: NIP, outstanding: 1230 },
      { id: F2, buyerNip: NIP, outstanding: 1230 },
    ]))).toBe(false);
  });
});

describe('readBalancePreview: RPC z środowiskiem KSeF aplikacji', () => {
  it('woła balance_confirmation_preview z KSEF_ENV i oddaje podgląd', async () => {
    const { rpc, client } = klient({ data: wynikBazy(), error: null });
    const r = await readBalancePreview(client, '00215215-1111-4000-8000-00000000000a');
    expect(rpc).toHaveBeenCalledWith('balance_confirmation_preview', {
      p_contractor_id: '00215215-1111-4000-8000-00000000000a',
      p_ksef_environment: 'test',
    });
    expect(r.ok).toBe(true);
  });

  it('odmowa bazy to wynik z kodem, nie wyjątek', async () => {
    const { client } = klient({ data: { status: 'refused', code: 'disabled' }, error: null });
    expect(await readBalancePreview(client, F1)).toEqual({ ok: false, code: 'disabled' });
  });

  it('błąd bazy, nieznany kształt i zła arytmetyka rzucają (nie wiem to nie saldo)', async () => {
    await expect(readBalancePreview(klient({ data: null, error: { message: 'boom' } }).client, F1)).rejects.toThrow(/boom/);
    await expect(readBalancePreview(klient({ data: { status: 'ok' }, error: null }).client, F1)).rejects.toThrow(/kształt/);
    await expect(readBalancePreview(klient({ data: wynikBazy({ total: 1 }), error: null }).client, F1)).rejects.toThrow(/nie sumują/);
  });
});
