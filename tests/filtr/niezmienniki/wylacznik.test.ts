import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * NZ-WYL-01 (żelazny filtr, uzupełnienie po spisie luk z 16.11): globalny stop
 * i brak flagi firmy zatrzymują moduł księgowości wszędzie: ekrany, akcje,
 * crony i API telefonu. Test strukturalny na drzewie składni: każda
 * eksportowana funkcja wejścia do modułu dochodzi do `czyKsiegowoscWlaczona`
 * albo `statusObszaru` (wprost, przez funkcję w tym samym pliku albo przez
 * funkcję z modułu, który sam o to pyta). Nowe wejście bez wyłącznika daje
 * czerwień z nazwą pliku i funkcji. Zachowanie wyłącznika sprawdzają testy
 * jednostkowe (`tests/unit/ksiegowosc-wylacznik.test.ts`) i RLS.
 */

const KATALOG = process.cwd();
const STRAZE = new Set(['czyKsiegowoscWlaczona', 'statusObszaru']);
/** Moduły współdzielone przez wejścia; ich funkcje liczy się jak lokalne. */
const MODULY = ['lib/ksiegowosc/ten-miesiac-zapis.ts', 'lib/api/mobile/ksiegowosc.ts'];
// M10d: plik JPK_V7M (`pobierzJpkV7m`) i API VAT telefonu same pytają o wyłącznik; akcja strony i trasy telefonu wołają je z importu.
// Kolejność: `vat-plik` przed `ksiegowosc-vat`, które z niego korzysta.
MODULY.push('lib/ksiegowosc/vat-plik.ts', 'lib/api/mobile/ksiegowosc-vat.ts');
// M10d część 2: pliki JPK_EWP i JPK_PKPIR (`pobierzJpkEwp`, `pobierzJpkPkpir`) same pytają o wyłącznik.
MODULY.push('lib/ksiegowosc/ewidencja-pliki.ts', 'lib/api/mobile/ksiegowosc-ksiegi.ts');
// Raport KPiR i eksport (`raport-kpir`, `eksport` poza katalogiem `ksiegowosc`) na stronie też nie są za wyłącznikiem modułu.
// M10d część 3: zapisy ksiąg (`dodajWpisReczny`, `dodajWpisKpir`, `dodajSpis`, usunięcia) same pytają o wyłącznik; trasy telefonu wołają je z importu.
MODULY.push('lib/ksiegowosc/ewidencja-zapis.ts', 'lib/api/mobile/ksiegowosc-zapisy.ts');

/** Ścieżki względne zawsze z `/` (`posix.join`), także na Windowsie: wzorce i listy niżej porównują napisy z `/`. */
function pliki(katalog: string, wzorzec: RegExp): string[] {
  const wynik: string[] = [];
  const idz = (k: string) => {
    for (const n of readdirSync(join(KATALOG, k))) {
      const sciezka = posix.join(k, n);
      if (statSync(join(KATALOG, sciezka)).isDirectory()) idz(sciezka);
      else if (wzorzec.test(sciezka)) wynik.push(sciezka);
    }
  };
  idz(katalog);
  return wynik.sort();
}

interface Plik {
  /** Funkcja: nazwy wywołanych identyfikatorów. */
  wywolania: Map<string, Set<string>>;
  eksportowane: string[];
  /** Nazwa lokalna z importu: ścieżka modułu `@/…`. */
  importy: Map<string, string>;
}

