/**
 * Autozapis formularza zwykłej faktury (plan kompletnej aplikacji, krok 2.8).
 *
 * Formularz co kilka sekund zapisuje swoje surowe wartości, także niedokończone,
 * do tabeli roboczej `invoice_form_drafts` (migracja 00207). To NIE jest
 * szkic faktury: bez numeru z serii, poza listami, KSeF i JPK. Szkic faktury
 * powstaje dopiero z „Zapisz szkic” albo „Wystaw i wyślij” i trzyma się
 * schematu formularza.
 *
 * Idempotencja: klucz wiersza to `numberRequestKey` formularza, ten sam, który
 * zapis faktury wysyła jako `number_request_key` (00199). Ponowny autozapis
 * tego samego otwarcia formularza nadpisuje ten sam wiersz (upsert po kluczu
 * głównym), więc nie ma drugiego szkicu. Gdy faktura z tym kluczem już
 * istnieje, nie zapisujemy (autozapis nie wskrzesi roboczej kopii po zapisie)
 * i nie oferujemy przywrócenia.
 *
 * Wartości z tabeli są danymi, nie poleceniami: przywrócenie wkłada je tylko
 * w pola formularza, a faktura i tak przechodzi pełną walidację przy zapisie.
 * Numer, seria i daty nie wracają (`restorableValues`): numer nadaje seria
 * w chwili zapisu, a data wystawienia ma być dzisiejsza.
 *
 * Błędy bazy nie psują formularza: zapis zwraca `ok: false`, odczyt `null`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

export const AUTOSAVE_TABLE = 'invoice_form_drafts';
/** Wiersze starsze niż tyle dni nie wracają do formularza i są usuwane przy kolejnym autozapisie. */
export const AUTOSAVE_RETENTION_DAYS = 30;
/** Granica CHECK w 00207 (znaki JSON). */
export const AUTOSAVE_MAX_CHARS = 200_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pola trybów z własną drogą zapisu: faktura cykliczna i zamiana proformy (bez szkicu, C2 i krok 2.4). */
const SPECIAL_MODE_FIELDS = ['recurringInvoiceId', 'recurringPeriod', 'salesQuoteId', 'salesQuoteSeq'] as const;

/** Pola, których nie przywracamy: numer i seria nadawane przy zapisie, daty ustawiane na dziś. */
const NOT_RESTORED = [
  ...SPECIAL_MODE_FIELDS,
  'internalNumber',
  'numberSeriesId',
  'numberPreview',
  'numberRequestKey',
  'issueDate',
  'saleDate',
  'paymentDueDate',
] as const;

export type AutosaveSaveResult = { ok: true; savedAt: string } | { ok: false; reason: 'invalid' | 'already_saved' | 'unavailable' };

export interface LoadedAutosave {
  requestKey: string;
  values: Partial<InvoiceFormValues>;
  savedAt: string;
}

export const isAutosaveKey = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

function cutoffIso(): string {
  return new Date(Date.now() - AUTOSAVE_RETENTION_DAYS * 86_400_000).toISOString();
}

/** Wartości do zapisu: obiekt bez pól trybów specjalnych, w granicy rozmiaru; inaczej `null`. */
export function autosaveSnapshot(values: unknown): Record<string, unknown> | null {
  if (typeof values !== 'object' || values === null || Array.isArray(values)) return null;
  const copy: Record<string, unknown> = { ...(values as Record<string, unknown>) };
  for (const field of SPECIAL_MODE_FIELDS) delete copy[field];
  let json: string;
  try {
    json = JSON.stringify(copy);
  } catch {
    return null;
  }
  return json.length <= AUTOSAVE_MAX_CHARS ? copy : null;
}

/** Wartości wkładane w formularz po przywróceniu: bez numeru, serii, dat i pól trybów specjalnych. */
export function restorableValues(values: Record<string, unknown>): Partial<InvoiceFormValues> {
  const copy: Record<string, unknown> = { ...values };
  for (const field of NOT_RESTORED) delete copy[field];
  return copy as Partial<InvoiceFormValues>;
}

