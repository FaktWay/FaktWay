#!/usr/bin/env node
// Następny wolny numer migracji (zastępuje wiersz „następny wolny” z rejestru
// w docs/koordynacja/CLAUDE-DO-CODEXA.md, który kłócił każde dwa PR z migracją).
//
//   node scripts/dev/nastepna-migracja.mjs               # np. 00207
//   node scripts/dev/nastepna-migracja.mjs --bez-sieci   # tylko dysk i origin/main, bez fetch i gh
//
// Numer = największy użyty + 1. Użyte numery to pliki
// `supabase/migrations/NNNNN_*.sql`: w katalogu roboczym, na `origin/main`
// (po `git fetch origin main`) i w OTWARTYCH PR (`gh pr list`). Wyjątek
// z audytu bloku 1, 00200, jest pomijany. Na stdout trafia tylko numer
// (5 cyfr), reszta na stderr, więc działa `NR=$(node scripts/dev/nastepna-migracja.mjs)`.
//
// Skrypt niczego nie rezerwuje. Kolizję dwóch PR rozstrzyga kolejka scalania
// (tests/unit/migracje-rejestr.test.ts na commicie grupy): przegrany PR po
// `git merge origin/main` uruchamia skrypt jeszcze raz i zmienia numer pliku.
// Brak `gh` albo sieci to ostrzeżenie, nie błąd: numer liczy się wtedy z dysku
// i `origin/main` i mógł już zająć go otwarty PR.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Numery, które nie liczą się do maksimum i nie są nadawane (00200: wyjątek z audytu bloku 1). */
export const POMIJANE_NUMERY = [200];

const KATALOG = 'supabase/migrations';
const WZORZEC = /^(\d{5})_[a-z0-9_]+\.sql$/;

/** Numer z nazwy pliku albo ścieżki (`supabase/migrations/00207_x.sql` → 207), `null` dla innych plików. */
export function numerZPliku(sciezka) {
  const nazwa = String(sciezka).split('/').pop() ?? '';
  const trafienie = WZORZEC.exec(nazwa);
  return trafienie ? Number(trafienie[1]) : null;
}

/** Numer jako 5 cyfr z zerami: 207 → „00207”. */
export function numer5(n) {
  return String(n).padStart(5, '0');
}

/**
 * @param {Iterable<number>} numery użyte numery (z dowolnych źródeł)
 * @param {{ pomin?: number[] }} [opcje] numery do pominięcia (domyślnie wyjątek 00200)
 * @returns {number} największy użyty + 1, nigdy numer z `pomin`
 */
export function nastepnyNumer(numery, { pomin = POMIJANE_NUMERY } = {}) {
  const pominiete = new Set(pomin.map(Number));
  let max = 0;
  for (const n of numery) {
    if (Number.isInteger(n) && n > 0 && !pominiete.has(n) && n > max) max = n;
  }
  let kandydat = max + 1;
  while (pominiete.has(kandydat)) kandydat += 1;
  return kandydat;
}

function polecenie(program, argumenty, opcje = {}) {
  return execFileSync(program, argumenty, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    ...opcje,
  });
}

/** Największy numer z listy (bez pomijanych) albo `null`. */
function maks(numery) {
  let max = null;
  for (const n of numery) {
    if (!POMIJANE_NUMERY.includes(n) && (max === null || n > max)) max = n;
  }
  return max;
}

/** Numery z katalogu roboczego (zawsze dostępne). */
function zDysku(korzen) {
  const katalog = join(korzen, KATALOG);
  if (!existsSync(katalog)) throw new Error(`Brak katalogu ${KATALOG} w ${korzen}.`);
  return readdirSync(katalog).map(numerZPliku).filter((n) => n !== null);
}

/** Numery z `origin/main` (po `git fetch`); `null` i ostrzeżenie, gdy się nie da. */
function zOriginMain(korzen, ostrzezenia, { fetch }) {
  try {
    if (fetch) {
      try {
        polecenie('git', ['fetch', '--quiet', 'origin', 'main'], { cwd: korzen, timeout: 20_000 });
      } catch {
        ostrzezenia.push('git fetch origin main nie powiódł się: origin/main może być nieaktualne.');
      }
    }
    const lista = polecenie('git', ['ls-tree', '--name-only', 'origin/main', `${KATALOG}/`], { cwd: korzen });
    return lista.split('\n').map(numerZPliku).filter((n) => n !== null);
  } catch {
    ostrzezenia.push('Nie odczytałem origin/main (git ls-tree): liczę tylko z dysku.');
    return null;
  }
}

/** Numery z plików migracji w otwartych PR: `[{ numer, pr }]`; `null` i ostrzeżenie bez `gh`. */
function zOtwartychPr(korzen, ostrzezenia) {
  try {
    const json = polecenie('gh', ['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,files'], { cwd: korzen });
    const wynik = [];
    for (const pr of JSON.parse(json)) {
      for (const plik of pr.files ?? []) {
        const n = String(plik.path ?? '').startsWith(`${KATALOG}/`) ? numerZPliku(plik.path) : null;
        if (n !== null) wynik.push({ numer: n, pr: pr.number });
      }
    }
    return wynik;
  } catch {
    ostrzezenia.push('Brak gh albo sieci: nie sprawdziłem otwartych PR, numer mógł już zająć jeden z nich.');
    return null;
  }
}

export function main(argv = process.argv.slice(2)) {
  const bezSieci = argv.includes('--bez-sieci');
  const nieznane = argv.filter((a) => a !== '--bez-sieci');
  if (nieznane.length > 0) {
    console.error(`Nieznana opcja: ${nieznane.join(' ')}. Użycie: node scripts/dev/nastepna-migracja.mjs [--bez-sieci]`);
    return 2;
  }

  const korzen = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const ostrzezenia = [];
  let dysk;
  try {
    dysk = zDysku(korzen);
  } catch (blad) {
    console.error(blad.message);
    return 1;
  }
  const origin = zOriginMain(korzen, ostrzezenia, { fetch: !bezSieci });
  const prs = bezSieci ? null : zOtwartychPr(korzen, ostrzezenia);

  const numery = [...dysk, ...(origin ?? []), ...(prs ?? []).map((p) => p.numer)];
  const nastepny = nastepnyNumer(numery);

  const opisy = [`dysk ${numer5(maks(dysk) ?? 0)}`];
  if (origin) opisy.push(`origin/main ${numer5(maks(origin) ?? 0)}`);
  if (prs) {
    const najwyzszy = prs.filter((p) => !POMIJANE_NUMERY.includes(p.numer)).sort((a, b) => b.numer - a.numer)[0];
    opisy.push(najwyzszy ? `otwarte PR ${numer5(najwyzszy.numer)} (#${najwyzszy.pr})` : 'otwarte PR: brak migracji');
  }
  console.error(`Największe użyte numery: ${opisy.join(', ')}.`);
  for (const tekst of ostrzezenia) console.error(`Uwaga: ${tekst}`);
  console.error('Numer nie jest zarezerwowany: nadaj go plikowi od razu. Kolizję rozstrzyga kolejka scalania (test unikalności).');
  console.log(numer5(nastepny));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main();
}
