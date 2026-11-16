import 'server-only';

import type { NextResponse } from 'next/server';

import type { MobileCaller } from '@/lib/api/mobile/auth';
import type { AbonamentOdpowiedz, OdcienTelefonu } from '@/lib/api/mobile/kontrakt-wiecej';
import { MobileUpstreamError, mobileError, mobileJson } from '@/lib/api/mobile/responses';
import { subscriptionPlanName, subscriptionStatusLabel, type SubscriptionTone } from '@/lib/billing/subscription-status';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { isStripeConfigured } from '@/lib/stripe/client';
import { getActiveSubscription, isInTrial, trialDaysRemaining } from '@/lib/stripe/subscription';

/**
 * `GET /api/mobile/v1/abonament` (plan aplikacji mobilnej, M10e): stan
 * subskrypcji do odczytu, jak zakładka „Abonament” strony (`settings/billing`):
 * ta sama subskrypcja (`getActiveSubscription`, tu klientem z tokenem: RLS
 * `subscriptions_select_own_tenant`), ten sam opis stanu
 * (`subscriptionStatusLabel`), okres próbny z `isInTrial` i `trialDaysRemaining`.
 *
 * Plan D5: telefon nie sprzedaje abonamentu, więc odpowiedź nie ma cen,
 * metod płatności, identyfikatorów Stripe ani przyczyny odmowy płatności
 * (strona radzi przy niej zmianę metody płatności). Zakładkę widzi właściciel
 * i administrator, jak na stronie. Tylko odczyt.
 */

const ROLE = ['owner', 'admin'];
export const ABONAMENT_BEZ_ROLI = 'Abonament widzi właściciel i administrator firmy.';

const ODCIEN: Record<SubscriptionTone, OdcienTelefonu> = { success: 'ok', warning: 'ostrzezenie', danger: 'blad', default: 'neutralny' };

/** Dzień w Warszawie, jak `formatSettingsDate` strony (koniec okresu o 23:00 UTC to już następny dzień). */
function dzien(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : todayInWarsaw(d);
}

export async function subscriptionForMobile(caller: MobileCaller): Promise<NextResponse> {
  if (!caller.org) throw new Error('Trasa abonamentu bez firmy (org: required)');
  const { tenantId, role } = caller.org;
  if (!ROLE.includes(role)) return mobileError(403, 'forbidden', ABONAMENT_BEZ_ROLI, caller.headers);
  if (!isStripeConfigured()) return mobileJson({ platnosci: false, subskrypcja: null } satisfies AbonamentOdpowiedz, 200, caller.headers);

  let sub: Awaited<ReturnType<typeof getActiveSubscription>>;
  try {
    sub = await getActiveSubscription(tenantId, caller.db);
  } catch {
    throw new MobileUpstreamError('subscriptions.read');
  }
  if (!sub) return mobileJson({ platnosci: true, subskrypcja: null } satisfies AbonamentOdpowiedz, 200, caller.headers);

  const stan = subscriptionStatusLabel(sub.status);
  const proba = isInTrial(sub);
  const odpowiedz: AbonamentOdpowiedz = {
    platnosci: true,
    subskrypcja: {
      status: sub.status,
      statusEtykieta: stan.label,
      odcien: ODCIEN[stan.tone],
      plan: subscriptionPlanName(sub.plan),
      okresOd: dzien(sub.current_period_start),
      okresDo: dzien(sub.current_period_end),
      dniProby: trialDaysRemaining(sub),
      probaDo: proba ? dzien(sub.trial_end) : null,
      konczySiePoOkresie: Boolean(sub.cancel_at_period_end),
    },
  };
  return mobileJson(odpowiedz, 200, caller.headers);
}
