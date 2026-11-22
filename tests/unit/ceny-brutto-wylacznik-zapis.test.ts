import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wyłącznik faktury w cenach brutto (RP-FA-BRUTTO-01, B4.0 zasada 2 planu
 * żelaznego filtra) przy zapisie faktury i w podkładzie z innej faktury.
 *
 * Zapis: `insertInvoiceAndLines` (`lib/invoices/issue-regular.ts`) to jedyny
 * zapis zwykłej faktury z formularza strony, telefonu, faktury cyklicznej
 * („Wystaw teraz”) i proformy. Przy wyłączonym wyłączniku faktura z
 * `pricesGross: true` (w wartościach formularza albo w zbudowanej fakturze)
 * dostaje odmowę z wyjściem, zanim cokolwiek się zapisze (bez numeru, bez
 * okresu faktury cyklicznej, bez kolejki). Faktura w cenach netto i faktura do
 * paragonu (FP) w cenach netto bez zmian i bez odczytu flagi.
 *
 * Podkład (N6 z przeglądu formularza (b)): „Duplikuj”, „Wystaw teraz” i baner
 * „Wypełnij” z dokumentu w cenach brutto (faktura FaktWay z `pricesGross` albo
 * import z `P_9B`, gdzie pozycja nie ma ceny netto) dają podkład w cenach netto
 * bez cen tych pozycji (puste pole, nigdy 0 zł) z komunikatem. Formularz w main
 * nie ma metody brutto, więc przy obu stanach wyłącznika podkład jest taki sam;
 * gałąź „włączony” (podkład w cenach brutto) dokłada formularz cen brutto (b).
 *
 * Prawdziwe: akcje strony (`saveDraftAction`, `saveAndSendInvoiceAction`,
 * `prefillFromInvoiceAction`, `prefillFromLastInvoiceAction`), schemat
 * formularza, budowanie faktury, zapis i odczyt flagi
 * (`getGlobalFlagForExecution`). Atrapy tylko bazy i granic: klient sesji
 * (tabele faktur, pozycji, firmy i faktur cyklicznych), klucz serwisowy
 * (wiersz flagi), sesja z ciasteczek, kolejka KSeF (osobny test), audyt, GUS.
 */

const T = 'ten-1';
const REC = '66666666-6666-4666-8666-666666666666';
const BRUTTO_ZAPIS = 'Faktura w cenach brutto nie jest jeszcze dostępna w FaktWay, więc faktury nie zapisaliśmy. Wystaw fakturę w cenach netto.';
const BRUTTO_ZAPIS_NIEZNANE = 'Nie udało się sprawdzić, czy faktura w cenach brutto jest dostępna w FaktWay, więc faktury nie zapisaliśmy. Spróbuj ponownie za chwilę.';
const PODKLAD = 'Faktura, z której wypełniliśmy formularz, ma ceny brutto, a faktury w cenach brutto FaktWay jeszcze nie wystawia. Ceny tych pozycji zostawiliśmy puste: wpisz je w cenach netto.';
const BEZ_CENY_NETTO = 'Faktura, z której wypełniliśmy formularz, ma pozycje bez ceny netto. Ceny tych pozycji zostawiliśmy puste: wpisz je w cenach netto.';

const st = vi.hoisted(() => ({
  auth: vi.fn(),
  audit: vi.fn(),
  enqueue: vi.fn(),
  /** Wiersz flagi `grossPricesEnabled`: brak (undefined), wartość albo błąd odczytu. */
  flaga: undefined as boolean | undefined | 'blad',
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
          if (filtry.flag !== 'grossPricesEnabled') return { data: null, error: null };
          if (st.flaga === 'blad') return { data: null, error: { message: 'connection refused' } };
          return { data: st.flaga === undefined ? null : { enabled: st.flaga }, error: null };
        },
      };
      return q;
    },
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: st.audit }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: st.enqueue }));
vi.mock('@/lib/gus/client', () => ({ lookupCompanyByNip: vi.fn() }));

import {
  prefillFromInvoiceAction,
  prefillFromLastInvoiceAction,
  saveAndSendInvoiceAction,
  saveDraftAction,
} from '@/components/invoices/actions';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

// 9.11.2026 10:00 w Polsce: wysyłka tylko z dzisiejszą datą (A1).
const NOW = new Date('2026-11-09T09:00:00Z');
const DZIS = '2026-11-09';

const form = (extra: Record<string, unknown> = {}): InvoiceFormValues => ({
  internalNumber: 'FV/7/11/2026',
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
  lines: [{ name: 'Projekt graficzny', unit: 'szt', quantity: 2, unitPriceNet: 1500, vatRate: '23' }],
  ...extra,
}) as InvoiceFormValues;

/** Wartości formularza w cenach brutto, jak wyśle je formularz cen brutto (b). */
const formBrutto = (extra: Record<string, unknown> = {}) =>
  form({ pricesGross: true, lines: [{ name: 'Kawa', unit: 'szt', quantity: 3, unitPriceNet: 0, unitPriceGross: 1, vatRate: '23' }], ...extra });

