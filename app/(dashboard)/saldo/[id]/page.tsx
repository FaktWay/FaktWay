import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { formatWarsawDateTime } from '@/lib/format/warsaw-date';
import { getBalanceConfirmation, listBalanceEmails } from '@/lib/saldo/baza';
import { BALANCE_SCREEN } from '@/lib/saldo/ekran-teksty';
import { canIssueBalanceConfirmations, type BalanceConfirmation, type BalanceEmailRecord } from '@/lib/saldo/model';
import { BALANCE_TEXTS } from '@/lib/saldo/teksty';
import { potwierdzenieSaldaDostepne } from '@/lib/saldo/wylacznik';
import { getPageContext } from '@/lib/supabase/page-context';

import { BalanceActions } from '../_components/balance-actions';
import { BalanceDocument } from '../_components/balance-document';
import { BalanceOmittedList } from '../_components/balance-omitted';

export const dynamic = 'force-dynamic';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function EmailHistory({ emails }: { emails: BalanceEmailRecord[] | null }) {
  return (
    <Card className='shadow-none'>
      <CardContent className='flex flex-col gap-2 text-sm'>
        <h2 className='font-medium'>{BALANCE_SCREEN.emailsTitle}</h2>
        {emails === null ? (
          <p className='text-muted-foreground'>{BALANCE_SCREEN.emailsFailed}</p>
        ) : emails.length === 0 ? (
          <p className='text-muted-foreground'>{BALANCE_SCREEN.emailsEmpty}</p>
        ) : (
          <ul className='flex flex-col gap-1'>
            {emails.map((email) => (
              <li key={email.id}>
                {formatWarsawDateTime(email.sentAt)}: {email.recipient}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Podgląd wystawionego potwierdzenia salda (PR C): dokument jak w PDF
 * (migawka z chwili wystawienia), pominięte dokumenty, przyciski i historia
 * wysyłek. Odczyt klientem z sesji (RLS 00216); dokument innej firmy to
 * „nie znaleziono”. Pobranie PDF działa także po wstrzymaniu funkcji (D59),
 * wysyłka mailem tylko przy włączonym wyłączniku i roli z uprawnieniem.
 */
export default async function BalancePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_SHAPE.test(id)) notFound();
  const { supabase, tenantId, role } = await getPageContext();

  let doc: BalanceConfirmation | null;
  try {
    doc = await getBalanceConfirmation(supabase, tenantId, id);
  } catch (error) {
    console.error('[saldo] podgląd:', error);
    return (
      <Alert variant='destructive'>
        <AlertTitle>Nie udało się wczytać potwierdzenia salda</AlertTitle>
        <AlertDescription>{BALANCE_TEXTS.documentReadFailed}</AlertDescription>
      </Alert>
    );
  }
  if (!doc) notFound();

  const emails = await listBalanceEmails(supabase, tenantId, doc.id).catch(() => null);
  const canSend = canIssueBalanceConfirmations(role) && (await potwierdzenieSaldaDostepne());

  return (
    <div className='flex flex-col gap-6'>
      <div className='flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between'>
        <div>
          <Link href='/noty?widok=salda' className='text-muted-foreground text-sm hover:underline'>
            Wróć do listy potwierdzeń salda
          </Link>
          <h1 className='text-2xl font-semibold tracking-tight'>{doc.number}</h1>
        </div>
        <BalanceActions confirmationId={doc.id} number={doc.number} defaultEmail={doc.counterparty.email} canSend={canSend} />
      </div>

      <BalanceOmittedList omitted={doc.omitted} />
      <BalanceDocument content={doc} number={doc.number} />
      <EmailHistory emails={emails} />
    </div>
  );
}
