import Link from 'next/link';
import { RiAddLine } from '@remixicon/react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { listNotes } from '@/lib/noty/baza';
import type { NoteListItem } from '@/lib/noty/model';
import { NOTE_BOOKS_NOTICE, NOTE_NOT_INVOICE_NOTICE } from '@/lib/noty/teksty';
import { BALANCE_LIST_LIMIT, listBalanceConfirmations, type BalanceListItem } from '@/lib/saldo/baza';
import { BALANCE_SCREEN } from '@/lib/saldo/ekran-teksty';
import { potwierdzenieSaldaDostepne } from '@/lib/saldo/wylacznik';
import { getPageContext } from '@/lib/supabase/page-context';

import { BalanceList } from '../saldo/_components/balance-list';
import { NotesList } from './_components/notes-list';

export const dynamic = 'force-dynamic';

/**
 * Noty obciążeniowe i uznaniowe (plan kompletnej aplikacji, krok 2.9,
 * część 1): lista not firmy z odczytem klientem z sesji (RLS 00193). Osobna
 * pozycja menu w „Sprzedaży”, nie zakładka „Rodzaje faktur”: nota nie jest
 * fakturą. Błąd odczytu to komunikat, nie pusta lista („nie wiem” to nie
 * „brak not”).
 */
export default async function NotesPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const { supabase, tenantId } = await getPageContext();
  // Zakładka „Potwierdzenia sald” (krok 2.9, część 2, PR C): tylko przy włączonym
  // wyłączniku `balanceConfirmationsEnabled`; bez niego strona wygląda jak dotąd.
  const balanceTab = await potwierdzenieSaldaDostepne();
  const sp = (await searchParams) ?? {};
  const view = Array.isArray(sp.widok) ? sp.widok[0] : sp.widok;
  if (balanceTab && view === 'salda') return <BalanceTabPage supabase={supabase} tenantId={tenantId} />;

  let rows: NoteListItem[] = [];
  let readFailed = false;
  try {
    rows = await listNotes(supabase, tenantId);
  } catch (error) {
    console.error('[noty] lista:', error);
    readFailed = true;
  }

  return (
    <div className='ff-page-fill flex flex-col gap-6'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div>
          <h1 className='text-2xl font-semibold tracking-tight'>Noty</h1>
          <p className='text-muted-foreground text-sm'>
            Noty obciążeniowe i uznaniowe dla kontrahentów, z PDF i wysyłką mailem.
          </p>
        </div>
        <Link href='/noty/nowa' className={buttonVariants()}>
          <RiAddLine />
          Nowa nota
        </Link>
      </div>
      {balanceTab ? <NotesTabs active='noty' /> : null}

      <Alert>
        <AlertDescription className='flex flex-col gap-1'>
          <span>{NOTE_NOT_INVOICE_NOTICE}</span>
          <span>{NOTE_BOOKS_NOTICE}</span>
        </AlertDescription>
      </Alert>

      {readFailed ? (
        <Alert variant='destructive'>
          <AlertTitle>Nie udało się wczytać not</AlertTitle>
          <AlertDescription>Odśwież stronę za chwilę. Jeśli błąd wróci, napisz do pomocy FaktWay.</AlertDescription>
        </Alert>
      ) : rows.length === 0 ? (
        <NotesList rows={rows} />
      ) : (
        <Card className='flex-1 shadow-none'>
          <NotesList rows={rows} />
          {rows.length >= 200 ? (
            <p className='text-muted-foreground px-4 text-xs'>Pokazujemy 200 ostatnich not.</p>
          ) : null}
        </Card>
      )}
    </div>
  );
}

function NotesTabs({ active }: { active: 'noty' | 'salda' }) {
  return (
    <nav aria-label='Rodzaje dokumentów' className='flex gap-2'>
      <Link
        href='/noty'
        aria-current={active === 'noty' ? 'page' : undefined}
        className={buttonVariants({ variant: active === 'noty' ? 'secondary' : 'ghost', size: 'sm' })}
      >
        {BALANCE_SCREEN.notesTab}
      </Link>
      <Link
        href='/noty?widok=salda'
        aria-current={active === 'salda' ? 'page' : undefined}
        className={buttonVariants({ variant: active === 'salda' ? 'secondary' : 'ghost', size: 'sm' })}
      >
        {BALANCE_SCREEN.listTab}
      </Link>
    </nav>
  );
}

/** Lista wystawionych potwierdzeń salda; błąd odczytu to komunikat, nie pusta lista. */
async function BalanceTabPage({ supabase, tenantId }: { supabase: unknown; tenantId: string }) {
  let rows: BalanceListItem[] = [];
  let readFailed = false;
  try {
    rows = await listBalanceConfirmations(supabase, tenantId);
  } catch (error) {
    console.error('[saldo] lista:', error);
    readFailed = true;
  }
  return (
    <div className='ff-page-fill flex flex-col gap-6'>
      <div>
        <h1 className='text-2xl font-semibold tracking-tight'>Noty</h1>
        <p className='text-muted-foreground text-sm'>Wystawione potwierdzenia salda z kontrahentami, z PDF i wysyłką mailem.</p>
      </div>
      <NotesTabs active='salda' />
      {readFailed ? (
        <Alert variant='destructive'>
          <AlertTitle>{BALANCE_SCREEN.listReadFailedTitle}</AlertTitle>
          <AlertDescription>{BALANCE_SCREEN.listReadFailedBody}</AlertDescription>
        </Alert>
      ) : rows.length === 0 ? (
        <BalanceList rows={rows} />
      ) : (
        <Card className='flex-1 shadow-none'>
          <BalanceList rows={rows} />
          {rows.length >= BALANCE_LIST_LIMIT ? (
            <p className='text-muted-foreground px-4 text-xs'>Pokazujemy {BALANCE_LIST_LIMIT} ostatnich potwierdzeń.</p>
          ) : null}
        </Card>
      )}
    </div>
  );
}
