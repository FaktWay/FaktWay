import 'server-only';

import type { NextResponse } from 'next/server';

import type { MobileCaller } from '@/lib/api/mobile/auth';
import type { DziennikOdpowiedz, ZespolOdpowiedz } from '@/lib/api/mobile/kontrakt-wiecej';
import { MobileUpstreamError, mobileError, mobileJson } from '@/lib/api/mobile/responses';
import { auditActionLabel, auditResourceLabel } from '@/lib/audit/labels';
import { formatWarsawDateTime } from '@/lib/format/warsaw-date';

/**
 * Karty Więcej bez kwot (plan aplikacji mobilnej, M10e): Dziennik zdarzeń
 * i Zespół, do odczytu, tymi samymi zapytaniami co zakładki strony
 * (`settings/audit`, `settings/team`), klientem z tokenem telefonu w jego
 * aktywnej firmie (RLS jak na stronie). Tylko odczyt: ponowienie niczego nie
 * zmienia. Zmiany w zespole zostają na faktway.pl (M10c).
 */

/** Jak zakładka strony: ostatnie 200 wpisów (RLS `audit_logs_select_own_tenant`: firma z `x-active-org`). */
const LIMIT_DZIENNIKA = 200;

/** `GET /dziennik`: wszystkie role, jak zakładka strony; kolumny jawnie, bez metadanych i przeglądarki. */
export async function auditLogForMobile(caller: MobileCaller): Promise<NextResponse> {
  if (!caller.org) throw new Error('Trasa dziennika bez firmy (org: required)');
  const { data, error } = await caller.db
    .from('audit_logs')
    .select('id, action, entity_type, entity_id, ip_address, created_at')
    .order('created_at', { ascending: false })
    .limit(LIMIT_DZIENNIKA);
  if (error) throw new MobileUpstreamError('audit_logs.read');
  const wiersze = (data ?? []) as Array<{ id: unknown; action: unknown; entity_type: string | null; entity_id: string | null; ip_address: unknown; created_at: string }>;
  const odpowiedz: DziennikOdpowiedz = {
    wpisy: wiersze.map((w) => ({
      id: String(w.id),
      kiedy: formatWarsawDateTime(w.created_at),
      akcja: auditActionLabel(String(w.action)),
      zasob: auditResourceLabel(w.entity_type, w.entity_id),
      ip: w.ip_address != null ? String(w.ip_address) : null,
    })),
  };
  return mobileJson(odpowiedz, 200, caller.headers);
}

const ZESPOL_ROLE = ['owner', 'admin'];
export const ZESPOL_BEZ_ROLI = 'Zespół widzi właściciel i administrator firmy.';

type CzlonekWiersz = { id: string; user_id: string; role: string; status: string; joined_at: string | null; users: { name: string | null } | Array<{ name: string | null }> | null };
type ProsbaWiersz = { id: string; message: string | null; created_at: string; users: { name: string | null } | Array<{ name: string | null }> | null };

function imie(users: CzlonekWiersz['users']): string {
  const u = Array.isArray(users) ? users[0] : users;
  return u?.name?.trim() || '(bez nazwy)';
}

/**
 * `GET /zespol`: właściciel albo administrator (`getPageContextWithRole(['owner','admin'])`
 * strony). Bez adresów e-mail członków: strona czyta je z `auth.users` kluczem
 * serwisowym, a trasy telefonu pytają bazę wyłącznie tokenem użytkownika.
 */
export async function teamForMobile(caller: MobileCaller): Promise<NextResponse> {
  if (!caller.org) throw new Error('Trasa zespołu bez firmy (org: required)');
  const { tenantId, role } = caller.org;
  if (!ZESPOL_ROLE.includes(role)) return mobileError(403, 'forbidden', ZESPOL_BEZ_ROLI, caller.headers);

  const [czlonkowie, zaproszenia, prosby] = await Promise.all([
    caller.db
      .from('memberships')
      .select('id, user_id, role, status, joined_at, users!inner(name)')
      .eq('organization_id', tenantId)
      .order('joined_at', { ascending: true }),
    caller.db
      .from('organization_invitations')
      .select('id, email, role, invited_at, expires_at')
      .eq('organization_id', tenantId)
      .is('accepted_at', null)
      .is('revoked_at', null)
      .order('invited_at', { ascending: false }),
    caller.db
      .from('organization_join_requests')
      .select('id, requested_by_user_id, message, created_at, users!inner(name)')
      .eq('organization_id', tenantId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false }),
  ]);
  if (czlonkowie.error) throw new MobileUpstreamError('memberships.read');
  if (zaproszenia.error) throw new MobileUpstreamError('organization_invitations.read');
  if (prosby.error) throw new MobileUpstreamError('organization_join_requests.read');

  const odpowiedz: ZespolOdpowiedz = {
    czlonkowie: ((czlonkowie.data ?? []) as unknown as CzlonekWiersz[]).map((m) => ({
      id: m.id,
      imie: imie(m.users),
      rola: m.role as ZespolOdpowiedz['czlonkowie'][number]['rola'],
      status: m.status,
      dolaczyl: m.joined_at,
      ty: m.user_id === caller.user.id,
    })),
    zaproszenia: ((zaproszenia.data ?? []) as Array<{ id: string; email: unknown; role: string; invited_at: string; expires_at: string }>).map((i) => ({
      id: i.id,
      email: String(i.email ?? ''),
      rola: i.role,
      zaproszono: i.invited_at,
      wygasa: i.expires_at,
    })),
    prosby: ((prosby.data ?? []) as unknown as ProsbaWiersz[]).map((r) => ({
      id: r.id,
      imie: imie(r.users),
      wiadomosc: r.message?.trim() || null,
      utworzono: r.created_at,
    })),
  };
  return mobileJson(odpowiedz, 200, caller.headers);
}
