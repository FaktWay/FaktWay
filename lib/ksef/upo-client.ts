/**
 * Klient KSeF API do pobierania Urzędowych Poświadczeń Odbioru (UPO).
 *
 * Wymaga `service_role` (ładowanie credentials z DB) — używać wyłącznie
 * w Inngest / API routes po stronie serwera, nie w Client Components.
 */

import type { KsefEnvironment } from '@/types/ksef';

import { bodyWithinTimeout } from '@/lib/http/body-within-timeout';
import { getTenantKsefCredentials } from '@/lib/supabase/admin-queries';
import { requireMatchingKsefEnvironment } from './claim-environment';

import { getKsefBaseUrl, isKsefLocalPause, KsefApiError, ksefErrorCodes, parseRetryAfterMs } from './client';
import { ksefPauseLengthMs, ksefPausedUntil, recordKsefRateLimit } from './rate-limit-pause';
import { ksefRateLimiter } from './rate-limiter';
import { ksefSessionCache } from './session-cache';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Kod wyniku „firma w pauzie po 429 z KSeF” (L1a). To NIE `KSEF_PAUSED`
 * (wyłącznik operatora, klasa hold): pauza mija sama po `Retry-After`.
 * Runner (`download-upo.ts`) porównuje ten sam napis.
 */
const KSEF_RATE_LIMIT_PAUSE = 'KSEF_RATE_LIMIT_PAUSE';

export interface UpoDownloadResult {
  success: true;
  upoXml: string;
  upoXmlHash: string; // SHA-256
  upoId?: string;
  acceptanceTimestamp: string;
}

export interface UpoDownloadError {
  success: false;
  error: string;
  errorCode?: string;
  retryable: boolean;
  /** Pauza firmy po 429 (`errorCode: 'KSEF_RATE_LIMIT_PAUSE'`): ile ms zostało do jej końca. */
  retryAfterMs?: number;
}

export type UpoDownloadResponse = UpoDownloadResult | UpoDownloadError;

function resolveEnv(env?: KsefEnvironment): KsefEnvironment {
  return requireMatchingKsefEnvironment(env);
}

/**
 * Wynik „firma w pauzie po 429” (L1a): bez żądania do KSeF, do ponowienia po
 * końcu pauzy. Komunikat mówi o limicie KSeF, nie o certyfikacie — 429 przy
 * logowaniu nie znaczy, że poświadczenia są złe.
 */
function rateLimitPaused(remainingMs: number): UpoDownloadError {
  const ms = Number.isFinite(remainingMs) ? Math.max(0, Math.ceil(remainingMs)) : 0;
  return {
    success: false,
    error: `KSeF chwilowo ogranicza zapytania tej firmy (429). UPO pobierze się samo po pauzie (jeszcze ${Math.ceil(ms / 1000)} s)`,
    errorCode: KSEF_RATE_LIMIT_PAUSE,
    retryable: true,
    retryAfterMs: ms,
  };
}

/** Pozostały czas pauzy firmy (ms) albo `null`, gdy firma nie jest w pauzie. */
async function pauseRemainingMs(env: KsefEnvironment, nip: string): Promise<number | null> {
  const until = await ksefPausedUntil(env, nip);
  return until === null ? null : until - Date.now();
}

/**
 * Pobiera UPO z KSeF API.
 *
 * KSeF 2.0 udostępnia UPO pojedynczej faktury wyłącznie w zasobach sesji:
 * `GET /sessions/{sessionRef}/invoices/ksef/{ksefNumber}/upo`
 * (CIRFMF/ksef-api, „sesja — sprawdzenie stanu i pobranie UPO”). Wcześniejsza
 * ścieżka `/invoices/{ksefNumber}/upo` nie istnieje w API (AUD-17).
 */
