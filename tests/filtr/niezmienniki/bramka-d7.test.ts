import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * NZ-ROZL-04 (D7; żelazny filtr, uzupełnienie po spisie luk z 16.11): bez
 * podpisu księgowej pod sekcją parametrów żadna kwota modułu nie trafia do
 * klienta: ekran, push, mail, dzwonek, „Odłóż na podatek”, telefon. Test
 * strukturalny na drzewie składni:
 *
 * 1. silniki kwot modułu woła się tylko w `lib/ksiegowosc/`;
 * 2. silnik całego miesiąca (`tenMiesiac`) woła tylko `czytajTenMiesiac`;
 * 3. `czytajTenMiesiac` stosuje bramkę D7 (`brakujace`) i chowa kwoty
 *    pozycji bez podpisu (`bezKwot`);
 * 4. każdy kanał bierze kwoty z `czytajTenMiesiac` (wprost albo przez
 *    `czytajOdlozyc`).
 *
 * Bramkę na danych sprawdzają testy jednostkowe
 * (`tests/unit/ksiegowosc-ten-miesiac-dane.test.ts`, „bramka D7 dla każdej
 * pozycji”); ten test pilnuje, żeby nowy kanał nie liczył kwot obok niej.
 */

const KATALOG = process.cwd();
/** Silniki kwot modułu (podatek i składki zależne od parametrów z podpisem księgowej). */
const SILNIKI = ['tenMiesiac', 'ryczaltMiesiaca', 'skladkiSpoleczne', 'zdrowotnaRyczaltu', 'zdrowotnaOdDochodu', 'zaliczkiPit'];
const KANALY: ReadonlyArray<[string, string]> = [
  ['ekran „Ten miesiąc”', 'app/(dashboard)/reports/ten-miesiac/page.tsx'],
  ['przypomnienie o terminie: push, mail, dzwonek', 'lib/jobs/runners/ksiegowosc-terminy.ts'],
  ['push „rozliczenie wyliczone”', 'lib/jobs/runners/ksiegowosc-miesiac.ts'],
  ['„Odłóż na podatek”: szacunek', 'lib/ksiegowosc/odlozyc.ts'],
  ['„Odłóż na podatek”: karta Pulpitu', 'components/przeplywy/finora-1do1/sloty.tsx'],
  ['telefon (API M10b)', 'lib/api/mobile/ksiegowosc.ts'],
];

function pliki(katalog: string): string[] {
  const wynik: string[] = [];
  const idz = (k: string) => {
    for (const n of readdirSync(join(KATALOG, k))) {
      if (n === 'node_modules' || n.startsWith('.')) continue;
      const s = join(k, n);
      if (statSync(join(KATALOG, s)).isDirectory()) idz(s);
      else if (/\.(ts|tsx)$/.test(n) && !/\.test\.(ts|tsx)$/.test(n)) wynik.push(s);
    }
  };
  idz(katalog);
  return wynik;
}

/** Wywołania funkcji o podanych nazwach: [nazwa wywoływanej, nazwa funkcji najwyższego poziomu, w której stoi]. */
function wywolania(sciezka: string, nazwy: ReadonlySet<string>): Array<[string, string]> {
  const tekst = readFileSync(join(KATALOG, sciezka), 'utf8');
  if (![...nazwy].some((n) => tekst.includes(`${n}(`))) return [];
  const zrodlo = ts.createSourceFile(sciezka, tekst, ts.ScriptTarget.Latest, true, sciezka.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const wynik: Array<[string, string]> = [];
  const idz = (w: ts.Node, wFunkcji: string) => {
    let teraz = wFunkcji;
    if (ts.isFunctionDeclaration(w) && w.name && w.parent === zrodlo) teraz = w.name.text;
    if (ts.isVariableDeclaration(w) && ts.isIdentifier(w.name) && w.parent.parent.parent === zrodlo) teraz = w.name.text;
    if (ts.isCallExpression(w) && ts.isIdentifier(w.expression) && nazwy.has(w.expression.text)) wynik.push([w.expression.text, teraz]);
    ts.forEachChild(w, (d) => idz(d, teraz));
  };
  idz(zrodlo, '(moduł)');
  return wynik;
}

const KOD = [...pliki('lib'), ...pliki('app'), ...pliki('components')];
const wywolaniaSilnikow = KOD.flatMap((p) => wywolania(p, new Set(SILNIKI)).map(([s, f]) => ({ plik: p, silnik: s, funkcja: f })));

describe('NZ-ROZL-04: kwoty modułu tylko przez bramkę D7', () => {
  it('silniki kwot modułu woła się tylko w lib/ksiegowosc/', () => {
    expect(wywolaniaSilnikow.length).toBeGreaterThan(0);
    expect(wywolaniaSilnikow.filter((w) => !w.plik.startsWith('lib/ksiegowosc/')).map((w) => `${w.plik}#${w.funkcja} woła ${w.silnik}`)).toEqual([]);
  });

  it('silnik całego miesiąca woła tylko czytajTenMiesiac', () => {
    const wolajacy = wywolaniaSilnikow.filter((w) => w.silnik === 'tenMiesiac').map((w) => `${w.plik}#${w.funkcja}`);
    expect(wolajacy).toEqual(['lib/ksiegowosc/ten-miesiac-dane.ts#czytajTenMiesiac']);
  });

  it('czytajTenMiesiac stosuje bramkę D7 i chowa kwoty pozycji bez podpisu', () => {
    const w = wywolania('lib/ksiegowosc/ten-miesiac-dane.ts', new Set(['brakujace', 'bezKwot', 'tenMiesiac'])).filter(([, f]) => f === 'czytajTenMiesiac').map(([n]) => n);
    expect(new Set(w)).toEqual(new Set(['brakujace', 'bezKwot', 'tenMiesiac']));
  });

  it.each(KANALY)('%s (%s) bierze kwoty z czytajTenMiesiac', (_kanal, plik) => {
    expect(wywolania(plik, new Set(['czytajTenMiesiac', 'czytajOdlozyc'])).length).toBeGreaterThan(0);
  });
});
