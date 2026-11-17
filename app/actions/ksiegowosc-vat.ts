'use server';

import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { logAudit } from '@/lib/audit/log';
import { monthLabel } from '@/lib/expenses/month';
import { JPK_V7M_FORM_CODE } from '@/lib/exports/jpk-v7m-generator';
import { bladPlikuVat, plikJpkV7m, plikVatSchema, pobierzJpkV7m, VAT_NIEDOSTEPNY, type WynikPlikuVat } from '@/lib/ksiegowosc/vat-plik';
import { czyKsiegowoscWlaczona, type ObszarModulu } from '@/lib/ksiegowosc/wylacznik';
import { certyfikatMf, srodowiskoMf } from '@/lib/ksiegowosc/wysylka-jpk/certyfikaty';
import { daneAutoryzujaceSchema } from '@/lib/ksiegowosc/wysylka-jpk/dane-autoryzujace';
import { BladMf, statusWysylki } from '@/lib/ksiegowosc/wysylka-jpk/klient';
import { ocenOdmoweInit, ocenStatus } from '@/lib/ksiegowosc/wysylka-jpk/statusy';
import { skrotBase64 } from '@/lib/ksiegowosc/wysylka-jpk/szyfrowanie';
import { wyslijJpk } from '@/lib/ksiegowosc/wysylka-jpk/wyslij';
import { czytajWysylke, zalozWysylke, zamknijPrzerwane, zmienWysylke } from '@/lib/ksiegowosc/wysylka-jpk/zapis';
import { downloadFromR2, uploadToR2IfAbsent } from '@/lib/storage/r2';
import { ActionAuthError, requireOrgRole, type AuthContext, type UserRole } from '@/lib/supabase/auth-context';

/**
 * Akcje ekranu VAT (plan księgowości JDG, K6): plik JPK_V7M(3) do pobrania,
 * wysyłka do MF z danymi autoryzującymi (D9), status i UPO. Klient z sesji,
 * obszar `vat` modułu; wysyłka dodatkowo za obszarem `wysylka_jpk`
 * (zablokowany w kodzie do opinii prawnika) i zmienną `JPK_MF_ENV`.
 *
 * Imię, nazwisko i datę urodzenia schemat wymaga dla osoby fizycznej, więc
 * klient podaje je przy pobraniu i wysyłce; nie zapisujemy ich (jak JPK_EWP
 * w K3), tak jak kwoty przychodu z danych autoryzujących. W audycie są okres,
 * skrót pliku i numer referencyjny.
 *
 * Ponowienie: wiersz `jpk_submissions` powstaje przed wysłaniem, a indeks
 * z 00170 nie wpuści drugiej wysyłki za ten sam miesiąc, dopóki pierwsza
 * trwa. Ten sam plik wysłany drugi raz MF rozpoznaje po skrócie (kod 170)
 * i podaje numer oryginału. Status: zmiana stanu z warunkiem na stan
 * poprzedni, UPO zapisane tylko, gdy klucza jeszcze nie ma.
 */

export type { WynikPlikuVat };
export type WynikWysylkiVat = { success: true; numer: string; duplikat: boolean } | { success: false; error: string; pole?: string };
export type WynikStatusuVat = { success: true; stan: string; tresc: string } | { success: false; error: string };
export type WynikUpo = { success: true; xml: string; nazwa: string } | { success: false; error: string };

const WYSYLKA_NIEDOSTEPNA =
  'Wysyłka JPK_V7M do Ministerstwa Finansów z FaktWay nie jest jeszcze włączona. Plik można pobrać i złożyć w e-Urzędzie Skarbowym.';

const wysylkaSchema = plikVatSchema.extend({ kwotaGr: daneAutoryzujaceSchema.shape.kwotaGr });

async function kontekst(role: UserRole[]): Promise<AuthContext | string> {
  try {
    return await requireOrgRole(role);
  } catch (e) {
    if (e instanceof ActionAuthError) return e.message;
    throw e;
  }
}

async function wlaczony(client: SupabaseClient, tenantId: string, obszar: ObszarModulu): Promise<boolean> {
  try {
    return (await czyKsiegowoscWlaczona(client, tenantId, obszar)).wlaczony;
  } catch {
    return false;
  }
}

export async function pobierzJpkV7mAction(wejscie: z.input<typeof plikVatSchema>): Promise<WynikPlikuVat> {
  const ctx = await kontekst(['owner', 'admin', 'accountant']);
  if (typeof ctx === 'string') return { success: false, error: ctx };
  // Schemat, wyłącznik, plik (XSD, strażnik) i audyt: `lib/ksiegowosc/vat-plik.ts` (to samo dla telefonu, M10d).
  return pobierzJpkV7m({ client: ctx.supabase as unknown as SupabaseClient, tenantId: ctx.tenantId, userId: ctx.user.id }, wejscie);
}