export async function downloadUpoFromKsef(
  tenantId: string,
  ksefNumber: string,
  opts?: {
    env?: KsefEnvironment;
    timeoutMs?: number;
    /** Faza 23 sekcja 3: zapis do audit_logs (fire-and-forget). */
    invoiceId?: string;
    /** Numer sesji KSeF, w której faktura dostała numer. Bez niego UPO nie da się pobrać. */
    sessionReferenceNumber?: string | null;
  },
): Promise<UpoDownloadResponse> {
  if (!opts?.sessionReferenceNumber) {
    return {
      success: false,
      error:
        'Brak numeru sesji KSeF dla tej faktury — UPO trzeba pobrać ręcznie w Aplikacji Podatnika KSeF',
      errorCode: 'NO_SESSION_REFERENCE',
      retryable: false,
    };
  }
  const sessionReferenceNumber = opts.sessionReferenceNumber;
  const env = resolveEnv(opts?.env);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const auditStart = Date.now();
  const auditInvoiceId = opts?.invoiceId;

  // Helper: fire-and-forget audit, w czystym wnętrzu downloadUpoFromKsef nie
  // używamy ksefFetch (raw `fetch` z streamingiem) — audit ręcznie.
  const writeAudit = (status: number, errorMsg?: string) => {
    void (async () => {
      try {
        const { logAuditSystem } = await import('@/lib/audit/log-system');
        await logAuditSystem({
          action: 'ksef.upo.download',
          tenantId,
          userId: null,
          entityType: auditInvoiceId ? 'invoice' : 'ksef',
          entityId: auditInvoiceId,
          metadata: {
            ksefNumber,
            httpStatus: status,
            durationMs: Date.now() - auditStart,
            ...(errorMsg ? { error: errorMsg } : {}),
          },
        });
      } catch (e) {
        console.error('[ksef.audit] upo download log failed', e);
      }
    })();
  };

  // LIM-05: zegar żądania UPO kasuje dopiero `finally` na końcu, po
  // przeczytaniu treści odpowiedzi. Tam też czekamy na zapis pauzy po 429.
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let pauseWrite: Promise<unknown> | undefined;
  try {
    let auth;
    try {
      auth = await getTenantKsefCredentials(tenantId);
    } catch (credErr) {
      const message =
        credErr instanceof Error ? credErr.message : 'Unknown error';
      if (
        message.includes('nie ma skonfigurowanych credentials') ||
        message.includes('ksef_credentials_encrypted')
      ) {
        return {
          success: false,
          error: 'Brak aktywnej sesji KSeF — sprawdź certyfikat',
          errorCode: 'NO_CREDENTIALS',
          retryable: false,
        };
      }
      return {
        success: false,
        error: message,
        retryable: false,
      };
    }

    // L1a: firma w pauzie po 429 — żadnego żądania do KSeF (MF wydłuża
    // blokadę przy powtórkach). Przed logowaniem: przy sesji w pamięci
    // `getSession` nie pyta KSeF, więc bramka w `ksefFetch` by tego nie złapała.
    const pausedBeforeSession = await pauseRemainingMs(env, auth.nip);
    if (pausedBeforeSession !== null) return rateLimitPaused(pausedBeforeSession);

    let session;
    try {
      session = await ksefRateLimiter.enqueue(auth.nip, () =>
        ksefSessionCache.getSession(auth, env),
      );
    } catch (sessionErr) {
      // 429 przy logowaniu albo odświeżeniu sesji: prawdziwy (pauzę zapisał
      // już `ksefFetch`, kontekst NIP z `getSession`) albo lokalny z pauzy.
      // To limit KSeF, nie zły certyfikat — UPO wraca po pauzie.
      if ((sessionErr instanceof KsefApiError && sessionErr.status === 429) || isKsefLocalPause(sessionErr)) {
        const remaining = await pauseRemainingMs(env, auth.nip);
        const fromError = (sessionErr as { retryAfterMs?: number | null }).retryAfterMs;
        return rateLimitPaused(remaining ?? ksefPauseLengthMs(fromError));
      }
      return {
        success: false,
        error: 'Brak aktywnej sesji KSeF — sprawdź certyfikat',
        retryable: false,
      };
    }

    // Drugi odczyt tuż przed żądaniem UPO: samo żądanie idzie surowym `fetch`
    // (poza bramką `ksefFetch`), a pauza mogła się zacząć w trakcie logowania
    // albo czekania w kolejce firmy (429 innego zadania tej firmy).
    const pausedBeforeUpo = await pauseRemainingMs(env, auth.nip);
    if (pausedBeforeUpo !== null) return rateLimitPaused(pausedBeforeUpo);

    const baseUrl = getKsefBaseUrl(env);
    const upoEndpoint = `${baseUrl}/sessions/${encodeURIComponent(sessionReferenceNumber)}/invoices/ksef/${encodeURIComponent(ksefNumber)}/upo`;

    // LIM-05: limit obejmuje żądanie i całą treść odpowiedzi (kody błędu albo
    // XML UPO). KSeF, który wysłał nagłówki i stanął, kończy się po
    // `timeoutMs` tym samym `TIMEOUT` co brak nagłówków (`catch` niżej),
    // zamiast trzymać job UPO do 300 s (limit ciszy undici).
    const controller = new AbortController();
    timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    const response = bodyWithinTimeout(
      await fetch(upoEndpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          Accept: 'application/xml',
        },
        signal: controller.signal,
        redirect: 'error',
      }),
      controller.signal,
    );

    if (!response.ok) {
      if (response.status === 404) {
        writeAudit(response.status, `HTTP ${response.status}`);
        return {
          success: false,
          error: 'UPO nie zostało jeszcze wygenerowane przez KSeF',
          errorCode: 'UPO_NOT_READY',
          retryable: true,
        };
      }

      if (response.status === 401) {
        writeAudit(response.status, `HTTP ${response.status}`);
        ksefSessionCache.invalidate(auth.nip, env);
        return {
          success: false,
          error: 'Sesja KSeF wygasła',
          errorCode: 'SESSION_EXPIRED',
          retryable: true,
        };
      }

      if (response.status === 429) {
        // L1a: 429 z samego żądania UPO zatrzymuje całą firmę na pełny
        // `Retry-After` (to żądanie omija `ksefFetch`, więc zapis jest tutaj).
        // Wynik dla TEGO 429 zostaje jak dotąd (błąd ostateczny `HTTP_429`
        // niżej; UPO wraca z `upo-retry-stale`, gdy wpis ma ponad 24 h i pauza
        // minęła): zmiana jego klasyfikacji to sesja D1 planu „zero zgubionych
        // faktur” (decyzja sesji nadrzędnej L1a).
        // Pamięć procesu dostaje pauzę od razu (część synchroniczna), zapis
        // w Redisie (do ok. 1 s) idzie równolegle z odczytem treści, a czeka
        // na niego `finally`. Inaczej 429 tuż przed limitem kończyłoby się
        // przerwaniem w trakcie zapisu, czyli `TIMEOUT` zamiast `HTTP_429`.
        // `catch` tylko na wszelki wypadek (funkcja z umowy nie rzuca): bez niego
        // odrzucenie w trakcie odczytu treści byłoby nieobsłużone.
        pauseWrite = recordKsefRateLimit(env, auth.nip, parseRetryAfterMs(response.headers.get('retry-after')))
          .catch(() => undefined);
      }

      // Treść odpowiedzi czytamy tylko po kody KSeF. Komunikat idzie do
      // `upo_receipts.last_error`, komunikatu błędu joba (log workera,
      // `inngest_run_log`, Sentry po wyczerpaniu prób), więc treść nigdy:
      // może nieść dane kontrahenta (F-093-UPO).
      const codes = ksefErrorCodes(await response.text());
      // Audyt po treści: jedna próba to jeden wiersz. Zawieszona treść (także
      // przy 429, z pauzą zapisaną wyżej) daje tylko wiersz 408 z `catch`
      // i `TIMEOUT` do ponowienia (na `main` ten sam wynik do ponowienia
      // przychodził po 300 s); ponowienie trafia w zapisaną pauzę firmy.
      writeAudit(response.status, `HTTP ${response.status}`);
      return {
        success: false,
        error: upoHttpErrorMessage(response.status, codes),
        errorCode: `HTTP_${response.status}`,
        retryable: response.status >= 500,
      };
    }

    const upoXml = await response.text();
    const upoXmlHash = await sha256(upoXml);
    const acceptanceTimestamp = extractAcceptanceTimestamp(upoXml);
    const upoId = extractUpoId(upoXml);

    writeAudit(response.status);

    return {
      success: true,
      upoXml,
      upoXmlHash,
      upoId,
      acceptanceTimestamp,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      writeAudit(408, 'timeout');
      return {
        success: false,
        error: `UPO — przekroczono limit czasu żądania (${timeoutMs} ms)`,
        errorCode: 'TIMEOUT',
        retryable: true,
      };
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    writeAudit(0, message);
    return {
      success: false,
      error: `Błąd pobierania UPO: ${message}`,
      retryable: true,
    };
  } finally {
    clearTimeout(timeoutHandle);
    // Wynik dopiero po zapisie pauzy: ponowienie w innym procesie ją widzi.
    await pauseWrite;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Najwyżej tyle kodów w komunikacie: lista przychodzi z zewnątrz. */
const MAX_CODES_IN_MESSAGE = 10;

/**
 * Komunikat błędu HTTP pobrania UPO: status i kody KSeF, bez treści odpowiedzi.
 * Reguła jak w `lib/ksef/history-sync/errors.ts` („HTTP {status} {ścieżka}
 * kody:{…}”), tylko bez ścieżki: UPO ma jedną. Krótki napis grupuje się
 * w `scripts/ops/kontrola-faktur-ksef.sh` (pierwsze 60 znaków `last_error`):
 * mieści się tam do 5 kodów pięciocyfrowych, dalsze kody widać w panelu.
 */
function upoHttpErrorMessage(status: number, codes: readonly number[]): string {
  const shown = [...new Set(codes)].slice(0, MAX_CODES_IN_MESSAGE);
  return `KSeF zwrócił HTTP ${status} kody:${shown.length ? shown.join(',') : '-'}`;
}

async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function extractAcceptanceTimestamp(upoXml: string): string {
  const match = upoXml.match(
    /<(?:DataPrzyjeciaWKsef|AcceptanceTimestamp|DataAkceptacji)>([^<]+)</,
  );
  return match?.[1] ?? new Date().toISOString();
}

function extractUpoId(upoXml: string): string | undefined {
  const match = upoXml.match(/<(?:NumerUPO|UpoNumber|IdUPO)>([^<]+)</);
  return match?.[1];
}
