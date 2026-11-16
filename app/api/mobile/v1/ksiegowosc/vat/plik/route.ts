import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { vatFileFromMobile } from '@/lib/api/mobile/ksiegowosc-vat';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/** `POST /api/mobile/v1/ksiegowosc/vat/plik` (M10d): ten sam plik JPK_V7M co „Pobierz” na stronie. Logika: `lib/api/mobile/ksiegowosc-vat.ts`. */
export async function POST(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await vatFileFromMobile(caller, request);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
