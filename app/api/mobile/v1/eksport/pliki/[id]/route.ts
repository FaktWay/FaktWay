import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { exportFileForMobile } from '@/lib/api/mobile/ksiegowosc-eksport';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/** `GET /api/mobile/v1/eksport/pliki/{id}` (M10d): gotowy plik eksportu w Base64. Logika: `lib/api/mobile/ksiegowosc-eksport.ts`. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    const { id } = await params;
    return await exportFileForMobile(caller, id);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
