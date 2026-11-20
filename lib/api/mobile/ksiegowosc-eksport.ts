import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { NextResponse } from 'next/server';
import { z } from 'zod';

import { describeExportPeriod } from '@/components/exports/export-period';
import { friendlyStartError } from '@/components/exports/export-fixes';
import {
  ENABLED_EXPORT_FORMATS,
  FORMAT_LABELS,
  FORMAT_PURPOSE,
  formatFileSize,
  formatLabel,
  includesFor,
  suspendedFormatsSummary,
  type EnabledExportFormat,
  type ManualExportJobWithFiles,
} from '@/components/exports/export-formats';
import type { MobileCaller } from '@/lib/api/mobile/auth';
import type { EksportPlikOdpowiedz, EksportStartOdpowiedz, EksportTelefonuOdpowiedz, ZadanieEksportuTelefonu } from '@/lib/api/mobile/kontrakt-ksiegi';
import { MobileUpstreamError, mobileError, mobileJson } from '@/lib/api/mobile/responses';
import { readJsonBody } from '@/lib/api/mobile/tresc';
import { downloadExportFile, startManualExport, type KontekstEksportu } from '@/lib/exports/eksport-reczny';
import { readTenantTaxOffice } from '@/lib/exports/tax-office';
import { monthRange, shiftMonth } from '@/lib/expenses/month';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { countLabel } from '@/lib/i18n/plural';
import { isUuid } from '@/lib/supabase/active-org';

/**
 * Ręczny eksport z telefonu, M10d część 2 (plan aplikacji mobilnej): lista
 * formatów i historia jak strona `reports/exports` (te same formaty
 * `ENABLED_EXPORT_FORMATS`, ten sam odczyt 20 ostatnich ręcznych jobów), start
 * tą samą funkcją co `startExportAction` (`startManualExport`, zakres z reguły
 * formatu FIR-01 przez `includesFor`) i pobranie gotowego pliku tą samą funkcją
 * co `downloadExportFileAction` (`downloadExportFile`). Klient z tokenem
 * telefonu w jego firmie (RLS); każdy członek firmy, jak akcje strony.
 *
 * Telefon wybiera format i miesiąc; domyślne pola formularza strony
 * (faktury wystawione i korekty, bez otrzymanych) bez zmian. Okres kwartalny
 * i dowolny zostają na stronie.
 *
 * Ponowienie: start bez klucza, jak na stronie: drugi start to drugi job
 * (widać go w historii); job bez wysłanego zdarzenia jest od razu usuwany.
 * Pobranie nie zmienia danych poza licznikiem pobrań (RPC atomowy).
 */

type Db = SupabaseClient;

const MIESIAC = /^20\d{2}-(0[1-9]|1[0-2])$/;
const MAX_BODY_BYTES = 2_000;
const POZA_KONTRAKTEM = 'Treść żądania nie pasuje do kontraktu. Zaktualizuj aplikację FaktWay.';
const BRAK_URZEDU = 'Najpierw ustaw urząd skarbowy. Urząd ustawia się w Ustawieniach, w części Księgowa.';
/** Ile miesięcy do wyboru wstecz (miesiąc bieżący i 11 poprzednich). */
const MIESIECY = 12;

/** Nazwy stanów jak `STATUS_MAP` historii strony (komponent kliencki, więc tu osobno). */
const NAZWY_STANOW: Readonly<Record<string, string>> = {
  completed: 'Gotowe',
  empty: 'Pusty',
  failed: 'Błąd',
  generating: 'Generowanie',
  pending: 'Oczekuje',
  expired: 'Wygasłe',
};

function orgOf(caller: MobileCaller): NonNullable<MobileCaller['org']> {
  if (!caller.org) throw new Error('Trasa eksportu bez firmy (org: required)');
  return caller.org;
}

interface WierszJobu {
  id: string;
  format: string;
  status: string;
  period_start: string;
  period_end: string;
  created_at: string;
  invoices_count: number | null;
  error_message: string | null;
  progress_message: string | null;
  export_files: Array<{ id: string; filename: string; size_bytes: number | null }> | null;
}

/** Zadanie historii jak wiersz `export-history.tsx`: stan „Pusty”, podsumowanie i notatka z tych samych reguł. */
function zadanie(j: WierszJobu): ZadanieEksportuTelefonu {
  const plik = j.export_files?.[0];
  const stan = j.status === 'completed' && !plik ? 'empty' : j.status;
  const czesci: string[] = [];
  if (j.status === 'completed' && j.format !== 'kpir_excel') czesci.push(countLabel(j.invoices_count ?? 0, ['faktura', 'faktury', 'faktur']));
  const rozmiar = formatFileSize(plik?.size_bytes);
  if (rozmiar) czesci.push(rozmiar);
  const notatka =
    j.status === 'failed' && j.error_message
      ? { tekst: j.error_message, blad: true }
      : stan === 'empty'
        ? { tekst: j.progress_message ?? 'Brak dokumentów w tym okresie', blad: false }
        : null;
  return {
    id: j.id,
    nazwaFormatu: formatLabel(j.format),
    okres: describeExportPeriod(j.period_start, j.period_end),
    stan,
    stanNazwa: NAZWY_STANOW[stan] ?? 'Inny stan',
    podsumowanie: czesci.length > 0 ? czesci.join(' · ') : null,
    notatka,
    plik: stan === 'completed' && plik ? { id: plik.id, nazwa: plik.filename } : null,
    utworzonoO: j.created_at,
  };
}

