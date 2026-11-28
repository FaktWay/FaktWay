import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Faktura w walucie obcej, część 3 kroku 2.1 (D56): wyłącznik `foreignCurrencyEnabled`
 * przy zapisie, kurs NBP z art. 31a ust. 1 zapisany przy fakturze, kurs wpisany ręcznie.
 *
 * Prawdziwe: akcje strony, schemat formularza, budowanie faktury, wybór dnia kursu
 * i tabeli (`rateBefore`), odczyt flagi. Atrapy tylko bazy, sesji, kolejki KSeF
 * i klienta HTTP NBP (`fetchNbpTablesBefore`).
 */

const T = 'ten-1';
const WALUTA_ZAPIS = 'Faktura w walucie obcej nie jest jeszcze dostępna w FaktWay, więc faktury nie zapisaliśmy. Wystaw fakturę w złotych.';

const st = vi.hoisted(() => ({
  auth: vi.fn(),
  audit: vi.fn(),
  enqueue: vi.fn(),
  /** Wiersz flagi `foreignCurrencyEnabled`: brak (undefined), wartość albo błąd odczytu. */
  flaga: undefined as boolean | undefined | 'blad',
  /** Tabele NBP z klienta HTTP; 'blad' rzuca (sieć). */
  tabele: [] as Array<{ currency: string; mid: number; tableNo: string; effectiveDate: string }> | 'blad',
  odczytyFlag: [] as string[],
  zapisy: [] as Array<{ table: string; payload: unknown }>,
  /** Faktura, z której wypełniamy formularz (wiersz `invoices`). */
  zrodlo: null as Record<string, unknown> | null,
  /** Jej pozycje (`invoice_line_items`). */
  pozycje: [] as Array<Record<string, unknown>>,
  cykliczna: null as Record<string, unknown> | null,
}));

const TENANT_ROW = {
  id: T,
  nip: '5260001246',
  name: 'Moja Firma',
  address_json: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' },
  vat_exemption_basis: null,
  vat_cash_method: false,
};

