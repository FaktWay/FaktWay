import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import fc from 'fast-check';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { ACCOUNTING_PAGE_SIZE, readCompletePages, readCompletePagesByKey, type KeysetPageQuery } from '@/lib/accounting/read-complete-pages';
import { POSTGREST_MAX_ROWS } from '@/lib/pagination/keyset';

import { opcje, PRZYPADKI } from '../generatory/ustawienia';

/**
 * NZ-WSP-08 (żelazny filtr, uzupełnienie po spisie luk z 16.11): odczyt
 * stronami daje te same wiersze i sumy co jeden odczyt, także przy 999,
 * 1000, 1001 i 2500 wierszach. Granica PostgREST: produkcja ucina każdą
 * odpowiedź do 1000 wierszy bez błędu (`PGRST_DB_MAX_ROWS`, odczyt
 * z produkcji z 25.10.2026 w `docs/koordynacja/PLAN-SKALOWANIE-3000.md`,
 * stała `POSTGREST_MAX_ROWS`), a helpery proszą o strony po 500
 * (`ACCOUNTING_PAGE_SIZE`).
 *
 * 1. Prawdziwe `readCompletePages` (zakresy) i `readCompletePagesByKey`
 *    (po `id`) na atrapie serwera: komplet wierszy w kolejności i ta sama
 *    suma przy każdym limicie serwera od rozmiaru strony w górę; limit
 *    poniżej strony daje wyjątek, nie niepełną sumę.
 * 2. Bezpieczniki z konkretnym komunikatem: wiersz dopisany albo usunięty
 *    w trakcie odczytu, zignorowana kolejność. Para zmian, która zachowuje
 *    liczbę wierszy (usunięty wiersz już przeczytany i dopisany w części
 *    jeszcze nieprzeczytanej), przechodzi dziś bez wyjątku: FZ-017.
 * 3. Test strukturalny: każde zapytanie `.from('tabela')` i `.rpc('funkcja')`
 *    w `lib/ksiegowosc`, `lib/reports` i `lib/exports` (nazwa spoza napisu daje
 *    czerwony test) idzie przez helper stronicowania, a funkcja podana helperowi
 *    ma jedno zapytanie z `order('id')` i stronicowaniem tego helpera. Poza
 *    helperem tylko zapis, jeden wiersz, sam licznik, `limit(1)` albo lista
 *    `OGRANICZONE` z liczbą zapytań i powodem. Własne stronicowanie bez
 *    licznika w `lib/exports/jpk-fa-readiness.ts`: FZ-018.
 */

interface Wiersz {
  id: string;
  kwotaGr: number;
}

const GRANICE = [0, 1, 499, 500, 501, 999, 1000, 1001, 2500];
const LICZBA = 'test: nie można potwierdzić liczby rekordów';
const STRONA = 'test: niepełna strona danych';
const KOLEJNOSC = 'test: niestabilna kolejność stron danych';

const wiersze = (n: number, kwota: (i: number) => number = (i) => (i * 7919) % 100_000): Wiersz[] =>
  Array.from({ length: n }, (_, i) => ({ id: `id-${String(i).padStart(6, '0')}`, kwotaGr: kwota(i) }));
const suma = (w: readonly Wiersz[]) => w.reduce((s, r) => s + r.kwotaGr, 0);
const ids = (w: readonly Wiersz[]) => w.map((r) => r.id);
/**
 * `order('id')` bazy. Na produkcji `id` to UUID w kanonicznym zapisie małymi
 * literami, a kolejność takich napisów jest kolejnością typu `uuid`
 * w Postgresie, więc porównanie napisów w helperze i w atrapie zgadza się z bazą.
 */
const poId = (dane: readonly Wiersz[]) => [...dane].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/**
 * Najwięcej zapytań jednego odczytu w atrapie (3000 wierszy to 7 stron i licznik
 * kontrolny). Helper, który prosi o strony bez końca, dostaje wyjątek, a nie
 * zawiesza testu: pętla na gotowych obietnicach nie oddaje sterowania zegarowi
 * limitu czasu testu.
 */
const NAJWIECEJ_ZAPYTAN = 50;
const kolejneZapytanie = (strona: number) => {
  if (strona > NAJWIECEJ_ZAPYTAN) throw new Error('atrapa: helper prosi o strony bez końca');
  return strona;
};

