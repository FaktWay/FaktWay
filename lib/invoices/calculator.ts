/**
 * Kalkulatory dla scenariuszy faktur z `types/invoice-types.ts`.
 * Sumy pozycji delegujemy do `@/lib/xml/invoice-calculator` (VAT, zaokrąglenia FA).
 */

import type { InvoiceLineItem, VatRate } from '@/types/invoice';
import type {
  AdvanceInvoiceData,
  CorrectionInvoiceData,
  InvoiceLine,
} from '@/types/invoice-types';
import type { InvoiceTotals } from '@/lib/xml/invoice-calculator';
import {
  calculateInvoiceTotals as summarizePreparedLineItems,
  calculateLineItem,
  grossPricedLines,
  roundToCents,
} from '@/lib/xml/invoice-calculator';

type LineAmounts = Pick<InvoiceLineItem, 'netAmount' | 'vatAmount' | 'grossAmount'>;

/**
 * Kwoty pozycji: z zapisu faktury (`recordedAmounts`, stan przed korekty,
 * także pozycja liczona od brutto). Bez zapisu od ilości × ceny: netto, a przy
 * cenie brutto z serwera korekty (`unitPriceGross`, koperta bez kwot zapisu)
 * od brutto jak na fakturze.
 */
export function lineAmounts(line: InvoiceLine): LineAmounts {
  if (line.recordedAmounts) {
    const { netAmount, vatAmount, grossAmount } = line.recordedAmounts;
    return { netAmount, vatAmount, grossAmount };
  }
  return calculateLineItem(
    { quantity: line.quantity, unitPriceNet: line.unitPriceNet, vatRate: line.vatRate as VatRate },
    { unitPriceGross: line.unitPriceGross },
  );
}

/** Kwoty pozycji z minusem (anulowanie); `+ 0`: bez zera ze znakiem. */
export function negatedAmounts(amounts: LineAmounts): LineAmounts {
  return { netAmount: -amounts.netAmount + 0, vatAmount: -amounts.vatAmount + 0, grossAmount: -amounts.grossAmount + 0 };
}

/** Ta sama pozycja w obu stanach korekty: jak `sameLine` w `lib/ksef/fa3-correction-generator.ts`. */
function sameCorrectionLine(a: InvoiceLine, b: InvoiceLine): boolean {
  return a.name === b.name && a.unit === b.unit && a.quantity === b.quantity &&
    a.unitPriceNet === b.unitPriceNet && a.unitPriceGross === b.unitPriceGross && a.vatRate === b.vatRate;
}

/**
 * Korekta faktury w cenach brutto (D6, RP-FA-BRUTTO-01 i RP-FA-KOR-03): stan po
 * ma ceny brutto każdej pozycji, a stan przed też (z faktury). Faktura
 * za abonament ma cenę brutto tylko w stanie przed (znak metody dla odmowy), więc
 * jej korekta „przed/po” nie jest w cenach brutto.
 */
function isGrossPricedCorrection(before: readonly InvoiceLine[], after: readonly InvoiceLine[]): boolean {
  return after.length > 0 && after.every((l) => l.unitPriceGross !== undefined) &&
    before.every((l) => l.unitPriceGross !== undefined);
}

/**
 * Kwoty stanów korekty „przed/po”. Stan przed: kwoty pozycji z zapisu faktury
 * korygowanej (`lineAmounts`), nie liczone od nowa. Stan po: pozycja bez zmian
 * (ta sama nazwa, j.m., ilość, cena netto i stawka co pozycja „przed”, parowana
 * jak pozycje bez zmian w `correctionLinePairs`) ma kwoty tej pozycji „przed”,
 * więc nie robi różnicy; pozycja zmieniona albo dopisana liczy się od ilości ×
 * ceny netto. Kwoty przysłane w pozycji „po” się nie liczą. Jedno liczenie dla
 * sum korekty, jej pozycji w bazie, pliku FA(3) KOR, JPK i podglądu w formularzu.
 */
