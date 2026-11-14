import { logAuthServiceFailure, REFRESH_RATE_LIMITED } from '@/lib/auth/gotrue-errors';

/**
 * Odmowa odświeżenia sesji limitem GoTrue (429), podana auth-js jako błąd sieci.
 *
 * Po błędzie odświeżenia, którego auth-js nie uważa za przejściowy, kasuje
 * sesję, a 429 za przejściowy nie uważa: limit GoTrue wylogowywał klienta.
 * Błąd rzucony z `fetch` auth-js bierze za brak sieci, więc sesja zostaje.
 * Status 429 rozpoznaje `isAuthRateLimited`.
 */
export class RefreshRateLimitedError extends Error {
  readonly status = 429;

  constructor() {
    super(REFRESH_RATE_LIMITED);
    this.name = 'RefreshRateLimitedError';
  }
}

function isSessionRefresh(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method !== 'POST') return false;
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    const url = new URL(href);
    return url.pathname.endsWith('/auth/v1/token') && url.searchParams.get('grant_type') === 'refresh_token';
  } catch {
    return false;
  }
}

/**
 * `fetch` klienta Supabase z ciasteczkami sesji: 429 na odświeżenie sesji
 * kończy się `RefreshRateLimitedError` i `onRateLimited` (domyślnie wpis
 * w logu), a nie skasowaniem sesji. auth-js ponawia błąd przejściowy
 * (po 200 ms, 400 ms, … do 30 s), ale po pierwszym 429 kolejne próby tego
 * klienta nie idą już do GoTrue. Logowanie hasłem i wymiana kodu (inne
 * `grant_type`) bez zmian: tam 429 obsługuje akcja.
 */
export function withRefreshRateLimit(
  base: typeof fetch,
  onRateLimited: (error: RefreshRateLimitedError) => void = (error) => logAuthServiceFailure('odswiezenie-sesji', error),
): typeof fetch {
  let limited: RefreshRateLimitedError | null = null;
  return async (input, init) => {
    if (!isSessionRefresh(input, init)) return base(input, init);
    if (limited) throw limited;
    const response = await base(input, init);
    if (response.status !== 429) return response;
    void response.body?.cancel().catch(() => {});
    limited = new RefreshRateLimitedError();
    onRateLimited(limited);
    throw limited;
  };
}
