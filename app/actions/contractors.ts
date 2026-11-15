'use server';

import { revalidatePath } from 'next/cache';

import type { ContractorEditInput } from '@/lib/contractors/edit';
import { CONTRACTOR_EDITOR_ROLES, deleteContractor, updateContractor } from '@/lib/contractors/manage';
import { ActionAuthError, requireOrgRole } from '@/lib/supabase/auth-context';

export type ContractorActionResult = { success: true } | { success: false; error: string };

/**
 * Poprawka danych kontrahenta (F-011). Zmienione pola trafiają do
 * `manual_fields` (00064), więc nocne odświeżanie z rejestrów ich nie cofnie.
 * Wystawione faktury mają własną kopię danych nabywcy — zmiana ich nie dotyka.
 * NIP nie podlega edycji (to klucz kontrahenta w firmie). Logika zapisu:
 * `lib/contractors/manage.ts` (ta sama dla aplikacji na telefon, M10e).
 */
export async function updateContractorAction(
  contractorId: string,
  input: ContractorEditInput,
): Promise<ContractorActionResult> {
  let ctx;
  try {
    // Księgowa ma wgląd; zmieniać bazę kontrahentów mogą pozostali członkowie.
    ctx = await requireOrgRole([...CONTRACTOR_EDITOR_ROLES]);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }

  const { supabase, tenantId, user } = ctx;
  const result = await updateContractor(supabase, contractorId, input, { tenantId, userId: user.id });
  if (!result.success) return { success: false, error: result.error };
  if (result.changed.length > 0) revalidatePath('/contractors');
  return { success: true };
}

/**
 * Usunięcie kontrahenta z bazy podpowiedzi (F-011). Faktury mają własną kopię
 * danych nabywcy, więc usunięcie ich nie zmienia.
 */
export async function deleteContractorAction(contractorId: string): Promise<ContractorActionResult> {
  let ctx;
  try {
    ctx = await requireOrgRole([...CONTRACTOR_EDITOR_ROLES]);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }

  const { supabase, tenantId, user } = ctx;
  const result = await deleteContractor(supabase, contractorId, { tenantId, userId: user.id });
  if (!result.success) return { success: false, error: result.error };
  revalidatePath('/contractors');
  return { success: true };
}