export async function wyslijJpkV7mAction(wejscie: z.input<typeof wysylkaSchema>): Promise<WynikWysylkiVat> {
  const ctx = await kontekst(['owner', 'admin']);
  if (typeof ctx === 'string') return { success: false, error: ctx };
  const parsed = wysylkaSchema.safeParse(wejscie);
  if (!parsed.success) return bladPlikuVat(parsed);
  const client = ctx.supabase as unknown as SupabaseClient;
  if (!(await wlaczony(client, ctx.tenantId, 'vat'))) return { success: false, error: VAT_NIEDOSTEPNY };
  const srodowisko = srodowiskoMf();
  if (!srodowisko || !(await wlaczony(client, ctx.tenantId, 'wysylka_jpk'))) return { success: false, error: WYSYLKA_NIEDOSTEPNA };

  try {
    certyfikatMf(srodowisko);
  } catch (e) {
    Sentry.captureException(e, { tags: { area: 'ksiegowosc.jpk' }, extra: { tenantId: ctx.tenantId } });
    return { success: false, error: WYSYLKA_NIEDOSTEPNA };
  }

  const w = parsed.data;
  const plik = await plikJpkV7m({ client, tenantId: ctx.tenantId, userId: ctx.user.id }, w, srodowisko);
  if (!plik.ok) return { success: false, error: plik.error };
  const okres = `${w.miesiac}-01`;
  const skrotPliku = skrotBase64('sha256', Buffer.from(plik.xml, 'utf8'));

  await zamknijPrzerwane(client, ctx.tenantId, okres);
  const zalozona = await zalozWysylke(client, ctx.tenantId, { okres, cel: plik.cel, srodowisko, skrotPliku, deklaracja: plik.deklaracja });
  if (zalozona === 'w_toku') {
    return { success: false, error: `Wysyłka JPK_V7M za ${monthLabel(w.miesiac)} już trwa. Jej status jest na liście wysyłek.` };
  }

  let wynik;
  try {
    wynik = await wyslijJpk(
      srodowisko,
      { xml: plik.xml, nazwa: plik.nazwa, formularz: JPK_V7M_FORM_CODE },
      { nip: plik.nip, imie: w.imie, nazwisko: w.nazwisko, dataUrodzenia: w.dataUrodzenia, kwotaGr: w.kwotaGr },
    );
  } catch (e) {
    // Odmowa InitUploadSigned (4xx) to wysyłka odrzucona; brak odpowiedzi i błąd po drodze to przerwana.
    const odrzucona = e instanceof BladMf && e.etap === 'init' && e.http >= 400 && e.http < 500;
    const ocena = ocenOdmoweInit(e instanceof BladMf ? e.kod : null);
    await zmienWysylke(client, zalozona.id, 'wysylanie', {
      stan: odrzucona ? 'odrzucona' : 'przerwana',
      status_kod: e instanceof BladMf ? e.kod : null,
      blad: e instanceof Error ? e.message : String(e),
      zakonczono_o: new Date().toISOString(),
    }).catch(() => false);
    if (!odrzucona || ocena.techniczny) Sentry.captureException(e, { tags: { area: 'ksiegowosc.jpk' }, extra: { tenantId: ctx.tenantId, okres } });
    revalidatePath('/reports/vat');
    return { success: false, error: odrzucona ? ocena.tresc : 'Wysyłka do MF nie doszła do końca i plik nie został złożony. Można spróbować jeszcze raz.' };
  }

  // Plik jest już w MF: błąd zapisu numeru nie może zamienić się w „nie wysłano”.
  // Numer zostaje w audycie, a operator dopisuje go do wiersza kluczem serwisowym.
  const zapisany = await zmienWysylke(client, zalozona.id, 'wysylanie', {
    stan: 'w_toku',
    numer_referencyjny: wynik.numerReferencyjny,
    wyslano_o: new Date().toISOString(),
  }).catch((e: unknown) => {
    Sentry.captureException(e, { tags: { area: 'ksiegowosc.jpk' }, extra: { tenantId: ctx.tenantId, id: zalozona.id, numer: wynik.numerReferencyjny } });
    return false;
  });
  await logAudit({
    action: 'jpk_v7m.sent',
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    entityType: 'jpk_submission',
    entityId: zalozona.id,
    metadata: { miesiac: w.miesiac, cel: plik.cel, srodowisko, numer: wynik.numerReferencyjny, skrotPliku, duplikat: wynik.duplikat, zapisany },
  });
  revalidatePath('/reports/vat');
  return { success: true, numer: wynik.numerReferencyjny, duplikat: wynik.duplikat };
}