/**
 * Atrapa zakresów PostgREST (`count: 'exact'`, `order('id')`, `range`):
 * odpowiedź ucięta do limitu serwera bez błędu, `poStronie` zmienia dane po
 * każdej stronie. Bez odpowiedzi 416 (zakres za licznikiem): helper o taką
 * stronę nie prosi.
 */
function zakresy(dane: Wiersz[], limit = POSTGREST_MAX_ROWS, poStronie?: (strona: number) => void) {
  let strona = 0;
  return async (from: number, to: number) => {
    strona = kolejneZapytanie(strona + 1);
    const wynik = { data: poId(dane).slice(from, Math.min(to + 1, from + limit)), count: dane.length, error: null };
    poStronie?.(strona);
    return wynik;
  };
}

/** Atrapa odczytu po `id` (`gt`, `order('id')`, `limit`, licznik, `head` bez wierszy), z tym samym limitem serwera. */
function poKluczu(dane: Wiersz[], limit = POSTGREST_MAX_ROWS, poStronie?: (strona: number) => void) {
  let strona = 0;
  return async (q: KeysetPageQuery) => {
    strona = kolejneZapytanie(strona + 1);
    const dalej = poId(dane).filter((r) => q.afterId === null || r.id > q.afterId);
    const wynik = { data: q.head ? null : dalej.slice(0, Math.min(q.limit, limit)), count: q.count ? dane.length : null, error: null };
    poStronie?.(strona);
    return wynik;
  };
}

const oba = (dane: Wiersz[], limit = POSTGREST_MAX_ROWS) => [
  () => readCompletePages('test', zakresy(dane, limit)),
  () => readCompletePagesByKey('test', poKluczu(dane, limit)),
];

describe('NZ-WSP-08: odczyt stronami daje te same wiersze i sumy co jeden odczyt', () => {
  it('strona helpera mieści się w limicie serwera, więc pełnej strony serwer nie utnie', () => {
    expect(ACCOUNTING_PAGE_SIZE).toBeLessThanOrEqual(POSTGREST_MAX_ROWS);
  });

  it.each(GRANICE)('%i wierszy: oba odczyty zwracają każdy wiersz raz, w kolejności, z tą samą sumą', async (n) => {
    const dane = wiersze(n);
    for (const odczyt of oba(dane)) {
      const w = await odczyt();
      expect(ids(w)).toEqual(ids(dane));
      expect(suma(w)).toBe(suma(dane));
    }
  });

  it('limit serwera o jeden poniżej strony: wyjątek; równy stronie: komplet (1001 wierszy)', async () => {
    const dane = wiersze(1001);
    for (const odczyt of oba(dane, ACCOUNTING_PAGE_SIZE - 1)) await expect(odczyt()).rejects.toThrow(STRONA);
    for (const odczyt of oba(dane, ACCOUNTING_PAGE_SIZE)) expect(suma(await odczyt())).toBe(suma(dane));
  });

  // W nocy najwyżej 1000 przebiegów zamiast `FILTR_PRZYPADKI` (50000): przebieg
  // czyta do 3000 wierszy oboma helperami, a przestrzeń (wiersze do 3000, limit
  // serwera do 1500) jest mała; nocne ziarno i tak daje inne dane.
  it('losowa liczba wierszy, kwoty i limit serwera: suma jak w jednym odczycie albo wyjątek, nigdy inna suma', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 3000 }), fc.integer({ min: 1, max: 2 ** 31 }), fc.integer({ min: 1, max: 1500 }), async (n, ziarno, limit) => {
        const dane = wiersze(n, (i) => ((i + 1) * ziarno) % 5_000_000);
        for (const odczyt of oba(dane, limit)) {
          if (limit >= ACCOUNTING_PAGE_SIZE || n <= limit) expect(suma(await odczyt())).toBe(suma(dane));
          else await expect(odczyt()).rejects.toThrow(STRONA);
        }
      }),
      opcje(Math.min(PRZYPADKI, 1000)),
    );
  }, 120_000);
});

/** Zmiany po pierwszej stronie, czyli po przeczytaniu wierszy 0–499 z 2500. */
const ZMIANY = {
  'dopisany na końcu': (d: Wiersz[]) => { d.push({ id: 'id-999999', kwotaGr: 1 }); },
  'dopisany w części nieprzeczytanej': (d: Wiersz[]) => { d.push({ id: 'id-000600a', kwotaGr: 1 }); },
  'usunięty już przeczytany': (d: Wiersz[]) => { d.splice(d.findIndex((r) => r.id === 'id-000010'), 1); },
  'usunięty jeszcze nieprzeczytany': (d: Wiersz[]) => { d.splice(d.findIndex((r) => r.id === 'id-001500'), 1); },
};
type Zmiana = keyof typeof ZMIANY;
type Czytnik = 'zakresy' | 'po kluczu';

