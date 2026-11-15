import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import type { NextResponse } from 'next/server';
import type { z } from 'zod';

import type { MobileCaller } from '@/lib/api/mobile/auth';
import {
  SEND_IN_PROGRESS_OR_DONE,
  dbOf,
  findInvoiceByRequestKey,
  findKey,
  readSaved,
  saveKey,
  tenantOf,
  tokenSessionOf,
} from '@/lib/api/mobile/faktury-wspolne';
import type {
  FakturaZapisana,
  GusOdpowiedz,
  KontekstKorektyOdpowiedz,
  PozycjaRodzajuTelefonu,
  UsuniecieSzkicuOdpowiedz,
  WyliczenieOdpowiedz,
  WystawienieOdpowiedz,
  ZaliczkaDoRozliczenia,
  ZaliczkiOdpowiedz,
  ZmianaFakturyOdpowiedz,
} from '@/lib/api/mobile/kontrakt';
import { MobileUpstreamError, mobileError, mobileJson } from '@/lib/api/mobile/responses';
import { sciezkaPola } from '@/lib/api/mobile/schematy';
import {
  korektaDoFormularza,
  rozliczenieDoFormularza,
  wyliczenieSchema,
  zaliczkaDoFormularza,
  type SprzedawcaFormularza,
  type wystawienieRodzajuSchema,
} from '@/lib/api/mobile/schematy-rodzaje';
import { readJsonBody } from '@/lib/api/mobile/tresc';
import { deleteDraftInvoice } from '@/lib/invoices/delete-draft';
import { previewAdvance, saveAdvance, saveAndSendAdvance } from '@/lib/invoices/issue-advance';
import {
  getCorrectionParentContext,
  previewCorrection,
  saveAndSendCorrection,
  saveCorrectionDraft,
  type CorrectionIssueContext,
} from '@/lib/invoices/issue-correction';
import { previewFinal, saveAndSendFinal, saveFinal } from '@/lib/invoices/issue-final';
import { readTenantSnapshot } from '@/lib/invoices/issue-regular';
import { resendInvoice, resetInvoiceToDraft } from '@/lib/invoices/ksef-resend';
import { canManageKsefSend, KSEF_SEND_MESSAGES } from '@/lib/invoices/ksef-send-policy';
import { lookupBuyer } from '@/lib/invoices/lookup-buyer';
import { findAdvancesAlreadySettled } from '@/lib/invoices/settled-advances';
import { sellerFromTenantProfile } from '@/lib/invoices/tenant-seller';
import { isUuid } from '@/lib/supabase/active-org';
import {
  advanceInvoiceSchema,
  correctionInvoiceSchema,
  finalInvoiceSchema,
  type CorrectionInvoiceSchemaIn,
} from '@/lib/validators/invoice-validators';
import type { Invoice } from '@/types/invoice';

/**
 * Faktury z telefonu poza zwykłą fakturą VAT (plan aplikacji mobilnej, M8b):
 * zaliczka, rozliczenie zaliczek i korekta (`POST /faktury` z kluczem rodzaju,
 * kwoty z `POST /faktury/wyliczenie`), faktura pierwotna korekty, zaliczki do
 * rozliczenia, „Wyślij ponownie”, „Wróć do szkicu”, usunięcie szkicu i nabywca
 * z GUS.
 *
 * Te same funkcje co akcje strony (`lib/invoices/issue-{advance,final,correction}.ts`,
 * `ksef-resend.ts`, `delete-draft.ts`, `lookup-buyer.ts`), na kliencie z tokenem
 * telefonu (RLS jak na stronie) i z 2FA z tokenu (`tokenSession`). Telefon kwot
 * nie liczy: sprzedawca z bazy firmy, faktura pierwotna i pozycje „przed” z bazy,
 * suma zaliczek z bazy.
 *
 * Ponowienie `POST /faktury` (protokół naprawy, punkt 5), jak w M8
 * (`faktury.ts`): klucz `Idempotency-Key` jest też kluczem zapisu faktury
 * (`number_request_key`, 00199) i trafia do `mobile_idempotency_keys` zaraz po
 * szkicu, przed kolejką KSeF.
 *  - Ten sam klucz i ta sama treść po każdym kroku: 200 z tą samą fakturą
 *    (`powtorzenie`); niczego nie zleca drugi raz (szkicu zaliczki i korekty nie
 *    wysyła się później, jak na stronie: `sendRegularDraft` bierze tylko zwykłą).
 *  - Przerwa po szkicu, przed kluczem: szkic po kluczu zapisu, dopisanie klucza.
 *  - Odmowa kolejki po szkicu: 201 ze szkicem i zdaniem, co zrobić.
 *  - Ten sam klucz z inną treścią: 409 `idempotency_conflict`.
 * „Wyślij ponownie”, „Wróć do szkicu” i usunięcie po zerwanym połączeniu: stan
 * po pierwszym żądaniu (w kolejce, szkic, brak faktury) to 200, nie odmowa.
 */

