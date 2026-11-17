import { KsefPurchaseCurrencyError } from '@/lib/dashboard/costs';
import { OutgoingInvoiceCurrencyNotSupportedError } from '@/lib/exports/currency-guard';
import { KsefExpenseCurrencyNotSupportedError } from '@/lib/expenses/ksef-currency-review';
import { ZdublowanyKosztError } from '@/lib/expenses/jeden-koszt-dokumentu';

/**
 * Treść wyjątku dla klienta: Pulpit, lista faktur i kontrahenci na stronie
 * (`pulpitErrorMessage` w `components/dashboard/pulpit/pulpit-grid.tsx`) oraz
 * trasy aplikacji na telefon (M10e). Przeniesione z `pulpit-grid.tsx` bez
 * zmiany zachowania, żeby trasy API nie ciągnęły kart Pulpitu.
 */

/** Polskie komunikaty strażników §2.4 i odczytów — te klient może przeczytać. */
const CUSTOMER_MESSAGE_PREFIXES = ['Nie można ', 'Przyjęte faktury ', 'Koszty ze skrzynki KSeF '];

/**
 * Polska treść wyjątku, którą klient może przeczytać, albo `null`, gdy wyjątek
 * jest techniczny. Strażniki walut i środowiska mówią po polsku, co klient ma
 * zrobić — te pokazujemy w całości. `readCompletePages` i odczyty dopisują po
 * dwukropku tekst PostgREST-a (po angielsku, techniczny), więc z nich zostaje
 * polska część przed dwukropkiem. Wszystko inne (konfiguracja serwera, błąd
 * programu) to `null`. Używaj tam, gdzie komunikat ogólny ma własną treść
 * (alerty strony listy faktur); karta bierze `pulpitErrorMessage`.
 */
export function customerErrorDetail(error: unknown): string | null {
  if (
    error instanceof OutgoingInvoiceCurrencyNotSupportedError ||
    error instanceof KsefExpenseCurrencyNotSupportedError ||
    // E10: faktura zakupu z KSeF w walucie obcej bez wydatku — komunikat z numerem dokumentu.
    error instanceof KsefPurchaseCurrencyError ||
    // FZ-022: ten sam dokument kosztu dwa razy — komunikat z numerem dokumentu i wyjściem.
    error instanceof ZdublowanyKosztError
  ) {
    return error.message;
  }
  const message = error instanceof Error ? error.message : '';
  if (CUSTOMER_MESSAGE_PREFIXES.some((prefix) => message.startsWith(prefix))) {
    return message.split(': ')[0]!;
  }
  return null;
}
