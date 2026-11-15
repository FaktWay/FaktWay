'use server';

import { revalidatePath } from 'next/cache';

import { deleteDraftInvoice } from '@/lib/invoices/delete-draft';
import { sendRegularDraft } from '@/lib/invoices/send-draft';
import { ActionAuthError, requireUserAndActiveOrg } from '@/lib/supabase/auth-context';

/**
 * Szkic faktury — wysyłka do KSeF i usunięcie (F-001 w raporcie audytu bloku 1).
 *
 * Do 02.10.2026 szkic był ślepą uliczką: kolejkę wysyłki wołały tylko akcje
 * tworzące nowy dokument, a szkicu nie dało się ani wysłać, ani usunąć —
 * jego numer zostawał zajęty (unikat numeru w organizacji), więc klient
 * wystawiał fakturę pod nowym numerem i zostawiał dziurę w serii.
 *
 * Wysyłka obejmuje tylko zwykłe faktury VAT: korekta, zaliczka i faktura
 * końcowa potrzebują danych specjalnych, których szkic nie przechowuje —
 * takie szkice można usunąć i wystawić ponownie.
 *
 * D-A4-1b-3 PR B (decyzje Bartosza 07.10.2026: 2, 3, 9): szkic z wpisem
 * `number_taken` w historii wysyłki — po decyzji klienta przy 440 albo po
 * automatycznym „numer zajęty” i „Wróć do szkicu” — jest WYCOFANY. Nie
 * wysyła się (każdy rodzaj: KSeF odpowiedziałby znowu 440), a zwykła faktura
 * i zaliczka nie usuwają się (numer zostałby podpowiedziany ponownie, a ślad
 * decyzji zniknąłby kaskadą). Korekta i faktura rozliczeniowa zostają
 * usuwalne — to ich wyjście (00133/00135, 00125). Obie akcje czytają historię
 * sesją klienta przed kolejką i przed DELETE; te same odmowy trzymają
 * wyzwalacze 00148 w bazie (wyścig: P0001 z komunikatem dla klienta).
 *
 * Plan Finora E9 (C2/C4): szkic z pozycji cyklicznej (zostaje, gdy kolejka
 * KSeF odmówi po „Wystaw i wyślij”) zajmuje okres, a `next_run_date` jest już
 * przesunięta. Po jego usunięciu cofamy datę o jeden okres —
 * `restoreRunDateAfterDraftDelete`, warunkowo — żeby okres wrócił do „Do
 * wystawienia”, zamiast zniknąć z harmonogramu.
 */

export type DraftActionResult =
  | { success: true; offline?: boolean }
  | { success: false; error: string };

function authError(err: unknown): DraftActionResult | null {
  return err instanceof ActionAuthError ? { success: false, error: err.message } : null;
}

export async function sendDraftInvoiceAction(invoiceId: string): Promise<DraftActionResult> {
  try {
    const { supabase, user, tenantId } = await requireUserAndActiveOrg();
    // Logika wysyłki szkicu: `sendRegularDraft` (lib/invoices/send-draft.ts), ta sama dla telefonu (M8).
    const sent = await sendRegularDraft({ supabase, userId: user.id, tenantId }, invoiceId);
    if (!sent.success) return { success: false, error: sent.error };

    revalidatePath('/invoices');
    revalidatePath(`/invoices/${invoiceId}`);
    return { success: true, offline: sent.offline };
  } catch (err) {
    return authError(err) ?? { success: false, error: 'Nie udało się wysłać szkicu. Spróbuj ponownie.' };
  }
}

/** Usunięcie szkicu: logika od M8b w `lib/invoices/delete-draft.ts` (ta sama dla telefonu). */
export async function deleteDraftInvoiceAction(invoiceId: string): Promise<DraftActionResult> {
  return deleteDraftInvoice(async () => {
    const { supabase, user, tenantId } = await requireUserAndActiveOrg();
    return { supabase, userId: user.id, tenantId };
  }, invoiceId);
}
