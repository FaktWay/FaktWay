import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { mobileFailure } from '@/lib/api/mobile/responses';
import { saveCompanyFromMobile } from '@/lib/api/mobile/ustawienia-zapis';

export const dynamic = 'force-dynamic';

/**
 * `POST /api/mobile/v1/ustawienia/firma` (M10c): jedna zmiana karty Firma (dane, rachunek, data
 * rozpoczęcia, zwolnienie z VAT, metoda kasowa) tą samą logiką co strona. Logika: `lib/api/mobile/ustawienia-zapis.ts`.
 */
export async function POST(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await saveCompanyFromMobile(caller, request);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
