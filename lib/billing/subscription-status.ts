import type { ActiveSubscription } from '@/lib/stripe/subscription';

/**
 * Stan subskrypcji dla klienta: zakładka „Abonament” strony
 * (`settings/billing`) i ta sama karta w aplikacji na telefon
 * (`GET /api/mobile/v1/abonament`, M10e). Bez cen (plan aplikacji, D5).
 */

export type SubscriptionTone = 'success' | 'warning' | 'danger' | 'default';

export function subscriptionStatusLabel(status: ActiveSubscription['status']): {
  label: string;
  tone: SubscriptionTone;
} {
  switch (status) {
    case 'trialing':
      return { label: 'Trial', tone: 'success' };
    case 'active':
      return { label: 'Aktywna', tone: 'success' };
    case 'past_due':
      return { label: 'Płatność opóźniona', tone: 'warning' };
    case 'unpaid':
      return { label: 'Nieopłacona', tone: 'danger' };
    case 'canceled':
      return { label: 'Anulowana', tone: 'danger' };
    case 'incomplete':
    case 'incomplete_expired':
      return { label: 'Niedokończona', tone: 'warning' };
    case 'paused':
      return { label: 'Wstrzymana', tone: 'warning' };
    default:
      return { label: status, tone: 'default' };
  }
}

/**
 * Nazwa planu bez ceny (telefon, D5). Plan roczny nie jest już sprzedawany
 * (decyzja z 1 października 2026); etykieta zostaje dla subskrypcji
 * założonych wcześniej.
 */
export function subscriptionPlanName(plan: ActiveSubscription['plan']): string {
  return plan === 'monthly' ? 'Miesięczny' : 'Roczny (plan wycofany)';
}
