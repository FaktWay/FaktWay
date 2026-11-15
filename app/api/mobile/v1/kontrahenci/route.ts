import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { contractorsForMobile, createContractorForMobile } from '@/lib/api/mobile/kontrahenci';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/** `GET /api/mobile/v1/kontrahenci?q=` (M10e): lista, kafle i należności jak `/contractors`. Logika: `lib/api/mobile/kontrahenci.ts`. */
export async function GET(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await contractorsForMobile(caller, request);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}

/** `POST /api/mobile/v1/kontrahenci` (M10e): nowy kontrahent z NIP; ponowienie z tymi samymi danymi oddaje istniejącego. */
export async function POST(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await createContractorForMobile(caller, request);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
