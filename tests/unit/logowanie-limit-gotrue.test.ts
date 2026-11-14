import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

/**
 * Plan skalowania 3000, sesja 7 (GTR-03): limit (429) i awaria GoTrue przy
 * logowaniu, rejestracji i resecie hasła.
 *
 * Przy 429 klient czytał „Nieprawidłowy email lub hasło”, więc ponawiał próbę
 * i zużywał limit aplikacji. Rejestracja pokazywała surowy komunikat GoTrue
 * po angielsku. Operator nie dostawał żadnego sygnału.
 *
 * Test używa prawdziwego klienta z `lib/supabase/server` (`@supabase/ssr`
 * i auth-js) z atrapą GoTrue, więc błędy mają prawdziwe klasy auth-js.
 * Odmowa captcha i złe hasło zostają, jak były.
 */

const mocks = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new Error('redirect:' + path); } }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ origin: 'https://app.example.test' }),
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/get-client-ip', () => ({ getClientIp: async () => '192.0.2.1' }));
vi.mock('@/lib/rate-limit/auth', () => ({
  checkLoginRateLimit: async () => ({ allowed: true }),
  checkRegisterRateLimit: async () => ({ allowed: true }),
}));
vi.mock('@/lib/rate-limit/password', () => ({
  checkPasswordRecoveryRequestRateLimit: async () => ({ allowed: true, unavailable: false, retryAfter: 0 }),
  checkPasswordOperationRateLimit: async () => ({ allowed: true, unavailable: false, retryAfter: 0 }),
}));
vi.mock('@/lib/feature-flags/signups', () => ({ isSignupClosed: async () => false }));
vi.mock('@/lib/auth/password', () => ({ validatePassword: async () => ({ valid: true }) }));
vi.mock('@/lib/auth/oauth-providers', () => ({ isGoogleLoginEnabled: async () => false }));
vi.mock('@/lib/auth/sign-out', () => ({ signOutCurrentSession: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: vi.fn() }));
vi.mock('@/lib/jobs/events', () => ({ userRegistered: { create: (data: unknown) => ({ data }) } }));
vi.mock('@/lib/legal/record', () => ({ recordTermsAcceptance: async () => ({ ok: true }) }));

const { loginWithEmail } = await import('@/app/(auth)/login/actions');
const { signupWithEmail } = await import('@/app/(auth)/register/actions');
const { requestPasswordReset } = await import('@/app/(auth)/forgot-password/actions');

const GOTRUE_URL = 'https://auth.example.test';
const TOKEN = 'synthetic-turnstile-token-0123456789';
const email = 'fixture@example.test';
const password = 'Fixture-Passw0rd!';

type Respond = () => Response;

/** Odpowiedź atrapy GoTrue na logowanie, rejestrację i reset hasła. */
let gotrue: Respond;
let gotrueCalls: string[];
let warn: MockInstance<typeof console.warn>;

function gotrueError(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status, headers: { 'x-supabase-api-version': '2024-01-01' } });
}

const rateLimited: Respond = () => gotrueError(429, 'over_request_rate_limit', 'Request rate limit reached');
const emailRateLimited: Respond = () => gotrueError(429, 'over_email_send_rate_limit', 'email rate limit exceeded');
const unavailable: Respond = () => gotrueError(503, 'unexpected_failure', 'Service Unavailable');
const networkDown: Respond = () => {
  throw new TypeError('fetch failed');
};
// GoTrue zgłasza brak tokenu captcha jako błąd wewnętrzny 500, a nie `captcha_failed`.
const captchaMissing: Respond = () => gotrueError(500, 'unexpected_failure', 'captcha verification process failed');
const wrongPassword: Respond = () => gotrueError(400, 'invalid_credentials', 'Invalid login credentials');

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== GOTRUE_URL) throw new Error(`Nieoczekiwane żądanie w teście: ${url.href}`);
  gotrueCalls.push(`${url.pathname}${url.search}`);
  return gotrue();
}

function form(): FormData {
  const data = new FormData();
  data.set('email', email);
  data.set('password', password);
  data.set('terms', 'on');
  data.set('cf-turnstile-response', TOKEN);
  return data;
}

/** Pierwsze argumenty wpisów `[auth]` w logu. */
const authLines = () => warn.mock.calls
  .map(([first]) => String(first))
  .filter((line) => line.startsWith('[auth]'));

/** Cały log jako tekst: bez adresu e-mail i hasła. */
function wholeLog(): string {
  return warn.mock.calls.flat().map((arg) => {
    if (typeof arg === 'string') return arg;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }).join('\n');
}