type Db = ReturnType<typeof dbOf>;
type WystawienieRodzaju = z.infer<typeof wystawienieRodzajuSchema>;

const NOT_FOUND = 'Nie znaleziono tej faktury w wybranej firmie. Odśwież listę faktur.';
const KEY_CONFLICT =
  'Ta faktura została już zapisana z innymi danymi. Otwórz ją na liście faktur albo zacznij nową fakturę.';
const SELLER_MISSING =
  'Uzupełnij poprawne dane sprzedawcy w ustawieniach firmy przed wystawieniem faktury (faktway.pl, Ustawienia, Firma).';
/** Szkicu zaliczki, rozliczenia i korekty nie wysyła się później (jak na stronie, `draft-actions.ts`). */
const SPECIAL_DRAFT_NOT_SENT =
  'Szkic jest zapisany, ale nie poszedł do KSeF. Szkicu zaliczki, rozliczenia ani korekty nie wyślesz później: usuń go i wystaw dokument od nowa.';
const SPECIAL_SEND_FAILED_EARLIER =
  'Ta faktura ma błąd wysyłki do KSeF albo KSeF ją odrzucił. Sprawdź powód w szczególe faktury.';
const SPECIAL_KEY_SAVE_FAILED =
  'Szkic jest zapisany, ale nie wysłaliśmy go do KSeF, bo nie udało się zapisać zabezpieczenia przed podwójną wysyłką. Usuń szkic na liście faktur i wystaw dokument od nowa.';
const RESET_ROLE = 'Do szkicu przywróci fakturę właściciel albo administrator firmy.';
const MAX_BODY_BYTES = 1_000_000;

function readJson(request: Request, headers: Record<string, string>) {
  return readJsonBody(request, headers, { maxBytes: MAX_BODY_BYTES, tooLarge: 'Faktura jest za duża do wysłania z telefonu. Wystaw ją na faktway.pl.' });
}

// ─── Wartości formularza strony z treści telefonu ──────────────────────

const ETYKIETY_POL: Record<string, string> = {
  internalNumber: 'Numer',
  issueDate: 'Data wystawienia',
  paymentDueDate: 'Termin płatności',
  paymentMethod: 'Metoda płatności',
  bankAccount: 'Rachunek',
  splitPayment: 'Podzielona płatność',
  notes: 'Uwagi',
  buyer: 'Nabywca',
  advanceAmount: 'Kwota zaliczki',
  totalContractAmount: 'Wartość zamówienia',
  expectedDeliveryDate: 'Planowana realizacja',
  advanceReceivedDate: 'Data otrzymania zaliczki',
  vatRate: 'Stawka VAT',
  description: 'Opis zaliczki',
  advanceInvoiceIds: 'Zaliczki',
  lines: 'Pozycje',
  linesAfter: 'Pozycje po korekcie',
  linesBefore: 'Pozycje przed korektą',
  correctionReason: 'Przyczyna korekty',
  correctionType: 'Typ korekty',
  amountChange: 'Zmiana kwoty',
};

/**
 * Zdanie pod polem: komunikat schematu strony, a zamiast domyślnego zdania
 * Zod (po angielsku, np. „Too small”) prośba o sprawdzenie pola z nazwą.
 */
function komunikatPola(path: ReadonlyArray<PropertyKey>, message: string): string {
  if (!/^(Invalid|Too (small|big)|Expected|Required|Unrecognized|Number must|String must)/.test(message)) return message;
  const glowa = String(path[0] ?? '');
  const etykieta = ETYKIETY_POL[glowa];
  return etykieta ? `Sprawdź pole „${etykieta}”.` : 'Sprawdź dane dokumentu.';
}

type Sprawdzenie = { ok: true } | { ok: false; response: NextResponse };

