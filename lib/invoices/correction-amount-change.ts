import { roundToCents, toGrosze, vatFromGrossGrosze, vatFromNetCents } from '@/lib/xml/invoice-calculator';
import type { ZeroVatAmountChangeRate } from '@/types/invoice-types';

type AmountChange = {
  netDelta: number;
  vatDelta: number;
  grossDelta: number;
  /** Jawna stawka bez VAT z faktury pierwotnej (np I, np II, oo, zw). */
  vatRate?: ZeroVatAmountChangeRate;
  /** Stawka faktury w cenach brutto ustalona przez serwer (D6); kwoty już ją potwierdziły. */
  grossRate?: '23' | '8' | '5' | '0';
};
type Rate = '23' | '8' | '5' | '0' | ZeroVatAmountChangeRate;

/** Reject ambiguous or inconsistent deltas rather than guessing a legal VAT rate. */
export function resolveAmountChangeVatRate(change: AmountChange): Rate {
  const { netDelta, vatDelta, grossDelta } = change;
  if (![netDelta, vatDelta, grossDelta].every(Number.isFinite) || netDelta === 0 ||
      [netDelta, vatDelta, grossDelta].some((value) =>
        Math.abs(value - roundToCents(value)) > 1e-8) ||
      roundToCents(netDelta + vatDelta) !== roundToCents(grossDelta)) {
    throw new Error('Korekta kwotowa: niespójna kwota netto, VAT lub brutto.');
  }

  // Faktura w cenach brutto: stawkę ustalił serwer (`grossAmountChange`), kwoty ze wzoru od sumy brutto.
  if (change.grossRate !== undefined) return change.grossRate;

  // Stawka bez VAT nie wynika z kwot (VAT 0 = także „0 KR”) — przychodzi jawnie
  // z faktury pierwotnej i wymaga zerowego VAT w korekcie.
  if (change.vatRate !== undefined) {
    if (roundToCents(vatDelta) !== 0) {
      throw new Error(`Korekta kwotowa: stawka „${change.vatRate}” nie ma VAT — różnica VAT musi być 0.`);
    }
    return change.vatRate;
  }

  const rates = [
    ['23', 23], ['8', 8], ['5', 5], ['0', 0],
  ] as const;
  // Najpierw VAT od netto (art. 106e ust. 1 pkt 14), jak dotąd. Wzór od brutto (ust. 7
  // i 10: faktura za abonament) tylko, gdy żadna stawka nie pasuje od netto, żeby drobne
  // kwoty nie stały się niejednoznaczne. Czy faktura liczy od brutto, sprawdza serwer.
  // VAT od netto w groszach całkowitych (art. 106e ust. 11: od 0,5 grosza w górę), nie
  // `roundToCents(netto × stawka)` na liczbach zmiennoprzecinkowych (FZ-025).
  const fromNet = rates.filter(([, rate]) => toGrosze(vatFromNetCents(netDelta, rate)) === toGrosze(vatDelta));
  const matches = fromNet.length > 0
    ? fromNet
    : rates.filter(([label]) => vatFromGrossGrosze(toGrosze(grossDelta), Number(label)) === toGrosze(vatDelta));
  if (matches.length !== 1) {
    throw new Error('Korekta kwotowa: stawka VAT jest niejednoznaczna lub nieobsługiwana.');
  }
  return matches[0]![0];
}

/**
 * Stawka bez VAT dla korekty kwotowej z pozycji faktury pierwotnej: gdy WSZYSTKIE
 * pozycje mają tę samą stawkę `np` / `np_ii` / `oo` / `zw`, korekta ją przejmuje
 * (z kwot przy VAT 0 nie da się jej odróżnić od „0 KR”). Inaczej `undefined`
 * i stawkę wyznaczają kwoty (`resolveAmountChangeVatRate`). Wspólne dla
 * serwera (akcja korekty) i formularza.
 */
export function zeroVatRateFromParentLines(
  lines: ReadonlyArray<{ vatRate: string }>,
): ZeroVatAmountChangeRate | undefined {
  const rates = new Set(lines.map((l) => l.vatRate));
  if (rates.size !== 1) return undefined;
  const [rate] = [...rates];
  return rate === 'np' || rate === 'np_ii' || rate === 'oo' || rate === 'zw' ? rate : undefined;
}
