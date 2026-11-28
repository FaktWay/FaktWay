import 'server-only';

import { describeMissingRate } from '@/lib/flo/nbp';
import { invoiceRateReferenceDate, exchangeRateFromNbp, nbpRateForInvoice } from '@/lib/invoices/exchange-rate';
import { walutaDokumentu } from '@/lib/invoices/waluty-wylacznik-wspolne';
import type { InvoiceExchangeRate } from '@/types/invoice';

/**
 * Kurs do zwykłej faktury w walucie obcej (plan kompletnej aplikacji, krok 2.1,
 * część 3; D56, art. 31a ust. 1 i 2 ustawy o VAT). Wołają zapis szkicu i „Wystaw
 * i wyślij” (`issue-regular.ts`) i podgląd kursu w formularzu. Czysta kolejność:
 *  - złote: bez kursu (`null` w `rate`);
 *  - kurs wpisany ręcznie (`exchangeRateManual`): bierzemy go, a w tabeli i dacie
 *    zapisujemy, że wpisał go klient (nie udajemy tabeli NBP);
 *  - inaczej kurs z tabeli NBP sprzed dnia obowiązku podatkowego (`saleDate`,
 *    a bez niego `issueDate`; wcześniejszy z dni z wystawieniem, art. 31a ust. 2).
 * Błąd sieci i brak tabeli to odmowa z wyjściem (wpisz kurs z tabeli NBP), nigdy
 * kurs „w przybliżeniu” ani 1.
 */

export const KURS_WPISANY_RECZNIE = 'wpisany ręcznie';

export interface WartosciKursu {
  currency?: string;
  issueDate: string;
  saleDate?: string;
  exchangeRateManual?: number;
}

export type WynikKursu =
  | { ok: true; rate: InvoiceExchangeRate | null }
  | { ok: false; error: string };

export async function kursDoFaktury(values: WartosciKursu): Promise<WynikKursu> {
  const currency = walutaDokumentu(values);
  if (currency === 'PLN') return { ok: true, rate: null };

  const taxPointDate = values.saleDate && values.saleDate !== '' ? values.saleDate : null;
  let reference: string;
  try {
    reference = invoiceRateReferenceDate({ issueDate: values.issueDate, taxPointDate });
  } catch {
    return { ok: false, error: 'Nie ustaliliśmy dnia kursu, bo data wystawienia albo sprzedaży jest nieprawidłowa. Popraw daty i zapisz fakturę jeszcze raz.' };
  }

  if (values.exchangeRateManual !== undefined) {
    return { ok: true, rate: { rate: values.exchangeRateManual, tableNo: KURS_WPISANY_RECZNIE, tableDate: reference } };
  }

  try {
    const found = await nbpRateForInvoice(currency, { issueDate: values.issueDate, taxPointDate });
    if (!found.found) {
      return {
        ok: false,
        error: `${describeMissingRate(found.reason, currency, reference)} Faktury nie zapisaliśmy: wpisz kurs z tabeli NBP w polu kursu.`,
      };
    }
    return { ok: true, rate: exchangeRateFromNbp(found.rate) };
  } catch {
    return {
      ok: false,
      error: `Nie udało się pobrać kursu ${currency} z NBP, więc faktury nie zapisaliśmy. Spróbuj ponownie za chwilę albo wpisz kurs z tabeli NBP w polu kursu.`,
    };
  }
}