/** Ten sam schemat co formularz strony danego dokumentu, z polem pierwszego błędu (422 `invoice_invalid`). */
function sprawdz(schema: z.ZodType, values: unknown, headers: Record<string, string>): Sprawdzenie {
  const parsed = schema.safeParse(values);
  if (parsed.success) return { ok: true };
  const issue = parsed.error.issues[0];
  const path = issue?.path ?? [];
  return {
    ok: false,
    response: mobileError(422, 'invoice_invalid', komunikatPola(path, issue?.message ?? 'Nieprawidłowe dane faktury'), headers, sciezkaPola(path)),
  };
}

function sprzedawcaFirmy(tenant: CorrectionIssueContext['tenant']): SprzedawcaFormularza | null {
  const seller = sellerFromTenantProfile({ nip: tenant.nip, name: tenant.name, address_json: tenant.address });
  if (!seller) return null;
  return {
    nip: seller.nip,
    name: seller.name,
    address: {
      addressLine1: seller.address.addressLine1,
      addressLine2: seller.address.addressLine2 ?? '',
      countryCode: seller.address.countryCode ?? 'PL',
    },
  };
}

/** Kontekst zapisu: klient z tokenem telefonu, firma z bramki, dane firmy z bazy, 2FA z tokenu. */
function kontekst(caller: MobileCaller, tenant: CorrectionIssueContext['tenant']): () => Promise<CorrectionIssueContext> {
  const db = dbOf(caller);
  return async () => ({ supabase: db, userId: caller.user.id, tenant, tokenSession: tokenSessionOf(caller) });
}

type Przygotowanie =
  | { ok: true; rodzaj: 'zaliczka' | 'rozliczenie' | 'korekta'; values: Record<string, unknown> }
  | { ok: false; response: NextResponse };

/** Treść telefonu na wartości formularza strony i sprawdzenie schematem strony (zapis i wyliczenie). */
async function przygotuj(
  caller: MobileCaller,
  tenant: CorrectionIssueContext['tenant'],
  body: { zaliczka: unknown } | { rozliczenie: unknown } | { korekta: unknown },
  klucz: string,
): Promise<Przygotowanie> {
  const headers = caller.headers;
  const typed = body as Partial<Pick<Extract<WystawienieRodzaju, { zaliczka: unknown }>, 'zaliczka'>> &
    Partial<Pick<Extract<WystawienieRodzaju, { rozliczenie: unknown }>, 'rozliczenie'>> &
    Partial<Pick<Extract<WystawienieRodzaju, { korekta: unknown }>, 'korekta'>>;

  if (typed.korekta) {
    const k = typed.korekta;
    if (!isUuid(k.parentInvoiceId)) return { ok: false, response: mobileError(404, 'not_found', NOT_FOUND, headers) };
    const ctx = await getCorrectionParentContext(kontekst(caller, tenant), k.parentInvoiceId.toLowerCase());
    if (!ctx.success) return { ok: false, response: mobileError(422, 'invoice_change_refused', ctx.error, headers) };
    const values = korektaDoFormularza(k, ctx, klucz);
    const checked = sprawdz(correctionInvoiceSchema, values, headers);
    return checked.ok ? { ok: true, rodzaj: 'korekta', values } : checked;
  }

  const seller = sprzedawcaFirmy(tenant);
  if (!seller) return { ok: false, response: mobileError(422, 'invoice_invalid', SELLER_MISSING, headers) };
  if (typed.zaliczka) {
    const values = zaliczkaDoFormularza(typed.zaliczka, seller, klucz);
    const checked = sprawdz(advanceInvoiceSchema, values, headers);
    return checked.ok ? { ok: true, rodzaj: 'zaliczka', values } : checked;
  }
  const values = rozliczenieDoFormularza(typed.rozliczenie!, seller, klucz);
  const checked = sprawdz(finalInvoiceSchema, values, headers);
  return checked.ok ? { ok: true, rodzaj: 'rozliczenie', values } : checked;
}

// ─── POST /faktury: zaliczka, rozliczenie, korekta ─────────────────────

function wysylkaPoPowtorzeniu(saved: FakturaZapisana): WystawienieOdpowiedz['wysylka'] {
  if (SEND_IN_PROGRESS_OR_DONE.has(saved.ksefStatus)) return { zlecona: true, blad: null };
  return { zlecona: false, blad: saved.ksefStatus === 'draft' ? SPECIAL_DRAFT_NOT_SENT : SPECIAL_SEND_FAILED_EARLIER };
}

/** Ile razy i co ile ms powtórzenie dopytuje o szkic, który pierwsze żądanie może właśnie zlecać do KSeF. */
const DOPYTANIA_O_KOLEJKE = 4;
const PRZERWA_DOPYTANIA_MS = 500;

