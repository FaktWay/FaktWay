/**
 * FZ-022, decyzja D29 (`docs/koordynacja/DECYZJE-2026-11-25.md`, RP-KOSZT-01):
 * kopia faktury z KSeF (zdjęcie, wpis ręczny, import) łączy się z kosztem
 * z KSeF tego samego dokumentu (z faktury przyjętej w środowisku KSeF
 * aplikacji), gdy jest dokładnie jedna, ma to samo brutto, a miesiące obu
 * kosztów nie są złożone. Wtedy do KPiR, VAT, JPK_V7M i kart kosztów idzie koszt z KSeF
 * (kwoty, data, numer KSeF), a kopia zostaje na liście poza KPiR
 * (`is_deductible = false`); kategoria nadana kopii ręcznie przechodzi na koszt
 * z KSeF. Kilka kopii, inne brutto albo miesiąc złożony: bez łączenia, zadanie
 * „Połącz koszty” i odmowa odczytu z #839 (`lib/expenses/jeden-koszt-dokumentu.ts`)
 * jak dotąd.
 *
 * Klucz dokumentu, wybór kandydatów, bezpiecznik miesiąca złożonego, blokady
 * i audyt są w bazie (00215, `link_ksef_expense_copy`), w jednej transakcji.
 * Ponowienie od zera: połączenie albo zadanie już jest, więc drugie wywołanie
 * nic nie zmienia (`already_linked`, `candidates` bez nowych wierszy).
 *
 * Bez włączania u klientów, dopóki Bartosz nie potwierdzi (D29: pewność średnia
 * dla przypadków brzegowych, do potwierdzenia przez księgową): przełącznik
 * `KOSZTY_LACZ_KOPIE_KSEF=true` w workerze; bez niego nic się nie łączy.
 * Decyzja D68: łączy tylko przy KSeF produkcyjnym (`KSEF_ENV=production`).
 * Dokumenty z KSeF TEST nie są fakturami i nie wywołują skutków prawnych
 * (Podręcznik KSeF 2.0 cz. II, pkt 3.2.1), więc połączenie z nimi wyjęłoby
 * prawdziwy koszt z KPiR i JPK_V7M. Przy innym środowisku przełącznik nie
 * działa: ostrzeżenie w logu, bez łączenia i bez błędu (worker startuje
 * normalnie, ponowienie niczego nie zmienia).
 * Ścieżka operatora: `docs/runbooks/koszt-dwa-razy.md`.
 */

import type { KsefEnvironment } from '@/types/ksef';

export const PRZELACZNIK_LACZENIA_KOPII = 'KOSZTY_LACZ_KOPIE_KSEF';

/** Czy łączenie kopii z kosztem z KSeF jest włączone (domyślnie nie). */
export function laczenieKopiiWlaczone(): boolean {
  return process.env[PRZELACZNIK_LACZENIA_KOPII] === 'true';
}

/** Wynik `link_ksef_expense_copy` (00215) albo `wylaczone` bez przełącznika. */
export type WynikLaczeniaKopii =
  | 'wylaczone'
  | 'inne_srodowisko'
  | 'linked'
  | 'candidates'
  | 'already_linked'
  | 'dismissed'
  | 'no_candidates'
  | 'no_ksef_original'
  | 'ambiguous_ksef'
  | 'not_deductible'
  | 'not_applicable';

/** Funkcja 00215 jeszcze nie jest w wygenerowanych typach bazy (types/database.ts po wgraniu migracji). */
interface LaczenieKopiiRpc {
  rpc(
    name: 'link_ksef_expense_copy',
    args: { p_tenant_id: string; p_expense_id: string; p_ksef_environment: KsefEnvironment; p_auto_link: boolean },
  ): PromiseLike<{ data: unknown; error: { message: string; code?: string | null } | null }>;
}

/**
 * Po zapisie kosztu (z KSeF albo kopii): łączy kopię z kosztem z KSeF albo
 * zapisuje zadanie dla klienta. Klient service_role (runner). Koszt z KSeF
 * liczy się tylko z faktury przyjętej w środowisku `environment` (jak odczyty,
 * `filterExpensesForKsefEnvironment`); bez skonfigurowanego środowiska nic się
 * nie łączy. Błąd bazy rzuca, a wołający decyduje, czy to ponowienie, czy
 * tylko wpis w Sentry.
 */
export async function polaczKopieFakturyKsef(
  supabase: unknown,
  w: {
    tenantId: string;
    expenseId: string;
    environment: KsefEnvironment | null;
    logger?: { warn(message: string, meta?: Record<string, unknown>): void };
  },
): Promise<WynikLaczeniaKopii> {
  if (!laczenieKopiiWlaczone()) return 'wylaczone';
  if (!w.environment) return 'not_applicable';
  // D68: tylko KSeF produkcyjny. Fail-closed: kopia i koszt zostają jak są, a odmowa odczytu (#839) chroni KPiR i JPK.
  if (w.environment !== 'production') {
    w.logger?.warn('Łączenie kopii faktury z kosztem z KSeF pominięte: działa tylko przy KSEF_ENV=production (D68)', {
      tenantId: w.tenantId,
      expenseId: w.expenseId,
      environment: w.environment,
    });
    return 'inne_srodowisko';
  }
  const { data, error } = await (supabase as LaczenieKopiiRpc).rpc('link_ksef_expense_copy', {
    p_tenant_id: w.tenantId,
    p_expense_id: w.expenseId,
    p_ksef_environment: w.environment,
    p_auto_link: true,
  });
  if (error) throw new Error(`Nie udało się połączyć kopii faktury z kosztem z KSeF: ${error.message}`);
  if (typeof data !== 'string') throw new Error('Nieznany wynik łączenia kopii faktury z kosztem z KSeF');
  return data as WynikLaczeniaKopii;
}