export async function sprawdzStatusJpkAction(wejscie: { id: string }): Promise<WynikStatusuVat> {
  const ctx = await kontekst(['owner', 'admin']);
  if (typeof ctx === 'string') return { success: false, error: ctx };
  const id = z.string().uuid().safeParse(wejscie.id);
  if (!id.success) return { success: false, error: 'Nie ma takiej wysyłki.' };
  const client = ctx.supabase as unknown as SupabaseClient;
  if (!(await wlaczony(client, ctx.tenantId, 'vat'))) return { success: false, error: VAT_NIEDOSTEPNY };

  const w = await czytajWysylke(client, ctx.tenantId, id.data);
  if (!w) return { success: false, error: 'Nie ma takiej wysyłki.' };
  if (w.stan !== 'w_toku' || !w.numerReferencyjny) return { success: true, stan: w.stan, tresc: w.statusOpis ?? '' };

  let s;
  try {
    s = await statusWysylki(w.srodowisko, w.numerReferencyjny);
  } catch (e) {
    Sentry.captureException(e, { tags: { area: 'ksiegowosc.jpk' }, extra: { tenantId: ctx.tenantId, id: w.id } });
    return { success: false, error: 'MF nie odpowiedziało na pytanie o status. Status sprawdzi się przy następnym otwarciu strony.' };
  }
  const ocena = ocenStatus(s.kod);
  const teraz = new Date().toISOString();
  if (ocena.stan === 'w_toku') {
    await zmienWysylke(client, w.id, 'w_toku', { status_kod: s.kod, status_opis: s.opis, sprawdzono_o: teraz });
    return { success: true, stan: 'w_toku', tresc: ocena.tresc };
  }
  if (ocena.stan === 'przyjeta') {
    if (!s.upo) return { success: false, error: 'MF potwierdziło przyjęcie bez UPO. Status sprawdzi się przy następnym otwarciu strony.' };
    const klucz = `upo/${ctx.tenantId}/jpk/${w.okres.slice(0, 7)}/${w.numerReferencyjny}.xml`;
    await uploadToR2IfAbsent(klucz, Buffer.from(s.upo, 'utf8'), 'application/xml');
    if (await zmienWysylke(client, w.id, 'w_toku', { stan: 'przyjeta', status_kod: s.kod, status_opis: s.opis, upo_sciezka: klucz, sprawdzono_o: teraz, zakonczono_o: teraz })) {
      await logAudit({
        action: 'jpk_v7m.accepted',
        tenantId: ctx.tenantId,
        userId: ctx.user.id,
        entityType: 'jpk_submission',
        entityId: w.id,
        metadata: { okres: w.okres, srodowisko: w.srodowisko, numer: w.numerReferencyjny },
      });
    }
  } else {
    await zmienWysylke(client, w.id, 'w_toku', { stan: 'odrzucona', status_kod: s.kod, status_opis: s.opis, sprawdzono_o: teraz, zakonczono_o: teraz });
    if (ocena.techniczny) {
      Sentry.captureMessage(`JPK_V7M odrzucony przez MF: ${s.kod} ${s.opis}`, { tags: { area: 'ksiegowosc.jpk' }, extra: { tenantId: ctx.tenantId, id: w.id } });
    }
  }
  revalidatePath('/reports/vat');
  return { success: true, stan: ocena.stan, tresc: ocena.tresc };
}

export async function pobierzUpoJpkAction(wejscie: { id: string }): Promise<WynikUpo> {
  const ctx = await kontekst(['owner', 'admin', 'accountant']);
  if (typeof ctx === 'string') return { success: false, error: ctx };
  const id = z.string().uuid().safeParse(wejscie.id);
  if (!id.success) return { success: false, error: 'Nie ma takiej wysyłki.' };
  const client = ctx.supabase as unknown as SupabaseClient;
  if (!(await wlaczony(client, ctx.tenantId, 'vat'))) return { success: false, error: VAT_NIEDOSTEPNY };
  const w = await czytajWysylke(client, ctx.tenantId, id.data);
  if (!w?.upoSciezka || !w.numerReferencyjny) return { success: false, error: 'Ta wysyłka nie ma UPO.' };
  const xml = (await downloadFromR2(w.upoSciezka, ctx.tenantId)).toString('utf8');
  return { success: true, xml, nazwa: `UPO_JPK_V7M_${w.okres.slice(0, 7)}_${w.numerReferencyjny}.xml` };
}
