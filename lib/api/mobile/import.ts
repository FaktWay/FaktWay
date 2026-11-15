import 'server-only';

import type { NextResponse } from 'next/server';

import {
  completedSummary,
  failureNote,
  FILE_SOURCES,
  formatWarsawDay,
  IMPORT_HISTORY_COLUMNS,
  IMPORT_HISTORY_LIMIT,
  INTERRUPTED_LEGACY_NOTE,
  isInterruptedLegacyImport,
  jobStatusGroup,
  progressPercent,
  runningStep,
  sourceDetail,
  sourceLabel,
  summarizeImports,
  type ImportHistoryJob,
  type ImportStatusGroup,
} from '@/components/import-danych/import-model';
import {
  certificateState,
  errorMessage,
  exportNotice,
  formatLastFetch,
  historyBadge,
  importedSoFarText,
  needsClientAction,
  NO_CERTIFICATE_TEXT,
  pausedText,
  phaseLines,
  progressInfo,
  rateLimitText,
  rateLines,
  READ_FAILURE_TEXT,
  retiredDraftLine,
  SECTION_TITLES,
  STUCK_TEXT,
  UNCONFIRMED_CERTIFICATE_TEXT,
  type HistoryBadge,
} from '@/components/import-danych/ksef-history-model';
import type { MobileCaller } from '@/lib/api/mobile/auth';
import type { HistoriaKsefTelefonu, ImportOdpowiedz, ImportTelefonu, KafelImportu, OdcienTelefonu, SekcjaHistoriiKsef } from '@/lib/api/mobile/kontrakt-wiecej';
import { MobileUpstreamError, mobileJson } from '@/lib/api/mobile/responses';
import { formatPlInt } from '@/lib/format/pl';
import { formatWarsawDateTime } from '@/lib/format/warsaw-date';
import { countLabel } from '@/lib/i18n/plural';
import { hasConfiguredKsefProof } from '@/lib/ksef/claim-environment';
import { readKsefHistorySyncStatus, type KsefHistoryStreamStatus, type KsefHistorySyncStatus } from '@/lib/ksef/history-sync/status';

/**
 * `GET /api/mobile/v1/import` (plan aplikacji mobilnej, M10e): „Import danych”
 * do odczytu, jak strona `/import-danych`: te same odczyty klientem
 * użytkownika (RLS: `tenants` bez zaszyfrowanego certyfikatu, ostatnie
 * `import_jobs`, `readKsefHistorySyncStatus`) i te same zdania z modeli widoku
 * strony (`components/import-danych/*-model.ts`), złożone jak karta „Historia z
 * KSeF”, kafle i „Historia importów”. Telefon niczego nie liczy, tylko pokazuje.
 *
 * Wgranie pliku CSV, wstrzymanie pobierania (właściciel, 2FA) i listy faktur
 * do rozstrzygnięcia zostają na faktway.pl. Tylko odczyt: ponowienie niczego
 * nie zmienia.
 */

const BADGE_TONE: Record<HistoryBadge['tone'], OdcienTelefonu> = { ok: 'ok', wait: 'ostrzezenie', muted: 'neutralny' };
const STATUS_IMPORTU: Record<ImportStatusGroup, string> = { completed: 'Gotowe', running: 'W toku', failed: 'Błąd', cancelled: 'Anulowano' };

/** Kafle jak `importStats` strony (`import-center.tsx`), z tych samych sum `summarizeImports`. */
function kafle(jobs: readonly ImportHistoryJob[], ksef: KsefHistorySyncStatus | null): KafelImportu[] {
  const summary = summarizeImports(jobs);
  const partialNote = summary.partial ? `z ostatnich ${IMPORT_HISTORY_LIMIT} importów` : null;
  let historia: KafelImportu;
  if (ksef) {
    const sales = ksef.outgoing.counts.imported + summary.legacyKsefIssued;
    const purchases = ksef.incoming.counts.imported + summary.legacyKsefReceived;
    historia = { podpis: 'Historia z KSeF', wartosc: formatPlInt(sales + purchases), nota: `sprzedaż ${formatPlInt(sales)} · zakupy ${formatPlInt(purchases)}` };
  } else {
    // Stanu nie znamy: nie pokazujemy liczby mniejszej niż prawdziwa.
    historia = { podpis: 'Historia z KSeF', wartosc: '—', nota: 'nie udało się wczytać' };
  }
  const lastFetch = ksef?.outgoing.lastSuccessAt ?? ksef?.incoming.lastSuccessAt ?? null;
  return [
    historia,
    { podpis: 'Zaimportowane z plików', wartosc: formatPlInt(summary.fileInvoices), nota: partialNote },
    { podpis: 'Nowi kontrahenci', wartosc: formatPlInt(summary.fileContractors), nota: partialNote ? `z importów plików, ${partialNote}` : 'z importów plików' },
    { podpis: 'Ostatnie pobranie z KSeF', wartosc: lastFetch ? formatWarsawDateTime(lastFetch) : '—', nota: null },
  ];
}

