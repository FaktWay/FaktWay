

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
    for (const id of plan.kolejnosc) {
      const invoice = poId.get(id)!;
      const result = await step.run(`purge-${id}`, async () => {
        let filesDeleted: number;
        let foreign: number;
        try {
          const keys = await collectInvoiceStorageKeys(createAdminClient(), invoice as RetainedInvoice);
          filesDeleted = await deleteInvoiceStorage(keys);
          foreign = keys.foreign;
        } catch (e) {
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
      if (result === 'usunieta') deleted++;
      if (result === 'wiersz') bledyWierszy++;
    }

    // Wiersz, którego baza nie dała usunąć po planie (nowa korekta albo koszt
    // w trakcie przebiegu): ponowienie zaplanuje go od nowa.
    if (bledyWierszy > 0) throw new Error(`Retencja: ${bledyWierszy} faktur bez usuniętego wiersza po usunięciu plików`);

    return { deleted, pending: plan.kolejnosc.length - deleted, postponed: plan.odroczone.length };
}
