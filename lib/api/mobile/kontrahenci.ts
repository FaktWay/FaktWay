import 'server-only';

import type { NextResponse } from 'next/server';
import { z } from 'zod';

import { customerErrorDetail } from '@/components/dashboard/pulpit/pulpit-grid';
import type { MobileCaller } from '@/lib/api/mobile/auth';
import type {
  KafleKontrahentow,
  KontrahenciOdpowiedz,
  KontrahentOdpowiedz,
  KontrahentTelefonu,
  NowyKontrahentOdpowiedz,
  StatusVatKontrahenta,
  UsuniecieKontrahentaOdpowiedz,
  ZmianaKontrahentaOdpowiedz,
} from '@/lib/api/mobile/kontrakt-wiecej';
import { MobileUpstreamError, mobileError, mobileJson } from '@/lib/api/mobile/responses';
import { readJsonBody } from '@/lib/api/mobile/tresc';
import { contractorSearchFilter } from '@/lib/contractors/edit';
import {
  CONTRACTOR_NOT_FOUND,
  createContractor,
  deleteContractor,
  mayEditContractors,
  updateContractor,
  type ContractorWriteFailure,
} from '@/lib/contractors/manage';
import {
  countActiveContractors,
  countContractorsWithOverdue,
  foreignCurrencyNote,
  needsVatCheck,
  normalizeNip,
  readContractorKeys,
  receivablesByNip,
  type ContractorReceivables,
} from '@/lib/contractors/overview';
import { getReceivables, RECEIVABLES_NOTE, type Receivables } from '@/lib/dashboard/receivables';
import { sanitizeSearch } from '@/lib/invoices/list-query';
import { isUuid } from '@/lib/supabase/active-org';

/**
 * Kontrahenci z telefonu (plan aplikacji mobilnej, M10e): lista, szczegół,
 * dodanie, poprawka i usunięcie, w zgodzie ze stroną `/contractors`.
 *
 * Odczyt to te same zapytania co strona (do 200 od ostatnio użytych, szukanie
 * w bazie po nazwie i NIP, `contractorSearchFilter`), kafle z
 * `lib/contractors/overview.ts`, a należności wyłącznie z `getReceivables`
 * rozłożonego po NIP (§2.4 pkt 11, jak kolumny tabeli strony). Każdy kafel
 * liczy się osobno: błąd zabiera kafel, nie listę (jak `SectionErrorBoundary`
 * na stronie).
 *
 * Zapisy wołają `lib/contractors/manage.ts`, tę samą logikę co akcje strony,
 * klientem z tokenem telefonu w jego aktywnej firmie (RLS 00004). Rola z
 * bramki: księgowa ma wgląd, zmieniają pozostali (jak `requireOrgRole` akcji).
 *
 * Ponowienie po zerwanym połączeniu:
 *  - dodanie: NIP jest kluczem w firmie (`UNIQUE (tenant_id, nip)`); ten sam
 *    NIP z tymi samymi danymi oddaje istniejącego (`juzBylo`) bez drugiego
 *    wpisu w audycie, inne dane to 409 `contractor_exists`;
 *  - poprawka: drugi zapis tych samych danych nie ma czego zmienić (`zmienione: []`);
 *  - usunięcie: drugie usunięcie to 404 `not_found`, telefon traktuje je jak wykonane.
 */

const KOLUMNY =
  'id, nip, name, address, email, phone, vat_status, validation_warning, last_validation_at, reminder_excluded, reminder_exclusion_reason';
const LIMIT = 200;
const MAX_BODY_BYTES = 20_000;
const TOO_LARGE = 'Dane kontrahenta są za długie do wysłania z telefonu.';
/** Strona: `PULPIT_GENERIC_ERROR` mówi „Odśwież stronę”; telefon ma pociągnięcie w dół. */
const BLAD_OGOLNY = 'Nie udało się policzyć. Spróbuj ponownie za chwilę.';
const AUDYT = { client: 'mobile' } as const;

/** Plakietki `VatStatusBadge` strony; czynny z ostrzeżeniem to „Wymaga uwagi”. */
const ETYKIETY_VAT: Record<StatusVatKontrahenta, string> = {
  active: 'Czynny VAT',
  exempt: 'Zwolniony VAT',
  inactive: 'Wykreślony',
  unknown: 'Niezweryfikowany',
  pending: 'Sprawdzanie',
};

type Wiersz = {
  id: string;
  nip: string | null;
  name: string | null;
  address: unknown;
  email: string | null;
  phone: string | null;
  vat_status: string | null;
  validation_warning: string | null;
  last_validation_at: string | null;
  reminder_excluded: boolean | null;
  reminder_exclusion_reason: string | null;
};

function tekst(w: unknown): string {
  return typeof w === 'string' ? w.trim() : '';
}

