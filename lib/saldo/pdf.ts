import path from 'node:path';
import PDFDocument from 'pdfkit';

import { formatIsoDatePl } from '@/lib/format/iso-date';
import { formatPlMoney } from '@/lib/format/pl';
import { drawPdfLogo, type PdfLogo } from '@/lib/pdf/logo';
import type { BalanceConfirmation, BalanceItem, BalanceParty } from '@/lib/saldo/model';
import {
  BALANCE_REQUEST,
  BALANCE_SCOPE_NOTICE,
  BALANCE_SETTLEMENT_NOTE,
  BALANCE_TITLE,
  balanceSummarySentence,
} from '@/lib/saldo/teksty';
import { PUBLIC_SITE_DOMAIN, PUBLIC_SITE_URL } from '@/lib/site';

/**
 * PDF potwierdzenia salda (krok 2.9, część 2; D27 i D28). Silnik i fonty jak
 * przy nocie (`lib/noty/pdf.ts`: pdfkit, Roboto z polskimi znakami). Kolumny
 * z D27 (K3): numer, data, termin, kwota brutto, wpłacono, do zapłaty; bez
 * netto i VAT. Faktura rozliczająca zaliczki ma przypis: do zapłaty jest
 * reszta po zaliczkach. Dokument nie pisze nic o uznaniu długu (D28).
 *
 * Plik jest powtarzalny: data utworzenia PDF to chwila wystawienia, więc ten
 * sam dokument daje bajt w bajt ten sam plik (ponowienie maila z kluczem
 * idempotencji, jak przy notach).
 */

const FONT_DIR = path.join(process.cwd(), 'lib/pdf/fonts');
const MARGIN = 42;
const SETTLEMENT_MARK = '*';

export type BalancePdfInput = Pick<BalanceConfirmation, 'number' | 'asOf' | 'issuedAt' | 'issuer' | 'counterparty' | 'items' | 'total'>;

type Doc = InstanceType<typeof PDFDocument>;

/** „PS/1/2026” → „potwierdzenie-salda-PS-1-2026.pdf”. */
export function balancePdfFilename(number: string): string {
  return `potwierdzenie-salda-${number.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}.pdf`;
}

export interface BalancePdfOptions {
  /** Logo firmy z ustawień (krok 2.2), jak na nocie; to samo logo daje ten sam plik. */
  logo?: PdfLogo | null;
}

export async function renderBalancePdf(doc: BalancePdfInput, options: BalancePdfOptions = {}): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const pdf = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      info: {
        Title: `${BALANCE_TITLE} ${doc.number}`,
        Author: doc.issuer.name,
        CreationDate: new Date(doc.issuedAt),
      },
    });
    const chunks: Buffer[] = [];
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    try {
      pdf.registerFont('body', path.join(FONT_DIR, 'Roboto-Regular.ttf'));
      pdf.registerFont('bold', path.join(FONT_DIR, 'Roboto-Bold.ttf'));
      const left = MARGIN;
      const width = pdf.page.width - MARGIN * 2;

      drawHeader(pdf, doc, options.logo ?? null, left, width);
      drawParties(pdf, doc, left, width);
      drawItems(pdf, doc.items, left, width);
      drawSummary(pdf, doc, left, width);
      drawFooter(pdf, left, width);
      pdf.end();
    } catch (error) {
      reject(error);
    }
  });
}

function contentBottom(pdf: Doc): number {
  return pdf.page.height - MARGIN - 24;
}

function ensureSpace(pdf: Doc, height: number): void {
  if (pdf.y + height > contentBottom(pdf)) pdf.addPage();
}

function drawHeader(pdf: Doc, doc: BalancePdfInput, logo: PdfLogo | null, left: number, width: number): void {
  const top = MARGIN + drawPdfLogo(pdf, logo, left, MARGIN);
  pdf.font('bold').fontSize(20).fillColor('#111111');
  pdf.text(BALANCE_TITLE, left, top, { width });
  pdf.font('body').fontSize(11).fillColor('#444444');
  pdf.text(`Nr ${doc.number}`, left, top + 26, { width });
  pdf.fontSize(9).fillColor('#666666');
  // W tej wersji dzień salda to dzień wystawienia (D26).
  pdf.text(`Data wystawienia: ${formatIsoDatePl(doc.asOf)}`, left, top + 44, { width });
  pdf.text(`Stan na dzień: ${formatIsoDatePl(doc.asOf)}`, left, top + 56, { width });

  const ruleY = top + 76;
  pdf.moveTo(left, ruleY).lineTo(left + width, ruleY).strokeColor('#dddddd').stroke();
  pdf.y = ruleY + 14;
}

function drawParties(pdf: Doc, doc: BalancePdfInput, left: number, width: number): void {
  const colWidth = (width - 20) / 2;
  const top = pdf.y;
  const block = (x: number, heading: string, party: BalanceParty) => {
    pdf.font('bold').fontSize(8).fillColor('#888888');
    pdf.text(heading, x, top, { width: colWidth });
    pdf.font('bold').fontSize(11).fillColor('#111111');
    pdf.text(party.name, x, top + 12, { width: colWidth });
    pdf.font('body').fontSize(9).fillColor('#444444');
    pdf.text(`NIP: ${party.nip}`, x, pdf.y + 1, { width: colWidth });
    if (party.addressLine1) pdf.text(party.addressLine1, x, pdf.y, { width: colWidth });
    if (party.addressLine2) pdf.text(party.addressLine2, x, pdf.y, { width: colWidth });
    return pdf.y;
  };
  const issuerBottom = block(left, 'Wystawca', doc.issuer);
  const counterpartyBottom = block(left + colWidth + 20, 'Adresat', doc.counterparty);
  pdf.y = Math.max(issuerBottom, counterpartyBottom) + 18;
}

