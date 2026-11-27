// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

/**
 * Uwaga N1 czytelnika #956 (D47, audyt dostępności #610): przycisk zamknięcia
 * powiadomienia o błędzie ma etykietę dla czytnika ekranu po polsku. Sonner 2.0.8
 * daje domyślnie „Close toast”; etykietę ustawia `toastOptions.closeButtonAriaLabel`.
 * Atrapa tylko biblioteki `sonner` (zapamiętuje opcje), prawdziwy jest nasz `Toaster`.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const m = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));
vi.mock('sonner', () => ({
  Toaster: (props: Record<string, unknown>) => {
    m.props.push(props);
    return null;
  },
}));

const { Toaster, TOAST_OPTIONS_ZAMKNIECIE_BLEDU } = await import('@/components/ui/sonner');

describe('etykieta przycisku zamknięcia powiadomienia', () => {
  it('jest po polsku we wspólnych opcjach', () => {
    expect(TOAST_OPTIONS_ZAMKNIECIE_BLEDU.closeButtonAriaLabel).toBe('Zamknij powiadomienie');
  });

  it('Toaster przekazuje ją do sonnera razem z przyciskiem zamknięcia', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => {
      root.render(<Toaster />);
    });
    const ostatnie = m.props.at(-1)?.toastOptions as Record<string, unknown> | undefined;
    expect(ostatnie).toMatchObject({ closeButton: true, closeButtonAriaLabel: 'Zamknij powiadomienie' });
    act(() => root.unmount());
  });
});
