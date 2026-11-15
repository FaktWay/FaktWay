import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { cashFlowForMobile } from '@/lib/api/mobile/przeplywy';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/** `GET /api/mobile/v1/przeplywy` (M10e): karty strony `/przeplywy`. Logika: `lib/api/mobile/przeplywy.ts`. */
export async function GET(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await cashFlowForMobile(caller);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
