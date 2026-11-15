import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { auditLogForMobile } from '@/lib/api/mobile/karty-wiecej';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/** `GET /api/mobile/v1/dziennik` (M10e): Dziennik zdarzeń, ostatnie 200 wpisów. Logika: `lib/api/mobile/karty-wiecej.ts`. */
export async function GET(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await auditLogForMobile(caller);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
