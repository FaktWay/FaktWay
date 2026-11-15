import { replacementForFormat } from '@/lib/exports/suspended-formats';
import type { Database } from '@/types/database';

/**
 * Formaty paczki Co-Pilota dla księgowej: wspólne dla wysyłki
 * (`lib/jobs/runners/co-pilot-monthly.ts`, przeniesione bez zmiany
 * zachowania) i karty „Księgowa” w aplikacji na telefon (M10e), która pokazuje,
 * co naprawdę wyjdzie, a nie surowy zapis ustawień.
 */

type ExportFormat = Database['public']['Enums']['export_format_enum'];

const VALID_FORMATS: readonly ExportFormat[] = [
  'jpk_fa',
  'kpir_excel',
  'comarch_optima',
  'insert_subiekt',
  'symfonia',
  'wapro',
  'csv_universal',
] as const;

function isExportFormat(v: string): v is ExportFormat {
  return (VALID_FORMATS as readonly string[]).includes(v);
}

/**
 * Formaty z ustawień paczki. Wstrzymany format (`suspended-formats.ts`)
 * zamienia się w to, co program księgowej naprawdę importuje (Symfonia,
 * Wapro → JPK_FA; reszta → uniwersalny CSV) — ustawienia zapisane przed
 * wstrzymaniem nie mogą wysłać pliku, którego program nie przyjmie. JPK_FA
 * przechodzi dalej przez bramki gotowości i w razie odmowy staje się CSV.
 */
export function parseFormats(formats: string[] | null | undefined): ExportFormat[] {
  return [
    ...new Set(
      (formats ?? [])
        .filter(isExportFormat)
        // Symfonia/Wapro → JPK_FA (to importują), reszta wstrzymanych → CSV.
        .map((f) => replacementForFormat(f)),
    ),
  ];
}

/**
 * Bez urzędu skarbowego firmy JPK_FA odmawia (#67) — w paczce zastępuje go
 * uniwersalny CSV, zamiast wywracać całą paczkę dla księgowej.
 */
export function formatsWithoutUnaddressedJpkFa<F extends string>(
  formats: readonly F[],
  taxOfficeCode: string | null,
): F[] {
  return taxOfficeCode ? [...formats] : formatsWithCsvInsteadOfJpkFa(formats);
}

/** JPK_FA → uniwersalny CSV (bez dubla, gdy CSV już jest w paczce). */
export function formatsWithCsvInsteadOfJpkFa<F extends string>(formats: readonly F[]): F[] {
  if (!formats.includes('jpk_fa' as F)) return [...formats];
  return [...new Set(formats.map((f) => (f === 'jpk_fa' ? ('csv_universal' as F) : f)))];
}
