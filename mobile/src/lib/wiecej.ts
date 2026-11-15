/**
 * Pomocnicze dla ekranów Więcej na prawdziwym koncie (M10e), bez React Native.
 */

const DZIEN_WARSZAWA = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Znacznik czasu z bazy (np. `2026-11-30T23:30:00Z`) jako dzień RRRR-MM-DD w Polsce; `null` bez wartości. */
export function dzienZnacznika(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : DZIEN_WARSZAWA.format(d);
}

/** Odmiana po liczbie: 1 wpis, 2 wpisy, 5 wpisów (jak `plural` strony). */
export function odmiana(n: number, formy: [jeden: string, kilka: string, wiele: string]): string {
  if (n === 1) return `1 ${formy[0]}`;
  const j = n % 10;
  const d = n % 100;
  return `${n.toLocaleString('pl-PL')} ${j >= 2 && j <= 4 && (d < 12 || d > 14) ? formy[1] : formy[2]}`;
}
