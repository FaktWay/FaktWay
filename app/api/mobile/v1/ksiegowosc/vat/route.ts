import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { vatForMobile } from '@/lib/api/mobile/ksiegowosc-vat';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/** `GET /api/mobile/v1/ksiegowosc/vat?miesiac=RRRR-MM&nadwyzka=N` (M10d): ekran VAT jak na stronie. Logika: `lib/api/mobile/ksiegowosc-vat.ts`. */
export async function GET(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await vatForMobile(caller, request);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
