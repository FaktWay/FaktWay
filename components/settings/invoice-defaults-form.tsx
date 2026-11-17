'use client';

import { useState, useTransition } from 'react';
import { RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { resetInvoiceDefaultsAction, saveInvoiceDefaultsAction } from '@/app/actions/invoice-defaults';
import { PAYMENT_METHOD_ITEMS } from '@/components/invoices/invoice-form-parts/constants';
import { Button } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DEFAULT_PAYMENT_DAYS, MAX_PAYMENT_DAYS, type InvoiceDefaults } from '@/lib/invoices/invoice-defaults';

const SAVE_FAILED = 'Nie udało się zapisać ustawień. Sprawdź połączenie i spróbuj ponownie.';
const RESET_FAILED = 'Nie udało się przywrócić ustawień domyślnych. Sprawdź połączenie i spróbuj ponownie.';
const NONE = 'default';

const METHOD_ITEMS = [{ value: NONE, label: 'Domyślna (przelew)' }, ...PAYMENT_METHOD_ITEMS];

/**
 * Domyślne ustawienia nowej faktury w ustawieniach firmy (plan kompletnej
 * aplikacji, krok 2.8, 00209): forma płatności, termin w dniach i adres
 * księgowej, do której idzie kopia maila z fakturą. Nowa sekcja na końcu
 * zakładki „Firma” (D1). Zmienia właściciel i administrator (sprawdza też
 * baza); pozostali widzą ustawienia bez przycisków. Logika:
 * `lib/invoices/invoice-defaults.ts`.
 */
export function InvoiceDefaultsForm({ initial, canEdit }: { initial: InvoiceDefaults | null; canEdit: boolean }) {
  const [method, setMethod] = useState<string>(initial?.paymentMethod ?? NONE);
  const [days, setDays] = useState(initial?.paymentDays !== null && initial?.paymentDays !== undefined ? String(initial.paymentDays) : '');
  const [copy, setCopy] = useState(initial?.accountantCopyEmail ?? '');
  const [hasSaved, setHasSaved] = useState(initial !== null);
  const [pending, startTransition] = useTransition();

  const save = () => {
    startTransition(async () => {
      const trimmed = days.trim();
      const result = await saveInvoiceDefaultsAction({
        paymentMethod: method === NONE ? null : method,
        paymentDays: trimmed === '' ? null : Number(trimmed),
        accountantCopyEmail: copy.trim() === '' ? null : copy.trim(),
      }).catch(() => ({ success: false as const, error: SAVE_FAILED }));
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      setHasSaved(true);
      setCopy(result.defaults.accountantCopyEmail ?? '');
      toast.success('Ustawienia nowej faktury zapisane');
    });
  };

  const reset = () => {
    startTransition(async () => {
      const result = await resetInvoiceDefaultsAction().catch(() => ({ success: false as const, error: RESET_FAILED }));
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      setHasSaved(false);
      setMethod(NONE);
      setDays('');
      setCopy('');
      toast.success('Przywrócono ustawienia domyślne');
    });
  };

  return (
    <Field orientation="responsive">
      <FieldContent>
        <FieldLabel>Nowa faktura: ustawienia domyślne</FieldLabel>
        <FieldDescription>
          {`Forma i termin płatności, które formularz nowej faktury wpisuje na starcie (bez ustawień: przelew i ${DEFAULT_PAYMENT_DAYS} dni). Faktura z podkładu, cykliczna i z proformy zachowuje własne wartości, a w formularzu zawsze można je zmienić.`}
        </FieldDescription>
        <FieldDescription>
          Adres księgowej: po wysłaniu faktury mailem do nabywcy księgowa dostaje osobną wiadomość z tym samym PDF. Nabywca nie
          widzi jej adresu, a księgowa nie dostaje adresu nabywcy.
        </FieldDescription>
        {canEdit ? null : <FieldDescription>Zmienić to może właściciel albo administrator firmy.</FieldDescription>}
      </FieldContent>
      <div className="flex w-full flex-col gap-3 sm:w-80">
        <div className="flex flex-col gap-1">
          <label htmlFor="invoice-defaults-method" className="text-sm font-medium">
            Forma płatności
          </label>
          <Select value={method} items={METHOD_ITEMS} onValueChange={(v) => v != null && canEdit && setMethod(v)}>
            <SelectTrigger id="invoice-defaults-method" className="w-full" disabled={!canEdit}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {METHOD_ITEMS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="invoice-defaults-days" className="text-sm font-medium">
            Termin płatności (dni od wystawienia)
          </label>
          <Input
            id="invoice-defaults-days"
            inputMode="numeric"
            placeholder={String(DEFAULT_PAYMENT_DAYS)}
            value={days}
            readOnly={!canEdit}
            onChange={(e) => setDays(e.target.value)}
          />
          <p className="text-muted-foreground text-xs">{`Od 0 do ${MAX_PAYMENT_DAYS}. Puste pole: ${DEFAULT_PAYMENT_DAYS} dni.`}</p>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="invoice-defaults-copy" className="text-sm font-medium">
            Adres księgowej (kopia maila z fakturą)
          </label>
          <Input
            id="invoice-defaults-copy"
            type="email"
            autoComplete="off"
            placeholder="ksiegowa@example.pl"
            value={copy}
            readOnly={!canEdit}
            onChange={(e) => setCopy(e.target.value)}
          />
        </div>
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={save} disabled={pending} className="max-lg:min-h-[44px]">
              {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
              Zapisz ustawienia
            </Button>
            <Button type="button" variant="ghost" onClick={reset} disabled={pending || !hasSaved} className="max-lg:min-h-[44px]">
              Przywróć domyślne
            </Button>
          </div>
        ) : null}
      </div>
    </Field>
  );
}
