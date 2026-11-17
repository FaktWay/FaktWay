import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import fc from 'fast-check';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { przeliczNaPln } from '@/lib/ksiegowosc/ewidencja';
import { costInPln } from '@/lib/ocr/currency';
import { licznikOss } from '@/lib/oss/prog';

import { opcje } from '../generatory/ustawienia';

/**
 * NZ-KURS-03 (żelazny filtr, uzupełnienie po spisie luk z 16.11): przeliczenie
 * kwota razy kurs do groszy jedną funkcją, bez błędu liczb zmiennoprzecinkowych.
 * Ta funkcja to `przeliczNaPln` (`lib/ksiegowosc/ewidencja.ts`): grosze waluty
 * razy kurs średni NBP, połówka grosza od zera, iloczyn na BigInt.
 *
 * 1. Wzorzec na liczbach całkowitych z zapisu dziesiętnego kursu: `przeliczNaPln`
 *    daje to samo dla kursów z 4 i 6 miejscami po przecinku (API NBP podaje kurs
 *    przeliczony na jedną jednostkę: tabela A za 1 jednostkę ma 4 miejsca, za
 *    100 jednostek 6), także w połowie grosza i dla kwot ujemnych (korekty).
 * 2. Kurs z 8 miejscami (IDR, w tabeli A za 10 000 jednostek): `przeliczNaPln`
 *    skaluje kurs przez 10^6 i gubi dwa ostatnie miejsca: FZ-020.
 * 3. Każde mnożenie przez kurs w `lib/`, `app/` i `components/` stoi
 *    w `przeliczNaPln`. Dziś poza nią liczą `costInPln` (OCR kosztu w walucie,
 *    kwoty idą do KPiR) i `netPln` (próg OSS), na liczbach zmiennoprzecinkowych
 *    z `roundToCents`: 0,75 EUR po 4,3000 to 3,225 zł, czyli 3,23 zł, a obie
 *    dają 3,22 zł. FZ-019.
 */

/** Wzorzec: grosze razy kurs z zapisu dziesiętnego, połówka grosza od zera, na BigInt. */
function wzorzec(kwotaGr: number, kurs: string): number {
  const [calk, ulamek = ''] = kurs.split('.');
  const skala = BigInt(10) ** BigInt(ulamek.length);
  const iloczyn = BigInt(Math.abs(kwotaGr)) * BigInt(`${calk}${ulamek}`);
  const grosze = Number((BigInt(2) * iloczyn + skala) / (BigInt(2) * skala));
  return kwotaGr < 0 ? -grosze : grosze;
}

/** Kurs jako zapis dziesiętny z `miejsca` miejscami po przecinku, od najmniejszego dodatniego do 99,99…. */
const kurs = (miejsca: number) =>
  fc.integer({ min: 1, max: 100 * 10 ** miejsca - 1 }).map((n) => {
    const s = String(n).padStart(miejsca + 1, '0');
    return `${s.slice(0, -miejsca)}.${s.slice(-miejsca)}`;
  });
/** Do miliarda złotych w groszach, w obie strony (korekty). */
const KWOTA = fc.integer({ min: -100_000_000_000, max: 100_000_000_000 });

/** Połowa grosza: [grosze waluty, kurs, grosze po przeliczeniu]. */
const POLOWKI: Array<[number, string, number]> = [
  [75, '4.3000', 323], // 3,225 zł
  [115, '4.3000', 495], // 4,945 zł
  [-115, '4.3000', -495],
  [201, '0.5000', 101], // 1,005 zł
  [100, '0.005000', 1], // 0,005 zł przy kursie za 100 jednostek
];

describe('NZ-KURS-03: kwota razy kurs do groszy jedną funkcją, bez błędu float', () => {
  it.each(POLOWKI)('%i gr po %s: %i gr (połowa grosza od zera)', (kwotaGr, k, oczekiwane) => {
    expect(wzorzec(kwotaGr, k)).toBe(oczekiwane);
    expect(przeliczNaPln(kwotaGr, Number(k))).toBe(oczekiwane);
  });

  it.each([4, 6])('losowa kwota i kurs z %i miejscami po przecinku: jak wzorzec na liczbach całkowitych', (miejsca) => {
    fc.assert(fc.property(KWOTA, kurs(miejsca), (kwotaGr, k) => przeliczNaPln(kwotaGr, Number(k)) === wzorzec(kwotaGr, k)), opcje());
  });

  it.fails('FZ-020: kurs z 8 miejscami (IDR za 10 000 jednostek), 100 000 000 IDR po 0,00024123 to 24 123,00 zł', () => {
    expect(przeliczNaPln(10_000_000_000, 0.00024123)).toBe(wzorzec(10_000_000_000, '0.00024123'));
  });

  it.fails('FZ-019: OCR kosztu w walucie, 0,75 EUR po 4,3000 to 3,23 zł', () => {
    const kurs = { currency: 'EUR', mid: 4.3, tableNo: '1/A/NBP/2026', effectiveDate: '2026-03-09' };
    const wynik = costInPln({ currency: 'EUR', net_amount: 0.75, vat_amount: 0, gross_amount: 0.75 }, '2026-03-10', { found: true, rate: kurs, gapDays: 1 });
    expect(wynik).toMatchObject({ kind: 'pln', net: 3.23, gross: 3.23 });
  });

  it.fails('FZ-019: próg OSS, sprzedaż 0,75 EUR po 4,3000 liczy się jako 3,23 zł', () => {
    const wynik = licznikOss(
      [{ id: 'a', issueDate: '2026-03-10', net: 0.75, kind: 'regular', currency: 'EUR', rateToPln: 4.3, countryCode: 'DE', isB2c: true, buyerNip: null, vatUe: null }],
      { year: 2026 },
    );
    expect(wynik.sum).toBe(3.23);
  });
});