function statusVat(w: string | null): StatusVatKontrahenta | null {
  return w && w in ETYKIETY_VAT ? (w as StatusVatKontrahenta) : null;
}

/** Treść wyjątku dla klienta jak karta strony (`pulpitErrorMessage`), bez „Odśwież stronę”. */
function bladKarty(error: unknown, kontekst: string): string {
  const szczegol = customerErrorDetail(error);
  if (!szczegol) console.error(`[api.mobile.kontrahenci] ${kontekst}:`, error);
  return szczegol ?? BLAD_OGOLNY;
}

function kontrahentTelefonu(w: Wiersz, poNip: Map<string, ContractorReceivables> | null): KontrahentTelefonu {
  const a = typeof w.address === 'object' && w.address !== null ? (w.address as Record<string, unknown>) : {};
  const status = statusVat(w.vat_status);
  const ostrzezenie = tekst(w.validation_warning) || null;
  const nip = normalizeNip(w.nip);
  return {
    id: w.id,
    nip: tekst(w.nip),
    nazwa: tekst(w.name),
    adres: { linia1: tekst(a.addressLine1), linia2: tekst(a.addressLine2) },
    email: tekst(w.email) || null,
    telefon: tekst(w.phone) || null,
    statusVat: status,
    statusVatEtykieta: status === 'active' && ostrzezenie ? 'Wymaga uwagi' : ETYKIETY_VAT[status ?? 'unknown'],
    ostrzezenie,
    vatDoSprawdzenia: needsVatCheck({ vat_status: w.vat_status, validation_warning: w.validation_warning }),
    sprawdzono: w.last_validation_at,
    przypomnieniaWylaczone: Boolean(w.reminder_excluded),
    powodWylaczenia: tekst(w.reminder_exclusion_reason) || null,
    naleznosci:
      poNip === null
        ? null
        : (() => {
            const r = (nip ? poNip.get(nip) : undefined) ?? { outstanding: 0, overdueCount: 0 };
            return { doZaplaty: r.outstanding, poTerminie: r.overdueCount };
          })(),
  };
}

/** Należności po NIP albo zdanie, dlaczego ich nie ma (kolumny strony dostają wtedy „—”). */
async function naleznosciPoNip(caller: MobileCaller, tenantId: string): Promise<{ poNip: Map<string, ContractorReceivables> | null; blad: string | null; dane: Receivables | null }> {
  try {
    const dane = await getReceivables(caller.db, tenantId);
    return { poNip: receivablesByNip(dane), blad: null, dane };
  } catch (error) {
    return { poNip: null, blad: bladKarty(error, 'należności'), dane: null };
  }
}

async function kafle(caller: MobileCaller, tenantId: string, naleznosci: Receivables | null, bladNaleznosci: string | null): Promise<KafleKontrahentow> {
  let kartoteka: Awaited<ReturnType<typeof readContractorKeys>> | null = null;
  let bladKartoteki: string | null = null;
  try {
    kartoteka = await readContractorKeys(caller.db, tenantId);
  } catch (error) {
    bladKartoteki = bladKarty(error, 'kartoteka');
  }
  const bezKartoteki = { ok: false as const, blad: bladKartoteki ?? BLAD_OGOLNY };

  let aktywni: KafleKontrahentow['aktywni'] = bezKartoteki;
  if (kartoteka) {
    try {
      aktywni = { ok: true, dane: { wartosc: await countActiveContractors(caller.db, tenantId, kartoteka), nota: 'z fakturą przyjętą w KSeF' } };
    } catch (error) {
      aktywni = { ok: false, blad: bladKarty(error, 'aktywni') };
    }
  }

  let zZaleglosciami: KafleKontrahentow['zZaleglosciami'] = bezKartoteki;
  if (kartoteka && naleznosci) {
    const pominiete = foreignCurrencyNote(naleznosci.foreignCurrencyCount);
    zZaleglosciami = {
      ok: true,
      dane: { wartosc: countContractorsWithOverdue(kartoteka, naleznosci), nota: pominiete ? `${RECEIVABLES_NOTE}. ${pominiete}` : RECEIVABLES_NOTE },
    };
  } else if (kartoteka) {
    zZaleglosciami = { ok: false, blad: bladNaleznosci ?? BLAD_OGOLNY };
  }

  return {
    wszyscy: kartoteka ? { ok: true, dane: { wartosc: kartoteka.length } } : bezKartoteki,
    aktywni,
    zZaleglosciami,
    vatDoSprawdzenia: kartoteka
      ? { ok: true, dane: { wartosc: kartoteka.filter(needsVatCheck).length, nota: 'niezweryfikowani, wykreśleni i z ostrzeżeniem' } }
      : bezKartoteki,
  };
}

