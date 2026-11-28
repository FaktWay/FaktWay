import 'server-only';

import { createHash } from 'node:crypto';

import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { logAudit } from '@/lib/audit/log';
import {
  czyPdf,
  PDF_SPOZA_KSEF_LIMIT_BYTES,
  PDF_SPOZA_KSEF_LIMIT_LABEL,
} from '@/lib/import/outside-ksef-pdf';
import { czySpozaKsefWlaczone, SPOZA_KSEF_NIEZNANE, SPOZA_KSEF_WYLACZONE } from '@/lib/import/outside-ksef-wylacznik';
import { getR2Client, getR2Config } from '@/lib/storage/r2-client';
import { uploadRequestOptions } from '@/lib/storage/s3-timeouts';
import { assertTenantStoragePath, isTenantStoragePath } from '@/lib/storage/tenant-path';
import { createAdminClient } from '@/lib/supabase/admin';
import { formatUploadSize } from '@/lib/upload-limit';

/**
 * Oryginał PDF faktury wystawionej poza KSeF (krok 1.6, część 2b, PR D;
 * D25 b i D40): plik zostaje przy wpisie, ma okres przechowywania faktury
 * (kasuje go retencja razem z wierszem, `lib/retention/invoice-files.ts`,
 * i usunięcie wpisu, `usunFakturaSpozaKsef`) i trafia do archiwum ZIP
 * (`lib/archiwum/paczka.ts`). Wgrywa się go PO zapisie faktury: nie ma więc
 * plików bez wpisu, a wpis bez pliku jest poprawnym stanem (klient mógł
 * wpisać fakturę ręcznie albo wgranie się nie udało i powtarza je).
 *
 * Klucz jest stały dla faktury (`tenants/<firma>/outside-ksef/<faktura>.pdf`).
 * Ponowienie od zera: wgranie drugi raz nadpisuje ten sam obiekt i te same
 * kolumny, więc nie rozmnaża plików. Kolejność kroków: magazyn, potem
 * wskaźnik w wierszu, potem audyt; gdy wskaźnika nie udało się zapisać, świeży
 * plik jest kasowany (bez sierot), a klient może wgrać go jeszcze raz.
 * Wskaźnik zapisujemy kluczem serwisowym (jak pamięć podręczna wydruku
 * `pdf_storage_path`), po sprawdzeniu przez klienta sesji (RLS), że faktura
 * jest wpisem spoza KSeF tej firmy; rolę sprawdza wywołujący.
 */

export type WynikOryginalu = { success: true } | { success: false; status: number; error: string };

export const BLAD_ORYGINALU =
  'Faktura jest zapisana, ale nie udało się zapisać jej oryginału PDF. Wgraj plik jeszcze raz; jeśli to się powtórzy, napisz do nas w Pomocy.';

export function kluczOryginaluSpozaKsef(tenantId: string, invoiceId: string): string {
  return `tenants/${tenantId}/outside-ksef/${invoiceId}.pdf`;
}