function odczytZeZmianami(czytnik: Czytnik, dane: Wiersz[], zmiany: readonly Zmiana[]) {
  const poStronie = (strona: number) => {
    if (strona === 1) for (const z of zmiany) ZMIANY[z](dane);
  };
  return czytnik === 'zakresy'
    ? readCompletePages('test', zakresy(dane, POSTGREST_MAX_ROWS, poStronie))
    : readCompletePagesByKey('test', poKluczu(dane, POSTGREST_MAX_ROWS, poStronie));
}

/** Wyjątek albo dokładnie stan sprzed zmian, albo stan po nich; nigdy wiersze z dwóch stanów. */
async function jedenStan(czytnik: Czytnik, zmiany: readonly Zmiana[]) {
  const dane = wiersze(2500);
  const przed = ids(dane);
  const wynik = await odczytZeZmianami(czytnik, dane, zmiany).then(ids, () => null);
  if (wynik !== null) expect([przed, ids(poId(dane))]).toContainEqual(wynik);
}

const zamienione = (dane: readonly Wiersz[]) => {
  const kopia = [...dane];
  [kopia[3], kopia[4]] = [kopia[4]!, kopia[3]!];
  return kopia;
};
/** Serwer, który zignorował kolejność albo kursor: helper musi to zauważyć, a nie policzyć wiersz dwa razy. */
const ZLA_KOLEJNOSC: Array<[string, () => Promise<Wiersz[]>]> = [
  ['zakresy, serwer zamienił miejscami dwa wiersze strony', () => {
    const d = wiersze(1200);
    return readCompletePages('test', async (from, to) => ({ data: zamienione(d).slice(from, to + 1), count: d.length, error: null }));
  }],
  ['zakresy, kolejne strony zachodzą na siebie o jeden wiersz', () => {
    const d = wiersze(1200);
    return readCompletePages('test', async (from, to) => ({ data: from === 0 ? d.slice(0, to + 1) : d.slice(from - 1, to), count: d.length, error: null }));
  }],
  ['po kluczu, serwer zamienił miejscami dwa wiersze strony', () => {
    const d = wiersze(1200);
    return readCompletePagesByKey('test', async (q) => ({
      data: q.head ? null : zamienione(d).filter((r) => q.afterId === null || r.id > q.afterId).slice(0, q.limit),
      count: q.count ? d.length : null,
      error: null,
    }));
  }],
  ['po kluczu, serwer pominął warunek gt i oddał stronę od początku', () => {
    const d = wiersze(1200);
    return readCompletePagesByKey('test', async (q) => ({ data: q.head ? null : d.slice(0, q.limit), count: q.count ? d.length : null, error: null }));
  }],
];

describe('NZ-WSP-08: bezpieczniki zamiast cichej niepełnej sumy', () => {
  it.each([
    // Zakresy: licznik przy każdej stronie.
    ['zakresy', 'dopisany na końcu', LICZBA],
    ['zakresy', 'dopisany w części nieprzeczytanej', LICZBA],
    ['zakresy', 'usunięty już przeczytany', LICZBA],
    ['zakresy', 'usunięty jeszcze nieprzeczytany', LICZBA],
    // Po kluczu: licznik na pierwszej stronie i licznik kontrolny na końcu. Bez
    // licznika kontrolnego trzy pierwsze przeszłyby bez wyjątku, a przy wierszu
    // dopisanym w części nieprzeczytanej wynik nie miałby ostatniego wiersza.
    ['po kluczu', 'dopisany na końcu', LICZBA],
    ['po kluczu', 'dopisany w części nieprzeczytanej', LICZBA],
    ['po kluczu', 'usunięty już przeczytany', LICZBA],
    ['po kluczu', 'usunięty jeszcze nieprzeczytany', STRONA],
  ] as const)('%s, wiersz %s po pierwszej stronie: %s', async (czytnik, zmiana, komunikat) => {
    await expect(odczytZeZmianami(czytnik, wiersze(2500), [zmiana])).rejects.toThrow(komunikat);
  });

  it.each(ZLA_KOLEJNOSC)('%s: niestabilna kolejność, nie wiersz policzony dwa razy', async (_opis, odczyt) => {
    await expect(odczyt()).rejects.toThrow(KOLEJNOSC);
  });

  it.fails('FZ-017: zakresy, usunięty wiersz już przeczytany i dopisany na końcu (liczba bez zmian) dają dziś wiersze z dwóch stanów', async () => {
    await jedenStan('zakresy', ['usunięty już przeczytany', 'dopisany na końcu']);
  });

  it.fails('FZ-017: po kluczu, usunięty wiersz już przeczytany i dopisany w części nieprzeczytanej (liczba bez zmian) dają dziś wiersze z dwóch stanów', async () => {
    await jedenStan('po kluczu', ['usunięty już przeczytany', 'dopisany w części nieprzeczytanej']);
  });
});

