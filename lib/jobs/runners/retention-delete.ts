

import * as Sentry from '@sentry/nextjs';

import type { JobContext } from '@/lib/jobs/registry';
import { createAdminClient } from '@/lib/supabase/server';
import { logAuditSystem } from '@/lib/audit/log-system';
import { readAllByIdInList } from '@/lib/pagination/in-list';
import {
  collectInvoiceStorageKeys,
  deleteInvoiceStorage,
  type RetainedInvoice,
} from '@/lib/retention/invoice-files';
import { blokadaKsef, planUsuniecia, type KorektaTrzymajaca, type PowodOdroczenia } from '@/lib/retention/plan-usuniecia';
import { StorageTimeoutError } from '@/lib/storage/s3-timeouts';

/**
 * Cron codziennie o 4:00 PL: usuwa faktury, których `scheduled_deletion_at`
 * już minął. Termin zapisuje archiwizacja: północ po dniu „archiwizacja plus
 * 8 lat”, czyli co najmniej 10 lat od wystawienia (`lib/retention/terminy.ts`).
 *
 * HARD DELETE — `invoice_line_items`, `ksef_submissions`, `xml_documents`
 * kasują się kaskadowo (FK ON DELETE CASCADE w schemacie). Najpierw pliki
 * w R2 i Glacier (`lib/retention/invoice-files.ts`), potem wiersz: odwrotna
 * kolejność zostawiała pliki bez śladu w bazie (AUD-45). Faktura, której
 * plików nie udało się usunąć, czeka do następnego przebiegu.
 *
 * FZ-005: korekta, koszt z KSeF, import płatności i strażnik cyklu KSeF
 * trzymają wiersz faktury w bazie (lista w `lib/retention/plan-usuniecia.ts`).
 * Plan rozstrzyga przed usunięciem plików: trzymana faktura zostaje z plikami
 * i dostaje nowy termin, reszta idzie po kolei (korekta przed oryginałem),
 * każda faktura osobnym DELETE, a wpis `retention.deletion_executed` dopiero
 * po usunięciu wiersza.
 *
 * LIM-05, wyłącznik: pierwszy limit czasu magazynu plików
 * (`StorageTimeoutError`, `lib/storage/s3-timeouts.ts`) kończy usuwanie
 * plików w tym przebiegu. Pozostałe faktury nie dotykają ani magazynu, ani
 * bazy i czekają jak po błędzie pliku: wiersz zostaje, następny przebieg
 * ponowi. Bez wyłącznika zawieszony magazyn trzymał workera na każdej
 * fakturze osobno (do 3 prób po 60 s na wywołanie; przy 100 fakturach ponad
 * dwie godziny). Przebieg kończy się sukcesem z `pending`
 * i `storageTimeoutSkipped`, nie błędem: ponowienie handlera po 10 s
 * trafiłoby w ten sam zawieszony magazyn, a cron i tak wraca następnego dnia
 * o 4:00. Operator dostaje jeden wpis w logu workera i jedno zgłoszenie
 * w Sentry (`docs/runbooks/joby-pg-boss.md`, „Typowe sytuacje”).
 */
/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-a.ts (kolejka cron.retention-delete).
 */
/** Powód odroczenia w `audit_logs` (`retention.deletion_postponed`). */
const POWODY: Readonly<Record<PowodOdroczenia, string>> = {
  korekta: 'correction still retained',
  koszt: 'linked expense',
  platnosc: 'matched bank import',
  ksef: 'KSeF lifecycle guard (00132)',
};

/**
 * Limit czasu magazynu plików albo `null`. Rozpoznany po typie albo po `name`
 * i `code`, nigdy po treści: błąd z innej instancji modułu nie przejdzie
 * `instanceof`. Zerwane połączenie (biblioteka też nazywa je 'TimeoutError',
 * ale z `code` ECONNRESET albo EPIPE) i limit Supabase (`code` ABORT_ERR) to
 * nie zawieszony magazyn, więc zostają błędem jednej faktury.
 */
function limitMagazynu(e: unknown): { operation: string; attempts: number } | null {
  if (!(e instanceof StorageTimeoutError)) {
    const { name, code } = (typeof e === 'object' && e !== null ? e : {}) as { name?: unknown; code?: unknown };
    if (name !== 'TimeoutError' || code !== 'ETIMEDOUT') return null;
  }
  const { operation, attempts } = e as { operation?: unknown; attempts?: unknown };
  return {
    operation: typeof operation === 'string' ? operation : 'S3',
    attempts: typeof attempts === 'number' ? attempts : 1,
  };
}

