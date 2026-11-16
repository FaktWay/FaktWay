import 'server-only';

import type { NextResponse } from 'next/server';
import { z } from 'zod';

import { logAudit } from '@/lib/audit/log';
import type { MobileCaller } from '@/lib/api/mobile/auth';
import { MobileUpstreamError, mobileError } from '@/lib/api/mobile/responses';
import { readJsonBody } from '@/lib/api/mobile/tresc';
import { settingsForMobile } from '@/lib/api/mobile/ustawienia';
import { REMINDER_LIMITS } from '@/lib/reminders/settings-model';
import {
  saveBusinessStart,
  saveCashMethod,
  saveCompanyBankAccount,
  saveCompanyProfile,
  saveVatExemption,
  type CompanySettingResult,
  type CompanySettingsActor,
} from '@/lib/settings/company-settings';

/**
 * Zapisy kart Firma i Przypomnienia z telefonu (plan aplikacji mobilnej, M10c).
 *
 * Firma (`POST /ustawienia/firma`): ta sama logika co akcje strony
 * (`lib/settings/company-settings.ts`: schemat danych firmy, rachunek, data
 * rozpoczęcia, zwolnienie z VAT, metoda kasowa, wpis `tenant.updated` w
 * dzienniku z `client: 'mobile'`). Jak strona: tylko właściciel i administrator
 * aktywnego członkostwa (bramka `org: 'required'`), zapis klientem serwisowym
 * po sprawdzeniu roli, NIP bez zmian.
 *
 * Przypomnienia (`POST /ustawienia/przypomnienia`): cały formularz strony, te
 * same granice (`REMINDER_LIMITS`), zapis klientem z tokenem telefonu (RLS
 * `reminder_settings_tenant_isolation`, jak akcja strony), tylko właściciel
 * (zakładka strony i odczyt telefonu też tylko dla niego).
 *
 * Ponowienie: każda zmiana ustawia wartość (nie przełącza), więc powtórka
 * zapisuje to samo i dopisuje drugi wpis w dzienniku. Odpowiedź to karty po
 * zapisie, jak `GET /ustawienia`.
 */

const MAX_BODY_BYTES = 10_000;
const KONTRAKT = 'Treść żądania nie pasuje do kontraktu. Zaktualizuj aplikację FaktWay.';
const AUDYT_TELEFONU = { client: 'mobile' } as const;

const tekst = (max: number) => z.string().max(max);

const zmianaFirmySchema = z.discriminatedUnion('zmiana', [
  z.object({ zmiana: z.literal('dane'), nazwa: tekst(2000), adres1: tekst(2000), adres2: tekst(2000) }).strict(),
  z.object({ zmiana: z.literal('rachunek'), rachunek: tekst(200) }).strict(),
  z.object({ zmiana: z.literal('rozpoczecie'), data: tekst(40) }).strict(),
  z.object({ zmiana: z.literal('zwolnienie'), podstawa: tekst(1000) }).strict(),
  z.object({ zmiana: z.literal('metodaKasowa'), wlaczona: z.boolean() }).strict(),
]);

/** Pole schematu strony na pole formularza telefonu (nazwy z treści żądania). */
const POLE_DANYCH: Record<string, string> = { name: 'nazwa', addressLine1: 'adres1', addressLine2: 'adres2' };

async function body(caller: MobileCaller, request: Request) {
  return readJsonBody(request, caller.headers, { maxBytes: MAX_BODY_BYTES, tooLarge: 'Treść jest za długa.' });
}

function odmowaZapisu(caller: MobileCaller, wynik: Exclude<CompanySettingResult<unknown>, { ok: true }>, pole: string | undefined): NextResponse {
  if (wynik.reason === 'invalid') return mobileError(422, 'settings_invalid', wynik.error, caller.headers, pole);
  // Błąd bazy: zdanie strony („Nie udało się zapisać…”), telefon ponawia jak przy 503.
  return mobileError(503, 'service_unavailable', wynik.error, caller.headers);
}

/** `POST /api/mobile/v1/ustawienia/firma`. */
export async function saveCompanyFromMobile(caller: MobileCaller, request: Request): Promise<NextResponse> {
  if (!caller.org) throw new Error('Trasa zapisu firmy bez firmy (org: required)');
  if (caller.org.role !== 'owner' && caller.org.role !== 'admin') {
    return mobileError(403, 'forbidden', 'Dane firmy zmienia właściciel albo administrator firmy.', caller.headers);
  }
  const raw = await body(caller, request);
  if (!raw.ok) return raw.response;
  const parsed = zmianaFirmySchema.safeParse(raw.value);
  if (!parsed.success) return mobileError(400, 'invalid_request', KONTRAKT, caller.headers);

  const actor: CompanySettingsActor = { tenantId: caller.org.tenantId, userId: caller.user.id, auditMetadata: AUDYT_TELEFONU };
  const zm = parsed.data;
  let wynik: CompanySettingResult<unknown>;
  let pole: string | undefined;
  switch (zm.zmiana) {
    case 'dane':
      wynik = await saveCompanyProfile(actor, { name: zm.nazwa, addressLine1: zm.adres1, addressLine2: zm.adres2 });
      pole = !wynik.ok && wynik.field ? POLE_DANYCH[wynik.field] : undefined;
      break;
    case 'rachunek':
      wynik = await saveCompanyBankAccount(actor, zm.rachunek);
      pole = 'rachunek';
      break;
    case 'rozpoczecie':
      wynik = await saveBusinessStart(actor, zm.data);
      pole = 'data';
      break;
    case 'zwolnienie':
      wynik = await saveVatExemption(actor, zm.podstawa);
      pole = 'podstawa';
      break;
    case 'metodaKasowa':
      wynik = await saveCashMethod(actor, zm.wlaczona);
      pole = undefined;
      break;
  }
  if (!wynik.ok) return odmowaZapisu(caller, wynik, pole);
  return settingsForMobile(caller);
}

