import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { NextResponse } from 'next/server';
import { z } from 'zod';

import type { MobileCaller } from '@/lib/api/mobile/auth';
import type { UsuniecieKsiegiOdpowiedz, ZapisKsiegiOdpowiedz } from '@/lib/api/mobile/kontrakt-ksiegi';
import { MobileUpstreamError, mobileError, mobileJson } from '@/lib/api/mobile/responses';
import { readJsonBody } from '@/lib/api/mobile/tresc';
import { BLAD_USUNIECIA, BLAD_ZAPISU, dodajSpis, dodajWpisKpir, dodajWpisReczny, usunSpis, usunWpisReczny, type KontekstZapisu, type WynikWpisu } from '@/lib/ksiegowosc/ewidencja-zapis';
import { isUuid } from '@/lib/supabase/active-org';

/**
 * Zapisy ksiąg z telefonu, M10d część 3 (plan aplikacji mobilnej): wpis ręczny w
 * ewidencji ryczałtu i w KPiR oraz spis z natury (dodanie i usunięcie) tymi samymi
 * funkcjami co akcje strony (`lib/ksiegowosc/ewidencja-zapis.ts`: schemat, wyłącznik,
 * ustawienia podatkowe na dzień wpisu, zapis, audyt). Klient z tokenem telefonu w jego
 * firmie (RLS). Tylko właściciel i administrator, jak `requireOrgRole(['owner', 'admin'])`.
 *
 * Ponowienie: dodanie nie ma klucza, jak na stronie; telefon blokuje drugie dotknięcie
 * i po zerwanym połączeniu odświeża listę, a nadmiarowy wpis usuwa się z audytem.
 * Usunięcie drugi raz kończy się zdaniem „już nie ma na liście” (422), spis z tego
 * samego dnia zatrzymuje UNIQUE.
 */

const ROLE_ZAPISU = new Set(['owner', 'admin']);
const TYLKO_WLASCICIEL = 'Wpisy i spisy dodaje i usuwa właściciel albo administrator firmy.';
const MAX_BODY_BYTES = 4_000;
const POZA_KONTRAKTEM = 'Treść żądania nie pasuje do kontraktu. Zaktualizuj aplikację FaktWay.';

function orgOf(caller: MobileCaller): NonNullable<MobileCaller['org']> {
  if (!caller.org) throw new Error('Trasa zapisu ksiąg bez firmy (org: required)');
  return caller.org;
}

function kontekst(caller: MobileCaller): KontekstZapisu {
  return { client: caller.db as SupabaseClient, tenantId: orgOf(caller).tenantId, userId: caller.user.id };
}

/**
 * Odmowa funkcji strony: 422 ze zdaniem strony i polem formularza. Zdania ogólne („Nie udało się zapisać…
 * Można spróbować jeszcze raz”) to porażka techniczna (zapis, odczyt ustawień): 5xx, telefon ponawia.
 */
function odmowa(wynik: Extract<WynikWpisu, { success: false }>, headers: Record<string, string>): NextResponse {
  if (wynik.error === BLAD_ZAPISU || wynik.error === BLAD_USUNIECIA) throw new MobileUpstreamError('ksiegowosc.ewidencja.zapis');
  return mobileError(422, 'ledger_refused', wynik.error, headers, wynik.pole);
}

/** Kształt treści (typy pól); zasady pól sprawdza schemat strony w funkcji zapisu. */
const wspolne = { rodzaj: z.string(), dataPrzychodu: z.string(), dokument: z.string(), kwota: z.string(), opis: z.string().nullable() };
const wpisSchema = z.discriminatedUnion('typ', [
  z.object({ typ: z.literal('ewidencja'), ...wspolne, stawkaPb: z.number() }).strict(),
  z.object({ typ: z.literal('kpir'), ...wspolne, kolumna: z.string() }).strict(),
]);

