import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { importForMobile } from '@/lib/api/mobile/import';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/** `GET /api/mobile/v1/import` (M10e): Import danych do odczytu (kafle, historia z KSeF, historia importów). Logika: `lib/api/mobile/import.ts`. */
export async function GET(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await importForMobile(caller);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