/** Faktura do paragonu (FP) w cenach netto: firma z NIP, paragon z 15.10.2026. */
const formFp = () =>
  form({
    saleDate: '2026-10-15',
    paymentMethod: 'cash',
    paymentDueDate: DZIS,
    bankAccount: '',
    lines: [{ name: 'Rower miejski', unit: 'szt.', quantity: 1, unitPriceNet: 1000, vatRate: '23' }],
    receiptInvoice: true,
    receiptNumber: ' 000123 ',
    receiptDate: '2026-10-15',
    cashRegisterNumber: 'abc 123-456 7890',
    receiptRequestDate: '',
    buyerNipOnReceipt: true,
  });

const wstawienia = () => st.zapisy.map((z) => z.table);

beforeEach(() => {
  vi.clearAllMocks();
  st.flaga = undefined;
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

describe('zapis faktury w cenach brutto (szkic, „Wystaw i wyślij”, faktura cykliczna)', () => {
  it('szkic przy wyłączonym wyłączniku (brak wiersza flagi): odmowa z wyjściem, nic nie zapisane', async () => {
    await expect(saveDraftAction(formBrutto(), T)).resolves.toEqual({ success: false, error: BRUTTO_ZAPIS });
    expect(wstawienia()).toEqual([]);
    expect(st.odczytyFlag).toEqual(['grossPricesEnabled']);
  });

  it('„Wystaw i wyślij” przy wiersz flagi z false: odmowa przed zapisem i bez kolejki KSeF', async () => {
    st.flaga = false;
    await expect(saveAndSendInvoiceAction(formBrutto(), T)).resolves.toEqual({ success: false, error: BRUTTO_ZAPIS });
    expect(wstawienia()).toEqual([]);
    expect(st.enqueue).not.toHaveBeenCalled();
  });

  it('błąd odczytu flagi: odmowa „spróbuj ponownie”, nic nie zapisane („nie wiem” to nie „tak”)', async () => {
    st.flaga = 'blad';
    await expect(saveDraftAction(formBrutto(), T)).resolves.toEqual({ success: false, error: BRUTTO_ZAPIS_NIEZNANE });
    expect(wstawienia()).toEqual([]);
  });

  it('„Wystaw teraz” z faktury cyklicznej w cenach brutto przy wyłączonym: odmowa, okres nie jest zajęty', async () => {
    st.cykliczna = { id: REC, name: 'Abonament', template_invoice_id: 'tpl-1', active: true, next_run_date: DZIS, frequency: 'monthly', day_of_month: 9 };
    st.pozycje = [{ vat_rate: '23' }];
    const wynik = await saveAndSendInvoiceAction(formBrutto({ recurringInvoiceId: REC, recurringPeriod: '2026-11' }), T);
    expect(wynik).toEqual({ success: false, error: BRUTTO_ZAPIS });
    expect(wstawienia()).toEqual([]);
    expect(st.enqueue).not.toHaveBeenCalled();
  });

  it('przy włączonym wyłączniku zapis idzie dalej (szkic zapisany)', async () => {
    st.flaga = true;
    await expect(saveDraftAction(formBrutto(), T)).resolves.toEqual({ success: true, invoiceId: 'inv-new' });
    expect(wstawienia()).toEqual(['invoices', 'invoice_line_items']);
  });

  it('faktura w cenach netto przy wyłączonym: zapis i kolejka jak dotąd, bez odczytu flagi', async () => {
    await expect(saveAndSendInvoiceAction(form(), T)).resolves.toEqual({ success: true, invoiceId: 'inv-new', offline: false });
    expect(wstawienia()).toEqual(['invoices', 'invoice_line_items']);
    expect(st.enqueue).toHaveBeenCalledTimes(1);
    expect(st.odczytyFlag).toEqual([]);
  });

  it('faktura do paragonu (FP) w cenach netto przy wyłączonym: działa jak dotąd, bez odczytu flagi', async () => {
    await expect(saveAndSendInvoiceAction(formFp(), T)).resolves.toEqual({ success: true, invoiceId: 'inv-new', offline: false });
    const zapis = st.zapisy.find((z) => z.table === 'invoices')?.payload as { fa3_data: Record<string, unknown> };
    expect(zapis.fa3_data.receipt).toMatchObject({ receiptNumber: '000123' });
    expect(zapis.fa3_data).not.toHaveProperty('pricesGross');
    expect(st.odczytyFlag).toEqual([]);
  });
});

/** Faktura FaktWay w cenach brutto zapisana przy włączonym wyłączniku: pozycje bez ceny netto (NULL). */
function zrodloBrutto(): void {
  st.zrodlo = {
    id: '44444444-4444-4444-8444-444444444444',
    internal_number: 'FV/3/10/2026',
    issue_date: '2026-10-05',
    payment_due_date: '2026-10-19',
    days_to_payment: 14,
    is_b2c: false,
    buyer_id_type: 'nip',
    buyer_pesel: null,
    buyer_id_number: null,
    fa3_data: {
      pricesGross: true,
      buyer: { nip: '5252241585', name: 'Klient Sp. z o.o.', address: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '00-002 Warszawa' } },
      payment: { method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
      lines: [
        { ordinal: 1, unitPriceGross: 20.99 },
        { ordinal: 2, unitPriceGross: 5.49 },
      ],
    },
  };
  st.pozycje = [
    { ordinal: 1, name: 'Kanapka', unit: 'szt.', quantity: '2.0000', unit_price_net: null, vat_rate: '8' },
    { ordinal: 2, name: 'Sok', unit: 'szt.', quantity: '3.0000', unit_price_net: null, vat_rate: '23' },
  ];
}

/** Faktura z KSeF z innego programu (import, `P_9B`): cena netto pozycji NULL, cena brutto w pliku. */
function zrodloImportP9B(): void {
  zrodloBrutto();
  const fa3 = st.zrodlo!.fa3_data as Record<string, unknown>;
  delete fa3.pricesGross;
  fa3.ksefLineFields = [{ ordinal: 1, P_9B: 20.99 }, { ordinal: 2, P_9B: 5.49 }];
}

const pozycjeBezCeny = (lines: ReadonlyArray<Record<string, unknown>>) => lines.filter((l) => !('unitPriceNet' in l)).length;

describe.each([
  ['wyłączony (brak wiersza flagi)', undefined],
  ['wyłączony (false)', false],
  ['włączony', true],
] as const)('podkład z faktury w cenach brutto, wyłącznik %s', (_nazwa, flaga) => {
  beforeEach(() => {
    st.flaga = flaga;
  });

  it('„Duplikuj” faktury FaktWay w cenach brutto: ceny netto puste (nigdy 0 zł), bez metody brutto, z komunikatem', async () => {
    zrodloBrutto();
    const podklad = await prefillFromInvoiceAction(st.zrodlo!.id as string);
    expect(podklad?.values.lines.map((l) => ({ ...l }))).toEqual([
      { name: 'Kanapka', unit: 'szt.', quantity: 2, vatRate: '8' },
      { name: 'Sok', unit: 'szt.', quantity: 3, vatRate: '23' },
    ]);
    expect(podklad?.values.lines.some((l) => Number(l.unitPriceNet) === 0)).toBe(false);
    expect(podklad?.values).not.toHaveProperty('pricesGross');
    expect(podklad?.priceNotice).toBe(PODKLAD);
    // Nabywca i zapłata jak w kopiowanej fakturze.
    expect(podklad?.values).toMatchObject({ buyerNip: '5252241585', buyerName: 'Klient Sp. z o.o.', paymentMethod: 'transfer' });
  });

  it('import z P_9B (cena netto NULL): ta sama zasada, nigdy 0 zł', async () => {
    zrodloImportP9B();
    const podklad = await prefillFromInvoiceAction(st.zrodlo!.id as string);
    expect(pozycjeBezCeny(podklad!.values.lines as unknown as Array<Record<string, unknown>>)).toBe(2);
    expect(podklad?.priceNotice).toBe(PODKLAD);
  });

  it('pozycje mieszane (część z ceną netto): cena netto zostaje, brak ceny zostaje brakiem', async () => {
    zrodloImportP9B();
    st.pozycje[0] = { ...st.pozycje[0], unit_price_net: '19.4352' };
    const podklad = await prefillFromInvoiceAction(st.zrodlo!.id as string);
    expect(podklad?.values.lines[0]).toMatchObject({ name: 'Kanapka', unitPriceNet: 19.4352 });
    expect(podklad?.values.lines[1]).not.toHaveProperty('unitPriceNet');
    expect(podklad?.priceNotice).toBe(PODKLAD);
  });

  it('import bez ceny netto i bez ceny brutto (bez P_9A i P_9B): pusta cena i komunikat bez słowa o cenach brutto', async () => {
    zrodloImportP9B();
    (st.zrodlo!.fa3_data as Record<string, unknown>).ksefLineFields = [];
    const podklad = await prefillFromInvoiceAction(st.zrodlo!.id as string);
    expect(pozycjeBezCeny(podklad!.values.lines as unknown as Array<Record<string, unknown>>)).toBe(2);
    expect(podklad?.priceNotice).toBe(BEZ_CENY_NETTO);
  });

  it('baner „Wypełnij z ostatniej faktury” nie podsuwa podkładu z faktury w cenach brutto', async () => {
    zrodloBrutto();
    await expect(prefillFromLastInvoiceAction()).resolves.toBeNull();
  });

  it('faktura w cenach netto: ceny jak dotąd, bez komunikatu', async () => {
    zrodloBrutto();
    delete (st.zrodlo!.fa3_data as Record<string, unknown>).pricesGross;
    st.pozycje = st.pozycje.map((p, i) => ({ ...p, unit_price_net: i === 0 ? '19.4352' : '0.0000' }));
    const podklad = await prefillFromInvoiceAction(st.zrodlo!.id as string);
    expect(podklad?.values.lines.map((l) => l.unitPriceNet)).toEqual([19.4352, 0]);
    expect(podklad).not.toHaveProperty('priceNotice');
    await expect(prefillFromLastInvoiceAction()).resolves.toMatchObject({ contractorName: 'Klient Sp. z o.o.' });
  });
});