/** Kafle tylko, gdy jest jakikolwiek import albo synchronizacja (`showsImportStats` i `hasKsefHistory` strony). */
function maHistorie(ksef: KsefHistorySyncStatus | null): boolean {
  if (!ksef) return false;
  return ksef.outgoing.phase !== 'waiting' || ksef.incoming.phase !== 'waiting' || ksef.outgoing.counts.imported + ksef.incoming.counts.imported > 0;
}

/** Sekcja „Sprzedaż” albo „Zakupy”, jak `StreamSection` strony. */
function sekcja(stream: KsefHistoryStreamStatus, status: KsefHistorySyncStatus, paused: boolean, blocked: boolean, now: Date): SekcjaHistoriiKsef {
  const progress = progressInfo(stream);
  const stuck = stream.stuck && !paused && !blocked && status.error?.code !== 'internal';
  return {
    kierunek: stream.direction,
    tytul: SECTION_TITLES[stream.direction],
    linie: phaseLines(stream, { outgoingEnabledAt: status.outgoing.enabledAt, paused, blocked, now }),
    postep: progress ? { podpis: progress.label, procent: progress.percent } : null,
    tempo: rateLines(stream, paused || blocked),
    stoi: stuck ? STUCK_TEXT : null,
  };
}

/** Karta „Historia z KSeF” jak `KsefHistoryCard` strony, bez formularza wstrzymania. */
function historiaKsef(hasCertificate: boolean, certificateConfirmed: boolean, status: KsefHistorySyncStatus | null, now: Date): HistoriaKsefTelefonu {
  const certyfikat = certificateState(hasCertificate, certificateConfirmed);
  const badge = historyBadge(certyfikat, status);
  const lastSuccessAt = status?.outgoing.lastSuccessAt ?? status?.incoming.lastSuccessAt ?? null;
  const baza = {
    odznaka: { etykieta: badge.label, odcien: BADGE_TONE[badge.tone] },
    podtytul: hasCertificate && lastSuccessAt ? `Ostatnie pobranie: ${formatLastFetch(lastSuccessAt)}` : 'Sprzedaż i zakupy z KSeF',
    certyfikat: certyfikat === 'missing' ? ('brak' as const) : certyfikat === 'unconfirmed' ? ('niepotwierdzony' as const) : ('gotowy' as const),
  };

  if (certyfikat !== 'ready') {
    const soFar = importedSoFarText(status);
    const tekst = certyfikat === 'missing' ? NO_CERTIFICATE_TEXT : UNCONFIRMED_CERTIFICATE_TEXT;
    return { ...baza, komunikaty: [{ tekst, odcien: 'ostrzezenie' }, ...(soFar ? [{ tekst: soFar, odcien: 'neutralny' as const }] : [])], sekcje: [], blad: null };
  }
  if (!status) return { ...baza, komunikaty: [], sekcje: [], blad: READ_FAILURE_TEXT };

  const paused = Boolean(status.clientPausedAt);
  const blocked = needsClientAction(status);
  const komunikaty: HistoriaKsefTelefonu['komunikaty'] = [];
  if (status.clientPausedAt) komunikaty.push({ tekst: pausedText(status.clientPausedAt, blocked), odcien: 'neutralny' });
  const error = errorMessage(status.error);
  if (error) komunikaty.push({ tekst: error.text, odcien: error.tone === 'destructive' ? 'blad' : 'ostrzezenie' });
  const rateLimit = paused || blocked ? null : rateLimitText(status.rateLimitedUntil, now);
  if (rateLimit) komunikaty.push({ tekst: rateLimit, odcien: 'ostrzezenie' });
  const notice = exportNotice(status.periodsChangedAfterExport);
  if (notice) komunikaty.push({ tekst: `${notice.lead}${notice.regenerate}${notice.rest}`, odcien: 'ostrzezenie' });
  const retired = retiredDraftLine(status);
  if (retired) komunikaty.push({ tekst: retired, odcien: 'neutralny' });
  // Listy faktur z powodami są na stronie; telefon mówi, ile ich jest (te same podpisy co listy strony).
  if (status.deferredTotal > 0) komunikaty.push({ tekst: `Czekają na rozstrzygnięcie: ${countLabel(status.deferredTotal, ['faktura', 'faktury', 'faktur'])}. Lista z powodami na faktway.pl.`, odcien: 'ostrzezenie' });
  if (status.blockedTotal > 0) komunikaty.push({ tekst: `Faktury, których nie pobraliśmy: ${formatPlInt(status.blockedTotal)}. Lista z powodami na faktway.pl.`, odcien: 'ostrzezenie' });

  return {
    ...baza,
    komunikaty,
    sekcje: [sekcja(status.outgoing, status, paused, blocked, now), sekcja(status.incoming, status, paused, blocked, now)],
    blad: null,
  };
}