export function correctionStateAmounts(
  before: readonly InvoiceLine[],
  after: readonly InvoiceLine[],
): { before: LineAmounts[]; after: LineAmounts[] } {
  const beforeAmounts = before.map(lineAmounts);
  const unchanged: Array<LineAmounts | undefined> = after.map(() => undefined);
  const matchedBefore = new Set<number>();
  before.forEach((b, bi) => {
    const ai = after.findIndex((a, i) => unchanged[i] === undefined && sameCorrectionLine(b, a));
    if (ai !== -1) {
      unchanged[ai] = beforeAmounts[bi];
      matchedBefore.add(bi);
    }
  });
  if (isGrossPricedCorrection(before, after)) {
    return { before: beforeAmounts, after: grossStateAfter(before, after, unchanged, matchedBefore) };
  }
  return {
    before: beforeAmounts,
    after: after.map((a, i) =>
      unchanged[i] ?? calculateLineItem({ quantity: a.quantity, unitPriceNet: a.unitPriceNet, vatRate: a.vatRate as VatRate }),
    ),
  };
}

/**
 * Stan po korekty faktury w cenach brutto (decyzja D6 z 25.11.2026, art. 106e
 * ust. 7 i 11 ustawy o VAT): w każdej stawce, której korekta dotyka, podatek
 * stanu po to wzór od sumy brutto wszystkich pozycji „po” tej stawki,
 * KP = WB × SP / (100 + SP) (`grossPricedLines`, ten sam podział na pozycje co
 * na fakturze), więc faktura i jej korekty zgadzają się z nową fakturą w cenach
 * brutto z pozycjami po korekcie. Różnica po stawkach to stan po minus stan
 * przed z zapisu (art. 106j ust. 2 pkt 5), nie podatek od samej różnicy brutto.
 * Stawka bez zmian (każda pozycja „po” ma swoją bez zmian „przed” i żadna
 * „przed” nie zniknęła) zostaje z kwot zapisu, żeby nie wykazać różnicy tam,
 * gdzie nic nie korygowano.
 */
function grossStateAfter(
  before: readonly InvoiceLine[],
  after: readonly InvoiceLine[],
  unchanged: ReadonlyArray<LineAmounts | undefined>,
  matchedBefore: ReadonlySet<number>,
): LineAmounts[] {
  const result: LineAmounts[] = after.map((_, i) => unchanged[i] ?? { netAmount: 0, vatAmount: 0, grossAmount: 0 });
  for (const rate of new Set(after.map((l) => l.vatRate))) {
    const afterIdx = after.flatMap((l, i) => (l.vatRate === rate ? [i] : []));
    const beforeIdx = before.flatMap((l, i) => (l.vatRate === rate ? [i] : []));
    if (afterIdx.every((i) => unchanged[i] !== undefined) && beforeIdx.every((i) => matchedBefore.has(i))) continue;
    const computed = grossPricedLines(afterIdx.map((i) => ({
      ordinal: i + 1,
      name: after[i]!.name,
      unit: after[i]!.unit,
      quantity: after[i]!.quantity,
      unitPriceNet: 0,
      unitPriceGross: after[i]!.unitPriceGross,
      vatRate: rate as VatRate,
    })));
    afterIdx.forEach((i, k) => {
      const { netAmount, vatAmount, grossAmount } = computed[k]!;
      result[i] = { netAmount, vatAmount, grossAmount };
    });
  }
  return result;
}

function domainLineToPrepared(line: InvoiceLine, ordinal: number): InvoiceLineItem {
  return {
    ordinal,
    name: line.name,
    unit: line.unit,
    quantity: line.quantity,
    unitPriceNet: line.unitPriceNet,
    vatRate: line.vatRate as VatRate,
    ...lineAmounts(line),
  };
}

/** Sumuje pozycje w kształcie domenowym (bez pól wyliczonych w linii). */
export function calculateInvoiceTotals(lines: InvoiceLine[]): InvoiceTotals {
  const prepared = lines.map((line, idx) => domainLineToPrepared(line, idx + 1));
  return summarizePreparedLineItems(prepared);
}

// ============================================================================
// Kalkulacja dla faktury KORYGUJĄCEJ
// ============================================================================

