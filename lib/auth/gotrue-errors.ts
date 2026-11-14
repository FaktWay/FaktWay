/**
 * Błąd infrastruktury GoTrue to nie odmowa (plan skalowania 3000, sesja 7:
 * REQ-V02, GTR-03, QAL-06).
 *
 * Limit (429), awaria (5xx) i brak sieci znaczą „spróbuj ponownie”: bez
 * wylogowania, bez „złego hasła” i bez wysyłania na „Załóż firmę”. Odmową
 * zostaje cała reszta: zły albo wygasły token, brak sesji, złe hasło, a także
 * błąd bez statusu (np. `AuthUnknownError`), żeby martwy token nie dawał bez
 * końca 503. Tę samą granicę ma `isTransientAuthError` w API telefonu
 * (`lib/api/mobile/auth.ts`).
 *
 * Bez `server-only`: moduł nie ma sekretów, a teksty czytają też strony logowania.
 */

/** Tekst dla klienta przy limicie GoTrue (429). */
export const AUTH_BUSY_MESSAGE = 'System logowania jest chwilowo przeciążony. Spróbuj ponownie za minutę.';

/** Tekst dla klienta przy awarii GoTrue: sesja zostaje, wystarczy ponowić. */
export const SESSION_RETRY_MESSAGE = 'Nie udało się zweryfikować sesji. Spróbuj ponownie za chwilę.';

/** Kody limitów GoTrue. */
const RATE_LIMIT_CODES: ReadonlySet<string> = new Set([
  'over_request_rate_limit',
  'over_email_send_rate_limit',
  'over_sms_send_rate_limit',
]);

const SERVICE_UNAVAILABLE = 'AuthServiceUnavailableError';

type ErrorFacts = { status: number | null; code: string | null; name: string | null };

function factsOf(error: unknown): ErrorFacts {
  if (typeof error !== 'object' || error === null) return { status: null, code: null, name: null };
  const { status, code, name } = error as { status?: unknown; code?: unknown; name?: unknown };
  return {
    status: typeof status === 'number' ? status : null,
    code: typeof code === 'string' ? code : null,
    name: typeof name === 'string' ? name : null,
  };
}

/**
 * Błąd infrastruktury z `getVerifiedMfaState` i `getDashboardSessionUser`:
 * wołający pokazuje „spróbuj ponownie” (przy limicie `AUTH_BUSY_MESSAGE`),
 * a nie „zaloguj się”. Pierwotny błąd auth-js jest w `cause`.
 */
export class AuthServiceUnavailableError extends Error {
  readonly rateLimited: boolean;
  readonly status: number | null;
  readonly code: string | null;

  constructor(cause: unknown) {
    const rateLimited = isAuthRateLimited(cause);
    super(rateLimited ? 'gotrue_rate_limited' : 'gotrue_unavailable', { cause });
    this.name = SERVICE_UNAVAILABLE;
    const { status, code } = factsOf(cause);
    this.rateLimited = rateLimited;
    this.status = status;
    this.code = code;
  }
}

/** Po nazwie, nie `instanceof`: błąd mija granice modułów (atrapy w testach, osobne paczki). */
export function isAuthServiceUnavailable(error: unknown): error is AuthServiceUnavailableError {
  return error instanceof Error && error.name === SERVICE_UNAVAILABLE;
}

/**
 * Brak sieci, przekroczony czas albo 5xx w auth-js: to samo sprawdzenie co
 * `isAuthRetryableFetchError` z `@supabase/auth-js` (znacznik `__isAuthError`
 * i nazwa klasy). Lokalnie, bez importu, bo wiele testów podmienia cały moduł
 * `@supabase/supabase-js` i nie zna tej funkcji.
 */
function isRetryableFetchError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && '__isAuthError' in error
    && (error as { name?: unknown }).name === 'AuthRetryableFetchError';
}

/**
 * Treść błędu `withRefreshRateLimit` (`lib/supabase/refresh-rate-limit.ts`).
 * auth-js podaje go dalej jako `AuthRetryableFetchError` ze statusem 0 i tą
 * treścią, więc bez niej limit przy odświeżeniu wyglądałby jak awaria.
 */
export const REFRESH_RATE_LIMITED = 'gotrue_refresh_rate_limited';

/** GoTrue odmówił limitem: status 429, kod `over_*_rate_limit` albo limit przy odświeżeniu sesji. */
export function isAuthRateLimited(error: unknown): boolean {
  if (isAuthServiceUnavailable(error)) return error.rateLimited === true;
  const { status, code } = factsOf(error);
  if (status === 429 || (code !== null && RATE_LIMIT_CODES.has(code))) return true;
  return isRetryableFetchError(error) && (error as { message?: unknown }).message === REFRESH_RATE_LIMITED;
}

/** Sesji, hasła ani kodu nie da się teraz sprawdzić: limit, 5xx albo brak sieci. */
export function isAuthServiceFailure(error: unknown): boolean {
  if (isAuthServiceUnavailable(error) || isRetryableFetchError(error) || isAuthRateLimited(error)) return true;
  const { status } = factsOf(error);
  return status !== null && status >= 500;
}

/** Skąd wpis w logu (pole `flow`). */
export type AuthFailureFlow =
  | `proxy:${string}`
  | 'odswiezenie-sesji'
  | 'login'
  | 'register'
  | 'forgot-password'
  | 'two-factor'
  | 'akcja'
  | 'api'
  | 'panel';

/**
 * Sygnał dla operatora: `[auth] gotrue_rate_limited` albo `[auth] gotrue_unavailable`
 * z przepływem, statusem, kodem i klasą błędu. Nigdy treść błędu, adres e-mail,
 * token ani kod 2FA. Wołający pisze jeden wpis na żądanie.
 */
export function logAuthServiceFailure(flow: AuthFailureFlow, error: unknown): void {
  const source = isAuthServiceUnavailable(error) ? error.cause : error;
  const { status, code, name } = factsOf(source);
  const line = isAuthRateLimited(error) ? '[auth] gotrue_rate_limited' : '[auth] gotrue_unavailable';
  console.warn(line, { flow, status, code, name });
}