/** Wiersz „Historii importów” jak `ResultCell` strony: podsumowanie, krok w toku albo powód błędu. */
function importTelefonu(job: ImportHistoryJob): ImportTelefonu {
  const status = jobStatusGroup(job);
  let opis: string | null = null;
  if (status === 'running') opis = runningStep(job.status);
  else if (status === 'completed') opis = completedSummary(job);
  else if (status === 'cancelled') {
    if (isInterruptedLegacyImport(job)) {
      const { saved } = failureNote(job);
      opis = saved ? `${INTERRUPTED_LEGACY_NOTE}. ${saved}` : INTERRUPTED_LEGACY_NOTE;
    }
  } else {
    const { reason, saved } = failureNote(job);
    opis = saved ? `${reason} ${saved}.` : reason;
  }
  return {
    id: job.id,
    zrodlo: sourceLabel(job.source),
    szczegol: sourceDetail(job),
    status,
    statusEtykieta: STATUS_IMPORTU[status],
    data: formatWarsawDay(job.created_at),
    opis,
    procent: status === 'running' ? progressPercent(job) : null,
  };
}

export async function importForMobile(caller: MobileCaller, now: Date = new Date()): Promise<NextResponse> {
  if (!caller.org) throw new Error('Trasa importu bez firmy (org: required)');
  const { tenantId } = caller.org;

  const [tenant, history, ksefHistory] = await Promise.all([
    caller.db.from('tenants').select('has_ksef_credentials, ksef_verified_at, ksef_verified_environment').eq('id', tenantId).maybeSingle(),
    caller.db.from('import_jobs').select(IMPORT_HISTORY_COLUMNS).eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(IMPORT_HISTORY_LIMIT),
    readKsefHistorySyncStatus(caller.db, tenantId).catch((error: unknown) => {
      console.error('[api.mobile.import] stan historii KSeF:', error instanceof Error ? error.name : 'błąd');
      return { ok: false } as const;
    }),
  ]);
  if (tenant.error || !tenant.data) throw new MobileUpstreamError('tenants.read');
  if (history.error) console.error('[api.mobile.import] historia importów:', history.error.message);

  const t = tenant.data as { has_ksef_credentials: boolean | null; ksef_verified_at: string | null; ksef_verified_environment: string | null };
  const status = ksefHistory.ok ? ksefHistory.status : null;
  const jobs = history.error ? null : ((history.data ?? []) as unknown as ImportHistoryJob[]);

  const odpowiedz: ImportOdpowiedz = {
    kafle: jobs && (jobs.length > 0 || maHistorie(status)) ? kafle(jobs, status) : null,
    historiaKsef: historiaKsef(Boolean(t.has_ksef_credentials), hasConfiguredKsefProof(t.ksef_verified_at, t.ksef_verified_environment), status, now),
    importy: jobs ? jobs.map(importTelefonu) : null,
    programy: FILE_SOURCES.map((s) => s.label),
  };
  return mobileJson(odpowiedz, 200, caller.headers);
}
