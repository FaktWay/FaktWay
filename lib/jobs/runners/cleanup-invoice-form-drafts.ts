// Cron job: retencja kopii roboczych formularza faktury (plan kompletnej
// aplikacji, krok 2.8, migracja 00207). Wiersz `invoice_form_drafts` może
// zawierać dane nabywcy wpisane przez osobę; po 30 dniach (`AUTOSAVE_RETENTION_DAYS`)
// znika, także gdy nikt nie wraca do formularza (przy zapisie sprząta tylko
// własne wiersze osoby, która zapisuje).
//
// Trigger: codziennie o 03:30 PL (lib/jobs/queues.ts).
//
// Ponowienie: przebieg jest idempotentny (jedno DELETE tylko wygasłych
// wierszy), więc ponowienie od zera po błędzie bazy nie dubluje skutków.
// Błąd bazy kończy przebieg błędem, żeby pg-boss ponowił, a przebieg nie
// wyglądał na udany.

import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

import { purgeExpiredInvoiceAutosaves } from '@/lib/invoices/form-autosave';
import type { JobContext } from '@/lib/jobs/registry';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Runner joba (worker pg-boss).
 * Rejestracja: lib/jobs/handlers/package-a.ts (kolejka cron.cleanup-invoice-form-drafts).
 */
export async function runCleanupInvoiceFormDrafts({ step }: JobContext) {
  const removed = await step.run('purge', () =>
    purgeExpiredInvoiceAutosaves(createAdminClient() as unknown as SupabaseClient),
  );
  Sentry.addBreadcrumb({
    category: 'db.cleanup',
    level: 'info',
    message: 'invoice form drafts retention completed',
    data: { removed },
  });
  return { removed };
}