beforeEach(() => {
  vi.clearAllMocks();
  gotrueCalls = [];
  gotrue = wrongPassword;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', GOTRUE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-anon-key');
  vi.stubEnv('TURNSTILE_SECRET_KEY', 'synthetic-turnstile-secret');
  // Token sprawdza GoTrue, więc atrapa Cloudflare nie jest potrzebna.
  vi.stubEnv('AUTH_CAPTCHA_IN_GOTRUE', 'true');
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('logowanie', () => {
  it('limit 429: „przeciążone, spróbuj za minutę”, nie „złe hasło”, i wpis w logu bez adresu', async () => {
    gotrue = rateLimited;
    await expect(loginWithEmail(form())).rejects.toThrow('redirect:/login?error=auth_busy');
    expect(gotrueCalls).toEqual(['/auth/v1/token?grant_type=password']);
    expect(authLines()).toEqual(['[auth] gotrue_rate_limited']);
    expect(warn).toHaveBeenCalledWith('[auth] gotrue_rate_limited', expect.objectContaining({
      flow: 'login', status: 429, code: 'over_request_rate_limit',
    }));
    expect(wholeLog()).not.toContain(email);
    expect(wholeLog()).not.toContain(password);
  });

  it.each([['503 z GoTrue', unavailable], ['brak sieci', networkDown]] as [string, Respond][])(
    '%s: „nie udało się teraz zalogować”, nie „złe hasło”',
    async (_name, respond) => {
      gotrue = respond;
      await expect(loginWithEmail(form())).rejects.toThrow('redirect:/login?error=auth_unavailable');
      expect(authLines()).toEqual(['[auth] gotrue_unavailable']);
    },
  );

  it('złe hasło zostaje złym hasłem, bez wpisu w logu', async () => {
    gotrue = wrongPassword;
    await expect(loginWithEmail(form())).rejects.toThrow('redirect:/login?error=invalid_credentials');
    expect(authLines()).toEqual([]);
  });

  it('odmowa captcha z GoTrue (500) zostaje komunikatem o weryfikacji', async () => {
    gotrue = captchaMissing;
    await expect(loginWithEmail(form())).rejects.toThrow('redirect:/login?error=bot_check_failed');
  });
});

describe('rejestracja', () => {
  it.each([
    ['limit żądań', rateLimited, 'auth_busy'],
    // Limit wysyłki maili ma swój, dokładniejszy komunikat (jak przed zmianą).
    ['limit maili', emailRateLimited, 'email_rate_limited'],
  ] as [string, Respond, string][])(
    '%s (429): kod komunikatu zamiast surowego tekstu GoTrue',
    async (_name, respond, code) => {
      gotrue = respond;
      await expect(signupWithEmail(form())).rejects.toThrow(`redirect:/register?error=${code}`);
      expect(authLines()).toEqual(['[auth] gotrue_rate_limited']);
      expect(wholeLog()).not.toContain(email);
    },
  );

  it('503 z GoTrue: kod komunikatu zamiast surowego tekstu GoTrue', async () => {
    gotrue = unavailable;
    await expect(signupWithEmail(form())).rejects.toThrow('redirect:/register?error=auth_unavailable');
    expect(authLines()).toEqual(['[auth] gotrue_unavailable']);
  });

  it('odmowa captcha z GoTrue (500) zostaje komunikatem o weryfikacji', async () => {
    gotrue = captchaMissing;
    await expect(signupWithEmail(form())).rejects.toThrow('redirect:/register?error=bot_check_failed');
  });
});

describe('reset hasła: ekran bez zmian (nie zdradza, czy konto istnieje), serwer zapisuje sygnał', () => {
  it('limit żądań (429, przed szukaniem konta): komunikat o przeciążeniu zamiast „wysłaliśmy link”', async () => {
    // GoTrue liczy ten limit od adresu IP, zanim sprawdzi konto, więc komunikat
    // niczego nie zdradza, a klient nie czeka na link, który nie wyjdzie.
    gotrue = rateLimited;
    await expect(requestPasswordReset(form())).rejects.toThrow('redirect:/forgot-password?error=auth_busy');
    expect(authLines()).toEqual(['[auth] gotrue_rate_limited']);
    expect(wholeLog()).not.toContain(email);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('limit maili (429): ekran bez zmian, bo GoTrue liczy go tylko dla istniejącego konta', async () => {
    gotrue = emailRateLimited;
    await expect(requestPasswordReset(form())).rejects.toThrow('redirect:/forgot-password?success=email_sent');
    expect(authLines()).toEqual(['[auth] gotrue_rate_limited']);
    expect(warn).toHaveBeenCalledWith('[auth] gotrue_rate_limited', expect.objectContaining({ flow: 'forgot-password' }));
    expect(wholeLog()).not.toContain(email);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('503 z GoTrue', async () => {
    gotrue = unavailable;
    await expect(requestPasswordReset(form())).rejects.toThrow('redirect:/forgot-password?success=email_sent');
    expect(authLines()).toEqual(['[auth] gotrue_unavailable']);
  });

  it('gdy GoTrue przyjmie prośbę, bez wpisu w logu', async () => {
    gotrue = () => Response.json({});
    await expect(requestPasswordReset(form())).rejects.toThrow('redirect:/forgot-password?success=email_sent');
    expect(authLines()).toEqual([]);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.password_reset_requested' }));
  });
});
