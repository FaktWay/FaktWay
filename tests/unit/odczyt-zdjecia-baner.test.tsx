// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ param: null as string | null, status: vi.fn(), replace: vi.fn() }));

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: (k: string) => (k === 'paragon' ? m.param : null) }),
  useRouter: () => ({ replace: m.replace, refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => '/dashboard',
}));
vi.mock('@/app/actions/expenses', () => ({ getOcrJobStatusAction: m.status }));

import { OdczytZdjeciaBaner } from '@/components/dashboard/odczyt-zdjecia-baner';

/**
 * Krok 8.1 planu kompletnej aplikacji: po udostępnieniu zdjęcia paragonu
 * z telefonu (`/share-target` przekierowuje na `/dashboard?paragon=<zadanie>`)
 * klient widzi, co się dzieje z odczytem: czytamy, gotowe (link do kosztu),
 * nie udało się (co dalej), trwa dłużej niż zwykle. Do tej pory pasek Flo
 * z `?paragon=` nie był nigdzie wyświetlany. Prawdziwy komponent, atrapa
 * tylko akcji stanu odczytu.
 */

const JOB = '11111111-1111-4111-8111-111111111111';
const EXPENSE = '22222222-2222-4222-8222-222222222222';
const zadanie = (status: string, o: Record<string, unknown> = {}) => ({
  success: true,
  job: { id: JOB, status, error_message: null, expense_id: null, extracted_data: null, ...o },
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  m.param = JOB;
  m.status.mockReset();
  m.replace.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

async function pokaz() {
  await act(async () => {
    root.render(<OdczytZdjeciaBaner />);
  });
}
const czekaj = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const tekst = () => host.textContent ?? '';
const status = () => host.querySelector('[role="status"], [role="alert"]');

describe('pasek odczytu zdjęcia po udostępnieniu z telefonu', () => {
  it('bez parametru paragon nic nie pokazuje i nie pyta o stan', async () => {
    m.param = null;
    await pokaz();
    await czekaj(10_000);
    expect(host.querySelector('[data-testid="odczyt-zdjecia-baner"]')).toBeNull();
    expect(m.status).not.toHaveBeenCalled();
  });

  it('odczyt w toku: „Czytamy paragon”, pyta o stan od razu i co kilka sekund', async () => {
    m.status.mockResolvedValue(zadanie('processing'));
    await pokaz();
    expect(tekst()).toMatch(/Czytamy .*paragon/i);
    expect(status()?.getAttribute('role')).toBe('status');
    expect(m.status).toHaveBeenCalledWith(JOB);
    const razy = m.status.mock.calls.length;
    await czekaj(4000);
    expect(m.status.mock.calls.length).toBeGreaterThan(razy);
  });

  it('gotowe: komunikat i link do kosztu, pytanie o stan się kończy', async () => {
    m.status.mockResolvedValueOnce(zadanie('processing')).mockResolvedValue(zadanie('completed', { expense_id: EXPENSE }));
    await pokaz();
    await czekaj(5000);
    expect(tekst()).toMatch(/odczytan/i);
    const link = host.querySelector<HTMLAnchorElement>(`a[href="/expenses/${EXPENSE}"]`);
    expect(link).not.toBeNull();
    const razy = m.status.mock.calls.length;
    await czekaj(20_000);
    expect(m.status.mock.calls.length).toBe(razy);
  });

  it('nie udało się: komunikat z drogą wyjścia (dodaj wydatek ręcznie), bez obietnicy archiwum', async () => {
    m.status.mockResolvedValue(zadanie('failed', { error_message: 'x' }));
    await pokaz();
    expect(tekst()).toMatch(/Nie udało się odczytać/i);
    expect(host.querySelector('a[href="/expenses"]')).not.toBeNull();
    expect(status()?.getAttribute('role')).toBe('alert');
    expect(tekst()).not.toContain('x');
  });

  it('chwilowy błąd odczytu stanu nie kończy czekania: pyta dalej i potem pokazuje wynik', async () => {
    m.status
      .mockResolvedValueOnce({ success: false, retryable: true, error: 'chwilowo' })
      .mockResolvedValue(zadanie('completed', { expense_id: EXPENSE }));
    await pokaz();
    expect(tekst()).toMatch(/Czytamy/i);
    await czekaj(5000);
    expect(host.querySelector(`a[href="/expenses/${EXPENSE}"]`)).not.toBeNull();
  });

  it('zadania nie ma (inna firma, zły identyfikator): przestaje pytać i odsyła do listy kosztów', async () => {
    m.status.mockResolvedValue({ success: false, retryable: false, error: 'Job nie istnieje' });
    await pokaz();
    expect(tekst()).toMatch(/Nie znaleźliśmy/i);
    expect(host.querySelector('a[href="/expenses"]')).not.toBeNull();
    const razy = m.status.mock.calls.length;
    await czekaj(20_000);
    expect(m.status.mock.calls.length).toBe(razy);
  });

  it('po 3 minutach bez wyniku: „trwa dłużej niż zwykle”, wynik pojawi się w Kosztach, koniec pytań', async () => {
    m.status.mockResolvedValue(zadanie('processing'));
    await pokaz();
    await czekaj(3 * 60 * 1000 + 5000);
    expect(tekst()).toMatch(/dłużej niż zwykle/i);
    expect(host.querySelector('a[href="/expenses"]')).not.toBeNull();
    const razy = m.status.mock.calls.length;
    await czekaj(30_000);
    expect(m.status.mock.calls.length).toBe(razy);
  });

  it.each([
    ['blad', /Nie udało się przyjąć/i],
    ['brak-zdjecia', /Nie dostaliśmy zdjęcia/i],
  ])('wartość „%s” z trasy udostępniania: komunikat bez pytania o stan', async (wartosc, wzorzec) => {
    m.param = wartosc;
    await pokaz();
    expect(tekst()).toMatch(wzorzec);
    expect(m.status).not.toHaveBeenCalled();
  });

  it('„Zamknij” chowa pasek i czyści parametr z adresu', async () => {
    m.status.mockResolvedValue(zadanie('processing'));
    await pokaz();
    const przycisk = [...host.querySelectorAll('button')].find((b) => /Zamknij/.test(b.textContent ?? '') || /Zamknij/.test(b.getAttribute('aria-label') ?? ''))!;
    await act(async () => { przycisk.click(); });
    expect(host.querySelector('[data-testid="odczyt-zdjecia-baner"]')).toBeNull();
    expect(m.replace).toHaveBeenCalledWith('/dashboard');
  });

  it('teksty bez długich myślników i bez nazwy sprzed zmiany marki', async () => {
    m.status.mockResolvedValue(zadanie('processing'));
    await pokaz();
    expect(tekst()).not.toMatch(/—|–|FaktFlow/);
  });
});
