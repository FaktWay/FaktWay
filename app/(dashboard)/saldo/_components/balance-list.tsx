import Link from 'next/link';
import { FileText } from 'lucide-react';

import { EmptyState } from '@/components/ui/empty-state';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { formatPlMoney } from '@/lib/format/pl';
import type { BalanceListItem } from '@/lib/saldo/baza';
import { BALANCE_SCREEN } from '@/lib/saldo/ekran-teksty';

/** Lista wystawionych potwierdzeń salda (zakładka w „Noty”): od `lg` tabela, poniżej karty. */
export function BalanceList({ rows }: { rows: BalanceListItem[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title={BALANCE_SCREEN.listEmptyTitle}
        description={BALANCE_SCREEN.listEmptyDescription}
        primaryAction={{ type: 'link', label: 'Kontrahenci', href: '/contractors', icon: FileText }}
      />
    );
  }
  return (
    <>
      <div className='hidden lg:block'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Numer</TableHead>
              <TableHead>Kontrahent</TableHead>
              <TableHead>Stan na dzień</TableHead>
              <TableHead className='text-right'>Saldo</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} className='h-14'>
                <TableCell className='font-medium'>
                  <Link href={`/saldo/${row.id}`} className='hover:underline'>
                    {row.number}
                  </Link>
                </TableCell>
                <TableCell className='max-w-72 truncate'>{row.counterpartyName}</TableCell>
                <TableCell>{formatIsoDatePl(row.asOf)}</TableCell>
                <TableCell className='text-right tabular-nums'>{formatPlMoney(row.total)} zł</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className='divide-y lg:hidden'>
        {rows.map((row) => (
          <li key={row.id}>
            <Link href={`/saldo/${row.id}`} className='flex min-h-[44px] flex-col gap-1 px-4 py-3'>
              <span className='flex items-center justify-between gap-2'>
                <span className='font-medium'>{row.number}</span>
                <span className='font-medium tabular-nums'>{formatPlMoney(row.total)} zł</span>
              </span>
              <span className='text-muted-foreground text-sm'>Stan na dzień {formatIsoDatePl(row.asOf)}</span>
              <span className='truncate text-sm'>{row.counterpartyName}</span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
