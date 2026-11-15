import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { nastepnyNumer, numer5, numerZPliku, POMIJANE_NUMERY } from '../../scripts/dev/nastepna-migracja.mjs';

/**
 * `scripts/dev/nastepna-migracja.mjs` zastępuje wiersz „następny wolny”
 * w rejestrze migracji (docs/koordynacja/CLAUDE-DO-CODEXA.md), który kłócił
 * każde dwa PR z migracją. Czysta funkcja i przebieg bez sieci.
 */

describe('nastepnyNumer', () => {
  it('daje największy użyty numer plus jeden', () => {
    expect(nastepnyNumer([1, 2, 206])).toBe(207);
    expect(nastepnyNumer([206, 5, 100])).toBe(207);
  });

  it('bierze największy numer z wielu źródeł (dysk, origin/main, otwarte PR)', () => {
    const dysk = [204, 206];
    const originMain = [205, 206];
    const otwartePr = [207, 209];
    expect(nastepnyNumer([...dysk, ...originMain, ...otwartePr])).toBe(210);
  });

  it('pomija 00200 (wyjątek z audytu bloku 1) także jako największy użyty', () => {
    expect(POMIJANE_NUMERY).toEqual([200]);
    expect(nastepnyNumer([198, 199, 200])).toBe(201);
    // Samo 00200 się nie liczy: nie zawyża numeru ...
    expect(nastepnyNumer([200])).toBe(1);
    // ... i nie jest nadawane, gdy poprzedni numer to 00199.
    expect(nastepnyNumer([199])).toBe(201);
  });

  it('własna lista pominiętych numerów zastępuje domyślną', () => {
    expect(nastepnyNumer([206, 207], { pomin: [207] })).toBe(208);
    expect(nastepnyNumer([206], { pomin: [207, 208] })).toBe(209);
    expect(nastepnyNumer([200], { pomin: [] })).toBe(201);
  });

  it('puste źródła i śmieci nie psują wyniku', () => {
    expect(nastepnyNumer([])).toBe(1);
    expect(nastepnyNumer([Number.NaN, -3, 0, 1.5, 12])).toBe(13);
  });

  it('wynik formatuje się do pięciu cyfr', () => {
    expect(numer5(nastepnyNumer([206]))).toBe('00207');
    expect(numer5(nastepnyNumer([99_999]))).toBe('100000');
  });
});

describe('numerZPliku', () => {
  it.each([
    ['00207_nowa_tabela.sql', 207],
    ['supabase/migrations/00206_ocr_jobs_no_client_update.sql', 206],
  ])('czyta numer z %s', (plik, numer) => {
    expect(numerZPliku(plik)).toBe(numer);
  });

  it.each(['README.md', '00207-zla-nazwa.sql', '0207_x.sql', '00207_Duze.sql', 'supabase/migrations/'])(
    'odrzuca %s',
    (plik) => {
      expect(numerZPliku(plik)).toBeNull();
    },
  );
});

describe('przebieg skryptu bez sieci', () => {
  it('wypisuje na stdout sam numer: największy na dysku plus jeden', () => {
    const numeryNaDysku = readdirSync('supabase/migrations')
      .map(numerZPliku)
      .filter((n): n is number => n !== null);
    const wynik = execFileSync('node', ['scripts/dev/nastepna-migracja.mjs', '--bez-sieci'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    expect(wynik).toBe(`${numer5(nastepnyNumer(numeryNaDysku))}\n`);
    expect(Number(wynik)).toBeGreaterThan(Math.max(...numeryNaDysku.filter((n) => !POMIJANE_NUMERY.includes(n))));
  });

  it('odmawia nieznanej opcji kodem 2 i nic nie wypisuje na stdout', () => {
    let kod: number | null = null;
    let stdout = '';
    try {
      stdout = execFileSync('node', ['scripts/dev/nastepna-migracja.mjs', '--co-innego'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (blad) {
      kod = (blad as { status: number }).status;
    }
    expect(kod).toBe(2);
    expect(stdout).toBe('');
  });
});
