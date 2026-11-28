'use server';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  dodajFakturaSpozaKsef,
  usunFakturaSpozaKsef,
  type WynikDodaniaSpozaKsef,
  type WynikUsunieciaSpozaKsef,
} from '@/lib/import/outside-ksef-zapis';
import { wliczCsvDoKsiegSpozaKsef, CSV_LIMIT_BAJTOW, CSV_ZA_DUZY, type WynikWliczeniaCsvAkcji } from '@/lib/import/outside-ksef-csv-zapis';
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

const ZRODLA_CSV = ['fakturownia', 'infakt', 'wfirma', 'ifirma'] as const;

/**
 * Wlicz do ksiąg faktury z pliku CSV (D25c). Pola: `file`, `source`
 * (fakturownia, infakt, wfirma, ifirma), `potwierdzam` ("1" zapisuje; bez niego
 * tylko podgląd). Plik czytany w całości w akcji, więc limit 1 MB.
 */
export async function wliczCsvDoKsiegAction(formData: FormData): Promise<WynikWliczeniaCsvAkcji> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  const plik = formData.get('file');
  const zrodlo = formData.get('source');
  if (!(plik instanceof File) || plik.size === 0) return { success: false, error: 'Wybierz plik CSV.' };
  if (plik.size > CSV_LIMIT_BAJTOW) return { success: false, error: CSV_ZA_DUZY };
  if (typeof zrodlo !== 'string' || !(ZRODLA_CSV as readonly string[]).includes(zrodlo)) {
    return { success: false, error: 'Wybierz program, z którego jest plik.' };
  }
  return wliczCsvDoKsiegSpozaKsef(
    { client: ctx.supabase as unknown as SupabaseClient, tenantId: ctx.tenantId, userId: ctx.user.id },
    { content: await plik.text(), source: zrodlo as (typeof ZRODLA_CSV)[number] },
    { potwierdzam: formData.get('potwierdzam') === '1' },
  );
}
