'use server';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  dodajFakturaSpozaKsef,
  usunFakturaSpozaKsef,
  type WynikDodaniaSpozaKsef,
  type WynikUsunieciaSpozaKsef,
} from '@/lib/import/outside-ksef-zapis';
import { ActionAuthError, requireOrgRole } from '@/lib/supabase/auth-context';

/**
 * Akcje faktur wystawionych poza KSeF (krok 1.6, część 2b, PR B; D22 i D23).
 * Rola: właściciel albo administrator. Schemat, wyłącznik, zapis, ostrzeżenie
 * o JPK i rozliczeniu oraz audyt: `lib/import/outside-ksef-zapis.ts`.
 */

export async function dodajFakturaSpozaKsefAction(
  wejscie: unknown,
  rodzajDokumentu?: string,
): Promise<WynikDodaniaSpozaKsef> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  return dodajFakturaSpozaKsef(
    { client: ctx.supabase as unknown as SupabaseClient, tenantId: ctx.tenantId, userId: ctx.user.id },
    wejscie,
    rodzajDokumentu,
  );
}

export async function removeOutsideKsefInvoiceAction(
  id: string,
  opcje: { potwierdzam?: boolean } = {},
): Promise<WynikUsunieciaSpozaKsef> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  return usunFakturaSpozaKsef(
    { client: ctx.supabase as unknown as SupabaseClient, tenantId: ctx.tenantId, userId: ctx.user.id },
    id,
    opcje,
  );
}
