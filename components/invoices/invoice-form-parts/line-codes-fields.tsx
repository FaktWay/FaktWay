'use client';

import { useEffect, useRef, useState } from 'react';
import { useWatch, type UseFormReturn } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

import { FieldErrorText, fieldErrorProps } from './field-error-text';
import { labelClass } from './constants';

/**
 * PKWiU pozycji (plan kompletnej aplikacji, krok 2.6, część 2b-1).
 * Zwinięte pod przyciskiem „Dodaj PKWiU”; pokazane po kliknięciu, gdy pozycja
 * ma kod (np. z katalogu produktów) albo błąd w polu kodu, i odtąd zostaje.
 *
 * Oznaczenie GTU dojdzie tutaj razem z GTU w JPK_V7M (część 2b-2), żeby
 * oznaczenie nie trafiało na fakturę bez ewidencji w pliku JPK.
 */
export function LineCodesFields({ form, index }: { form: UseFormReturn<InvoiceFormValues>; index: number }) {
  const pkwiu = useWatch({ control: form.control, name: `lines.${index}.pkwiuCode` });
  const pkwiuError = form.formState.errors.lines?.[index]?.pkwiuCode?.message;
  const [shown, setShown] = useState(false);
  const focusPending = useRef(false);
  const pkwiuId = `line-${index}-pkwiu`;

  // Kod (z katalogu, z kopii faktury) albo błąd pokazuje pole; raz pokazane
  // zostaje, także po wyczyszczeniu kodu (stan z poprzedniego renderu).
  if (!shown && (Boolean(pkwiu?.trim()) || Boolean(pkwiuError))) setShown(true);

  // Po „Dodaj PKWiU” kursor w polu PKWiU (pole pojawia się dopiero po kliknięciu).
  useEffect(() => {
    if (!shown || !focusPending.current) return;
    focusPending.current = false;
    document.getElementById(pkwiuId)?.focus();
  }, [shown, pkwiuId]);

  if (!shown) {
    return (
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto px-0 text-xs"
        aria-label={`Dodaj PKWiU do pozycji ${index + 1}`}
        onClick={() => {
          focusPending.current = true;
          setShown(true);
        }}
      >
        Dodaj PKWiU
      </Button>
    );
  }

  return (
    <div className="sm:max-w-xs">
      <Label htmlFor={pkwiuId} className={labelClass}>PKWiU</Label>
      <Input
        id={pkwiuId}
        aria-label={`PKWiU pozycji ${index + 1}`}
        placeholder="np. 62.01.11.0"
        autoComplete="off"
        {...fieldErrorProps(pkwiuId, !!pkwiuError)}
        {...form.register(`lines.${index}.pkwiuCode`)}
      />
      {pkwiuError ? (
        <FieldErrorText fieldId={pkwiuId} iconClassName="shrink-0">{pkwiuError}</FieldErrorText>
      ) : null}
    </div>
  );
}
