import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { analyticsForMobile } from '@/lib/api/mobile/analizy';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/** `GET /api/mobile/v1/analizy?widok=sprzedaz|koszty&miesiac=RRRR-MM` (M10e): karty stron `/analizy/*`. Logika: `lib/api/mobile/analizy.ts`. */
export async function GET(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await analyticsForMobile(caller, request);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
