/**
 * Cena jednostkowa brutto pozycji (FA(3) `P_9B`, art. 106e ust. 8 ustawy o VAT)
 * z dokumentu faktury, po numerze pozycji. Pozycja w cenach brutto ma w bazie
 * pustą cenę netto (`invoice_line_items.unit_price_net` NULL), a cena brutto
 * leży w dokumencie: w pliku importu (`fa3_data.ksefLineFields[].P_9B`, F12-E4)
 * albo w fakturze FaktWay w cenach brutto (`fa3_data.pricesGross`,
 * `fa3_data.lines[].unitPriceGross`, plan cen brutto). PDF, szczegóły faktury
 * i strona dla nabywcy pokazują ją jako „… brutto”, jak plik.
 */
export function documentGrossPrices(
  fa3: { pricesGross?: unknown; lines?: unknown; ksefLineFields?: unknown } | null | undefined,
): Map<number, number> {
  const prices = new Map<number, number>();
  const read = (rows: unknown, key: 'P_9B' | 'unitPriceGross') => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const { ordinal } = row as { ordinal?: unknown };
      const price = (row as Record<string, unknown>)[key];
      if (typeof ordinal === 'number' && typeof price === 'number' && Number.isFinite(price) && !prices.has(ordinal)) {
        prices.set(ordinal, price);
      }
    }
  };
  read(fa3?.ksefLineFields, 'P_9B');
  if (fa3?.pricesGross === true) read(fa3.lines, 'unitPriceGross');
  return prices;
}
