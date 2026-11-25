import { createHash } from 'node:crypto';

import { formatIsoDatePl } from '@/lib/format/iso-date';
import { BALANCE_REQUEST, BALANCE_SCOPE_NOTICE, BALANCE_TITLE, balanceSummarySentence } from '@/lib/saldo/teksty';

/**
 * Mail z potwierdzeniem salda do kontrahenta (krok 2.9, część 2): temat,
 * treść i klucz idempotencji. Wysyłka idzie istniejącą drogą (`sendEmail`
 * z `lib/email/send.ts`, nagłówek `Idempotency-Key` w Resend, 24 h), jak noty.
 */

/**
 * Klucz zależy od zdarzenia, nie od próby (AUD-86), jak przy notach: dokument,
 * skrót adresu i liczba wysyłek tego dokumentu na ten adres zapisanych już
 * w historii. Ponowienie po wysyłce, której nie zdążyliśmy zapisać, daje ten
 * sam klucz, więc Resend nie wyśle drugi raz; świadome „Wyślij ponownie” po
 * zapisanej wysyłce daje nowy. Adres tylko jako skrót (klucz trafia do
 * dzienników dostawcy), logo jako skrót klucza logo (inne logo to inny PDF).
 * Przedrostek `saldo/<id>/` sprawdza RPC `record_balance_confirmation_email` (00216).
 */
export function balanceEmailIdempotencyKey(
  confirmationId: string,
  recipient: string,
  previousSends: number,
  logoKey: string | null = null,
): string {
  const hash = createHash('sha256').update(recipient.trim().toLowerCase()).digest('hex').slice(0, 16);
  const logo = logoKey ? `/${createHash('sha256').update(logoKey).digest('hex').slice(0, 16)}` : '';
  return `saldo/${confirmationId}/${hash}/${previousSends}${logo}`;
}

export interface BalanceEmailContent {
  number: string;
  asOf: string;
  total: number;
  issuerName: string;
}

export function balanceEmailSubject(doc: BalanceEmailContent): string {
  return `${BALANCE_TITLE} ${doc.number} od ${doc.issuerName}`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Stopka jak przy nocie: nadawcą jest wystawca, FaktWay przetwarza dane na jego zlecenie. */
export function balanceEmailFooter(issuerName: string): string {
  const issuer = escapeHtml(issuerName);
  return (
    `Potwierdzenie salda wysłał(a) ${issuer} za pośrednictwem serwisu FaktWay, który przetwarza dane na zlecenie ${issuer}. ` +
    `W sprawie salda, płatności i Twoich danych osobowych skontaktuj się bezpośrednio z ${issuer}. ` +
    'Odpowiedź na tę wiadomość trafi do obsługi FaktWay, która przekaże ją nadawcy.'
  );
}

/** Treść HTML bez znaczników czasu: ten sam dokument daje tę samą treść (ponowienie z tym samym kluczem). */
export function balanceEmailHtml(doc: BalanceEmailContent): string {
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:560px;margin:0 auto;color:#374151">
      <h1 style="font-size:20px;color:#111827">${escapeHtml(BALANCE_TITLE)} ${escapeHtml(doc.number)}</h1>
      <p>Dzień dobry,</p>
      <p>w załączniku przesyłamy potwierdzenie salda <strong>${escapeHtml(doc.number)}</strong>
      od <strong>${escapeHtml(doc.issuerName)}</strong> według stanu na dzień ${escapeHtml(formatIsoDatePl(doc.asOf))}.</p>
      <p><strong>${escapeHtml(balanceSummarySentence(doc.total))}</strong></p>
      <p>${escapeHtml(BALANCE_REQUEST)}</p>
      <p style="font-size:13px">${escapeHtml(BALANCE_SCOPE_NOTICE)}</p>
      <p style="color:#9ca3af;font-size:12px">${balanceEmailFooter(doc.issuerName)}</p>
    </div>
  `;
}
