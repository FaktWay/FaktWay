#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════
// Kontrola migracji przed wgraniem na produkcję (db-1) — TYLKO ODCZYT
// ────────────────────────────────────────────────────────────────
// Automat (nocne wdrożenie, `wgraj-migracje.sh`) wgrywa migrację sam tylko
// wtedy, gdy ta kontrola ją przepuści. To zastępuje „pytam Bartosza” przy
// migracjach addytywnych; operacje, które mogą zgubić dane albo zepsuć stary
// kod, zostają ręczne (docs/runbooks/wgrywanie-migracji.md, zasada 4).
//
//   node scripts/ops/kontrola-migracji.mjs --git <ref> 00207 00208   # pliki z gita
//   node scripts/ops/kontrola-migracji.mjs --plik a.sql b.sql        # pliki z dysku
//   ... --json                                                        # wynik dla skryptów
//   ... --bez-fazy                                                    # nie wymaga nagłówka fazy (wgranie ręczne)
//
// Kod wyjścia: 0 = wszystkie przechodzą i kolejność jest poprawna,
// 3 = blokada (migracja albo kolejność), 2 = błąd użycia.
//
// Co kontrola ocenia (po usunięciu komentarzy, tekstów w apostrofach i ciał
// funkcji `$$…$$`, które przy wgraniu się nie wykonują; ciało bloku `DO`
// wykonuje się od razu, więc je czyta):
//   - nazwa pliku `NNNNN_nazwa.sql`;
//   - oznaczenie fazy w nagłówku: `-- Wdrożenie: PRZED|PO …` albo starsze
//     `-- KIEDY WGRAĆ: PRZED|PO …`; brak albo sprzeczność = blokada;
//   - zakazane bez człowieka: DROP TABLE/SCHEMA/DATABASE/ROLE/TYPE/SEQUENCE/
//     EXTENSION, DROP COLUMN, TRUNCATE, DELETE FROM, UPDATE na wierszach,
//     RENAME w ALTER TABLE, zmiana typu kolumny, wyłączenie RLS,
//     SUPERUSER/BYPASSRLS, ALTER SYSTEM, COPY … PROGRAM;
//   - kolejność: gdy w zbiorze jest migracja „PO wdrożeniu”, żadna późniejsza
//     numerem nie może być „PRZED” (nie da się zachować kolejności numerów).
// Dozwolone (wzorce addytywne i zastępowanie): CREATE …, ALTER TABLE ADD,
// DROP CONSTRAINT/NOT NULL/DEFAULT/POLICY/TRIGGER/FUNCTION/INDEX/VIEW,
// GRANT/REVOKE, INSERT, COMMENT.

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const NAZWA_PLIKU = /^(\d{5})_[a-z0-9_]+\.sql$/;

/**
 * Usuwa to, co przy wgraniu niczego nie robi: komentarze liniowe i blokowe,
 * treść tekstów w apostrofach i cudzysłowach oraz ciała `$tag$…$tag$` poza
 * blokami `DO`. Zwraca tekst do szukania instrukcji.
 */
