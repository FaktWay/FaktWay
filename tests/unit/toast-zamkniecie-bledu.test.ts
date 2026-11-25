/**
 * D47 (plan kompletnej aplikacji, audyt dostępności #610, WCAG 2.1 kryterium 2.2.1):
 * powiadomienie o błędzie ma przycisk zamknięcia, sukces dalej znika sam i go nie ma.
 * Sonner 2.0.8 nie ma opcji `closeButton` per typ, więc przycisk jest włączony dla
 * wszystkich, a typy inne niż błąd chowają go klasą (`classNames.<typ>`).
 */
import { describe, expect, it } from 'vitest';

import { TOAST_OPTIONS_ZAMKNIECIE_BLEDU } from '@/components/ui/sonner';

const CHOWA_PRZYCISK = /\[data-close-button\]\]:hidden!/;

describe('przycisk zamknięcia w powiadomieniach', () => {
  it('jest włączony, a błąd go nie chowa', () => {
    expect(TOAST_OPTIONS_ZAMKNIECIE_BLEDU.closeButton).toBe(true);
    expect(TOAST_OPTIONS_ZAMKNIECIE_BLEDU.classNames?.error ?? '').not.toMatch(CHOWA_PRZYCISK);
  });

  it.each(['success', 'info', 'warning', 'loading', 'default'] as const)(
    '%s: przycisk zamknięcia jest schowany (znika samo)',
    (typ) => {
      expect(TOAST_OPTIONS_ZAMKNIECIE_BLEDU.classNames?.[typ]).toMatch(CHOWA_PRZYCISK);
    },
  );
});
