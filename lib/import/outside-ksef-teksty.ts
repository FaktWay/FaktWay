/**
 * Teksty i znacznik faktury wystawionej poza KSeF dla klienta (krok 1.6,
 * część 2b, PR C; D24 z `DECYZJE-2026-11-25.md`). Tekst D24 mówi tylko, co robi
 * aplikacja, i podaje fakt z ustawy, bez porady; do potwierdzenia przez prawnika
 * przed włączeniem funkcji klientom (wyłącznik `outsideKsefImportEnabled`).
 */

/** Wartość `invoices.origin` wpisu spoza KSeF (migracja 00221). */
export const ORIGIN_SPOZA_KSEF = 'outside_ksef';

/** Napis przy fakturze: na liście, w szczegółach i na wydruku PDF (D24). */
export const SPOZA_KSEF_OZNACZENIE = 'Poza KSeF';

/** Tekst z D24: ekran dopisywania, karta faktury i pomoc. */
export const SPOZA_KSEF_OPIS =
  'Faktura dodana tutaj trafia tylko do historii FaktWay: liczy się w KPiR albo w ewidencji przychodów, w JPK_V7M i na Pulpicie. ' +
  'FaktWay jej nie wystawia i nie wysyła do KSeF. Od 1 stycznia 2027 r. faktury dla firm wystawia się w KSeF.';

/** Dopisek na wydruku PDF wpisu spoza KSeF (kopia dokumentu klienta, nie faktura wystawiona w FaktWay). */
export const SPOZA_KSEF_PDF_DOPISEK =
  'Poza KSeF. To kopia faktury wystawionej poza KSeF, dopisana do historii FaktWay; FaktWay jej nie wystawił i nie wysłał do KSeF.';

export function jestFakturaSpozaKsef(origin: string | null | undefined): boolean {
  return origin === ORIGIN_SPOZA_KSEF;
}
