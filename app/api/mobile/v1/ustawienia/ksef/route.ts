import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { mobileFailure } from '@/lib/api/mobile/responses';
import { uploadCertificateFromMobile } from '@/lib/api/mobile/ustawienia-ksef';

export const dynamic = 'force-dynamic';

/** `POST /api/mobile/v1/ustawienia/ksef`: wgranie certyfikatu KSeF (M10c, część 2b). Logika i warunki strony: `lib/api/mobile/ustawienia-ksef.ts`. */
export async function POST(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await uploadCertificateFromMobile(caller, request);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
