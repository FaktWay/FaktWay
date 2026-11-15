import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { subscriptionForMobile } from '@/lib/api/mobile/abonament';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/** `GET /api/mobile/v1/abonament` (M10e): stan subskrypcji do odczytu, bez cen (D5). Logika: `lib/api/mobile/abonament.ts`. */
export async function GET(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await subscriptionForMobile(caller);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
