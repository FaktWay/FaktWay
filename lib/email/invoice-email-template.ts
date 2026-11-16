/**
 * Własny szablon maila z fakturą (plan kompletnej aplikacji, krok 2.8).
 *
 * Firma może zmienić temat i treść wiadomości, którą nabywca dostaje z fakturą
 * w załączniku. Szablon to zwykły tekst z polami w nawiasach klamrowych
 * (`INVOICE_EMAIL_PLACEHOLDERS`); pola zastępują się wartościami faktury
 * w chwili wysyłki. Czysta logika: bez bazy i bez poczty.
 *
 * Co szablon zmienia, a czego NIE: zmienia temat i akapity powitania
 * w treści. Tabela z kwotą, terminem płatności i tytułem przelewu oraz stopka
 * o przetwarzaniu danych są w mailu zawsze (`sendInvoiceEmail`), a wartość
 * pola `{kwota}` to ta sama kwota, którą mail podaje w tabeli i PDF w załączniku
 * (`invoiceEmailAmount`). Szablon nie wykonuje HTML: cały tekst jest
 * wyłączany z działania (`escapeHtml`), a wartość pola nie jest podstawiana
 * drugi raz (jedno przejście).
 */

import { isXmlSafe } from '@/lib/xml/fa3-limits';

export const INVOICE_EMAIL_PLACEHOLDERS = [
  { key: 'numer', label: 'Numer faktury' },
  { key: 'sprzedawca', label: 'Nazwa sprzedawcy' },
  { key: 'kwota', label: 'Kwota do zapłaty z walutą' },
  { key: 'termin', label: 'Termin płatności' },
  { key: 'tytul_przelewu', label: 'Tytuł przelewu' },
] as const;

export type InvoiceEmailPlaceholder = (typeof INVOICE_EMAIL_PLACEHOLDERS)[number]['key'];
export type InvoiceEmailValues = Record<InvoiceEmailPlaceholder, string>;

export interface InvoiceEmailTemplate {
  subject: string;
  body: string;
}

export const INVOICE_EMAIL_SUBJECT_MAX = 120;
export const INVOICE_EMAIL_BODY_MAX = 2000;

/** Dzisiejszy mail zapisany jako szablon: od niego startuje formularz i do niego wraca „Przywróć domyślny”. */
export const DEFAULT_INVOICE_EMAIL_TEMPLATE: InvoiceEmailTemplate = {
  subject: 'Faktura {numer} od {sprzedawca}',
  body: 'Dzień dobry,\n\nW załączniku przesyłamy fakturę {numer} od {sprzedawca}.',
};

const KNOWN = new Set<string>(INVOICE_EMAIL_PLACEHOLDERS.map((p) => p.key));
const FIELD = /\{([A-Za-z0-9_]+)\}/g;
// Znaki sterujące: wyrażenie z modułu granic (jedno źródło, C1) plus separatory wierszy Unicode (U+0085, U+2028, U+2029).
const LINE_SEPARATORS = /[\u0085\u2028\u2029]/;
const hasForbiddenChars = (text: string) => !isXmlSafe(text) || LINE_SEPARATORS.test(text);

const allowedList = () => INVOICE_EMAIL_PLACEHOLDERS.map((p) => `{${p.key}}`).join(', ');

function unknownField(text: string): string | null {
  for (const match of text.matchAll(FIELD)) {
    if (!KNOWN.has(match[1]!)) return match[0];
  }
  return null;
}

export type TemplateValidation = ({ ok: true } & InvoiceEmailTemplate) | { ok: false; error: string };

/** Sprawdza i normalizuje szablon z formularza; ta sama reguła po stronie klienta i serwera. */
export function validateInvoiceEmailTemplate(input: { subject: unknown; body: unknown }): TemplateValidation {
  const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!subject) return { ok: false, error: 'Wpisz temat wiadomości.' };
  if (subject.length > INVOICE_EMAIL_SUBJECT_MAX) {
    return { ok: false, error: `Temat jest za długi: najwyżej ${INVOICE_EMAIL_SUBJECT_MAX} znaków.` };
  }
  if (/[\r\n]/.test(subject) || hasForbiddenChars(subject)) {
    return { ok: false, error: 'Temat musi być w jednym wierszu i bez znaków sterujących.' };
  }
  if (!body) return { ok: false, error: 'Wpisz treść wiadomości.' };
  if (body.length > INVOICE_EMAIL_BODY_MAX) {
    return { ok: false, error: `Treść jest za długa: najwyżej ${INVOICE_EMAIL_BODY_MAX} znaków.` };
  }
  if (hasForbiddenChars(body)) return { ok: false, error: 'Treść zawiera niedozwolone znaki sterujące.' };
  const unknown = unknownField(subject) ?? unknownField(body);
  if (unknown) {
    return { ok: false, error: `Nieznane pole ${unknown}. Dostępne pola: ${allowedList()}.` };
  }
  return { ok: true, subject, body };
}

/** Jedno przejście: wartość pola nie jest podstawiana drugi raz. */
function fill(text: string, values: InvoiceEmailValues): string {
  return text.replace(FIELD, (whole, key: string) => (KNOWN.has(key) ? values[key as InvoiceEmailPlaceholder] : whole));
}

export function escapeEmailHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Temat: pola z wartościami, w jednym wierszu (wartość z nowym wierszem nie dopisze nagłówka). */
export function renderInvoiceEmailSubject(subject: string, values: InvoiceEmailValues): string {
  return fill(subject, values).replace(/[\r\n]+/g, ' ').trim();
}

/** Treść jako akapity (tekst, nowe wiersze w środku akapitu zostają): podgląd w ustawieniach i HTML maila. */
export function invoiceEmailBodyParagraphs(body: string, values: InvoiceEmailValues): string[] {
  return fill(body, values)
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

/** Treść w HTML maila: akapity po pustym wierszu, pojedynczy nowy wiersz to `<br>`; cały tekst wyłączony z HTML. */
export function renderInvoiceEmailBodyHtml(body: string, values: InvoiceEmailValues): string {
  return invoiceEmailBodyParagraphs(body, values)
    .map((paragraph) => `<p>${escapeEmailHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}
