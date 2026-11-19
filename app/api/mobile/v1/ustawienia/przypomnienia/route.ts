import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { mobileFailure } from '@/lib/api/mobile/responses';
import { saveRemindersFromMobile } from '@/lib/api/mobile/ustawienia-zapis';

export const dynamic = 'force-dynamic';

/** `POST /api/mobile/v1/ustawienia/przypomnienia` (M10c): formularz przypomnień o zapłacie strony. Logika: `lib/api/mobile/ustawienia-zapis.ts`. */
export async function POST(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await saveRemindersFromMobile(caller, request);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
