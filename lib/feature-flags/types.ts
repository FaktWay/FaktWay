export type PerTenantFlag =
  | 'co_pilot_enabled'
  | 'magic_import_enabled'
  | 'exports_enabled'
  /** Pilotaż modułu księgowości JDG (00165, plan księgowości K8); obszary rozstrzyga `lib/ksiegowosc/wylacznik.ts`. */
  | 'ksiegowosc_enabled';

export type GlobalFlag =
  | 'killAllKsefSubmissions'
  | 'maintenanceMode'
  | 'disableSignups'
  /** Zatrzymuje CAŁEGO agenta FLO — pierwszy krok runbooku incydentowego. */
  | 'killFloAgent'
  /** AAL2 dla owner/admin przy KSeF, certyfikacie i płatnościach (AUD-65). */
  | 'requireMfaForSensitive'
  /** Zatrzymuje CAŁY moduł księgowości (plan księgowości JDG, D10; wiersz z 00165). */
  | 'killKsiegowosc'
  /**
   * WŁĄCZNIK publicznego API `/api/v1` i kluczy API w Ustawieniach (00181, krok 7.1).
   * Odwrotnie niż `kill*`: brak wiersza albo błąd odczytu = API zamknięte.
   */
  | 'publicApiEnabled'
  /**
   * WŁĄCZNIK uprawnień biura rachunkowego w KSeF nadawanych z FaktWay (00195,
   * krok 6.2, część 4). Odwrotnie niż `kill*`: brak wiersza albo błąd odczytu = wyłączone.
   */
  | 'ksefPermissionsEnabled'
  /**
   * WŁĄCZNIK faktury w cenach brutto (RP-FA-BRUTTO-01, B4.0 zasada 2 planu żelaznego
   * filtra). Bez migracji: brak wiersza, `false` albo błąd odczytu = wyłączone.
   * Odczyt i miejsca odmowy: `lib/invoices/ceny-brutto-wylacznik.ts`; włączenie:
   * `docs/runbooks/ceny-brutto-wylacznik.md`.
   */
  | 'grossPricesEnabled'
  /**
   * WŁĄCZNIK potwierdzenia salda z kontrahentem (krok 2.9 cz. 2, D27 i D28 ze średnią
   * pewnością). Wiersz wyłączony z 00215; brak wiersza, `false` albo błąd odczytu =
   * wyłączone, a funkcje bazy odmawiają `disabled`. Odczyt: `lib/saldo/wylacznik.ts`.
   */
  | 'balanceConfirmationsEnabled';
