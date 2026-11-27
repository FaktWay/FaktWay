'use client';

import { useEffect, useState } from 'react';
import { useWatch, type UseFormReturn } from 'react-hook-form';

import { previewInvoiceRateAction, type InvoiceRatePreview } from '@/components/invoices/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

import { labelClass } from './constants';
import { FieldErrorText, fieldErrorProps } from './field-error-text';

/** Waluty z tabeli A NBP najczęściej używane na fakturach; „PLN” to złote (bez kursu). */
export const WALUTY_FORMULARZA = ['PLN', 'EUR', 'USD', 'GBP', 'CHF', 'CZK', 'SEK', 'NOK', 'DKK', 'HUF', 'CAD', 'AUD', 'JPY'] as const;

/**
 * Waluta faktury i kurs (plan kompletnej aplikacji, krok 2.1, część 3; D56).
 * Pokazywana tylko przy włączonym wyłączniku. Kurs NBP z art. 31a ust. 1 (ostatni
 * dzień roboczy przed dniem sprzedaży, a bez niego przed wystawieniem) pokazujemy
 * jako podgląd; przy zapisie serwer pobiera go jeszcze raz i zapisuje przy
 * fakturze. Pole „Kurs” zastępuje kurs NBP, gdy obowiązek podatkowy powstał
 * innego dnia.
 */
export function CurrencyField({ form }: { form: UseFormReturn<InvoiceFormValues> }) {
  const currency = useWatch({ control: form.control, name: 'currency' }) || 'PLN';
  const issueDate = useWatch({ control: form.control, name: 'issueDate' });
  const saleDate = useWatch({ control: form.control, name: 'saleDate' });
  const manual = useWatch({ control: form.control, name: 'exchangeRateManual' });
  const errors = form.formState.errors;
  const [preview, setPreview] = useState<InvoiceRatePreview | 'loading' | null>(null);

  useEffect(() => {
    if (currency === 'PLN' || !issueDate) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setPreview('loading');
      previewInvoiceRateAction({ currency, issueDate, saleDate: saleDate || undefined })
        .then((result) => {
          if (!cancelled) setPreview(result);
        })
        .catch(() => {
          if (!cancelled) setPreview({ ok: false, error: 'Nie udało się pobrać kursu z NBP. Wpisz kurs z tabeli NBP w polu kursu.' });
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [currency, issueDate, saleDate]);

  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <div>
        <Label htmlFor="invoice-currency" className={labelClass}>
          Waluta
        </Label>
        <select
          id="invoice-currency"
          className="border-input bg-background h-9 w-full border px-2 text-sm"
          {...fieldErrorProps('invoice-currency', !!errors.currency)}
          {...form.register('currency', {
            onChange: () => {
              form.setValue('exchangeRateManual', undefined, { shouldDirty: true });
              setPreview(null);
            },
          })}
        >
          {WALUTY_FORMULARZA.map((code) => (
            <option key={code} value={code}>
              {code === 'PLN' ? 'PLN (złote)' : code}
            </option>
          ))}
        </select>
        {errors.currency?.message ? (
          <FieldErrorText fieldId="invoice-currency" iconClassName="shrink-0">{errors.currency.message}</FieldErrorText>
        ) : null}
      </div>
      {currency !== 'PLN' ? (
        <div>
          <Label htmlFor="invoice-exchange-rate" className={labelClass}>
            Kurs {currency} (zł)
          </Label>
          <Input
            id="invoice-exchange-rate"
            type="number"
            inputMode="decimal"
            step="0.000001"
            min="0"
            placeholder={preview && preview !== 'loading' && preview.ok ? String(preview.rate) : 'kurs z NBP'}
            {...fieldErrorProps('invoice-exchange-rate', !!errors.exchangeRateManual)}
            {...form.register('exchangeRateManual', {
              setValueAs: (v) => (v === '' || v === null || v === undefined ? undefined : Number(v)),
            })}
          />
          {errors.exchangeRateManual?.message ? (
            <FieldErrorText fieldId="invoice-exchange-rate" iconClassName="shrink-0">{errors.exchangeRateManual.message}</FieldErrorText>
          ) : null}
          <p aria-live="polite" className="text-muted-foreground mt-1 text-xs">
            {manual !== undefined
              ? 'Użyjemy kursu wpisanego przez Ciebie. Wyczyść pole, żeby wrócić do kursu NBP.'
              : preview === 'loading'
                ? 'Pobieramy kurs z NBP…'
                : preview && preview.ok
                  ? `Kurs NBP ${preview.rate} z tabeli ${preview.tableNo} z dnia ${preview.tableDate} (ostatni dzień roboczy przed dniem sprzedaży). Zmień go tylko wtedy, gdy obowiązek podatkowy powstał innego dnia.`
                  : preview && !preview.ok
                    ? preview.error
                    : 'Kurs pobierzemy z NBP przy zapisie.'}
          </p>
          {manual !== undefined ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto px-0 text-xs"
              onClick={() => form.setValue('exchangeRateManual', undefined, { shouldDirty: true })}
            >
              Wróć do kursu NBP
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
