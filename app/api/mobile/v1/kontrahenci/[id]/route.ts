import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { contractorForMobile, updateContractorForMobile } from '@/lib/api/mobile/kontrahenci';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/** `GET /api/mobile/v1/kontrahenci/{id}` (M10e): karta kontrahenta z należnościami. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    const { id } = await params;
    return await contractorForMobile(caller, id);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}

/** `POST /api/mobile/v1/kontrahenci/{id}` (M10e): poprawka nazwy, adresu i e-maila, jak okno edycji strony. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    const { id } = await params;
    return await updateContractorForMobile(caller, request, id);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
