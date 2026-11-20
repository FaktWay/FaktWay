import 'server-only';

import type { NextResponse } from 'next/server';
import { z } from 'zod';

import type { MobileCaller } from '@/lib/api/mobile/auth';
import type { CertyfikatKsefOdpowiedz } from '@/lib/api/mobile/kontrakt-bezpieczenstwo';
import { mobileError, mobileJson } from '@/lib/api/mobile/responses';
import { readJsonBody } from '@/lib/api/mobile/tresc';
import { niedostepne, niepoprawne } from '@/lib/api/mobile/ustawienia-bezpieczenstwo';
import { uploadKsefCertificate, type ConnectFailureReason } from '@/lib/ksef/upload-certificate';

/**
 * Wgranie certyfikatu KSeF z telefonu (plan aplikacji mobilnej, M10c, część
 * 2b) tą samą logiką co kreator strony (`lib/ksef/upload-certificate.ts`:
 * sprawdzenia lokalne plików, limit 5 prób na godzinę, logowanie do KSeF,
 * własność NIP, szyfrowanie, RPC `finalize_ksef_certificate_claim` z audytem).
 * Bramka jak `uploadCertificateAction`: tylko właściciel aktywnej firmy i
 * konto z włączonym 2FA po kodzie (konto z TOTP w sesji AAL1 odrzuca bramka
 * telefonu, `mfa_required`; konto bez 2FA dostaje tu 403 z drogą do
 * Bezpieczeństwa). Pliki to PEM (tekst) jako base64 bajtów; klucz, hasło do
 * klucza i certyfikat nie trafiają do dziennika, Sentry ani logów.
 *
 * Ponowienie: zapis jest jedną operacją w RPC (claim, poświadczenia, audyt);
 * powtórka po zerwanym połączeniu zużywa kolejną próbę z limitu i kończy się
 * „Certyfikat zaktualizowany”.
 */

const MAX_BODY_BYTES = 300_000;
const KONTRAKT = 'Treść żądania nie pasuje do kontraktu. Zaktualizuj aplikację FaktWay.';
const schema = z.object({ certyfikat: z.string().max(200_000), klucz: z.string().max(200_000), haslo: z.string().max(256).optional() }).strict();

/** Powód z logiki strony na pole formularza telefonu; bez pola: zdanie stoi nad przyciskiem. */
const POLE: Partial<Record<ConnectFailureReason, 'certyfikat' | 'klucz' | 'haslo'>> = {
  cert_unreadable: 'certyfikat',
  cert_expired: 'certyfikat',
  cert_not_yet_valid: 'certyfikat',
  cert_offline: 'certyfikat',
  key_unreadable: 'klucz',
  key_unsupported: 'klucz',
  key_mismatch: 'klucz',
  password_required: 'haslo',
  password_wrong: 'haslo',
};
/** Awaria po naszej albo KSeF stronie, nie wina plików: telefon ponawia. */
const AWARIA: ReadonlySet<ConnectFailureReason> = new Set(['unavailable', 'internal_error', 'save_failed']);

/** `POST /api/mobile/v1/ustawienia/ksef`. */
export async function uploadCertificateFromMobile(caller: MobileCaller, request: Request): Promise<NextResponse> {
  if (!caller.org) throw new Error('Trasa certyfikatu KSeF bez firmy (org: required)');
  if (caller.org.role !== 'owner') {
    return mobileError(403, 'forbidden', 'Certyfikat KSeF zmienia właściciel firmy.', caller.headers);
  }
  if (!caller.mfaEnabled) {
    return mobileError(403, 'forbidden', 'Przed zmianą certyfikatu KSeF włącz weryfikację dwuetapową w Bezpieczeństwie.', caller.headers);
  }
  const raw = await readJsonBody(request, caller.headers, { maxBytes: MAX_BODY_BYTES, tooLarge: 'Pliki są za duże jak na certyfikat KSeF.' });
  if (!raw.ok) return raw.response;
  const parsed = schema.safeParse(raw.value);
  if (!parsed.success) return mobileError(400, 'invalid_request', KONTRAKT, caller.headers);

  const wynik = await uploadKsefCertificate(
    { supabase: caller.db, tenantId: caller.org.tenantId, userId: caller.user.id },
    { certificate: parsed.data.certyfikat, privateKey: parsed.data.klucz, password: parsed.data.haslo },
  );
  if (wynik.success) {
    const odpowiedz: CertyfikatKsefOdpowiedz = {
      polaczono: true,
      pierwszePolaczenie: wynik.wasFirstClaim,
      wazneDo: wynik.validTo.slice(0, 10),
      komunikat: wynik.message,
    };
    return mobileJson(odpowiedz, 200, caller.headers);
  }

  if (wynik.reason === 'rate_limited') {
    const minuty = Number(/za około (\d+) min/.exec(wynik.error)?.[1] ?? '10');
    const sekundy = String(Math.max(60, minuty * 60));
    return mobileError(429, 'rate_limited', wynik.error, { ...caller.headers, 'Retry-After': sekundy });
  }
  if (AWARIA.has(wynik.reason)) {
    // Zdanie logiki strony (KSeF nie odpowiada, nie udało się zapisać); telefon ponawia jak przy 503.
    return mobileError(503, 'service_unavailable', wynik.error, caller.headers);
  }
  if (wynik.reason === 'forbidden' || wynik.reason === 'mfa_required') return niedostepne(caller);
  return niepoprawne(caller, POLE[wynik.reason] ?? null, wynik.error);
}
