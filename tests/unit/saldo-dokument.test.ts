import PDFDocument from 'pdfkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { balanceEmailHtml, balanceEmailIdempotencyKey, balanceEmailSubject } from '@/lib/saldo/mail';
import { BALANCE_REFUSAL_CODES, OMITTED_REASONS, formatBalanceNumber, type BalanceItem } from '@/lib/saldo/model';
import { balancePdfFilename, renderBalancePdf, type BalancePdfInput } from '@/lib/saldo/pdf';
import {
  BALANCE_REFUSALS,
  BALANCE_REQUEST,
  BALANCE_SCOPE_NOTICE,
  BALANCE_SETTLEMENT_NOTE,
  BALANCE_TEXTS,
  BALANCE_TITLE,
  OMITTED_REASON_LABELS,
  balanceSummarySentence,
} from '@/lib/saldo/teksty';

/**
 * Dokument potwierdzenia salda dla kontrahenta (krok 2.9, część 2, PR B;
 * D27 i D28): teksty, PDF i mail. Kolumny z D27 (numer, data, termin, brutto,
 * wpłacono, do zapłaty, bez netto i VAT), dopisek z D28 dosłownie, żadnego
 * zdania o uznaniu długu ani przedawnieniu, PDF powtarzalny (ponowienie maila
 * z tym samym kluczem idempotencji).
 */

const ID = '00215215-3333-4000-8000-000000000001';

function pozycja(zmiany: Partial<BalanceItem> = {}): BalanceItem {
  return {
    invoiceId: '00215215-2222-4000-8000-000000000001', number: 'FV/1/2026', ksefNumber: null, issueDate: '2026-10-01',
    dueDate: '2026-10-15', kind: 'regular', type: 'VAT', gross: 1230, amountDue: 1230, paid: 230, outstanding: 1000, ...zmiany,
  };
}

