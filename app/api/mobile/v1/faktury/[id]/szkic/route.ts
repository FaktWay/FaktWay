import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { resetToDraftFromMobile } from '@/lib/api/mobile/faktury-rodzaje';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/**
 * `POST /api/mobile/v1/faktury/{id}/szkic` (M8b): „Wróć do szkicu” po błędzie wysyłki
 * albo odrzuceniu przez KSeF, jak na stronie (RPC `reset_ksef_send`, właściciel
 * albo administrator). Faktura już szkicem daje 200.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;

  try {
    const { id } = await params;
    return await resetToDraftFromMobile(caller, id);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
