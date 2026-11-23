'use client';

import { useState, useTransition, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { createProductAction, updateProductAction } from '@/app/actions/produkty';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  GTU_CODES,
  PRODUCT_LIMITS,
  PRODUCT_VAT_RATES,
  PRODUCT_VAT_RATE_LABELS,
  productFormSchema,
  type ProductFormInput,
  type ProductListItem,
} from '@/lib/produkty/model';

/** Radix Select nie przyjmuje pustej wartości, więc „brak GTU” ma znacznik. */
const NO_GTU = '__brak';

interface FormState {
  name: string;
  unit: string;
  priceNet: string;
  priceGross: string;
  vatRate: ProductFormInput['vatRate'];
  pkwiu: string;
  gtu: string;
  description: string;
}

function initial(product?: ProductListItem): FormState {
  return {
    name: product?.name ?? '',
    unit: product?.unit ?? 'szt.',
    priceNet: product?.defaultPriceNet === null || product?.defaultPriceNet === undefined ? '' : String(product.defaultPriceNet).replace('.', ','),
    priceGross:
      product?.defaultPriceGross === null || product?.defaultPriceGross === undefined ? '' : String(product.defaultPriceGross).replace('.', ','),
    vatRate: (product?.defaultVatRate as ProductFormInput['vatRate']) ?? '23',
    pkwiu: product?.pkwiuCode ?? '',
    gtu: product?.gtuCode ?? '',
    description: product?.description ?? '',
  };
}

/** Przy wyłączonym wyłączniku cen brutto okno nie wysyła pola: zapisana cena brutto zostaje. */
function toInput(form: FormState, grossPrices: boolean): ProductFormInput {
  if (grossPrices) return form;
  const { priceGross: _ukryte, ...rest } = form;
  void _ukryte;
  return rest;
}

/**
 * Dodanie i edycja produktu (krok 2.6). Walidacja tym samym schematem co akcja
 * serwera; błąd z serwera (np. dubel nazwy i jednostki) pokazany przy formularzu.
 * Pole ceny brutto (plan cen brutto, PR (d)) tylko przy `grossPrices` (włączony
 * wyłącznik `grossPricesEnabled`, odczyt na stronie).
 */
export function ProductFormDialog({
  product,
  trigger,
  grossPrices = false,
}: {
  product?: ProductListItem;
  trigger: ReactElement;
  grossPrices?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(() => initial(product));
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setForm(initial(product));
      setError(null);
    }
  }

  function submit() {
    const input = toInput(form, grossPrices);
    const parsed = productFormSchema.safeParse(input);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Sprawdź dane produktu.');
      return;
    }
    setError(null);
    startSaving(async () => {
      const result = product ? await updateProductAction(product.id, input) : await createProductAction(input);
      if (!result.success) {
        setError(result.error);
        return;
      }
      toast.success(product ? 'Zapisano zmiany produktu.' : 'Dodano produkt do katalogu.');
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Base UI: przycisk dostarcza `render`, bez zagnieżdżania przycisku w przycisku. */}
      <DialogTrigger render={trigger} />
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>{product ? 'Edytuj produkt lub usługę' : 'Nowy produkt lub usługa'}</DialogTitle>
          <DialogDescription>
            Wpis w katalogu podpowiada się przy wystawianiu faktury. Zmiana ceny nie zmienia wystawionych faktur.
            {grossPrices
              ? ' Faktura w cenach netto bierze cenę netto, a faktura w cenach brutto cenę brutto. Jednej ceny nie wyliczamy z drugiej.'
              : null}
          </DialogDescription>
        </DialogHeader>

        <div className='grid gap-3'>
          <div className='grid gap-1.5'>
            <Label htmlFor='product-name'>Nazwa</Label>
            <Input id='product-name' value={form.name} maxLength={PRODUCT_LIMITS.name} onChange={(e) => set('name', e.target.value)} />
          </div>
          <div className='grid grid-cols-2 gap-3'>
            <div className='grid gap-1.5'>
              <Label htmlFor='product-unit'>Jednostka</Label>
              <Input id='product-unit' value={form.unit} maxLength={PRODUCT_LIMITS.unit} onChange={(e) => set('unit', e.target.value)} />
            </div>
            <div className='grid gap-1.5'>
              <Label htmlFor='product-price'>Cena netto (zł)</Label>
              <Input id='product-price' inputMode='decimal' placeholder='np. 1250,00' value={form.priceNet} onChange={(e) => set('priceNet', e.target.value)} />
            </div>
            {grossPrices ? (
              <div className='col-start-2 grid gap-1.5'>
                <Label htmlFor='product-price-gross'>Cena brutto (zł)</Label>
                <Input
                  id='product-price-gross'
                  inputMode='decimal'
                  placeholder='np. 1537,50'
                  value={form.priceGross}
                  onChange={(e) => set('priceGross', e.target.value)}
                />
              </div>
            ) : null}
          </div>
          <div className='grid grid-cols-2 gap-3'>
            <div className='grid gap-1.5'>
              <Label htmlFor='product-vat'>Stawka VAT</Label>
              <Select value={form.vatRate} onValueChange={(v) => v && set('vatRate', v as ProductFormInput['vatRate'])}>
                <SelectTrigger id='product-vat'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRODUCT_VAT_RATES.map((rate) => (
                    <SelectItem key={rate} value={rate}>
                      {PRODUCT_VAT_RATE_LABELS[rate]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className='grid gap-1.5'>
              <Label htmlFor='product-gtu'>Kod GTU (opcjonalnie)</Label>
              <Select value={form.gtu || NO_GTU} onValueChange={(v) => set('gtu', !v || v === NO_GTU ? '' : v)}>
                <SelectTrigger id='product-gtu'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_GTU}>Brak</SelectItem>
                  {GTU_CODES.map((code) => (
                    <SelectItem key={code} value={code}>
                      {code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className='grid gap-1.5'>
            <Label htmlFor='product-pkwiu'>PKWiU (opcjonalnie)</Label>
            <Input id='product-pkwiu' placeholder='np. 62.01.11.0' value={form.pkwiu} maxLength={PRODUCT_LIMITS.pkwiu} onChange={(e) => set('pkwiu', e.target.value)} />
          </div>
          <div className='grid gap-1.5'>
            <Label htmlFor='product-description'>Opis (opcjonalnie)</Label>
            <Textarea id='product-description' rows={3} value={form.description} maxLength={PRODUCT_LIMITS.description} onChange={(e) => set('description', e.target.value)} />
          </div>
          {error ? (
            <p role='alert' className='text-destructive text-sm'>
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant='outline' onClick={() => setOpen(false)} disabled={saving}>
            Anuluj
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? <RiLoader4Line className='animate-spin' /> : null}
            Zapisz
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
