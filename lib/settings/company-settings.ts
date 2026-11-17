import 'server-only';

import { logAudit } from '@/lib/audit/log';
import { normalizujRachunekFirmy } from '@/lib/expenses/rachunek-firmy';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { isMissingColumnError, normalizeBusinessStart, readTenantBusinessStart } from '@/lib/invoices/business-start';
import { readTenantCashMethod } from '@/lib/invoices/cash-method';
import { normalizeExemptionBasis, readTenantVatExemption } from '@/lib/invoices/vat-exemption';
import { companyProfileSchema, type CompanyProfileInput } from '@/lib/schemas/company-profile';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Zapis danych firmy, które trafiają na faktury i do JPK: nazwa i adres,
 * rachunek, data rozpoczęcia działalności, zwolnienie z VAT, metoda kasowa.
 *
 * Wydzielone z akcji strony (`app/actions/{company-profile,company-bank-account,
 * business-start,vat-exemption,cash-method}.ts`) bez zmiany zachowania, żeby
 * telefon (`POST /api/mobile/v1/ustawienia/firma`, plan aplikacji mobilnej,
 * M10c) zapisywał tą samą logiką. Wołający sprawdza rolę (właściciel albo
 * administrator) i aktywne członkostwo; zapis idzie potem klientem serwisowym,
 * bo RLS `tenants_update_own_owner` (00037) przepuszcza tylko właściciela.
 * Komunikaty są zdaniami strony; `reason` mówi trasie telefonu, czy to błąd
 * danych (`invalid`), czy bazy (`unavailable`).
 */

export interface CompanySettingsActor {
  tenantId: string;
  userId: string;
  /** Dopisane do metadanych audytu (telefon: `{ client: 'mobile' }`). */
  auditMetadata?: Record<string, unknown>;
}

/** `field`: pole schematu strony przy złych danych firmy (`name`, `addressLine1`, `addressLine2`). */
export type CompanySettingFailure = { ok: false; reason: 'invalid' | 'unavailable'; error: string; field?: string };
export type CompanySettingResult<T> = { ok: true; value: T } | CompanySettingFailure;

const MIGRATION_PENDING = 'Ta funkcja czeka jeszcze na aktualizację bazy danych. Spróbuj ponownie później.';

function invalid(error: string, field?: string): CompanySettingFailure {
  return field ? { ok: false, reason: 'invalid', error, field } : { ok: false, reason: 'invalid', error };
}

function unavailable(error: string): CompanySettingFailure {
  return { ok: false, reason: 'unavailable', error };
}

async function auditTenantChange(actor: CompanySettingsActor, metadata: Record<string, unknown>): Promise<void> {
  await logAudit({
    action: 'tenant.updated',
    tenantId: actor.tenantId,
    userId: actor.userId,
    entityType: 'tenant',
    entityId: actor.tenantId,
    metadata: { ...metadata, ...actor.auditMetadata },
  });
}

/** Nazwa i adres siedziby (F-008). NIP bez zmian; wystawione faktury mają własną kopię danych sprzedawcy. */
export async function saveCompanyProfile(
  actor: CompanySettingsActor,
  input: CompanyProfileInput,
): Promise<CompanySettingResult<{ name: string; addressLine1: string; addressLine2: string }>> {
  const parsed = companyProfileSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = typeof issue?.path[0] === 'string' ? issue.path[0] : undefined;
    return invalid(issue?.message ?? 'Nieprawidłowe dane firmy.', field);
  }
  const { name, addressLine1, addressLine2 } = parsed.data;

  const admin = createAdminClient();
  const { data: before } = await admin.from('tenants').select('name, address_json').eq('id', actor.tenantId).maybeSingle();

  const { error } = await admin
    .from('tenants')
    .update({ name, address_json: { countryCode: 'PL', addressLine1, addressLine2 } })
    .eq('id', actor.tenantId);
  if (error) return unavailable('Nie udało się zapisać danych firmy.');

  await auditTenantChange(actor, {
    field: 'company_profile',
    before: before ? { name: before.name, address: before.address_json } : null,
    after: { name, address: { addressLine1, addressLine2 } },
  });
  return { ok: true, value: { name, addressLine1, addressLine2 } };
}

