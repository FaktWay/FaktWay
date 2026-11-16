import 'server-only';

import type { NextResponse } from 'next/server';
import { z } from 'zod';

import type { MobileCaller } from '@/lib/api/mobile/auth';
import type { KategoriaEmaila, PowiadomieniaOdpowiedz } from '@/lib/api/mobile/kontrakt-ustawienia';
import { mobileError, mobileJson } from '@/lib/api/mobile/responses';
import { readJsonBody } from '@/lib/api/mobile/tresc';
import { readDisabledEmailCategories, setEmailCategory, type ToggleableEmailCategory } from '@/lib/email/settings-toggle';

/**
 * Karta Powiadomienia z telefonu (plan aplikacji mobilnej, M10c): e-maile
 * „Porady i nowości” i „Oferty i kampanie” tą samą logiką co strona
 * (`lib/email/settings-toggle.ts`: wypis, zgoda z art. 398 Prawa komunikacji
 * elektronicznej, wpis w dzienniku). Zgoda i wypis z telefonu mają źródło
 * `mobile_settings`, ze strony `settings_ui`. Konto, nie firma
 * (`org: 'none'`). Powiadomienia push w aplikacji dojdą z M11.
 *
 * Ponowienie: zapis ustawia stan (nie przełącza), więc powtórka daje ten sam
 * stan i drugi wpis zgody z nowym czasem.
 */

const KATEGORIA: Record<KategoriaEmaila, ToggleableEmailCategory> = { porady: 'product_updates', oferty: 'marketing' };
const zmianaSchema = z.object({ kategoria: z.enum(['porady', 'oferty']), wlaczone: z.boolean() }).strict();

async function stan(caller: MobileCaller): Promise<PowiadomieniaOdpowiedz> {
  const wylaczone = await readDisabledEmailCategories(caller.user.id);
  return {
    email: wylaczone
      ? { porady: !wylaczone.includes('product_updates'), oferty: !wylaczone.includes('marketing') }
      : null,
  };
}

/** `GET /api/mobile/v1/ustawienia/powiadomienia`. */
export async function notificationsForMobile(caller: MobileCaller): Promise<NextResponse> {
  return mobileJson(await stan(caller), 200, caller.headers);
}

/** `POST /api/mobile/v1/ustawienia/powiadomienia`. */
export async function saveNotificationFromMobile(caller: MobileCaller, request: Request): Promise<NextResponse> {
  const raw = await readJsonBody(request, caller.headers, { maxBytes: 1_000, tooLarge: 'Treść jest za długa.' });
  if (!raw.ok) return raw.response;
  const parsed = zmianaSchema.safeParse(raw.value);
  if (!parsed.success) {
    return mobileError(400, 'invalid_request', 'Treść żądania nie pasuje do kontraktu. Zaktualizuj aplikację FaktWay.', caller.headers);
  }
  try {
    await setEmailCategory({
      userId: caller.user.id,
      category: KATEGORIA[parsed.data.kategoria],
      subscribed: parsed.data.wlaczone,
      channel: 'mobile_settings',
    });
  } catch {
    // Zdanie strony; telefon ponawia jak przy 503 i zostawia przełącznik w stanie sprzed zmiany.
    return mobileError(503, 'service_unavailable', 'Nie udało się zapisać ustawienia. Spróbuj ponownie.', caller.headers);
  }
  return mobileJson(await stan(caller), 200, caller.headers);
}
