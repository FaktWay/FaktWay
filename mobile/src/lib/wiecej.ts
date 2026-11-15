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
