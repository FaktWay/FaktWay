'use client';

import { useEffect, useRef, useState } from 'react';
import { useWatch, type UseFormReturn } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ORDER_NUMBER_MAX } from '@/lib/invoices/order-reference';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

import { FieldErrorText, fieldErrorProps } from './field-error-text';
import { labelClass } from './constants';

/**
 * Numer i data zamówienia (plan kompletnej aplikacji, krok 2.8): jeden numer
 * na fakturę, idzie do pliku FA(3) (`Fa/WarunkiTransakcji/Zamowienia`) i na
 * wydruk. Pola zwinięte pod przyciskiem „Dodaj numer zamówienia” (jak „Dodaj
 * PKWiU” przy pozycji), więc formularz bez numeru wygląda jak dotąd; pokazane
 * po kliknięciu, gdy numer albo data są wpisane (np. szkic) albo któreś pole
 * ma błąd, i odtąd zostają.
 */
export function OrderNumberField({ form }: { form: UseFormReturn<InvoiceFormValues> }) {
  const number = useWatch({ control: form.control, name: 'orderNumber' });
  const date = useWatch({ control: form.control, name: 'orderDate' });
  const numberError = form.formState.errors.orderNumber?.message;
  const dateError = form.formState.errors.orderDate?.message;

  const [shown, setShown] = useState(false);
  const focusPending = useRef(false);
  if (!shown && (Boolean(number?.trim()) || Boolean(date?.trim()) || Boolean(numberError) || Boolean(dateError))) {
    setShown(true);
  }

  useEffect(() => {
    if (!shown || !focusPending.current) return;
    focusPending.current = false;
    document.getElementById('invoice-order-number')?.focus();
  }, [shown]);

  if (!shown) {
    return (
      <div>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto px-0 text-xs"
          aria-label="Dodaj numer zamówienia"
          onClick={() => {
            focusPending.current = true;
            setShown(true);
          }}
        >
          Dodaj numer zamówienia
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div>
        <Label htmlFor="invoice-order-number" className={labelClass}>
          Numer zamówienia
        </Label>
        <Input
          id="invoice-order-number"
          autoComplete="off"
          maxLength={ORDER_NUMBER_MAX}
          {...fieldErrorProps('invoice-order-number', !!numberError)}
          {...form.register('orderNumber')}
        />
        {numberError ? (
          <FieldErrorText fieldId="invoice-order-number" iconClassName="shrink-0">{numberError}</FieldErrorText>
        ) : null}
      </div>
      <div>
        <Label htmlFor="invoice-order-date" className={labelClass}>
          Data zamówienia
        </Label>
        <Input
          id="invoice-order-date"
          type="date"
          {...fieldErrorProps('invoice-order-date', !!dateError)}
          {...form.register('orderDate')}
        />
        {dateError ? (
          <FieldErrorText fieldId="invoice-order-date" iconClassName="shrink-0">{dateError}</FieldErrorText>
        ) : null}
      </div>
    </div>
  );
}
