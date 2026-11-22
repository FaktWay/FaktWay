import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { logAudit } from '@/lib/audit/log';
import { zglosAlarmy } from '@/lib/bezpieczniki/alarm';
import { odmowaJpkEwp, sprawdzJpkEwp } from '@/lib/bezpieczniki/jpk-ewp';
import { odmowaJpkPkpir, sprawdzJpkPkpir } from '@/lib/bezpieczniki/jpk-pkpir';
import { monthRange } from '@/lib/expenses/month';
import { redactXsdMessage } from '@/lib/exports/jpk-schema-check';
import { readTenantTaxOffice } from '@/lib/exports/tax-office';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { brakiOkresu, sumyOkresu, wierszeOkresu } from '@/lib/ksiegowosc/ewidencja';
import { czytajEwidencje } from '@/lib/ksiegowosc/ewidencja-dane';
import { celZlozenia, generujJpkEwp, nazwaPlikuJpkEwp } from '@/lib/ksiegowosc/jpk-ewp';
import { validateJpkEwp, validateJpkPkpir } from '@/lib/ksiegowosc/jpk-ewp-walidator';
import { generujJpkPkpir, nazwaPlikuJpkPkpir } from '@/lib/ksiegowosc/jpk-pkpir';
import { brakiKpirOkresu, sumyKpir, wierszeKpirOkresu } from '@/lib/ksiegowosc/kpir';
import { czytajKpir } from '@/lib/ksiegowosc/kpir-dane';
import { spisyPliku } from '@/lib/ksiegowosc/spis-z-natury';
import { czyKsiegowoscWlaczona, statusObszaru } from '@/lib/ksiegowosc/wylacznik';

/**
 * Pliki JPK_EWP(4) i JPK_PKPIR(3) od 1 stycznia (plan księgowości JDG, K3,
 * K7), wspólne dla akcji strony (`app/actions/ksiegowosc-ewidencja.ts`, sesja
 * z ciasteczek) i telefonu (`POST /api/mobile/v1/ksiegowosc/ewidencja/plik`,
 * M10d, sesja z tokenu). Kod przeniesiony z akcji bez zmian. Rolę (właściciel,
 * administrator, księgowa) sprawdza wywołujący; wyłącznik (obszar `ewidencja`,
 * przy KPiR także blokada obszaru `kpir`), dane, braki, XSD i strażnika pliku
 * sprawdza ta funkcja. Klient to klient sesji klienta (RLS).
 *
 * Ponowienie: pobranie nie zmienia danych; drugie daje ten sam plik i drugi
 * wpis audytu.
 */

export interface KontekstPliku {
  client: SupabaseClient;
  tenantId: string;
  userId: string;
}

export type WynikPobrania = { success: true; xml: string; nazwa: string } | { success: false; error: string; pole?: string };

export const EWIDENCJA_NIEDOSTEPNA = 'Ewidencja przychodów nie jest jeszcze dostępna dla tej firmy.';
export const KPIR_NIEDOSTEPNA = 'KPiR w module księgowości jest chwilowo niedostępna dla tej firmy.';
const NIEDOSTEPNE = EWIDENCJA_NIEDOSTEPNA;

export async function wlaczona(client: SupabaseClient, tenantId: string): Promise<boolean> {
  try {
    return (await czyKsiegowoscWlaczona(client, tenantId, 'ewidencja')).wlaczony;
  } catch {
    return false;
  }
}

/** KPiR (K7): obszar `ewidencja` (globalny stop, flaga firmy) i blokada w kodzie obszaru `kpir`. */
export const kpirWlaczona = async (client: SupabaseClient, tenantId: string) => statusObszaru('kpir').wlaczony && (await wlaczona(client, tenantId));

export const pobranieSchema = z.object({
  rok: z.number().int().min(2026).max(2100),
  doMiesiaca: z.number().int().min(1).max(12),
  imie: z.string().trim().min(1, 'Brak imienia.').max(30, 'Imię ma w JPK najwyżej 30 znaków.'),
  nazwisko: z.string().trim().min(1, 'Brak nazwiska.').max(81, 'Nazwisko ma w JPK najwyżej 81 znaków.'),
  dataUrodzenia: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Brak daty urodzenia.')
    .refine((v) => v >= '1900-01-01' && v < todayInWarsaw(), { message: 'To nie jest poprawna data urodzenia.' }),
});

/** Ostatni dzień miesiąca (`monthRange`: arytmetyka UTC, bez strefy serwera; ta sama wartość co dotąd). */
function koniecMiesiaca(rok: number, miesiac: number): string {
  return monthRange(`${rok}-${String(miesiac).padStart(2, '0')}`).to;
}

