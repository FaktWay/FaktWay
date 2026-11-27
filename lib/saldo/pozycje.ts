import type { BalanceItem } from '@/lib/saldo/model';

/**
 * Kolumna „Kwota brutto” w zestawieniu (D58): przy fakturze rozliczającej
 * (ROZ) kwota pozostała do zapłaty po zaliczkach (`amountDue`, jak `P_15`),
 * inaczej brutto faktury. Dzięki temu w każdym wierszu brutto minus wpłacono
 * daje „Do zapłaty”. Ta sama zasada co w PDF (`lib/saldo/pdf.ts`).
 */
export function balanceGrossShown(item: BalanceItem): number {
  return item.kind === 'final' ? item.amountDue : item.gross;
}
