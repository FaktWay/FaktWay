'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { RiCheckLine, RiFileEditLine, RiLoader4Line, RiRefreshLine } from '@remixicon/react';

import { decideExpenseAcceptanceAction } from '@/app/actions/expense-acceptance';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldContent, FieldError, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import {
  ACCEPTANCE_STATUS_LABELS,
  ACCEPTED_TEXT,
  EXPENSE_ACCEPTANCE_REASON_MAX,
  NEEDS_CHANGES_TEXT,
  acceptanceStatus,
  expenseAcceptanceReasonFormSchema,
  type ExpenseAcceptanceDecision,
  type ExpenseAcceptanceLoad,
  type ExpenseAcceptanceReasonFormValues,
  type ExpenseAcceptanceState,
} from '@/lib/expenses/acceptance';
import { formatWarsawDateTime } from '@/lib/format/warsaw-date';

/**
 * Akceptacja kosztu przez księgową w przeglądarce (plan kompletnej aplikacji,
 * krok 6.2, część 5a, 00214): stan („Czeka na akceptację”, „Zaakceptowany”,
 * „Do poprawy” z powodem albo „Zmieniony po…”), kto i kiedy, a dla księgowej
 * „Zaakceptuj koszt” i „Oznacz do poprawy” z powodem. Decyzja idzie z odciskiem
 * treści, którą księgowa widzi na tej stronie; po zapisie akcja odświeża stronę
 * kosztu (`revalidatePath`), więc stan przychodzi z serwera.
 */

const TITLE = 'Akceptacja księgowej';
const DESCRIPTION = 'Informacja od księgowej, czy koszt jest gotowy do ksiąg. Akceptacja nie zmienia KPiR ani VAT.';

export function ExpenseAcceptancePanel({
  expenseId,
  load,
  canDecide,
}: {
  expenseId: string;
  load: ExpenseAcceptanceLoad;
  canDecide: boolean;
}) {
  if (!load.ok) return <AcceptanceLoadError error={load.error} />;
  return <AcceptanceView expenseId={expenseId} state={load.state} decidedByLabel={load.decidedByLabel} canDecide={canDecide} />;
}

/** Błąd odczytu: komunikat z wyjściem, nigdy stan udający brak decyzji. */
function AcceptanceLoadError({ error }: { error: string }) {
  const router = useRouter();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{TITLE}</CardTitle>
      </CardHeader>
      <CardContent>
        <Alert variant="destructive">
          <AlertTitle>{error}</AlertTitle>
          <AlertDescription>
            <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => router.refresh()}>
              <RiRefreshLine />
              Spróbuj ponownie
            </Button>
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}

function AcceptanceView({
  expenseId,
  state,
  decidedByLabel,
  canDecide,
}: {
  expenseId: string;
  state: ExpenseAcceptanceState;
  decidedByLabel: string | null;
  canDecide: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [asking, setAsking] = useState(false);
  const form = useForm<ExpenseAcceptanceReasonFormValues>({
    resolver: zodResolver(expenseAcceptanceReasonFormSchema),
    defaultValues: { reason: '' },
  });
  const status = acceptanceStatus(state);

  function decide(decision: ExpenseAcceptanceDecision, reason?: string) {
    startTransition(async () => {
      const result = await decideExpenseAcceptanceAction({ expenseId, decision, reason, fingerprint: state.currentFingerprint });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(decision === 'accepted' ? ACCEPTED_TEXT : NEEDS_CHANGES_TEXT);
      setAsking(false);
      form.reset({ reason: '' });
      router.refresh();
    });
  }

  const reasonError = form.formState.errors.reason?.message;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{TITLE}</CardTitle>
        <CardDescription>{DESCRIPTION}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={status === 'accepted' ? 'default' : status === 'needs_changes' ? 'destructive' : 'secondary'}>
            {ACCEPTANCE_STATUS_LABELS[status]}
          </Badge>
          {state.decidedAt && decidedByLabel ? (
            <span className="text-muted-foreground text-sm">
              {decidedByLabel}, {formatWarsawDateTime(state.decidedAt)}
            </span>
          ) : null}
        </div>
        {state.decision === 'needs_changes' && state.reason ? (
          <p className="text-sm whitespace-pre-line">
            <span className="font-medium">Powód: </span>
            {state.reason}
          </p>
        ) : null}

        {canDecide && !asking ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={pending || status === 'accepted'} onClick={() => decide('accepted')}>
              {pending ? <RiLoader4Line className="animate-spin" /> : <RiCheckLine />}
              Zaakceptuj koszt
            </Button>
            <Button type="button" variant="outline" disabled={pending} onClick={() => setAsking(true)}>
              <RiFileEditLine />
              Oznacz do poprawy
            </Button>
          </div>
        ) : null}

        {canDecide && asking ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={form.handleSubmit((values) => decide('needs_changes', values.reason))}
            noValidate
          >
            <Field data-invalid={reasonError ? true : undefined}>
              <FieldLabel htmlFor="expense-acceptance-reason">Co trzeba poprawić</FieldLabel>
              <FieldContent>
                <Textarea
                  id="expense-acceptance-reason"
                  rows={3}
                  maxLength={EXPENSE_ACCEPTANCE_REASON_MAX}
                  aria-invalid={reasonError ? true : undefined}
                  {...form.register('reason')}
                />
                {reasonError ? <FieldError>{reasonError}</FieldError> : null}
              </FieldContent>
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={pending}>
                {pending ? <RiLoader4Line className="animate-spin" /> : <RiFileEditLine />}
                Zapisz uwagę
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  setAsking(false);
                  form.reset({ reason: '' });
                }}
              >
                Anuluj
              </Button>
            </div>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
