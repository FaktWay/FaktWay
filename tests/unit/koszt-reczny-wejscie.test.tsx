// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: m.push, refresh: vi.fn() }) }));
vi.mock('@/components/expenses/use-expense-capture', () => ({
  useExpenseCapture: () => ({ state: { kind: 'idle' }, busy: false, openCamera: vi.fn(), openGallery: vi.fn(), inputs: null }),
}));

import { CaptureButton } from '@/components/expenses/capture-button';

/**
 * Krok 3.8, część 1: z „+ Dodaj wydatek” na Kosztach da się wpisać koszt
 * ręcznie (obok zdjęcia i pliku). Prawdziwy przycisk, atrapa tylko wgrywania.
 */

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  m.push.mockReset();
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  })) as unknown as typeof window.matchMedia;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('wejście do ręcznego kosztu z listy Kosztów', () => {
  it('arkusz „Dodaj wydatek” ma trzecią drogę „Wpisz ręcznie”, która prowadzi do formularza', async () => {
    await act(async () => {
      root.render(<CaptureButton />);
    });
    const otworz = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Dodaj wydatek'))!;
    await act(async () => { otworz.click(); });
    const opcja = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Wpisz ręcznie'));
    expect(opcja, 'brak opcji „Wpisz ręcznie” w arkuszu').toBeTruthy();
    await act(async () => { opcja!.click(); });
    expect(m.push).toHaveBeenCalledWith('/expenses/new');
  });
});