export async function runRetentionDelete({ step, logger }: JobContext) {
    const teraz = new Date();
    const nowIso = teraz.toISOString();

    const candidates = await step.run('find-candidates', async () => {
      const supabase = createAdminClient();
      const { data, error } = await supabase
        .from('invoices')
        .select('id, tenant_id, internal_number, issue_date, xml_storage_path, pdf_storage_path, archive_storage_path, ksef_status, submitted_to_ksef_at, offline_idempotency_key')
        .not('scheduled_deletion_at', 'is', null)
        .lt('scheduled_deletion_at', nowIso)
        .limit(100);

      if (error) throw new Error(`Find candidates failed: ${error.message}`);
      return data ?? [];
    });

    if (candidates.length === 0) return { deleted: 0 };

    // Przed usunięciem plików: co trzyma kandydatki kluczem bez kaskady.
    const plan = await step.run('plan', async () => {
      const supabase = createAdminClient();
      const ids = candidates.map((c) => c.id as string);
      const korekty = await readAllByIdInList<KorektaTrzymajaca>('Retencja: korekty kandydatek', ids, (values, afterId, limit) => {
        let query = supabase.from('invoices').select('id, parent_invoice_id, scheduled_deletion_at').in('parent_invoice_id', values);
        if (afterId) query = query.gt('id', afterId);
        return query.order('id', { ascending: true }).limit(limit);
      });
      const koszty = await readAllByIdInList<{ id: string; ksef_invoice_id: string }>('Retencja: koszty kandydatek', ids, (values, afterId, limit) => {
        let query = supabase.from('expenses').select('id, ksef_invoice_id').in('ksef_invoice_id', values);
        if (afterId) query = query.gt('id', afterId);
        return query.order('id', { ascending: true }).limit(limit);
      });
      // Płatności faktury znikają z nią kaskadą, ale import z banku trzyma płatność kluczem bez `ON DELETE`.
      const platnosci = await readAllByIdInList<{ id: string; invoice_id: string }>('Retencja: płatności kandydatek', ids, (values, afterId, limit) => {
        let query = supabase.from('payments').select('id, invoice_id').in('invoice_id', values);
        if (afterId) query = query.gt('id', afterId);
        return query.order('id', { ascending: true }).limit(limit);
      });
      const fakturaPlatnosci = new Map(platnosci.map((p) => [p.id, p.invoice_id]));
      const importy = await readAllByIdInList<{ id: string; matched_payment_id: string }>('Retencja: importy płatności', [...fakturaPlatnosci.keys()], (values, afterId, limit) => {
        let query = supabase.from('payment_imports').select('id, matched_payment_id').in('matched_payment_id', values);
        if (afterId) query = query.gt('id', afterId);
        return query.order('id', { ascending: true }).limit(limit);
      });
      const blokady: Array<{ id: string; powod: Exclude<PowodOdroczenia, 'korekta'> }> = [
        ...candidates.filter((c) => blokadaKsef(c)).map((c) => ({ id: c.id as string, powod: 'ksef' as const })),
        ...koszty.map((k) => ({ id: k.ksef_invoice_id, powod: 'koszt' as const })),
        ...importy.map((i) => ({ id: fakturaPlatnosci.get(i.matched_payment_id)!, powod: 'platnosc' as const })),
      ];
      return planUsuniecia({ kandydaci: ids, korekty, blokady, teraz });
    });

    const poId = new Map(candidates.map((c) => [c.id as string, c]));

    for (const o of plan.odroczone) {
      await step.run(`postpone-${o.id}`, async () => {
        const invoice = poId.get(o.id)!;
        const { error } = await createAdminClient().from('invoices').update({ scheduled_deletion_at: o.termin }).eq('id', o.id);
        if (error) throw new Error(`Postpone deletion failed for ${o.id}: ${error.message}`);
        await logAuditSystem({
          action: 'retention.deletion_postponed',
          tenantId: invoice.tenant_id,
          entityType: 'invoice',
          entityId: o.id,
          metadata: { internalNumber: invoice.internal_number, reason: POWODY[o.powod], until: o.termin },
        });
      });
    }
    if (plan.odroczone.length > 0) logger.warn(`Retencja: ${plan.odroczone.length} faktur czeka (korekta, koszt, import płatności albo strażnik KSeF)`);

    logger.info(`Usuwam ${plan.kolejnosc.length} faktur (retencja)`);

    let deleted = 0;
    let bledyWierszy = 0;
    // Wyłącznik (LIM-05): faktura, przy której magazyn nie odpowiedział
    // w limicie czasu. Po niej reszta przebiegu nie dotyka magazynu ani bazy.
    let wylacznik: { invoiceId: string; operation: string; attempts: number } | null = null;
    let skipped = 0;
    for (const id of plan.kolejnosc) {
      if (wylacznik) {
        skipped++;
        continue;
      }
      const invoice = poId.get(id)!;
      const result = await step.run(`purge-${id}`, async () => {
        let filesDeleted: number;
        let foreign: number;
        try {
          const keys = await collectInvoiceStorageKeys(createAdminClient(), invoice as RetainedInvoice);
          filesDeleted = await deleteInvoiceStorage(keys);
          foreign = keys.foreign;
        } catch (e) {
          // Limit czasu: jeden wpis wyłącznika po pętli zamiast wpisu tutaj.
          const limit = limitMagazynu(e);
          if (limit) return { limit };
          logger.error('Retencja: pliki faktury nieusunięte — wiersz zostaje do następnego przebiegu', {
            invoiceId: invoice.id,
            error: e instanceof Error ? e.message : String(e),
          });
          return 'pliki' as const;
        }
        // Wiersz osobno: błąd jednej faktury nie zatrzymuje pozostałych.
        const { error } = await createAdminClient().from('invoices').delete().eq('id', invoice.id);
        if (error) {
          logger.error('Retencja: pliki usunięte, wiersz faktury został', { invoiceId: invoice.id, error: error.message });
          return 'wiersz' as const;
        }
        // Wpis po usunięciu wiersza: prawdziwy i jeden także przy ponowieniu.
        try {
          await logAuditSystem({
            action: 'retention.deletion_executed',
            tenantId: invoice.tenant_id,
            entityType: 'invoice',
            entityId: invoice.id,
            metadata: { internalNumber: invoice.internal_number, reason: '10-year retention expired', filesDeleted, foreignKeysSkipped: foreign },
          });
        } catch (e) {
          logger.error('Retencja: faktura usunięta, wpis audytu nie zapisał się', { invoiceId: invoice.id, error: e instanceof Error ? e.message : String(e) });
        }
        return 'usunieta' as const;
      });
      if (typeof result === 'object') wylacznik = { invoiceId: id, ...result.limit };
      if (result === 'usunieta') deleted++;
      if (result === 'wiersz') bledyWierszy++;
    }

    const pending = plan.kolejnosc.length - deleted;
    // Przed błędem wierszy niżej: operator ma zobaczyć wyłącznik także wtedy.
    if (wylacznik) {
      const { invoiceId, operation, attempts } = wylacznik;
      logger.error(
        `Retencja: magazyn plików nie odpowiedział w limicie czasu (${operation}, prób: ${attempts}). ` +
          `Wyłącznik: pominięte faktury: ${skipped}, czeka razem: ${pending}; wiersze zostają, następny przebieg ponowi`,
        { invoiceId, skipped, pending, deleted, operation, attempts },
      );
      // Same liczby, bez identyfikatorów faktur i kluczy plików; faktura, przy
      // której stanął magazyn, jest w logu workera.
      Sentry.captureMessage('Retencja: magazyn plików nie odpowiedział w limicie czasu, faktury czekają na następny przebieg', {
        level: 'error',
        tags: { job: 'retention-delete' },
        extra: { skipped, pending, deleted, operation, attempts },
      });
    }

    // Wiersz, którego baza nie dała usunąć po planie (nowa korekta albo koszt
    // w trakcie przebiegu): ponowienie zaplanuje go od nowa.
    if (bledyWierszy > 0) throw new Error(`Retencja: ${bledyWierszy} faktur bez usuniętego wiersza po usunięciu plików`);

    return { deleted, pending, postponed: plan.odroczone.length, storageTimeoutSkipped: skipped };
}
