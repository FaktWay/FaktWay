import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import type { NextResponse } from 'next/server';

import type { MobileCaller } from '@/lib/api/mobile/auth';
import type {
  PodpowiedzFakturyOdpowiedz,
  WystawienieOdpowiedz,
  WysylkaSzkicuOdpowiedz,
} from '@/lib/api/mobile/kontrakt';
import { MobileUpstreamError, mobileError, mobileJson } from '@/lib/api/mobile/responses';
import { readJsonBody } from '@/lib/api/mobile/tresc';
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
import { issueSpecialFromMobile } from '@/lib/api/mobile/faktury-rodzaje';
import { doWartosciFormularza, sciezkaPola, wystawienieSchema } from '@/lib/api/mobile/schematy';
import { rodzajTresci, wystawienieRodzajuSchema } from '@/lib/api/mobile/schematy-rodzaje';
import { requestDigest } from '@/lib/api/v1/invoice-create';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import {
  parseRegularInvoiceForm,
  readTenantSnapshot,
  saveAndSendRegularInvoice,
  saveRegularDraft,
  type RegularIssueContext,
  type RegularIssueResult,
} from '@/lib/invoices/issue-regular';
import { loadInvoiceNumbering } from '@/lib/numeracja/baza';
import { selectedNumberingOption } from '@/lib/numeracja/model';
import type { InvoiceKind } from '@/lib/numeracja/wzor';
import { CORRECTION_PROD_SEND_HOLD_MESSAGE } from '@/lib/invoices/issue-correction';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { ROZ_SUBMISSION_HOLD_MESSAGE } from '@/lib/ksef/roz-submission-hold';
import { sendRegularDraft } from '@/lib/invoices/send-draft';
import { readTenantVatExemption } from '@/lib/invoices/vat-exemption';
import { isUuid } from '@/lib/supabase/active-org';

/**
 * Faktury z telefonu (plan aplikacji mobilnej, M8): szybka faktura (szkic albo
 * „Wyślij do KSeF”), wysyłka szkicu i podpowiedź do pustego formularza.
 *
 * Te same funkcje co akcje strony (`lib/invoices/issue-regular.ts`,
 * `lib/invoices/send-draft.ts`), na kliencie z tokenem telefonu (RLS jak na
 * stronie) i z 2FA z tokenu (`tokenSession`).
 *
 * Ponowienie `POST /faktury` (protokół naprawy, punkt 5). Klucz z nagłówka
 * `Idempotency-Key` (UUID na jedno wypełnienie formularza) trafia do
 * `mobile_idempotency_keys` (00201) zaraz po zapisie szkicu, przed kolejką KSeF:
 *  - po każdym kroku ponowienie z tym samym kluczem i tą samą treścią oddaje
 *    tę samą fakturę (200, `powtorzenie: true`);
 *  - przerwa po szkicu, przed kluczem: ten sam klucz idzie też jako klucz zapisu
 *    faktury (`number_request_key`, 00199), więc ponowienie znajduje szkic po
 *    nim, dopisuje klucz i oddaje szkic (drugi INSERT odbija wyzwalacz
 *    `invoice_number_request_done`);
 *  - przerwa po kluczu, przed kolejką (albo kolejka odmówiła): ponowienie
 *    z `wyslij: true` zleca wysyłkę szkicu jak „Wyślij” (RPC przejmuje tylko szkic);
 *  - po kolejce: ponowienie widzi stan inny niż szkic i niczego nie zleca;
 *  - ten sam klucz z inną treścią: 409 `idempotency_conflict`.
 */

/** Największa treść żądania (jak publiczne API: 1000 pozycji z długimi nazwami z zapasem). */
const MAX_BODY_BYTES = 1_000_000;

const SEND_AFTER_DRAFT_FAILED =
  'Szkic faktury jest zapisany, ale zlecenie wysyłki do KSeF się nie udało. Otwórz szkic na liście faktur i wyślij go jeszcze raz.';
const SEND_FAILED_EARLIER =
  'Ta faktura ma błąd wysyłki do KSeF albo KSeF ją odrzucił. Sprawdź powód w szczególe faktury i popraw ją na faktway.pl.';

