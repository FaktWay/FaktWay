import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { accountantForMobile } from '@/lib/api/mobile/ksiegowa';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/** `GET /api/mobile/v1/ksiegowa` (M10e): karta Księgowa do odczytu (właściciel). Logika: `lib/api/mobile/ksiegowa.ts`. */
export async function GET(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await accountantForMobile(caller);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
