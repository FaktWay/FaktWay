import 'server-only';

import type { NextResponse } from 'next/server';
import { z } from 'zod';

import { verifyMobileToken, type MobileCaller } from '@/lib/api/mobile/auth';
import type { Potwierdzenie2faOdpowiedz, Wlaczenie2faOdpowiedz, Wylaczenie2faOdpowiedz } from '@/lib/api/mobile/kontrakt-bezpieczenstwo';
import { mobileError, mobileJson } from '@/lib/api/mobile/responses';
import { readJsonBody } from '@/lib/api/mobile/tresc';
import {
  aktualneHaslo,
  goTrue,
  niedostepne,
  niepoprawne,
  odmowaGoTrue,
  zaDuzoProb,
} from '@/lib/api/mobile/ustawienia-bezpieczenstwo';
import { logAudit } from '@/lib/audit/log';
import { deleteAllRecoveryCodes } from '@/lib/auth/mfa-recovery';
import { checkMfaRateLimit } from '@/lib/rate-limit/mfa';

/**
 * Włączanie i wyłączanie 2FA (TOTP) z telefonu (plan aplikacji mobilnej, M10c,
 * część 2b) tymi samymi warunkami co strona
 * (`app/(dashboard)/settings/security/actions.ts`: `enrollTotpAction`,
 * `verifyTotpEnrollmentAction`, `unenrollTotpAction`):
 *
 *  - start: konto bez zweryfikowanego TOTP, limit prób 2FA (`checkMfaRateLimit`,
 *    bez Redisa odmowa), stare niepotwierdzone czynniki usuwane przed nowym,
 *    czynnik zakładany w GoTrue tokenem telefonu;
 *  - potwierdzenie: czynnik z listy konta (niepotwierdzony TOTP), kod z sześciu
 *    cyfr, limit prób, wyzwanie i kod w GoTrue tokenem telefonu, nowa sesja
 *    sprawdzona (AAL2, ten sam czynnik zweryfikowany); wpis `auth.mfa_enrolled`.
 *    Telefon dostaje nową sesję (`sesja`, jak `POST /kod`): GoTrue wydaje przy
 *    kodzie nowy refresh token i unieważnia stary, więc odświeżanie starym
 *    wylogowałoby telefon, gdy minie okno ponownego użycia (10 s). Kroki GoTrue
 *    mają po 5 s (jak `kod.ts`), żeby bramka i trzy kroki mieściły się w 15 s
 *    telefonu;
 *  - wyłączenie: sesja po kodzie (bramka), aktualne hasło (wspólny limit prób),
 *    kody ratunkowe usunięte PRZED czynnikami (nieudane sprzątanie nie zostawia
 *    starych kodów), czynniki TOTP usunięte tokenem telefonu; wpis
 *    `auth.mfa_unenrolled`. Częściowa porażka to `unenroll_incomplete` na
 *    stronie i tu 503 z prośbą o ponowienie (usuwanie jest idempotentne).
 *
 * Ponowienie: start zakłada nowy czynnik (stary niepotwierdzony znika); kod
 * wysłany drugi raz po udanym potwierdzeniu dostaje 422 (czynnik już
 * potwierdzony); wyłączenie ponowione po sukcesie to 422 (brak 2FA).
 * Sekret TOTP i kody nie trafiają do dziennika, Sentry ani logów.
 */

const KONTRAKT = 'Treść żądania nie pasuje do kontraktu. Zaktualizuj aplikację FaktWay.';
const AUDYT_TELEFONU = { client: 'mobile' } as const;
const KROK_GOTRUE_MS = 5_000;
const NIEDOSTEPNE_2FA = 'Nie możemy teraz zmienić weryfikacji dwuetapowej. Spróbuj ponownie za chwilę.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const potwierdzenieSchema = z.object({ idFaktora: z.string().max(64), kod: z.string().max(64) }).strict();
const wylaczenieSchema = z.object({ haslo: z.string().max(1024) }).strict();

type Faktor = { id: string; typ: string; status: string };

/** Czynniki konta z GoTrue (nie z treści tokenu): `GET /user` tokenem telefonu. */
async function faktoryKonta(request: Request, timeoutMs?: number): Promise<{ ok: true; faktory: Faktor[] } | { ok: false; blad: Parameters<typeof odmowaGoTrue>[1] }> {
  const odp = await goTrue(request, '/user', { method: 'GET', timeoutMs });
  if (!odp.ok) return { ok: false, blad: odp };
  const lista = Array.isArray(odp.body.factors) ? odp.body.factors : [];
  const faktory = lista.flatMap((f): Faktor[] => {
    const o = f as Record<string, unknown>;
    return typeof o.id === 'string' && typeof o.factor_type === 'string' && typeof o.status === 'string' ? [{ id: o.id, typ: o.factor_type, status: o.status }] : [];
  });
  return { ok: true, faktory };
}

