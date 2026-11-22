import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * NZ-WYL-01, uzupełnienie `wylacznik.test.ts` po drugim czytelniku #807
 * (tamten plik zostaje bez zmian). Globalny stop i brak flagi firmy
 * zatrzymują moduł księgowości wszędzie, więc:
 * 1. Graf importów zamiast listy plików: funkcja modułu (`lib/ksiegowosc/`),
 *    która czyta albo zapisuje dane (baza, sieć) i sama nie pyta
 *    o wyłącznik, przenosi to pytanie na tego, kto ją woła. Wejście
 *    aplikacji (strona, układ, trasa API, akcja serwera, zadanie w tle),
 *    które dochodzi do takiej funkcji, nie przechodząc przez wyłącznik,
 *    daje czerwień z nazwą pliku i funkcji. Nowa karta, cron, trasa
 *    telefonu czy powiadomienie z danymi modułu nie musi być na żadnej
 *    liście.
 * 2. Wejścia z `wylacznik.test.ts` czytane pełniej: `export { a }`,
 *    `export default X`, `export const GET = opakowanie(async () => …)`,
 *    import z aliasem, `import * as` z wywołaniem metody; każdy plik wejścia
 *    ma co najmniej jedną rozpoznaną eksportowaną funkcję.
 * Strażnik to tylko `czyKsiegowoscWlaczona` (kod, globalny stop i flaga
 * firmy): `statusObszaru` zna tylko blokadę w kodzie, więc funkcja, która
 * pyta wyłącznie o nią (np. `czytajTenMiesiac`), przenosi pytanie o globalny
 * stop na wołających. Jak w `wylacznik.test.ts` liczy się osiągalność
 * strażnika, nie kolejność: że wynik wyłącznika zatrzymuje działanie,
 * sprawdzają testy jednostkowe (`tests/unit/ksiegowosc-wylacznik.test.ts`)
 * i RLS.
 */

const KATALOG = process.cwd();
const WYLACZNIK = 'lib/ksiegowosc/wylacznik.ts';
const STRAZE = new Set(['czyKsiegowoscWlaczona']);
const MODUL = 'lib/ksiegowosc/';

/** Wejścia aplikacji: pliki, których eksporty woła Next.js albo kolejka zadań. */
const WEJSCIE_APLIKACJI = [/^app\/.*\/(page|layout|template|default|route)\.tsx?$/, /^app\/actions\/.*\.ts$/, /^lib\/jobs\/(runners|handlers)\/.*\.ts$/];

function pliki(katalog: string): string[] {
  const wynik: string[] = [];
  const idz = (k: string) => {
    for (const n of readdirSync(join(KATALOG, k))) {
      const sciezka = `${k}/${n}`;
      if (statSync(join(KATALOG, sciezka)).isDirectory()) idz(sciezka);
      else if (/\.tsx?$/.test(n) && !n.endsWith('.d.ts')) wynik.push(sciezka);
    }
  };
  idz(katalog);
  return wynik;
}

interface Jednostka {
  plik: string;
  nazwa: string;
  /** Funkcja albo opakowanie funkcji (nie stała z wartością). */
  funkcja: boolean;
  /** Nazwy lokalne użyte w ciele (wywołania, przekazanie dalej, JSX). */
  nazwy: Set<string>;
  /** `X.f` dla importu przestrzeni `X`. */
  metody: Array<[string, string]>;
  /** Wprost baza albo sieć: `x.from('tabela')`, `x.rpc(…)`, `fetch(…)`. */
  io: boolean;
  /** Tabele z `x.from('tabela')` wprost w tej jednostce. */
  tabele: string[];
}

interface Import {
  modul: string;
  /** Nazwa w module; `*` dla `import * as`, `default` dla importu domyślnego. */
  nazwa: string;
}

interface Plik {
  sciezka: string;
  jednostki: Map<string, Jednostka>;
  /** Nazwa eksportu: nazwa lokalna albo przekazanie z innego modułu. */
  eksporty: Map<string, string | Import>;
  importy: Map<string, Import>;
}

function modulZeSciezki(z: string, plik: string): string | null {
  if (z.startsWith('@/')) return z.slice(2);
  if (z.startsWith('.')) return normalize(join(dirname(plik), z));
  return null;
}

