import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { entryCreateFromMobile } from '@/lib/api/mobile/ksiegowosc-zapisy';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/** `POST /api/mobile/v1/ksiegowosc/ewidencja/wpisy` (M10d): wpis ręczny w ewidencji albo KPiR tą samą funkcją co strona. Logika: `lib/api/mobile/ksiegowosc-zapisy.ts`. */
export async function POST(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await entryCreateFromMobile(caller, request);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
