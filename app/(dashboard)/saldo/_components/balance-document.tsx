import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { formatPlMoney } from '@/lib/format/pl';
import type { BalanceContent, BalanceItem, BalanceParty } from '@/lib/saldo/model';
import { balanceGrossShown } from '@/lib/saldo/pozycje';
import {
  BALANCE_REQUEST,
  BALANCE_SCOPE_NOTICE,
  BALANCE_SETTLEMENT_NOTE,
  BALANCE_TITLE,
  balanceSummarySentence,
} from '@/lib/saldo/teksty';

/**
 * Zestawienie na ekranie (PR C): te same elementy i kolumny co PDF
 * (`lib/saldo/pdf.ts`, D27): numer, data, termin, kwota brutto, wpłacono,
 * do zapłaty, bez netto i VAT. Faktura rozliczająca pokazuje kwotę po
 * zaliczkach z przypisem (D58). Podgląd przed wystawieniem nie ma numeru.
 */

function Party({ heading, party }: { heading: string; party: BalanceParty }) {
  return (
    <div className='flex flex-col gap-0.5 text-sm'>
      <span className='text-muted-foreground text-xs font-medium'>{heading}</span>
      <span className='font-semibold'>{party.name}</span>
      <span>NIP: {party.nip}</span>
      {party.addressLine1 ? <span>{party.addressLine1}</span> : null}
      {party.addressLine2 ? <span>{party.addressLine2}</span> : null}
    </div>
  );
}

function numberLabel(item: BalanceItem): string {
  return item.kind === 'final' ? `${item.number} *` : item.number;
}

function dueLabel(item: BalanceItem): string {
  return item.dueDate ? formatIsoDatePl(item.dueDate) : 'bez terminu';
}

export function BalanceItemsTable({ items }: { items: readonly BalanceItem[] }) {
  return (
    <>
      <div className='hidden lg:block'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className='w-12'>Lp</TableHead>
              <TableHead>Numer faktury</TableHead>
              <TableHead>Data wystawienia</TableHead>
              <TableHead>Termin płatności</TableHead>
              <TableHead className='text-right'>Kwota brutto</TableHead>
              <TableHead className='text-right'>Wpłacono</TableHead>
              <TableHead className='text-right'>Do zapłaty</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item, index) => (
              <TableRow key={item.invoiceId}>
                <TableCell>{index + 1}</TableCell>
                <TableCell className='font-medium'>{numberLabel(item)}</TableCell>
                <TableCell>{formatIsoDatePl(item.issueDate)}</TableCell>
                <TableCell>{dueLabel(item)}</TableCell>
                <TableCell className='text-right tabular-nums'>{formatPlMoney(balanceGrossShown(item))}</TableCell>
                <TableCell className='text-right tabular-nums'>{formatPlMoney(item.paid)}</TableCell>
                <TableCell className='text-right tabular-nums'>{formatPlMoney(item.outstanding)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className='divide-y rounded-md border lg:hidden'>
        {items.map((item, index) => (
          <li key={item.invoiceId} className='flex flex-col gap-1 px-3 py-3 text-sm'>
            <span className='flex items-center justify-between gap-2'>
              <span className='font-medium'>
                {index + 1}. {numberLabel(item)}
              </span>
              <span className='font-medium tabular-nums'>{formatPlMoney(item.outstanding)} zł</span>
            </span>
            <span className='text-muted-foreground'>
              Wystawiona {formatIsoDatePl(item.issueDate)}, termin: {dueLabel(item)}
            </span>
            <span className='text-muted-foreground'>
              Brutto {formatPlMoney(balanceGrossShown(item))}, wpłacono {formatPlMoney(item.paid)}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

export function BalanceDocument({ content, number }: { content: BalanceContent; number?: string }) {
  const hasFinal = content.items.some((item) => item.kind === 'final');
  return (
    <Card className='shadow-none'>
      <CardContent className='flex flex-col gap-6'>
        <div className='flex flex-col gap-1'>
          <h2 className='text-xl font-semibold'>{BALANCE_TITLE}</h2>
          {number ? (
            <p className='text-sm'>Nr {number}</p>
          ) : (
            <p className='text-muted-foreground text-sm'>Podgląd: numer nada się przy wystawieniu.</p>
          )}
          <p className='text-muted-foreground text-sm'>Stan na dzień: {formatIsoDatePl(content.asOf)}</p>
        </div>

        <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
          <Party heading='Wystawca' party={content.issuer} />
          <Party heading='Adresat' party={content.counterparty} />
        </div>

        <p className='text-sm'>{BALANCE_REQUEST}</p>

        <BalanceItemsTable items={content.items} />

        <div className='flex flex-col gap-1 text-sm'>
          <p className='text-right text-base font-semibold'>Saldo: {formatPlMoney(content.total)} PLN</p>
          <p>{balanceSummarySentence(content.total)}</p>
          {hasFinal ? <p className='text-muted-foreground'>* {BALANCE_SETTLEMENT_NOTE}</p> : null}
        </div>

        <Alert>
          <AlertDescription>{BALANCE_SCOPE_NOTICE}</AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}
