import { weekdayFromMonday } from './months';

/**
 * Kalendarz dni (Finora „Daily Spend”, plan P10/P11). Moduł bez ciężkich
 * importów — używa go komponent kliencki z podpowiedziami.
 */

export interface HeatmapDay {
  /** RRRR-MM-DD */
  date: string;
  amount: number;
}

/**
 * Kolumny tygodni kalendarza: każda ma 7 miejsc od poniedziałku do niedzieli
 * (polski tydzień; Finora zaczyna od niedzieli), `null` = dzień poza oknem.
 */
export function heatmapWeeks(days: readonly HeatmapDay[]): (HeatmapDay | null)[][] {
  if (days.length === 0) return [];
  const first = weekdayFromMonday(days[0]!.date);
  const weekCount = Math.ceil((first + days.length) / 7);
  const weeks: (HeatmapDay | null)[][] = Array.from({ length: weekCount }, () =>
    Array<HeatmapDay | null>(7).fill(null));
  days.forEach((day, index) => {
    const position = first + index;
    weeks[Math.floor(position / 7)]![position % 7] = day;
  });
  return weeks;
}

/**
 * Poziom natężenia 0 do 4 według kwantyla wśród dni z kwotą > 0, 1:1
 * z Finorą (pojedynczy rekordowy dzień nie wygasza reszty). Dzień z kwotą
 * ≤ 0 (brak albo korekta in minus) to 0. Strona (`heatmapIntensityClass`)
 * i kalendarz w aplikacji na telefon (M10e).
 */
export function heatmapIntensityLevel(amount: number, sortedPositiveAmounts: readonly number[]): 0 | 1 | 2 | 3 | 4 {
  if (amount <= 0 || sortedPositiveAmounts.length === 0) return 0;
  const rank = sortedPositiveAmounts.findIndex((value) => value >= amount) / sortedPositiveAmounts.length;
  if (rank >= 0.75) return 4;
  if (rank >= 0.5) return 3;
  if (rank >= 0.25) return 2;
  return 1;
}

const INTENSITY_CLASS = ['bg-muted', 'bg-chart-1/25', 'bg-chart-1/50', 'bg-chart-1/75', 'bg-chart-1'] as const;

/** Klasa koloru komórki kalendarza strony według `heatmapIntensityLevel`. */
export function heatmapIntensityClass(amount: number, sortedPositiveAmounts: readonly number[]): string {
  return INTENSITY_CLASS[heatmapIntensityLevel(amount, sortedPositiveAmounts)];
}
