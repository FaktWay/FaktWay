import type { SupabaseClient } from '@supabase/supabase-js';

import {
  balanceConfirmationFromRow,
  type BalanceConfirmation,
  type BalanceEmailRecord,
} from '@/lib/saldo/model';

/**
 * Odczyty potwierdzeń salda (00216) klientem z sesji: RLS zawęża do aktywnej
 * firmy, a każde zapytanie filtruje jeszcze `tenant_id` firmy z sesji, więc
 * dokument innej firmy to „nie znaleziono”. Błąd bazy rzuca: „nie wiem” to
 * nie „brak dokumentu”. Wiersz w nieznanym kształcie też rzuca: dokumentu dla
 * kontrahenta nie składamy z części.
 *
 * Tabele 00216 nie są jeszcze w `types/database.ts` (typy z produkcji po
 * wgraniu migracji), stąd klient bez typów bazy.
 */

function untyped(client: unknown): SupabaseClient {
  return client as SupabaseClient;
}

export const BALANCE_COLUMNS =
  'id, tenant_id, contractor_id, number, as_of, currency, counterparty, issuer, items, omitted, total, issued_at';

export async function getBalanceConfirmation(client: unknown, tenantId: string, id: string): Promise<BalanceConfirmation | null> {
  const { data, error } = await untyped(client)
    .from('balance_confirmations')
    .select(BALANCE_COLUMNS)
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`balance_confirmations: ${error.message}`);
  if (!data) return null;
  const doc = balanceConfirmationFromRow(data);
  if (!doc) throw new Error('balance_confirmations: wiersz w nieznanym kształcie');
  return doc;
}

/** Historia wysyłek dokumentu mailem, od najstarszej. */
export async function listBalanceEmails(client: unknown, tenantId: string, confirmationId: string): Promise<BalanceEmailRecord[]> {
  const { data, error } = await untyped(client)
    .from('balance_confirmation_emails')
    .select('id, recipient, sent_at')
    .eq('tenant_id', tenantId)
    .eq('confirmation_id', confirmationId)
    .order('sent_at', { ascending: true });
  if (error) throw new Error(`balance_confirmation_emails: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).flatMap((raw) => {
    const { id, recipient, sent_at: sentAt } = raw;
    return typeof id === 'string' && typeof recipient === 'string' && typeof sentAt === 'string' ? [{ id, recipient, sentAt }] : [];
  });
}

/** Ile wysyłek tego dokumentu na ten adres jest już w historii (część klucza idempotencji maila). */
export async function countBalanceEmailsTo(client: unknown, tenantId: string, confirmationId: string, recipient: string): Promise<number> {
  const { count, error } = await untyped(client)
    .from('balance_confirmation_emails')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('confirmation_id', confirmationId)
    .eq('recipient', recipient);
  if (error) throw new Error(`balance_confirmation_emails: ${error.message}`);
  return count ?? 0;
}

/** Wiersz listy wystawionych potwierdzeń salda (zakładka w „Noty”). */
export interface BalanceListItem {
  id: string;
  number: string;
  asOf: string;
  counterpartyName: string;
  total: number;
  issuedAt: string;
}

export const BALANCE_LIST_LIMIT = 200;

/**
 * Lista wystawionych dokumentów firmy, od najnowszego (do 200). Pełny wiersz
 * jest sprawdzany jak przy podglądzie (`balanceConfirmationFromRow`): dokumentu
 * w nieznanym kształcie nie pokazujemy z części, błąd rzuca.
 */
export async function listBalanceConfirmations(client: unknown, tenantId: string): Promise<BalanceListItem[]> {
  const { data, error } = await untyped(client)
    .from('balance_confirmations')
    .select(BALANCE_COLUMNS)
    .eq('tenant_id', tenantId)
    .order('issued_at', { ascending: false })
    .limit(BALANCE_LIST_LIMIT);
  if (error) throw new Error(`balance_confirmations: ${error.message}`);
  return ((data ?? []) as unknown[]).map((row) => {
    const doc = balanceConfirmationFromRow(row);
    if (!doc) throw new Error('balance_confirmations: wiersz w nieznanym kształcie');
    return { id: doc.id, number: doc.number, asOf: doc.asOf, counterpartyName: doc.counterparty.name, total: doc.total, issuedAt: doc.issuedAt };
  });
}