function readJson(request: Request, headers: Record<string, string>) {
  return readJsonBody(request, headers, { maxBytes: MAX_BODY_BYTES, tooLarge: 'Faktura jest za duża do wysłania z telefonu. Wystaw ją na faktway.pl.' });
}

const MISSING_KEY = 'Brak klucza zapisu (Idempotency-Key). Zaktualizuj aplikację FaktWay i spróbuj ponownie.';
const KEY_CONFLICT =
  'Ta faktura została już zapisana z innymi danymi. Otwórz ją na liście faktur albo zacznij nową fakturę.';
const NOT_FOUND = 'Nie znaleziono tej faktury w wybranej firmie. Odśwież listę faktur.';

/** Odmowa wystawienia: zdanie z akcji strony (co poprawić), szkic tylko gdy powstał. */
function refusal(result: Extract<RegularIssueResult, { success: false }>, headers: Record<string, string>): NextResponse {
  return mobileError(422, 'invoice_invalid', result.error, headers);
}

/** Powtórzenie po kluczu: zapisana faktura; przy `wyslij` szkic idzie do kolejki jak „Wyślij”. */
async function replay(caller: MobileCaller, invoiceId: string, wyslij: boolean): Promise<NextResponse> {
  const db = dbOf(caller);
  const tenantId = tenantOf(caller);
  const saved = await readSaved(db, tenantId, invoiceId);
  // Klucz usuwa się razem z fakturą (ON DELETE CASCADE): tu faktura zawsze jest.
  if (!saved) throw new MobileUpstreamError('mobile_idempotency_keys.invoice');

  let wysylka: WystawienieOdpowiedz['wysylka'] = null;
  let faktura = saved;
  if (wyslij && saved.ksefStatus === 'draft') {
    const sent = await sendRegularDraft({ supabase: db, userId: caller.user.id, tenantId, tokenSession: tokenSessionOf(caller) }, invoiceId);
    // Stan po próbie: zlecenie zmienia go na `queued`; odmowa RPC bywa też tym, że równoległe
    // pierwsze żądanie właśnie przejęło szkic (wtedy faktura jest w kolejce, a nie „niewysłana”).
    faktura = (await readSaved(db, tenantId, invoiceId)) ?? saved;
    wysylka = sent.success || SEND_IN_PROGRESS_OR_DONE.has(faktura.ksefStatus) ? { zlecona: true, blad: null } : { zlecona: false, blad: sent.error };
  } else if (wyslij) {
    wysylka = SEND_IN_PROGRESS_OR_DONE.has(saved.ksefStatus)
      ? { zlecona: true, blad: null }
      : { zlecona: false, blad: SEND_FAILED_EARLIER };
  }
  const body: WystawienieOdpowiedz = { faktura, powtorzenie: true, wysylka };
  return mobileJson(body, 200, caller.headers);
}

