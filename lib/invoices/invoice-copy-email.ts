/**
 * Kopia maila z fakturą do księgowej (plan kompletnej aplikacji, krok 2.8).
 *
 * Gdy firma ustawiła adres księgowej (`tenant_invoice_defaults`, 00209),
 * każdy mail z fakturą do nabywcy dostaje OSOBNĄ wiadomość do księgowej z tym
 * samym PDF. Osobna wiadomość, nie ukryta kopia: nabywca nie zobaczy adresu
 * księgowej, a księgowa nie dostaje adresu nabywcy (wiadomość go nie zawiera;
 * dane nabywcy są tylko w samym PDF faktury). Kopia idzie dopiero po udanej
 * wysyłce do nabywcy; jej błąd nie cofa tamtej wysyłki (zwracamy `failed`),
 * a każda wysłana kopia ma wpis w audycie (`invoice.emailed`, `copy: true`).
 * Ponowienie: akcja użytkownika nie ponawia sama; ponowna wysyłka do nabywcy
 * to nowe działanie osoby i nowa kopia (też w audycie).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { logAudit } from '@/lib/audit/log';
import { invoiceEmailFooter, sendEmail } from '@/lib/email/send';
import { readInvoiceDefaults } from '@/lib/invoices/invoice-defaults';

export type InvoiceCopyResult = 'none' | 'sent' | 'failed';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function sendInvoiceCopyToAccountant(input: {
  db: SupabaseClient;
  tenantId: string;
  userId: string;
  invoiceId: string;
  /** Adres, na który poszła wiadomość do nabywcy (tylko do wykluczenia dubla; nie trafia do kopii). */
  buyerEmail: string;
  invoiceNumber: string;
  sellerName: string;
  amountCaption: string;
  amountLabel: string;
  dueDate: string;
  transferTitle?: string | null;
  pdf: Buffer;
  pdfFilename: string;
}): Promise<InvoiceCopyResult> {
  const defaults = await readInvoiceDefaults(input.db, input.tenantId);
  const to = defaults?.accountantCopyEmail ?? null;
  // Księgowa wpisana jako nabywca dostała już tę wiadomość.
  if (!to || to === input.buyerEmail.trim().toLowerCase()) return 'none';

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:560px;margin:0 auto;color:#374151">
      <h1 style="font-size:20px;color:#111827">Kopia faktury ${esc(input.invoiceNumber)}</h1>
      <p>Dzień dobry,</p>
      <p>W załączniku kopia faktury <strong>${esc(input.invoiceNumber)}</strong> wystawionej przez
      <strong>${esc(input.sellerName)}</strong>, wysłanej do nabywcy.</p>
      <table style="margin:16px 0;font-size:14px">
        <tr><td style="color:#6b7280;padding-right:16px">${esc(input.amountCaption)}</td><td><strong>${esc(input.amountLabel)}</strong></td></tr>
        <tr><td style="color:#6b7280;padding-right:16px">Termin płatności</td><td>${esc(input.dueDate)}</td></tr>
        ${input.transferTitle ? `<tr><td style="color:#6b7280;padding-right:16px">Tytuł przelewu</td><td>${esc(input.transferTitle)}</td></tr>` : ''}
      </table>
      <p style="color:#9ca3af;font-size:12px">${invoiceEmailFooter(input.sellerName)}</p>
    </div>
  `;

  try {
    const sent = await sendEmail({
      to,
      subject: `Kopia: faktura ${input.invoiceNumber} od ${input.sellerName}`,
      html,
      category: 'transactional',
      attachments: [{ filename: input.pdfFilename, content: input.pdf }],
    });
    if (!sent.sent) return 'failed';
  } catch {
    return 'failed';
  }
  await logAudit({
    action: 'invoice.emailed',
    tenantId: input.tenantId,
    userId: input.userId,
    entityType: 'invoice',
    entityId: input.invoiceId,
    metadata: { recipient: to, copy: true },
  });
  return 'sent';
}