/**
 * Powtórzenie po kluczu: zapisany dokument; nic nie zlecamy drugi raz. Szkic przy
 * `wyslij` bywa chwilowy: ponowienie po limicie czasu telefonu przychodzi, gdy
 * pierwsze żądanie jeszcze zleca wysyłkę (klucz jest zapisany przed kolejką), więc
 * zanim powiemy „nie poszło do KSeF”, dopytujemy o stan przez około 2 s.
 */
async function powtorzenie(caller: MobileCaller, invoiceId: string, wyslij: boolean): Promise<NextResponse> {
  const db = dbOf(caller);
  const tenantId = tenantOf(caller);
  let saved = await readSaved(db, tenantId, invoiceId);
  for (let i = 0; wyslij && saved?.ksefStatus === 'draft' && i < DOPYTANIA_O_KOLEJKE; i++) {
    await new Promise((resolve) => setTimeout(resolve, PRZERWA_DOPYTANIA_MS));
    saved = await readSaved(db, tenantId, invoiceId);
  }
  // Klucz usuwa się razem z fakturą (ON DELETE CASCADE): tu faktura zawsze jest.
  if (!saved) throw new MobileUpstreamError('mobile_idempotency_keys.invoice');
  const body: WystawienieOdpowiedz = { faktura: saved, powtorzenie: true, wysylka: wyslij ? wysylkaPoPowtorzeniu(saved) : null };
  return mobileJson(body, 200, caller.headers);
}

type WynikZapisu = { success: true; invoiceId: string } | { success: false; error: string; invoiceId?: string };

/** `POST /api/mobile/v1/faktury` z kluczem `zaliczka`, `rozliczenie` albo `korekta` (M8b). */
export async function issueSpecialFromMobile(caller: MobileCaller, key: string, body: WystawienieRodzaju, hash: string): Promise<NextResponse> {
  const headers = caller.headers;
  const db = dbOf(caller);
  const tenantId = tenantOf(caller);
  const userId = caller.user.id;
  const { wyslij } = body;

  const earlier = await findKey(db, tenantId, userId, key);
  if (earlier) {
    if (earlier.request_hash !== hash) return mobileError(409, 'idempotency_conflict', KEY_CONFLICT, headers);
    return powtorzenie(caller, earlier.invoice_id, wyslij);
  }
  // Przerwa po szkicu, przed wierszem klucza: szkic po kluczu zapisu faktury.
  const orphan = await findInvoiceByRequestKey(db, tenantId, key);
  if (orphan) {
    await saveKey(db, tenantId, userId, key, hash, orphan.id, SPECIAL_KEY_SAVE_FAILED);
    return powtorzenie(caller, orphan.id, wyslij);
  }

  const tenant = await readTenantSnapshot(db, tenantId);
  const ready = await przygotuj(caller, tenant, body, key);
  if (!ready.ok) return ready.response;

  const context = kontekst(caller, tenant);
  let keySaved = false;
  const afterDraftSaved = async (invoiceId: string): Promise<{ ok: true } | { ok: false; error: string }> => {
    const k = await saveKey(db, tenantId, userId, key, hash, invoiceId, SPECIAL_KEY_SAVE_FAILED);
    if (k.ok) {
      keySaved = true;
      return k;
    }
    // Równoległe ponowienie (ta sama treść) zdążyło dopisać klucz do tego szkicu: to ten sam zapis, więc
    // wysyłka idzie dalej stąd (ponowienie jej nie zleca, tylko czeka na stan), bez drugiego zlecenia.
    const existing = await findKey(db, tenantId, userId, key);
    if (existing && existing.request_hash === hash && existing.invoice_id === invoiceId) {
      keySaved = true;
      return { ok: true };
    }
    return k;
  };
  const values = ready.values;
  let result: WynikZapisu;
  try {
    if (ready.rodzaj === 'zaliczka') {
      result = wyslij ? await saveAndSendAdvance(context, values, afterDraftSaved) : await saveAdvance(context, values);
    } else if (ready.rodzaj === 'rozliczenie') {
      // Wysyłka ROZ jest dziś wstrzymana (strona tak samo): odmowa przed zapisem, zdanie strony.
      result = wyslij ? await saveAndSendFinal(context, values) : await saveFinal(context, values);
    } else {
      const raw = values as CorrectionInvoiceSchemaIn;
      result = wyslij ? await saveAndSendCorrection(context, raw, afterDraftSaved) : await saveCorrectionDraft(context, raw);
    }
  } catch (error) {
    // Funkcje zapisu łapią błędy same; tu tylko nieoczekiwany wyjątek. Gdy szkic powstał,
    // klient ma usłyszeć, że jest (protokół naprawy, punkt 4), zamiast 500 bez wyjścia.
    const draft = await findInvoiceByRequestKey(db, tenantId, key);
    if (!draft) throw error;
    Sentry.captureException(error, { tags: { area: 'api.mobile.faktury-rodzaje' }, extra: { requestId: caller.requestId, invoiceId: draft.id } });
    result = { success: false, error: SPECIAL_DRAFT_NOT_SENT, invoiceId: draft.id };
  }

  // Odmowa bez identyfikatora mogła przyjść po zapisie szkicu (np. wyjątek złapany w funkcji
  // zapisu) albo po równoległym żądaniu z tym samym kluczem: szkic szukamy po kluczu zapisu.
  const invoiceId = result.success ? result.invoiceId : (result.invoiceId ?? (await findInvoiceByRequestKey(db, tenantId, key))?.id);
  if (!invoiceId) {
    const code = wyslij && ready.rodzaj === 'rozliczenie' ? 'ksef_send_refused' : 'invoice_invalid';
    return mobileError(422, code, result.success ? NOT_FOUND : result.error, headers);
  }
  if (!keySaved) {
    keySaved = (await saveKey(db, tenantId, userId, key, hash, invoiceId, SPECIAL_KEY_SAVE_FAILED)).ok;
    // Równoległe żądanie z tym samym kluczem zdążyło pierwsze: oddajemy jego fakturę.
    if (!keySaved) {
      const winner = await findKey(db, tenantId, userId, key);
      if (winner && winner.request_hash === hash) return powtorzenie(caller, winner.invoice_id, wyslij);
    }
  }
  if (!wyslij && result.success) revalidatePath('/invoices');

  const saved = await readSaved(db, tenantId, invoiceId);
  if (!saved) throw new MobileUpstreamError('invoices.after_save');
  const odpowiedz: WystawienieOdpowiedz = {
    faktura: saved,
    powtorzenie: false,
    wysylka: wyslij ? (result.success ? { zlecona: true, blad: null } : { zlecona: false, blad: result.error }) : null,
  };
  return mobileJson(odpowiedz, 201, headers);
}

