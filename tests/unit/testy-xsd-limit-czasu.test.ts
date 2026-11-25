import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Strażnik limitu czasu testów XSD. Test z `fc.asyncProperty`, który
 * przepuszcza pliki przez walidator XSD (`xmllint-wasm`), na CI bywa dłuższy
 * niż domyślne 5 s Vitest i wtedy losowo wyrzuca PR z kolejki scalania
 * („Test timed out in 5000ms”: #828 `korekta-od-brutto`, #872
 * `fa3-fawiersz-klasyfikacja-xsd`, 23.11 #896 `korekta-kody-pozycji`). Taki
 * test ma jawny limit (trzeci argument `it`/`test` albo `{ timeout }`), jak
 * `tests/filtr/xsd/*` (600_000).
 *
 * Co jest testem XSD: plik w `tests/`, który importuje `xmllint-wasm` albo
 * moduł z `lib/`, który sięga walidatora wprost albo przez inne moduły
 * (importy z `@/` i względne). Sprawdzany jest każdy przypadek takiego pliku,
 * którego funkcja woła `fc.asyncProperty` sama albo przez funkcję z tego
 * samego pliku.
 */

const KATALOG = process.cwd();
const BIBLIOTEKA_XSD = 'xmllint-wasm';
/** Limit jak w `tests/filtr/xsd/*`. */
const LIMIT = 600_000;

function pliki(katalog: string, czy: (sciezka: string) => boolean): string[] {
  const wynik: string[] = [];
  for (const nazwa of readdirSync(katalog)) {
    if (nazwa === 'node_modules' || nazwa.startsWith('.')) continue;
    const pelna = join(katalog, nazwa);
    if (statSync(pelna).isDirectory()) wynik.push(...pliki(pelna, czy));
    else if (czy(pelna)) wynik.push(pelna);
  }
  return wynik;
}

const zrodlo = (sciezka: string) =>
  ts.createSourceFile(sciezka, readFileSync(sciezka, 'utf8'), ts.ScriptTarget.Latest, true, sciezka.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** Specyfikatory statycznych importów i eksportów `from` (bez `import()` i `vi.mock`). */
function importy(plik: ts.SourceFile): string[] {
  const wynik: string[] = [];
  for (const s of plik.statements) {
    if ((ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier)) {
      wynik.push(s.moduleSpecifier.text);
    }
  }
  return wynik;
}

/** Plik modułu z `lib/` dla specyfikatora albo null (paczki, inne katalogi). */
function rozwiaz(zPliku: string, specyfikator: string): string | null {
  const baza = specyfikator.startsWith('@/')
    ? join(KATALOG, specyfikator.slice(2))
    : specyfikator.startsWith('.')
      ? resolve(dirname(zPliku), specyfikator)
      : null;
  if (!baza) return null;
  for (const kandydat of [baza, `${baza}.ts`, `${baza}.tsx`, join(baza, 'index.ts'), join(baza, 'index.tsx')]) {
    if (existsSync(kandydat) && statSync(kandydat).isFile()) return kandydat;
  }
  return null;
}

const LIB = pliki(join(KATALOG, 'lib'), (p) => /\.tsx?$/.test(p) && !p.endsWith('.d.ts'));
const IMPORTY_LIB = new Map(LIB.map((p) => [p, importy(zrodlo(p))]));

/** Moduły `lib/`, które sięgają walidatora XSD wprost albo przez inne moduły `lib/`. */
const MODULY_XSD = (() => {
  const xsd = new Set(LIB.filter((p) => IMPORTY_LIB.get(p)!.includes(BIBLIOTEKA_XSD)));
  for (let zmiana = true; zmiana; ) {
    zmiana = false;
    for (const p of LIB) {
      if (xsd.has(p)) continue;
      if (IMPORTY_LIB.get(p)!.some((s) => {
        const cel = rozwiaz(p, s);
        return cel !== null && xsd.has(cel);
      })) {
        xsd.add(p);
        zmiana = true;
      }
    }
  }
  return xsd;
})();

interface Przypadek {
  plik: string;
  linia: number;
  nazwa: string;
  limit: boolean;
}

const NAZWY_TESTU = new Set(['it', 'test']);

/** Czy wyrażenie to `it`, `test`, `it.fails`, `test.skip`, `it.each(...)` itd. */
function wywolanieTestu(wyr: ts.Expression): boolean {
  if (ts.isIdentifier(wyr)) return NAZWY_TESTU.has(wyr.text);
  if (ts.isPropertyAccessExpression(wyr)) return wywolanieTestu(wyr.expression);
  if (ts.isCallExpression(wyr)) return wywolanieTestu(wyr.expression);
  return false;
}

const maLimitWOpcjach = (arg: ts.Expression | undefined) =>
  arg !== undefined && ts.isObjectLiteralExpression(arg) && arg.properties.some((p) => p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === 'timeout');

/** Przypadki z `fc.asyncProperty` (wprost albo przez funkcję z pliku) i czy mają jawny limit. */
function przypadki(sciezka: string): Przypadek[] {
  const plik = zrodlo(sciezka);
  // Funkcje z pliku (deklaracje i stałe z funkcją), których ciało woła fc.asyncProperty, także przez inne takie funkcje.
  const funkcje = new Map<string, string>();
  const zbierz = (w: ts.Node) => {
    if (ts.isFunctionDeclaration(w) && w.name && w.body) funkcje.set(w.name.text, w.body.getText(plik));
    if (ts.isVariableDeclaration(w) && ts.isIdentifier(w.name) && w.initializer && (ts.isArrowFunction(w.initializer) || ts.isFunctionExpression(w.initializer))) {
      funkcje.set(w.name.text, w.initializer.getText(plik));
    }
    ts.forEachChild(w, zbierz);
  };
  zbierz(plik);
  const asynchroniczne = new Set([...funkcje].filter(([, cialo]) => /\bfc\.asyncProperty\b/.test(cialo)).map(([n]) => n));
  for (let zmiana = true; zmiana; ) {
    zmiana = false;
    for (const [nazwa, cialo] of funkcje) {
      if (asynchroniczne.has(nazwa)) continue;
      if ([...asynchroniczne].some((a) => new RegExp(`\\b${a}\\b`).test(cialo))) {
        asynchroniczne.add(nazwa);
        zmiana = true;
      }
    }
  }
  const wolaAsync = (kod: string) => /\bfc\.asyncProperty\b/.test(kod) || [...asynchroniczne].some((a) => new RegExp(`\\b${a}\\b`).test(kod));

  const wynik: Przypadek[] = [];
  const odwiedz = (w: ts.Node) => {
    if (ts.isCallExpression(w) && wywolanieTestu(w.expression) && w.arguments.length >= 2) {
      const [, drugi, trzeci] = w.arguments;
      const funkcja = w.arguments.slice(1).find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a) || ts.isIdentifier(a));
      if (funkcja && wolaAsync(funkcja.getText(plik))) {
        const nazwa = w.arguments[0] && ts.isStringLiteralLike(w.arguments[0]) ? w.arguments[0].text : w.arguments[0]?.getText(plik) ?? '';
        const limit = trzeci !== undefined && !ts.isArrowFunction(trzeci) && !ts.isFunctionExpression(trzeci)
          ? true
          : maLimitWOpcjach(drugi);
        wynik.push({ plik: relative(KATALOG, sciezka).split(sep).join('/'), linia: plik.getLineAndCharacterOfPosition(w.getStart(plik)).line + 1, nazwa, limit });
      }
    }
    ts.forEachChild(w, odwiedz);
  };
  odwiedz(plik);
  return wynik;
}

