// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Zwolnienie z VAT na stronie: pusta „Inna podstawa” (ustalenie U19, to samo co
 * na telefonie, `tests/unit/mobile-zwolnienie-vat.test.ts`).
 *
 * Czerwone przed poprawką: przy włączonym zwolnieniu i wyborze „Inna podstawa”
 * wyczyszczone pole tekstowe szło do `updateVatExemptionAction('')`, a pusty
 * tekst to „czynny podatnik VAT” (`normalizeExemptionBasis`). Zwolnienie
 * znikało z bazy, a klient dostawał zielony komunikat „Firma jest czynnym
 * podatnikiem VAT”, choć niczego takiego nie wybrał. Zwolnienie decyduje o
 * stawkach „zw” i podstawie (P_19A) na każdej kolejnej fakturze do KSeF.
 * Akcja serwerowa zostaje bez zmian: pusty tekst i `null` to zamierzona droga
 * wyłączenia zwolnienia (`vat-exemption-action.test.ts`), więc straż stoi w
 * formularzu, a serwer dostaje od niego `null` tylko po wyłączeniu przełącznika.
 *
 * Podstawiamy tylko akcję serwerową (`'use server'` ciągnie backend) i
 * powiadomienia; formularz jest prawdziwy.
 */

const mocks = vi.hoisted(() => ({
  zapisz: vi.fn(),
  sukces: vi.fn(),
  blad: vi.fn(),
}));

vi.mock('@/app/actions/vat-exemption', () => ({ updateVatExemptionAction: mocks.zapisz }));
vi.mock('sonner', () => ({ toast: { success: mocks.sukces, error: mocks.blad } }));

import { VatExemptionForm } from '@/components/settings/vat-exemption-form';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WLASNA = 'art. 43 ust. 1 pkt 29 lit. c ustawy o VAT';
let host: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.zapisz.mockResolvedValue({ success: true, basis: WLASNA });
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

async function pokaz(initialBasis: string | null) {
  root = createRoot(host);
  await act(async () => root!.render(<VatExemptionForm initialBasis={initialBasis} canEdit />));
}

async function wpisz(pole: HTMLInputElement, tekst: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(pole, tekst);
    pole.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function kliknijZapisz() {
  const przycisk = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Zapisz');
  expect(przycisk).toBeTruthy();
  await act(async () => przycisk!.click());
}

const poleInnej = () => host.querySelector<HTMLInputElement>('input[aria-label="Inna podstawa prawna zwolnienia"]')!;

describe('formularz zwolnienia z VAT: pusta „Inna podstawa” nie zdejmuje zwolnienia', () => {
  it.each(['', '   ', '\t', '   '])('wyczyszczone pole (%j): zdanie dla klienta, żaden zapis do serwera', async (pusty) => {
    await pokaz(WLASNA);
    await wpisz(poleInnej(), pusty);
    await kliknijZapisz();

    expect(mocks.zapisz).not.toHaveBeenCalled();
    expect(mocks.blad).toHaveBeenCalledWith('Podaj podstawę zwolnienia z VAT.');
    expect(mocks.sukces).not.toHaveBeenCalled();
    // Nie tylko znikający komunikat: pole jest oznaczone jako błędne i dostaje fokus.
    expect(poleInnej().getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(poleInnej());
  });

  it('po wpisaniu podstawy oznaczenie błędu znika', async () => {
    await pokaz(WLASNA);
    await wpisz(poleInnej(), '');
    await kliknijZapisz();
    await wpisz(poleInnej(), 'art. 43 ust. 1 pkt 38 ustawy o VAT');

    expect(poleInnej().getAttribute('aria-invalid')).toBeNull();
  });

  it('puste pole, potem wyłączony przełącznik: zapis wysyła null (świadome wyłączenie zwolnienia)', async () => {
    mocks.zapisz.mockResolvedValue({ success: true, basis: null });
    await pokaz(WLASNA);
    await wpisz(poleInnej(), '');
    await kliknijZapisz();
    expect(mocks.zapisz).not.toHaveBeenCalled();

    await act(async () => host.querySelector<HTMLElement>('#vat-exempt')!.click());
    await kliknijZapisz();

    expect(mocks.zapisz).toHaveBeenCalledWith(null);
    expect(mocks.sukces).toHaveBeenCalledWith('Firma jest czynnym podatnikiem VAT');
  });

  it('wpisana podstawa własna jest zapisywana jak dotąd', async () => {
    await pokaz(WLASNA);
    await wpisz(poleInnej(), 'art. 43 ust. 1 pkt 38 ustawy o VAT');
    await kliknijZapisz();

    expect(mocks.zapisz).toHaveBeenCalledWith('art. 43 ust. 1 pkt 38 ustawy o VAT');
    expect(mocks.blad).not.toHaveBeenCalled();
  });

  it('wyłączony przełącznik wysyła null: to jedyna droga do „czynnego podatnika VAT”', async () => {
    mocks.zapisz.mockResolvedValue({ success: true, basis: null });
    await pokaz(null);
    await kliknijZapisz();

    expect(mocks.zapisz).toHaveBeenCalledWith(null);
    expect(mocks.sukces).toHaveBeenCalledWith('Firma jest czynnym podatnikiem VAT');
  });
});