/** Kolumny tabeli (części szerokości); kwoty w PLN. */
const COLUMNS = [
  { label: 'Lp', share: 0.05, align: 'left' as const },
  { label: 'Numer faktury', share: 0.25, align: 'left' as const },
  { label: 'Data wystawienia', share: 0.13, align: 'left' as const },
  { label: 'Termin płatności', share: 0.13, align: 'left' as const },
  { label: 'Kwota brutto', share: 0.15, align: 'right' as const },
  { label: 'Wpłacono', share: 0.14, align: 'right' as const },
  { label: 'Do zapłaty', share: 0.15, align: 'right' as const },
];

function itemValues(item: BalanceItem, index: number): string[] {
  const mark = item.kind === 'final' ? ` ${SETTLEMENT_MARK}` : '';
  return [
    String(index + 1),
    `${item.number}${mark}`,
    formatIsoDatePl(item.issueDate),
    item.dueDate ? formatIsoDatePl(item.dueDate) : 'bez terminu',
    // D58: przy ROZ kwota po zaliczkach (P_15), więc brutto minus wpłacono daje do zapłaty.
    formatPlMoney(item.kind === 'final' ? item.amountDue : item.gross),
    formatPlMoney(item.paid),
    formatPlMoney(item.outstanding),
  ];
}

function drawItems(pdf: Doc, items: readonly BalanceItem[], left: number, width: number): void {
  const pad = 4;
  const minRow = 20;
  const textTop = 6;
  const xs: number[] = [];
  let acc = left;
  for (const column of COLUMNS) {
    xs.push(acc);
    acc += column.share * width;
  }
  const cellWidth = (i: number) => COLUMNS[i]!.share * width - pad * 2;

  const headerRow = () => {
    const top = pdf.y;
    pdf.rect(left, top, width, minRow + 8).fill('#f3f3f3');
    pdf.font('bold').fontSize(7.5).fillColor('#333333');
    COLUMNS.forEach((column, i) => {
      pdf.text(column.label, xs[i]! + pad, top + textTop, { width: cellWidth(i), align: column.align });
    });
    pdf.y = top + minRow + 8;
    pdf.font('body').fontSize(8.5).fillColor('#222222');
  };

  ensureSpace(pdf, minRow * 3);
  headerRow();

  items.forEach((item, index) => {
    const values = itemValues(item, index);
    const textHeight = Math.max(
      ...values.map((value, i) => pdf.heightOfString(value, { width: cellWidth(i), align: COLUMNS[i]!.align })),
    );
    const rowHeight = Math.max(minRow, Math.ceil(textHeight) + textTop * 2);
    if (pdf.y + rowHeight > contentBottom(pdf)) {
      pdf.addPage();
      headerRow();
    }
    const top = pdf.y;
    if (index % 2 === 1) {
      pdf.rect(left, top, width, rowHeight).fill('#fafafa');
      pdf.fillColor('#222222');
    }
    values.forEach((value, i) => {
      pdf.text(value, xs[i]! + pad, top + textTop, { width: cellWidth(i), align: COLUMNS[i]!.align });
    });
    pdf.y = top + rowHeight;
  });

  pdf.moveTo(left, pdf.y).lineTo(left + width, pdf.y).strokeColor('#dddddd').stroke();
  pdf.y += 8;
  if (items.some((item) => item.kind === 'final')) {
    ensureSpace(pdf, 24);
    pdf.font('body').fontSize(8).fillColor('#555555');
    pdf.text(`${SETTLEMENT_MARK} ${BALANCE_SETTLEMENT_NOTE}`, left, pdf.y, { width });
    pdf.y += 6;
  }
}

function drawSummary(pdf: Doc, doc: BalancePdfInput, left: number, width: number): void {
  ensureSpace(pdf, 120);
  pdf.font('bold').fontSize(11).fillColor('#111111');
  pdf.text(`Razem do zapłaty: ${formatPlMoney(doc.total)} PLN`, left, pdf.y, { width, align: 'right' });
  pdf.y += 12;

  pdf.font('body').fontSize(10).fillColor('#222222');
  pdf.text(balanceSummarySentence(doc.total), left, pdf.y, { width });
  pdf.y += 8;
  pdf.text(BALANCE_REQUEST, left, pdf.y, { width });

  pdf.y += 16;
  pdf.font('bold').fontSize(9).fillColor('#222222');
  pdf.text(BALANCE_SCOPE_NOTICE, left, pdf.y, { width });
}

function drawFooter(pdf: Doc, left: number, width: number): void {
  const footY = pdf.page.height - MARGIN - 14;
  pdf.moveTo(left, footY).lineTo(left + width, footY).strokeColor('#eeeeee').stroke();
  pdf.font('body').fontSize(7).fillColor('#aaaaaa');
  pdf.text(`Dokument wygenerowany w FaktWay: ${PUBLIC_SITE_DOMAIN}`, left, footY + 4, {
    width,
    align: 'center',
    link: PUBLIC_SITE_URL,
    lineBreak: false,
  });
}