const KATALOG = process.cwd();
/** Nazwy kursu waluty w kodzie (zmienna albo pole): mnożenie albo dzielenie przez nie to przeliczenie waluty. */
const NAZWY_KURSU = new Set(['mid', 'rateToPln', 'kurs', 'kursNbp', 'kursSredni', 'exchangeRate', 'fxRate', 'USD_PLN', 'EUR_PLN']);
const PRZELICZENIE = 'lib/ksiegowosc/ewidencja.ts#przeliczNaPln';
/** Przeliczenia, które nie są kwotą księgową: `plik#funkcja` i dlaczego. */
const INNE: Readonly<Record<string, string>> = {
  'lib/flo/budget.ts#usdToPln': 'koszt modelu językowego FLO w USD po stałym kursie założonym (limit budżetu), nie kwota dla klienta ani księgi',
};
/** Przeliczenia ze znaleziska FZ-019 (otwarte), pilnowane przez `.fails` niżej. */
const FZ_019 = ['lib/ocr/currency.ts#costInPln', 'lib/oss/prog.ts#netPln'];

function pliki(katalog: string): string[] {
  const wynik: string[] = [];
  const idz = (k: string) => {
    for (const n of readdirSync(join(KATALOG, k))) {
      if (n === 'node_modules' || n.startsWith('.')) continue;
      const s = join(k, n);
      if (statSync(join(KATALOG, s)).isDirectory()) idz(s);
      else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) wynik.push(s);
    }
  };
  idz(katalog);
  return wynik;
}

const nazwa = (w: ts.Expression): string | null => {
  if (ts.isParenthesizedExpression(w) || ts.isNonNullExpression(w)) return nazwa(w.expression);
  if (ts.isIdentifier(w)) return w.text;
  if (ts.isPropertyAccessExpression(w)) return w.name.text;
  return null;
};
const RAZY_PRZEZ = new Set([ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.SlashEqualsToken]);

/** Mnożenia i dzielenia przez kurs: `plik#funkcja najwyższego poziomu` z linią. */
function przeliczenia(sciezka: string): Array<{ klucz: string; linia: number }> {
  const tekst = readFileSync(join(KATALOG, sciezka), 'utf8');
  if (![...NAZWY_KURSU].some((n) => tekst.includes(n))) return [];
  const zrodlo = ts.createSourceFile(sciezka, tekst, ts.ScriptTarget.Latest, true, sciezka.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const wynik: Array<{ klucz: string; linia: number }> = [];
  const idz = (w: ts.Node) => {
    if (ts.isBinaryExpression(w) && RAZY_PRZEZ.has(w.operatorToken.kind) && [nazwa(w.left), nazwa(w.right)].some((n) => n !== null && NAZWY_KURSU.has(n))) {
      let funkcja = '(moduł)';
      for (let p: ts.Node | undefined = w.parent; p; p = p.parent) {
        if (ts.isFunctionDeclaration(p) && p.name && p.parent === zrodlo) funkcja = p.name.text;
        if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && p.parent.parent.parent === zrodlo) funkcja = p.name.text;
      }
      wynik.push({ klucz: `${sciezka}#${funkcja}`, linia: zrodlo.getLineAndCharacterOfPosition(w.getStart(zrodlo)).line + 1 });
    }
    ts.forEachChild(w, idz);
  };
  idz(zrodlo);
  return wynik;
}

const PRZELICZENIA = ['lib', 'app', 'components'].flatMap(pliki).flatMap(przeliczenia);
const poza = () => [...new Set(PRZELICZENIA.map((p) => p.klucz).filter((k) => k !== PRZELICZENIE))].sort();

describe('NZ-KURS-03: każde przeliczenie waluty w kodzie stoi w przeliczNaPln', () => {
  it('test widzi przeliczenie w przeliczNaPln (inaczej nie sprawdza niczego)', () => {
    expect(PRZELICZENIA.some((p) => p.klucz === PRZELICZENIE)).toBe(true);
  });

  it('poza przeliczNaPln tylko przeliczenia spoza ksiąg, z powodem', () => {
    expect(poza().filter((k) => !FZ_019.includes(k))).toEqual(Object.keys(INNE).sort());
  });

  it.fails('FZ-019: OCR kosztu (costInPln) i próg OSS (netPln) przeliczają sami, na liczbach zmiennoprzecinkowych', () => {
    expect(poza().filter((k) => FZ_019.includes(k))).toEqual([]);
  });
});
