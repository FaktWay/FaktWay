// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ekrany potwierdzenia salda (krok 2.9, część 2, PR C; D26-D28, D58): zestawienie
 * z kolumnami z D27 (bez netto i VAT), ROZ z kwotą po zaliczkach i przypisem,
 * pominięte dokumenty z powodami, wystawienie z odciskiem i świadomym „Wystaw
 * bez tych dokumentów”, lista i przycisk przy kontrahencie.
 */

const m = vi.hoisted(() => ({ issue: vi.fn(), send: vi.fn(), push: vi.fn(), refresh: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: m.push, refresh: m.refresh, replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/app/actions/saldo', () => ({
  issueBalanceConfirmationAction: m.issue,
  sendBalanceConfirmationEmailAction: m.send,
  previewBalanceConfirmationAction: vi.fn(),
}));
vi.mock('@/app/actions/contractors', () => ({ deleteContractorAction: vi.fn(), updateContractorAction: vi.fn() }));

import { BalanceActions } from '@/app/(dashboard)/saldo/_components/balance-actions';
import { BalanceDocument } from '@/app/(dashboard)/saldo/_components/balance-document';
import { BalanceIssueActions } from '@/app/(dashboard)/saldo/_components/balance-issue-actions';
import { BalanceList } from '@/app/(dashboard)/saldo/_components/balance-list';
import { BalanceOmittedList } from '@/app/(dashboard)/saldo/_components/balance-omitted';
import { ContractorRowActions } from '@/components/contractors/contractor-row-actions';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { BalanceContent, BalanceItem, BalanceOmitted } from '@/lib/saldo/model';
import { balanceGrossShown } from '@/lib/saldo/pozycje';
import { BALANCE_SCOPE_NOTICE, BALANCE_SETTLEMENT_NOTE, OMITTED_REASON_LABELS } from '@/lib/saldo/teksty';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KONTRAHENT = '0b8a3f4e-2c1d-4e5f-8a9b-0c1d2e3f4a5b';
const DOKUMENT = '5d0e8a8c-7a3b-4f61-9d2e-1c4b5a6f7e80';
const ODCISK = 'abcdef0123456789abcdef0123456789';

const plain = (html: string) => html.replace(/\u00a0/g, ' ').replace(/&quot;/g, '"');

function pozycja(zmiany: Partial<BalanceItem> = {}): BalanceItem {
  return {
    invoiceId: '00215215-2222-4000-8000-000000000001', number: 'FV/1/2026', ksefNumber: null, issueDate: '2026-10-01',
    dueDate: '2026-10-15', kind: 'regular', type: 'VAT', gross: 1230, amountDue: 1230, paid: 230, outstanding: 1000, ...zmiany,
  };
}