/** `POST /api/mobile/v1/faktury`. */
export async function issueInvoiceFromMobile(caller: MobileCaller, request: Request): Promise<NextResponse> {
  const headers = caller.headers;
  const key = request.headers.get('idempotency-key')?.trim().toLowerCase() ?? '';
  if (!isUuid(key)) return mobileError(400, 'missing_idempotency_key', MISSING_KEY, headers);

  const raw = await readJson(request, headers);
  if (!raw.ok) return raw.response;
  // M8b: zaliczka, rozliczenie i korekta tą samą trasą (klucz rodzaju zamiast `faktura`).
  if (rodzajTresci(raw.value)) {
    const special = wystawienieRodzajuSchema.safeParse(raw.value);
    if (!special.success) {
      const issue = special.error.issues[0];
      return mobileError(400, 'invalid_request', `Treść żądania nie pasuje do kontraktu (${sciezkaPola(issue?.path ?? []) ?? 'treść'}). Zaktualizuj aplikację FaktWay.`, headers);
    }
    return issueSpecialFromMobile(caller, key, special.data, requestDigest(raw.value));
  }
  const parsed = wystawienieSchema.safeParse(raw.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return mobileError(400, 'invalid_request', `Treść żądania nie pasuje do kontraktu (${sciezkaPola(issue?.path ?? []) ?? 'treść'}). Zaktualizuj aplikację FaktWay.`, headers);
  }
  const { wyslij, faktura } = parsed.data;
  const hash = requestDigest(raw.value);
  const db = dbOf(caller);
  const tenantId = tenantOf(caller);
  const userId = caller.user.id;

  const earlier = await findKey(db, tenantId, userId, key);
  if (earlier) {
    if (earlier.request_hash !== hash) return mobileError(409, 'idempotency_conflict', KEY_CONFLICT, headers);
    return replay(caller, earlier.invoice_id, wyslij);
  }

  // Przerwa po szkicu, przed wierszem klucza: szkic znajdziemy po kluczu zapisu faktury.
  const orphan = await findInvoiceByRequestKey(db, tenantId, key);
  if (orphan) {
    await saveKey(db, tenantId, userId, key, hash, orphan.id);
    return replay(caller, orphan.id, wyslij);
  }

  // Ten sam schemat i te same komunikaty co formularz strony. Klucz żądania jest też
  // kluczem zapisu faktury (00199): drugi INSERT z nim odbija baza.
  const values = { ...doWartosciFormularza(faktura), numberRequestKey: key };
  const checked = parseRegularInvoiceForm(values);
  if (!checked.ok) return mobileError(422, 'invoice_invalid', checked.error, headers, sciezkaPola(checked.path));

  const ctx: RegularIssueContext = { supabase: db, userId, tenant: await readTenantSnapshot(db, tenantId), tokenSession: tokenSessionOf(caller) };
  let keySaved = false;
  let result: RegularIssueResult;
  try {
    result = wyslij
      ? await saveAndSendRegularInvoice(ctx, values, async (invoiceId) => {
          const k = await saveKey(db, tenantId, userId, key, hash, invoiceId);
          keySaved = k.ok;
          return k;
        })
      : await saveRegularDraft(ctx, values);
  } catch (error) {
    // Wyjątek po zapisie szkicu (np. kolejka): klient ma usłyszeć, że szkic jest, i co zrobić,
    // zamiast 500 bez wyjścia (protokół naprawy, punkt 4). Bez szkicu: zwykła obsługa błędu trasy.
    const draft = await findInvoiceByRequestKey(db, tenantId, key);
    if (!draft) throw error;
    Sentry.captureException(error, { tags: { area: 'api.mobile.faktury' }, extra: { requestId: caller.requestId, invoiceId: draft.id } });
    if (!keySaved) keySaved = (await saveKey(db, tenantId, userId, key, hash, draft.id)).ok;
    const body: WystawienieOdpowiedz = {
      faktura: draft,
      powtorzenie: false,
      wysylka: wyslij
        ? SEND_IN_PROGRESS_OR_DONE.has(draft.ksefStatus) ? { zlecona: true, blad: null } : { zlecona: false, blad: SEND_AFTER_DRAFT_FAILED }
        : null,
    };
    return mobileJson(body, 201, headers);
  }

  if (!wyslij && result.success) {
    // Szkic bez kolejki: klucz po zapisie (przerwę między nimi łapie unikalny numer faktury).
    keySaved = (await saveKey(db, tenantId, userId, key, hash, result.invoiceId)).ok;
    revalidatePath('/invoices');
  }

  // Równoległe żądanie z tym samym kluczem zdążyło pierwsze: oddajemy jego fakturę.
  if (!keySaved) {
    const winner = await findKey(db, tenantId, userId, key);
    if (winner && winner.request_hash === hash) return replay(caller, winner.invoice_id, wyslij);
  }

  if (!result.success && !result.invoiceId) return refusal(result, headers);

  const invoiceId = result.success ? result.invoiceId : result.invoiceId!;
  const saved = await readSaved(db, tenantId, invoiceId);
  if (!saved) throw new MobileUpstreamError('invoices.after_save');
  const body: WystawienieOdpowiedz = {
    faktura: saved,
    powtorzenie: false,
    wysylka: wyslij ? (result.success ? { zlecona: true, blad: null } : { zlecona: false, blad: result.error }) : null,
  };
  return mobileJson(body, 201, headers);
}

