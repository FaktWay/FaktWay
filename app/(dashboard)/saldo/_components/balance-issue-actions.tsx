'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { issueBalanceConfirmationAction } from '@/app/actions/saldo';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { BALANCE_SCREEN } from '@/lib/saldo/ekran-teksty';

/**
 * Wystawienie (D26, D27 K4): odcisk z podglądu, który klient widział, i firma,
 * dla której ekran wyrenderowano (UX-01). Przy pominiętych dokumentach jedyny
 * przycisk to świadome „Wystaw bez tych dokumentów”. Serwer i baza sprawdzają
 * wszystko jeszcze raz: inny odcisk to odmowa z prośbą o odświeżenie.
 */
export function BalanceIssueActions({
  contractorId,
  tenantId,
  fingerprint,
  hasOmitted,
}: {
  contractorId: string;
  tenantId: string;
  fingerprint: string;
  hasOmitted: boolean;
}) {
  const router = useRouter();
  const [isPending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const issue = () => {
    setError(null);
    start(async () => {
      const result = await issueBalanceConfirmationAction({ contractorId, fingerprint, withoutOmitted: hasOmitted }, tenantId);
      setOpen(false);
      if (!result.success) {
        setError(result.error);
        return;
      }
      toast.success(result.alreadyIssued ? `Potwierdzenie było już wystawione jako ${result.number}.` : `Wystawiono potwierdzenie ${result.number}.`);
      router.push(`/saldo/${result.id}`);
    });
  };

  return (
    <div className='flex flex-col gap-3'>
      {error ? (
        <Alert variant='destructive'>
          <AlertDescription className='flex flex-col gap-2'>
            <span>{error}</span>
            <Button type='button' variant='outline' size='sm' className='self-start' onClick={() => router.refresh()}>
              Odśwież podgląd
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <div className='flex flex-wrap gap-2'>
        <Button onClick={() => setOpen(true)} disabled={isPending}>
          {hasOmitted ? BALANCE_SCREEN.omittedConfirm : BALANCE_SCREEN.issue}
        </Button>
      </div>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{BALANCE_SCREEN.issueConfirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {hasOmitted ? BALANCE_SCREEN.issueConfirmBodyOmitted : BALANCE_SCREEN.issueConfirmBody}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Anuluj</AlertDialogCancel>
            <AlertDialogAction disabled={isPending} onClick={issue}>
              {isPending ? <RiLoader4Line className='animate-spin' /> : null}
              {hasOmitted ? BALANCE_SCREEN.omittedConfirm : BALANCE_SCREEN.issue}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
