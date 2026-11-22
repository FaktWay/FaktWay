'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { type SpisWejscie } from '@/lib/ksiegowosc/spis-z-natury';
import { type WpisKpirWejscie, type WpisWejscie } from '@/lib/ksiegowosc/wpisy-reczne';
import { dodajSpis, dodajWpisKpir, dodajWpisReczny, usunSpis, usunWpisReczny, type WynikWpisu } from '@/lib/ksiegowosc/ewidencja-zapis';
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

export type { WynikWpisu };
export type { WynikPobrania };

export async function dodajWpisRecznyAction(wejscie: WpisWejscie): Promise<WynikWpisu> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  // Schemat, wyłącznik, zapis i audyt: `lib/ksiegowosc/ewidencja-zapis.ts` (to samo dla telefonu, M10d).
  return dodajWpisReczny({ client: ctx.supabase as unknown as SupabaseClient, tenantId: ctx.tenantId, userId: ctx.user.id }, wejscie);
}

export async function usunWpisRecznyAction(id: string): Promise<WynikWpisu> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  // Schemat, wyłącznik, zapis i audyt: `lib/ksiegowosc/ewidencja-zapis.ts` (to samo dla telefonu, M10d).
  return usunWpisReczny({ client: ctx.supabase as unknown as SupabaseClient, tenantId: ctx.tenantId, userId: ctx.user.id }, id);
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
  // Schemat, wyłącznik, zapis i audyt: `lib/ksiegowosc/ewidencja-zapis.ts` (to samo dla telefonu, M10d).
  return dodajWpisKpir({ client: ctx.supabase as unknown as SupabaseClient, tenantId: ctx.tenantId, userId: ctx.user.id }, wejscie);
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
  // Schemat, wyłącznik, zapis i audyt: `lib/ksiegowosc/ewidencja-zapis.ts` (to samo dla telefonu, M10d).
  return dodajSpis({ client: ctx.supabase as unknown as SupabaseClient, tenantId: ctx.tenantId, userId: ctx.user.id }, wejscie);
}

export async function usunSpisAction(id: string): Promise<WynikWpisu> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  // Schemat, wyłącznik, zapis i audyt: `lib/ksiegowosc/ewidencja-zapis.ts` (to samo dla telefonu, M10d).
  return usunSpis({ client: ctx.supabase as unknown as SupabaseClient, tenantId: ctx.tenantId, userId: ctx.user.id }, id);
}

