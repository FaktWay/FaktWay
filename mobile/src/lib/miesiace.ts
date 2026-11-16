/**
 * Miesiące na samych napisach RRRR-MM, bez zegara telefonu (M10d). Bez React
 * Native: czyta go test strony (`tests/unit/mobile-api-ksiegowosc-vat.test.ts`).
 */

/** Miesiące RRRR-MM od `doMiesiaca` wstecz do `od` (na samych napisach, bez zegara telefonu). */
export function miesiaceWstecz(od: string, doMiesiaca: string): string[] {
  const wynik: string[] = [];
  let [rok, mies] = doMiesiaca.split('-').map(Number) as [number, number];
  for (let m = doMiesiaca; m >= od && wynik.length < 120; ) {
    wynik.push(m);
    mies -= 1;
    if (mies === 0) {
      mies = 12;
      rok -= 1;
    }
    m = `${rok}-${String(mies).padStart(2, '0')}`;
  }
  return wynik;
}