export async function saveInvoiceAutosave(
  db: SupabaseClient,
  input: { tenantId: string; userId: string; requestKey: string; values: unknown },
): Promise<AutosaveSaveResult> {
  if (!isAutosaveKey(input.requestKey)) return { ok: false, reason: 'invalid' };
  const snapshot = autosaveSnapshot(input.values);
  if (!snapshot) return { ok: false, reason: 'invalid' };
  try {
    // Zapis faktury z tym kluczem wyprzedził autozapis: nie wskrzeszamy kopii roboczej.
    const { data: saved } = await db
      .from('invoices')
      .select('id')
      .eq('tenant_id', input.tenantId)
      .eq('number_request_key', input.requestKey)
      .limit(1);
    if (Array.isArray(saved) && saved.length > 0) return { ok: false, reason: 'already_saved' };

    const savedAt = new Date().toISOString();
    const { error } = await db.from(AUTOSAVE_TABLE).upsert(
      {
        tenant_id: input.tenantId,
        user_id: input.userId,
        request_key: input.requestKey,
        form_values: snapshot,
        updated_at: savedAt,
      },
      { onConflict: 'tenant_id,user_id,request_key' },
    );
    if (error) return { ok: false, reason: 'unavailable' };

    // Sprzątanie własnych wygasłych wierszy; błąd nie cofa zapisu.
    await db
      .from(AUTOSAVE_TABLE)
      .delete()
      .eq('tenant_id', input.tenantId)
      .eq('user_id', input.userId)
      .lt('updated_at', cutoffIso());
    return { ok: true, savedAt };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/** Najnowsza niezakończona praca tej osoby w tej firmie; wiersze ze zapisaną już fakturą są usuwane. */
export async function loadInvoiceAutosave(
  db: SupabaseClient,
  tenantId: string,
  userId: string,
): Promise<LoadedAutosave | null> {
  try {
    const { data, error } = await db
      .from(AUTOSAVE_TABLE)
      .select('request_key, form_values, updated_at')
      .eq('tenant_id', tenantId)
      .eq('user_id', userId)
      .gte('updated_at', cutoffIso())
      .order('updated_at', { ascending: false })
      .limit(5);
    if (error || !Array.isArray(data) || data.length === 0) return null;
    const rows = (data as Array<{ request_key: unknown; form_values: unknown; updated_at: unknown }>).filter(
      (r) => isAutosaveKey(r.request_key) && typeof r.form_values === 'object' && r.form_values !== null && typeof r.updated_at === 'string',
    );
    if (rows.length === 0) return null;

    const keys = rows.map((r) => r.request_key as string);
    const { data: savedRows } = await db
      .from('invoices')
      .select('number_request_key')
      .eq('tenant_id', tenantId)
      .in('number_request_key', keys);
    const saved = new Set(
      ((savedRows ?? []) as Array<{ number_request_key: unknown }>).map((r) => r.number_request_key as string),
    );
    if (saved.size > 0) {
      await db
        .from(AUTOSAVE_TABLE)
        .delete()
        .eq('tenant_id', tenantId)
        .eq('user_id', userId)
        .in('request_key', [...saved]);
    }
    const open = rows.find((r) => !saved.has(r.request_key as string));
    if (!open) return null;
    return {
      requestKey: open.request_key as string,
      values: restorableValues(open.form_values as Record<string, unknown>),
      savedAt: open.updated_at as string,
    };
  } catch {
    return null;
  }
}

export async function discardInvoiceAutosave(
  db: SupabaseClient,
  tenantId: string,
  userId: string,
  requestKey: string,
): Promise<void> {
  if (!isAutosaveKey(requestKey)) return;
  try {
    await db
      .from(AUTOSAVE_TABLE)
      .delete()
      .eq('tenant_id', tenantId)
      .eq('user_id', userId)
      .eq('request_key', requestKey);
  } catch {
    // Wiersz roboczy sprzątnie przy odczycie (faktura zapisana) albo po 30 dniach.
  }
}
