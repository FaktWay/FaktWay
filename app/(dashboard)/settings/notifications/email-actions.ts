'use server';

import { revalidatePath } from 'next/cache';
import { getVerifiedUserContext } from '@/lib/auth/verified-user';
import type { EmailCategory } from '@/lib/email/preferences';
import { isToggleableEmailCategory, setEmailCategory } from '@/lib/email/settings-toggle';

export type EmailPreferenceResult =
  | { success: true }
  | { success: false; error: string };

/** Zgoda i wypis: `lib/email/settings-toggle.ts` (ta sama logika dla telefonu, M10c). */
export async function toggleEmailCategoryAction(
  category: EmailCategory,
  subscribed: boolean,
): Promise<EmailPreferenceResult> {
  const context = await getVerifiedUserContext();
  if (!context.ok) return { success: false, error: context.error };
  if (!isToggleableEmailCategory(category) || typeof subscribed !== 'boolean') {
    return { success: false, error: 'Nieprawidłowe ustawienie powiadomień.' };
  }
  try {
    await setEmailCategory({ userId: context.user.id, category, subscribed, method: 'settings_ui' });
  } catch {
    return { success: false, error: 'Nie udało się zapisać ustawienia. Spróbuj ponownie.' };
  }
  revalidatePath('/settings/notifications');
  return { success: true };
}