function czytaj(sciezka: string): Plik {
  const zrodlo = ts.createSourceFile(sciezka, readFileSync(join(KATALOG, sciezka), 'utf8'), ts.ScriptTarget.Latest, true, sciezka.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const wywolania = new Map<string, Set<string>>();
  const eksportowane: string[] = [];
  const importy = new Map<string, string>();
  const zbierz = (wezel: ts.Node, cel: Set<string>) => {
    if (ts.isCallExpression(wezel) && ts.isIdentifier(wezel.expression)) cel.add(wezel.expression.text);
    ts.forEachChild(wezel, (d) => zbierz(d, cel));
  };
  const eksport = (w: ts.Node) => !!ts.getModifiers(w as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const w of zrodlo.statements) {
    if (ts.isImportDeclaration(w) && ts.isStringLiteral(w.moduleSpecifier)) {
      const z = w.importClause?.namedBindings;
      if (z && ts.isNamedImports(z)) for (const e of z.elements) importy.set(e.name.text, w.moduleSpecifier.text);
    }
    if (ts.isFunctionDeclaration(w) && w.body) {
      const nazwa = w.name?.text ?? 'default';
      const cel = new Set<string>();
      zbierz(w.body, cel);
      wywolania.set(nazwa, cel);
      if (eksport(w)) eksportowane.push(nazwa);
    }
    if (ts.isVariableStatement(w)) {
      for (const d of w.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer || !(ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) continue;
        const cel = new Set<string>();
        zbierz(d.initializer, cel);
        wywolania.set(d.name.text, cel);
        if (eksport(w)) eksportowane.push(d.name.text);
      }
    }
  }
  return { wywolania, eksportowane, importy };
}

/** Funkcje pliku, które dochodzą do wyłącznika; `obce`: nazwy z innych modułów, które same do niego dochodzą. */
function zeStraza(p: Plik, obce: ReadonlyMap<string, Set<string>>): Set<string> {
  const z = new Set<string>();
  const obca = (nazwa: string) => {
    const modul = p.importy.get(nazwa);
    return modul !== undefined && (obce.get(modul)?.has(nazwa) ?? false);
  };
  for (let zmiana = true; zmiana; ) {
    zmiana = false;
    for (const [f, wywolane] of p.wywolania) {
      if (z.has(f)) continue;
      if ([...wywolane].some((n) => STRAZE.has(n) || z.has(n) || obca(n))) {
        z.add(f);
        zmiana = true;
      }
    }
  }
  return z;
}

const obce = new Map<string, Set<string>>();
for (const m of MODULY) obce.set(`@/${m.replace(/\.tsx?$/, '')}`, zeStraza(czytaj(m), obce));

const WEJSCIA = [
  ...pliki('app/(dashboard)/reports', /\/(ten-miesiac|ewidencja|vat|ustawienia-podatkowe)\/page\.tsx$/),
  ...pliki('app/actions', /\/ksiegowosc-[^/]*\.ts$/),
  ...pliki('lib/jobs/runners', /\/ksiegowosc-[^/]*\.ts$/),
  ...pliki('app/api/mobile/v1/ksiegowosc', /route\.ts$/),
];

describe('NZ-WYL-01: każde wejście do modułu księgowości pyta o wyłącznik', () => {
  it('lista wejść nie jest pusta (strony, akcje, crony, API telefonu)', () => {
    expect(WEJSCIA.filter((p) => p.includes('/page.tsx')).length).toBeGreaterThanOrEqual(4);
    expect(WEJSCIA.filter((p) => p.startsWith('app/actions/')).length).toBeGreaterThanOrEqual(3);
    expect(WEJSCIA.filter((p) => p.startsWith('lib/jobs/runners/')).length).toBeGreaterThanOrEqual(2);
    expect(WEJSCIA.filter((p) => p.startsWith('app/api/mobile/')).length).toBeGreaterThanOrEqual(3);
  });

  it.each(WEJSCIA)('%s: każda eksportowana funkcja dochodzi do wyłącznika', (sciezka) => {
    const p = czytaj(sciezka);
    const z = zeStraza(p, obce);
    const bez = p.eksportowane.filter((f) => !z.has(f));
    expect(bez.map((f) => `${sciezka}#${f}`)).toEqual([]);
  });

  it('moduły współdzielone dochodzą do wyłącznika w funkcjach zapisu i odczytu dla telefonu', () => {
    expect([...(obce.get('@/lib/ksiegowosc/ten-miesiac-zapis') ?? [])]).toEqual(expect.arrayContaining(['zatwierdzMiesiac', 'oznaczZaplacone']));
    expect([...(obce.get('@/lib/api/mobile/ksiegowosc') ?? [])]).toEqual(expect.arrayContaining(['monthForMobile', 'approveMonthFromMobile', 'settlementPaymentFromMobile']));
  });
});