// ─── Przypomnienia ────────────────────────────────────────────────────

const dni = z.number().int().min(REMINDER_LIMITS.days.min).max(REMINDER_LIMITS.days.max);
const etapSchema = (etap: 1 | 2 | 3) => z.object({ etap: z.literal(etap), wlaczony: z.boolean(), dniPoTerminie: dni }).strict();

const przypomnieniaSchema = z
  .object({
    wlaczone: z.boolean(),
    etapy: z.tuple([etapSchema(1), etapSchema(2), etapSchema(3)]),
    godzina: z.number().int().min(REMINDER_LIMITS.hour.min).max(REMINDER_LIMITS.hour.max),
    tylkoDniRobocze: z.boolean(),
    najwiecej: z.number().int().min(REMINDER_LIMITS.perInvoice.min).max(REMINDER_LIMITS.perInvoice.max),
    nadawca: tekst(1000),
    odpowiedzNa: tekst(1000),
    wstrzymajPoOdpowiedzi: z.boolean(),
    wstrzymajPoCzesciowej: z.boolean(),
  })
  .strict();

/** Zdania pod polami formularza telefonu; liczby spoza granic strony to błąd danych, nie kontraktu. */
function bladPrzypomnien(issue: z.core.$ZodIssue | undefined): { pole: string; zdanie: string } | null {
  const [pierwsze, indeks, drugie] = issue?.path ?? [];
  if (pierwsze === 'etapy' && typeof indeks === 'number' && drugie === 'dniPoTerminie') {
    return { pole: `etapy.${indeks}.dniPoTerminie`, zdanie: `Liczba dni po terminie: od ${REMINDER_LIMITS.days.min} do ${REMINDER_LIMITS.days.max}.` };
  }
  if (pierwsze === 'godzina') return { pole: 'godzina', zdanie: `Godzina wysyłki: od ${REMINDER_LIMITS.hour.min} do ${REMINDER_LIMITS.hour.max}.` };
  if (pierwsze === 'najwiecej') {
    return { pole: 'najwiecej', zdanie: `Przypomnień na fakturę: od ${REMINDER_LIMITS.perInvoice.min} do ${REMINDER_LIMITS.perInvoice.max}.` };
  }
  return null;
}

const NADAWCA_MAX = 200;
const EMAIL = z.email().max(254);

/** `POST /api/mobile/v1/ustawienia/przypomnienia`. */
export async function saveRemindersFromMobile(caller: MobileCaller, request: Request): Promise<NextResponse> {
  if (!caller.org) throw new Error('Trasa zapisu przypomnień bez firmy (org: required)');
  if (caller.org.role !== 'owner') {
    return mobileError(403, 'forbidden', 'Przypomnienia o zapłacie ustawia właściciel firmy.', caller.headers);
  }
  const raw = await body(caller, request);
  if (!raw.ok) return raw.response;
  const parsed = przypomnieniaSchema.safeParse(raw.value);
  if (!parsed.success) {
    const blad = bladPrzypomnien(parsed.error.issues[0]);
    if (blad) return mobileError(422, 'settings_invalid', blad.zdanie, caller.headers, blad.pole);
    return mobileError(400, 'invalid_request', KONTRAKT, caller.headers);
  }
  const p = parsed.data;
  const nadawca = p.nadawca.trim().replace(/\s+/g, ' ');
  if (nadawca.length > NADAWCA_MAX || /[\u0000-\u001f\u007f<>]/.test(nadawca)) {
    return mobileError(422, 'settings_invalid', `Nazwa nadawcy: najwyżej ${NADAWCA_MAX} znaków, bez znaków < i >.`, caller.headers, 'nadawca');
  }
  const odpowiedzNa = p.odpowiedzNa.trim();
  if (odpowiedzNa && !EMAIL.safeParse(odpowiedzNa).success) {
    return mobileError(422, 'settings_invalid', 'Wpisz poprawny adres e-mail do odpowiedzi albo zostaw pole puste.', caller.headers, 'odpowiedzNa');
  }

  const [e1, e2, e3] = p.etapy;
  // Bez `sender_email`: pole dawnego formularza, którego telefon (jak strona) nie pokazuje; upsert go nie rusza.
  const po = {
    enabled: p.wlaczone,
    stage_1_enabled: e1.wlaczony,
    stage_1_days_after_due: e1.dniPoTerminie,
    stage_2_enabled: e2.wlaczony,
    stage_2_days_after_due: e2.dniPoTerminie,
    stage_3_enabled: e3.wlaczony,
    stage_3_days_after_due: e3.dniPoTerminie,
    sender_name: nadawca || null,
    reply_to_email: odpowiedzNa || null,
    pause_on_reply: p.wstrzymajPoOdpowiedzi,
    pause_on_partial_payment: p.wstrzymajPoCzesciowej,
    send_on_weekdays_only: p.tylkoDniRobocze,
    send_hour: p.godzina,
    max_reminders_per_invoice: p.najwiecej,
  };
  const { error } = await caller.db.from('reminder_settings').upsert({ tenant_id: caller.org.tenantId, ...po }, { onConflict: 'tenant_id' });
  if (error) throw new MobileUpstreamError('reminder_settings.upsert');

  await logAudit({
    action: 'tenant.updated',
    tenantId: caller.org.tenantId,
    userId: caller.user.id,
    entityType: 'tenant',
    entityId: caller.org.tenantId,
    metadata: { field: 'reminder_settings', after: po, ...AUDYT_TELEFONU },
  });
  return settingsForMobile(caller);
}