/** Rachunek firmy (`tenants.bank_account`, 00183); pusty tekst czyści. */
export async function saveCompanyBankAccount(
  actor: CompanySettingsActor,
  input: string | null,
): Promise<CompanySettingResult<string | null>> {
  let rachunek: string | null;
  try {
    rachunek = normalizujRachunekFirmy(input);
  } catch (e) {
    return invalid(e instanceof Error ? e.message : 'Nieprawidłowy numer rachunku.');
  }

  const admin = createAdminClient();
  const { data: before, error: readError } = await admin.from('tenants').select('bank_account').eq('id', actor.tenantId).maybeSingle();
  if (readError && !isMissingColumnError(readError.code)) {
    return unavailable('Nie udało się zapisać rachunku firmy. Spróbuj ponownie.');
  }

  const { error } = await admin.from('tenants').update({ bank_account: rachunek }).eq('id', actor.tenantId);
  if (error) return unavailable(isMissingColumnError(error.code) ? MIGRATION_PENDING : 'Nie udało się zapisać rachunku firmy.');

  const from = (before as { bank_account?: unknown } | null)?.bank_account;
  await auditTenantChange(actor, { field: 'bank_account', from: typeof from === 'string' ? from : null, to: rachunek });
  return { ok: true, value: rachunek };
}

/** Data rozpoczęcia działalności (albo `null`/pusty tekst: wyczyszczenie). Zmienia limit zwolnienia z VAT na Pulpicie. */
export async function saveBusinessStart(
  actor: CompanySettingsActor,
  input: string | null,
): Promise<CompanySettingResult<string | null>> {
  let startedOn: string | null;
  try {
    startedOn = normalizeBusinessStart(input, todayInWarsaw());
  } catch (e) {
    return invalid(e instanceof Error ? e.message : 'Nieprawidłowa data rozpoczęcia działalności.');
  }

  const admin = createAdminClient();
  let before: string | null;
  try {
    before = await readTenantBusinessStart(admin, actor.tenantId);
  } catch {
    return unavailable('Nie udało się zapisać daty rozpoczęcia działalności. Spróbuj ponownie.');
  }

  const { error } = await admin.from('tenants').update({ business_started_on: startedOn }).eq('id', actor.tenantId);
  if (error) {
    return unavailable(isMissingColumnError(error.code) ? MIGRATION_PENDING : 'Nie udało się zapisać daty rozpoczęcia działalności.');
  }

  await auditTenantChange(actor, { field: 'business_started_on', from: before, to: startedOn });
  return { ok: true, value: startedOn };
}

/** Zwolnienie z VAT (albo `null`/pusty tekst: czynny podatnik VAT). Zmienia treść każdej kolejnej faktury do KSeF. */
export async function saveVatExemption(
  actor: CompanySettingsActor,
  basisInput: string | null,
): Promise<CompanySettingResult<string | null>> {
  let basis: string | null;
  try {
    basis = normalizeExemptionBasis(basisInput);
  } catch (e) {
    return invalid(e instanceof Error ? e.message : 'Nieprawidłowa podstawa zwolnienia.');
  }

  const admin = createAdminClient();
  const before = await readTenantVatExemption(admin, actor.tenantId);
  const { error } = await admin.from('tenants').update({ vat_exemption_basis: basis }).eq('id', actor.tenantId);
  if (error) return unavailable(error.code === '42703' ? MIGRATION_PENDING : 'Nie udało się zapisać ustawienia VAT.');

  await auditTenantChange(actor, { field: 'vat_exemption_basis', from: before, to: basis });
  return { ok: true, value: basis };
}

/** Metoda kasowa VAT (P_16 w FA(3) każdej kolejnej faktury). */
export async function saveCashMethod(actor: CompanySettingsActor, enabled: boolean): Promise<CompanySettingResult<boolean>> {
  if (typeof enabled !== 'boolean') return invalid('Nieprawidłowe ustawienie metody kasowej.');

  const admin = createAdminClient();
  const before = await readTenantCashMethod(admin, actor.tenantId);
  const { error } = await admin.from('tenants').update({ vat_cash_method: enabled }).eq('id', actor.tenantId);
  if (error) return unavailable(error.code === '42703' ? MIGRATION_PENDING : 'Nie udało się zapisać metody rozliczania VAT.');

  await auditTenantChange(actor, { field: 'vat_cash_method', from: before, to: enabled });
  return { ok: true, value: enabled };
}
