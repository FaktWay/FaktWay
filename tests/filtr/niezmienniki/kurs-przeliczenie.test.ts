import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

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
 *    daje to samo dla kursów z 4 i 6 miejscami po przecinku, w połowie grosza
 *    (losowe remisy i tabela) i dla kwot ujemnych (korekty). API NBP podaje kurs
 *    przeliczony na jedną jednostkę, więc przy walutach z tabeli A za 100
 *    i 10 000 jednostek ma on 6 i 8 miejsc (do potwierdzenia jednym odczytem API).
 * 2. Kurs z 8 miejscami (IDR za 10 000 jednostek): `przeliczNaPln` skaluje kurs
 *    przez 10^6 i gubi dwa ostatnie miejsca: FZ-020.
 * 3. Test strukturalny po nazwie kursu (`NAZWY_KURSU` i ich aliasy w tym samym
 *    pliku: `const r = rate.mid`, `{ mid: r }`, `Number(mid)`, `mid as number`,
 *    `rate['mid']`): mnożenie albo dzielenie przez kurs w `lib/`, `app/`
 *    i `components/` stoi w `przeliczNaPln`, poza listą `INNE` (koszt modelu FLO).
 *    Dziś poza nią liczą też `costInPln` (OCR kosztu w walucie, kwoty idą do KPiR)
 *    i `netPln` (próg OSS, dziś bez skutku: jedyny wołający podaje `rateToPln:
 *    null`), na liczbach zmiennoprzecinkowych z `roundToCents`: 0,75 EUR po
 *    4,3000 to 3,225 zł, czyli 3,23 zł, a obie dają 3,22 zł. FZ-019. Kursu pod
 *    nazwą spoza listy i przekazanego z innego pliku test nie zobaczy.
 */

/** Wzorzec: grosze razy kurs z zapisu dziesiętnego, połówka grosza od zera, na BigInt. */
function wzorzec(kwotaGr: number, kurs: string): number {
  const [calk, ulamek = ''] = kurs.split('.');
  const skala = BigInt(10) ** BigInt(ulamek.length);
  const iloczyn = BigInt(Math.abs(kwotaGr)) * BigInt(`${calk}${ulamek}`);
  const grosze = Number((BigInt(2) * iloczyn + skala) / (BigInt(2) * skala));
  return kwotaGr < 0 ? -grosze : grosze;
}

/** Zapis dziesiętny kursu `n / 10^miejsca`. */
function zapis(n: number, miejsca: number): string {
  const s = String(n).padStart(miejsca + 1, '0');
  return `${s.slice(0, -miejsca)}.${s.slice(-miejsca)}`;
}

/** Największy wspólny dzielnik. */
function nwd(a: number, b: number): number {
  return b === 0 ? a : nwd(b, a % b);
}

/** Odwrotność `a` modulo `m` (algorytm Euklidesa), dla `a` względnie pierwszego z `m`. */
function odwrotnosc(a: number, m: number): number {
  let [r0, r1, s0, s1] = [m, a % m, 0, 1];
  while (r1 !== 0) {
    const q = Math.floor(r0 / r1);
    [r0, r1, s0, s1] = [r1, r0 - q * r1, s1, s0 - q * s1];
  }
  return ((s0 % m) + m) % m;
}

/** Kurs z `miejsca` miejscami po przecinku, od najmniejszego dodatniego do 99,99…. */
const kurs = (miejsca: number) => fc.integer({ min: 1, max: 100 * 10 ** miejsca - 1 }).map((n) => zapis(n, miejsca));
/** Do miliarda złotych w groszach, w obie strony (korekty). */
const KWOTA = fc.integer({ min: -100_000_000_000, max: 100_000_000_000 });
/**
 * Remis: kurs `n / 10^miejsca` i kwota, przy której iloczyn ma dokładnie pół
 * grosza (`kwota * n ≡ 10^miejsca / 2`), w obie strony. Rozwiązanie istnieje,
 * gdy `nwd(n, 10^miejsca)` dzieli `10^miejsca / 2`; kurs z zerami na końcu
 * (np. 4,3000) ma remisów więcej niż kurs z czterema znaczącymi cyframi.
 */
const remis = (miejsca: number) =>
  fc
    .tuple(fc.integer({ min: 1, max: 100 * 10 ** miejsca - 1 }), fc.integer({ min: 0, max: 10 ** (10 - miejsca) }), fc.boolean())
    .filter(([n]) => (10 ** miejsca / 2) % nwd(n, 10 ** miejsca) === 0)
    .map(([n, wielokrotnosc, ujemna]): [number, string] => {
      const m = 10 ** miejsca;
      const g = nwd(n, m);
      const modul = m / g;
      const reszta = (((m / 2 / g) % modul) * odwrotnosc((n / g) % modul, modul)) % modul;
      return [(reszta + wielokrotnosc * modul) * (ujemna ? -1 : 1), zapis(n, miejsca)];
    });

