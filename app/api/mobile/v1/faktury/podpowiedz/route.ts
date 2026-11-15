import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { invoiceFormHint } from '@/lib/api/mobile/faktury';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/mobile/v1/faktury/podpowiedz` (M8): kolejny numer faktury, dziś
 * w Polsce i zwolnienie z VAT, czyli to, czym strona wypełnia pusty formularz.
 * Tylko odczyt tokenem klienta (RLS). Od M8b `?rodzaj=zaliczka|rozliczenie|korekta`
 * daje numer z serii tego dokumentu.
 */
export async function GET(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;

  try {
    return await invoiceFormHint(caller, new URL(request.url).searchParams.get('rodzaj'));
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
