import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { inventoryCreateFromMobile } from '@/lib/api/mobile/ksiegowosc-zapisy';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/** `POST /api/mobile/v1/ksiegowosc/ewidencja/spisy` (M10d): spis z natury. Logika: `lib/api/mobile/ksiegowosc-zapisy.ts`. */
export async function POST(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await inventoryCreateFromMobile(caller, request);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
