'use client';

import { useEffect, useRef, useState } from 'react';
import { useWatch, type UseFormReturn } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { GTU_CODES } from '@/lib/invoices/line-codes';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

import { FieldErrorText, fieldErrorProps } from './field-error-text';
import { labelClass, vatSelectClass } from './constants';

type Props = { form: UseFormReturn<InvoiceFormValues>; index: number };

/**
 * Kody pozycji (plan kompletnej aplikacji, krok 2.6): PKWiU (część 2b-1)
 * i oznaczenie GTU (część 2b-2). Każde pole zwinięte pod swoim przyciskiem
 * („Dodaj PKWiU”, „Dodaj GTU”); pokazane po kliknięciu, gdy pozycja ma kod
 * (np. z katalogu produktów albo z kopii faktury) albo błąd w polu, i odtąd
 * zostaje. GTU to lista samych kodów, bez opisów: które oznaczenie się
 * należy, wybiera klient (D8 planu księgowości). Oznaczenie idzie do pliku
 * FA(3) i do wiersza faktury w JPK_V7M.
 */
export function LineCodesFields({ form, index }: Props) {
  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
      <PkwiuField form={form} index={index} />
      <GtuField form={form} index={index} />
    </div>
  );
}

/**
 * Pole pokazane po kliknięciu przycisku, przy kodzie albo błędzie; raz pokazane
 * zostaje, także po wyczyszczeniu kodu (stan z poprzedniego renderu). Po
 * kliknięciu kursor w polu (pole pojawia się dopiero wtedy).
 */
function useRevealedField(fieldId: string, hasValue: boolean, hasError: boolean) {
  const [shown, setShown] = useState(false);
  const focusPending = useRef(false);
  if (!shown && (hasValue || hasError)) setShown(true);

  useEffect(() => {
    if (!shown || !focusPending.current) return;
    focusPending.current = false;
    document.getElementById(fieldId)?.focus();
  }, [shown, fieldId]);

  const reveal = () => {
    focusPending.current = true;
    setShown(true);
  };
  return { shown, reveal };
}

function RevealButton({ label, ariaLabel, onClick }: { label: string; ariaLabel: string; onClick: () => void }) {
  return (
    <Button type="button" variant="link" size="sm" className="h-auto px-0 text-xs" aria-label={ariaLabel} onClick={onClick}>
      {label}
    </Button>
  );
}

function PkwiuField({ form, index }: Props) {
  const pkwiu = useWatch({ control: form.control, name: `lines.${index}.pkwiuCode` });
  const pkwiuError = form.formState.errors.lines?.[index]?.pkwiuCode?.message;
  const pkwiuId = `line-${index}-pkwiu`;
  const { shown, reveal } = useRevealedField(pkwiuId, Boolean(pkwiu?.trim()), Boolean(pkwiuError));

  if (!shown) {
    return <RevealButton label="Dodaj PKWiU" ariaLabel={`Dodaj PKWiU do pozycji ${index + 1}`} onClick={reveal} />;
  }

  return (
    <div className="w-full sm:max-w-xs">
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

function GtuField({ form, index }: Props) {
  const gtu = useWatch({ control: form.control, name: `lines.${index}.gtuCode` });
  const gtuError = form.formState.errors.lines?.[index]?.gtuCode?.message;
  const gtuId = `line-${index}-gtu`;
  const { shown, reveal } = useRevealedField(gtuId, Boolean(gtu), Boolean(gtuError));

  if (!shown) {
    return <RevealButton label="Dodaj GTU" ariaLabel={`Dodaj GTU do pozycji ${index + 1}`} onClick={reveal} />;
  }

  return (
    <div className="w-full sm:max-w-[10rem]">
      <Label htmlFor={gtuId} className={labelClass}>GTU</Label>
      <select
        id={gtuId}
        aria-label={`GTU pozycji ${index + 1}`}
        className={vatSelectClass}
        {...fieldErrorProps(gtuId, !!gtuError)}
        {...form.register(`lines.${index}.gtuCode`)}
      >
        <option value="">Brak</option>
        {GTU_CODES.map((code) => (
          <option key={code} value={code}>{code}</option>
        ))}
      </select>
      {gtuError ? (
        <FieldErrorText fieldId={gtuId} iconClassName="shrink-0">{gtuError}</FieldErrorText>
      ) : null}
    </div>
  );
}
