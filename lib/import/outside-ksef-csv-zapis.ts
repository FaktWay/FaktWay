import 'server-only';

import type { CsvSource } from '@/lib/import/csv-parsers';
import { logAudit } from '@/lib/audit/log';
import {
  type OdrzuconaFakturaCsv,
  przygotujCsvSpozaKsef,
} from '@/lib/import/outside-ksef-csv';
import {
  BLAD_ZAPISU_SPOZA_KSEF,
  dodajFakturaSpozaKsef,
  type KontekstSpozaKsef,
} from '@/lib/import/outside-ksef-zapis';
import { czySpozaKsefWlaczone, SPOZA_KSEF_NIEZNANE, SPOZA_KSEF_WYLACZONE } from '@/lib/import/outside-ksef-wylacznik';

/**
 * Wlicz do ksiąg faktury z pliku CSV (krok 1.6, część 2b, D25c): dwa kroki.
 * Bez `potwierdzam` funkcja nic nie zapisuje i zwraca podgląd (ile faktur
 * wejdzie do KPiR/ewidencji, JPK_V7M i na Pulpit, ile zostaje poza nimi i
 * dlaczego). Z `potwierdzam` zapisuje każdą fakturę tą samą drogą co formularz
 * (`dodajFakturaSpozaKsef`: wyłącznik, daty 2026, środowisko firmy, numer
 * unikalny w firmie, audyt wpisu). Rolę (właściciel, administrator) sprawdza
 * wywołujący.
 *
 * Ponowienie od zera: po każdym kroku ten sam plik wgrany drugi raz kończy się
 * „faktura o tym numerze jest już w historii” dla zapisanych (unikalny numer w
 * firmie), a niezapisane dopisują się dalej, więc nic nie dubluje się w księgach.
 * Błąd jednej faktury nie przerywa pozostałych; wynik wylicza każdą z powodem.
 * Audyt zbiorczy zapisuje się po pętli (jego brak nie cofa wpisów, każdy ma własny).
 */

export const CSV_LIMIT_FAKTUR = 500;
export const CSV_LIMIT_BAJTOW = 1_000_000;
export const CSV_ZA_DUZY =
  'Plik jest za duży do wliczenia do ksiąg za jednym razem. Wyeksportuj krótszy okres (np. miesiąc) i wgraj pliki po kolei.';
export const CSV_BRAK_FIRMY = 'Uzupełnij NIP firmy w Ustawieniach, a potem wgraj plik. Bez niego nie sprawdzimy, czy to Twoje faktury.';

export interface WynikWliczeniaCsv {
  success: true;
  /** Faktury, które wejdą (podgląd) albo weszły (zapis) do ksiąg. */
  wliczone: number;
  /** Faktury, które zostają poza księgami z powodem; w zapisie także te, których zapis się nie udał. */
  odrzucone: OdrzuconaFakturaCsv[];
  ostrzezeniaPliku: string[];
  zapisano: boolean;
}

export type WynikWliczeniaCsvAkcji =
  | WynikWliczeniaCsv
  | { success: false; error: string };

export async function wliczCsvDoKsiegSpozaKsef(
  ctx: KontekstSpozaKsef,
  wejscie: { content: string; source: CsvSource },
  opcje: { potwierdzam?: boolean } = {},
): Promise<WynikWliczeniaCsvAkcji> {
  try {
    if (!(await czySpozaKsefWlaczone())) return { success: false, error: SPOZA_KSEF_WYLACZONE };
  } catch {
    return { success: false, error: SPOZA_KSEF_NIEZNANE };
  }
  if (Buffer.byteLength(wejscie.content, 'utf8') > CSV_LIMIT_BAJTOW) return { success: false, error: CSV_ZA_DUZY };

  const { data: firma, error: firmaBlad } = await ctx.client
    .from('tenants')
    .select('nip')
    .eq('id', ctx.tenantId)
    .maybeSingle();
  if (firmaBlad || !firma) return { success: false, error: BLAD_ZAPISU_SPOZA_KSEF };
  const nip = String((firma as { nip: unknown }).nip ?? '').replace(/\D/g, '');
  if (nip.length !== 10) return { success: false, error: CSV_BRAK_FIRMY };

  const podglad = przygotujCsvSpozaKsef(wejscie.content, wejscie.source, nip);
  if (podglad.odmowaPliku) return { success: false, error: podglad.odmowaPliku };
  if (podglad.wpisy.length > CSV_LIMIT_FAKTUR) return { success: false, error: CSV_ZA_DUZY };

  if (!opcje.potwierdzam) {
    return {
      success: true,
      wliczone: podglad.wpisy.length,
      odrzucone: podglad.odrzucone,
      ostrzezeniaPliku: podglad.ostrzezeniaPliku,
      zapisano: false,
    };
  }

  const odrzucone = [...podglad.odrzucone];
  let wliczone = 0;
  for (const wpis of podglad.wpisy) {
    const wynik = await dodajFakturaSpozaKsef(ctx, wpis);
    if (wynik.success) wliczone++;
    else odrzucone.push({ numer: wpis.number, powod: wynik.error });
  }

  await logAudit({
    action: 'invoice.outside_ksef_csv_imported',
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    entityType: 'tenant',
    entityId: ctx.tenantId,
    metadata: { source: wejscie.source, included: wliczone, notIncluded: odrzucone.length },
  });

  return { success: true, wliczone, odrzucone, ostrzezeniaPliku: podglad.ostrzezeniaPliku, zapisano: true };
}
