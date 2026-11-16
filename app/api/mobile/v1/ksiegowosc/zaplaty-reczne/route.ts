import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { manualPaymentFromMobile } from '@/lib/api/mobile/ksiegowosc-vat';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/** `POST /api/mobile/v1/ksiegowosc/zaplaty-reczne` (M10d): zapłata spoza wyliczenia tą samą funkcją co strona. Logika: `lib/api/mobile/ksiegowosc-vat.ts`. */
export async function POST(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await manualPaymentFromMobile(caller, request);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