/** `GET /api/mobile/v1/eksport`. */
export async function exportsForMobile(caller: MobileCaller): Promise<NextResponse> {
  const headers = caller.headers;
  const org = orgOf(caller);
  const db = caller.db as Db;
  const dzis = todayInWarsaw();

  const [urzad, historia] = await Promise.all([
    readTenantTaxOffice(db, org.tenantId).then(
      (kod) => kod !== null,
      () => null,
    ),
    db
      .from('export_jobs')
      .select('*, export_files(id, filename, format, size_bytes, download_count)')
      .eq('tenant_id', org.tenantId)
      .eq('trigger_source', 'manual')
      .order('created_at', { ascending: false })
      .limit(20),
  ]);
  // Jak strona: błąd historii to nie pusta lista (klient myślałby, że eksportów nie ma).
  if (historia.error) throw new MobileUpstreamError('ksiegowosc.eksport.historia');
  const wstrzymane = suspendedFormatsSummary();

  const odpowiedz: EksportTelefonuOdpowiedz = {
    formaty: ENABLED_EXPORT_FORMATS.map((f) => ({ format: f, nazwa: FORMAT_LABELS[f], opis: FORMAT_PURPOSE[f] })),
    miesiac: shiftMonth(dzis.slice(0, 7), -1),
    miesiace: Array.from({ length: MIESIECY }, (_, i) => shiftMonth(dzis.slice(0, 7), -i)),
    urzadUstawiony: urzad,
    wstrzymane: wstrzymane ? `Wstrzymane formaty: ${wstrzymane}.` : null,
    historia: ((historia.data ?? []) as unknown as ManualExportJobWithFiles[] as unknown as WierszJobu[]).map(zadanie),
  };
  return mobileJson(odpowiedz, 200, headers);
}

const startSchema = z.object({ format: z.enum(['kpir_excel', 'csv_universal', 'jpk_fa']), miesiac: z.string() }).strict();

/** `POST /api/mobile/v1/eksport`. */
export async function startExportFromMobile(caller: MobileCaller, request: Request): Promise<NextResponse> {
  const headers = caller.headers;
  const org = orgOf(caller);
  const db = caller.db as Db;
  const raw = await readJsonBody(request, headers, { maxBytes: MAX_BODY_BYTES, tooLarge: 'Treść jest za długa.' });
  if (!raw.ok) return raw.response;
  const parsed = startSchema.safeParse(raw.value);
  if (!parsed.success || !MIESIAC.test(parsed.data.miesiac)) return mobileError(400, 'invalid_request', POZA_KONTRAKTEM, headers);
  const format: EnabledExportFormat = parsed.data.format;
  // Jak strona: JPK_FA bez urzędu skarbowego i tak odmówi, więc nie zlecamy (odczyt, który się nie udał, niczego nie blokuje).
  if (format === 'jpk_fa') {
    const urzad = await readTenantTaxOffice(db, org.tenantId).then(
      (kod) => kod !== null,
      () => undefined,
    );
    if (urzad === false) return mobileError(422, 'export_refused', BRAK_URZEDU, headers);
  }
  const { from, to } = monthRange(parsed.data.miesiac);
  const wynik = await startManualExport(
    { client: caller.db as unknown as KontekstEksportu['client'], tenantId: org.tenantId, userId: caller.user.id },
    // Pola formularza strony po domyślnych: faktury wystawione i korekty, bez otrzymanych; zakres wg reguły formatu.
    { format, periodStart: from, periodEnd: to, ...includesFor(format, { csv: { issued: true, received: false, corrections: true }, jpkCorrections: true }) },
  );
  if (!wynik.success) return mobileError(422, 'export_refused', friendlyStartError(wynik.error), headers);
  const odpowiedz: EksportStartOdpowiedz = { jobId: wynik.jobId };
  return mobileJson(odpowiedz, 201, headers);
}

/** `GET /api/mobile/v1/eksport/pliki/{id}`. */
export async function exportFileForMobile(caller: MobileCaller, id: string): Promise<NextResponse> {
  const headers = caller.headers;
  const org = orgOf(caller);
  if (!isUuid(id)) return mobileError(404, 'not_found', 'Tego pliku nie ma w historii. Odśwież listę eksportów.', headers);
  const wynik = await downloadExportFile(
    { client: caller.db as unknown as KontekstEksportu['client'], tenantId: org.tenantId, userId: caller.user.id },
    id.toLowerCase(),
  );
  if (!wynik.success) {
    if (wynik.error === 'Plik nie znaleziony') return mobileError(404, 'not_found', 'Tego pliku nie ma w historii. Odśwież listę eksportów.', headers);
    if (wynik.error === 'Plik nie jest gotowy') return mobileError(422, 'export_refused', 'Plik nie jest jeszcze gotowy. Odśwież listę eksportów za chwilę.', headers);
    // Błąd magazynu: telefon ponawia.
    throw new MobileUpstreamError('ksiegowosc.eksport.plik');
  }
  const odpowiedz: EksportPlikOdpowiedz = { nazwa: wynik.filename, mimeType: wynik.mimeType, base64: wynik.base64 };
  return mobileJson(odpowiedz, 200, headers);
}