// ─── POST /faktury/wyliczenie ──────────────────────────────────────────

function pozycjeWyliczone(invoice: Invoice): WyliczenieOdpowiedz['pozycje'] {
  return invoice.lines.map((l) => ({
    nazwa: l.name,
    ilosc: l.quantity,
    jednostka: l.unit,
    cenaNetto: l.unitPriceNet,
    stawka: String(l.vatRate),
    netto: l.netAmount,
    vat: l.vatAmount,
    brutto: l.grossAmount,
  }));
}

function kwoty(invoice: Invoice, zaliczki: WyliczenieOdpowiedz['zaliczki']): WyliczenieOdpowiedz {
  return {
    netto: invoice.netTotal,
    vat: invoice.vatTotal,
    brutto: invoice.grossTotal,
    doZaplaty: invoice.payment.amountDue,
    pozycje: pozycjeWyliczone(invoice),
    zaliczki,
  };
}

/**
 * `POST /api/mobile/v1/faktury/wyliczenie` (M8b): kwoty dokumentu tymi samymi
 * krokami co zapis, bez zapisu i bez numeru z serii. Nic nie zmienia w bazie.
 */
export async function previewFromMobile(caller: MobileCaller, request: Request): Promise<NextResponse> {
  const headers = caller.headers;
  const raw = await readJson(request, headers);
  if (!raw.ok) return raw.response;
  const parsed = wyliczenieSchema.safeParse(raw.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return mobileError(400, 'invalid_request', `Treść żądania nie pasuje do kontraktu (${sciezkaPola(issue?.path ?? []) ?? 'treść'}). Zaktualizuj aplikację FaktWay.`, headers);
  }
  const tenant = await readTenantSnapshot(dbOf(caller), tenantOf(caller));
  // Bez klucza zapisu: wyliczenie niczego nie zapisuje.
  const ready = await przygotuj(caller, tenant, parsed.data, '');
  if (!ready.ok) return ready.response;
  const context = kontekst(caller, tenant);

  if (ready.rodzaj === 'zaliczka') {
    const w = await previewAdvance(context, ready.values);
    if (!w.success) return mobileError(422, 'invoice_invalid', w.error, headers);
    return mobileJson(kwoty(w.invoice, []), 200, headers);
  }
  if (ready.rodzaj === 'rozliczenie') {
    const w = await previewFinal(context, ready.values);
    if (!w.success) return mobileError(422, 'invoice_invalid', w.error, headers);
    // Wiersze rozliczenia idą w kolejności wybranych zaliczek (`fetchSettlementRows`).
    const ids = (ready.values.advanceInvoiceIds as string[]) ?? [];
    const zaliczki = w.settlement.map((r, i) => ({ id: ids[i] ?? '', numer: r.internal_number, brutto: r.advance_amount }));
    return mobileJson(kwoty(w.invoice, zaliczki), 200, headers);
  }
  const w = await previewCorrection(context, ready.values as CorrectionInvoiceSchemaIn);
  if (!w.success) return mobileError(422, 'invoice_invalid', w.error, headers);
  return mobileJson(kwoty(w.invoice, []), 200, headers);
}

