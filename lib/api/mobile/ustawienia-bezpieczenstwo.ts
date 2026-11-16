import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { NextResponse } from 'next/server';
import { z } from 'zod';

import type { MobileCaller } from '@/lib/api/mobile/auth';
import { createMobileLoginClient, resolveTarget } from '@/lib/api/mobile/db';
import type { KluczeDostepuOdpowiedz, KodHaslaOdpowiedz, UsuniecieKluczaOdpowiedz, ZmianaHaslaOdpowiedz } from '@/lib/api/mobile/kontrakt-bezpieczenstwo';
import { MOBILE_UNAVAILABLE, MobileUpstreamError, mobileError, mobileJson } from '@/lib/api/mobile/responses';
import { readJsonBody } from '@/lib/api/mobile/tresc';
import { logAudit } from '@/lib/audit/log';
import { listPasskeyDevices } from '@/lib/auth/passkey/devices';
import { validatePassword } from '@/lib/auth/password';
import { confirmAccountPassword } from '@/lib/auth/password-check';
import { checkPasskeyManageRateLimit } from '@/lib/rate-limit/passkey';
import { checkPasswordNonceSendRateLimit } from '@/lib/rate-limit/password';
import { isUuid } from '@/lib/supabase/active-org';

/**
 * Karta Bezpieczeństwo z telefonu (plan aplikacji mobilnej, M10c, część 2):
 * hasło i klucze dostępu tymi samymi warunkami co strona
 * (`app/(dashboard)/settings/security/actions.ts`, `app/api/auth/passkey/[id]`).
 *
 *  - 2FA: konto z TOTP przechodzi bramkę `authenticateMobileRequest` tylko po
 *    kodzie (AAL2), jak `passwordSession` i `requirePasskeyManagementSession`.
 *  - Hasło: aktualne sprawdza `confirmAccountPassword` ze wspólnym ze stroną
 *    limitem prób (Redis, bez niego odmowa), klientem logowania z kluczem
 *    serwisowym (bez captchy, jak `POST /logowanie`, D16); nowe przez
 *    `validatePassword` (siła i wycieki); zapis w GoTrue tokenem telefonu
 *    (`PUT /user` z `current_password`, jak `updateUser` strony), więc sesja
 *    telefonu zostaje. Kod z e-maila (`reauthentication_needed`) wysyła
 *    `POST /ustawienia/haslo/kod` z limitem wysyłek strony.
 *  - Klucze: lista i usunięcie klientem z tokenem (RLS 00159: własny klucz,
 *    AAL2 przy 2FA), limit `passkey_manage`, po usunięciu wylogowanie
 *    pozostałych sesji i wpis w dzienniku, jak strona. Dodanie zostaje na
 *    faktway.pl.
 *
 * Ponowienie: zmiana hasła na to samo kończy się `same_password` z GoTrue (422
 * pod polem `nowe`), choć hasło już jest zmienione; ponowione usunięcie klucza
 * to 404 (klucza już nie ma). Kod z e-maila wysyła się ponownie w limicie.
 */

const KONTRAKT = 'Treść żądania nie pasuje do kontraktu. Zaktualizuj aplikację FaktWay.';
const AUDYT_TELEFONU = { client: 'mobile' } as const;
const GOTRUE_TIMEOUT_MS = 15_000;

const hasloSchema = z
  .object({
    obecne: z.string().max(1024),
    nowe: z.string().max(1024),
    kod: z.string().max(20).optional(),
  })
  .strict();
const kodSchema = z.object({ obecne: z.string().max(1024) }).strict();

type Odmowa = { ok: false; response: NextResponse };

function niepoprawne(caller: MobileCaller, pole: 'obecne' | 'nowe' | 'kod', zdanie: string): NextResponse {
  return mobileError(422, 'settings_invalid', zdanie, caller.headers, pole);
}

function niedostepne(caller: MobileCaller): NextResponse {
  return mobileError(503, 'service_unavailable', 'Nie możemy teraz zmienić hasła. Spróbuj ponownie za chwilę.', caller.headers);
}

function zaDuzoProb(caller: MobileCaller, retryAfter: number | undefined, co: string): NextResponse {
  const sekundy = String(Math.max(1, retryAfter ?? 60));
  return mobileError(429, 'rate_limited', `${co} Spróbuj ponownie za ${sekundy} s.`, { ...caller.headers, 'Retry-After': sekundy });
}

/** Token z nagłówka: bramka już go sprawdziła w GoTrue (ten sam nagłówek, to samo żądanie). */
function tokenZadania(request: Request): string | null {
  const naglowek = request.headers.get('authorization') ?? '';
  const [schemat, token] = naglowek.split(' ');
  return schemat?.toLowerCase() === 'bearer' && token ? token : null;
}

/** Konto bez hasła (tylko Google) nie ma czego zmieniać; strona też pokazuje mu inną drogę. */
function bezHasla(caller: MobileCaller): NextResponse | null {
  if (caller.user.providers.includes('email') && caller.user.email) return null;
  return mobileError(403, 'forbidden', 'To konto loguje się przez Google i nie ma hasła w FaktWay. Hasło ustawisz na faktway.pl przez „Nie pamiętam hasła”.', caller.headers);
}

