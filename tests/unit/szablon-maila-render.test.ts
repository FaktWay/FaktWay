import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INVOICE_EMAIL_TEMPLATE,
  INVOICE_EMAIL_PLACEHOLDERS,
  renderInvoiceEmailBodyHtml,
  renderInvoiceEmailSubject,
  validateInvoiceEmailTemplate,
} from '@/lib/email/invoice-email-template';

/**
 * Własny szablon maila z fakturą (plan kompletnej aplikacji, krok 2.8):
 * walidacja i składanie tematu i treści z pól. Czysta logika, bez atrap.
 */

const wartosci = {
  numer: 'FV/12/11/2026',
  sprzedawca: 'Moja Firma sp. z o.o.',
  kwota: '1 230,00 PLN',
  termin: '2026-11-30',
  tytul_przelewu: 'Faktura FV/12/11/2026',
};

describe('pola szablonu', () => {
  it('lista pól: numer, sprzedawca, kwota, termin, tytuł przelewu', () => {
    expect(INVOICE_EMAIL_PLACEHOLDERS.map((p) => p.key)).toEqual(['numer', 'sprzedawca', 'kwota', 'termin', 'tytul_przelewu']);
  });

  it('domyślny szablon odpowiada dzisiejszemu mailowi (temat i pierwsze zdanie)', () => {
    expect(DEFAULT_INVOICE_EMAIL_TEMPLATE.subject).toBe('Faktura {numer} od {sprzedawca}');
    expect(DEFAULT_INVOICE_EMAIL_TEMPLATE.body).toContain('{numer}');
    expect(validateInvoiceEmailTemplate(DEFAULT_INVOICE_EMAIL_TEMPLATE).ok).toBe(true);
  });
});

describe('walidacja', () => {
  it('przycina odstępy i przyjmuje poprawny szablon', () => {
    const r = validateInvoiceEmailTemplate({ subject: '  Faktura {numer}  ', body: '  Dzień dobry,\n\nFaktura {numer} na {kwota}.  ' });
    expect(r).toEqual({ ok: true, subject: 'Faktura {numer}', body: 'Dzień dobry,\n\nFaktura {numer} na {kwota}.' });
  });

  it.each([
    [{ subject: '', body: 'x' }, /temat/i],
    [{ subject: 'x', body: '   ' }, /treść/i],
    [{ subject: 'x'.repeat(121), body: 'x' }, /temat/i],
    [{ subject: 'x', body: 'x'.repeat(2001) }, /treść/i],
    [{ subject: 'Temat\ndrugi wiersz', body: 'x' }, /temat/i],
  ])('odrzuca %j', (tpl, wzorzec) => {
    const r = validateInvoiceEmailTemplate(tpl);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(wzorzec);
  });

  it('nieznane pole jest błędem z nazwą pola i listą dozwolonych', () => {
    const r = validateInvoiceEmailTemplate({ subject: 'Faktura {numr}', body: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('{numr}');
      expect(r.error).toContain('{numer}');
    }
  });

  it('nieznane pole w treści też', () => {
    const r = validateInvoiceEmailTemplate({ subject: 'x', body: 'Do zapłaty {kwota_brutto}' });
    expect(r.ok).toBe(false);
  });

  it('znaki sterujące w treści odrzucone, nowe wiersze dozwolone', () => {
    expect(validateInvoiceEmailTemplate({ subject: 'x', body: 'a\u0000b' }).ok).toBe(false);
    expect(validateInvoiceEmailTemplate({ subject: 'x', body: 'a\r\nb\n\nc' }).ok).toBe(true);
  });
});

describe('składanie', () => {
  it('temat: pola zastąpione wartościami', () => {
    expect(renderInvoiceEmailSubject('Faktura {numer} na {kwota} od {sprzedawca}', wartosci)).toBe(
      'Faktura FV/12/11/2026 na 1 230,00 PLN od Moja Firma sp. z o.o.',
    );
  });

  it('temat: wartość z nowym wierszem nie łamie nagłówka', () => {
    expect(renderInvoiceEmailSubject('Faktura {sprzedawca}', { ...wartosci, sprzedawca: 'Firma\r\nBcc: x@y.z' })).toBe('Faktura Firma Bcc: x@y.z');
  });

  it('treść: akapity po pustym wierszu, pojedynczy wiersz to <br>, pola z wartościami', () => {
    const html = renderInvoiceEmailBodyHtml('Dzień dobry,\n\nFaktura {numer}\nna kwotę {kwota}.', wartosci);
    expect(html).toBe('<p>Dzień dobry,</p><p>Faktura FV/12/11/2026<br>na kwotę 1 230,00 PLN.</p>');
  });

  it('treść: HTML w szablonie i w wartościach jest wyłączony z działania', () => {
    const html = renderInvoiceEmailBodyHtml('<script>alert(1)</script> {sprzedawca}', { ...wartosci, sprzedawca: '<img src=x onerror=1>' });
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img');
  });

  it('wartość pola zawierająca {inne} nie jest podstawiana drugi raz', () => {
    expect(renderInvoiceEmailSubject('{sprzedawca}', { ...wartosci, sprzedawca: '{kwota}' })).toBe('{kwota}');
  });

  it('brak tytułu przelewu: pole zostaje puste, nie „null”', () => {
    expect(renderInvoiceEmailSubject('Faktura {numer}{tytul_przelewu}', { ...wartosci, tytul_przelewu: '' })).toBe('Faktura FV/12/11/2026');
  });
});