export interface CorrectionTotals {
  netBefore: number;
  vatBefore: number;
  grossBefore: number;

  netAfter: number;
  vatAfter: number;
  grossAfter: number;

  netDelta: number;
  vatDelta: number;
  grossDelta: number;
}

export function calculateCorrectionTotals(data: CorrectionInvoiceData): CorrectionTotals {
  if (data.correctionType === 'before_after') {
    const states = correctionStateAmounts(data.linesBefore ?? [], data.linesAfter ?? []);
    const before = summarizePreparedLineItems(states.before);
    const after = summarizePreparedLineItems(states.after);

    return {
      netBefore: before.netTotal,
      vatBefore: before.vatTotal,
      grossBefore: before.grossTotal,
      netAfter: after.netTotal,
      vatAfter: after.vatTotal,
      grossAfter: after.grossTotal,
      netDelta: after.netTotal - before.netTotal,
      vatDelta: after.vatTotal - before.vatTotal,
      grossDelta: after.grossTotal - before.grossTotal,
    };
  }

  if (data.correctionType === 'amount_change' && data.amountChange) {
    return {
      netBefore: 0,
      vatBefore: 0,
      grossBefore: 0,
      netAfter: 0,
      vatAfter: 0,
      grossAfter: 0,
      netDelta: data.amountChange.netDelta,
      vatDelta: data.amountChange.vatDelta,
      grossDelta: data.amountChange.grossDelta,
    };
  }

  if (data.correctionType === 'cancellation') {
    // Stan przed z zapisu faktury korygowanej (`lineAmounts`).
    const before = summarizePreparedLineItems((data.linesBefore ?? []).map(lineAmounts));

    return {
      netBefore: before.netTotal,
      vatBefore: before.vatTotal,
      grossBefore: before.grossTotal,
      netAfter: 0,
      vatAfter: 0,
      grossAfter: 0,
      netDelta: -before.netTotal,
      vatDelta: -before.vatTotal,
      grossDelta: -before.grossTotal,
    };
  }

  return {
    netBefore: 0,
    vatBefore: 0,
    grossBefore: 0,
    netAfter: 0,
    vatAfter: 0,
    grossAfter: 0,
    netDelta: 0,
    vatDelta: 0,
    grossDelta: 0,
  };
}

// ============================================================================
// Kalkulacja dla faktury ZALICZKOWEJ
// ============================================================================

export interface AdvanceTotals {
  advanceNet: number;
  advanceVat: number;
  advanceGross: number;
  vatRate: string;
  remainingAmount: number;
}

export function calculateAdvanceTotals(
  data: Pick<AdvanceInvoiceData, 'vatRate' | 'advanceAmount' | 'totalContractAmount'>,
): AdvanceTotals {
  const vatRateNum = parseFloat(data.vatRate);
  const vatMultiplier = vatRateNum / 100;

  const advanceNet = round2(data.advanceAmount / (1 + vatMultiplier));
  const advanceVat = round2(data.advanceAmount - advanceNet);

  return {
    advanceNet,
    advanceVat,
    advanceGross: data.advanceAmount,
    vatRate: data.vatRate,
    remainingAmount: round2(data.totalContractAmount - data.advanceAmount),
  };
}

// ============================================================================
// Kalkulacja dla faktury FINALNEJ (rozliczającej zaliczki)
// ============================================================================

export interface FinalInvoiceTotals {
  totalNet: number;
  totalVat: number;
  totalGross: number;
  totalAdvances: number;
  amountDue: number;
}

export function calculateFinalInvoiceTotals(
  lines: InvoiceLine[],
  totalAdvances: number
): FinalInvoiceTotals {
  const totals = calculateInvoiceTotals(lines);

  return {
    totalNet: totals.netTotal,
    totalVat: totals.vatTotal,
    totalGross: totals.grossTotal,
    totalAdvances: round2(totalAdvances),
    amountDue: round2(totals.grossTotal - totalAdvances),
  };
}

// ============================================================================
// Helper - zaokrąglanie do 2 miejsc (spójne z FA / invoice-calculator)
// ============================================================================

function round2(n: number): number {
  return roundToCents(n);
}
