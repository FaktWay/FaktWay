import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { gusLookupFromMobile } from '@/lib/api/mobile/faktury-rodzaje';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/mobile/v1/gus/{nip}` (M8b): nazwa i adres nabywcy po NIP z kontrahentów
 * firmy albo z GUS, jak „Pobierz z GUS” w formularzu strony (`lib/invoices/lookup-buyer.ts`).
 */
export async function GET(request: Request, { params }: { params: Promise<{ nip: string }> }) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;

  try {
    const { nip } = await params;
    return await gusLookupFromMobile(caller, decodeURIComponent(nip));
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
