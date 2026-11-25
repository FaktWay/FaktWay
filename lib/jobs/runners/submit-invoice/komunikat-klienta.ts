/**
 * Tekst porażki walidacji faktury dla klienta (U3 z obchodu aplikacji
 * 20.11.2026). `onSubmitInvoiceExhausted` zapisuje go w `invoices.last_error`,
 * `last_error_field` i `last_error_suggestion`; czytają je strona
 * (`components/invoices/error-display.tsx`) i telefon (karta „Dlaczego KSeF
 * odrzucił fakturę”), więc to ten sam tekst w obu miejscach.
 *
 * Dotyczy dwóch błędów, które powstają PRZED wysyłką do KSeF:
 *   - `InvoiceXmlSchemaError` (plik niezgodny ze schematem FA(3));
 *   - `InvoiceValidationError` (walidacja biznesowa: suma kontrolna NIP,
 *     daty, pozycje).
 * Błąd leży w łańcuchu przyczyn (`cause`) `NonRetriableError`, którego treść
 * zostaje tekstem operatora: log workera, audyt i dziennik prób niosą pełny
 * komunikat techniczny (libxml), a ponawianie i klasyfikacja po nim się nie zmieniają.
 *
 * Klasy rozpoznajemy po nazwie, jak w `send-error-codes.ts`: błąd mógł przejść
 * przez inną kopię modułu.
 */
import { SUPPORT_EMAIL } from '@/lib/site';
import { FA3_ISSUE_LEAD } from '@/lib/xml/fa3-limits';

export interface CustomerFailure {
  readonly message: string;
  readonly field: string | null;
  readonly suggestion: string;
}

/** Najwyżej tyle uwag walidacji w jednym zdaniu dla klienta; reszta to liczba. */
const MAX_SHOWN = 3;

/** Błąd i jego przyczyny, od wierzchu w dół; bez pętli. */
function chain(error: unknown): Error[] {
  const out: Error[] = [];
  let current: unknown = error;
  while (current instanceof Error && out.length < 8 && !out.includes(current)) {
    out.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return out;
}

/**
 * Tekst błędu bez nazwy klasy na początku („TypeError: fetch failed”,
 * „Error: …”): runner składa ją w treści ponowienia (`send.ts`, `errorLabel`).
 * Nazwa klasy to szczegół techniczny, nie komunikat dla klienta (U3).
 */
export function withoutErrorClass(message: string): string {
  return message.replace(/^(?:(?:[A-Z][A-Za-z0-9]*)?(?:Error|Exception): )+/, '');
}

const withDot = (text: string): string => {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

/** Ogólne zdanie, gdy pola nie da się nazwać bez zgadywania: bez surowego tekstu walidatora. */
function genericSchemaFailure(): CustomerFailure {
  return {
    message: `${FA3_ISSUE_LEAD} Dane faktury nie przeszły sprawdzenia formatu przed wysyłką.`,
    field: null,
    suggestion:
      'Sprawdź dane nabywcy, daty, pozycje i kwoty, popraw je w szkicu i wyślij fakturę jeszcze raz. ' +
      `Jeśli błąd wróci, napisz do pomocy FaktWay: ${SUPPORT_EMAIL}.`,
  };
}

function schemaFailure(error: Error): CustomerFailure {
  const customer = (error as { customer?: Partial<CustomerFailure> }).customer;
  if (customer && typeof customer.message === 'string' && typeof customer.suggestion === 'string') {
    return {
      message: customer.message,
      field: typeof customer.field === 'string' ? customer.field : null,
      suggestion: customer.suggestion,
    };
  }
  return genericSchemaFailure();
}

/** Komunikaty walidacji biznesowej są już po polsku i z nazwami pól; bez opakowania „Faktura zawiera N błędów”. */
function businessFailure(error: Error): CustomerFailure {
  const raw = (error as { errors?: unknown }).errors;
  const errors = Array.isArray(raw) ? raw.filter((e): e is string => typeof e === 'string' && e.trim() !== '') : [];
  if (errors.length === 0) return genericSchemaFailure();
  const shown = errors.slice(0, MAX_SHOWN).map(withDot).join(' ');
  const more = errors.length > MAX_SHOWN ? ` Razem uwag: ${errors.length}.` : '';
  return {
    message: `${FA3_ISSUE_LEAD} ${shown}${more}`,
    field: null,
    suggestion: 'Popraw wskazane dane.',
  };
}

/**
 * Tekst dla klienta, gdy porażka to błąd schematu albo walidacji faktury
 * (gdziekolwiek w łańcuchu przyczyn); `null` dla każdego innego błędu.
 */
export function validationFailureIn(error: unknown): CustomerFailure | null {
  for (const e of chain(error)) {
    if (e.name === 'InvoiceXmlSchemaError') return schemaFailure(e);
    if (e.name === 'InvoiceValidationError') return businessFailure(e);
  }
  return null;
}
