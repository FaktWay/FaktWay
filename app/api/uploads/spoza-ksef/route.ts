import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

import { dolaczOryginalSpozaKsef } from '@/lib/import/outside-ksef-oryginal';
import { odczytajPdfSpozaKsef } from '@/lib/import/outside-ksef-pdf-odczyt';
import { UPLOAD_FAILED_MESSAGE } from '@/lib/upload-limit';
import {
  authorizeUpload,
  checkUploadHeaders,
  checkUploadRate,
  isServerSideRefusal,
  logUploadRefusal,
  readUploadForm,
  refusalJson,
  reserveUploadBytes,
  uploadCaller,
  uploadJson,
  type UploadRefusal,
} from '@/lib/uploads/server';

export const dynamic = 'force-dynamic';

const ROUTE = '/api/uploads/spoza-ksef';

const ROLE_MESSAGE = 'Faktury wystawione poza KSeF dopisuje właściciel albo administrator firmy.';

/**
 * POST /api/uploads/spoza-ksef: PDF faktury wystawionej poza KSeF (krok 1.6,
 * część 2b, PR D; D25 a i b, D40). Dwa tryby w polu `tryb`, plik w polu `plik`:
 *  - `odczyt`: odczyt PDF modelem, odpowiedź `{ success: true, wypelnienie }`
 *    (tylko wypełnia formularz, nic nie zapisuje, ten sam limit AI co koszty);
 *  - `oryginal` (z polem `invoiceId`): zapis oryginału przy już dopisanej
 *    fakturze, odpowiedź `{ success: true }`.
 * Błąd to `{ success: false, error }` z komunikatem z wyjściem.
 *
 * Trasa jest poza proxy (`proxy.ts`, AGENTS.md, niezmiennik 7), więc bramka
 * (`lib/uploads/server.ts`) sama sprawdza Origin, rozmiar przed odczytem
 * ciała, sesję, 2FA, firmę, przerwę techniczną, limit wgrań, wgrania naraz
 * i budżet bajtów. Rola (właściciel, administrator) i wyłącznik
 * `outsideKsefImportEnabled` przed zapisem i przed odczytem modelem.
 */
export async function POST(req: Request): Promise<Response> {
  let refund: (() => Promise<void>) | null = null;
  const refused = async (refusal: UploadRefusal) => {
    if (refund && isServerSideRefusal(refusal)) await refund();
    logUploadRefusal(ROUTE, refusal);
    return refusalJson(refusal);
  };

  const headers = checkUploadHeaders(req, { checkOrigin: true });
  if (!headers.ok) return refused(headers);

  try {
    const auth = await authorizeUpload({ maintenanceGate: true });
    if (!auth.ok) return refused(auth);
    if (auth.ctx.role !== 'owner' && auth.ctx.role !== 'admin') {
      return refused({ ok: false, status: 403, reason: 'forbidden', error: ROLE_MESSAGE });
    }
    const rate = await checkUploadRate('outside_ksef', auth.ctx);
    if (!rate.ok) return refused(rate);
    refund = rate.refund;

    const slot = reserveUploadBytes(headers.contentLength, uploadCaller(auth.ctx));
    if (!slot.ok) return refused(slot);
    try {
      const body = await readUploadForm(req, headers.contentLength);
      if (!body.ok) return refused(body);

      const file = body.form.get('plik');
      if (!(file instanceof File)) return uploadJson({ success: false, error: 'Brak pliku' }, 400);
      const tryb = body.form.get('tryb');

      if (tryb === 'odczyt') {
        const wynik = await odczytajPdfSpozaKsef({ tenantId: auth.ctx.tenantId, file });
        if (!wynik.success) {
          if (wynik.status >= 500) await refund();
          return uploadJson({ success: false, error: wynik.error }, wynik.status);
        }
        return uploadJson({ success: true, wypelnienie: wynik.wypelnienie }, 200);
      }

      if (tryb === 'oryginal') {
        const invoiceId = body.form.get('invoiceId');
        const wynik = await dolaczOryginalSpozaKsef(
          { client: auth.ctx.supabase as unknown as SupabaseClient, tenantId: auth.ctx.tenantId, userId: auth.ctx.user.id },
          typeof invoiceId === 'string' ? invoiceId : '',
          file,
        );
        if (!wynik.success) {
          if (wynik.status >= 500) await refund();
          return uploadJson({ success: false, error: wynik.error }, wynik.status);
        }
        return uploadJson({ success: true }, 200);
      }

      return uploadJson({ success: false, error: 'Nieznany rodzaj wgrania.' }, 400);
    } finally {
      slot.release();
    }
  } catch (error) {
    await refund?.();
    Sentry.captureException(error, { tags: { route: ROUTE } });
    return uploadJson({ success: false, error: UPLOAD_FAILED_MESSAGE }, 500);
  }
}
