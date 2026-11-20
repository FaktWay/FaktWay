import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { exportsForMobile, startExportFromMobile } from '@/lib/api/mobile/ksiegowosc-eksport';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/** `GET /api/mobile/v1/eksport` (M10d): formaty i historia ręcznych eksportów jak na stronie. Logika: `lib/api/mobile/ksiegowosc-eksport.ts`. */
export async function GET(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await exportsForMobile(caller);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}

/** `POST /api/mobile/v1/eksport` (M10d): zlecenie eksportu tą samą funkcją co strona. */
export async function POST(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await startExportFromMobile(caller, request);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
