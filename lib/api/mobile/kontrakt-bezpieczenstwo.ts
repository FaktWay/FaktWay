/**
 * Kontrakt karty Bezpieczeństwo z telefonu (plan aplikacji mobilnej, M10c,
 * część 2). Czyta go też aplikacja przez Metro
 * (`mobile/src/lib/api/kontrakt-bezpieczenstwo.ts`), więc plik nie ma importów
 * (pilnuje `tests/unit/mobile-api-bezpieczenstwo.test.ts`).
 *
 * Konto, nie firma: trasy bez `X-Active-Org`. Konto z 2FA przechodzi bramkę
 * tylko po kodzie (AAL2), jak operacje wrażliwe strony.
 */

// ─── Hasło ───────────────────────────────────────────────────────────

/**
 * `POST /api/mobile/v1/ustawienia/haslo`: zmiana hasła jak na stronie (aktualne
 * hasło ze wspólnym limitem prób, nowe sprawdzone także w znanych wyciekach).
 * `kod`: sześć do dziesięciu cyfr z e-maila, gdy serwer odpowiedział 409
 * `password_code_required`. Odmowy danych: 422 `settings_invalid` z polem
 * `obecne`, `nowe` albo `kod`.
 */
export interface ZmianaHaslaZadanie {
  obecne: string;
  nowe: string;
  kod?: string;
}

/** `POST /api/mobile/v1/ustawienia/haslo/kod`: wysyła kod na e-mail konta; hasła nie zmienia. */
export interface KodHaslaZadanie {
  obecne: string;
}

export interface ZmianaHaslaOdpowiedz {
  zmienione: true;
}

export interface KodHaslaOdpowiedz {
  wyslany: true;
}

// ─── Klucze dostępu (passkey) ─────────────────────────────────────────

/**
 * `GET /api/mobile/v1/ustawienia/klucze`: klucze dostępu konta (Face ID, Touch
 * ID, klucz sprzętowy na stronie). Dodanie klucza jest na faktway.pl: w
 * aplikacji wymagałoby powiązanej domeny w koncie Apple.
 */
export interface KluczeDostepuOdpowiedz {
  klucze: Array<{ id: string; nazwa: string; kopiaWChmurze: boolean; dodany: string; ostatnio: string | null }>;
}

/**
 * `POST /api/mobile/v1/ustawienia/klucze/{id}/usuniecie`: usuwa klucz i, jak
 * strona, wylogowuje pozostałe sesje konta (ta zostaje). `inneWylogowane:
 * false`: klucz usunięty, ale wylogowania nie potwierdzono; klient wyloguje
 * inne urządzenia ręcznie na faktway.pl.
 */
export interface UsuniecieKluczaOdpowiedz {
  usuniety: true;
  inneWylogowane: boolean;
}

// ─── 2FA (TOTP), M10c część 2b ───────────────────────────────────────

/**
 * `POST /api/mobile/v1/ustawienia/2fa/start`: zaczyna włączanie 2FA (jak
 * `enrollTotpAction` strony): czynnik w stanie „niepotwierdzony”. Telefon
 * pokazuje `sekret` do wpisania w aplikacji uwierzytelniającej i `uri`
 * (`otpauth://`), które otwiera ją na tym samym telefonie. Konto z włączonym
 * 2FA dostaje 422 `settings_invalid`.
 */
export interface Wlaczenie2faOdpowiedz {
  idFaktora: string;
  sekret: string;
  uri: string;
}

/** `POST /api/mobile/v1/ustawienia/2fa/potwierdzenie`: pierwszy kod z aplikacji kończy włączanie. Zły kod: 422 `settings_invalid` z polem `kod`. */
export interface Potwierdzenie2faZadanie {
  idFaktora: string;
  kod: string;
}

export interface Potwierdzenie2faOdpowiedz {
  wlaczone: true;
}

/**
 * `POST /api/mobile/v1/ustawienia/2fa/wylaczenie`: wyłączenie 2FA po aktualnym
 * haśle (jak `unenrollTotpAction`). Wymaga sesji po kodzie.
 */
export interface Wylaczenie2faZadanie {
  haslo: string;
}

export interface Wylaczenie2faOdpowiedz {
  wylaczone: true;
}

// ─── Certyfikat KSeF, M10c część 2b ──────────────────────────────────

/**
 * `POST /api/mobile/v1/ustawienia/ksef`: wgranie certyfikatu KSeF jak w
 * kreatorze strony. Pliki (PEM, tekst) jako base64 bajtów. Tylko właściciel,
 * z włączonym 2FA po kodzie; limit 5 prób na godzinę.
 */
export interface CertyfikatKsefZadanie {
  certyfikat: string;
  klucz: string;
  /** Tylko gdy klucz jest zaszyfrowany. Nigdzie nie jest zapisywane. */
  haslo?: string;
}

export interface CertyfikatKsefOdpowiedz {
  polaczono: true;
  pierwszePolaczenie: boolean;
  /** RRRR-MM-DD. */
  wazneDo: string;
  komunikat: string;
}
