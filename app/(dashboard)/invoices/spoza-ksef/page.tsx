import Link from 'next/link';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { spozaKsefDostepne } from '@/lib/import/outside-ksef-wylacznik';
import { SPOZA_KSEF_OPIS } from '@/lib/import/outside-ksef-teksty';
import { getPageContext } from '@/lib/supabase/page-context';

import { OutsideKsefForm } from './_components/outside-ksef-form';

export const dynamic = 'force-dynamic';

/**
 * Dopisanie faktury wystawionej w 2026 r. poza KSeF do historii (krok 1.6,
 * PR C). Za wyłącznikiem `outsideKsefImportEnabled` (domyślnie wyłączony) i tylko
 * dla właściciela i administratora; bez tego klient dostaje komunikat z wyjściem,
 * nie formularz. Zapis i tak sprawdza oba warunki w akcji serwera.
 */
export default async function OutsideKsefPage() {
  const { role } = await getPageContext();
  const wolno = role === 'owner' || role === 'admin';
  const dostepne = wolno ? await spozaKsefDostepne() : false;

  if (!wolno || !dostepne) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
        <Alert>
          <AlertTitle>Dopisywanie faktur spoza KSeF jest niedostępne</AlertTitle>
          <AlertDescription>
            {wolno
              ? 'Ta funkcja nie jest jeszcze włączona na Twoim koncie. Faktury wystawione poza KSeF ujmuje się w księgach poza FaktWay.'
              : 'Faktury spoza KSeF dopisuje właściciel albo administrator firmy. Poproś go o to w zespole.'}
          </AlertDescription>
        </Alert>
        <Link href="/invoices" className={buttonVariants({ variant: 'outline' })}>
          Wróć do faktur
        </Link>
      </div>
    );
  }

  return <OutsideKsefForm opis={SPOZA_KSEF_OPIS} />;
}