// ─── GET /faktury/{id}/korekta ─────────────────────────────────────────

/** `GET /api/mobile/v1/faktury/{id}/korekta` (M8b): kontekst formularza korekty, jak na stronie. */
export async function correctionContextFromMobile(caller: MobileCaller, invoiceId: string): Promise<NextResponse> {
  const headers = caller.headers;
  if (!isUuid(invoiceId)) return mobileError(404, 'not_found', NOT_FOUND, headers);
  const tenant = await readTenantSnapshot(dbOf(caller), tenantOf(caller));
  const ctx = await getCorrectionParentContext(kontekst(caller, tenant), invoiceId.toLowerCase());
  if (!ctx.success) return mobileError(422, 'invoice_change_refused', ctx.error, headers);
  if (ctx.allowedCorrectionTypes === 'none') return mobileError(422, 'invoice_change_refused', 'Tej faktury nie można już korygować.', headers);

  const b = ctx.buyer;
  const body: KontekstKorektyOdpowiedz = {
    faktura: {
      id: invoiceId.toLowerCase(),
      numer: ctx.internalNumber ?? '',
      numerKsef: ctx.ksefNumber ?? '',
      dataWystawienia: ctx.issueDate,
      brutto: ctx.grossTotal,
    },
    nabywca: {
      nazwa: b.name,
      nip: b.type === 'b2b' ? b.nip : null,
      vatUe: ctx.buyerVatUe ?? null,
      osoba: b.type === 'b2c',
      adres1: b.address.addressLine1,
      adres2: b.address.addressLine2 ?? '',
    },
    dozwolone: ctx.allowedCorrectionTypes,
    poprzedniaKorekta: ctx.previousCorrection ? { numer: ctx.previousCorrection.internalNumber, typ: ctx.previousCorrection.correctionType } : null,
    stawkaBezVat: ctx.amountChangeVatRate ?? null,
    npIiDozwolone: ctx.npIiAllowed,
    pozycje: ctx.linesBefore.map((l): PozycjaRodzajuTelefonu => ({
      name: l.name,
      unit: l.unit,
      quantity: l.quantity,
      unitPriceNet: l.unitPriceNet,
      vatRate: l.vatRate,
    })),
  };
  return mobileJson(body, 200, headers);
}

// ─── GET /faktury/zaliczki ─────────────────────────────────────────────

interface ZaliczkaRow {
  id: string;
  internal_number: string | null;
  ksef_number: string | null;
  issue_date: string | null;
  advance_amount: unknown;
  gross_total: unknown;
  buyer_nip: string | null;
  buyer_data: unknown;
}

function nabywcaZaliczki(row: ZaliczkaRow): ZaliczkaDoRozliczenia['nabywca'] {
  const d = row.buyer_data && typeof row.buyer_data === 'object' && !Array.isArray(row.buyer_data) ? (row.buyer_data as Record<string, unknown>) : {};
  const adres = d.address && typeof d.address === 'object' ? (d.address as Record<string, unknown>) : {};
  const tekst = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    nazwa: tekst(d.name),
    nip: row.buyer_nip?.replace(/\D/g, '') || null,
    adres1: tekst(adres.addressLine1),
    adres2: tekst(adres.addressLine2),
    email: tekst(d.email),
  };
}