async function limitProb(caller: MobileCaller): Promise<NextResponse | null> {
  const limit = await checkMfaRateLimit(caller.user.id).catch(() => null);
  if (!limit || limit.unavailable) return mobileError(503, 'service_unavailable', 'Nie możemy teraz sprawdzić kodu. Spróbuj ponownie za chwilę.', caller.headers);
  if (!limit.allowed) return zaDuzoProb(caller, limit.retryAfter, 'Zbyt wiele prób.');
  return null;
}

/** `POST /api/mobile/v1/ustawienia/2fa/start`. */
export async function startTotpFromMobile(caller: MobileCaller, request: Request): Promise<NextResponse> {
  if (caller.mfaEnabled) return niepoprawne(caller, null, 'Weryfikacja dwuetapowa jest już włączona.');
  const odmowaLimitu = await limitProb(caller);
  if (odmowaLimitu) return odmowaLimitu;

  const konto = await faktoryKonta(request);
  if (!konto.ok) return odmowaGoTrue(caller, konto.blad);
  // Jak strona: stare niepotwierdzone czynniki TOTP znikają, a porażka sprzątania zatrzymuje operację.
  for (const f of konto.faktory.filter((x) => x.typ === 'totp' && x.status === 'unverified')) {
    const usuniety = await goTrue(request, `/factors/${encodeURIComponent(f.id)}`, { method: 'DELETE' });
    if (!usuniety.ok) return odmowaGoTrue(caller, usuniety);
  }
  const nowy = await goTrue(request, '/factors', { method: 'POST', body: { factor_type: 'totp', friendly_name: `FaktWay ${new Date().toISOString().slice(0, 10)}` } });
  if (!nowy.ok) return odmowaGoTrue(caller, nowy);
  const totp = (nowy.body.totp ?? {}) as Record<string, unknown>;
  if (typeof nowy.body.id !== 'string' || typeof totp.secret !== 'string' || typeof totp.uri !== 'string') return niedostepne(caller, NIEDOSTEPNE_2FA);
  const odpowiedz: Wlaczenie2faOdpowiedz = { idFaktora: nowy.body.id, sekret: totp.secret, uri: totp.uri };
  return mobileJson(odpowiedz, 200, caller.headers);
}

/** `POST /api/mobile/v1/ustawienia/2fa/potwierdzenie`. */
export async function confirmTotpFromMobile(caller: MobileCaller, request: Request): Promise<NextResponse> {
  const raw = await readJsonBody(request, caller.headers, { maxBytes: 2_000, tooLarge: 'Treść jest za długa.' });
  if (!raw.ok) return raw.response;
  const parsed = potwierdzenieSchema.safeParse(raw.value);
  if (!parsed.success) return mobileError(400, 'invalid_request', KONTRAKT, caller.headers);
  const kod = parsed.data.kod.trim();
  if (caller.mfaEnabled || !UUID.test(parsed.data.idFaktora)) return niepoprawne(caller, null, 'To włączanie 2FA wygasło. Zacznij od nowa.');
  // Kod spoza sześciu cyfr: bez zużycia próby i bez GoTrue (jak strona).
  if (!/^[0-9]{6}$/.test(kod)) return niepoprawne(caller, 'kod', 'Wpisz sześciocyfrowy kod z aplikacji uwierzytelniającej.');

  const konto = await faktoryKonta(request, KROK_GOTRUE_MS);
  if (!konto.ok) return odmowaGoTrue(caller, konto.blad);
  const faktor = konto.faktory.find((f) => f.id === parsed.data.idFaktora && f.typ === 'totp' && f.status === 'unverified');
  if (!faktor) return niepoprawne(caller, null, 'To włączanie 2FA wygasło. Zacznij od nowa.');
  const odmowaLimitu = await limitProb(caller);
  if (odmowaLimitu) return odmowaLimitu;

  const wyzwanie = await goTrue(request, `/factors/${encodeURIComponent(faktor.id)}/challenge`, { method: 'POST', body: {}, timeoutMs: KROK_GOTRUE_MS });
  if (!wyzwanie.ok) return odmowaGoTrue(caller, wyzwanie);
  if (typeof wyzwanie.body.id !== 'string') return niedostepne(caller, NIEDOSTEPNE_2FA);
  const weryfikacja = await goTrue(request, `/factors/${encodeURIComponent(faktor.id)}/verify`, { method: 'POST', body: { challenge_id: wyzwanie.body.id, code: kod }, timeoutMs: KROK_GOTRUE_MS });
  if (!weryfikacja.ok) {
    // GoTrue: 400 i 422 to zły kod albo wygasłe wyzwanie; reszta to nie wina klienta.
    if (weryfikacja.status === 400 || weryfikacja.status === 422) {
      return niepoprawne(caller, 'kod', 'Kod nieprawidłowy. Sprawdź godzinę w telefonie i wpisz aktualny kod z aplikacji.');
    }
    return odmowaGoTrue(caller, weryfikacja);
  }

  // Sama odpowiedź GoTrue nie wystarcza: nowa sesja ma być AAL2 tego samego konta z zweryfikowanym TOTP.
  const noweToken = typeof weryfikacja.body.access_token === 'string' ? weryfikacja.body.access_token : null;
  const stan = noweToken ? await verifyMobileToken(noweToken).catch(() => null) : null;
  if (!stan || stan.status !== 'ok' || stan.user.id !== caller.user.id || stan.claims.aal !== 'aal2' || !stan.mfaEnabled) return niedostepne(caller, NIEDOSTEPNE_2FA);

  await logAudit({ action: 'auth.mfa_enrolled', tenantId: null, userId: caller.user.id, metadata: { factor_id: faktor.id, ...AUDYT_TELEFONU } });
  const odswiezony = typeof weryfikacja.body.refresh_token === 'string' ? weryfikacja.body.refresh_token : null;
  if (!noweToken || !odswiezony) return niedostepne(caller, NIEDOSTEPNE_2FA);
  const odpowiedz: Potwierdzenie2faOdpowiedz = { wlaczone: true, sesja: { accessToken: noweToken, refreshToken: odswiezony } };
  return mobileJson(odpowiedz, 200, caller.headers);
}