/** JPK_EWP(4) za ryczałt; rola sprawdzona przez wywołującego. */
export async function pobierzJpkEwp(ctx: KontekstPliku, wejscie: z.input<typeof pobranieSchema>): Promise<WynikPobrania> {
  const parsed = pobranieSchema.safeParse(wejscie);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { success: false, error: issue?.message ?? 'Nieprawidłowe dane do pliku.', pole: issue?.path.join('.') };
  }
  const { rok, doMiesiaca, imie, nazwisko, dataUrodzenia } = parsed.data;

  const client = ctx.client;
  if (!(await wlaczona(client, ctx.tenantId))) return { success: false, error: NIEDOSTEPNE };

  const dzis = todayInWarsaw();
  const od = `${rok}-01-01`;
  if (od > dzis) return { success: false, error: `Rok ${rok} jeszcze się nie zaczął, więc nie ma z niego ewidencji.` };
  const koniec = koniecMiesiaca(rok, doMiesiaca);
  const doDnia = koniec < dzis ? koniec : dzis;

  const wynik = await czytajEwidencje(client, ctx.tenantId, rok);
  if (!wynik.ok) return { success: false, error: wynik.komunikat };
  const braki = brakiOkresu(wynik.ewidencja, od, doDnia);
  if (braki.length > 0) {
    const reszta = braki.length > 1 ? ` Braków w tym okresie jest ${braki.length}; lista jest w ewidencji.` : '';
    return { success: false, error: `Plik JPK_EWP nie powstanie, dopóki ewidencja ma braki. ${braki[0].komunikat}${reszta}` };
  }
  const wiersze = wierszeOkresu(wynik.ewidencja, od, doDnia);
  if (wiersze.length === 0) {
    return {
      success: false,
      error: `W ewidencji nie ma wpisów od ${formatIsoDatePl(od)} do ${formatIsoDatePl(doDnia)}, więc plik JPK_EWP byłby pusty.`,
    };
  }

  const [{ data: firma }, kodUrzedu] = await Promise.all([
    client.from('tenants').select('nip').eq('id', ctx.tenantId).maybeSingle(),
    readTenantTaxOffice(client, ctx.tenantId).catch(() => null),
  ]);
  const nip = String((firma as { nip?: unknown } | null)?.nip ?? '').replace(/\D/g, '');
  if (!/^[1-9]((\d[1-9])|([1-9]\d))\d{7}$/.test(nip)) {
    return { success: false, error: 'Plik JPK_EWP potrzebuje poprawnego NIP firmy. NIP jest w Ustawieniach, w danych firmy.' };
  }
  if (!kodUrzedu) {
    return { success: false, error: 'Plik JPK_EWP potrzebuje urzędu skarbowego firmy. Urząd ustawia się w Ustawieniach, w części Księgowa.' };
  }

  const cel = celZlozenia(od, doDnia, dzis);
  const xml = generujJpkEwp({ od, do: doDnia, celZlozenia: cel, kodUrzedu, podatnik: { nip, imie, nazwisko, dataUrodzenia }, wiersze });
  const kontrola = await validateJpkEwp(xml);
  if (!kontrola.valid) {
    console.error('[jpk_ewp] niezgodny ze schematem', ctx.tenantId, kontrola.errors.slice(0, 20).map(redactXsdMessage));
    return {
      success: false,
      error:
        'Plik JPK_EWP nie przeszedł kontroli schematu Ministerstwa Finansów, więc go nie wydajemy. ' +
        'Szczegóły są w naszych logach i sprawdzimy dane z tego okresu.',
    };
  }
  // Strażnik (żelazny filtr F13): sumy kontrolne pliku po XSD. Plik z alarmem
  // nie trafia do klienta i nie ma audytu pobrania; operator dostaje alarm.
  const alarmy = sprawdzJpkEwp(xml, doDnia.slice(0, 7));
  if (alarmy.length > 0) {
    zglosAlarmy(alarmy, { tenantId: ctx.tenantId, straznik: 'jpk-ewp' });
    return { success: false, error: odmowaJpkEwp(alarmy[0].kod) };
  }

  const sumy = sumyOkresu(wiersze);
  await logAudit({
    action: 'jpk_ewp.downloaded',
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    entityType: 'jpk_ewp',
    // Bez entityId: audit_logs.entity_id to uuid, a okres jest w metadata.
    // Bez imienia, nazwiska i daty urodzenia: tych danych nie zapisujemy (jak w D9).
    metadata: { od, do: doDnia, celZlozenia: cel, liczbaWierszy: sumy.liczbaWierszy, sumaGr: sumy.razemGr },
  });
  return { success: true, xml, nazwa: nazwaPlikuJpkEwp(nip, od, doDnia) };
}