/**
 * `GET /api/mobile/v1/faktury/zaliczki` (M8b): zaliczki przyjęte w KSeF, jeszcze
 * nierozliczone, z tymi samymi warunkami co lista formularza rozliczenia na
 * stronie (`app/(dashboard)/invoices/new/final/page.tsx`); do tego nabywca, bo
 * rozliczenie obejmuje tylko zaliczki tego samego nabywcy. Zapis sprawdza to
 * jeszcze raz z bazy (`resolveFinalPayload`, wyzwalacz 00125).
 */
export async function settleableAdvancesFromMobile(caller: MobileCaller): Promise<NextResponse> {
  const db = dbOf(caller);
  const tenantId = tenantOf(caller);
  const { data, error } = await db
    .from('invoices')
    .select('id, internal_number, ksef_number, issue_date, advance_amount, gross_total, buyer_nip, buyer_data')
    .eq('tenant_id', tenantId)
    .eq('direction', 'outgoing')
    .eq('ksef_status', 'accepted')
    .eq('invoice_kind', 'advance')
    .order('issue_date', { ascending: false })
    .limit(120);
  if (error) throw new MobileUpstreamError('invoices.advances');
  let available = (data ?? []) as unknown as ZaliczkaRow[];
  // AUD-67, jak na stronie: zaliczki już wskazane w innej ROZ nie trafiają na listę. Gdy odczyt
  // się nie uda, lista zostaje pełna (zapis i tak sprawdza akcja i wyzwalacz bazy 00125).
  try {
    const settled = await findAdvancesAlreadySettled(db, tenantId, available.map((a) => a.id));
    available = available.filter((a) => !settled.has(a.id));
  } catch {
    // celowo: patrz komentarz wyżej
  }
  const body: ZaliczkiOdpowiedz = {
    zaliczki: available.map((r) => ({
      id: r.id,
      numer: r.internal_number ?? '',
      numerKsef: r.ksef_number,
      dataWystawienia: r.issue_date ?? '',
      // Kwota rozliczenia jak `fetchSettlementRows`: zaliczka, a bez niej brutto faktury.
      brutto: Number(r.advance_amount ?? r.gross_total ?? 0),
      nabywca: nabywcaZaliczki(r),
    })),
  };
  return mobileJson(body, 200, caller.headers);
}

// ─── Ponowienie, szkic, usunięcie ──────────────────────────────────────

async function stan(db: Db, tenantId: string, invoiceId: string): Promise<FakturaZapisana | null> {
  return readSaved(db, tenantId, invoiceId);
}

/**
 * `POST /api/mobile/v1/faktury/{id}/ponowienie` (M8b): „Wyślij ponownie” po błędzie
 * wysyłki, jak przycisk strony (`resendInvoice`: kto i kiedy według
 * `ksef-send-policy.ts`; odrzuconej nie, ona wraca do szkicu). Ponowienie po
 * zerwanym połączeniu: faktura już w kolejce daje 200, nic nie idzie drugi raz.
 */
export async function resendFromMobile(caller: MobileCaller, invoiceId: string): Promise<NextResponse> {
  const headers = caller.headers;
  if (!isUuid(invoiceId)) return mobileError(404, 'not_found', NOT_FOUND, headers);
  const id = invoiceId.toLowerCase();
  const db = dbOf(caller);
  const tenantId = tenantOf(caller);
  const role = caller.org!.role;
  if (!canManageKsefSend(role)) return mobileError(403, 'forbidden', KSEF_SEND_MESSAGES.role, headers);

  const sent = await resendInvoice(async () => ({ supabase: db, userId: caller.user.id, tenantId, role, tokenSession: tokenSessionOf(caller) }), id);
  const now = await stan(db, tenantId, id);
  if (!sent.success) {
    if (!now) return mobileError(404, 'not_found', NOT_FOUND, headers);
    if (SEND_IN_PROGRESS_OR_DONE.has(now.ksefStatus)) return mobileJson({ faktura: now } satisfies ZmianaFakturyOdpowiedz, 200, headers);
    return mobileError(422, 'invoice_change_refused', sent.error, headers);
  }
  if (!now) throw new MobileUpstreamError('invoices.after_resend');
  return mobileJson({ faktura: now } satisfies ZmianaFakturyOdpowiedz, 200, headers);
}

/**
 * `POST /api/mobile/v1/faktury/{id}/szkic` (M8b): „Wróć do szkicu” po błędzie
 * wysyłki albo odrzuceniu, jak przycisk strony (RPC `reset_ksef_send`, właściciel
 * albo administrator). Ponowienie: faktura już szkicem daje 200.
 */
