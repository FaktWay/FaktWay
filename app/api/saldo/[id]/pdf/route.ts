import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';

import { loadCompanyPdfLogo } from '@/lib/pdf/logo-odczyt';
import { getBalanceConfirmation } from '@/lib/saldo/baza';
import { balancePdfFilename, renderBalancePdf } from '@/lib/saldo/pdf';
import { resolveApiUserAndActiveOrg } from '@/lib/supabase/auth-context';
import { createClient } from '@/lib/supabase/server';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/saldo/[id]/pdf: PDF wystawionego potwierdzenia salda (krok 2.9,
 * część 2). Firma ze zweryfikowanego członkostwa (`resolveApiUserAndActiveOrg`),
 * dokument czyta klient z sesji, więc RLS 00215 i filtr `tenant_id` dają „nie
 * znaleziono” dla dokumentu innej firmy. PDF powstaje za każdym razem
 * z migawki dokumentu: wystawionego nie zmienia nikt, a plik jest powtarzalny.
 * Pobranie już wystawionego dokumentu działa także przy zdjętym wyłączniku.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!UUID_SHAPE.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const ctx = await resolveApiUserAndActiveOrg();
  if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });

  try {
    const supabase = await createClient();
    const doc = await getBalanceConfirmation(supabase, ctx.tenantId, id);
    if (!doc) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    // Logo firmy z ustawień (krok 2.2); bez pliku albo przy błędzie PDF bez logo.
    const { logo } = await loadCompanyPdfLogo(ctx.tenantId);
    const pdf = await renderBalancePdf(doc, { logo });
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${balancePdfFilename(doc.number)}"`,
        // Dokument z danymi kontrahenta: bez pamięci podręcznej przeglądarki.
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    Sentry.captureException(err, { tags: { route: 'saldo/pdf' } });
    return NextResponse.json({ error: 'pdf_generation_failed' }, { status: 500 });
  }
}
