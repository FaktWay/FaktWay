import { describe, expect, it } from 'vitest';
import {
  OUTSIDE_KSEF_REFUSAL_MESSAGE,
  OUTSIDE_KSEF_REFUSED_KINDS,
  outsideKsefInvoiceSchema,
  outsideKsefRefusal,
} from '@/lib/import/outside-ksef-schema';

const base = {
  number: 'FV/1/2026',
  issueDate: '2026-06-15',
  buyerName: 'Firma Testowa Sp. z o.o.',
  currency: 'PLN',
  lines: [{ name: 'Usługa', netAmount: 100, vatRate: '23', vatAmount: 23, grossAmount: 123 }],
};

describe('outsideKsefInvoiceSchema (D21, D22)', () => {
  it('przyjmuje fakturę w PLN ze stawką 23 i GTU', () => {
    const r = outsideKsefInvoiceSchema.safeParse({ ...base, lines: [{ ...base.lines[0], gtuCode: 'GTU_06', tp: true }] });
    expect(r.success).toBe(true);
  });
  it('data wystawienia tylko w 2026 r., data sprzedaży może być wcześniejsza', () => {
    expect(outsideKsefInvoiceSchema.safeParse({ ...base, issueDate: '2025-12-31' }).success).toBe(false);
    expect(outsideKsefInvoiceSchema.safeParse({ ...base, issueDate: '2027-01-01' }).success).toBe(false);
    expect(outsideKsefInvoiceSchema.safeParse({ ...base, issueDate: '2026-01-01', saleDate: '2025-12-20' }).success).toBe(true);
    expect(outsideKsefInvoiceSchema.safeParse({ ...base, issueDate: '2026-02-30' }).success).toBe(false);
  });
  it('odmawia waluty innej niż PLN', () => {
    expect(outsideKsefInvoiceSchema.safeParse({ ...base, currency: 'EUR' }).success).toBe(false);
  });
  it('odmawia stawki oo i nieznanej', () => {
    for (const vatRate of ['oo', 'np_ii', '7']) {
      expect(outsideKsefInvoiceSchema.safeParse({ ...base, lines: [{ ...base.lines[0], vatRate }] }).success).toBe(false);
    }
  });
  it('zw wymaga podstawy zwolnienia i zerowego VAT', () => {
    const zw = { name: 'Usługa', netAmount: 100, vatRate: 'zw', vatAmount: 0, grossAmount: 100 };
    expect(outsideKsefInvoiceSchema.safeParse({ ...base, lines: [zw] }).success).toBe(false);
    expect(outsideKsefInvoiceSchema.safeParse({ ...base, lines: [{ ...zw, exemptionBasis: 'art. 43 ust. 1 pkt 37' }] }).success).toBe(true);
    expect(outsideKsefInvoiceSchema.safeParse({ ...base, lines: [{ ...zw, exemptionBasis: 'x', vatAmount: 5, grossAmount: 105 }] }).success).toBe(false);
  });
  it('pilnuje kwot: brutto = netto + VAT i VAT zgodny ze stawką', () => {
    expect(outsideKsefInvoiceSchema.safeParse({ ...base, lines: [{ ...base.lines[0], grossAmount: 124 }] }).success).toBe(false);
    expect(outsideKsefInvoiceSchema.safeParse({ ...base, lines: [{ ...base.lines[0], vatAmount: 20, grossAmount: 120 }] }).success).toBe(false);
    expect(outsideKsefInvoiceSchema.safeParse({ ...base, lines: [{ name: 'x', netAmount: 0.05, vatRate: '23', vatAmount: 0.01, grossAmount: 0.06 }] }).success).toBe(true);
  });
  it('wymaga numeru, nabywcy i pozycji', () => {
    expect(outsideKsefInvoiceSchema.safeParse({ ...base, number: ' ' }).success).toBe(false);
    expect(outsideKsefInvoiceSchema.safeParse({ ...base, buyerName: '' }).success).toBe(false);
    expect(outsideKsefInvoiceSchema.safeParse({ ...base, lines: [] }).success).toBe(false);
  });
});

describe('odmowy z wyjściem (D22)', () => {
  it('każdy wymieniony rodzaj dostaje komunikat z wyjściem', () => {
    for (const kind of OUTSIDE_KSEF_REFUSED_KINDS) expect(outsideKsefRefusal(kind)).toBe(OUTSIDE_KSEF_REFUSAL_MESSAGE);
    expect(outsideKsefRefusal('faktura_vat')).toBeNull();
  });
});
