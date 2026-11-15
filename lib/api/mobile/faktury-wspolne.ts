import 'server-only';

import type { MobileCaller } from '@/lib/api/mobile/auth';
import type { FakturaZapisana } from '@/lib/api/mobile/kontrakt';
import { MobileUpstreamError } from '@/lib/api/mobile/responses';
import type { RegularIssueContext } from '@/lib/invoices/issue-regular';
import type { TokenSessionSendActor } from '@/lib/invoices/ksef-submit-enqueue';

/**
 * Wspólne kroki zapisu faktury z telefonu (`POST /api/mobile/v1/faktury`):
 * zwykła faktura (M8, `faktury.ts`) i zaliczka, rozliczenie, korekta (M8b,
 * `faktury-rodzaje.ts`). Klucz `Idempotency-Key` trafia do
 * `mobile_idempotency_keys` (00201) z jednym `endpoint`, bo to jedna trasa;
 * ten sam klucz jest kluczem zapisu faktury (`number_request_key`, 00199).
 */

/** Trasa w kolumnie `endpoint` (CHECK w 00201/00202 dopuszcza tylko ją dla faktur). */
export const ENDPOINT = 'POST /api/mobile/v1/faktury';

/** Stany, w których wysyłka już jest zlecona albo zakończona sukcesem (`statusZBazy` w telefonie). */
export const SEND_IN_PROGRESS_OR_DONE = new Set(['pending', 'queued', 'sending', 'offline_queued', 'accepted']);

export type Db = RegularIssueContext['supabase'];

/** Stan 2FA tokenu dla kolejki: sesja konta z TOTP jest po kodzie (inaczej bramka dała 403). */
export function tokenSessionOf(caller: MobileCaller): TokenSessionSendActor {
  return { mfa: caller.mfaEnabled ? 'verified' : 'enrollment_required' };
}

export function dbOf(caller: MobileCaller): Db {
  return caller.db as unknown as Db;
}

export function tenantOf(caller: MobileCaller): string {
  if (!caller.org) throw new Error('Trasa faktur bez firmy (org: required)');
  return caller.org.tenantId;
}

export async function readSaved(db: Db, tenantId: string, invoiceId: string): Promise<FakturaZapisana | null> {
  const { data, error } = await db
    .from('invoices')
    .select('id, internal_number, ksef_status')
    .eq('id', invoiceId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new MobileUpstreamError('invoices.read');
  if (!data) return null;
  return { id: String(data.id), numer: String(data.internal_number ?? ''), ksefStatus: String(data.ksef_status ?? 'draft') };
}

export interface KeyRow {
  request_hash: string;
  invoice_id: string;
}

export async function findKey(db: Db, tenantId: string, userId: string, key: string): Promise<KeyRow | null> {
  const { data, error } = await db
    .from('mobile_idempotency_keys' as never)
    .select('request_hash, invoice_id')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('idempotency_key', key)
    .maybeSingle();
  if (error) throw new MobileUpstreamError('mobile_idempotency_keys.read');
  return (data as KeyRow | null) ?? null;
}

/** Faktura zapisana z tym kluczem żądania (`number_request_key`, 00199): szkic sprzed przerwy przed wierszem klucza. */
export async function findInvoiceByRequestKey(db: Db, tenantId: string, key: string): Promise<FakturaZapisana | null> {
  const { data, error } = await db
    .from('invoices')
    .select('id, internal_number, ksef_status')
    .eq('tenant_id', tenantId)
    .eq('number_request_key' as never, key)
    .maybeSingle();
  if (error) throw new MobileUpstreamError('invoices.request_key');
  const row = data as { id?: unknown; internal_number?: unknown; ksef_status?: unknown } | null;
  return row && typeof row.id === 'string'
    ? { id: row.id, numer: String(row.internal_number ?? ''), ksefStatus: String(row.ksef_status ?? 'draft') }
    : null;
}

export const KEY_SAVE_FAILED =
  'Szkic faktury jest zapisany, ale nie wysłaliśmy go do KSeF, bo nie udało się zapisać zabezpieczenia przed podwójną wysyłką. Otwórz szkic na liście faktur i wyślij go jeszcze raz.';

/**
 * Wiersz klucza po zapisie faktury. `failMessage`: zdanie dla klienta, gdy zapis klucza
 * się nie uda (wtedy wysyłka nie idzie, bo ponowienie mogłoby ją zdublować).
 */
export async function saveKey(
  db: Db,
  tenantId: string,
  userId: string,
  key: string,
  hash: string,
  invoiceId: string,
  failMessage: string = KEY_SAVE_FAILED,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await db.from('mobile_idempotency_keys' as never).insert({
    tenant_id: tenantId,
    user_id: userId,
    idempotency_key: key,
    request_hash: hash,
    endpoint: ENDPOINT,
    invoice_id: invoiceId,
  } as never);
  return error ? { ok: false, error: failMessage } : { ok: true };
}
