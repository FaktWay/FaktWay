import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { deleteDraftFromMobile } from '@/lib/api/mobile/faktury-rodzaje';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/**
 * `POST /api/mobile/v1/faktury/{id}/usuniecie` (M8b): usunięcie szkicu, ta sama
 * funkcja co „Usuń szkic” na stronie (`lib/invoices/delete-draft.ts`). Faktury już
 * nie ma (ponowienie po zerwanym połączeniu): 200.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;

  try {
    const { id } = await params;
    return await deleteDraftFromMobile(caller, id);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
