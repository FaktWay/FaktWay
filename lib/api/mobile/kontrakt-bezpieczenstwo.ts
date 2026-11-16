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
