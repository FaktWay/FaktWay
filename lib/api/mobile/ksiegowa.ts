import 'server-only';

import type { NextResponse } from 'next/server';

import type { MobileCaller } from '@/lib/api/mobile/auth';
import type { DostepKsiegowej, KsiegowaOdpowiedz, PaczkaKsiegowej } from '@/lib/api/mobile/kontrakt-wiecej';
import { MobileUpstreamError, mobileError, mobileJson } from '@/lib/api/mobile/responses';
import { readTenantTaxOffice } from '@/lib/exports/tax-office';
import { taxOfficeName } from '@/lib/exports/tax-offices';

/**
 * `GET /api/mobile/v1/ksiegowa` (plan aplikacji mobilnej, M10e): karta
 * „Księgowa” do odczytu, jak zakładka strony (`settings/accountant`): urząd
 * skarbowy, Co-Pilot miesięczny z ostatnimi paczkami i linki dla księgowej.
 *
 * Tylko właściciel, jak strona (`getPageContextWithRole('owner')`) i RLS
 * `accountant_access_owner_manage` (00037). Klient z tokenem telefonu w jego
 * firmie. Z `accountant_access` tylko kolumny listy strony (`toPublicAccesses`),
 * nigdy skrót tokenu. Uprawnienia biura w KSeF i wszystkie zmiany zostają na
 * faktway.pl (M10c). Tylko odczyt.
 */

export const KSIEGOWA_BEZ_ROLI = 'Dostęp dla księgowej ustawia właściciel firmy.';

/** Etykiety statusu paczki jak `RecentJobRow` strony (`co-pilot-settings-form.tsx`). */
const STATUS_PACZKI: Record<string, string> = {
  completed: 'Wysłane',
  failed: 'Błąd',
  generating: 'Generowanie',
  pending: 'Oczekuje',
  expired: 'Wygasłe',
};

/** Nazwy formatów jak `FORMAT_OPTIONS` formularza Co-Pilota strony. */
const FORMATY: Record<string, string> = {
  jpk_fa: 'JPK_FA(4)',
  kpir_excel: 'KPiR Excel',
  comarch_optima: 'Comarch Optima',
  insert_subiekt: 'Insert Subiekt',
  symfonia: 'Symfonia',
  wapro: 'Wapro Mag',
  csv_universal: 'CSV uniwersalny',
};

const KOLUMNY_USTAWIEN =
  'co_pilot_enabled, accountant_name, accountant_company, accountant_email, cc_emails, preferred_formats, send_day_of_month, include_issued_invoices, include_received_invoices, include_corrections, last_sent_at';
const KOLUMNY_DOSTEPU = 'id, accountant_name, accountant_email, access_level, expires_at, use_count, created_at, revoked_at, last_used_at';

type Ustawienia = {
  co_pilot_enabled: boolean | null;
  accountant_name: string | null;
  accountant_company: string | null;
  accountant_email: string | null;
  cc_emails: unknown;
  preferred_formats: unknown;
  send_day_of_month: number | null;
  include_issued_invoices: boolean | null;
  include_received_invoices: boolean | null;
  include_corrections: boolean | null;
  last_sent_at: string | null;
};

function tekst(w: unknown): string | null {
  return typeof w === 'string' && w.trim() ? w.trim() : null;
}

function lista(w: unknown): string[] {
  return Array.isArray(w) ? w.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

/** Stan dostępu jak plakietki listy strony: odebrany, wygasł albo aktywny. */
function stanDostepu(revokedAt: string | null, expiresAt: string | null, now: Date): DostepKsiegowej['stan'] {
  if (revokedAt) return 'odebrany';
  return expiresAt && new Date(expiresAt) < now ? 'wygasl' : 'aktywny';
}

export async function accountantForMobile(caller: MobileCaller, now: Date = new Date()): Promise<NextResponse> {
  if (!caller.org) throw new Error('Trasa księgowej bez firmy (org: required)');
  const { tenantId, role } = caller.org;
  if (role !== 'owner') return mobileError(403, 'forbidden', KSIEGOWA_BEZ_ROLI, caller.headers);

  const [ustawienia, paczki, dostepy, urzad] = await Promise.all([
    caller.db.from('accountant_settings').select(KOLUMNY_USTAWIEN).eq('tenant_id', tenantId).maybeSingle(),
    caller.db
      .from('export_jobs')
      .select('id, format, status, period_start, period_end, created_at, invoices_count, emailed_at')
      .eq('tenant_id', tenantId)
      .eq('trigger_source', 'co_pilot_monthly')
      .order('created_at', { ascending: false })
      .limit(5),
    caller.db.from('accountant_access').select(KOLUMNY_DOSTEPU).eq('tenant_id', tenantId).order('created_at', { ascending: false }),
    readTenantTaxOffice(caller.db, tenantId).catch(() => {
      throw new MobileUpstreamError('tenants.tax_office');
    }),
  ]);
  if (ustawienia.error) throw new MobileUpstreamError('accountant_settings.read');
  if (paczki.error) throw new MobileUpstreamError('export_jobs.read');
  if (dostepy.error) throw new MobileUpstreamError('accountant_access.read');

  const u = ustawienia.data as unknown as Ustawienia | null;
  const odpowiedz: KsiegowaOdpowiedz = {
    urzad: urzad ? { kod: urzad, nazwa: taxOfficeName(urzad) } : null,
    coPilot: u
      ? {
          wlaczony: Boolean(u.co_pilot_enabled),
          ksiegowa: tekst(u.accountant_name),
          biuro: tekst(u.accountant_company),
          email: tekst(u.accountant_email),
          dw: lista(u.cc_emails),
          formaty: lista(u.preferred_formats).map((f) => FORMATY[f] ?? f),
          dzienWysylki: typeof u.send_day_of_month === 'number' ? u.send_day_of_month : null,
          zakres: {
            wystawione: Boolean(u.include_issued_invoices),
            otrzymane: Boolean(u.include_received_invoices),
            korekty: Boolean(u.include_corrections),
          },
          ostatnio: u.last_sent_at,
        }
      : null,
    paczki: ((paczki.data ?? []) as Array<{ id: string; format: string; status: string; period_start: string | null; period_end: string | null; created_at: string; emailed_at: string | null }>).map(
      (p): PaczkaKsiegowej => ({
        id: p.id,
        format: FORMATY[p.format] ?? p.format,
        status: p.status,
        statusEtykieta: STATUS_PACZKI[p.status] ?? p.status,
        okresOd: p.period_start,
        okresDo: p.period_end,
        utworzono: p.created_at,
        wyslano: p.emailed_at,
      }),
    ),
    dostepy: ((dostepy.data ?? []) as Array<{ id: string; accountant_name: string | null; accountant_email: string | null; access_level: string | null; expires_at: string | null; use_count: number | null; revoked_at: string | null; last_used_at: string | null }>).map(
      (d): DostepKsiegowej => ({
        id: d.id,
        nazwa: d.accountant_name ?? '',
        email: d.accountant_email ?? '',
        poziom: d.access_level === 'download' ? 'Pobieranie' : 'Podgląd',
        stan: stanDostepu(d.revoked_at, d.expires_at, now),
        wygasa: d.expires_at,
        uzycia: Number(d.use_count ?? 0),
        ostatnio: d.last_used_at,
      }),
    ),
  };
  return mobileJson(odpowiedz, 200, caller.headers);
}
