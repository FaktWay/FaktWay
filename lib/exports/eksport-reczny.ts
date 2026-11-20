import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';

import { exportIncludesFor } from '@/lib/exports/export-scope';
import { isExportFormatSuspended, SUSPENDED_EXPORT_FORMATS } from '@/lib/exports/suspended-formats';
import { sendJobEvent } from '@/lib/jobs/enqueue';
import { formatJobSendError } from '@/lib/jobs/error-message';
import { exportsGenerateRequested } from '@/lib/jobs/events';
import { downloadFromR2 } from '@/lib/storage/r2';
import type { Database } from '@/types/database';

/**
 * Ręczny eksport (zakładka „Eksport” Księgowości): start joba i pobranie
 * gotowego pliku, wspólne dla akcji strony (`app/actions/exports.ts`, sesja z
 * ciasteczek) i telefonu (`/api/mobile/v1/eksport`, M10d, sesja z
 * tokenu). Kod przeniesiony z akcji bez zmian. Klient to klient sesji klienta
 * (RLS), a każde zapytanie ma też `tenant_id` (obrona w głąb).
 *
 * Ponowienie: start bez klucza, jak na stronie; drugi start to drugi job (widać
 * go w historii). Job bez wysłanego zdarzenia jest od razu usuwany. Pobranie
 * nie zmienia danych poza licznikiem pobrań.
 */

export interface KontekstEksportu {
  client: SupabaseClient<Database>;
  tenantId: string;
  userId: string;
}

export interface ParametryEksportu {
  format: string;
  periodStart: string;
  periodEnd: string;
  includeIssued?: boolean;
  includeReceived?: boolean;
  includeCorrections?: boolean;
}

// `jpk_v7m` doszło migracją 00056; `types/database.ts` regenerujemy przed
// Fazą 35, więc lista jest jawna (nie z `export_format_enum`).
export const EXPORT_FORMATS: string[] = [
  'jpk_fa',
  'jpk_v7m',
  'kpir_excel',
  'comarch_optima',
  'insert_subiekt',
  'symfonia',
  'wapro',
  'csv_universal',
];

export function isExportDbFormat(
  v: string,
): v is Database['public']['Enums']['export_format_enum'] {
  return EXPORT_FORMATS.includes(v);
}

type ExportFileJobRel = Pick<
  Database['public']['Tables']['export_jobs']['Row'],
  'status'
>;

/** Ręczny eksport: format, zakres z reguły formatu, job i zdarzenie dla workera; rola: każdy członek firmy (jak akcja strony). */
export async function startManualExport(
  ctx: KontekstEksportu,
  params: ParametryEksportu,
): Promise<{ success: true; jobId: string } | { success: false; error: string }> {
  const { client: supabase, userId, tenantId } = ctx;
  const user = { id: userId };

  if (!isExportDbFormat(params.format)) {
    return { success: false, error: 'Nieobsługiwany format eksportu' };
  }
  // Przed zapisem joba: wstrzymany format nie może powstać także z pominięciem
  // interfejsu.
  if (isExportFormatSuspended(params.format)) {
    return { success: false, error: SUSPENDED_EXPORT_FORMATS[params.format]! };
  }

  const startDay = params.periodStart.trim().slice(0, 10);
  const endDay = params.periodEnd.trim().slice(0, 10);
  const dateRx = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRx.test(startDay) || !dateRx.test(endDay)) {
    return { success: false, error: 'Niepoprawny format dat (YYYY-MM-DD)' };
  }
  if (endDay < startDay) {
    return { success: false, error: 'Data końcowa < początkowa' };
  }

  // Zakres z reguły formatu (FIR-01) — nie wprost z tego, co przysłał klient.
  const scope = exportIncludesFor(params.format, params);

  const { data: job, error } = await supabase
    .from('export_jobs')
    .insert({
      tenant_id: tenantId,
      triggered_by: user.id,
      format: params.format,
      trigger_source: 'manual',
      period_start: startDay,
      period_end: endDay,
      include_issued: scope.includeIssued,
      include_received: scope.includeReceived,
      include_corrections: scope.includeCorrections,
      status: 'pending',
    })
    .select('id')
    .single();

  if (error || !job) {
    return { success: false, error: error?.message ?? 'Błąd tworzenia jobu' };
  }

  try {
    await sendJobEvent(
      exportsGenerateRequested.create({ exportJobId: job.id }),
    );
  } catch (e) {
    // Cleanup z `tenant_id` jako defense-in-depth — nawet jeśli RLS by zawiodł,
    // nie usuniemy joba innego tenanta.
    await supabase
      .from('export_jobs')
      .delete()
      .eq('id', job.id)
      .eq('tenant_id', tenantId);
    return { success: false, error: formatJobSendError(e) };
  }

  revalidatePath('/dashboard');
  revalidatePath('/reports/exports');
  return { success: true, jobId: job.id };
}

/** Pobranie pliku gotowego eksportu (Base64); licznik pobrań atomowo w RPC. */
export async function downloadExportFile(
  ctx: KontekstEksportu,
  fileId: string,
): Promise<{ success: true; base64: string; filename: string; mimeType: string } | { success: false; error: string }> {
  const { client: supabase, userId, tenantId } = ctx;
  const user = { id: userId };

  // `.eq('tenant_id', tenantId)` jako defense-in-depth obok RLS:
  // pojedyncza linia chroni przed pobraniem cudzego pliku, nawet
  // jeśli polityka RLS zostanie kiedyś zmieniona / zawiedzie.
  const { data: fileRow, error: fileErr } = await supabase
    .from('export_files')
    .select(
      `
      *,
      export_jobs(status)
      `,
    )
    .eq('id', fileId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (fileErr || !fileRow) {
    return { success: false, error: 'Plik nie znaleziony' };
  }

  type FileWithJob = Database['public']['Tables']['export_files']['Row'] & {
    export_jobs: ExportFileJobRel | ExportFileJobRel[] | null;
  };
  const file = fileRow as FileWithJob;
  const relation = file.export_jobs;
  const jobStatus =
    Array.isArray(relation) ? relation[0]?.status : relation?.status;

  if (jobStatus !== 'completed') {
    return { success: false, error: 'Plik nie jest gotowy' };
  }

  try {
    const buffer = await downloadFromR2(file.r2_path, tenantId);

    // Atomowy increment przez RPC `increment_export_file_download` (00030).
    //
    // PRZED: read-then-write race — dwa równoległe pobrania odczytywały tę samą
    // wartość download_count i nadpisywały się nawzajem (utracony increment).
    // PO: jedno UPDATE w bazie, atomowe na poziomie wiersza Postgresa.
    // Funkcja sama waliduje `tenant_id = get_current_tenant_id()` w WHERE,
    // więc service-side nie ma jak pomylić tenanta — defense-in-depth.
    const { error: rpcError } = await supabase.rpc(
      'increment_export_file_download',
      { p_file_id: fileId, p_user_id: user.id },
    );
    if (rpcError) {
      // Increment licznika to nie blocker dla samego pobrania — logujemy,
      // ale nie wywalamy responsu klienta (plik jest już w buforze).
      console.error('[downloadExportFile] increment failed', rpcError);
    }

    return {
      success: true,
      base64: buffer.toString('base64'),
      filename: file.filename,
      mimeType: file.mime_type,
    };
  } catch {
    return { success: false, error: 'Błąd pobierania z storage' };
  }
}
