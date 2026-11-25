import type { SupabaseClient } from '@supabase/supabase-js';

import { normalizeNip } from '@/lib/contractors/overview';
import type { Receivables } from '@/lib/dashboard/receivables';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { balancePreviewFromRpc, type BalanceContent, type BalancePreviewResult } from '@/lib/saldo/model';
import { toGrosze } from '@/lib/xml/invoice-calculator';

/**
 * Obliczenie salda (krok 2.9, część 2, PR B; D26 i D27). Saldo liczy baza
 * (`balance_confirmation_preview`, 00215) z tym samym warunkiem co Pulpit;
 * aplikacja:
 *  1. czyta wynik i sprawdza jego arytmetykę w groszach (każda pozycja:
 *     do zapłaty po wpłatach = do zapłaty z faktury minus wpłaty, saldo =
 *     suma pozycji); zły kształt albo zła arytmetyka to błąd, nie dokument;
 *  2. porównuje pozycje z należnościami tego kontrahenta z `getReceivables`
 *     (Pulpit i tabela Kontrahenci, rozkład po NIP jak `receivablesByNip`):
 *     te same faktury i te same kwoty co do grosza. Różnica zatrzymuje
 *     wystawienie (dwa sposoby liczenia nie mogą się rozjechać po cichu).
 */

/** Funkcje 00215 nie są jeszcze w `types/database.ts` (typy z produkcji po wgraniu migracji). */
function untyped(client: unknown): SupabaseClient {
  return client as SupabaseClient;
}

/** Arytmetyka zestawienia w groszach całkowitych (bez błędów liczb zmiennoprzecinkowych). */
export function balanceArithmeticHolds(content: Pick<BalanceContent, 'items' | 'total'>): boolean {
  let sum = 0;
  for (const item of content.items) {
    const outstanding = toGrosze(item.outstanding);
    if (outstanding <= 0) return false;
    if (outstanding !== toGrosze(item.amountDue) - toGrosze(item.paid)) return false;
    if (toGrosze(item.amountDue) > toGrosze(item.gross)) return false;
    sum += outstanding;
  }
  return sum === toGrosze(content.total);
}

/**
 * Podgląd salda kontrahenta aktywnej firmy z bazy. Środowisko KSeF z
 * konfiguracji aplikacji (KSEF_ENV), jak w `getReceivables`. Błąd bazy,
 * nieznany kształt albo zła arytmetyka rzucają: „nie wiem” to nie saldo.
 */
export async function readBalancePreview(client: unknown, contractorId: string): Promise<BalancePreviewResult> {
  const environment = requireConfiguredKsefEnvironment();
  const { data, error } = await untyped(client).rpc('balance_confirmation_preview', {
    p_contractor_id: contractorId,
    p_ksef_environment: environment,
  });
  if (error) throw new Error(`balance_confirmation_preview: ${error.message}`);
  const result = balancePreviewFromRpc(data);
  if (!result) throw new Error('balance_confirmation_preview: nieznany kształt wyniku');
  if (result.ok && !balanceArithmeticHolds(result.preview)) {
    throw new Error('balance_confirmation_preview: kwoty pozycji nie sumują się do salda');
  }
  return result;
}

/**
 * Czy pozycje zestawienia to dokładnie należności tego kontrahenta z Pulpitu:
 * te same faktury (po NIP nabywcy jak `receivablesByNip`) i ta sama kwota do
 * zapłaty każdej z nich co do grosza.
 */
export function matchesReceivables(
  content: Pick<BalanceContent, 'items' | 'counterparty'>,
  receivables: Pick<Receivables, 'byInvoice'>,
): boolean {
  const nip = normalizeNip(content.counterparty.nip);
  if (!nip) return false;
  const pulpit = new Map<string, number>();
  for (const invoice of receivables.byInvoice) {
    if (normalizeNip(invoice.buyerNip) === nip) pulpit.set(invoice.id, toGrosze(invoice.outstanding));
  }
  const ids = new Set(content.items.map((item) => item.invoiceId));
  if (ids.size !== content.items.length || pulpit.size !== ids.size) return false;
  return content.items.every((item) => pulpit.get(item.invoiceId) === toGrosze(item.outstanding));
}
