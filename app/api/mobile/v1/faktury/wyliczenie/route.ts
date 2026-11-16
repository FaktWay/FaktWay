import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { previewFromMobile } from '@/lib/api/mobile/faktury-rodzaje';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/**
 * `POST /api/mobile/v1/faktury/wyliczenie` (plan aplikacji mobilnej, M8b): kwoty
 * zaliczki, rozliczenia albo korekty policzone tymi samymi funkcjami co zapis
 * (telefon kwot nie liczy). Nic nie zapisuje. Logika: `lib/api/mobile/faktury-rodzaje.ts`.
 */
export async function POST(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;

  try {
    return await previewFromMobile(caller, request);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
