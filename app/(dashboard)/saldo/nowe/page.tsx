import Link from 'next/link';
import { notFound } from 'next/navigation';

import { previewBalanceConfirmationAction } from '@/app/actions/saldo';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { BALANCE_SCREEN } from '@/lib/saldo/ekran-teksty';
import { canIssueBalanceConfirmations } from '@/lib/saldo/model';
import { potwierdzenieSaldaDostepne } from '@/lib/saldo/wylacznik';
import { getPageContext } from '@/lib/supabase/page-context';

import { BalanceDocument } from '../_components/balance-document';
import { BalanceIssueActions } from '../_components/balance-issue-actions';
import { BalanceOmittedList } from '../_components/balance-omitted';

export const dynamic = 'force-dynamic';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ekran wystawienia potwierdzenia salda (plan kompletnej aplikacji, krok 2.9,
 * część 2, PR C; D26-D28, D58): podgląd liczy akcja z PR B (baza, sprawdzenie
 * z Pulpitem), ekran pokazuje pozycje, pominięte dokumenty z powodami i saldo.
 * Za wyłącznikiem `balanceConfirmationsEnabled`: bez niego strona to 404.
 * Odmowa (kod bazy, rola, niezgodność z Pulpitem) to komunikat z wyjściem,
 * nie pusty ekran.
 */
export default async function NewBalancePage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  if (!(await potwierdzenieSaldaDostepne())) notFound();
  const sp = (await searchParams) ?? {};
  const contractorId = Array.isArray(sp.kontrahent) ? (sp.kontrahent[0] ?? '') : (sp.kontrahent ?? '');
  if (!UUID_SHAPE.test(contractorId)) notFound();
  const { tenantId, role } = await getPageContext();

  const back = (
    <Link href='/contractors' className='text-muted-foreground text-sm hover:underline'>
      Wróć do kontrahentów
    </Link>
  );

  if (!canIssueBalanceConfirmations(role)) {
    return (
      <div className='flex flex-col gap-4'>
        {back}
        <Alert>
          <AlertDescription>{BALANCE_SCREEN.noRole}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const result = await previewBalanceConfirmationAction(contractorId, tenantId);
  if (!result.success) {
    return (
      <div className='flex flex-col gap-4'>
        {back}
        <h1 className='text-2xl font-semibold tracking-tight'>{BALANCE_SCREEN.issueTitle}</h1>
        <Alert variant='destructive'>
          <AlertTitle>Nie przygotowaliśmy zestawienia</AlertTitle>
          <AlertDescription>{result.error}</AlertDescription>
        </Alert>
      </div>
    );
  }
  const { preview } = result;

  return (
    <div className='flex flex-col gap-6'>
      <div>
        {back}
        <h1 className='text-2xl font-semibold tracking-tight'>{BALANCE_SCREEN.issueTitle}</h1>
        <p className='text-muted-foreground text-sm'>{BALANCE_SCREEN.issueIntro}</p>
      </div>

      <BalanceOmittedList omitted={preview.omitted} />
      <BalanceDocument content={preview} />
      <BalanceIssueActions
        contractorId={contractorId}
        tenantId={tenantId}
        fingerprint={preview.fingerprint}
        hasOmitted={preview.omitted.length > 0}
      />
    </div>
  );
}
