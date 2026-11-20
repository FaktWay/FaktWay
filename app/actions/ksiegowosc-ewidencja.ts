'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { logAudit } from '@/lib/audit/log';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { KOLUMNY_SPISU, spisSchema, zWierszaSpisu, type SpisWejscie } from '@/lib/ksiegowosc/spis-z-natury';
import { czytajWersjeProfilu, NAZWY_FORM, wersjaNa } from '@/lib/ksiegowosc/profil';
import { doWierszaWpisu, doWierszaWpisuKpir, KOLUMNY_WPISU, KOLUMNY_WPISU_KPIR, wpisKpirSchema, wpisSchema, zWierszaWpisu, zWierszaWpisuKpir, type WpisKpirWejscie, type WpisWejscie } from '@/lib/ksiegowosc/wpisy-reczne';
import { czyKsiegowoscWlaczona, statusObszaru } from '@/lib/ksiegowosc/wylacznik';
import { pobierzJpkEwp, pobierzJpkPkpir, type pobranieSchema, type WynikPobrania } from '@/lib/ksiegowosc/ewidencja-pliki';
import { ActionAuthError, requireOrgRole } from '@/lib/supabase/auth-context';

/**
 * Akcje ewidencji przychodów (plan księgowości JDG, K3): wpisy ręczne
 * (dodanie i usunięcie, owner/admin, z audytem) i pobranie pliku JPK_EWP(4).
 * Od K7 także KPiR przy skali i liniowym: wpis ręczny z kolumną KPiR (00171)
 * i plik JPK_PKPIR(3).
 * Wszystko za wyłącznikiem modułu (obszar `ewidencja`) i klientem z sesji.
 *
 * Ponowienie: dodanie nie ma klucza, więc podwójne kliknięcie dałoby dwa
 * wpisy; przycisk jest zablokowany na czas zapisu, a nadmiarowy wpis widać
 * na liście i usuwa się go z wpisem w audycie. Usunięcie drugi raz kończy
 * się komunikatem „wpis już nie istnieje”. Pobranie nie zmienia danych.
 */

export type WynikWpisu = { success: true } | { success: false; error: string; pole?: string };
export type { WynikPobrania };

const NIEDOSTEPNE = 'Ewidencja przychodów nie jest jeszcze dostępna dla tej firmy.';
const KPIR_NIEDOSTEPNA = 'KPiR w module księgowości jest chwilowo niedostępna dla tej firmy.';
/** KPiR (K7): obszar `ewidencja` (globalny stop, flaga firmy) i blokada w kodzie obszaru `kpir`. */
const kpirWlaczona = async (client: SupabaseClient, tenantId: string) => statusObszaru('kpir').wlaczony && (await wlaczona(client, tenantId));
const BLAD_ZAPISU = 'Nie udało się zapisać wpisu i nic się nie zmieniło. Można spróbować jeszcze raz.';
const BLAD_USUNIECIA = 'Nie udało się usunąć wpisu i nic się nie zmieniło. Można spróbować jeszcze raz.';
const PROFIL_TEKST = 'Ustawienia są w Księgowości, w zakładce „Ustawienia podatkowe”.';

async function wlaczona(client: SupabaseClient, tenantId: string): Promise<boolean> {
  try {
    return (await czyKsiegowoscWlaczona(client, tenantId, 'ewidencja')).wlaczony;
  } catch {
    return false;
  }
}

