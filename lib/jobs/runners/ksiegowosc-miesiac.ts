/**
 * `cron.ksiegowosc-miesiac` (plan księgowości JDG, K5, sekcja 9): 1-3. dnia
 * miesiąca o 07:00 liczy rozliczenie za poprzedni miesiąc każdej firmy
 * w pilotażu i wysyła push „rozliczenie jest wyliczone”. Firma bez kwot
 * (brak profilu, parametry czekają na księgową, D7) nie dostaje nic.
 *
 * Szkic nie trafia do bazy (00168), więc idempotencję trzyma
 * `tax_notifications` (etap `wyliczone`): trzy dni uruchomień i ponowienia
 * dają jeden push. Ponowienie od zera pomija firmy z wpisem „sent”; błąd
 * jednej firmy nie zatrzymuje pozostałych, a zadanie kończy się błędem,
 * żeby kolejka je ponowiła.
 *
 * Rejestracja pg-boss: lib/jobs/handlers/package-b.ts
 */

import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

import { shiftMonth } from '@/lib/expenses/month';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import type { JobContext } from '@/lib/jobs/registry';
import { firmyWPilotazu, zajmij, zamknij } from '@/lib/ksiegowosc/powiadomienia';
import { trescWyliczenia } from '@/lib/ksiegowosc/przypomnienia';
import { BLAD_ODCZYTU_ROZLICZEN, czytajTenMiesiac } from '@/lib/ksiegowosc/ten-miesiac-dane';
import { BLAD_ODCZYTU_VAT } from '@/lib/ksiegowosc/vat-dane';
import { czyKsiegowoscWlaczona } from '@/lib/ksiegowosc/wylacznik';
import { sendPushToTenant } from '@/lib/push/sender';
import { createAdminClient } from '@/lib/supabase/admin';

export type WynikFirmy = 'wyslane' | 'pominiete' | 'duplikaty';

/** Ponowienia zadania (rejestracja w `lib/jobs/handlers/package-b.ts`); ostatnia próba ma `attempt` równe tej liczbie. */
export const PONOWIENIA_MIESIACA = 4;

export async function powiadomOWyliczeniu(
  admin: SupabaseClient,
  tenantId: string,
  miesiac: string,
  opcje: { ostatniaProba?: boolean } = {},
): Promise<WynikFirmy> {
  if (!(await czyKsiegowoscWlaczona(admin, tenantId, 'terminy')).wlaczony) return 'pominiete';
  const dane = await czytajTenMiesiac(admin, tenantId, miesiac);
  // D63 (FZ-030): błąd odczytu (baza nie odpowiedziała) to ponowienie zadania, nie „bez kwot”; to samo błąd odczytu VAT
  // albo KPiR poprzedniego roku (składka zdrowotna w styczniu), bo „wyliczone” bez tej pozycji byłoby nieprawdą o miesiącu.
  // Odmowa z przyczyną w danych zostaje miesiącem bez kwot. Wyjście: ostatnia próba idzie dalej (bez pozycji z błędem
  // odczytu), z wpisem w Sentry.
  const bladVat = dane.ok && dane.pozycje.some((p) => p.rodzaj === 'vat' && !p.ok && p.brak === BLAD_ODCZYTU_VAT);
  const bladOdczytu = (!dane.ok && (dane.bladOdczytu === true || dane.braki.includes(BLAD_ODCZYTU_ROZLICZEN))) || bladVat || (dane.ok && dane.bladOdczytuPoprzedniego === true);
  if (bladOdczytu && !opcje.ostatniaProba) throw new Error(`Nie udało się odczytać rozliczeń firmy ${tenantId} za ${miesiac}`);
  if (bladOdczytu) {
    Sentry.captureException(new Error(`Błąd odczytu rozliczeń firmy ${tenantId} za ${miesiac} po ponowieniach (ostatnia próba)`), {
      tags: { area: 'ksiegowosc.miesiac' },
      extra: { tenantId, miesiac, krok: 'odczyt-ostatnia-proba' },
    });
  }
  if (!dane.ok) return 'pominiete';
  // Kwota zero (np. składki w uldze na start) nie trafia do treści.
  const pozycje = dane.pozycje.flatMap((p) => (p.ok && p.kwotaGr > 0 ? [{ rodzaj: p.rodzaj, kwotaGr: p.kwotaGr }] : []));
  if (pozycje.length === 0) return 'pominiete';

  if ((await zajmij(admin, tenantId, miesiac, 'wyliczone')) === 'duplikat') return 'duplikaty';
  const tresc = trescWyliczenia({ miesiac, pozycje });
  try {
    const push = await sendPushToTenant(tenantId, 'ksiegowosc', {
      title: tresc.tytul,
      body: tresc.tresc,
      url: tresc.adres,
      // Ten sam tag: powtórzony push zastępuje poprzedni, zamiast dzwonić drugi raz.
      tag: `ksiegowosc-${miesiac}-wyliczone`,
    });
    await zamknij(admin, tenantId, miesiac, 'wyliczone', { status: 'sent', wynik: { push: push.sent } });
  } catch (e) {
    await zamknij(admin, tenantId, miesiac, 'wyliczone', { status: 'failed', blad: e instanceof Error ? e.message : String(e) }).catch(() => undefined);
    throw e;
  }
  return 'wyslane';
}

export async function runKsiegowoscMiesiac({ step, logger, attempt }: JobContext) {
  const ostatniaProba = attempt >= PONOWIENIA_MIESIACA;
  const admin = createAdminClient() as unknown as SupabaseClient;
  const miesiac = shiftMonth(todayInWarsaw().slice(0, 7), -1);
  const firmy = await step.run('firmy-w-pilotazu', () => firmyWPilotazu(admin));

  const licznik: Record<WynikFirmy, number> = { wyslane: 0, pominiete: 0, duplikaty: 0 };
  let doPonowienia = 0;
  for (const tenantId of firmy) {
    try {
      licznik[await step.run(`wyliczone-${tenantId}`, () => powiadomOWyliczeniu(admin, tenantId, miesiac, { ostatniaProba }))]++;
    } catch (e) {
      doPonowienia++;
      Sentry.captureException(e, { tags: { area: 'ksiegowosc.miesiac' }, extra: { tenantId, miesiac } });
    }
  }

  logger.info('ksiegowosc-miesiac', { miesiac, firmy: firmy.length, ...licznik, doPonowienia });
  if (doPonowienia > 0) throw new Error(`ksiegowosc-miesiac: ${doPonowienia} firm do ponowienia`);
  return { miesiac, firmy: firmy.length, ...licznik };
}
