import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { deleteContractorForMobile } from '@/lib/api/mobile/kontrahenci';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/** `POST /api/mobile/v1/kontrahenci/{id}/usuniecie` (M10e): usunięcie z bazy podpowiedzi; wystawione faktury się nie zmieniają. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    const { id } = await params;
    return await deleteContractorForMobile(caller, id);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