export async function dodajWpisRecznyAction(wejscie: WpisWejscie): Promise<WynikWpisu> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }

  const parsed = wpisSchema.safeParse(wejscie);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { success: false, error: issue?.message ?? 'Nieprawidłowy wpis.', pole: issue?.path.join('.') };
  }
  const wpis = parsed.data;
  if (wpis.dataPrzychodu > todayInWarsaw()) {
    return { success: false, error: 'Data przychodu nie może być późniejsza niż dziś.', pole: 'dataPrzychodu' };
  }

  const client = ctx.supabase as unknown as SupabaseClient;
  if (!(await wlaczona(client, ctx.tenantId))) return { success: false, error: NIEDOSTEPNE };

  let wersje;
  try {
    wersje = await czytajWersjeProfilu(client, ctx.tenantId);
  } catch {
    return { success: false, error: BLAD_ZAPISU };
  }
  const wersja = wersjaNa(wersje, wpis.dataPrzychodu);
  const kiedy = formatIsoDatePl(wpis.dataPrzychodu);
  if (!wersja) {
    return {
      success: false,
      error: `Bez ustawień podatkowych na ${kiedy} wpis nie trafi do ewidencji. ${PROFIL_TEKST}`,
      pole: 'dataPrzychodu',
    };
  }
  if (wersja.forma !== 'ryczalt') {
    return {
      success: false,
      error: `${kiedy} forma opodatkowania to ${NAZWY_FORM[wersja.forma].toLowerCase()}, więc wpis nie należy do ewidencji przychodów.`,
      pole: 'dataPrzychodu',
    };
  }

  // `ledger_manual_entries` dojdzie do types/database.ts po wgraniu 00167 (typy z produkcji).
  const { data, error } = await client
    .from('ledger_manual_entries')
    .insert(doWierszaWpisu(ctx.tenantId, wpis))
    .select(KOLUMNY_WPISU)
    .single();
  if (error || !data) return { success: false, error: BLAD_ZAPISU };

  const zapisany = zWierszaWpisu(data as Parameters<typeof zWierszaWpisu>[0]);
  await logAudit({
    action: 'ledger_entry.created',
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    entityType: 'ledger_manual_entry',
    entityId: zapisany.id,
    metadata: { wpis: zapisany },
  });
  revalidatePath('/reports/ewidencja');
  return { success: true };
}

export async function usunWpisRecznyAction(id: string): Promise<WynikWpisu> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  if (!z.string().uuid().safeParse(id).success) return { success: false, error: BLAD_USUNIECIA };

  const client = ctx.supabase as unknown as SupabaseClient;
  if (!(await wlaczona(client, ctx.tenantId))) return { success: false, error: NIEDOSTEPNE };

  const { data, error } = await client
    .from('ledger_manual_entries')
    .delete()
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    // Cały wiersz: wpis KPiR (K7, 00171) ma kolumnę zamiast stawki, a audyt pokazuje, co usunięto.
    .select('*');
  if (error) return { success: false, error: BLAD_USUNIECIA };
  const usuniety = (data ?? [])[0] as (Parameters<typeof zWierszaWpisu>[0] & { kolumna?: string | null }) | undefined;
  if (!usuniety) return { success: false, error: 'Tego wpisu już nie ma na liście.' };

  await logAudit({
    action: 'ledger_entry.deleted',
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    entityType: 'ledger_manual_entry',
    entityId: id,
    metadata: { wpis: { ...zWierszaWpisu(usuniety), ...(usuniety.kolumna ? { kolumna: usuniety.kolumna } : {}) } },
  });
  revalidatePath('/reports/ewidencja');
  return { success: true };
}

export async function pobierzJpkEwpAction(wejscie: z.input<typeof pobranieSchema>): Promise<WynikPobrania> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin', 'accountant']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  // Schemat, wyłącznik, braki, plik (XSD, strażnik) i audyt: `lib/ksiegowosc/ewidencja-pliki.ts` (to samo dla telefonu, M10d).
  return pobierzJpkEwp({ client: ctx.supabase as unknown as SupabaseClient, tenantId: ctx.tenantId, userId: ctx.user.id }, wejscie);
}

export async function dodajWpisKpirAction(wejscie: WpisKpirWejscie): Promise<WynikWpisu> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  const parsed = wpisKpirSchema.safeParse(wejscie);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { success: false, error: issue?.message ?? 'Nieprawidłowy wpis.', pole: issue?.path.join('.') };
  }
  const wpis = parsed.data;
  if (wpis.dataPrzychodu > todayInWarsaw()) {
    return { success: false, error: 'Data zdarzenia nie może być późniejsza niż dziś.', pole: 'dataPrzychodu' };
  }
  const client = ctx.supabase as unknown as SupabaseClient;
  if (!(await kpirWlaczona(client, ctx.tenantId))) return { success: false, error: KPIR_NIEDOSTEPNA };

  let wersje;
  try {
    wersje = await czytajWersjeProfilu(client, ctx.tenantId);
  } catch {
    return { success: false, error: BLAD_ZAPISU };
  }
  const wersja = wersjaNa(wersje, wpis.dataPrzychodu);
  const kiedy = formatIsoDatePl(wpis.dataPrzychodu);
  if (!wersja) {
    return { success: false, error: `Bez ustawień podatkowych na ${kiedy} wpis nie trafi do KPiR. ${PROFIL_TEKST}`, pole: 'dataPrzychodu' };
  }
  if (wersja.forma === 'ryczalt') {
    return { success: false, error: `${kiedy} forma opodatkowania to ryczałt, więc wpis należy do ewidencji przychodów, nie do KPiR.`, pole: 'dataPrzychodu' };
  }

  const { data, error } = await client.from('ledger_manual_entries').insert(doWierszaWpisuKpir(ctx.tenantId, wpis)).select(KOLUMNY_WPISU_KPIR).single();
  if (error || !data) return { success: false, error: BLAD_ZAPISU };
  const zapisany = zWierszaWpisuKpir(data as Parameters<typeof zWierszaWpisuKpir>[0]);
  await logAudit({
    action: 'ledger_entry.kpir_created',
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    entityType: 'ledger_manual_entry',
    entityId: zapisany.id,
    metadata: { wpis: zapisany },
  });
  revalidatePath('/reports/ewidencja');
  return { success: true };
}

