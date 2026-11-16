import 'server-only';

import { revalidatePath } from 'next/cache';

import { logAudit } from '@/lib/audit/log';
import { recurringDb } from '@/lib/invoices/recurring/db';
import { restoreRunDateAfterDraftDelete } from '@/lib/invoices/recurring/issue';
import { readNumberTakenRows } from '@/lib/invoices/send-draft';
import { DUPLICATE_DECISION_TEXTS, retiredDraftView } from '@/lib/ksef/duplicate-decision';
import { ActionAuthError, type requireUserAndActiveOrg } from '@/lib/supabase/auth-context';

/**
 * Usunięcie szkicu faktury (F-001; plan aplikacji mobilnej, etap M8b: wzór
 * `lib/invoices/send-draft.ts`). Do M8b ta logika siedziała w
 * `deleteDraftInvoiceAction` (`components/invoices/draft-actions.ts`); teraz
 * akcja strony i trasa telefonu wołają tę samą funkcję. Wołający podaje sesję
 * i firmę leniwie (wewnątrz `try`), więc odmowy i komunikaty są takie jak
 * przed wydzieleniem. Szkic wycofany zwykłej faktury i zaliczki zostaje
 * (decyzje 2, 3, 9), korekta i faktura rozliczeniowa są usuwalne; szkic
 * z pozycji cyklicznej oddaje okres (plan Finora E9).
 */

export type DraftDeleteResult = { success: true } | { success: false; error: string };

interface DraftRow {
  id: string;
  ksef_status: string | null;
  direction: string | null;
  invoice_kind: string | null;
  invoice_type: string | null;
  internal_number: string | null;
  fa3_data: unknown;
}

const DELETE_FAILED = 'Nie udało się usunąć szkicu. Spróbuj ponownie.';

function authError(err: unknown): DraftDeleteResult | null {
  return err instanceof ActionAuthError ? { success: false, error: err.message } : null;
}

type SessionClient = Awaited<ReturnType<typeof requireUserAndActiveOrg>>['supabase'];

/** Kody „brak kolumny/tabeli” — przed wgraniem 00154 szkic nie ma powiązania z pozycją. */
const SCHEMA_PENDING = new Set(['42703', 'PGRST204', '42P01', 'PGRST205']);

type RecurringLinkRead =
  | { ok: true; link: { recurringInvoiceId: string; period: string } | null }
  | { ok: false };

/**
 * Powiązanie szkicu z okresem pozycji cyklicznej (00154), sesją klienta (RLS).
 * Osobny odczyt, żeby usuwanie szkiców działało też przed wgraniem 00154.
 * Błąd odczytu (inny niż brak kolumny) → `ok: false`: bez tej wiedzy
 * usunięcie zgubiłoby okres po cichu, więc odmawiamy.
 */
async function readRecurringLink(supabase: SessionClient, tenantId: string, invoiceId: string): Promise<RecurringLinkRead> {
  const { data, error } = await recurringDb(supabase)
    .from('invoices')
    .select('recurring_invoice_id, recurring_period')
    .eq('id', invoiceId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) return SCHEMA_PENDING.has(error.code ?? '') ? { ok: true, link: null } : { ok: false };
  if (!data?.recurring_invoice_id || !data.recurring_period) return { ok: true, link: null };
  return { ok: true, link: { recurringInvoiceId: data.recurring_invoice_id, period: data.recurring_period } };
}

