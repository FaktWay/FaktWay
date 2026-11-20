import 'server-only';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { logAudit } from '@/lib/audit/log';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { EWIDENCJA_NIEDOSTEPNA, KPIR_NIEDOSTEPNA, kpirWlaczona, wlaczona, type KontekstPliku } from '@/lib/ksiegowosc/ewidencja-pliki';
import { czytajWersjeProfilu, NAZWY_FORM, wersjaNa } from '@/lib/ksiegowosc/profil';
import { KOLUMNY_SPISU, spisSchema, zWierszaSpisu, type SpisWejscie } from '@/lib/ksiegowosc/spis-z-natury';
import {
  doWierszaWpisu,
  doWierszaWpisuKpir,
  KOLUMNY_WPISU,
  KOLUMNY_WPISU_KPIR,
  wpisKpirSchema,
  wpisSchema,
  zWierszaWpisu,
  zWierszaWpisuKpir,
  type WpisKpirWejscie,
  type WpisWejscie,
} from '@/lib/ksiegowosc/wpisy-reczne';

/**
 * Zapisy ewidencji i KPiR (plan księgowości JDG, K3, K7): wpis ręczny
 * (dodanie i usunięcie, także z kolumną KPiR) i spis z natury, wspólne dla akcji
 * strony (`app/actions/ksiegowosc-ewidencja.ts`, sesja z ciasteczek) i telefonu
 * (`/api/mobile/v1/ksiegowosc/ewidencja/*`, M10d, sesja z tokenu). Kod przeniesiony
 * z akcji bez zmian. Rolę (właściciel, administrator) sprawdza wywołujący;
 * wyłącznik (obszar `ewidencja`, przy KPiR i spisie także blokada obszaru `kpir`),
 * schemat, ustawienia podatkowe na dzień wpisu, zapis i audyt sprawdza ta
 * funkcja. Klient to klient sesji klienta (RLS).
 *
 * Ponowienie: dodanie nie ma klucza, więc podwójne dotknięcie dałoby dwa wpisy;
 * przycisk jest zablokowany na czas zapisu, a nadmiarowy wpis widać na liście
 * i usuwa się go z wpisem w audycie. Usunięcie drugi raz kończy się
 * komunikatem „wpisu już nie ma na liście”. Spis z tego samego dnia zatrzymuje
 * UNIQUE (23505).
 */

export type KontekstZapisu = KontekstPliku;
export type WynikWpisu = { success: true } | { success: false; error: string; pole?: string };

const NIEDOSTEPNE = EWIDENCJA_NIEDOSTEPNA;
export const BLAD_ZAPISU = 'Nie udało się zapisać wpisu i nic się nie zmieniło. Można spróbować jeszcze raz.';
export const BLAD_USUNIECIA = 'Nie udało się usunąć wpisu i nic się nie zmieniło. Można spróbować jeszcze raz.';
const PROFIL_TEKST = 'Ustawienia są w Księgowości, w zakładce „Ustawienia podatkowe”.';

export async function dodajWpisReczny(ctx: KontekstZapisu, wejscie: WpisWejscie): Promise<WynikWpisu> {
  const parsed = wpisSchema.safeParse(wejscie);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { success: false, error: issue?.message ?? 'Nieprawidłowy wpis.', pole: issue?.path.join('.') };
  }
  const wpis = parsed.data;
  if (wpis.dataPrzychodu > todayInWarsaw()) {
    return { success: false, error: 'Data przychodu nie może być późniejsza niż dziś.', pole: 'dataPrzychodu' };
  }

  const client = ctx.client;
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
    userId: ctx.userId,
    entityType: 'ledger_manual_entry',
    entityId: zapisany.id,
    metadata: { wpis: zapisany },
  });
  revalidatePath('/reports/ewidencja');
  return { success: true };
}

export async function usunWpisReczny(ctx: KontekstZapisu, id: string): Promise<WynikWpisu> {
  if (!z.string().uuid().safeParse(id).success) return { success: false, error: BLAD_USUNIECIA };

  const client = ctx.client;
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
    userId: ctx.userId,
    entityType: 'ledger_manual_entry',
    entityId: id,
    metadata: { wpis: { ...zWierszaWpisu(usuniety), ...(usuniety.kolumna ? { kolumna: usuniety.kolumna } : {}) } },
  });
  revalidatePath('/reports/ewidencja');
  return { success: true };
}

export async function dodajWpisKpir(ctx: KontekstZapisu, wejscie: WpisKpirWejscie): Promise<WynikWpisu> {
  const parsed = wpisKpirSchema.safeParse(wejscie);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { success: false, error: issue?.message ?? 'Nieprawidłowy wpis.', pole: issue?.path.join('.') };
  }
  const wpis = parsed.data;
  if (wpis.dataPrzychodu > todayInWarsaw()) {
    return { success: false, error: 'Data zdarzenia nie może być późniejsza niż dziś.', pole: 'dataPrzychodu' };
  }
  const client = ctx.client;
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
    userId: ctx.userId,
    entityType: 'ledger_manual_entry',
    entityId: zapisany.id,
    metadata: { wpis: zapisany },
  });
  revalidatePath('/reports/ewidencja');
  return { success: true };
}

export async function dodajSpis(ctx: KontekstZapisu, wejscie: SpisWejscie): Promise<WynikWpisu> {
  const parsed = spisSchema.safeParse(wejscie);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { success: false, error: issue?.message ?? 'Nieprawidłowy spis.', pole: issue?.path.join('.') };
  }
  const spis = parsed.data;
  if (spis.data > todayInWarsaw()) return { success: false, error: 'Data spisu nie może być późniejsza niż dziś.', pole: 'data' };
  const client = ctx.client;
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
    userId: ctx.userId,
    entityType: 'ledger_inventory_count',
    entityId: zapisany.id,
    metadata: { spis: zapisany },
  });
  revalidatePath('/reports/ewidencja');
  return { success: true };
}

export async function usunSpis(ctx: KontekstZapisu, id: string): Promise<WynikWpisu> {
  if (!z.string().uuid().safeParse(id).success) return { success: false, error: BLAD_USUNIECIA };
  const client = ctx.client;
  if (!(await kpirWlaczona(client, ctx.tenantId))) return { success: false, error: KPIR_NIEDOSTEPNA };

  const { data, error } = await client.from('ledger_inventory_counts').delete().eq('id', id).eq('tenant_id', ctx.tenantId).select(KOLUMNY_SPISU);
  if (error) return { success: false, error: BLAD_USUNIECIA };
  const usuniety = (data ?? [])[0];
  if (!usuniety) return { success: false, error: 'Tego spisu już nie ma na liście.' };
  await logAudit({
    action: 'ledger_inventory.deleted',
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    entityType: 'ledger_inventory_count',
    entityId: id,
    metadata: { spis: zWierszaSpisu(usuniety as Parameters<typeof zWierszaSpisu>[0]) },
  });
  revalidatePath('/reports/ewidencja');
  return { success: true };
}
