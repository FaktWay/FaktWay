import 'server-only';

import type { AuthError, SupabaseClient } from '@supabase/supabase-js';

import { checkPasswordOperationRateLimit } from '@/lib/rate-limit/password';
import { isGoTrueCaptchaRejection } from '@/lib/security/bot-check';

/**
 * Sprawdzenie hasła konta przed wrażliwą operacją (zmiana hasła, 2FA, usunięcie
 * konta), wspólne dla strony (`reauthenticateWithPassword`, konto z ciasteczek,
 * klient z kluczem anon i tokenem Turnstile) i telefonu (M10b, konto z tokenu,
 * klient logowania z kluczem serwisowym jak `POST /logowanie`, plan D16).
 * Logika przeniesiona z `lib/auth/reauth.ts`. Od LIM-05 brak odpowiedzi GoTrue
 * (limit czasu, sieć, 5xx, jego limit żądań) to `verification_unavailable`,
 * a nie złe hasło.
 *
 * Każde wywołanie liczy się do jednego limitu prób hasła konta
 * (`checkPasswordOperationRateLimit`), wspólnego dla strony i telefonu.
 * Hasło sprawdzamy na osobnym kliencie bez trwałej sesji; tymczasowa sesja
 * musi należeć do tego samego konta i jest od razu wylogowywana lokalnie.
 * Ten helper potwierdza hasło, a nie drugi czynnik: 2FA sprawdza wywołujący.
 */

export type PasswordCheckError = 'invalid_password' | 'unknown' | 'rate_limited' | 'verification_unavailable';
export type PasswordCheckResult = { ok: true } | { ok: false; error: PasswordCheckError; retryAfter?: number };

/** Kody limitu żądań samego GoTrue (odpowiedź 429). */
const GOTRUE_RATE_LIMIT_CODES = new Set(['over_request_rate_limit', 'over_email_send_rate_limit', 'over_sms_send_rate_limit']);

/**
 * GoTrue nie sprawdził hasła: limit czasu albo sieć (`AuthRetryableFetchError`,
 * LIM-05), 5xx, jego własny limit żądań albo odpowiedź bez kodu HTTP
 * (`AuthUnknownError`: ciało nie-JSON, czyli strona błędu po drodze; złe hasło
 * GoTrue zawsze opisuje w JSON z kodem 400). Klient słyszy wtedy „spróbuj za
 * chwilę”, a nie „złe hasło”, tak jak w `POST /logowanie` telefonu
 * (`lib/api/mobile/logowanie.ts`). Odpowiednik `isAuthServiceFailure` z sesji 7
 * planu skalowania (`lib/auth/gotrue-errors.ts`, jeszcze poza `main`), który
 * błąd bez kodu uznaje za odmowę: przy scalaniu trzeba wybrać jedną regułę.
 * Bez importu wartości z `@supabase/supabase-js`, bo wiele testów podmienia
 * ten moduł w całości.
 */
function isGoTrueUnavailable(error: AuthError): boolean {
  if ('__isAuthError' in error && error.name === 'AuthRetryableFetchError') return true;
  if (error.status === 429 || (typeof error.code === 'string' && GOTRUE_RATE_LIMIT_CODES.has(error.code))) return true;
  return typeof error.status !== 'number' || error.status >= 500;
}

export async function confirmAccountPassword(input: {
  userId: string;
  email: string;
  password: string;
  /** Klient GoTrue tylko do tego sprawdzenia (bez sesji w pamięci); tworzony dopiero po limicie prób. */
  verifier: () => SupabaseClient;
  captchaToken?: string;
}): Promise<PasswordCheckResult> {
  const { userId, email, password, captchaToken } = input;
  if (typeof password !== 'string' || !password || password.length > 1024) {
    return { ok: false, error: 'invalid_password' };
  }

  // Every caller, including GDPR, shares one authoritative account budget.
  // Keep it here so a new sensitive action cannot omit the password-attempt limit.
  const limit = await checkPasswordOperationRateLimit(userId).catch(() => null);
  if (!limit || limit.unavailable) return { ok: false, error: 'verification_unavailable' };
  if (!limit.allowed) return { ok: false, error: 'rate_limited', retryAfter: limit.retryAfter };

  const verifier = input.verifier();

  const token = typeof captchaToken === 'string' && captchaToken.length >= 10 && captchaToken.length <= 2048
    ? captchaToken
    : undefined;
  const { data, error } = await verifier.auth.signInWithPassword({
    email,
    password,
    ...(token ? { options: { captchaToken: token } } : {}),
  });

  // Nawet niespójna odpowiedź tożsamości nie może zostawić celowo otwartej
  // sesji. Używamy JWT wyłącznie z odpowiedzi tego logowania i zakresu local.
  // Zwykłe auth.signOut() ukrywa błędy HTTP 401/403/404. Jego warstwa admin
  // zachowuje te błędy; nazwa SDK nie oznacza użycia klucza service_role.
  let cleanupFailed = false;
  const temporaryToken = data.session?.access_token;
  if (typeof temporaryToken === 'string' && temporaryToken) {
    try {
      const { error: cleanupError } = await verifier.auth.admin.signOut(temporaryToken, 'local');
      cleanupFailed = Boolean(cleanupError);
    } catch {
      cleanupFailed = true;
    }
  }

  if (error) {
    const unavailable = isGoTrueUnavailable(error) || isGoTrueCaptchaRejection(error);
    return { ok: false, error: unavailable ? 'verification_unavailable' : 'invalid_password' };
  }

  if (cleanupFailed || typeof temporaryToken !== 'string' || !temporaryToken || data.user?.id !== userId) {
    return { ok: false, error: 'unknown' };
  }

  return { ok: true };
}