/** `POST /api/mobile/v1/ustawienia/2fa/wylaczenie`. */
export async function disableTotpFromMobile(caller: MobileCaller, request: Request): Promise<NextResponse> {
  const raw = await readJsonBody(request, caller.headers, { maxBytes: 5_000, tooLarge: 'Treść jest za długa.' });
  if (!raw.ok) return raw.response;
  const parsed = wylaczenieSchema.safeParse(raw.value);
  if (!parsed.success) return mobileError(400, 'invalid_request', KONTRAKT, caller.headers);
  // Bramka przepuszcza konto z 2FA tylko po kodzie; konto bez 2FA nie ma czego wyłączać.
  if (!caller.mfaEnabled) return niepoprawne(caller, null, 'Weryfikacja dwuetapowa nie jest włączona.');
  if (!caller.user.providers.includes('email') || !caller.user.email) {
    return mobileError(403, 'forbidden', 'To konto loguje się przez Google i nie ma hasła w FaktWay. Wyłączysz 2FA na faktway.pl po ustawieniu hasła.', caller.headers);
  }

  const odmowa = await aktualneHaslo(caller, parsed.data.haslo, { zmianaHasla: false, niedostepne: NIEDOSTEPNE_2FA });
  if (odmowa) return odmowa.response;

  const konto = await faktoryKonta(request);
  if (!konto.ok) return odmowaGoTrue(caller, konto.blad);
  // Tylko TOTP; telefon i WebAuthn zostają (jak strona).
  const totp = konto.faktory.filter((f) => f.typ === 'totp');
  if (!totp.some((f) => f.status === 'verified')) return niedostepne(caller, NIEDOSTEPNE_2FA);

  // Nieudane sprzątanie kodów ratunkowych zatrzymuje wyłączanie: stare kody nie mogą zostać po wyłączeniu TOTP.
  const sprzatniete = await deleteAllRecoveryCodes(caller.user.id).then(() => true, () => false);
  if (!sprzatniete) return niedostepne(caller, NIEDOSTEPNE_2FA);

  let usuniete = 0;
  for (const f of totp) {
    const wynik = await goTrue(request, `/factors/${encodeURIComponent(f.id)}`, { method: 'DELETE' });
    if (!wynik.ok) {
      // Czynniki usuwamy po kolei, bez wycofania: ponowienie dokończy resztę.
      return usuniete > 0
        ? mobileError(503, 'service_unavailable', 'Wyłączyliśmy tylko część czynników 2FA. Spróbuj ponownie, żeby dokończyć.', caller.headers)
        : odmowaGoTrue(caller, wynik);
    }
    usuniete += 1;
  }

  await logAudit({ action: 'auth.mfa_unenrolled', tenantId: null, userId: caller.user.id, metadata: { factor_type: 'totp', removed_count: usuniete, ...AUDYT_TELEFONU } });
  const odpowiedz: Wylaczenie2faOdpowiedz = { wylaczone: true };
  return mobileJson(odpowiedz, 200, caller.headers);
}