function sesja() {
  return {
    from(table: string) {
      let op = 'select';
      const q = {
        select: () => q,
        eq: () => q,
        neq: () => q,
        not: () => q,
        is: () => q,
        in: () => q,
        or: () => q,
        order: () => q,
        limit: () => q,
        insert: (payload: unknown) => {
          op = 'insert';
          st.zapisy.push({ table, payload });
          return q;
        },
        delete: () => {
          op = 'delete';
          return q;
        },
        maybeSingle: async () => {
          if (table === 'tenants') return { data: TENANT_ROW, error: null };
          if (table === 'recurring_invoices') return { data: st.cykliczna, error: null };
          if (table === 'invoices') return { data: st.zrodlo ?? { id: 'tpl-1' }, error: null };
          return { data: null, error: null };
        },
        single: async () => ({ data: op === 'insert' ? { id: 'inv-new' } : null, error: null }),
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
          Promise.resolve({
            data: table === 'invoice_line_items' && op === 'select' ? st.pozycje : [],
            error: null,
            count: 0,
          }).then(ok, fail),
      };
      return q;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

vi.mock('@/lib/supabase/auth-context', () => ({
  requireUserAndActiveOrg: st.auth,
  ActionAuthError: class ActionAuthError extends Error {},
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    throw new Error('sesja z ciasteczek: tylko przez requireUserAndActiveOrg');
  },
  createAdminClient: () => ({
    from(table: string) {
      const filtry: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq: (kolumna: string, wartosc: unknown) => {
          filtry[kolumna] = wartosc;
          return q;
        },
        maybeSingle: async () => {
          if (table !== 'global_feature_flags') throw new Error(`nieoczekiwana tabela ${table}`);
          st.odczytyFlag.push(String(filtry.flag));
          if (filtry.flag !== 'foreignCurrencyEnabled') return { data: null, error: null };
          if (st.flaga === 'blad') return { data: null, error: { message: 'connection refused' } };
          return { data: st.flaga === undefined ? null : { enabled: st.flaga }, error: null };
        },
      };
      return q;
    },
  }),
}));
vi.mock('@/lib/nbp/client', () => ({
  fetchNbpTablesBefore: async () => {
    if (st.tabele === 'blad') throw new Error('NBP: HTTP 503');
    return st.tabele;
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: st.audit }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: st.enqueue }));
vi.mock('@/lib/gus/client', () => ({ lookupCompanyByNip: vi.fn() }));

import { previewInvoiceRateAction, saveAndSendInvoiceAction, saveDraftAction } from '@/components/invoices/actions';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

// 9.11.2026 (poniedziałek) 10:00 w Polsce: wysyłka tylko z dzisiejszą datą (A1).
const NOW = new Date('2026-11-09T09:00:00Z');
const DZIS = '2026-11-09';

const TABELE = [
  { currency: 'EUR', mid: 4.3, tableNo: '212/A/NBP/2026', effectiveDate: '2026-11-03' },
  { currency: 'EUR', mid: 4.2345, tableNo: '215/A/NBP/2026', effectiveDate: '2026-11-06' },
  // Tabela z dnia wystawienia: reguła mówi „poprzedzającym”, więc nie wolno jej wziąć.
  { currency: 'EUR', mid: 9, tableNo: '216/A/NBP/2026', effectiveDate: '2026-11-09' },
];

const form = (extra: Record<string, unknown> = {}): InvoiceFormValues => ({
  internalNumber: 'FV/8/11/2026',
  issueDate: DZIS,
  saleDate: '',
  buyerNip: '5252241585',
  buyerName: 'Klient Sp. z o.o.',
  buyerAddressLine1: 'ul. B 2',
  buyerAddressLine2: '00-002 Warszawa',
  buyerEmail: '',
  buyerIsConsumer: false,
  buyerPesel: '',
  buyerIdDocument: '',
  paymentMethod: 'transfer',
  paymentDueDate: '2026-11-23',
  bankAccount: 'PL61109010140000071219812874',
  notes: '',
  splitPayment: false,
  lines: [{ name: 'Usługa programistyczna', unit: 'szt', quantity: 2, unitPriceNet: 1500, vatRate: '23' }],
  ...extra,
}) as InvoiceFormValues;

const wstawienia = () => st.zapisy.map((z) => z.table);
const faktura = () => (st.zapisy.find((z) => z.table === 'invoices')?.payload ?? {}) as {
  currency: string;
  fa3_data: { payment: { currency: string }; exchangeRate?: { rate: number; tableNo: string; tableDate: string } };
};

beforeEach(() => {
  vi.clearAllMocks();
  st.flaga = undefined;
  st.tabele = TABELE;
  st.odczytyFlag = [];
  st.zapisy = [];
  st.zrodlo = null;
  st.pozycje = [];
  st.cykliczna = null;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  st.auth.mockImplementation(async () => ({ supabase: sesja(), user: { id: 'user-1' }, tenantId: T, role: 'owner' }));
  st.enqueue.mockResolvedValue({ ok: true, mode: 'online_queued' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('faktura w walucie obcej: wyłącznik', () => {
  it('szkic w EUR przy wyłączonym wyłączniku (brak wiersza): odmowa z wyjściem, nic nie zapisane', async () => {
    await expect(saveDraftAction(form({ currency: 'EUR' }), T)).resolves.toEqual({ success: false, error: WALUTA_ZAPIS });
    expect(wstawienia()).toEqual([]);
    expect(st.odczytyFlag).toEqual(['foreignCurrencyEnabled']);
  });

  it('„Wystaw i wyślij” przy false: odmowa przed zapisem i bez kolejki KSeF', async () => {
    st.flaga = false;
    await expect(saveAndSendInvoiceAction(form({ currency: 'EUR' }), T)).resolves.toEqual({ success: false, error: WALUTA_ZAPIS });
    expect(wstawienia()).toEqual([]);
    expect(st.enqueue).not.toHaveBeenCalled();
  });

  it('błąd odczytu flagi: odmowa „spróbuj ponownie”, nic nie zapisane', async () => {
    st.flaga = 'blad';
    const wynik = await saveDraftAction(form({ currency: 'EUR' }), T);
    expect(wynik).toMatchObject({ success: false });
    expect(wynik.success === false && wynik.error).toContain('Spróbuj ponownie za chwilę');
    expect(wstawienia()).toEqual([]);
  });

  it('faktura w złotych (bez waluty i z „PLN”): jak dotąd, bez odczytu flagi i bez NBP', async () => {
    st.tabele = 'blad';
    await expect(saveDraftAction(form(), T)).resolves.toEqual({ success: true, invoiceId: 'inv-new' });
    await expect(saveDraftAction(form({ currency: 'PLN' }), T)).resolves.toEqual({ success: true, invoiceId: 'inv-new' });
    expect(st.odczytyFlag).toEqual([]);
    expect(faktura().currency).toBe('PLN');
    expect(faktura().fa3_data).not.toHaveProperty('exchangeRate');
  });
});

describe('faktura w walucie obcej: kurs NBP zapisany przy fakturze', () => {
  beforeEach(() => {
    st.flaga = true;
  });

  it('bez daty sprzedaży: tabela sprzed dnia wystawienia (nie z tego samego dnia), kurs, numer i dzień tabeli w fa3_data', async () => {
    await expect(saveDraftAction(form({ currency: 'EUR' }), T)).resolves.toEqual({ success: true, invoiceId: 'inv-new' });
    expect(faktura().currency).toBe('EUR');
    expect(faktura().fa3_data.payment.currency).toBe('EUR');
    expect(faktura().fa3_data.exchangeRate).toEqual({ rate: 4.2345, tableNo: '215/A/NBP/2026', tableDate: '2026-11-06' });
  });

  it('z datą sprzedaży wcześniejszą niż wystawienie: kurs sprzed dnia sprzedaży (art. 31a ust. 1)', async () => {
    await saveAndSendInvoiceAction(form({ currency: 'EUR', saleDate: '2026-11-04' }), T);
    expect(faktura().fa3_data.exchangeRate).toEqual({ rate: 4.3, tableNo: '212/A/NBP/2026', tableDate: '2026-11-03' });
    expect(st.enqueue).toHaveBeenCalledTimes(1);
  });

  it('kurs wpisany ręcznie zastępuje NBP i jest oznaczony jako wpisany ręcznie', async () => {
    await saveDraftAction(form({ currency: 'EUR', exchangeRateManual: 4.5005 }), T);
    expect(faktura().fa3_data.exchangeRate).toEqual({ rate: 4.5005, tableNo: 'wpisany ręcznie', tableDate: DZIS });
  });

  it('błąd sieci NBP: odmowa z wyjściem, nic nie zapisane', async () => {
    st.tabele = 'blad';
    const wynik = await saveDraftAction(form({ currency: 'EUR' }), T);
    expect(wynik).toMatchObject({ success: false });
    expect(wynik.success === false && wynik.error).toContain('wpisz kurs z tabeli NBP');
    expect(wstawienia()).toEqual([]);
  });

  it('brak tabeli NBP (luka w publikacji): odmowa, nigdy kurs „w przybliżeniu”', async () => {
    st.tabele = [];
    const wynik = await saveDraftAction(form({ currency: 'EUR' }), T);
    expect(wynik).toMatchObject({ success: false });
    expect(wstawienia()).toEqual([]);
  });

  it('schemat: waluta w cenach brutto, kurs przy złotych i zły kod waluty odrzucone na serwerze', async () => {
    const brutto = await saveDraftAction(
      form({ currency: 'EUR', pricesGross: true, lines: [{ name: 'Kawa', unit: 'szt', quantity: 1, unitPriceNet: 0, unitPriceGross: 10, vatRate: '23' }] }),
      T,
    );
    expect(brutto.success === false && brutto.error).toContain('tylko w cenach netto');
    const wPln = await saveDraftAction(form({ exchangeRateManual: 4.2 }), T);
    expect(wPln.success === false && wPln.error).toContain('Faktura w złotych nie ma kursu');
    const zlyKod = await saveDraftAction(form({ currency: 'eur' }), T);
    expect(zlyKod.success === false && zlyKod.error).toContain('trzy wielkie litery');
    expect(wstawienia()).toEqual([]);
  });
});

describe('podgląd kursu w formularzu', () => {
  it('przy włączonym wyłączniku zwraca kurs i tabelę; przy wyłączonym odmowę', async () => {
    st.flaga = true;
    await expect(previewInvoiceRateAction({ currency: 'EUR', issueDate: DZIS })).resolves.toEqual({
      ok: true,
      rate: 4.2345,
      tableNo: '215/A/NBP/2026',
      tableDate: '2026-11-06',
    });
    st.flaga = false;
    await expect(previewInvoiceRateAction({ currency: 'EUR', issueDate: DZIS })).resolves.toMatchObject({ ok: false });
    await expect(previewInvoiceRateAction({ currency: 'PLN', issueDate: DZIS })).resolves.toMatchObject({ ok: false });
  });
});
