// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ceny brutto, krok (e), część 2, luka 1 (decyzja D6 z 25.11.2026): formularz
 * korekty pozycji („przed / po”) faktury w cenach brutto. Serwer liczy stan po
 * od cen brutto pozycji (`unitPriceGross`, podatek stawki od sumy brutto stawki,
 * art. 106e ust. 7 i 11 ustawy o VAT), ale formularz miał tylko „Cenę netto”
 * i `beforeAfterRefusal` odsyłał klienta do anulowania albo korekty kwotowej.
 * Teraz tabela „Było / Jest” takiej faktury ma „Cenę brutto” zamiast ceny netto
 * i wysyła cenę brutto pozycji; korekta pozycji faktury od brutto z samego
 * zapisu (faktura za abonament, bez `pricesGross`) zostaje odmową.
 */

const mocks = vi.hoisted(() => ({
  getContext: vi.fn(),
  saveDraft: vi.fn(),
  saveAndSend: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/invoices/correction-actions', () => ({
  getCorrectionParentContextAction: mocks.getContext,
  saveCorrectionDraftAction: mocks.saveDraft,
  saveAndSendCorrectionAction: mocks.saveAndSend,
}));
// Fikcyjny NIP 1234567890 (AGENTS.md) nie ma sumy kontrolnej; reszta kalkulatora prawdziwa.
vi.mock('@/lib/xml/invoice-calculator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/xml/invoice-calculator')>()),
  validateNipChecksum: () => true,
}));

import { CorrectionInvoiceForm, type CorrectionParentInvoiceRow } from '@/components/invoices/correction-form';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PARENT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const seller = { nip: '1234567890', name: 'Moja Firma', address: { addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa', countryCode: 'PL' } };
const buyer = { type: 'b2b' as const, idType: 'nip' as const, nip: '1234567890', name: 'Klient PL', address: { addressLine1: 'ul. Klienta 2', addressLine2: '00-002 Warszawa', countryCode: 'PL' } };

/** Trzy kawy po 1,00 zł brutto przy 23 %: zapis pozycji 0,81 / 0,81 / 0,82 netto, VAT stawki 0,56 od 3,00 (#835). */
const TRZY_KAWY = [[0.81, 0.19], [0.81, 0.19], [0.82, 0.18]].map(([netAmount, vatAmount], i) => ({
  name: `Kawa ${i + 1}`, unit: 'szt.', quantity: 1, unitPriceNet: 0, unitPriceGross: 1, vatRate: '23',
  recordedAmounts: { netAmount: netAmount!, vatAmount: vatAmount!, grossAmount: 1 },
}));

const parentRow: CorrectionParentInvoiceRow = {
  id: PARENT_ID, internal_number: 'FV 7/11/2026', ksef_number: '1234567890-20261102-0100001AF601-B1',
  issue_date: '2026-11-02', gross_total: 3, buyer_data: { name: 'Klient PL', nip: '1234567890' },
};

function context(extra: Record<string, unknown>) {
  return {
    success: true, issueDate: '2026-11-02', internalNumber: 'FV 7/11/2026', ksefNumber: parentRow.ksef_number, grossTotal: 3,
    seller, buyer, allowedCorrectionTypes: 'all', linesBefore: TRZY_KAWY, linesAfter: structuredClone(TRZY_KAWY), ...extra,
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.saveDraft.mockResolvedValue({ success: true, invoiceId: 'kor-1' });
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function render(ctx: unknown) {
  mocks.getContext.mockResolvedValue(ctx);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<CorrectionInvoiceForm parentInvoices={[parentRow]} preselectedParentId={PARENT_ID} tenantId={TENANT} />);
  });
  await act(async () => {});
  expect(host.textContent).toContain('Korekta faktury FV 7/11/2026');
  return host;
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

const pole = (el: HTMLElement, label: string) => el.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);

describe('formularz korekty „przed / po” faktury w cenach brutto (D6)', () => {
  it('tabele „Było” i „Jest” mają cenę brutto zamiast ceny netto, a zmiana ceny pozycji idzie do zapisu jako cena brutto', async () => {
    const el = await render(context({ pricesGross: true }));

    expect(pole(el, 'Cena brutto pozycji 3 (Jest)')).not.toBeNull();
    expect(pole(el, 'Cena brutto pozycji 3 (Było)')).not.toBeNull();
    expect(el.querySelectorAll('input[aria-label^="Cena netto pozycji"]')).toHaveLength(0);

    await act(async () => {
      setValue(pole(el, 'Cena brutto pozycji 3 (Jest)')!, '1.08');
      setValue(el.querySelector<HTMLInputElement>('input[placeholder="KOR/2026/04/001"]')!, 'KOR/2026/11/001');
      setValue(el.querySelector<HTMLTextAreaElement>('textarea[placeholder^="Np. błąd"]')!, 'Zmiana ceny');
    });
    const draft = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Zapisz szkic')!;
    await act(async () => draft.click());
    await act(async () => {});

    expect(mocks.saveDraft).toHaveBeenCalledTimes(1);
    const payload = mocks.saveDraft.mock.calls[0]![0] as { linesAfter: Array<{ unitPriceGross?: number }> };
    expect(mocks.saveDraft.mock.calls[0]![0]).toMatchObject({ correctionType: 'before_after', pricesGross: true });
    expect(payload.linesAfter.map((l) => l.unitPriceGross)).toEqual([1, 1, 1.08]);
  });

  it('kwoty pozycji „Jest” w podglądzie liczy się od cen brutto: Kawa 3 po 1,08 zł ma brutto 1,08', async () => {
    const el = await render(context({ pricesGross: true }));
    await act(async () => {
      setValue(pole(el, 'Cena brutto pozycji 3 (Jest)')!, '1.08');
    });
    const wiersz = pole(el, 'Cena brutto pozycji 3 (Jest)')!.closest('tr')!;
    const komorki = [...wiersz.querySelectorAll('td')].map((td) => td.textContent?.trim());
    expect(komorki).toContain('1.08');
  });

  it('faktura od brutto tylko z zapisu (bez znacznika cen brutto): bez „przed / po”, cena netto i odmowa jak dotąd', async () => {
    const el = await render(context({ beforeAfterRefusal: 'Faktura FV 7/11/2026 ma pozycje, których kwoty nie wynikają z ilości i ceny netto.' }));
    expect(el.querySelectorAll('input[aria-label^="Cena brutto pozycji"]')).toHaveLength(0);
  });

  it('faktura w cenach netto: szkic „przed / po” z formularza się zapisuje (pusty blok korekty kwotowej nie blokuje walidacji)', async () => {
    const netto = [{ name: 'Usługa', unit: 'szt.', quantity: 1, unitPriceNet: 10, vatRate: '23' }];
    const el = await render(context({ linesBefore: netto, linesAfter: structuredClone(netto) }));
    await act(async () => {
      setValue(el.querySelector<HTMLInputElement>('input[placeholder="KOR/2026/04/001"]')!, 'KOR/2026/11/001');
      setValue(el.querySelector<HTMLTextAreaElement>('textarea[placeholder^="Np. błąd"]')!, 'Zmiana ceny');
    });
    const draft = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Zapisz szkic')!;
    await act(async () => draft.click());
    await act(async () => {});
    expect(mocks.saveDraft).toHaveBeenCalledTimes(1);
    expect(mocks.saveDraft.mock.calls[0]![0]).toMatchObject({ correctionType: 'before_after' });
    expect(mocks.saveDraft.mock.calls[0]![0]).not.toHaveProperty('amountChange');
  });
});