export async function resetToDraftFromMobile(caller: MobileCaller, invoiceId: string): Promise<NextResponse> {
  const headers = caller.headers;
  if (!isUuid(invoiceId)) return mobileError(404, 'not_found', NOT_FOUND, headers);
  const id = invoiceId.toLowerCase();
  const db = dbOf(caller);
  const tenantId = tenantOf(caller);
  const role = caller.org!.role;
  if (role !== 'owner' && role !== 'admin') return mobileError(403, 'forbidden', RESET_ROLE, headers);

  const before = await stan(db, tenantId, id);
  if (!before) return mobileError(404, 'not_found', NOT_FOUND, headers);
  if (before.ksefStatus === 'draft') return mobileJson({ faktura: before } satisfies ZmianaFakturyOdpowiedz, 200, headers);

  const reset = await resetInvoiceToDraft(async () => ({ userId: caller.user.id, tenantId }), id);
  const now = await stan(db, tenantId, id);
  if (!reset.success) {
    if (now?.ksefStatus === 'draft') return mobileJson({ faktura: now } satisfies ZmianaFakturyOdpowiedz, 200, headers);
    return mobileError(422, 'invoice_change_refused', reset.error, headers);
  }
  if (!now) throw new MobileUpstreamError('invoices.after_reset');
  return mobileJson({ faktura: now } satisfies ZmianaFakturyOdpowiedz, 200, headers);
}

/**
 * `POST /api/mobile/v1/faktury/{id}/usuniecie` (M8b): usunięcie szkicu jak na
 * stronie (`deleteDraftInvoice`: szkic wycofany zwykłej faktury i zaliczki
 * zostaje, okres faktury cyklicznej wraca). Zmiana szkicu z telefonu to, jak na
 * stronie, usunięcie i nowy dokument z jego danymi. Ponowienie po zerwanym
 * połączeniu: faktury już nie ma, więc 200.
 */
export async function deleteDraftFromMobile(caller: MobileCaller, invoiceId: string): Promise<NextResponse> {
  const headers = caller.headers;
  if (!isUuid(invoiceId)) return mobileError(404, 'not_found', NOT_FOUND, headers);
  const id = invoiceId.toLowerCase();
  const db = dbOf(caller);
  const tenantId = tenantOf(caller);

  const deleted = await deleteDraftInvoice(async () => ({ supabase: db, userId: caller.user.id, tenantId }), id);
  if (!deleted.success) {
    const now = await stan(db, tenantId, id);
    if (!now) return mobileJson({ usuniety: true } satisfies UsuniecieSzkicuOdpowiedz, 200, headers);
    return mobileError(422, 'invoice_change_refused', deleted.error, headers);
  }
  revalidatePath(`/invoices/${id}`);
  return mobileJson({ usuniety: true } satisfies UsuniecieSzkicuOdpowiedz, 200, headers);
}

// ─── GET /gus/{nip} ────────────────────────────────────────────────────

const GUS_UNAVAILABLE_HEADERS = { 'Retry-After': '30' };

/**
 * `GET /api/mobile/v1/gus/{nip}` (M8b): nabywca po NIP jak „Pobierz z GUS” na
 * stronie (`lookupBuyer`: najpierw kontrahenci firmy, potem GUS, z zapisem
 * podpowiedzi w kontrahentach tokenem klienta).
 */
export async function gusLookupFromMobile(caller: MobileCaller, nip: string): Promise<NextResponse> {
  const headers = caller.headers;
  const db = dbOf(caller);
  const tenantId = tenantOf(caller);
  const found = await lookupBuyer(async () => ({ supabase: db, tenantId }), nip.replace(/[\s-]/g, ''));
  if (!found.success) {
    if (found.reason === 'nip') return mobileError(422, 'invoice_invalid', found.error, headers, 'buyerNip');
    if (found.reason === 'not_found') return mobileError(404, 'not_found', found.error, headers);
    return mobileError(503, 'service_unavailable', found.reason === 'unavailable' ? found.error : 'Nie możemy teraz sprawdzić NIP. Spróbuj ponownie za chwilę albo wpisz dane ręcznie.', {
      ...headers,
      ...GUS_UNAVAILABLE_HEADERS,
    });
  }
  const body: GusOdpowiedz = {
    zrodlo: found.source === 'cache' ? 'kontrahenci' : 'gus',
    nabywca: { nip: found.data.nip, nazwa: found.data.name, adres1: found.data.addressLine1, adres2: found.data.addressLine2 },
  };
  return mobileJson(body, 200, headers);
}