const KATALOG = process.cwd();
const KATALOGI = ['lib/ksiegowosc', 'lib/reports', 'lib/exports'];
type Stronicowanie = 'zakresy' | 'po kluczu';
/** Helpery, które sprawdzają komplet stron i kolejność po `id`, i jak stronicują. */
const HELPERY = new Map<string, Stronicowanie>([
  ['readCompletePages', 'zakresy'],
  ['readCompletePagesByKey', 'po kluczu'],
  ['readAllById', 'po kluczu'],
  ['readAllByIdInList', 'po kluczu'],
  ['forEachPageById', 'po kluczu'],
]);
/** Czego poza `order('id')` musi użyć zapytanie podane helperowi. */
const STRONICOWANIE: Readonly<Record<Stronicowanie, readonly RegExp[]>> = {
  zakresy: [/\.range\(/],
  'po kluczu': [/\.gt\(\s*'id'/, /\.limit\(/],
};
/** `.from` wbudowanych typów (`Array.from`, `Buffer.from`) to nie zapytanie do bazy. */
const WBUDOWANE = new Set(['Array', 'Buffer', 'Object', 'String', 'Set', 'Map', 'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array']);
const ZAPIS = new Set(['insert', 'update', 'upsert', 'delete']);
/**
 * Odczyty listy bez helpera, ograniczone z natury: `plik#funkcja:tabela`, ile
 * takich zapytań stoi w tej funkcji i dlaczego limit serwera ich nie psuje.
 */
const OGRANICZONE: Readonly<Record<string, { ile: number; powod: string }>> = {
  'lib/exports/data-fetcher.ts#attachKsefNumbers:invoices': { ile: 1, powod: 'numery KSeF po `id`, paczki po 200 (`KSEF_LOOKUP_CHUNK`)' },
  'lib/exports/data-fetcher.ts#fetchExpensesForExport:invoices': { ile: 1, powod: 'waluty faktur KSeF po `id`, paczki po 200 z `assertKsefExpensesReadyForPln`' },
  'lib/exports/data-fetcher.ts#fetchParentInvoices:invoices': { ile: 1, powod: 'faktury korygowane po `id`, paczki po 100, licznik równy paczce' },
  'lib/ksiegowosc/kpir-dane.ts#koszty:invoices': { ile: 1, powod: 'waluty faktur KSeF po `id`, paczki po 200 z `assertKsefExpensesReadyForPln`' },
  'lib/ksiegowosc/powiadomienia.ts#firmyWPilotazu:tenant_feature_flags': { ile: 1, powod: '`limit(1000)`, a 1000 i więcej firm to wyjątek (pora na fan-out)' },
  'lib/ksiegowosc/profil.ts#czytajWersjeProfilu:tax_profiles': {
    ile: 1,
    powod: 'wersje profilu firmy rosnąco, jedna na dzień `valid_from` (UNIQUE w 00166); ucięcie zabrałoby najnowsze wersje, ale dopiero przy ponad 1000 dniach ze zmianą ustawień podatkowych jednej firmy',
  },
  'lib/ksiegowosc/vat-dane.ts#nadwyzkiZatwierdzone:tax_settlements': {
    ile: 1,
    powod: 'dwa okresy, wersje malejąco: ucięcie zabiera najstarsze wersje, a cały okres zniknąłby dopiero przy ponad 1000 zatwierdzeniach drugiego okresu (wtedy nadwyżka z drugiego okresu)',
  },
  'lib/ksiegowosc/wysylka-jpk/zapis.ts#czytajWysylki:jpk_submissions': { ile: 1, powod: '`limit(100)` od najnowszej, poniżej limitu serwera' },
  'lib/reports/kpir-data.ts#getKpirData:invoices': { ile: 1, powod: 'waluty faktur KSeF po `id`, paczki po 200 z `assertKsefExpensesReadyForPln`' },
};
/** Odczyty ze znaleziska FZ-018 (otwarte), pilnowane przez `.fails` niżej. */
const FZ_018 = [
  'lib/exports/jpk-fa-readiness.ts#unsupportedDocumentReason:invoice_line_items',
  'lib/exports/jpk-fa-readiness.ts#unsupportedDocumentReason:invoices',
];

function pliki(katalog: string): string[] {
  const wynik: string[] = [];
  const idz = (k: string) => {
    for (const n of readdirSync(join(KATALOG, k))) {
      const s = join(k, n);
      if (statSync(join(KATALOG, s)).isDirectory()) idz(s);
      else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) wynik.push(s);
    }
  };
  idz(katalog);
  return wynik;
}

interface Zapytanie {
  /** `plik#funkcja najwyższego poziomu:tabela`, przy RPC `:rpc:funkcja`, przy nazwie spoza napisu `:?`. */
  klucz: string;
  linia: number;
  /** Nazwa tabeli albo funkcji spoza napisu: test nie wie, co to zapytanie czyta. */
  nieznane: boolean;
  /** Funkcja podana helperowi stronicowania, w której stoi zapytanie, i nazwa helpera; null poza helperem. */
  wHelperze: { funkcja: ts.Node; helper: string } | null;
  /** Zapis, jeden wiersz, sam licznik albo `limit(1)`. */
  ograniczone: boolean;
}

/** Zapytania `.from('tabela')` i `.rpc('funkcja')` w pliku, z łańcuchem metod aż do końca wyrażenia. */
function zapytania(sciezka: string): Zapytanie[] {
  const tekst = readFileSync(join(KATALOG, sciezka), 'utf8');
  if (!tekst.includes('.from(') && !tekst.includes('.rpc(')) return [];
  const zrodlo = ts.createSourceFile(sciezka, tekst, ts.ScriptTarget.Latest, true, sciezka.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const helper = (w: ts.Node): string | null => (ts.isCallExpression(w) && ts.isIdentifier(w.expression) && HELPERY.has(w.expression.text) ? w.expression.text : null);
  // Funkcje podane helperowi z nazwy (`readCompletePages('x', strona)`).
  const podane = new Map<string, string>();
  const zbierz = (w: ts.Node) => {
    const h = helper(w);
    if (h && ts.isCallExpression(w)) for (const a of w.arguments) if (ts.isIdentifier(a)) podane.set(a.text, h);
    ts.forEachChild(w, zbierz);
  };
  zbierz(zrodlo);
  const wynik: Zapytanie[] = [];
  const idz = (w: ts.Node) => {
    const metoda = ts.isCallExpression(w) && ts.isPropertyAccessExpression(w.expression) ? w.expression : null;
    const obiekt = metoda?.expression;
    const zapytanie = metoda && obiekt && (metoda.name.text === 'from' || metoda.name.text === 'rpc') &&
      !(ts.isIdentifier(obiekt) && WBUDOWANE.has(obiekt.text)) &&
      // `supabase.storage.from('kubeł')` to pliki, nie tabela.
      !(ts.isPropertyAccessExpression(obiekt) && obiekt.name.text === 'storage');
    if (zapytanie && ts.isCallExpression(w)) {
      const arg = w.arguments[0];
      const nazwa = arg && ts.isStringLiteralLike(arg) ? arg.text : null;
      const metody: string[] = [];
      let szczyt: ts.Node = w;
      while (ts.isPropertyAccessExpression(szczyt.parent) && szczyt.parent.expression === szczyt && ts.isCallExpression(szczyt.parent.parent)) {
        metody.push(szczyt.parent.name.text);
        szczyt = szczyt.parent.parent;
      }
      const lancuch = szczyt.getText(zrodlo);
      let funkcja = '(moduł)';
      let wHelperze: Zapytanie['wHelperze'] = null;
      for (let p: ts.Node | undefined = w.parent; p; p = p.parent) {
        if (wHelperze === null && (ts.isArrowFunction(p) || ts.isFunctionExpression(p))) {
          const h = ts.isCallExpression(p.parent) && p.parent.arguments.some((a) => a === p) ? helper(p.parent)
            : ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name) ? podane.get(p.parent.name.text) ?? null : null;
          if (h) wHelperze = { funkcja: p, helper: h };
        }
        if (ts.isFunctionDeclaration(p) && p.name && p.parent === zrodlo) funkcja = p.name.text;
        if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && p.parent.parent.parent === zrodlo) funkcja = p.name.text;
      }
      wynik.push({
        klucz: `${sciezka}#${funkcja}:${metoda.name.text === 'rpc' ? 'rpc:' : ''}${nazwa ?? '?'}`,
        linia: zrodlo.getLineAndCharacterOfPosition(w.getStart(zrodlo)).line + 1,
        nieznane: nazwa === null,
        wHelperze,
        ograniczone: metody.some((m) => ZAPIS.has(m) || m === 'single' || m === 'maybeSingle') || /head:\s*true/.test(lancuch) || /\.limit\(\s*1\s*\)/.test(lancuch),
      });
    }
    ts.forEachChild(w, idz);
  };
  idz(zrodlo);
  return wynik;
}

const ZAPYTANIA = KATALOGI.flatMap(pliki).flatMap(zapytania);
/** Odczyty listy bez helpera: klucz i ile takich zapytań. */
function listyBezHelpera(z: readonly Zapytanie[]): Record<string, number> {
  const ile: Record<string, number> = {};
  for (const q of z) if (!q.wHelperze && !q.ograniczone) ile[q.klucz] = (ile[q.klucz] ?? 0) + 1;
  return ile;
}
const wybrane = (ile: Record<string, number>, czy: (klucz: string) => boolean) => Object.fromEntries(Object.entries(ile).filter(([k]) => czy(k)));

describe('NZ-WSP-08: listy w księgowości, KPiR i eksportach czyta się stronami', () => {
  it('test widzi zapytania w każdym katalogu i w helperach (inaczej nie sprawdza niczego)', () => {
    for (const k of KATALOGI) expect(ZAPYTANIA.some((q) => q.klucz.startsWith(`${k}/`)), k).toBe(true);
    expect(ZAPYTANIA.filter((q) => q.wHelperze).length).toBeGreaterThanOrEqual(10);
  });

  it('każde zapytanie ma nazwę tabeli albo funkcji jako napis (inaczej test nie wie, co czyta)', () => {
    expect(ZAPYTANIA.filter((q) => q.nieznane).map((q) => `${q.klucz} (linia ${q.linia})`)).toEqual([]);
  });

  it('każdy odczyt listy idzie przez helper stronicowania albo jest na liście ograniczonych, policzony co do sztuki', () => {
    expect(wybrane(listyBezHelpera(ZAPYTANIA), (k) => !FZ_018.includes(k))).toEqual(
      Object.fromEntries(Object.entries(OGRANICZONE).map(([k, v]) => [k, v.ile])),
    );
  });

  it('każda funkcja podana helperowi ma jedno zapytanie, sortuje po `id` i stronicuje jak jej helper', () => {
    const funkcje = new Map<ts.Node, { helper: string; zapytania: Zapytanie[] }>();
    for (const q of ZAPYTANIA) {
      if (!q.wHelperze) continue;
      const f = funkcje.get(q.wHelperze.funkcja) ?? { helper: q.wHelperze.helper, zapytania: [] };
      f.zapytania.push(q);
      funkcje.set(q.wHelperze.funkcja, f);
    }
    const zle: string[] = [];
    for (const [funkcja, { helper, zapytania: z }] of funkcje) {
      const gdzie = `${z[0]!.klucz} (linia ${z[0]!.linia})`;
      const kod = funkcja.getText();
      if (z.length !== 1) zle.push(`${gdzie}: ${z.length} zapytania w jednej funkcji strony`);
      if (!/\.order\(\s*'id'/.test(kod)) zle.push(`${gdzie}: bez order('id')`);
      for (const wzor of STRONICOWANIE[HELPERY.get(helper)!]) if (!wzor.test(kod)) zle.push(`${gdzie}: bez ${wzor.source}`);
    }
    expect(zle).toEqual([]);
  });

  it.fails('FZ-018: jpk-fa-readiness czyta faktury i pozycje okresu własnymi stronami po 1000 bez licznika, więc limit serwera poniżej 1000 albo zapis w trakcie dają cichą niepełną listę', () => {
    expect(wybrane(listyBezHelpera(ZAPYTANIA), (k) => FZ_018.includes(k))).toEqual({});
  });
});
