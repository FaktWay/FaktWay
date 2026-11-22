import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { kpirReportForMobile } from '@/lib/api/mobile/ksiegowosc-ksiegi';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/** `GET /api/mobile/v1/raport-kpir?miesiac=RRRR-MM` (M10d): KPiR raportu jak na stronie. Logika: `lib/api/mobile/ksiegowosc-ksiegi.ts`. */
export async function GET(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await kpirReportForMobile(caller, request);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
