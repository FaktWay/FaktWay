import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { logAudit } from '@/lib/audit/log';
import { changedContractorFields, contractorEditSchema, type ContractorEditInput } from '@/lib/contractors/edit';
import type { UserRole } from '@/lib/supabase/auth-context';
import { validateNipChecksum } from '@/lib/xml/invoice-calculator';

/**
 * Zapis kontrahenta wspólny dla strony (`app/actions/contractors.ts`) i
 * aplikacji na telefon (`/api/mobile/v1/kontrahenci`, plan aplikacji mobilnej,
 * M10e). Edycja i usunięcie to logika akcji strony z F-011, przeniesiona tu bez
 * zmiany zachowania (test `tests/unit/kontrahenci-edycja.test.ts`, ten sam przed
 * i po). Dodanie z formularza (NIP i dane wpisane ręcznie) jest nowe: na
 * stronie kontrahent powstaje przy wyszukaniu NIP w formularzu faktury
 * (`lookupNipAction`, upsert po `tenant_id, nip`).
 *
 * Klient bazy z sesji użytkownika (ciasteczka na stronie, token na telefonie),
 * więc RLS 00004 (`tenant_id = get_current_tenant_id()`) pilnuje firmy także
 * wtedy, gdy warunek `tenant_id` w zapytaniu by zawiódł. Rolę sprawdza
 * wywołujący (`mayEditContractors`): RLS kontrahentów nie rozróżnia ról.
 */

type Db = SupabaseClient;

/** Księgowa ma wgląd; zmieniać bazę kontrahentów mogą pozostali członkowie. */
export const CONTRACTOR_EDITOR_ROLES = ['owner', 'admin', 'member'] as const satisfies readonly UserRole[];

export function mayEditContractors(role: UserRole): boolean {
  return (CONTRACTOR_EDITOR_ROLES as readonly UserRole[]).includes(role);
}

/** Brak kontrahenta w firmie: powód i wyjście (ustalenie 25), jak „Nie znaleziono produktu” (#924). */
export const CONTRACTOR_NOT_FOUND = 'Nie znaleziono kontrahenta w tej firmie. Mógł go usunąć ktoś inny albo w innej karcie wybrano inną firmę. Odśwież listę kontrahentów.';
/** Błąd bazy przy odczycie to nie brak kontrahenta: klient spróbuje ponownie, a nie szuka kontrahenta, który jest. */
export const CONTRACTOR_READ_FAILED = 'Nie udało się odczytać kontrahenta, więc zmian nie zapisaliśmy. Spróbuj ponownie za chwilę.';

export type ContractorWriteFailure = {
  success: false;
  error: string;
  /** `invalid`: dane nie przeszły schematu (`field` wskazuje pole); `not_found`: brak w tej firmie; `failed`: baza odmówiła zapisu. */
  reason: 'invalid' | 'not_found' | 'failed';
  field?: string;
};

/** Pierwsze zdanie walidacji i pole, którego dotyczy. */
function invalid(error: z.ZodError, fallback: string): ContractorWriteFailure {
  const issue = error.issues[0];
  const field = typeof issue?.path[0] === 'string' ? issue.path[0] : undefined;
  return { success: false, reason: 'invalid', error: issue?.message ?? fallback, ...(field ? { field } : {}) };
}

export interface ContractorWriteContext {
  tenantId: string;
  userId: string;
  /** Dopisane do metadanych wpisu w `audit_logs` (telefon: `{ client: 'mobile' }`). */
  auditMetadata?: Record<string, unknown>;
}

/**
 * Poprawka danych kontrahenta (F-011). Zmienione pola trafiają do
 * `manual_fields` (00064), więc nocne odświeżanie z rejestrów ich nie cofnie.
 * Wystawione faktury mają własną kopię danych nabywcy: zmiana ich nie dotyka.
 * NIP nie podlega edycji (to klucz kontrahenta w firmie). Bez zmian: sukces
 * z pustą listą `changed`, bez zapisu i bez wpisu w audycie (ponowienie z
 * telefonu po zapisie też tak się kończy).
 */
export async function updateContractor(
  supabase: Db,
  contractorId: string,
  input: ContractorEditInput,
  ctx: ContractorWriteContext,
): Promise<{ success: true; changed: Array<'name' | 'address' | 'email'> } | ContractorWriteFailure> {
  const parsed = contractorEditSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error, 'Nieprawidłowe dane kontrahenta.');

  const { tenantId, userId } = ctx;
  const { data: current, error: readError } = await supabase
    .from('contractors')
    .select('id, name, address, email, manual_fields')
    .eq('id', contractorId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (readError) return { success: false, reason: 'failed', error: CONTRACTOR_READ_FAILED };
  if (!current) return { success: false, reason: 'not_found', error: CONTRACTOR_NOT_FOUND };

  const before = {
    name: (current.name as string | null) ?? null,
    address: (current.address as { addressLine1?: string; addressLine2?: string; countryCode?: string } | null) ?? null,
    email: (current.email as string | null) ?? null,
  };
  const after = parsed.data;
  const changed = changedContractorFields(before, after);
  if (changed.length === 0) return { success: true, changed };

  const manual = new Set<string>([...((current.manual_fields as string[] | null) ?? []), ...changed]);
  const { data: updated, error } = await supabase
    .from('contractors')
    .update({
      name: after.name,
      address: {
        countryCode: before.address?.countryCode ?? 'PL',
        addressLine1: after.addressLine1,
        addressLine2: after.addressLine2,
      },
      email: after.email || null,
      manual_fields: [...manual],
    })
    .eq('id', contractorId)
    .eq('tenant_id', tenantId)
    .select('id');
  if (error || !updated || updated.length === 0) {
    return { success: false, reason: 'failed', error: 'Nie udało się zapisać kontrahenta.' };
  }

  await logAudit({
    action: 'contractor.updated',
    tenantId,
    userId,
    entityType: 'contractor',
    entityId: contractorId,
    metadata: { fields: changed, ...ctx.auditMetadata },
  });
  return { success: true, changed };
}