export async function pobierzJpkPkpirAction(wejscie: z.input<typeof pobranieSchema>): Promise<WynikPobrania> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin', 'accountant']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  // Schemat, wyłącznik, braki, plik (XSD, strażnik) i audyt: `lib/ksiegowosc/ewidencja-pliki.ts` (to samo dla telefonu, M10d).
  return pobierzJpkPkpir({ client: ctx.supabase as unknown as SupabaseClient, tenantId: ctx.tenantId, userId: ctx.user.id }, wejscie);
}

/** Spis z natury (K7.4, D19): data, wartość i opis; owner/admin, za obszarem `kpir`, z audytem. */
export async function dodajSpisAction(wejscie: SpisWejscie): Promise<WynikWpisu> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  const parsed = spisSchema.safeParse(wejscie);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { success: false, error: issue?.message ?? 'Nieprawidłowy spis.', pole: issue?.path.join('.') };
  }
  const spis = parsed.data;
  if (spis.data > todayInWarsaw()) return { success: false, error: 'Data spisu nie może być późniejsza niż dziś.', pole: 'data' };
  const client = ctx.supabase as unknown as SupabaseClient;
  if (!(await kpirWlaczona(client, ctx.tenantId))) return { success: false, error: KPIR_NIEDOSTEPNA };

  const { data, error } = await client
    .from('ledger_inventory_counts')
    .insert({ tenant_id: ctx.tenantId, data: spis.data, kwota_gr: spis.kwota, opis: spis.opis })
    .select(KOLUMNY_SPISU)
    .single();
  if (error?.code === '23505') {
    return { success: false, error: 'Spis z tego dnia już jest; poprawka to usunięcie spisu i dodanie nowego.', pole: 'data' };
  }
  if (error || !data) return { success: false, error: BLAD_ZAPISU };
  const zapisany = zWierszaSpisu(data as Parameters<typeof zWierszaSpisu>[0]);
  await logAudit({
    action: 'ledger_inventory.created',
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    entityType: 'ledger_inventory_count',
    entityId: zapisany.id,
    metadata: { spis: zapisany },
  });
  revalidatePath('/reports/ewidencja');
  return { success: true };
}

export async function usunSpisAction(id: string): Promise<WynikWpisu> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  if (!z.string().uuid().safeParse(id).success) return { success: false, error: BLAD_USUNIECIA };
  const client = ctx.supabase as unknown as SupabaseClient;
  if (!(await kpirWlaczona(client, ctx.tenantId))) return { success: false, error: KPIR_NIEDOSTEPNA };

  const { data, error } = await client.from('ledger_inventory_counts').delete().eq('id', id).eq('tenant_id', ctx.tenantId).select(KOLUMNY_SPISU);
  if (error) return { success: false, error: BLAD_USUNIECIA };
  const usuniety = (data ?? [])[0];
  if (!usuniety) return { success: false, error: 'Tego spisu już nie ma na liście.' };
  await logAudit({
    action: 'ledger_inventory.deleted',
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    entityType: 'ledger_inventory_count',
    entityId: id,
    metadata: { spis: zWierszaSpisu(usuniety as Parameters<typeof zWierszaSpisu>[0]) },
  });
  revalidatePath('/reports/ewidencja');
  return { success: true };
}