/** `GET /kontrahenci?q=`: lista jak strona; kafle tylko bez szukania. */
export async function contractorsForMobile(caller: MobileCaller, request: Request): Promise<NextResponse> {
  if (!caller.org) throw new Error('Trasa kontrahentów bez firmy (org: required)');
  const { tenantId, role } = caller.org;
  const fraza = sanitizeSearch(new URL(request.url).searchParams.get('q') ?? '');

  let query = caller.db.from('contractors').select(KOLUMNY).eq('tenant_id', tenantId);
  const szukaj = contractorSearchFilter(fraza);
  if (szukaj) query = query.or(szukaj);
  const { data, error } = await query.order('last_used_at', { ascending: false, nullsFirst: false }).limit(LIMIT);
  if (error) throw new MobileUpstreamError('contractors.read');
  const wiersze = (data ?? []) as unknown as Wiersz[];

  // Należności tylko, gdy jest komu je przypisać (jak strona).
  const naleznosci = wiersze.length > 0 || !fraza ? await naleznosciPoNip(caller, tenantId) : { poNip: null, blad: null, dane: null };
  const pominiete = naleznosci.dane ? foreignCurrencyNote(naleznosci.dane.foreignCurrencyCount) : null;

  const odpowiedz: KontrahenciOdpowiedz = {
    lista: wiersze.map((w) => kontrahentTelefonu(w, naleznosci.poNip)),
    fraza,
    kafle: fraza ? null : await kafle(caller, tenantId, naleznosci.dane, naleznosci.blad),
    bladNaleznosci: naleznosci.blad,
    nota: `Należności i „Po terminie”: ${RECEIVABLES_NOTE.toLowerCase()}.${pominiete ? ` ${pominiete}.` : ''} Pokazujemy do ${LIMIT} kontrahentów, od ostatnio użytych.`,
    mozeEdytowac: mayEditContractors(role),
  };
  return mobileJson(odpowiedz, 200, caller.headers);
}

async function jeden(caller: MobileCaller, tenantId: string, id: string): Promise<Wiersz | null> {
  const { data, error } = await caller.db.from('contractors').select(KOLUMNY).eq('id', id).eq('tenant_id', tenantId).maybeSingle();
  if (error) throw new MobileUpstreamError('contractors.read_one');
  return (data as unknown as Wiersz | null) ?? null;
}

const NIE_MA = 'Nie znaleziono tego kontrahenta w wybranej firmie. Mógł zostać usunięty: odśwież listę.';

/** `GET /kontrahenci/{id}`. */
export async function contractorForMobile(caller: MobileCaller, id: string): Promise<NextResponse> {
  if (!caller.org) throw new Error('Trasa kontrahenta bez firmy (org: required)');
  const { tenantId, role } = caller.org;
  if (!isUuid(id)) return mobileError(404, 'not_found', NIE_MA, caller.headers);
  const wiersz = await jeden(caller, tenantId, id);
  if (!wiersz) return mobileError(404, 'not_found', NIE_MA, caller.headers);
  const naleznosci = await naleznosciPoNip(caller, tenantId);
  const odpowiedz: KontrahentOdpowiedz = {
    kontrahent: kontrahentTelefonu(wiersz, naleznosci.poNip),
    bladNaleznosci: naleznosci.blad,
    mozeEdytowac: mayEditContractors(role),
  };
  return mobileJson(odpowiedz, 200, caller.headers);
}

// ─── Zapisy ──────────────────────────────────────────────────────────

const daneSchema = z.strictObject({
  nazwa: z.string().max(2_000),
  adres1: z.string().max(2_000),
  adres2: z.string().max(2_000),
  email: z.string().max(2_000),
});
const nowySchema = daneSchema.extend({ nip: z.string().max(64) });

/** Pole schematu strony na pole formularza telefonu. */
const POLE_TELEFONU: Record<string, string> = { name: 'nazwa', addressLine1: 'adres1', addressLine2: 'adres2', email: 'email', nip: 'nip' };

export const ROLA_BEZ_ZMIAN = 'Księgowa widzi kontrahentów, ale ich nie zmienia. Poproś właściciela firmy albo członka zespołu.';

function odmowaZapisu(caller: MobileCaller, wynik: ContractorWriteFailure): NextResponse {
  if (wynik.reason === 'invalid') {
    return mobileError(422, 'contractor_invalid', wynik.error, caller.headers, wynik.field ? POLE_TELEFONU[wynik.field] : undefined);
  }
  if (wynik.reason === 'not_found') return mobileError(404, 'not_found', wynik.error === CONTRACTOR_NOT_FOUND ? NIE_MA : wynik.error, caller.headers);
  throw new MobileUpstreamError(`contractors.write: ${wynik.error}`);
}