export async function dolaczOryginalSpozaKsef(
  ctx: { client: SupabaseClient; tenantId: string; userId: string },
  invoiceId: string,
  file: File,
): Promise<WynikOryginalu> {
  try {
    if (!(await czySpozaKsefWlaczone())) return { success: false, status: 403, error: SPOZA_KSEF_WYLACZONE };
  } catch {
    return { success: false, status: 503, error: SPOZA_KSEF_NIEZNANE };
  }
  if (!z.string().uuid().safeParse(invoiceId).success) {
    return { success: false, status: 400, error: 'Nie wiadomo, do której faktury dołączyć plik.' };
  }
  if (!czyPdf(new Uint8Array(await file.slice(0, 8).arrayBuffer()))) {
    return { success: false, status: 400, error: 'To nie jest plik PDF, więc go nie zapisaliśmy.' };
  }
  if (file.size > PDF_SPOZA_KSEF_LIMIT_BYTES) {
    return {
      success: false,
      status: 413,
      error: `PDF ma ${formatUploadSize(file.size)}, a można zapisać najwyżej ${PDF_SPOZA_KSEF_LIMIT_LABEL}.`,
    };
  }

  const { data: faktura, error: odczyt } = await ctx.client
    .from('invoices')
    .select('id, internal_number, outside_ksef_original_path')
    .eq('id', invoiceId)
    .eq('tenant_id', ctx.tenantId)
    .eq('origin', 'outside_ksef')
    .maybeSingle();
  if (odczyt) return { success: false, status: 500, error: BLAD_ORYGINALU };
  if (!faktura) return { success: false, status: 404, error: 'Tej faktury nie ma w historii wpisów spoza KSeF.' };
  const { internal_number: numer, outside_ksef_original_path: poprzedni } = faktura as {
    internal_number: string | null;
    outside_ksef_original_path?: string | null;
  };

  const bajty = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash('sha256').update(bajty).digest('hex');
  const klucz = kluczOryginaluSpozaKsef(ctx.tenantId, invoiceId);

  const { bucketName } = getR2Config();
  const s3 = getR2Client();
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: klucz,
        Body: bajty,
        ContentType: 'application/pdf',
        CacheControl: 'private, no-store',
      }),
      uploadRequestOptions(bajty.length),
    );
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'outside-ksef.original-put' } });
    return { success: false, status: 500, error: BLAD_ORYGINALU };
  }

  const { data: zmienione, error: zapis } = await createAdminClient()
    .from('invoices')
    .update({ outside_ksef_original_path: klucz, outside_ksef_original_sha256: sha256, outside_ksef_original_size: bajty.length })
    .eq('id', invoiceId)
    .eq('tenant_id', ctx.tenantId)
    .eq('origin', 'outside_ksef')
    .select('id');
  if (zapis || !zmienione || zmienione.length === 0) {
    // Świeży plik kasujemy tylko wtedy, gdy wiersz nie wskazywał wcześniej tego samego klucza (zamiana pliku nie może zostawić wskaźnika w próżnię).
    if (!poprzedni) await usunOryginalSpozaKsef(ctx.tenantId, klucz);
    return { success: false, status: zapis ? 500 : 404, error: zapis ? BLAD_ORYGINALU : 'Tej faktury nie ma już w historii.' };
  }

  await logAudit({
    action: 'invoice.outside_ksef_original_saved',
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    entityType: 'invoice',
    entityId: invoiceId,
    metadata: { number: numer, sizeBytes: bajty.length, sha256 },
  });
  revalidatePath(`/invoices/${invoiceId}`);
  return { success: true };
}

/** Odczyt oryginału do paczki ZIP. Brak obiektu rzuca (wywołujący zamienia to na wpis w spisie braków). */
export async function pobierzOryginalSpozaKsef(tenantId: string, klucz: string): Promise<Buffer> {
  assertTenantStoragePath(klucz, tenantId);
  const { bucketName } = getR2Config();
  const wynik = await getR2Client().send(new GetObjectCommand({ Bucket: bucketName, Key: klucz }));
  if (!wynik.Body) throw Object.assign(new Error('Pusty obiekt oryginału'), { name: 'NoSuchKey' });
  return Buffer.from(await (wynik.Body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray());
}

/**
 * Kasuje obiekt oryginału. `false`, gdy klucz nie leży w katalogu firmy albo
 * magazyn odmówił; wywołujący zgłasza to do audytu, a nie przerywa usunięcia wpisu.
 */
export async function usunOryginalSpozaKsef(tenantId: string, klucz: string): Promise<boolean> {
  if (!isTenantStoragePath(klucz, tenantId)) return false;
  try {
    const { bucketName } = getR2Config();
    await getR2Client().send(new DeleteObjectCommand({ Bucket: bucketName, Key: klucz }));
    return true;
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'outside-ksef.original-delete' }, extra: { tenantId } });
    return false;
  }
}