/**
 * Usunięcie kontrahenta z bazy podpowiedzi (F-011). Faktury mają własną kopię
 * danych nabywcy, więc usunięcie ich nie zmienia. Drugie usunięcie (ponowienie)
 * to `not_found`.
 */
export async function deleteContractor(
  supabase: Db,
  contractorId: string,
  ctx: ContractorWriteContext,
): Promise<{ success: true } | ContractorWriteFailure> {
  const { tenantId, userId } = ctx;
  const { data: deleted, error } = await supabase
    .from('contractors')
    .delete()
    .eq('id', contractorId)
    .eq('tenant_id', tenantId)
    .select('id, nip');
  if (error) return { success: false, reason: 'failed', error: 'Nie udało się usunąć kontrahenta.' };
  if (!deleted || deleted.length === 0) {
    return { success: false, reason: 'not_found', error: CONTRACTOR_NOT_FOUND };
  }

  await logAudit({
    action: 'contractor.deleted',
    tenantId,
    userId,
    entityType: 'contractor',
    entityId: contractorId,
    metadata: { nip: (deleted[0] as { nip?: string | null }).nip ?? null, ...ctx.auditMetadata },
  });
  return { success: true };
}

// ─── Dodanie (M10e) ──────────────────────────────────────────────────

export const CONTRACTOR_NIP_INVALID = 'Niepoprawny NIP: sprawdź 10 cyfr (błędna suma kontrolna).';

/**
 * Nowy kontrahent: polski NIP (10 cyfr z sumą kontrolną, jak nabywca w
 * formularzu faktury, `lib/validators/invoice-validators.ts`) i te same pola
 * z tymi samymi granicami co edycja. Kreski i spacje w NIP usuwamy.
 */
export const contractorCreateSchema = contractorEditSchema.extend({
  nip: z
    .string()
    .transform((v) => v.replace(/[\s-]/g, ''))
    .refine(validateNipChecksum, CONTRACTOR_NIP_INVALID),
});

export type ContractorCreateInput = z.input<typeof contractorCreateSchema>;

export type ContractorCreateResult =
  | { success: true; id: string; existed: boolean }
  | ContractorWriteFailure
  | { success: false; reason: 'exists'; error: string; id: string };

type ExistingRow = { id: string; name: string | null; address: { addressLine1?: string; addressLine2?: string } | null; email: string | null };

/**
 * Dodanie kontrahenta. NIP jest kluczem w firmie (`UNIQUE (tenant_id, nip)`,
 * 00004): drugi zapis tych samych danych (ponowienie z telefonu po zerwanym
 * połączeniu) oddaje istniejący wiersz z `existed: true`, bez drugiego wpisu
 * w audycie; inne dane pod tym NIP to `exists` z identyfikatorem, żeby klient
 * otworzył istniejącego kontrahenta zamiast go nadpisać.
 */
export async function createContractor(
  supabase: Db,
  input: ContractorCreateInput,
  ctx: ContractorWriteContext,
): Promise<ContractorCreateResult> {
  const parsed = contractorCreateSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error, 'Nieprawidłowe dane kontrahenta.');
  const { nip, name, addressLine1, addressLine2, email } = parsed.data;
  const { tenantId, userId } = ctx;

  const { data: inserted, error } = await supabase
    .from('contractors')
    .insert({
      tenant_id: tenantId,
      nip,
      name,
      address: { countryCode: 'PL', addressLine1, addressLine2 },
      email: email || null,
      // Jak zapis z wyszukania NIP w formularzu: nowy kontrahent na górze listy (od ostatnio użytych).
      last_used_at: new Date().toISOString(),
    })
    .select('id')
    .maybeSingle();

  if (!error && inserted) {
    const id = (inserted as { id: string }).id;
    await logAudit({
      action: 'contractor.created',
      tenantId,
      userId,
      entityType: 'contractor',
      entityId: id,
      metadata: { nip, ...ctx.auditMetadata },
    });
    return { success: true, id, existed: false };
  }
  // 23505: kontrahent z tym NIP już jest w tej firmie.
  if (error?.code !== '23505') return { success: false, reason: 'failed', error: 'Nie udało się dodać kontrahenta.' };

  const { data: existing, error: readError } = await supabase
    .from('contractors')
    .select('id, name, address, email')
    .eq('tenant_id', tenantId)
    .eq('nip', nip)
    .maybeSingle();
  if (readError || !existing) return { success: false, reason: 'failed', error: 'Nie udało się dodać kontrahenta.' };
  const row = existing as unknown as ExistingRow;
  const same = changedContractorFields(row, parsed.data).length === 0;
  if (same) return { success: true, id: row.id, existed: true };
  return {
    success: false,
    reason: 'exists',
    id: row.id,
    error: `Kontrahent z NIP ${nip} jest już zapisany${row.name ? ` jako ${row.name}` : ''}. Otwórz go i popraw dane.`,
  };
}
