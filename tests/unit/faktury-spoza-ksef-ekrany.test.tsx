import fs from 'fs';
import { renderToStaticMarkup } from 'react-dom/server';
import PDFDocument from 'pdfkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  rola: 'owner' as string,
  dostepne: true,
}));

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => {
        const query = { eq: () => query, maybeSingle: async () => ({ data: mocks.row, error: null }) };
        return query;
      },
    }),
  }),
}));
vi.mock('@/lib/supabase/page-context', () => ({ getPageContext: async () => ({ role: mocks.rola }) }));
vi.mock('@/lib/import/outside-ksef-wylacznik', () => ({ spozaKsefDostepne: async () => mocks.dostepne }));
vi.mock('@/app/actions/faktury-spoza-ksef', () => ({ dodajFakturaSpozaKsefAction: vi.fn(), removeOutsideKsefInvoiceAction: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import OutsideKsefPage from '@/app/(dashboard)/invoices/spoza-ksef/page';
import { StatusBadge } from '@/components/invoices/status-badge';
import { OutsideKsefForm } from '@/app/(dashboard)/invoices/spoza-ksef/_components/outside-ksef-form';
import {
  bruttoPozycji,
  PUSTA_POZYCJA,
  parseKwota,
  podpowiedzVat,
  sprawdzFormularz,
  type FormularzSpozaKsef,
} from '@/lib/import/outside-ksef-formularz';
import { SPOZA_KSEF_OPIS, SPOZA_KSEF_PDF_DOPISEK, jestFakturaSpozaKsef } from '@/lib/import/outside-ksef-teksty';
import { loadInvoiceForPdf } from '@/lib/pdf/invoice-data';
import { renderInvoicePdf } from '@/lib/pdf/invoice-renderer';

/**
 * Krok 1.6, część 2b, PR C: ekrany faktury spoza KSeF (D24): napis „Poza KSeF”
 * na liście, w szczegółach i w PDF, tekst z D24, formularz i bramka strony.
 */

const FORMULARZ: FormularzSpozaKsef = {
  number: 'FV/12/2026',
  issueDate: '2026-05-10',
  saleDate: '',
  buyerName: 'Nabywca Sp. z o.o.',
  buyerNip: '',
  lines: [{ ...PUSTA_POZYCJA, name: 'Usługa', net: '100,00' }],
};

beforeEach(() => {
  mocks.rola = 'owner';
  mocks.dostepne = true;
});
afterEach(() => vi.restoreAllMocks());

describe('formularz: liczby i schemat', () => {
  it('czyta kwoty z przecinkiem i spacjami, odrzuca tekst', () => {
    expect(parseKwota('1 234,50')).toBe(1234.5);
    expect(parseKwota('abc')).toBeNull();
    expect(parseKwota('')).toBeNull();
  });

  it('podpowiada VAT ze stawki, zero dla 0, zw i np, brutto w groszach', () => {
    expect(podpowiedzVat(100, '23')).toBe(23);
    expect(podpowiedzVat(33.33, '8')).toBe(2.67);
    expect(podpowiedzVat(100, 'zw')).toBe(0);
    expect(bruttoPozycji({ ...PUSTA_POZYCJA, net: '100', vatRate: '23' })).toBe(123);
    expect(bruttoPozycji({ ...PUSTA_POZYCJA, net: '', vatRate: '23' })).toBeNull();
  });

  it('poprawny formularz przechodzi schemat', () => {
    const w = sprawdzFormularz(FORMULARZ);
    expect(w.ok).toBe(true);
  });

  it('błąd pozycji niesie jej numer, a data spoza 2026 r. jest odrzucona', () => {
    const zlaPozycja = sprawdzFormularz({ ...FORMULARZ, lines: [{ ...PUSTA_POZYCJA, name: 'Usługa', net: '100', vatRate: 'zw' }] });
    expect(zlaPozycja).toEqual({ ok: false, blad: expect.stringContaining('Pozycja 1: ') });
    const zlaData = sprawdzFormularz({ ...FORMULARZ, issueDate: '2025-12-31' });
    expect(zlaData.ok).toBe(false);
  });

  it('formularz renderuje opis z D24', () => {
    const html = renderToStaticMarkup(<OutsideKsefForm opis={SPOZA_KSEF_OPIS} />);
    expect(html).toContain('FaktWay jej nie wystawia i nie wysyła do KSeF');
    expect(html).toContain('Faktura do paragonu');
  });
});

describe('napis „Poza KSeF”', () => {
  it('plakietka statusu pokazuje „Poza KSeF” zamiast „Zaakceptowana”', () => {
    const zwykla = renderToStaticMarkup(<StatusBadge status="accepted" />);
    const spoza = renderToStaticMarkup(<StatusBadge status="accepted" outsideKsef />);
    expect(zwykla).toContain('Zaakceptowana');
    expect(spoza).toContain('Poza KSeF');
    expect(spoza).not.toContain('Zaakceptowana');
  });

  it('rozpoznaje tylko origin outside_ksef', () => {
    expect(jestFakturaSpozaKsef('outside_ksef')).toBe(true);
    expect(jestFakturaSpozaKsef('ksef_import')).toBe(false);
    expect(jestFakturaSpozaKsef(null)).toBe(false);
  });

  it('PDF: wpis spoza KSeF dostaje dopisek, a pusta płatność nie przewraca wydruku', async () => {
    mocks.row = {
      id: 'inv-1', tenant_id: 'ten-1', internal_number: 'FV/12/2026', invoice_type: 'VAT',
      issue_date: '2026-05-10', sale_date: null, ksef_number: null, ksef_status: 'accepted', origin: 'outside_ksef',
      net_total: 100, vat_total: 23, gross_total: 123, notes: null, updated_at: null, pdf_storage_path: null, pdf_generated_at: null,
      seller_data: { nip: '1234567890', name: 'Sprzedawca', address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
      buyer_data: { name: 'Nabywca', noIdMarker: true, address: { countryCode: 'PL', addressLine1: ' ', addressLine2: ' ' } },
      payment_data: {},
      invoice_line_items: [{ ordinal: 1, name: 'Usługa', unit: 'szt.', quantity: 1, unit_price_net: 100, net_amount: 100, vat_rate: '23', vat_amount: 23, gross_amount: 123 }],
    };
    const data = await loadInvoiceForPdf('inv-1', 'ten-1');
    expect(data?.outsideKsef).toBe(true);
    const text = vi.spyOn(PDFDocument.prototype, 'text');
    await renderInvoicePdf(data!.invoice, { previewNotice: data!.outsideKsef ? SPOZA_KSEF_PDF_DOPISEK : null });
    expect(text.mock.calls.map((c) => String(c[0]))).toContain(SPOZA_KSEF_PDF_DOPISEK);
    // Faktura z KSeF (origin inny) nie dostaje dopisku.
    mocks.row = { ...mocks.row, origin: 'ksef_import', ksef_number: '1234567890-20260510-AAAAAA-AA' };
    expect((await loadInvoiceForPdf('inv-1', 'ten-1'))?.outsideKsef).toBe(false);
  });
});

describe('strona dopisywania: bramka', () => {
  it('wyłącznik wyłączony: komunikat z wyjściem, bez formularza', async () => {
    mocks.dostepne = false;
    const html = renderToStaticMarkup(await OutsideKsefPage());
    expect(html).toContain('niedostępne');
    expect(html).toContain('Wróć do faktur');
    expect(html).not.toContain('Dodaj do historii');
  });

  it('rola inna niż właściciel i administrator: komunikat, bez formularza', async () => {
    mocks.rola = 'accountant';
    const html = renderToStaticMarkup(await OutsideKsefPage());
    expect(html).toContain('właściciel albo administrator');
    expect(html).not.toContain('Dodaj do historii');
  });

  it('wyłącznik włączony i właściciel: formularz', async () => {
    const html = renderToStaticMarkup(await OutsideKsefPage());
    expect(html).toContain('Dodaj do historii');
  });
});

describe('pomoc (D24)', () => {
  it('artykuł zawiera tekst z D24 dosłownie', () => {
    const tresc = fs.readFileSync('content/help/faktury-spoza-ksef.mdx', 'utf8');
    expect(tresc).toContain(SPOZA_KSEF_OPIS);
    expect(tresc).toContain('Poza KSeF');
  });
});