function dokument(zmiany: Partial<BalancePdfInput> = {}): BalancePdfInput {
  return {
    number: 'PS/1/2026',
    asOf: '2026-11-25',
    issuedAt: '2026-11-25T09:30:00.000Z',
    issuer: { name: 'Moja Firma', nip: '1234567890', countryCode: 'PL', addressLine1: 'ul. Przykładowa 1', addressLine2: '00-001 Warszawa', email: null },
    counterparty: { name: 'Kontrahent Testowy', nip: '1234567890', countryCode: 'PL', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa', email: 'k@kontrahent.test' },
    items: [pozycja()],
    total: 1000,
    ...zmiany,
  };
}

/** Wszystkie napisy na stronach, z twardą spacją (separator tysięcy pl-PL) jako zwykłą. */
async function wydruk(doc: BalancePdfInput): Promise<string[]> {
  const text = vi.spyOn(PDFDocument.prototype, 'text');
  await renderBalancePdf(doc);
  const napisy = text.mock.calls.map((c) => String(c[0]).replace(/\u00a0/g, ' '));
  text.mockRestore();
  return napisy;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const WSZYSTKIE_TEKSTY = [
  BALANCE_TITLE, BALANCE_REQUEST, BALANCE_SCOPE_NOTICE, BALANCE_SETTLEMENT_NOTE, balanceSummarySentence(1234.5),
  ...Object.values(OMITTED_REASON_LABELS), ...Object.values(BALANCE_REFUSALS), ...Object.values(BALANCE_TEXTS),
];

describe('teksty (D27, D28)', () => {
  it('dopisek o zakresie dosłownie z decyzji D28', () => {
    expect(BALANCE_SCOPE_NOTICE).toBe('Zestawienie obejmuje wymienione faktury sprzedaży. Nie zawiera odsetek ani not. Nie jest wezwaniem do zapłaty ani fakturą.');
  });

  it('nic o uznaniu długu ani przedawnieniu, bez długich myślników', () => {
    for (const tekst of WSZYSTKIE_TEKSTY) {
      expect(tekst, tekst).not.toMatch(/uzna|przedawn|\bdług(u|iem)?\b/i);
      expect(tekst, tekst).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it('każdy kod odmowy z bazy i każdy powód pominięcia ma tekst z przyczyną i wyjściem', () => {
    for (const kod of BALANCE_REFUSAL_CODES) expect(BALANCE_REFUSALS[kod].length, kod).toBeGreaterThan(40);
    for (const powod of OMITTED_REASONS) expect(OMITTED_REASON_LABELS[powod].length, powod).toBeGreaterThan(30);
    expect(BALANCE_REFUSALS.changed).toMatch(/Odśwież podgląd/);
    expect(BALANCE_REFUSALS.environment_unknown).toMatch(/Pomoc/);
    expect(BALANCE_TEXTS.pulpitMismatch).toMatch(/Pomoc/);
  });

  it('saldo w złotych z groszami po polsku', () => {
    expect(balanceSummarySentence(12345.5).replace(/\u00a0/g, ' ')).toBe(
      'Saldo należności wystawcy od adresata według ewidencji wystawcy: 12 345,50 PLN.',
    );
  });
});

describe('PDF', () => {
  it('nazwa dokumentu, numer, dzień salda, strony, kolumny z D27 i teksty z D28', async () => {
    const napisy = await wydruk(dokument());
    for (const oczekiwany of [
      BALANCE_TITLE, 'Nr PS/1/2026', 'Stan na dzień: 25.11.2026', 'Wystawca', 'Adresat', 'Moja Firma', 'Kontrahent Testowy',
      'Numer faktury', 'Data wystawienia', 'Termin płatności', 'Kwota brutto', 'Wpłacono', 'Do zapłaty',
      'FV/1/2026', '1230,00', '230,00', '1000,00', BALANCE_REQUEST, BALANCE_SCOPE_NOTICE, balanceSummarySentence(1000).replace(/\u00a0/g, ' '),
    ]) {
      expect(napisy, oczekiwany).toContain(oczekiwany);
    }
    expect(napisy.join('\n')).not.toMatch(/netto|VAT/);
    expect(napisy).not.toContain(`* ${BALANCE_SETTLEMENT_NOTE}`);
  });

  it('faktura rozliczająca zaliczki: gwiazdka przy numerze i przypis o reszcie po zaliczkach', async () => {
    const napisy = await wydruk(dokument({
      items: [pozycja({ number: 'ROZ/1/2026', kind: 'final', type: 'ROZ', gross: 10000, amountDue: 7000, paid: 0, outstanding: 7000 })],
      total: 7000,
    }));
    expect(napisy).toContain('ROZ/1/2026 *');
    expect(napisy).toContain(`* ${BALANCE_SETTLEMENT_NOTE}`);
  });

  it('powtarzalny: ten sam dokument daje te same bajty (data utworzenia to chwila wystawienia)', async () => {
    const a = await renderBalancePdf(dokument());
    const b = await renderBalancePdf(dokument());
    expect(a.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(a.equals(b)).toBe(true);
  });

  it('wiele pozycji mieści się na kolejnych stronach', async () => {
    const items = Array.from({ length: 80 }, (_, i) => pozycja({ invoiceId: `00215215-2222-4000-8000-${String(i + 1).padStart(12, '0')}`, number: `FV/${i + 1}/2026` }));
    const pdf = await renderBalancePdf(dokument({ items, total: 80_000 }));
    expect(pdf.toString('latin1').match(/\/Type \/Page\b/g)?.length ?? 0).toBeGreaterThan(1);
  });

  it('nazwa pliku z numeru', () => {
    expect(balancePdfFilename(formatBalanceNumber(12, 2026))).toBe('potwierdzenie-salda-PS-12-2026.pdf');
  });
});

describe('mail', () => {
  it('klucz idempotencji: przedrostek saldo/<id>/ sprawdzany przez bazę, skrót adresu, liczba zapisanych wysyłek, logo', () => {
    const klucz = balanceEmailIdempotencyKey(ID, ' K@Kontrahent.TEST ', 0);
    expect(klucz).toMatch(new RegExp(`^saldo/${ID}/[0-9a-f]{16}/0$`));
    expect(klucz).toBe(balanceEmailIdempotencyKey(ID, 'k@kontrahent.test', 0));
    expect(klucz).not.toContain('kontrahent');
    expect(balanceEmailIdempotencyKey(ID, 'k@kontrahent.test', 1)).not.toBe(klucz);
    expect(balanceEmailIdempotencyKey(ID, 'k@kontrahent.test', 0, 'logo/a.png')).toMatch(/\/0\/[0-9a-f]{16}$/);
  });

  it('temat i treść: numer, wystawca, dzień salda, saldo, prośba i dopisek; HTML bez wstrzyknięć', () => {
    const tresc = { number: 'PS/1/2026', asOf: '2026-11-25', total: 1000, issuerName: 'Firma <b>A</b> & S-ka' };
    expect(balanceEmailSubject(tresc)).toBe('Potwierdzenie salda PS/1/2026 od Firma <b>A</b> & S-ka');
    const html = balanceEmailHtml(tresc);
    expect(html).toContain('Firma &lt;b&gt;A&lt;/b&gt; &amp; S-ka');
    expect(html).not.toContain('<b>A</b>');
    expect(html).toContain('25.11.2026');
    expect(html).toContain(BALANCE_REQUEST);
    expect(html).toContain(BALANCE_SCOPE_NOTICE);
    expect(html).toBe(balanceEmailHtml(tresc));
  });
});