/** JPK_PKPIR(3) przy skali i liniowym; rola sprawdzona przez wywołującego. */
export async function pobierzJpkPkpir(ctx: KontekstPliku, wejscie: z.input<typeof pobranieSchema>): Promise<WynikPobrania> {
  const parsed = pobranieSchema.safeParse(wejscie);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { success: false, error: issue?.message ?? 'Nieprawidłowe dane do pliku.', pole: issue?.path.join('.') };
  }
  const { rok, doMiesiaca, imie, nazwisko, dataUrodzenia } = parsed.data;
  const client = ctx.client;
  if (!(await kpirWlaczona(client, ctx.tenantId))) return { success: false, error: KPIR_NIEDOSTEPNA };

  const dzis = todayInWarsaw();
  const od = `${rok}-01-01`;
  if (od > dzis) return { success: false, error: `Rok ${rok} jeszcze się nie zaczął, więc nie ma z niego KPiR.` };
  const koniec = koniecMiesiaca(rok, doMiesiaca);
  const doDnia = koniec < dzis ? koniec : dzis;

  const wynik = await czytajKpir(client, ctx.tenantId, rok);
  if (!wynik.ok) return { success: false, error: wynik.komunikat };
  const braki = brakiKpirOkresu(wynik.kpir, od, doDnia);
  if (braki.length > 0) {
    const reszta = braki.length > 1 ? ` Braków w tym okresie jest ${braki.length}; lista jest w KPiR.` : '';
    return { success: false, error: `Plik JPK_PKPIR nie powstanie, dopóki KPiR ma braki. ${braki[0].komunikat}${reszta}` };
  }
  const wiersze = wierszeKpirOkresu(wynik.kpir, od, doDnia);
  if (wiersze.length === 0) {
    return { success: false, error: `W KPiR nie ma wpisów od ${formatIsoDatePl(od)} do ${formatIsoDatePl(doDnia)}, więc plik JPK_PKPIR byłby pusty.` };
  }

  const [{ data: firma }, kodUrzedu] = await Promise.all([
    client.from('tenants').select('nip').eq('id', ctx.tenantId).maybeSingle(),
    readTenantTaxOffice(client, ctx.tenantId).catch(() => null),
  ]);
  const nip = String((firma as { nip?: unknown } | null)?.nip ?? '').replace(/\D/g, '');
  if (!/^[1-9]((\d[1-9])|([1-9]\d))\d{7}$/.test(nip)) {
    return { success: false, error: 'Plik JPK_PKPIR potrzebuje poprawnego NIP firmy. NIP jest w Ustawieniach, w danych firmy.' };
  }
  if (!kodUrzedu) {
    return { success: false, error: 'Plik JPK_PKPIR potrzebuje urzędu skarbowego firmy. Urząd ustawia się w Ustawieniach, w części Księgowa.' };
  }

  const cel = celZlozenia(od, doDnia, dzis);
  const spis = spisyPliku(wynik.spisy, od, doDnia);
  const xml = generujJpkPkpir({ od, do: doDnia, celZlozenia: cel, kodUrzedu, podatnik: { nip, imie, nazwisko, dataUrodzenia }, wiersze, spis });
  const kontrola = await validateJpkPkpir(xml);
  if (!kontrola.valid) {
    console.error('[jpk_pkpir] niezgodny ze schematem', ctx.tenantId, kontrola.errors.slice(0, 20).map(redactXsdMessage));
    return {
      success: false,
      error:
        'Plik JPK_PKPIR nie przeszedł kontroli schematu Ministerstwa Finansów, więc go nie wydajemy. ' +
        'Szczegóły są w naszych logach i sprawdzimy dane z tego okresu.',
    };
  }
  // Strażnik (żelazny filtr F13): sumy kontrolne i kolumny „razem” pliku po XSD.
  // Plik z alarmem nie trafia do klienta i nie ma audytu pobrania; operator dostaje alarm.
  const alarmy = sprawdzJpkPkpir(xml, doDnia.slice(0, 7));
  if (alarmy.length > 0) {
    zglosAlarmy(alarmy, { tenantId: ctx.tenantId, straznik: 'jpk-pkpir' });
    return { success: false, error: odmowaJpkPkpir(alarmy[0].kod) };
  }
  const sumy = sumyKpir(wiersze);
  await logAudit({
    action: 'jpk_pkpir.downloaded',
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    entityType: 'jpk_pkpir',
    // Bez imienia, nazwiska i daty urodzenia: tych danych nie zapisujemy (jak w D9).
    metadata: {
      od,
      do: doDnia,
      celZlozenia: cel,
      liczbaWierszy: sumy.liczbaWierszy,
      przychodGr: sumy.przychodGr,
      kosztyGr: sumy.kosztyGr,
      spisPoczatekGr: spis.poczatekGr,
      spisKoniecGr: spis.koniecGr,
    },
  });
  return { success: true, xml, nazwa: nazwaPlikuJpkPkpir(nip, od, doDnia) };
}