export async function deleteDraftInvoice(
  context: () => Promise<{ supabase: SessionClient; userId: string; tenantId: string }>,
  invoiceId: string,
): Promise<DraftDeleteResult> {
  try {
    const { supabase, userId, tenantId } = await context();

    // Szkic wycofany zwykłej faktury i zaliczki zostaje (decyzje 2, 3, 9):
    // trzyma numer i ślad decyzji. Korekta i faktura rozliczeniowa — usuwalne.
    const { data: current, error: readError } = await supabase
      .from('invoices')
      .select('id, ksef_status, invoice_kind, internal_number')
      .eq('id', invoiceId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (readError) return { success: false, error: DUPLICATE_DECISION_TEXTS.HISTORY_READ_FAILED };
    const row = current as Pick<DraftRow, 'id' | 'ksef_status' | 'invoice_kind' | 'internal_number'> | null;
    if (row && row.ksef_status === 'draft') {
      const taken = await readNumberTakenRows(supabase, tenantId, invoiceId);
      if (!taken) return { success: false, error: DUPLICATE_DECISION_TEXTS.HISTORY_READ_FAILED };
      const retired = retiredDraftView({
        invoiceNumber: row.internal_number,
        invoiceKind: row.invoice_kind,
        submissions: taken,
        // Baner nie jest tu potrzebny — tylko `deletable` i `deleteRefusal`, które od blokady rodzaju nie zależą.
        kindHeld: false,
      });
      if (retired && !retired.deletable && retired.deleteRefusal) {
        return { success: false, error: retired.deleteRefusal };
      }
    }

    const recurring: RecurringLinkRead =
      row && row.ksef_status === 'draft' ? await readRecurringLink(supabase, tenantId, invoiceId) : { ok: true, link: null };
    if (!recurring.ok) return { success: false, error: DELETE_FAILED };

    // Pozycje znikają kaskadowo (invoice_line_items ON DELETE CASCADE).
    // Warunek na status w samym zapytaniu: szkic, który właśnie poszedł do
    // kolejki, nie zostanie usunięty.
    const { data: deleted, error } = await supabase
      .from('invoices')
      .delete()
      .eq('id', invoiceId)
      .eq('tenant_id', tenantId)
      .eq('ksef_status', 'draft')
      .select('id, internal_number');
    if (error) {
      // Wyzwalacz 00148 (`c_guard_ksef_retired_draft_delete`) w wyścigu z decyzją:
      // jego komunikat P0001 nazywa dokument i mówi, co zrobić.
      if (error.code === 'P0001' && error.message) return { success: false, error: error.message };
      return { success: false, error: DELETE_FAILED };
    }
    if (!deleted || deleted.length === 0) {
      return { success: false, error: 'Usunąć można tylko szkic, który nie został wysłany do KSeF.' };
    }

    await logAudit({
      action: 'invoice.draft_deleted',
      tenantId,
      userId,
      entityType: 'invoice',
      entityId: invoiceId,
      metadata: {
        internalNumber: (deleted[0] as { internal_number?: string | null }).internal_number ?? null,
        ...(recurring.link
          ? { recurringInvoiceId: recurring.link.recurringInvoiceId, recurringPeriod: recurring.link.period }
          : {}),
      },
    });

    // Okres szkicu jest już wolny (indeks), więc cofamy harmonogram — tylko
    // gdy poprzedni termin pozycji to ten okres (warunkowy UPDATE). Inaczej
    // (pozycja zmieniona, przesunięta dalej, usunięta) nic nie ruszamy.
    if (recurring.link) {
      const restore = await restoreRunDateAfterDraftDelete(supabase, tenantId, recurring.link);
      if (restore.restored) {
        await logAudit({
          action: 'recurring_invoice.run_date_restored',
          tenantId,
          userId,
          entityType: 'recurring_invoice',
          entityId: recurring.link.recurringInvoiceId,
          metadata: {
            deletedDraftId: invoiceId,
            recurringPeriod: recurring.link.period,
            fromNextRunDate: restore.fromNextRunDate,
            toNextRunDate: restore.toNextRunDate,
          },
        });
        revalidatePath('/invoices/recurring');
      } else {
        console.warn('[recurring-invoices] restore_skipped', { reason: restore.reason });
      }
    }

    revalidatePath('/invoices');
    return { success: true };
  } catch (err) {
    return authError(err) ?? { success: false, error: DELETE_FAILED };
  }
}
