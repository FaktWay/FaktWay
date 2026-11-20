import { describe, expect, it } from 'vitest';

import { validationFailureIn } from '@/lib/jobs/runners/submit-invoice/komunikat-klienta';
import { NonRetriableError } from '@/lib/jobs/errors';
import { assertFa3TextLimits, FA3_TEXT_LIMITS, InvoiceXmlSchemaError } from '@/lib/xml/fa3-limits';
import { InvoiceValidationError } from '@/lib/xml/fa3-generator';

/**
 * U3: tekst dla klienta przy błędzie schematu i walidacji faktury. Moduł jest
 * czystą funkcją nad łańcuchem przyczyn `NonRetriableError`; pełny przebieg
 * runnera z prawdziwym XSD jest w `ksef-powod-odrzucenia-dla-klienta.test.ts`.
 */

const owiniety = (przyczyna: Error) => new NonRetriableError('tekst operatora', { cause: przyczyna });

describe('validationFailureIn', () => {
  it('inny błąd niż schemat i walidacja faktury: null (tekst zostaje bez zmian)', () => {
    expect(validationFailureIn(new Error('Nie można zapisać'))).toBeNull();
    expect(validationFailureIn(owiniety(new Error('KSeF HTTP 503')))).toBeNull();
    expect(validationFailureIn('nie błąd')).toBeNull();
  });

  it('schemat bez opisu (np. stary błąd albo inna kopia modułu): ogólne zdanie bez surowego tekstu, z adresem pomocy', () => {
    const failure = validationFailureIn(owiniety(new InvoiceXmlSchemaError(["Linia 1: Schemas validity error : Element '{x}NIP': [facet 'pattern']"])));

    expect(failure).toMatchObject({ field: null });
    expect(failure?.message).toBe('Faktura nie trafiła do KSeF. Dane faktury nie przeszły sprawdzenia formatu przed wysyłką.');
    expect(failure?.suggestion).toContain('pomoc@faktway.pl');
    expect(`${failure?.message} ${failure?.suggestion}`).not.toMatch(/Schemas|facet|NIP/);
  });

  it('schemat z opisem: zdanie, pole i podpowiedź bez zmian', () => {
    const customer = { message: 'Faktura nie trafiła do KSeF. Pole „Waluta” ma niepoprawny format.', field: 'Waluta', suggestion: 'Wpisz walutę.' };

    expect(validationFailureIn(owiniety(new InvoiceXmlSchemaError(['surowy'], customer)))).toEqual(customer);
  });

  it('opis uszkodzony (inny kształt): ogólne zdanie, nie wyjątek', () => {
    const e = new InvoiceXmlSchemaError(['surowy']);
    (e as unknown as { customer: unknown }).customer = { message: 7 };

    expect(validationFailureIn(owiniety(e))?.field).toBeNull();
  });

  it('klasa rozpoznana po nazwie, gdy błąd przeszedł przez inną kopię modułu', () => {
    const obcy = Object.assign(new Error('x'), { name: 'InvoiceValidationError', errors: ['Termin płatności nie może być wcześniejszy niż data wystawienia.'] });

    expect(validationFailureIn(owiniety(obcy))?.message).toBe(
      'Faktura nie trafiła do KSeF. Termin płatności nie może być wcześniejszy niż data wystawienia.',
    );
  });

  it('walidacja faktury: komunikaty z nazwami pól, bez opakowania „Faktura zawiera N błędów”, pole puste', () => {
    const failure = validationFailureIn(owiniety(new InvoiceValidationError(['NIP nabywcy "123" ma nieprawidłową sumę kontrolną.', 'Faktura musi mieć co najmniej jedną pozycję'])));

    expect(failure?.message).toBe(
      'Faktura nie trafiła do KSeF. NIP nabywcy "123" ma nieprawidłową sumę kontrolną. Faktura musi mieć co najmniej jedną pozycję.',
    );
    expect(failure?.field).toBeNull();
    expect(failure?.suggestion).toBe('Popraw wskazane dane w szkicu faktury.');
  });

  it('walidacja faktury: najwyżej trzy uwagi, reszta jako liczba', () => {
    const failure = validationFailureIn(owiniety(new InvoiceValidationError(['A.', 'B.', 'C.', 'D.', 'E.'])));

    expect(failure?.message).toBe('Faktura nie trafiła do KSeF. A. B. C. Razem uwag: 5.');
  });

  it('walidacja faktury bez komunikatów: ogólne zdanie', () => {
    expect(validationFailureIn(owiniety(new InvoiceValidationError([])))?.message).toContain('nie przeszły sprawdzenia formatu');
  });
});

describe('granice tekstu przed budową XML (assertFa3TextLimits) niosą opis z nazwą pola', () => {
  it('zdanie składa się z gotowych komunikatów generatora, pole puste, podpowiedź ogólna', () => {
    const za = 'x'.repeat(FA3_TEXT_LIMITS.nazwa.max + 1);
    let zlapany: unknown;
    try {
      assertFa3TextLimits([{ label: 'Nabywca, nazwa', value: za, limit: FA3_TEXT_LIMITS.nazwa }]);
    } catch (e) {
      zlapany = e;
    }

    const failure = validationFailureIn(owiniety(zlapany as Error));
    expect(failure?.message).toMatch(/^Faktura nie trafiła do KSeF\. Nabywca, nazwa: najwyżej \d+ znaków?, a jest \d+\.$/);
    expect(failure?.field).toBeNull();
    expect(failure?.suggestion).toBe('Popraw wskazane pola w szkicu faktury.');
    // Operator dostaje to samo co dotąd w `errors`.
    expect((zlapany as InvoiceXmlSchemaError).errors).toHaveLength(1);
  });
});
