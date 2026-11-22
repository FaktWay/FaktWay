import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { mobileFailure } from '@/lib/api/mobile/responses';
import { passkeysForMobile } from '@/lib/api/mobile/ustawienia-bezpieczenstwo';

export const dynamic = 'force-dynamic';

/** `GET /api/mobile/v1/ustawienia/klucze`: klucze dostępu konta (M10c, część 2). Konto, bez firmy. Logika i warunki strony: `lib/api/mobile/ustawienia-bezpieczenstwo.ts`. */
export async function GET(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'none' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await passkeysForMobile(caller);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
