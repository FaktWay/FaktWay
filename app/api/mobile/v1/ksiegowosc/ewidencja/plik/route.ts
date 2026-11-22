import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { ledgerFileFromMobile } from '@/lib/api/mobile/ksiegowosc-ksiegi';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/** `POST /api/mobile/v1/ksiegowosc/ewidencja/plik` (M10d): ten sam plik JPK_EWP albo JPK_PKPIR co „Pobierz” na stronie. Logika: `lib/api/mobile/ksiegowosc-ksiegi.ts`. */
export async function POST(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await ledgerFileFromMobile(caller, request);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