function tresc(zmiany: Partial<BalanceContent> = {}): BalanceContent {
  return {
    contractorId: KONTRAHENT,
    asOf: '2026-11-25',
    issuer: { name: 'Moja Firma', nip: '1234567890', countryCode: 'PL', addressLine1: 'ul. Przykładowa 1', addressLine2: '00-001 Warszawa', email: null },
    counterparty: { name: 'Kontrahent Testowy', nip: '9876543210', countryCode: 'PL', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa', email: 'k@kontrahent.test' },
    items: [pozycja()],
    omitted: [],
    total: 1000,
    ...zmiany,
  };
}

const pominieta: BalanceOmitted = {
  invoiceId: '00215215-2222-4000-8000-000000000009', number: 'FV/9/2026', ksefNumber: null, issueDate: '2026-09-01',
  kind: 'regular', type: 'VAT', currency: null, gross: 500, reason: 'corrected',
};

describe('zestawienie na ekranie', () => {
  it('kolumny z D27 bez netto i VAT, saldo, dopisek o zakresie bez uznania długu', () => {
    const html = plain(renderToStaticMarkup(<BalanceDocument content={tresc()} number='PS/1/2026' />));
    for (const tekst of ['PS/1/2026', 'Numer faktury', 'Data wystawienia', 'Termin płatności', 'Kwota brutto', 'Wpłacono', 'Do zapłaty', 'FV/1/2026', '1000,00 PLN', BALANCE_SCOPE_NOTICE]) {
      expect(html, tekst).toContain(tekst);
    }
    expect(html).not.toMatch(/netto|VAT<|uzna|przedawni/i);
  });

  it('podgląd przed wystawieniem nie ma numeru', () => {
    const html = renderToStaticMarkup(<BalanceDocument content={tresc()} />);
    expect(html).toMatch(/numer nada się przy wystawieniu/);
  });

  it('faktura rozliczająca: kwota po zaliczkach (D58) i przypis; brutto minus wpłacono daje do zapłaty', () => {
    const roz = pozycja({ number: 'ROZ/1/2026', kind: 'final', type: 'ROZ', gross: 10_000, amountDue: 7000, paid: 2000, outstanding: 5000 });
    expect(balanceGrossShown(roz)).toBe(7000);
    expect(balanceGrossShown(pozycja())).toBe(1230);
    const html = plain(renderToStaticMarkup(<BalanceDocument content={tresc({ items: [roz], total: 5000 })} number='PS/2/2026' />));
    expect(html).toContain('ROZ/1/2026 *');
    expect(html).toContain('7000,00');
    expect(html).not.toContain('10000,00');
    expect(html).toContain(BALANCE_SETTLEMENT_NOTE);
  });

  it('bez ROZ nie ma przypisu o zaliczkach', () => {
    expect(plain(renderToStaticMarkup(<BalanceDocument content={tresc()} />))).not.toContain(BALANCE_SETTLEMENT_NOTE);
  });

  it('teksty bez długich myślników', () => {
    expect(renderToStaticMarkup(<BalanceDocument content={tresc({ omitted: [pominieta] })} number='PS/1/2026' />)).not.toMatch(/[—–]/);
  });
});

describe('pominięte dokumenty', () => {
  it('każda faktura z numerem, kwotą i powodem; pusta lista nic nie pokazuje', () => {
    const html = plain(renderToStaticMarkup(<BalanceOmittedList omitted={[pominieta]} />));
    expect(html).toContain('Pominięte dokumenty');
    expect(html).toContain('FV/9/2026');
    expect(html).toContain('500,00 PLN');
    expect(html).toContain(OMITTED_REASON_LABELS.corrected);
    expect(renderToStaticMarkup(<BalanceOmittedList omitted={[]} />)).toBe('');
  });
});

describe('lista i przycisk przy kontrahencie', () => {
  it('lista: numer prowadzi do dokumentu, pusta lista wskazuje Kontrahentów', () => {
    const wiersz = { id: DOKUMENT, number: 'PS/1/2026', asOf: '2026-11-25', counterpartyName: 'Kontrahent Testowy', total: 1000, issuedAt: '2026-11-25T09:30:00Z' };
    const html = plain(renderToStaticMarkup(<BalanceList rows={[wiersz]} />));
    expect(html).toContain(`href="/saldo/${DOKUMENT}"`);
    expect(html).toContain('1000,00 zł');
    const pusta = renderToStaticMarkup(<BalanceList rows={[]} />);
    expect(pusta).toContain('href="/contractors"');
    expect(pusta).toMatch(/Nie masz jeszcze potwierdzeń salda/);
  });

  const kontrahent = { id: KONTRAHENT, nip: '9876543210', name: 'Kontrahent Testowy', address: null, email: null };

  it('przycisk widać tylko przy balanceAvailable', () => {
    const z = renderToStaticMarkup(
      <TooltipProvider><ContractorRowActions contractor={{ ...kontrahent, balanceAvailable: true }} /></TooltipProvider>,
    );
    expect(z).toContain(`href="/saldo/nowe?kontrahent=${KONTRAHENT}"`);
    expect(z).toContain('Potwierdzenie salda');
    for (const bez of [kontrahent, { ...kontrahent, balanceAvailable: false }]) {
      const html = renderToStaticMarkup(<TooltipProvider><ContractorRowActions contractor={bez} /></TooltipProvider>);
      expect(html).not.toContain('/saldo/');
      expect(html).not.toContain('Potwierdzenie salda');
    }
  });
});

describe('wystawienie', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    m.issue.mockReset().mockResolvedValue({ success: true, id: DOKUMENT, number: 'PS/1/2026', alreadyIssued: false });
    m.push.mockReset();
    m.refresh.mockReset();
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const klik = async (tekst: string, ostatni = false) => {
    const przyciski = [...document.body.querySelectorAll('button')].filter((b) => b.textContent?.trim() === tekst);
    expect(przyciski.length, tekst).toBeGreaterThan(0);
    await act(async () => {
      (ostatni ? przyciski[przyciski.length - 1]! : przyciski[0]!).click();
      await new Promise((r) => setTimeout(r, 20));
    });
  };

  it('bez pominiętych: „Wystaw potwierdzenie salda”, odcisk i firma strony, potem podgląd dokumentu', async () => {
    await act(async () => {
      root.render(<BalanceIssueActions contractorId={KONTRAHENT} tenantId={TENANT} fingerprint={ODCISK} hasOmitted={false} />);
    });
    expect(container.textContent).not.toContain('Wystaw bez tych dokumentów');
    await klik('Wystaw potwierdzenie salda');
    await klik('Wystaw potwierdzenie salda', true);
    expect(m.issue).toHaveBeenCalledTimes(1);
    expect(m.issue).toHaveBeenCalledWith({ contractorId: KONTRAHENT, fingerprint: ODCISK, withoutOmitted: false }, TENANT);
    expect(m.push).toHaveBeenCalledWith(`/saldo/${DOKUMENT}`);
  });

  it('z pominiętymi: jedyny przycisk to świadome „Wystaw bez tych dokumentów”', async () => {
    await act(async () => {
      root.render(<BalanceIssueActions contractorId={KONTRAHENT} tenantId={TENANT} fingerprint={ODCISK} hasOmitted />);
    });
    expect(container.textContent).not.toContain('Wystaw potwierdzenie salda');
    await klik('Wystaw bez tych dokumentów');
    await klik('Wystaw bez tych dokumentów', true);
    expect(m.issue).toHaveBeenCalledWith({ contractorId: KONTRAHENT, fingerprint: ODCISK, withoutOmitted: true }, TENANT);
  });

  it('odmowa (np. zmienione faktury) to komunikat z przyciskiem odświeżenia, bez przejścia dalej', async () => {
    m.issue.mockResolvedValue({ success: false, error: 'Faktury albo wpłaty zmieniły się. Odśwież podgląd.' });
    await act(async () => {
      root.render(<BalanceIssueActions contractorId={KONTRAHENT} tenantId={TENANT} fingerprint={ODCISK} hasOmitted={false} />);
    });
    await klik('Wystaw potwierdzenie salda');
    await klik('Wystaw potwierdzenie salda', true);
    expect(container.textContent).toContain('Odśwież podgląd.');
    expect(m.push).not.toHaveBeenCalled();
    await klik('Odśwież podgląd');
    expect(m.refresh).toHaveBeenCalled();
  });
});

describe('przyciski wystawionego dokumentu', () => {
  it('PDF zawsze, wysyłka tylko gdy dostępna (D59)', () => {
    const z = renderToStaticMarkup(<BalanceActions confirmationId={DOKUMENT} number='PS/1/2026' defaultEmail={null} canSend />);
    expect(z).toContain(`/api/saldo/${DOKUMENT}/pdf`);
    expect(z).toContain('Wyślij e-mailem');
    const bez = renderToStaticMarkup(<BalanceActions confirmationId={DOKUMENT} number='PS/1/2026' defaultEmail={null} canSend={false} />);
    expect(bez).toContain(`/api/saldo/${DOKUMENT}/pdf`);
    expect(bez).not.toContain('Wyślij e-mailem');
  });
});
