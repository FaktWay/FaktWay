import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { correctionContextFromMobile } from '@/lib/api/mobile/faktury-rodzaje';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/mobile/v1/faktury/{id}/korekta` (M8b): faktura pierwotna do korekty
 * (stan po przyjętych korektach, dozwolone typy, pozycje „przed”), jak kontekst
 * formularza korekty na stronie. Tylko odczyt tokenem klienta (RLS).
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;

  try {
    const { id } = await params;
    return await correctionContextFromMobile(caller, id);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
