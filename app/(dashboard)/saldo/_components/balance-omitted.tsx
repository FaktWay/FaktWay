import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { formatPlMoney } from '@/lib/format/pl';
import type { BalanceOmitted } from '@/lib/saldo/model';
import { BALANCE_SCREEN } from '@/lib/saldo/ekran-teksty';
import { OMITTED_REASON_LABELS } from '@/lib/saldo/teksty';

/** Pominięte faktury z powodem (D27 K4): każda z numerem, datą, kwotą i tym, co z nią zrobić. */
export function BalanceOmittedList({ omitted }: { omitted: readonly BalanceOmitted[] }) {
  if (omitted.length === 0) return null;
  return (
    <Alert>
      <AlertTitle>
        {BALANCE_SCREEN.omittedTitle} ({omitted.length})
      </AlertTitle>
      <AlertDescription className='flex flex-col gap-2'>
        <span>{BALANCE_SCREEN.omittedIntro}</span>
        <ul className='flex flex-col gap-2'>
          {omitted.map((row) => (
            <li key={row.invoiceId} className='flex flex-col gap-0.5'>
              <span className='font-medium'>
                {row.number} · {formatIsoDatePl(row.issueDate)} · {formatPlMoney(row.gross)} {row.currency ?? 'PLN'}
              </span>
              <span>{OMITTED_REASON_LABELS[row.reason]}</span>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
