import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan skalowania 3000, sesja 7 (GTR-03): kody `auth_busy` i `auth_unavailable`
 * z akcji logowania, rejestracji, resetu hasła i 2FA (oraz `email_rate_limited`
 * z rejestracji) mają na ekranie polski komunikat.
 * Strona logowania i rejestracji pokazuje nieznany kod wprost, więc bez
 * wpisu w mapie klient zobaczyłby „auth_busy”.
 */

const mocks = vi.hoisted(() => ({ google: vi.fn(), closed: vi.fn(), mfa: vi.fn() }));

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/auth/oauth-providers', () => ({ isGoogleLoginEnabled: mocks.google }));
vi.mock('@/lib/feature-flags/signups', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/feature-flags/signups')>()),
  isSignupClosed: mocks.closed,
}));
vi.mock('@/components/auth/turnstile-widget', () => ({ TurnstileWidget: () => null }));
vi.mock('@/app/(auth)/login/actions', () => ({ loginWithEmail: vi.fn(), loginWithGoogle: vi.fn() }));
vi.mock('@/app/(auth)/register/actions', () => ({ signupWithEmail: vi.fn() }));
vi.mock('@/app/(auth)/forgot-password/actions', () => ({ requestPasswordReset: vi.fn() }));
vi.mock('@/app/(auth)/login/two-factor/actions', () => ({ verifyMfaChallengeAction: vi.fn() }));
vi.mock('@/lib/auth/verified-mfa', () => ({ getVerifiedMfaState: mocks.mfa }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  redirect: (path: string) => { throw new Error('redirect:' + path); },
}));

import ForgotPasswordPage from '@/app/(auth)/forgot-password/page';
import LoginPage from '@/app/(auth)/login/page';
import RegisterPage from '@/app/(auth)/register/page';
import TwoFactorChallengePage from '@/app/(auth)/login/two-factor/page';

const AUTH_BUSY = 'System logowania jest chwilowo przeciążony. Spróbuj ponownie za minutę.';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.google.mockResolvedValue(false);
  mocks.closed.mockResolvedValue(false);
  mocks.mfa.mockResolvedValue({ status: 'challenge_required', user: { id: 'fixture-user', factors: [] } });
});

const page = async (render: (props: { searchParams: Promise<Record<string, string>> }) => Promise<React.ReactElement>, error: string) =>
  renderToStaticMarkup(await render({ searchParams: Promise.resolve({ error }) }));

describe('komunikaty limitu i awarii GoTrue', () => {
  it.each([
    ['logowanie, limit', LoginPage, 'auth_busy', AUTH_BUSY],
    ['logowanie, awaria', LoginPage, 'auth_unavailable', 'Nie udało się teraz zalogować. Spróbuj ponownie za chwilę.'],
    ['rejestracja, limit', RegisterPage, 'auth_busy', 'Rejestracja jest chwilowo przeciążona. Spróbuj ponownie za kilka minut.'],
    ['rejestracja, awaria', RegisterPage, 'auth_unavailable', 'Nie udało się teraz założyć konta. Spróbuj ponownie za chwilę.'],
    ['rejestracja, limit maili', RegisterPage, 'email_rate_limited', 'Przekroczono limit wysyłki maili. Poczekaj kilka minut i spróbuj ponownie.'],
    ['reset hasła, limit', ForgotPasswordPage, 'auth_busy', 'Wysyłka linków do resetu hasła jest chwilowo przeciążona. Spróbuj ponownie za minutę.'],
    ['2FA, limit', TwoFactorChallengePage, 'auth_busy', AUTH_BUSY],
  ] as const)('%s', async (_name, render, error, text) => {
    const html = await page(render as never, error);
    expect(html).toMatch(/role="alert"[^>]*data-tone="error"/);
    expect(html).toContain(text);
    expect(html).not.toContain(error);
  });
});