/** `POST /api/mobile/v1/faktury/{id}/wysylka`. */
export async function sendDraftFromMobile(caller: MobileCaller, invoiceId: string): Promise<NextResponse> {
  const headers = caller.headers;
  if (!isUuid(invoiceId)) return mobileError(404, 'not_found', NOT_FOUND, headers);
  const db = dbOf(caller);
  const tenantId = tenantOf(caller);

  const sent = await sendRegularDraft({ supabase: db, userId: caller.user.id, tenantId, tokenSession: tokenSessionOf(caller) }, invoiceId.toLowerCase());
  if (!sent.success) {
    if (sent.reason === 'not_found') return mobileError(404, 'not_found', NOT_FOUND, headers);
    if (sent.reason === 'not_draft') {
      const saved = await readSaved(db, tenantId, invoiceId.toLowerCase());
      // Ponowienie po zerwanym połączeniu: wysyłka już zlecona, nic nie wysyłamy drugi raz.
      if (saved && SEND_IN_PROGRESS_OR_DONE.has(saved.ksefStatus)) {
        const body: WysylkaSzkicuOdpowiedz = { faktura: saved, juzZlecona: true };
        return mobileJson(body, 200, headers);
      }
      return mobileError(409, 'not_draft', 'Ta faktura nie jest szkicem. Odrzuconą albo z błędem wysyłki popraw na faktway.pl.', headers);
    }
    // Odmowa RPC, bo równoległe żądanie właśnie zleciło wysyłkę: to nie błąd dla klienta.
    const now = await readSaved(db, tenantId, invoiceId.toLowerCase());
    if (now && SEND_IN_PROGRESS_OR_DONE.has(now.ksefStatus)) {
      const body: WysylkaSzkicuOdpowiedz = { faktura: now, juzZlecona: true };
      return mobileJson(body, 200, headers);
    }
    return mobileError(422, 'ksef_send_refused', sent.error, headers);
  }
  revalidatePath('/invoices');
  revalidatePath(`/invoices/${invoiceId.toLowerCase()}`);
  const saved = await readSaved(db, tenantId, invoiceId.toLowerCase());
  if (!saved) throw new MobileUpstreamError('invoices.after_send');
  const body: WysylkaSzkicuOdpowiedz = { faktura: saved, juzZlecona: false };
  return mobileJson(body, 200, headers);
}

/** `?rodzaj=` podpowiedzi (M8b): rodzaj numeracji jak formularz strony danego dokumentu. */
const RODZAJ_NUMERACJI: Record<string, InvoiceKind> = {
  vat: 'regular',
  zaliczka: 'advance',
  rozliczenie: 'final',
  korekta: 'correction',
};

/**
 * `GET /api/mobile/v1/faktury/podpowiedz`: numer, seria, dziś i zwolnienie z VAT,
 * jak pusty formularz strony (`loadInvoiceNumbering`, krok 2.5). Od M8b
 * `?rodzaj=zaliczka|rozliczenie|korekta` daje serię i numer tego dokumentu;
 * bez parametru zwykła faktura (jak w M8).
 */
export async function invoiceFormHint(caller: MobileCaller, rodzaj: string | null = null): Promise<NextResponse> {
  const kind = RODZAJ_NUMERACJI[rodzaj ?? 'vat'];
  if (!kind) return mobileError(400, 'invalid_request', 'Nieznany rodzaj faktury w podpowiedzi. Zaktualizuj aplikację FaktWay.', caller.headers);
  const db = dbOf(caller);
  const tenantId = tenantOf(caller);
  const dzis = todayInWarsaw();
  const [numbering, zwolnienie] = await Promise.all([
    loadInvoiceNumbering(db, tenantId, kind, dzis),
    readTenantVatExemption(db, tenantId),
  ]);
  const option = selectedNumberingOption(numbering);
  const body: PodpowiedzFakturyOdpowiedz = {
    numer: option?.preview ?? null,
    seria: option?.id && option.preview ? option.id : null,
    dzis,
    zwolnienieVat: zwolnienie !== null,
    // Te same odmowy co „Wystaw i wyślij” (`saveAndSendFinal`, `saveAndSendCorrection`), znane przed zapisem.
    wysylkaWstrzymana:
      kind === 'final' ? ROZ_SUBMISSION_HOLD_MESSAGE
      : kind === 'correction' && configuredKsefEnvironment() === 'production' ? CORRECTION_PROD_SEND_HOLD_MESSAGE
      : null,
  };
  return mobileJson(body, 200, caller.headers);
}