/** `POST /api/mobile/v1/ksiegowosc/ewidencja/wpisy`. */
export async function entryCreateFromMobile(caller: MobileCaller, request: Request): Promise<NextResponse> {
  const headers = caller.headers;
  if (!ROLE_ZAPISU.has(orgOf(caller).role)) return mobileError(403, 'forbidden', TYLKO_WLASCICIEL, headers);
  const raw = await readJsonBody(request, headers, { maxBytes: MAX_BODY_BYTES, tooLarge: 'Treść jest za długa.' });
  if (!raw.ok) return raw.response;
  const parsed = wpisSchema.safeParse(raw.value);
  if (!parsed.success) return mobileError(400, 'invalid_request', POZA_KONTRAKTEM, headers);
  const { typ, ...pola } = parsed.data;
  const ctx = kontekst(caller);
  // Rodzaj, daty, kwoty, stawka i kolumna: schematy strony (`wpisSchema`, `wpisKpirSchema`) w funkcji zapisu.
  const wynik = typ === 'ewidencja' ? await dodajWpisReczny(ctx, pola as Parameters<typeof dodajWpisReczny>[1]) : await dodajWpisKpir(ctx, pola as Parameters<typeof dodajWpisKpir>[1]);
  if (!wynik.success) return odmowa(wynik, headers);
  const odpowiedz: ZapisKsiegiOdpowiedz = { zapisano: true };
  return mobileJson(odpowiedz, 201, headers);
}

/** `POST /api/mobile/v1/ksiegowosc/ewidencja/wpisy/{id}/usuniecie`. */
export async function entryDeleteFromMobile(caller: MobileCaller, id: string): Promise<NextResponse> {
  const headers = caller.headers;
  if (!ROLE_ZAPISU.has(orgOf(caller).role)) return mobileError(403, 'forbidden', TYLKO_WLASCICIEL, headers);
  if (!isUuid(id)) return mobileError(404, 'not_found', 'Tego wpisu nie ma na liście. Odśwież księgę.', headers);
  const wynik = await usunWpisReczny(kontekst(caller), id.toLowerCase());
  if (!wynik.success) return odmowa(wynik, headers);
  const odpowiedz: UsuniecieKsiegiOdpowiedz = { usunieto: true };
  return mobileJson(odpowiedz, 200, headers);
}

const spisSchema = z.object({ data: z.string(), kwota: z.string(), opis: z.string().nullable() }).strict();

/** `POST /api/mobile/v1/ksiegowosc/ewidencja/spisy`. */
export async function inventoryCreateFromMobile(caller: MobileCaller, request: Request): Promise<NextResponse> {
  const headers = caller.headers;
  if (!ROLE_ZAPISU.has(orgOf(caller).role)) return mobileError(403, 'forbidden', TYLKO_WLASCICIEL, headers);
  const raw = await readJsonBody(request, headers, { maxBytes: MAX_BODY_BYTES, tooLarge: 'Treść jest za długa.' });
  if (!raw.ok) return raw.response;
  const parsed = spisSchema.safeParse(raw.value);
  if (!parsed.success) return mobileError(400, 'invalid_request', POZA_KONTRAKTEM, headers);
  const wynik = await dodajSpis(kontekst(caller), parsed.data);
  if (!wynik.success) return odmowa(wynik, headers);
  const odpowiedz: ZapisKsiegiOdpowiedz = { zapisano: true };
  return mobileJson(odpowiedz, 201, headers);
}

/** `POST /api/mobile/v1/ksiegowosc/ewidencja/spisy/{id}/usuniecie`. */
export async function inventoryDeleteFromMobile(caller: MobileCaller, id: string): Promise<NextResponse> {
  const headers = caller.headers;
  if (!ROLE_ZAPISU.has(orgOf(caller).role)) return mobileError(403, 'forbidden', TYLKO_WLASCICIEL, headers);
  if (!isUuid(id)) return mobileError(404, 'not_found', 'Tego spisu nie ma na liście. Odśwież księgę.', headers);
  const wynik = await usunSpis(kontekst(caller), id.toLowerCase());
  if (!wynik.success) return odmowa(wynik, headers);
  const odpowiedz: UsuniecieKsiegiOdpowiedz = { usunieto: true };
  return mobileJson(odpowiedz, 200, headers);
}