async function trescZapisu<T extends z.ZodType>(caller: MobileCaller, request: Request, schema: T): Promise<{ ok: true; dane: z.output<T> } | { ok: false; response: NextResponse }> {
  const body = await readJsonBody(request, caller.headers, { maxBytes: MAX_BODY_BYTES, tooLarge: TOO_LARGE });
  if (!body.ok) return body;
  const parsed = schema.safeParse(body.value);
  if (!parsed.success) return { ok: false, response: mobileError(400, 'invalid_request', 'Treść żądania nie pasuje do formularza kontrahenta.', caller.headers) };
  return { ok: true, dane: parsed.data };
}

/** Odczyt po zapisie, z należnościami, żeby telefon pokazał to samo co lista. */
async function poZapisie(caller: MobileCaller, tenantId: string, id: string): Promise<KontrahentTelefonu | null> {
  const wiersz = await jeden(caller, tenantId, id);
  if (!wiersz) return null;
  const naleznosci = await naleznosciPoNip(caller, tenantId);
  return kontrahentTelefonu(wiersz, naleznosci.poNip);
}

/** `POST /kontrahenci`: nowy kontrahent. */
export async function createContractorForMobile(caller: MobileCaller, request: Request): Promise<NextResponse> {
  if (!caller.org) throw new Error('Trasa kontrahentów bez firmy (org: required)');
  const { tenantId, role } = caller.org;
  if (!mayEditContractors(role)) return mobileError(403, 'forbidden', ROLA_BEZ_ZMIAN, caller.headers);
  const tresc = await trescZapisu(caller, request, nowySchema);
  if (!tresc.ok) return tresc.response;
  const { nip, nazwa, adres1, adres2, email } = tresc.dane;

  const wynik = await createContractor(
    caller.db,
    { nip, name: nazwa, addressLine1: adres1, addressLine2: adres2, email },
    { tenantId, userId: caller.user.id, auditMetadata: AUDYT },
  );
  if (!wynik.success) {
    if (wynik.reason === 'exists') return mobileError(409, 'contractor_exists', wynik.error, caller.headers, 'nip');
    return odmowaZapisu(caller, wynik);
  }
  const kontrahent = await poZapisie(caller, tenantId, wynik.id);
  if (!kontrahent) throw new MobileUpstreamError('contractors.read_after_create');
  const odpowiedz: NowyKontrahentOdpowiedz = { kontrahent, juzBylo: wynik.existed };
  return mobileJson(odpowiedz, wynik.existed ? 200 : 201, caller.headers);
}

/** `POST /kontrahenci/{id}`: poprawka danych. */
export async function updateContractorForMobile(caller: MobileCaller, request: Request, id: string): Promise<NextResponse> {
  if (!caller.org) throw new Error('Trasa kontrahenta bez firmy (org: required)');
  const { tenantId, role } = caller.org;
  if (!mayEditContractors(role)) return mobileError(403, 'forbidden', ROLA_BEZ_ZMIAN, caller.headers);
  if (!isUuid(id)) return mobileError(404, 'not_found', NIE_MA, caller.headers);
  const tresc = await trescZapisu(caller, request, daneSchema);
  if (!tresc.ok) return tresc.response;
  const { nazwa, adres1, adres2, email } = tresc.dane;

  const wynik = await updateContractor(
    caller.db,
    id,
    { name: nazwa, addressLine1: adres1, addressLine2: adres2, email },
    { tenantId, userId: caller.user.id, auditMetadata: AUDYT },
  );
  if (!wynik.success) return odmowaZapisu(caller, wynik);
  const kontrahent = await poZapisie(caller, tenantId, id);
  if (!kontrahent) return mobileError(404, 'not_found', NIE_MA, caller.headers);
  const zmienione = wynik.changed.map((p) => (p === 'name' ? 'nazwa' : p === 'address' ? 'adres' : 'email') as ZmianaKontrahentaOdpowiedz['zmienione'][number]);
  const odpowiedz: ZmianaKontrahentaOdpowiedz = { kontrahent, zmienione };
  return mobileJson(odpowiedz, 200, caller.headers);
}

/** `POST /kontrahenci/{id}/usuniecie`. */
export async function deleteContractorForMobile(caller: MobileCaller, id: string): Promise<NextResponse> {
  if (!caller.org) throw new Error('Trasa kontrahenta bez firmy (org: required)');
  const { tenantId, role } = caller.org;
  if (!mayEditContractors(role)) return mobileError(403, 'forbidden', ROLA_BEZ_ZMIAN, caller.headers);
  if (!isUuid(id)) return mobileError(404, 'not_found', NIE_MA, caller.headers);
  const wynik = await deleteContractor(caller.db, id, { tenantId, userId: caller.user.id, auditMetadata: AUDYT });
  if (!wynik.success) return odmowaZapisu(caller, wynik);
  const odpowiedz: UsuniecieKontrahentaOdpowiedz = { usuniety: true };
  return mobileJson(odpowiedz, 200, caller.headers);
}