function czytaj(sciezka: string): Plik {
  const tekst = readFileSync(join(KATALOG, sciezka), 'utf8');
  const zrodlo = ts.createSourceFile(sciezka, tekst, ts.ScriptTarget.Latest, true, sciezka.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const p: Plik = { sciezka, jednostki: new Map(), eksporty: new Map(), importy: new Map() };

  const jednostka = (nazwa: string, wezel: ts.Node, funkcja: boolean) => {
    const j: Jednostka = { plik: sciezka, nazwa, funkcja, nazwy: new Set(), metody: [], io: false, tabele: [] };
    const idz = (w: ts.Node) => {
      if (ts.isTypeNode(w) || ts.isInterfaceDeclaration(w) || ts.isTypeAliasDeclaration(w)) return;
      if (ts.isPropertyAccessExpression(w)) {
        if (ts.isIdentifier(w.expression)) j.metody.push([w.expression.text, w.name.text]);
        idz(w.expression);
        return;
      }
      if (ts.isCallExpression(w)) {
        const c = w.expression;
        const pierwszy = w.arguments.at(0);
        if (ts.isIdentifier(c) && c.text === 'fetch') j.io = true;
        if (ts.isPropertyAccessExpression(c) && c.name.text === 'rpc') j.io = true;
        // `client.from('tabela')`, `admin.storage.from(KOSZYK)`; bez `Array.from` i `Buffer.from`.
        const odbiorca = ts.isPropertyAccessExpression(c) ? c.expression : null;
        const globalny = odbiorca !== null && ts.isIdentifier(odbiorca) && /^[A-Z]/.test(odbiorca.text);
        if (ts.isPropertyAccessExpression(c) && c.name.text === 'from' && !globalny && pierwszy !== undefined) {
          j.io = true;
          j.tabele.push(ts.isStringLiteralLike(pierwszy) ? pierwszy.text : '?');
        }
      }
      if (ts.isIdentifier(w)) j.nazwy.add(w.text);
      ts.forEachChild(w, idz);
    };
    idz(wezel);
    p.jednostki.set(nazwa, j);
    return j;
  };
  const eksportowany = (w: ts.Node) => !!ts.getModifiers(w as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const domyslny = (w: ts.Node) => !!ts.getModifiers(w as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
  const maFunkcje = (w: ts.Node): boolean =>
    ts.isArrowFunction(w) || ts.isFunctionExpression(w) || ts.isClassExpression(w) || ts.isCallExpression(w) || ts.isIdentifier(w) || ts.forEachChild(w, (d) => (maFunkcje(d) ? true : undefined)) === true;

  let gora = 0;
  for (const w of zrodlo.statements) {
    if (ts.isImportDeclaration(w) && ts.isStringLiteral(w.moduleSpecifier)) {
      const modul = modulZeSciezki(w.moduleSpecifier.text, sciezka);
      const k = w.importClause;
      if (!modul || !k || k.isTypeOnly) continue;
      if (k.name) p.importy.set(k.name.text, { modul, nazwa: 'default' });
      const z = k.namedBindings;
      if (z && ts.isNamespaceImport(z)) p.importy.set(z.name.text, { modul, nazwa: '*' });
      if (z && ts.isNamedImports(z)) for (const e of z.elements) if (!e.isTypeOnly) p.importy.set(e.name.text, { modul, nazwa: (e.propertyName ?? e.name).text });
      continue;
    }
    if (ts.isExportDeclaration(w)) {
      if (w.isTypeOnly) continue;
      const modul = w.moduleSpecifier && ts.isStringLiteral(w.moduleSpecifier) ? modulZeSciezki(w.moduleSpecifier.text, sciezka) : null;
      if (w.exportClause && ts.isNamedExports(w.exportClause)) {
        for (const e of w.exportClause.elements) {
          if (e.isTypeOnly) continue;
          const wlasna = (e.propertyName ?? e.name).text;
          p.eksporty.set(e.name.text, modul ? { modul, nazwa: wlasna } : wlasna);
        }
      } else if (modul) {
        p.eksporty.set(`*${modul}`, { modul, nazwa: '*' });
      }
      continue;
    }
    if (ts.isExportAssignment(w)) {
      if (ts.isIdentifier(w.expression)) p.eksporty.set('default', w.expression.text);
      else {
        jednostka('default', w.expression, maFunkcje(w.expression));
        p.eksporty.set('default', 'default');
      }
      continue;
    }
    if ((ts.isFunctionDeclaration(w) && w.body) || ts.isClassDeclaration(w)) {
      const nazwa = w.name?.text ?? 'default';
      jednostka(nazwa, w, true);
      if (eksportowany(w)) p.eksporty.set(domyslny(w) ? 'default' : nazwa, nazwa);
      continue;
    }
    if (ts.isVariableStatement(w)) {
      for (const d of w.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        jednostka(d.name.text, d.initializer, maFunkcje(d.initializer));
        if (eksportowany(w)) p.eksporty.set(d.name.text, d.name.text);
      }
      continue;
    }
    if (ts.isInterfaceDeclaration(w) || ts.isTypeAliasDeclaration(w) || ts.isEnumDeclaration(w) || ts.isModuleDeclaration(w)) continue;
    // Kod na górze pliku (np. rejestracja zadań) to osobna jednostka.
    jednostka(`<gora ${++gora}>`, w, true);
  }
  return p;
}

const ZRODLA = new Map<string, Plik>();
for (const k of ['app', 'lib', 'components']) for (const s of pliki(k)) ZRODLA.set(s, czytaj(s));

function plikModulu(modul: string): Plik | undefined {
  for (const kandydat of [`${modul}.ts`, `${modul}.tsx`, `${modul}/index.ts`, `${modul}/index.tsx`, modul]) {
    const p = ZRODLA.get(kandydat);
    if (p) return p;
  }
  return undefined;
}

/** Jednostki, do których prowadzi eksport `nazwa` modułu (przez przekazania). */
function eksport(modul: string, nazwa: string, glebokosc = 0): Jednostka[] {
  const p = plikModulu(modul);
  if (!p || glebokosc > 8) return [];
  if (nazwa === '*') return [...p.eksporty.keys()].flatMap((n) => (n.startsWith('*') ? [] : eksport(modul, n, glebokosc + 1)));
  const cel = p.eksporty.get(nazwa);
  if (cel === undefined) {
    return [...p.eksporty.entries()].flatMap(([n, c]) => (n.startsWith('*') && typeof c !== 'string' ? eksport(c.modul, nazwa, glebokosc + 1) : []));
  }
  if (typeof cel !== 'string') return eksport(cel.modul, cel.nazwa, glebokosc + 1);
  const j = p.jednostki.get(cel);
  if (j) return [j];
  const imp = p.importy.get(cel);
  return imp ? eksport(imp.modul, imp.nazwa, glebokosc + 1) : [];
}

/** Jednostki wskazane przez jednostkę: lokalne, z importu (także alias i przestrzeń) i metody przestrzeni. */
const wskazane = new Map<Jednostka, Jednostka[]>();
for (const p of ZRODLA.values()) {
  for (const j of p.jednostki.values()) {
    const cele: Jednostka[] = [];
    for (const n of j.nazwy) {
      const lokalna = p.jednostki.get(n);
      if (lokalna && lokalna !== j) cele.push(lokalna);
      const imp = p.importy.get(n);
      if (imp && imp.nazwa !== '*') cele.push(...eksport(imp.modul, imp.nazwa));
    }
    for (const [x, f] of j.metody) {
      const imp = p.importy.get(x);
      if (imp?.nazwa === '*') cele.push(...eksport(imp.modul, f));
    }
    wskazane.set(j, cele);
  }
}

function dopelnienie(start: (j: Jednostka) => boolean, przez: (j: Jednostka, cel: Jednostka) => boolean): Set<Jednostka> {
  const z = new Set([...wskazane.keys()].filter(start));
  for (let zmiana = true; zmiana; ) {
    zmiana = false;
    for (const [j, cele] of wskazane) {
      if (!z.has(j) && cele.some((c) => z.has(c) && przez(j, c))) {
        z.add(j);
        zmiana = true;
      }
    }
  }
  return z;
}

const zeStraza = dopelnienie(
  (j) => j.plik === WYLACZNIK && STRAZE.has(j.nazwa),
  () => true,
);
const wModule = (j: Jednostka) => j.plik.startsWith(MODUL) && j.plik !== WYLACZNIK;
/** Baza albo sieć wprost albo przez inne funkcje, w dowolnym pliku. */
const io = dopelnienie(
  (j) => j.io,
  () => true,
);
/**
 * Odczyty samego wyłącznika w module: lista firm z flagą modułu, po której
 * crony pytają `czyKsiegowoscWlaczona` o każdą firmę osobno. Wolno im czytać
 * tylko `tenant_feature_flags` (sprawdza to test niżej).
 */
const ODCZYTY_WYLACZNIKA = new Set(['lib/ksiegowosc/powiadomienia.ts#firmyWPilotazu']);
/** Dane modułu bez wyłącznika: funkcja modułu z bazą albo siecią, która sama nie pyta o wyłącznik. */
const daneBezStrazy = new Set([...io].filter((j) => wModule(j) && !zeStraza.has(j) && !ODCZYTY_WYLACZNIKA.has(`${j.plik}#${j.nazwa}`)));
const siega = (j: Jednostka, zbior: ReadonlySet<Jednostka>) => (wskazane.get(j) ?? []).some((c) => zbior.has(c));
/**
 * Pytanie o wyłącznik: strażnik albo funkcja, która do niego prowadzi i sama
 * nie sięga po dane modułu (np. `zaplatyZWyciaguWlaczone`). Funkcja, która
 * pyta o wyłącznik tylko w jednym z wołanych komponentów, sama nie pyta:
 * pytanie musi być na drodze od wejścia do danych.
 */
const pytania = dopelnienie(
  (j) => j.plik === WYLACZNIK && STRAZE.has(j.nazwa),
  (j) => !siega(j, daneBezStrazy),
);
const pyta = (j: Jednostka) => pytania.has(j) || siega(j, pytania);
const pozaModulem = (j: Jednostka) => !wModule(j) && j.plik !== WYLACZNIK;
/** Poza modułem: droga do danych modułu bez wyłącznika, na której nikt nie pyta o wyłącznik. */
const zagrozone = dopelnienie(
  (j) => pozaModulem(j) && !pyta(j) && siega(j, daneBezStrazy),
  (j) => pozaModulem(j) && !pyta(j),
);
const wejscieAplikacji = (plik: string) => WEJSCIE_APLIKACJI.some((r) => r.test(plik));
/** Eksporty pliku (własne, z importu i przekazane dalej) z jednostkami, do których prowadzą. */
const eksportowane = (p: Plik) =>
  [...p.eksporty.keys()].filter((n) => !n.startsWith('*')).flatMap((n) => eksport(p.sciezka.replace(/\.tsx?$/, ''), n).map((j) => [n, j] as const));

const opis = (j: Jednostka) => `${j.plik}#${j.nazwa}`;

/** Droga od zagrożonej jednostki do danych modułu bez wyłącznika (do komunikatu testu). */
function droga(od: Jednostka): string {
  const poprzednik = new Map<Jednostka, Jednostka | null>([[od, null]]);
  const kolejka = [od];
  for (let i = 0; i < kolejka.length; i++) {
    const j = kolejka[i];
    for (const c of wskazane.get(j) ?? []) {
      if (poprzednik.has(c)) continue;
      poprzednik.set(c, j);
      if (daneBezStrazy.has(c)) {
        const kroki: string[] = [];
        for (let k: Jednostka | null = c; k; k = poprzednik.get(k) ?? null) kroki.unshift(opis(k));
        return kroki.join(' -> ');
      }
      if (zagrozone.has(c)) kolejka.push(c);
    }
  }
  return opis(od);
}

describe('NZ-WYL-01: dane modułu księgowości tylko przez wyłącznik (graf importów)', () => {
  it('graf widzi moduł: dane bez wyłącznika w module i ich użycia poza nim', () => {
    expect(ZRODLA.size).toBeGreaterThan(500);
    const nazwy = new Set([...daneBezStrazy].map(opis));
    for (const n of [
      'lib/ksiegowosc/kpir-dane.ts#czytajKpir',
      'lib/ksiegowosc/ewidencja-dane.ts#czytajEwidencje',
      'lib/ksiegowosc/profil.ts#czytajWersjeProfilu',
      'lib/ksiegowosc/vat-dane.ts#czytajVat',
      // Tylko `statusObszaru`: o globalny stop i flagę firmy pyta ten, kto woła.
      'lib/ksiegowosc/ten-miesiac-dane.ts#czytajTenMiesiac',
      'lib/ksiegowosc/odlozyc.ts#czytajOdlozyc',
    ]) {
      expect(nazwy).toContain(n);
    }
    // Funkcje spoza modułu, które same pytają o wyłącznik (wprost albo przez funkcję bez danych modułu), nie przenoszą pytania dalej.
    const pytajace = new Set([...wskazane.keys()].filter(pyta).map(opis));
    for (const n of ['lib/kalendarz/zbierz.ts#zbierzZdarzenia', 'lib/import/bank/podatki-dane.ts#czytajPrzelewyPodatkowe', 'components/przeplywy/finora-1do1/sloty.tsx#PierscienKarta', 'lib/api/mobile/ksiegowosc.ts#monthForMobile']) {
      expect(pytajace).toContain(n);
    }
    const uzycia = [...wskazane].filter(([j, cele]) => !wModule(j) && cele.some((c) => daneBezStrazy.has(c))).map(([j]) => opis(j));
    expect(uzycia).toEqual(expect.arrayContaining(['app/(dashboard)/reports/ewidencja/page.tsx#EwidencjaPage', 'lib/import/bank/podatki-dane.ts#czytajKontaPodatkowe']));
  });

  it.each([...ODCZYTY_WYLACZNIKA])('%s: odczyt wyłącznika czyta tylko flagi firm i nie sięga po dane modułu', (nazwa) => {
    const j = [...wskazane.keys()].find((x) => opis(x) === nazwa);
    expect(j).toBeDefined();
    if (!j) return;
    expect(j.tabele).toEqual(['tenant_feature_flags']);
    expect(siega(j, daneBezStrazy) || siega(j, io)).toBe(false);
  });

  it('każde wejście aplikacji, które dochodzi do danych modułu, przechodzi przez wyłącznik', () => {
    const bez = [...ZRODLA.values()]
      .filter((p) => wejscieAplikacji(p.sciezka))
      .flatMap((p) => eksportowane(p).filter(([, j]) => zagrozone.has(j)).map(([n, j]) => `${p.sciezka}#${n}: ${droga(j)}`));
    expect(bez).toEqual([]);
  });

  const WEJSCIA = [...ZRODLA.keys()]
    .filter(
      (s) =>
        /^app\/\(dashboard\)\/reports\/(ten-miesiac|ewidencja|vat|ustawienia-podatkowe)\/page\.tsx$/.test(s) ||
        /^app\/actions\/ksiegowosc-[^/]*\.ts$/.test(s) ||
        /^lib\/jobs\/runners\/ksiegowosc-[^/]*\.ts$/.test(s) ||
        /^app\/api\/mobile\/v1\/ksiegowosc\/.*route\.ts$/.test(s),
    )
    .sort();

  it('wejścia modułu z listy `wylacznik.test.ts` istnieją', () => {
    expect(WEJSCIA.length).toBeGreaterThanOrEqual(15);
  });

  it.each(WEJSCIA)('%s: każda eksportowana funkcja, w każdej postaci eksportu, dochodzi do wyłącznika', (sciezka) => {
    const p = ZRODLA.get(sciezka);
    if (!p) throw new Error(`brak ${sciezka}`);
    const funkcje = eksportowane(p).filter(([, j]) => j.funkcja);
    expect(funkcje.length).toBeGreaterThan(0);
    if (sciezka.endsWith('/page.tsx')) expect(funkcje.map(([n]) => n)).toContain('default');
    expect(funkcje.filter(([, j]) => !zeStraza.has(j)).map(([n]) => `${sciezka}#${n}`)).toEqual([]);
  });
});
