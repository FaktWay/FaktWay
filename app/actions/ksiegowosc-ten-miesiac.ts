'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { z } from 'zod';

import {
  dodajZaplateReczna,
  oznaczZaplacone,
  zaplataSchema,
  zatwierdzenieSchema,
  zatwierdzMiesiac,
  type WynikZaplaty,
  type WynikZatwierdzenia,
} from '@/lib/ksiegowosc/ten-miesiac-zapis';
import type { ZaplataRecznaWejscie } from '@/lib/ksiegowosc/zaplata-reczna';
import { ActionAuthError, requireOrgRole } from '@/lib/supabase/auth-context';

/**
 * Akcje „Ten miesiąc” (plan księgowości JDG, K4, D6): zatwierdzenie miesiąca
 * i oznaczenie zapłaty. Owner/admin, za wyłącznikiem (obszar `ten_miesiac`),
 * klientem z sesji; każda zmiana trafia do audit_logs.
 *
 * Ponowienie: zatwierdzenie liczy szkic od nowa na serwerze i zapisuje tylko
 * rozliczenia, których skrót różni się od ostatniej wersji, więc drugi klik
 * z tymi samymi danymi niczego nie dopisuje; dwa równoległe kliknięcia
 * zatrzymuje UNIQUE wersji. Zatwierdza się tylko to, co użytkownik widział:
 * skrót inny niż na ekranie to odmowa i odświeżenie. Oznaczenie zapłaty
 * ustawia stan (także na starszej wersji, żeby dało się poprawić datę),
 * więc powtórzone daje ten sam wynik.
 *
 * Zapłata spoza wyliczenia (K7.2, D15) dopisuje wersję rozliczenia z kwotą
 * z PUE ZUS i od razu ją oznacza jako zapłaconą. Nie ma klucza: drugi klik
 * dopisuje kolejną wersję, a odliczenie liczy tylko przyrost ponad najwyższą
 * zapłaconą wersję tego okresu (`przyrostyZaplat`), więc kwota się nie dubluje;
 * wersja z innym podziałem między FP i część bez FP to brak okresu do
 * „Cofnij” błędnej wersji (`zmianyPodzialu`, FZ-027).
 */

export type { WynikZatwierdzenia, WynikZaplaty } from '@/lib/ksiegowosc/ten-miesiac-zapis';

export async function zatwierdzMiesiacAction(wejscie: z.input<typeof zatwierdzenieSchema>): Promise<WynikZatwierdzenia> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  // Wyliczenie, skróty, zapis wersji i audyt: `lib/ksiegowosc/ten-miesiac-zapis.ts` (to samo dla telefonu).
  return zatwierdzMiesiac({ client: ctx.supabase as unknown as SupabaseClient, tenantId: ctx.tenantId, userId: ctx.user.id }, wejscie);
}

export async function oznaczZaplaconeAction(wejscie: z.input<typeof zaplataSchema>): Promise<WynikZaplaty> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  return oznaczZaplacone({ client: ctx.supabase as unknown as SupabaseClient, tenantId: ctx.tenantId, userId: ctx.user.id }, wejscie);
}

/**
 * Zapłata spoza wyliczenia (K7.2, D15): składki za okres, którego moduł nie
 * liczy, z kwotą z PUE ZUS. Wersja rozliczenia z `migawka.reczna`, zaraz
 * potem oznaczona jako zapłacona w podanym dniu.
 */
export async function dodajZaplateRecznaAction(wejscie: ZaplataRecznaWejscie): Promise<WynikZaplaty> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  // Schemat, daty, wyłącznik, zapis wersji, zapłata i audyt: `lib/ksiegowosc/ten-miesiac-zapis.ts` (to samo dla telefonu, M10d).
  return dodajZaplateReczna({ client: ctx.supabase as unknown as SupabaseClient, tenantId: ctx.tenantId, userId: ctx.user.id }, wejscie);
}
