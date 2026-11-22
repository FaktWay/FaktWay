import { ManualExpenseForm } from '@/components/expenses/manual-expense-form';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { isSubjectiveVatExemption, readTenantVatExemption } from '@/lib/invoices/vat-exemption';
import { getPageContext } from '@/lib/supabase/page-context';

export const dynamic = 'force-dynamic';

/**
 * Koszt wpisany ręcznie (plan kompletnej aplikacji, krok 3.8, część 1):
 * formularz dla aktywnej firmy. Zwolnienie z VAT (odczyt odporny przed 00091)
 * tylko do podpowiedzi o odliczeniu; zapis liczy to samo po stronie serwera.
 */
export default async function NewManualExpensePage() {
  const { supabase, tenantId } = await getPageContext();
  const vatExempt = isSubjectiveVatExemption(await readTenantVatExemption(supabase, tenantId));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Wpisz koszt ręcznie</h1>
        <p className="text-muted-foreground text-sm">Koszt bez zdjęcia: opłata bez faktury, składka, drobny zakup.</p>
      </div>
      <ManualExpenseForm tenantId={tenantId} today={todayInWarsaw()} vatExempt={vatExempt} />
    </div>
  );
}
