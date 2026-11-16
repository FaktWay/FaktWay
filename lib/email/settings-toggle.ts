import 'server-only';

import {
  getEmailConsents,
  getUnsubscribedCategories,
  resubscribe,
  unsubscribe,
  type EmailCategory,
} from '@/lib/email/preferences';
import { setEmailConsent } from '@/lib/legal/record';

/**
 * Przełączniki e-maili w ustawieniach (porady i nowości, oferty): odczyt
 * i zapis wspólne dla strony (`settings/notifications`) i telefonu
 * (`/api/mobile/v1/ustawienia/powiadomienia`, M10c). Wydzielone z akcji
 * i strony bez zmiany zachowania.
 */

export const TOGGLEABLE_EMAIL_CATEGORIES = ['product_updates', 'marketing'] as const;
export type ToggleableEmailCategory = (typeof TOGGLEABLE_EMAIL_CATEGORIES)[number];

export function isToggleableEmailCategory(value: unknown): value is ToggleableEmailCategory {
  return (TOGGLEABLE_EMAIL_CATEGORIES as readonly unknown[]).includes(value);
}

/**
 * Kategorie pokazane jako wyłączone. Przełącznik jest włączony tylko przy
 * zgodzie i bez wypisu, tak samo, jak decyduje wysyłka (`canSendTo`). Bez
 * zgody: „wyłączone”. `null`: któregoś odczytu nie ma, więc nie pokazujemy
 * stanu, który mógłby być nieprawdą.
 */
export function disabledEmailCategories(
  unsubscribed: EmailCategory[] | null,
  consents: Record<ToggleableEmailCategory, boolean> | null,
): EmailCategory[] | null {
  if (!unsubscribed || !consents) return null;
  return [...new Set<EmailCategory>([...unsubscribed, ...TOGGLEABLE_EMAIL_CATEGORIES.filter((c) => !consents[c])])];
}

/** Odczyt stanu przełączników konta; błąd odczytu to `null` (jak strona). */
export async function readDisabledEmailCategories(userId: string): Promise<EmailCategory[] | null> {
  const [unsubscribed, consents] = await Promise.all([
    getUnsubscribedCategories(userId).catch(() => null),
    getEmailConsents(userId).catch(() => null),
  ]);
  return disabledEmailCategories(unsubscribed, consents);
}

/**
 * Porady i oferty wymagają zgody (art. 398 Prawa komunikacji elektronicznej):
 * włączenie przełącznika JEST wyrażeniem zgody, wyłączenie — jej wycofaniem.
 * Przy wyłączaniu najpierw wiersz wypisu (blokuje wysyłkę od razu), potem
 * zgoda. `method` trafia do zapisu zgody (gdzie ją wyrażono). Rzuca przy
 * błędzie zapisu.
 */
export async function setEmailCategory(input: {
  userId: string;
  category: ToggleableEmailCategory;
  subscribed: boolean;
  method: string;
}): Promise<void> {
  const { userId, category, subscribed, method } = input;
  if (subscribed) {
    await resubscribe(userId, category);
  } else {
    await unsubscribe({ userId, category, source: 'settings_ui' });
  }
  const consent = await setEmailConsent({ userId, category, granted: subscribed, method });
  if (!consent.ok) throw new Error('consent_write_failed');
}
