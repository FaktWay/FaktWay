import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { inventoryDeleteFromMobile } from '@/lib/api/mobile/ksiegowosc-zapisy';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/** `POST /api/mobile/v1/ksiegowosc/ewidencja/spisy/{id}/usuniecie` (M10d): usunięcie spisu z natury. Logika: `lib/api/mobile/ksiegowosc-zapisy.ts`. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    const { id } = await params;
    return await inventoryDeleteFromMobile(caller, id);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
