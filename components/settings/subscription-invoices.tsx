import { FieldDescription, FieldLabel } from '@/components/ui/field';
import type { SubscriptionInvoiceRow, SubscriptionInvoiceState, SubscriptionPaymentState } from '@/lib/billing/faktury-abonamentu';

const STATE_LABEL: Record<SubscriptionInvoiceState, string> = {
  in_ksef: 'W KSeF',
  issued: 'Wystawiona, czeka na przyjęcie przez KSeF',
  preparing: 'W przygotowaniu',
};

const PAYMENT_LABEL: Record<SubscriptionPaymentState, string | null> = {
  paid: null,
  refunded: 'Zwrócona',
  partially_refunded: 'Częściowo zwrócona',
};

/** RRRR-MM-DD jako DD.MM.RRRR. */
function plDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : 'brak daty';
}

/**
 * Faktury za abonament FaktWay (krok 8.1) w Ustawieniach → Abonament: data
 * płatności, kwota, numer faktury i stan. Sama lista, bez pobierania PDF:
 * fakturę klient dostaje w KSeF (Koszty → skrzynka odbiorcza). `rows = null`
 * to błąd odczytu (komunikat zamiast tabeli).
 */
export function SubscriptionInvoices({ rows }: { rows: SubscriptionInvoiceRow[] | null }) {
  return (
    <section aria-labelledby="faktury-abonamentu-tytul" className="flex flex-col gap-2">
      <div>
        <FieldLabel id="faktury-abonamentu-tytul">Faktury za abonament</FieldLabel>
        <FieldDescription>
          Za każdą udaną płatność wystawiamy fakturę VAT i wysyłamy ją do KSeF. Znajdziesz ją w Koszty, w skrzynce
          odbiorczej KSeF.
        </FieldDescription>
      </div>
      {rows === null ? (
        <p role="alert" className="text-destructive text-sm">
          Nie udało się wczytać listy faktur. Odśwież stronę, a jeśli to nie pomoże, napisz do pomocy FaktWay.
        </p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">Pierwsza faktura pojawi się tu po pierwszej płatności za abonament.</p>
      ) : (
        <div className="overflow-x-auto">
          {rows.some((r) => r.paymentState !== 'paid') ? (
            <p className="text-muted-foreground mb-2 text-xs">
              Faktura wystawiona za zwróconą płatność zostaje w KSeF. Pytania o jej korektę kieruj do pomocy FaktWay.
            </p>
          ) : null}
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground text-left text-xs">
                <th scope="col" className="py-1 pr-4 font-medium">
                  Data płatności
                </th>
                <th scope="col" className="py-1 pr-4 font-medium">
                  Numer faktury
                </th>
                <th scope="col" className="py-1 pr-4 text-right font-medium">
                  Kwota brutto
                </th>
                <th scope="col" className="py-1 pr-4 font-medium">
                  Płatność
                </th>
                <th scope="col" className="py-1 font-medium">
                  Faktura
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.paymentId} className="border-t">
                  <td className="py-1.5 pr-4 whitespace-nowrap">{plDay(row.paidOn)}</td>
                  <td className="py-1.5 pr-4">
                    {row.number ?? 'brak numeru'}
                    {row.ksefNumber ? <span className="text-muted-foreground block font-mono text-xs">{row.ksefNumber}</span> : null}
                  </td>
                  <td className="py-1.5 pr-4 text-right whitespace-nowrap tabular-nums">{row.amountLabel}</td>
                  <td className="py-1.5 pr-4">{PAYMENT_LABEL[row.paymentState] ?? 'Opłacona'}</td>
                  <td className="py-1.5">{STATE_LABEL[row.state]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