export function oczyscSql(sql) {
  let wynik = '';
  let i = 0;
  const n = sql.length;
  // Początek bieżącej instrukcji w `wynik` (po ostatnim `;`), do rozpoznania `DO`.
  const poczatekInstrukcji = () => {
    const ost = wynik.lastIndexOf(';');
    return wynik.slice(ost + 1).trimStart();
  };
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if (c === '-' && d === '-') {
      while (i < n && sql[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && d === '*') {
      let glebokosc = 1;
      i += 2;
      while (i < n && glebokosc > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          glebokosc += 1;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          glebokosc -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      wynik += ' ';
      continue;
    }
    if (c === "'") {
      const eskejp = /[eE]$/.test(wynik) && !/[\w]$/.test(wynik.slice(0, -1));
      i += 1;
      while (i < n) {
        if (eskejp && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      wynik += "''";
      continue;
    }
    if (c === '"') {
      i += 1;
      while (i < n && !(sql[i] === '"' && sql[i + 1] !== '"')) i += sql[i] === '"' ? 2 : 1;
      i += 1;
      wynik += '"x"';
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 80));
      if (m) {
        const znacznik = m[0];
        const koniec = sql.indexOf(znacznik, i + znacznik.length);
        const cialo = koniec < 0 ? sql.slice(i + znacznik.length) : sql.slice(i + znacznik.length, koniec);
        const jestDo = /^DO\b/i.test(poczatekInstrukcji());
        wynik += jestDo ? ` ${oczyscSql(cialo)} ` : ' $$ ';
        i = koniec < 0 ? n : koniec + znacznik.length;
        continue;
      }
    }
    wynik += c;
    i += 1;
  }
  return wynik;
}

/** Instrukcje po oczyszczeniu: osobno, z ściśniętymi białymi znakami. */
export function instrukcje(sql) {
  return oczyscSql(sql)
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Pierwszy blok komentarzy pliku (nagłówek migracji). */
export function naglowek(sql) {
  const linie = [];
  for (const linia of sql.split('\n')) {
    const t = linia.trim();
    if (t === '') {
      if (linie.length === 0) continue;
      break;
    }
    if (!t.startsWith('--')) break;
    linie.push(t.replace(/^--+\s?/, ''));
  }
  return linie.join('\n');
}

/** `przed`, `po`, `niejednoznaczna` albo `null` (brak oznaczenia). */
export function faza(sql) {
  const g = naglowek(sql);
  const jawna = /(?:KIEDY\s+WGRA[ĆC]|WDRO[ŻZ]ENIE)\s*:\s*\**\s*(PRZED|PO)\b/i.exec(g);
  if (jawna) return jawna[1].toUpperCase() === 'PO' ? 'po' : 'przed';
  const przed = /\bPRZED\s+wdro[żz]eniem\b/i.test(g);
  const po = /\bPO\s+wdro[żz]eniu\b/i.test(g);
  if (przed && po) return 'niejednoznaczna';
  if (przed) return 'przed';
  if (po) return 'po';
  return null;
}

const NAZWA = String.raw`(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?[\w."]+`;

/** Reguły: [identyfikator, wyrażenie na instrukcji zaczynającej się od słowa, wyrażenie wewnątrz bloku DO]. */
const REGULY = [
  ['DROP TABLE/SCHEMA/DATABASE/ROLE/TYPE/SEQUENCE/EXTENSION', /^DROP\s+(?:TABLE|SCHEMA|DATABASE|ROLE|USER|TYPE|SEQUENCE|EXTENSION|OWNED)\b/i, /\bDROP\s+(?:TABLE|SCHEMA|DATABASE|ROLE|USER|TYPE|SEQUENCE|EXTENSION|OWNED)\b/i],
  ['DROP COLUMN', /^ALTER\s+TABLE\b.*\bDROP\s+(?:COLUMN\b|(?!CONSTRAINT\b|NOT\b|DEFAULT\b|IDENTITY\b|EXPRESSION\b)\w)/i, /\bDROP\s+COLUMN\b/i],
  ['TRUNCATE', /^TRUNCATE\b/i, /\bTRUNCATE\b/i],
  ['DELETE FROM', /^DELETE\s+FROM\b/i, /\bDELETE\s+FROM\b/i],
  ['UPDATE na wierszach', new RegExp(String.raw`^UPDATE\s+${NAZWA}(?:\s+(?:AS\s+)?\w+)?\s+SET\b`, 'i'), new RegExp(String.raw`\bUPDATE\s+${NAZWA}(?:\s+(?:AS\s+)?\w+)?\s+SET\b`, 'i')],
  ['RENAME w ALTER TABLE', /^ALTER\s+TABLE\b.*\bRENAME\b/i, /\bALTER\s+TABLE\b.*\bRENAME\b/i],
  ['zmiana typu kolumny', /^ALTER\s+TABLE\b.*\bALTER\s+COLUMN\b.*\b(?:SET\s+DATA\s+)?TYPE\b/i, /\bALTER\s+COLUMN\b.*\bTYPE\b/i],
  ['wyłączenie RLS', /^ALTER\s+TABLE\b.*\b(?:DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY\b/i, /\b(?:DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY\b/i],
  ['SUPERUSER/BYPASSRLS', /^(?:CREATE|ALTER)\s+(?:ROLE|USER)\b.*\b(?:SUPERUSER|BYPASSRLS)\b/i, /\b(?:SUPERUSER|BYPASSRLS)\b/i],
  ['ALTER SYSTEM', /^ALTER\s+SYSTEM\b/i, /\bALTER\s+SYSTEM\b/i],
  ['COPY … PROGRAM', /^COPY\b.*\bPROGRAM\b/i, /\bCOPY\b.*\bPROGRAM\b/i],
];

/** Powody blokady jednej migracji (puste = przechodzi), bez sprawdzania fazy. */
export function blokadyZapisu(sql) {
  const powody = new Set();
  for (const ins of instrukcje(sql)) {
    const wDo = /^DO\b/i.test(ins);
    for (const [nazwa, wzorzecPoczatek, wzorzecWewnatrz] of REGULY) {
      if ((wDo ? wzorzecWewnatrz : wzorzecPoczatek).test(ins)) powody.add(nazwa);
    }
  }
  return [...powody];
}

/**
 * Ocena jednej migracji: `{numer, plik, faza, powody}`. `powody` puste =
 * automat może ją wgrać.
 */
export function ocenMigracje(plik, sql, opcje = {}) {
  const m = NAZWA_PLIKU.exec(plik);
  const powody = [];
  if (!m) powody.push(`nazwa „${plik}” poza wzorcem NNNNN_nazwa.sql`);
  const f = faza(sql);
  // `bezFazy`: wgranie ręczne (`wgraj-migracje.sh`) nie ustala kolejności względem
  // kodu, więc nagłówka nie wymaga; nocne wdrożenie wymaga.
  if (!opcje.bezFazy) {
    if (f === null) powody.push('brak oznaczenia fazy w nagłówku (`-- Wdrożenie: PRZED` albo `PO`)');
    if (f === 'niejednoznaczna') powody.push('nagłówek mówi i „PRZED wdrożeniem”, i „PO wdrożeniu”: dopisz jedną linię `-- Wdrożenie: PRZED` albo `PO`');
  }
  for (const p of blokadyZapisu(sql)) powody.push(`zakazane bez człowieka: ${p}`);
  return { numer: m ? m[1] : null, plik, faza: f === 'przed' || f === 'po' ? f : null, powody };
}

/**
 * Plan dla zbioru oczekujących migracji: `{przed, po, zablokowane, kolejnosc}`.
 * `migracje` to `[{plik, sql}]` w dowolnej kolejności.
 */
export function planMigracji(migracje, opcje = {}) {
  const oceny = migracje.map((m) => ocenMigracje(m.plik, m.sql, opcje)).sort((a, b) => a.plik.localeCompare(b.plik));
  const zablokowane = oceny.filter((o) => o.powody.length > 0).map((o) => ({ numer: o.numer, plik: o.plik, powody: o.powody }));
  const przed = oceny.filter((o) => o.powody.length === 0 && o.faza === 'przed').map((o) => o.numer);
  const po = oceny.filter((o) => o.powody.length === 0 && o.faza === 'po').map((o) => o.numer);
  // Kolejność numerów musi dać się zachować: wszystkie PRZED przed kodem,
  // wszystkie PO po kodzie. PRZED o numerze wyższym niż jakakolwiek PO ją łamie.
  let kolejnosc = null;
  const pierwszaPo = oceny.find((o) => o.faza === 'po');
  if (pierwszaPo) {
    const pozniej = oceny.find((o) => o.faza === 'przed' && o.plik > pierwszaPo.plik);
    if (pozniej) {
      kolejnosc = `migracja ${pozniej.numer} („PRZED”) ma wyższy numer niż ${pierwszaPo.numer} („PO wdrożeniu”): kolejności numerów nie da się zachować przy jednym wdrożeniu`;
    }
  }
  return { przed, po, zablokowane, kolejnosc };
}

function uzycie() {
  process.stderr.write(
    'Użycie:\n  node scripts/ops/kontrola-migracji.mjs [--json] [--bez-fazy] --git <ref> <numer...>\n  node scripts/ops/kontrola-migracji.mjs [--json] [--bez-fazy] --plik <plik.sql...>\n',
  );
  process.exit(2);
}

function wczytajZGita(ref, numery) {
  const lista = execFileSync('git', ['ls-tree', '--name-only', ref, 'supabase/migrations/'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  return numery.map((numer) => {
    if (!/^\d{5}$/.test(numer)) throw new Error(`niepoprawny numer migracji: ${numer}`);
    const trafione = lista.filter((s) => basename(s).startsWith(`${numer}_`));
    if (trafione.length !== 1) throw new Error(`migracja ${numer}: oczekiwałem jednego pliku w ${ref}, znalazłem ${trafione.length}`);
    return { plik: basename(trafione[0]), sql: execFileSync('git', ['show', `${ref}:${trafione[0]}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) };
  });
}

function main(argv) {
  const json = argv.includes('--json');
  const bezFazy = argv.includes('--bez-fazy');
  const reszta = argv.filter((a) => a !== '--json' && a !== '--bez-fazy');
  const tryb = reszta[0];
  let migracje;
  try {
    if (tryb === '--git' && reszta.length >= 3) migracje = wczytajZGita(reszta[1], reszta.slice(2));
    else if (tryb === '--plik' && reszta.length >= 2) migracje = reszta.slice(1).map((s) => ({ plik: basename(s), sql: readFileSync(s, 'utf8') }));
    else uzycie();
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
  const plan = planMigracji(migracje, { bezFazy });
  if (json) {
    process.stdout.write(`${JSON.stringify(plan)}\n`);
  } else {
    for (const num of plan.przed) process.stdout.write(`${num}\tprzed\tOK\n`);
    for (const num of plan.po) process.stdout.write(`${num}\tpo\tOK\n`);
    for (const z of plan.zablokowane) process.stdout.write(`${z.numer ?? z.plik}\t-\tZABLOKOWANA\t${z.powody.join('; ')}\n`);
    if (plan.kolejnosc) process.stdout.write(`KOLEJNOŚĆ\t${plan.kolejnosc}\n`);
  }
  process.exit(plan.zablokowane.length > 0 || plan.kolejnosc ? 3 : 0);
}

// Uruchomiony wprost? Porównanie przez realpath: ścieżka z dowiązaniem (macOS: /var → /private/var)
// dawałaby różne adresy i skrypt kończyłby się po cichu, bez wyniku.
const uruchomionyWprost = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
})();
if (uruchomionyWprost) main(process.argv.slice(2));