const TESTY = pliki(join(KATALOG, 'tests'), (p) => /\.test\.tsx?$/.test(p));
const TESTY_XSD = TESTY.filter((p) => {
  const plik = zrodlo(p);
  return importy(plik).some((s) => s === BIBLIOTEKA_XSD || MODULY_XSD.has(rozwiaz(p, s) ?? ''));
});
const PRZYPADKI = TESTY_XSD.flatMap(przypadki);

describe('testy fc.asyncProperty z walidatorem XSD mają jawny limit czasu', () => {
  it('strażnik widzi walidatory, pliki testów XSD i ich przypadki (inaczej nie sprawdza niczego)', () => {
    const lib = (p: string) => MODULY_XSD.has(join(KATALOG, p));
    for (const p of ['lib/xml/validator.ts', 'lib/exports/jpk-v7m-validator.ts', 'lib/exports/jpk-fa-validator.ts', 'lib/ksiegowosc/jpk-ewp-walidator.ts']) {
      expect(lib(p), p).toBe(true);
    }
    const pliki = new Set(PRZYPADKI.map((p) => p.plik));
    for (const p of ['tests/unit/korekta-kody-pozycji.test.ts', 'tests/unit/korekta-od-brutto.test.ts', 'tests/unit/fa3-fawiersz-klasyfikacja-xsd.test.ts', 'tests/filtr/xsd/fa3.test.ts', 'tests/filtr/xsd/jpk-v7m.test.ts']) {
      expect(pliki.has(p), p).toBe(true);
    }
    expect(PRZYPADKI.length).toBeGreaterThanOrEqual(20);
  });

  it(`każdy taki przypadek ma jawny limit (trzeci argument albo { timeout }; w repo ${LIMIT})`, () => {
    expect(PRZYPADKI.filter((p) => !p.limit).map((p) => `${p.plik}:${p.linia} ${p.nazwa}`)).toEqual([]);
  });
});
