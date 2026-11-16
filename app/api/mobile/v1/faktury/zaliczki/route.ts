import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { settleableAdvancesFromMobile } from '@/lib/api/mobile/faktury-rodzaje';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/mobile/v1/faktury/zaliczki` (M8b): zaliczki przyjęte w KSeF i jeszcze
 * nierozliczone, do faktury rozliczającej (jak lista formularza na stronie).
 * Tylko odczyt tokenem klienta (RLS).
 */
export async function GET(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;

  try {
    return await settleableAdvancesFromMobile(caller);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
