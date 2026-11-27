'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RiDownload2Line, RiLoader4Line, RiSendPlaneLine } from '@remixicon/react';
import { toast } from 'sonner';

import { sendBalanceConfirmationEmailAction } from '@/app/actions/saldo';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { BALANCE_SCREEN } from '@/lib/saldo/ekran-teksty';

/**
 * Przyciski wystawionego dokumentu: PDF zawsze (D59: pobranie działa także
 * po wstrzymaniu), wysyłka mailem tylko gdy dostępna (wyłącznik i rola);
 * serwer sprawdza to jeszcze raz.
 */
export function BalanceActions({
  confirmationId,
  number,
  defaultEmail,
  canSend,
}: {
  confirmationId: string;
  number: string;
  defaultEmail: string | null;
  canSend: boolean;
}) {
  const router = useRouter();
  const [isPending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(defaultEmail ?? '');
  const [error, setError] = useState<string | null>(null);
  const formId = `balance-email-${confirmationId}`;

  const send = () => {
    setError(null);
    start(async () => {
      const result = await sendBalanceConfirmationEmailAction(confirmationId, to);
      if (!result.success) {
        setError(result.error);
        return;
      }
      toast.success(`Wysłano potwierdzenie salda na adres ${result.recipient}.`);
      setOpen(false);
      router.refresh();
    });
  };

  return (
    <div className='flex flex-wrap gap-2'>
      {canSend ? (
        <Button
          onClick={() => {
            setTo(defaultEmail ?? '');
            setError(null);
            setOpen(true);
          }}
        >
          <RiSendPlaneLine />
          Wyślij e-mailem
        </Button>
      ) : null}
      <a href={`/api/saldo/${confirmationId}/pdf`} className={buttonVariants({ variant: canSend ? 'outline' : 'default' })} download>
        <RiDownload2Line />
        Pobierz PDF
      </a>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className='sm:max-w-md'>
          <SheetHeader>
            <SheetTitle>Wyślij potwierdzenie {number} e-mailem</SheetTitle>
          </SheetHeader>
          <form
            id={formId}
            className='flex flex-1 flex-col overflow-y-auto px-4'
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <FieldGroup>
              {error ? (
                <Alert variant='destructive'>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
              <Field>
                <FieldLabel htmlFor={`${formId}-to`}>Do</FieldLabel>
                <FieldContent>
                  <Input
                    id={`${formId}-to`}
                    type='email'
                    autoComplete='email'
                    placeholder='e-mail kontrahenta'
                    value={to}
                    onChange={(event) => setTo(event.target.value)}
                  />
                  <FieldDescription>{BALANCE_SCREEN.sendDescription}</FieldDescription>
                </FieldContent>
              </Field>
            </FieldGroup>
          </form>
          <SheetFooter className='flex-row'>
            <Button type='submit' form={formId} disabled={isPending || to.trim() === ''}>
              {isPending ? <RiLoader4Line className='animate-spin' /> : null}
              Wyślij
            </Button>
            <Button type='button' variant='outline' onClick={() => setOpen(false)} disabled={isPending}>
              Anuluj
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
