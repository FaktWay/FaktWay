import { describe, expect, it } from 'vitest';

import { costInPln } from '@/lib/ocr/currency';
import { licznikOss } from '@/lib/oss/prog';

/**
 * FZ-019: OCR kosztu w walucie (`costInPln`) i próg OSS (`netPln` przez
 * `licznikOss`) przeliczają kwotę razy kurs przez `przeliczNaPln` na groszach
 * (połówka grosza od zera), a VAT z OCR to różnica w groszach. Brzegi po
 * drugim czytelniku: połówki w netto i brutto, korekta ujemna, kwota z trzema
 * miejscami z OCR, kurs nieskończony w OSS.
 */

const kurs = (mid: number) => ({ found: true as const, rate: { currency: 'EUR', mid, tableNo: '1/A/NBP/2026', effectiveDate: '2026-03-09' }, gapDays: 1 });
const sprzedaz = (net: number, rateToPln: number) => ({
  id: 'a', issueDate: '2026-03-10', net, kind: 'regular' as const, currency: 'EUR', rateToPln, countryCode: 'DE', isB2c: true, buyerNip: null, vatUe: null,
});

describe('FZ-019: przeliczenie waluty na grosze przez przeliczNaPln', () => {
  it('netto i brutto z połówką grosza w górę, VAT to różnica co do grosza', () => {
    // 0,75 × 4,3 = 3,225 → 3,23; 0,92 × 4,3 = 3,956 → 3,96; VAT 0,73.
    expect(costInPln({ currency: 'EUR', net_amount: 0.75, vat_amount: 0.17, gross_amount: 0.92 }, '2026-03-10', kurs(4.3))).toMatchObject({ kind: 'pln', net: 3.23, vat: 0.73, gross: 3.96 });
  });

  it('korekta ujemna: połówka od zera (-0,75 EUR po 4,3000 to -3,23 zł)', () => {
    expect(costInPln({ currency: 'EUR', net_amount: -0.75, vat_amount: 0, gross_amount: -0.75 }, '2026-03-10', kurs(4.3))).toMatchObject({ net: -3.23, vat: 0, gross: -3.23 });
  });

  it('kwota z trzema miejscami z OCR: najpierw grosz, potem kurs', () => {
    // 1,235 EUR → 1,24 EUR (toGrosze) → 1,24 × 4 = 4,96 zł.
    expect(costInPln({ currency: 'EUR', net_amount: 1.235, vat_amount: 0, gross_amount: 1.235 }, '2026-03-10', kurs(4))).toMatchObject({ net: 4.96, gross: 4.96 });
  });

  it('OSS: sprzedaż ujemna z połówką i kurs nieskończony (bez kursu, bez wyjątku)', () => {
    expect(licznikOss([sprzedaz(1, 4.3), sprzedaz(-0.75, 4.3)], { year: 2026 }).sum).toBe(1.07);
    expect(() => licznikOss([sprzedaz(1, Number.POSITIVE_INFINITY)], { year: 2026 })).not.toThrow();
    expect(licznikOss([sprzedaz(1, Number.POSITIVE_INFINITY)], { year: 2026 }).sum).toBe(0);
  });
});
