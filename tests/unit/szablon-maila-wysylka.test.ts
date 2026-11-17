import { beforeEach, describe, expect, it, vi } from 'vitest';

const s = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('resend', () => ({ Resend: class { emails = { send: s.send }; } }));
vi.mock('@/lib/email/preferences', () => ({ canSendTo: async () => ({ ok: true }) }));

import { sendInvoiceEmail, type InvoiceEmailPayload } from '@/lib/email/send';

/**
 * Własny szablon maila z fakturą (plan kompletnej aplikacji, krok 2.8, R1/R2):
 * prawdziwy `sendInvoiceEmail`, atrapa tylko dostawcy poczty. Niezmienniki:
 * kwota, termin, tytuł przelewu i stopka o przetwarzaniu danych są w mailu
 * ZAWSZE, bez względu na szablon, a wartości pól to te same, które idą do
 * PDF. Bez szablonu mail jest taki jak dotąd.
 */

const payload = (o: Partial<InvoiceEmailPayload> = {}): InvoiceEmailPayload => ({
  to: 'nabywca@example.test',
  invoiceNumber: 'FV/12/11/2026',
  sellerName: 'Moja Firma sp. z o.o.',
  amountCaption: 'Kwota brutto',
  amountLabel: '1 230,00 PLN',
  dueDate: '2026-11-30',
  transferTitle: 'Faktura FV/12/11/2026 KSeF 123',
  pdf: Buffer.from('pdf'),
  pdfFilename: 'faktura.pdf',
  ...o,
});

const wyslane = () => s.send.mock.calls[0]![0] as { subject: string; html: string; attachments: Array<{ filename: string }> };

beforeEach(() => {
  s.send.mockReset().mockResolvedValue({ data: { id: 'm' }, error: null });
  vi.stubEnv('RESEND_API_KEY', 're_test_klucz');
  vi.stubEnv('RESEND_DEV_TO_OVERRIDE', '');
});

describe('mail z fakturą bez własnego szablonu', () => {
  it('temat i treść jak dotąd', async () => {
    await sendInvoiceEmail(payload());
    expect(wyslane().subject).toBe('Faktura FV/12/11/2026 od Moja Firma sp. z o.o.');
    expect(wyslane().html).toContain('W załączniku przesyłamy fakturę <strong>FV/12/11/2026</strong>');
    expect(wyslane().html).toContain('Termin płatności');
  });

  it('szablon null to to samo co brak', async () => {
    await sendInvoiceEmail(payload({ customTemplate: null }));
    expect(wyslane().html).toContain('W załączniku przesyłamy fakturę <strong>');
  });
});

describe('mail z własnym szablonem', () => {
  const szablon = { subject: 'Twoja faktura {numer} ({kwota})', body: 'Cześć!\n\nWysyłamy {numer} od {sprzedawca}. Zapłać do {termin}.' };

  it('temat i treść z pól, załącznik bez zmian', async () => {
    await sendInvoiceEmail(payload({ customTemplate: szablon }));
    const m = wyslane();
    expect(m.subject).toBe('Twoja faktura FV/12/11/2026 (1 230,00 PLN)');
    expect(m.html).toContain('<p>Cześć!</p>');
    expect(m.html).toContain('Wysyłamy FV/12/11/2026 od Moja Firma sp. z o.o.. Zapłać do 2026-11-30.');
    expect(m.html).not.toContain('W załączniku przesyłamy fakturę');
    expect(m.attachments).toEqual([expect.objectContaining({ filename: 'faktura.pdf' })]);
  });

  it('kwota, termin, tytuł przelewu i stopka zostają w mailu, choć szablon ich nie używa', async () => {
    await sendInvoiceEmail(payload({ customTemplate: { subject: 'Faktura', body: 'Pozdrawiamy' } }));
    const { html } = wyslane();
    expect(html).toContain('Kwota brutto');
    expect(html).toContain('1 230,00 PLN');
    expect(html).toContain('Termin płatności');
    expect(html).toContain('2026-11-30');
    expect(html).toContain('Tytuł przelewu');
    expect(html).toContain('Faktura FV/12/11/2026 KSeF 123');
    expect(html).toContain('za pośrednictwem serwisu FaktWay');
  });

  it('{kwota} to dokładnie kwota z PDF (przy ROZ do zapłaty po zaliczkach)', async () => {
    await sendInvoiceEmail(
      payload({ amountCaption: 'Do zapłaty (po zaliczkach)', amountLabel: '9840,00 PLN', customTemplate: { subject: 'Do zapłaty {kwota}', body: 'Kwota: {kwota}' } }),
    );
    expect(wyslane().subject).toBe('Do zapłaty 9840,00 PLN');
    expect(wyslane().html).toContain('Kwota: 9840,00 PLN');
  });

  it('HTML w szablonie i w nazwie sprzedawcy nie wykonuje się', async () => {
    await sendInvoiceEmail(payload({ sellerName: '<b>Firma</b>', customTemplate: { subject: 'x', body: '<script>x</script> {sprzedawca}' } }));
    expect(wyslane().html).not.toContain('<script>');
    expect(wyslane().html).not.toContain('<b>Firma</b>');
  });

  it('pusty temat po złożeniu wraca do domyślnego tematu (mail nie wyjdzie bez tematu)', async () => {
    await sendInvoiceEmail(payload({ transferTitle: null, customTemplate: { subject: '{tytul_przelewu}', body: 'x' } }));
    expect(wyslane().subject).toBe('Faktura FV/12/11/2026 od Moja Firma sp. z o.o.');
  });

  it('brak tytułu przelewu: wiersza w tabeli nie ma, jak dotąd', async () => {
    await sendInvoiceEmail(payload({ transferTitle: null, customTemplate: szablon }));
    expect(wyslane().html).not.toContain('Tytuł przelewu');
  });
});
