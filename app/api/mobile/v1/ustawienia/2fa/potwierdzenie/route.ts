import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { mobileFailure } from '@/lib/api/mobile/responses';
import { confirmTotpFromMobile } from '@/lib/api/mobile/ustawienia-2fa';

export const dynamic = 'force-dynamic';

/** `POST /api/mobile/v1/ustawienia/2fa/potwierdzenie`: pierwszy kod kończy włączanie 2FA (M10c, część 2b). Logika i warunki strony: `lib/api/mobile/ustawienia-2fa.ts`. */
export async function POST(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'none' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await confirmTotpFromMobile(caller, request);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