/** Połowa grosza: [grosze waluty, kurs, grosze po przeliczeniu]. */
const POLOWKI: Array<[number, string, number]> = [
  [75, '4.3000', 323], // 3,225 zł
  [115, '4.3000', 495], // 4,945 zł
  [-115, '4.3000', -495],
  [201, '0.5000', 101], // 1,005 zł
  [100, '0.005000', 1], // 0,005 zł przy kursie z 6 miejscami
  [-1, '0.500000', -1], // -0,005 zł
];

describe('NZ-KURS-03: kwota razy kurs do groszy jedną funkcją, bez błędu float', () => {
  it.each(POLOWKI)('%i gr po %s: %i gr (połowa grosza od zera)', (kwotaGr, k, oczekiwane) => {
    expect(wzorzec(kwotaGr, k)).toBe(oczekiwane);
    expect(przeliczNaPln(kwotaGr, Number(k))).toBe(oczekiwane);
  });

  it.each([4, 6])('losowa kwota i kurs z %i miejscami po przecinku: jak wzorzec na liczbach całkowitych', (miejsca) => {
    fc.assert(fc.property(KWOTA, kurs(miejsca), (kwotaGr, k) => przeliczNaPln(kwotaGr, Number(k)) === wzorzec(kwotaGr, k)), opcje());
  });

  it.each([4, 6])('losowy remis w połowie grosza przy kursie z %i miejscami, w obie strony: od zera, jak wzorzec', (miejsca) => {
    fc.assert(
      fc.property(remis(miejsca), ([kwotaGr, k]) => {
        // Sprawdzenie generatora: iloczyn ma dokładnie pół grosza.
        const iloczyn = BigInt(Math.abs(kwotaGr)) * BigInt(k.replace('.', ''));
        const skala = BigInt(10) ** BigInt(miejsca);
        return BigInt(2) * (iloczyn % skala) === skala && przeliczNaPln(kwotaGr, Number(k)) === wzorzec(kwotaGr, k);
      }),
      opcje(),
    );
  });

  it('FZ-020: kurs z 8 miejscami (IDR, API NBP podaje kurs za 1 jednostkę), 100 000 000 IDR po 0,00024123 to 24 123,00 zł', () => {
    expect(przeliczNaPln(10_000_000_000, 0.00024123)).toBe(wzorzec(10_000_000_000, '0.00024123'));
  });

  it.fails('FZ-019: OCR kosztu w walucie, 0,75 EUR po 4,3000 to 3,23 zł', () => {
    const tabela = { currency: 'EUR', mid: 4.3, tableNo: '1/A/NBP/2026', effectiveDate: '2026-03-09' };
    const wynik = costInPln({ currency: 'EUR', net_amount: 0.75, vat_amount: 0, gross_amount: 0.75 }, '2026-03-10', { found: true, rate: tabela, gapDays: 1 });
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
/** Nazwy kursu waluty w kodzie (zmienna, pole, parametr): mnożenie albo dzielenie przez nie to przeliczenie waluty. */
const NAZWY_KURSU = ['mid', 'rateToPln', 'kurs', 'kursNbp', 'kursSredni', 'exchangeRate', 'fxRate', 'USD_PLN', 'EUR_PLN', 'usdToPln', 'USD_TO_PLN'];
/** `plik#funkcja`: ile przeliczeń w niej stoi i dlaczego wolno. */
const DOZWOLONE: Readonly<Record<string, { ile: number; powod: string }>> = {
  'lib/ksiegowosc/ewidencja.ts#przeliczNaPln': { ile: 2, powod: 'ta jedna funkcja (kurs razy 10^6, iloczyn na BigInt)' },
  'lib/flo/budget.ts#usdToPln': { ile: 1, powod: 'koszt modelu językowego FLO w USD po stałym kursie założonym (limit budżetu), nie kwota dla klienta ani księgi' },
  'lib/flo/metrics.ts#computeCost': { ile: 2, powod: 'koszt modelu FLO na firmę wobec progów w złotych (metryka), nie kwota dla klienta ani księgi' },
  'app/admin/flo/page.tsx#AdminFloPage': { ile: 1, powod: 'panel administratora: średni koszt modelu FLO po kursie z `FLO_USD_PLN`, nie kwota dla klienta ani księgi' },
};
/** Przeliczenia ze znaleziska FZ-019 (otwarte), pilnowane przez `.fails` niżej. */
const FZ_019 = ['lib/ocr/currency.ts#costInPln', 'lib/oss/prog.ts#netPln'];

/** Ścieżki względne zawsze z `/` (`posix.join`), także na Windowsie: klucze `DOZWOLONE` i `FZ_019` są napisami z `/`. */
function pliki(katalog: string): string[] {
  const wynik: string[] = [];
  const idz = (k: string) => {
    for (const n of readdirSync(join(KATALOG, k))) {
      if (n === 'node_modules' || n.startsWith('.')) continue;
      const s = posix.join(k, n);
      if (statSync(join(KATALOG, s)).isDirectory()) idz(s);
      else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) wynik.push(s);
    }
  };
  idz(katalog);
  return wynik;
}

/** Nazwa wartości bez nawiasów, `!`, `as`, `satisfies`, `Number(…)`, `parseFloat(…)`; pole przez kropkę albo `['pole']`. */
function nazwa(w: ts.Expression): string | null {
  if (ts.isParenthesizedExpression(w) || ts.isNonNullExpression(w) || ts.isAsExpression(w) || ts.isTypeAssertionExpression(w) || ts.isSatisfiesExpression(w)) {
    return nazwa(w.expression);
  }
  if (ts.isCallExpression(w) && ts.isIdentifier(w.expression) && ['Number', 'parseFloat'].includes(w.expression.text) && w.arguments.length === 1) {
    return nazwa(w.arguments[0]!);
  }
  if (ts.isIdentifier(w)) return w.text;
  if (ts.isPropertyAccessExpression(w)) return w.name.text;
  if (ts.isElementAccessExpression(w) && ts.isStringLiteralLike(w.argumentExpression)) return w.argumentExpression.text;
  return null;
}

/** Nazwy kursu w pliku: z listy i ich aliasy (`const r = rate.mid`, `{ mid: r }`), aż przestaną przybywać. */
function nazwyKursu(zrodlo: ts.SourceFile): Set<string> {
  const nazwy = new Set(NAZWY_KURSU);
  for (let przybylo = true; przybylo; ) {
    przybylo = false;
    const idz = (w: ts.Node) => {
      let alias: string | null = null;
      if (ts.isVariableDeclaration(w) && ts.isIdentifier(w.name) && w.initializer) {
        const n = nazwa(w.initializer);
        if (n !== null && nazwy.has(n)) alias = w.name.text;
      }
      if (ts.isBindingElement(w) && ts.isIdentifier(w.name)) {
        const pole = w.propertyName && (ts.isIdentifier(w.propertyName) || ts.isStringLiteralLike(w.propertyName)) ? w.propertyName.text : w.name.text;
        if (nazwy.has(pole)) alias = w.name.text;
      }
      if (alias !== null && !nazwy.has(alias)) {
        nazwy.add(alias);
        przybylo = true;
      }
      ts.forEachChild(w, idz);
    };
    idz(zrodlo);
  }
  return nazwy;
}

const RAZY_PRZEZ = new Set([ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.SlashEqualsToken]);

/** Mnożenia i dzielenia przez kurs: `plik#funkcja najwyższego poziomu` z linią. */
function przeliczenia(sciezka: string): Array<{ klucz: string; linia: number }> {
  const tekst = readFileSync(join(KATALOG, sciezka), 'utf8');
  if (!/[*/]/.test(tekst)) return [];
  const zrodlo = ts.createSourceFile(sciezka, tekst, ts.ScriptTarget.Latest, true, sciezka.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const nazwy = nazwyKursu(zrodlo);
  const wynik: Array<{ klucz: string; linia: number }> = [];
  const idz = (w: ts.Node) => {
    if (ts.isBinaryExpression(w) && RAZY_PRZEZ.has(w.operatorToken.kind) && [nazwa(w.left), nazwa(w.right)].some((n) => n !== null && nazwy.has(n))) {
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
/** Przeliczenia policzone na klucz `plik#funkcja`, wybrane filtrem. */
function policzone(czy: (klucz: string) => boolean): Record<string, number> {
  const ile: Record<string, number> = {};
  for (const p of PRZELICZENIA) if (czy(p.klucz)) ile[p.klucz] = (ile[p.klucz] ?? 0) + 1;
  return ile;
}

describe('NZ-KURS-03: przeliczenia waluty po nazwie kursu stoją w przeliczNaPln', () => {
  it('test widzi przeliczenie w przeliczNaPln (inaczej nie sprawdza niczego)', () => {
    expect(PRZELICZENIA.some((p) => p.klucz === 'lib/ksiegowosc/ewidencja.ts#przeliczNaPln')).toBe(true);
  });

  it('poza przeliczNaPln tylko przeliczenia spoza ksiąg z listy, policzone co do sztuki', () => {
    expect(policzone((k) => !FZ_019.includes(k))).toEqual(Object.fromEntries(Object.entries(DOZWOLONE).map(([k, v]) => [k, v.ile])));
  });

  it.fails('FZ-019: OCR kosztu (costInPln) i próg OSS (netPln) przeliczają sami, na liczbach zmiennoprzecinkowych', () => {
    expect(policzone((k) => FZ_019.includes(k))).toEqual({});
  });
});
