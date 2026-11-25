'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import {
  archiveProductAction,
  deleteProductAction,
  restoreProductAction,
  type ProductActionResult,
} from '@/app/actions/produkty';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatPlMoney } from '@/lib/format/pl';
import {
  PRODUCT_VAT_RATE_LABELS,
  type ProductListItem,
  type ProductVatRate,
} from '@/lib/produkty/model';

import { ProductFormDialog } from './product-form-dialog';

function RowActions({ product, grossPrices }: { product: ProductListItem; grossPrices: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function run(task: () => Promise<ProductActionResult>, done: string) {
    start(async () => {
      const result = await task();
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(done);
      router.refresh();
    });
  }

  return (
    <div className='flex flex-wrap justify-end gap-1'>
      <ProductFormDialog
        product={product}
        grossPrices={grossPrices}
        trigger={
          <Button variant='ghost' size='sm' disabled={pending}>
            Edytuj
          </Button>
        }
      />
      {product.isArchived ? (
        <Button variant='ghost' size='sm' disabled={pending} onClick={() => run(() => restoreProductAction(product.id), 'Przywrócono produkt.')}>
          Przywróć
        </Button>
      ) : (
        <Button variant='ghost' size='sm' disabled={pending} onClick={() => run(() => archiveProductAction(product.id), 'Zarchiwizowano produkt.')}>
          Zarchiwizuj
        </Button>
      )}
      {product.useCount === 0 ? (
        <Button
          variant='ghost'
          size='sm'
          className='text-destructive'
          disabled={pending}
          onClick={() => {
            if (window.confirm(`Usunąć produkt „${product.name}”? Tej operacji nie da się cofnąć.`)) {
              run(() => deleteProductAction(product.id), 'Usunięto produkt.');
            }
          }}
        >
          Usuń
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Lista katalogu produktów i usług (krok 2.6). Usuwanie tylko nieużytych, reszta
 * do archiwum. Kolumna ceny brutto tylko przy włączonym wyłączniku cen brutto.
 */
export function ProductsList({ rows, grossPrices = false }: { rows: ProductListItem[]; grossPrices?: boolean }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Nazwa</TableHead>
          <TableHead>Jedn.</TableHead>
          <TableHead className='text-right'>Cena netto</TableHead>
          {grossPrices ? <TableHead className='text-right'>Cena brutto</TableHead> : null}
          <TableHead>VAT</TableHead>
          <TableHead>PKWiU</TableHead>
          <TableHead>GTU</TableHead>
          <TableHead className='text-right'>Użyć</TableHead>
          <TableHead className='text-right'>Działania</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((p) => (
          <TableRow key={p.id}>
            <TableCell className='max-w-[22rem] font-medium'>
              <span className='block truncate' title={p.name}>
                {p.name}
              </span>
              {p.isArchived ? <Badge variant='secondary'>Zarchiwizowany</Badge> : null}
            </TableCell>
            <TableCell>{p.unit}</TableCell>
            <TableCell className='text-right tabular-nums'>
              {p.defaultPriceNet === null ? 'brak' : formatPlMoney(p.defaultPriceNet)}
            </TableCell>
            {grossPrices ? (
              <TableCell className='text-right tabular-nums'>
                {p.defaultPriceGross === null ? 'brak' : formatPlMoney(p.defaultPriceGross)}
              </TableCell>
            ) : null}
            <TableCell>{PRODUCT_VAT_RATE_LABELS[p.defaultVatRate as ProductVatRate] ?? p.defaultVatRate}</TableCell>
            <TableCell>{p.pkwiuCode ?? 'brak'}</TableCell>
            <TableCell>{p.gtuCode ?? 'brak'}</TableCell>
            <TableCell className='text-right tabular-nums'>{p.useCount}</TableCell>
            <TableCell>
              <RowActions product={p} grossPrices={grossPrices} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
