import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { ledgerForMobile } from '@/lib/api/mobile/ksiegowosc-ksiegi';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/** `GET /api/mobile/v1/ksiegowosc/ewidencja?miesiac=RRRR-MM` (M10d): ewidencja ryczałtu albo KPiR modułu jak na stronie. Logika: `lib/api/mobile/ksiegowosc-ksiegi.ts`. */
export async function GET(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await ledgerForMobile(caller, request);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
