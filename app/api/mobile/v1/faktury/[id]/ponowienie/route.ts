import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { resendFromMobile } from '@/lib/api/mobile/faktury-rodzaje';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/**
 * `POST /api/mobile/v1/faktury/{id}/ponowienie` (M8b): „Wyślij ponownie” po błędzie
 * wysyłki do KSeF, ta sama funkcja co przycisk strony (`lib/invoices/ksef-resend.ts`).
 * Faktura już w kolejce daje 200, nic nie idzie drugi raz.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;

  try {
    const { id } = await params;
    return await resendFromMobile(caller, id);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