async function aktualneHaslo(caller: MobileCaller, haslo: string): Promise<Odmowa | null> {
  if (!haslo) return { ok: false, response: niepoprawne(caller, 'obecne', 'Wpisz aktualne hasło.') };
  const wynik = await confirmAccountPassword({
    userId: caller.user.id,
    email: caller.user.email ?? '',
    password: haslo,
    verifier: () => createMobileLoginClient() as SupabaseClient,
  }).catch(() => null);
  if (!wynik) return { ok: false, response: niedostepne(caller) };
  if (wynik.ok) return null;
  if (wynik.error === 'rate_limited') return { ok: false, response: zaDuzoProb(caller, wynik.retryAfter, 'Za dużo prób hasła.') };
  if (wynik.error === 'invalid_password') {
    return { ok: false, response: niepoprawne(caller, 'obecne', 'Aktualne hasło jest nieprawidłowe. Sprawdź je i spróbuj ponownie.') };
  }
  return { ok: false, response: niedostepne(caller) };
}

type OdpowiedzGoTrue = { ok: true; body: Record<string, unknown> } | { ok: false; status: number | null; code: string | null };

/** Żądanie do GoTrue tokenem telefonu (bez sesji w pamięci serwera); błąd sieci to `status: null`. */
async function goTrue(request: Request, sciezka: string, init: { method: 'GET' | 'PUT'; body?: unknown }): Promise<OdpowiedzGoTrue> {
  const token = tokenZadania(request);
  if (!token) return { ok: false, status: 401, code: 'bad_jwt' };
  const { url, anonKey } = resolveTarget({});
  try {
    const res = await fetch(`${url}/auth/v1${sciezka}`, {
      method: init.method,
      headers: { apikey: anonKey, authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(GOTRUE_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return { ok: true, body };
    const code = typeof body.error_code === 'string' ? body.error_code : typeof body.code === 'string' ? body.code : null;
    return { ok: false, status: res.status, code };
  } catch {
    return { ok: false, status: null, code: null };
  }
}

/** Odmowa GoTrue na odpowiedź telefonu; kody jak `passwordAuthError` strony. */
function odmowaGoTrue(caller: MobileCaller, blad: Extract<OdpowiedzGoTrue, { ok: false }>): NextResponse {
  switch (blad.code) {
    case 'reauthentication_needed':
      return mobileError(409, 'password_code_required', 'Ze względów bezpieczeństwa potrzebny jest kod z e-maila. Wyślemy go na adres konta.', caller.headers);
    case 'reauthentication_not_valid':
    case 'otp_expired':
      return niepoprawne(caller, 'kod', 'Kod z e-maila jest nieprawidłowy albo wygasł. Wyślij nowy i wpisz go od razu.');
    case 'current_password_required':
    case 'current_password_mismatch':
      return niepoprawne(caller, 'obecne', 'Aktualne hasło jest nieprawidłowe. Sprawdź je i spróbuj ponownie.');
    case 'same_password':
      return niepoprawne(caller, 'nowe', 'Nowe hasło musi być inne niż obecne.');
    case 'weak_password':
      return niepoprawne(caller, 'nowe', 'Hasło jest za słabe: co najmniej 12 znaków, mała i wielka litera, cyfra i znak specjalny.');
    case 'insufficient_aal':
      return mobileError(403, 'mfa_required', 'Podaj kod z aplikacji uwierzytelniającej.', caller.headers);
    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit':
    case 'over_sms_send_rate_limit':
      return zaDuzoProb(caller, undefined, 'Za dużo prób.');
    default:
      if (blad.status === 429) return zaDuzoProb(caller, undefined, 'Za dużo prób.');
      if (blad.status === 401 || blad.code === 'session_not_found' || blad.code === 'bad_jwt') {
        return mobileError(401, 'invalid_token', 'Sesja wygasła. Zaloguj się ponownie.', caller.headers);
      }
      return niedostepne(caller);
  }
}

/** `POST /api/mobile/v1/ustawienia/haslo`. */
export async function changePasswordFromMobile(caller: MobileCaller, request: Request): Promise<NextResponse> {
  const raw = await readJsonBody(request, caller.headers, { maxBytes: 5_000, tooLarge: 'Treść jest za długa.' });
  if (!raw.ok) return raw.response;
  const parsed = hasloSchema.safeParse(raw.value);
  if (!parsed.success) return mobileError(400, 'invalid_request', KONTRAKT, caller.headers);
  const { obecne, nowe, kod } = parsed.data;
  const bez = bezHasla(caller);
  if (bez) return bez;
  if (!nowe || nowe.length > 128) return niepoprawne(caller, 'nowe', 'Nowe hasło: od 12 do 128 znaków.');
  const nonce = kod?.trim() ?? '';
  if (nonce && !/^[0-9]{6,10}$/.test(nonce)) return niepoprawne(caller, 'kod', 'Kod z e-maila to od 6 do 10 cyfr.');

  // Kolejność jak `changePasswordAction`: aktualne hasło (limit prób), potem siła nowego, potem zapis.
  const odmowa = await aktualneHaslo(caller, obecne);
  if (odmowa) return odmowa.response;
  const sila = await validatePassword(nowe).catch(() => null);
  if (!sila) return niedostepne(caller);
  if (!sila.valid) return niepoprawne(caller, 'nowe', sila.error ?? 'Hasło jest za słabe.');

  const zapis = await goTrue(request, '/user', { method: 'PUT', body: { password: nowe, current_password: obecne, ...(nonce ? { nonce } : {}) } });
  if (!zapis.ok) return odmowaGoTrue(caller, zapis);
  if (zapis.body.id !== caller.user.id) return niedostepne(caller);

  await logAudit({ action: 'auth.password_changed', tenantId: null, userId: caller.user.id, metadata: AUDYT_TELEFONU });
  const odpowiedz: ZmianaHaslaOdpowiedz = { zmienione: true };
  return mobileJson(odpowiedz, 200, caller.headers);
}

/** `POST /api/mobile/v1/ustawienia/haslo/kod`. */
export async function sendPasswordCodeFromMobile(caller: MobileCaller, request: Request): Promise<NextResponse> {
  const raw = await readJsonBody(request, caller.headers, { maxBytes: 5_000, tooLarge: 'Treść jest za długa.' });
  if (!raw.ok) return raw.response;
  const parsed = kodSchema.safeParse(raw.value);
  if (!parsed.success) return mobileError(400, 'invalid_request', KONTRAKT, caller.headers);
  const bez = bezHasla(caller);
  if (bez) return bez;

  // Jak `requestPasswordChangeNonceAction`: limit wysyłek, aktualne hasło, potem wysyłka kodu.
  const limit = await checkPasswordNonceSendRateLimit(caller.user.id).catch(() => null);
  if (!limit || limit.unavailable) return niedostepne(caller);
  if (!limit.allowed) return zaDuzoProb(caller, limit.retryAfter, 'Kod już wysłaliśmy.');
  const odmowa = await aktualneHaslo(caller, parsed.data.obecne);
  if (odmowa) return odmowa.response;

  const wysylka = await goTrue(request, '/reauthenticate', { method: 'GET' });
  if (!wysylka.ok) return odmowaGoTrue(caller, wysylka);
  const odpowiedz: KodHaslaOdpowiedz = { wyslany: true };
  return mobileJson(odpowiedz, 200, caller.headers);
}

/** `GET /api/mobile/v1/ustawienia/klucze`. */
export async function passkeysForMobile(caller: MobileCaller): Promise<NextResponse> {
  let urzadzenia;
  try {
    urzadzenia = await listPasskeyDevices(caller.db, caller.user.id);
  } catch {
    throw new MobileUpstreamError('user_passkeys.read');
  }
  const odpowiedz: KluczeDostepuOdpowiedz = {
    klucze: urzadzenia.map((u) => ({ id: u.id, nazwa: u.deviceLabel, kopiaWChmurze: u.backedUp, dodany: u.createdAt, ostatnio: u.lastUsedAt })),
  };
  return mobileJson(odpowiedz, 200, caller.headers);
}

/** `POST /api/mobile/v1/ustawienia/klucze/{id}/usuniecie`. */
export async function removePasskeyFromMobile(caller: MobileCaller, request: Request, id: string): Promise<NextResponse> {
  if (!isUuid(id)) return mobileError(404, 'not_found', 'Nie ma takiego klucza dostępu.', caller.headers);
  const limit = await checkPasskeyManageRateLimit(caller.user.id);
  if (!limit.allowed) return zaDuzoProb(caller, limit.retryAfter, 'Za dużo zmian kluczy dostępu.');

  const usuniety = await caller.db.from('user_passkeys').delete().eq('id', id).eq('user_id', caller.user.id).select('id, device_label');
  if (usuniety.error) return mobileError(503, 'service_unavailable', MOBILE_UNAVAILABLE, caller.headers);
  const wiersz = (usuniety.data as Array<{ id: string; device_label: string }> | null)?.[0];
  if (!wiersz) return mobileError(404, 'not_found', 'Tego klucza dostępu już nie ma.', caller.headers);

  // Jak strona: klucz mógł zginąć razem z urządzeniem, więc pozostałe sesje konta wylogowujemy (ta zostaje).
  const token = tokenZadania(request);
  const wylogowanie = token ? await caller.db.auth.admin.signOut(token, 'others').catch(() => null) : null;
  const inneWylogowane = !!wylogowanie && !wylogowanie.error;

  await logAudit({
    action: 'auth.passkey_removed',
    tenantId: null,
    userId: caller.user.id,
    metadata: { passkey_id: wiersz.id, device_label: wiersz.device_label, others_signed_out: inneWylogowane, ...AUDYT_TELEFONU },
  });
  const odpowiedz: UsuniecieKluczaOdpowiedz = { usuniety: true, inneWylogowane };
  return mobileJson(odpowiedz, 200, caller.headers);
}
