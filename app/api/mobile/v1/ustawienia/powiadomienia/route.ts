import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { mobileFailure } from '@/lib/api/mobile/responses';
import { notificationsForMobile, saveNotificationFromMobile } from '@/lib/api/mobile/ustawienia-powiadomienia';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/mobile/v1/ustawienia/powiadomienia` (M10c): e-maile porad i ofert konta, jak karta strony.
 * `POST`: włączenie (zgoda) albo wyłączenie (wycofanie zgody). Logika: `lib/api/mobile/ustawienia-powiadomienia.ts`.
 */
export async function GET(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'none' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await notificationsForMobile(caller);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}

export async function POST(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'none' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await saveNotificationFromMobile(caller, request);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
