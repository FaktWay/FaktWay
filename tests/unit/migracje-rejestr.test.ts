import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { headerOf } from '@/scripts/ci/migracje-niewgrane.mjs';

/**
 * Strażnik migracji (plan usprawnień 2.6). Zasady z
 * docs/runbooks/wgrywanie-migracji.md sprawdza automat zamiast reguły
 * w prompcie:
 *
 * - nazwa `NNNNN_nazwa.sql`, numery unikalne (kolizję dwóch PR rozstrzyga
 *   kolejka scalania tym testem na commicie grupy: przegrany PR zmienia numer;
 *   wolny numer daje `node scripts/dev/nastepna-migracja.mjs`);
 * - numery 00083-00206 mają wiersz w rejestrze (docs/koordynacja/CLAUDE-DO-CODEXA.md,
 *   „Rejestr numerów migracji”), który jest od 00207 zamrożoną historią: wspólna
 *   tabela była źródłem konfliktów, bo każdy PR z migracją dopisywał do niej
 *   wiersz w tym samym miejscu;
 * - nowe migracje (od 00164) mówią w nagłówku, czy wgrać je przed, czy PO
 *   wdrożeniu, a `DROP TABLE`/`DROP COLUMN`/`TRUNCATE`/`DELETE FROM` poza
 *   ciałami funkcji opisują w linii `-- DROP/DML: …` (zgoda Bartosza);
 * - od 00207 nagłówek ma jawną linię `-- KIEDY WGRAĆ: PRZED wdrożeniem …` albo
 *   `-- KIEDY WGRAĆ: PO wdrożeniu …`: to jedyne miejsce, w którym migracja mówi
 *   o swoim stanie (czyta ją też `scripts/ci/migracje-niewgrane.mjs`). Stan
 *   „wgrana na db-1” jest w `supabase_migrations.schema_migrations`, nie w repo.
 */

const ROOT = process.cwd();
const DIR = join(ROOT, 'supabase/migrations');
const REGISTRY = join(ROOT, 'docs/koordynacja/CLAUDE-DO-CODEXA.md');
/** Od tego numeru zaczyna się rejestr (wcześniejsze sprzed rejestru). */
const REGISTRY_FROM = 83;
/** Ostatni numer z wierszem w rejestrze; od następnego tabela jest zamrożona. */
const REGISTRY_UNTIL = 206;
/** Numer spoza kolejności z audytu bloku 1. */
const OUT_OF_ORDER = new Set([200]);
/** Pierwszy numer objęty zasadami nagłówka (starsze bywały bez niego). */
const HEADER_RULES_FROM = 164;
/** Pierwszy numer z jawną linią „KIEDY WGRAĆ” w nagłówku. */
const WHEN_LINE_FROM = 207;
/** `-- KIEDY WGRAĆ: PRZED wdrożeniem …` albo `-- KIEDY WGRAĆ: PO wdrożeniu …` (dozwolone bez ogonków). */
const WHEN_LINE = /^--\s*KIEDY\s+WGRA[ĆC]:\s*(?:PRZED|PO)\s+wdro[żz]eni/m;

interface Migration {
  file: string;
  number: number;
  sql: string;
}

function parseRegistry(text: string): Set<number> {
  const start = text.indexOf('## Rejestr numerów migracji');
  if (start < 0) throw new Error('Brak sekcji „Rejestr numerów migracji” w CLAUDE-DO-CODEXA.md');
  const rest = text.slice(start);
  const end = rest.search(/\n---\n|\n## (?!Rejestr)/);
  const section = end > 0 ? rest.slice(0, end) : rest;
  const covered = new Set<number>();
  for (const line of section.split('\n')) {
    const cell = /^\|\s*\**(\d{5})(?:\s*[–-]\s*(\d{5}))?\**\s*\|/.exec(line);
    if (!cell) continue;
    const from = Number(cell[1]);
    const to = cell[2] ? Number(cell[2]) : from;
    for (let n = from; n <= to; n += 1) covered.add(n);
  }
  return covered;
}

/** Komentarze nagłówka (`--` na początku linii). */
const headerOfAll = (sql: string) => sql.split('\n').filter((line) => line.trimStart().startsWith('--')).join('\n');
/** Kod wykonywany przy wgraniu: bez komentarzy i bez ciał funkcji `$…$`. */
const outsideBodies = (sql: string) => sql.replace(/--[^\n]*/g, '').replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, '');

export function migrationProblems(files: string[], read: (file: string) => string, registryText: string): string[] {
  const problems: string[] = [];
  const migrations: Migration[] = [];
  for (const file of files) {
    const m = /^(\d{5})_[a-z0-9_]+\.sql$/.exec(file);
    if (!m) {
      problems.push(`${file}: nazwa poza wzorcem NNNNN_nazwa.sql (małe litery, cyfry, _)`);
      continue;
    }
    migrations.push({ file, number: Number(m[1]), sql: read(file) });
  }

  const byNumber = new Map<number, string[]>();
  for (const { number, file } of migrations) byNumber.set(number, [...(byNumber.get(number) ?? []), file]);
  for (const [number, names] of byNumber) {
    if (names.length > 1) {
      problems.push(
        `numer ${String(number).padStart(5, '0')} użyty ${names.length} razy: ${names.join(', ')}; ` +
          'zmień numer swojego pliku na wynik `node scripts/dev/nastepna-migracja.mjs` (po `git merge origin/main`)',
      );
    }
  }

  const covered = parseRegistry(registryText);
  for (const { number, file } of migrations) {
    if (number >= REGISTRY_FROM && number <= REGISTRY_UNTIL && !covered.has(number)) {
      problems.push(`${file}: brak wiersza w rejestrze (docs/koordynacja/CLAUDE-DO-CODEXA.md, zamrożony od 00207)`);
    }
  }

  for (const { number, file, sql } of migrations) {
    if (number < HEADER_RULES_FROM || OUT_OF_ORDER.has(number)) continue;
    const header = headerOfAll(sql);
    if (!/(przed|po)\s+wdro[żz]eni|bez\s+wdro[żz]enia/i.test(header)) {
      problems.push(`${file}: nagłówek nie mówi, czy wgrać PRZED, czy PO wdrożeniu`);
    }
    if (number >= WHEN_LINE_FROM && !WHEN_LINE.test(headerOf(sql))) {
      problems.push(
        `${file}: nagłówek (komentarze na samym początku pliku) ma mieć linię „-- KIEDY WGRAĆ: PRZED wdrożeniem …” albo „-- KIEDY WGRAĆ: PO wdrożeniu …”`,
      );
    }
    if (/\b(DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM)\b/i.test(outsideBodies(sql)) && !/^\s*--\s*DROP\/DML:\s*\S/im.test(sql)) {
      problems.push(`${file}: DROP TABLE/DROP COLUMN/TRUNCATE/DELETE FROM przy wgraniu wymaga linii „-- DROP/DML: co i dlaczego” i zgody Bartosza`);
    }
  }
  return problems;
}

describe('strażnik migracji: rejestr i nagłówki', () => {
  it('migracje w repo spełniają zasady rejestru', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(migrationProblems(files, (f) => readFileSync(join(DIR, f), 'utf8'), readFileSync(REGISTRY, 'utf8'))).toEqual([]);
  });

  const registry = (rows: string) => `## Rejestr numerów migracji\n\n| Numer | Kto | Plik | Stan |\n|---|---|---|---|\n${rows}\n\n---\n`;
  const good = '-- PRZED wdrożeniem (addytywna)\nCREATE TABLE public.x (id int);\n';
  /** Nagłówek od 00207: jawna linia „KIEDY WGRAĆ” (czyta ją nocne wdrożenie i `migracje-niewgrane.mjs`). */
  const goodNew = '-- KIEDY WGRAĆ: PRZED wdrożeniem kodu (addytywna: nowa tabela).\nCREATE TABLE public.x (id int);\n';
  const check = (files: Record<string, string>, rows: string) =>
    migrationProblems(Object.keys(files), (f) => files[f]!, registry(rows));

  it('przechodzi poprawna migracja z wierszem w rejestrze (zamrożona historia do 00206)', () => {
    expect(check({ '00164_x.sql': good }, '| 00164 | Claude | `x` | PR |')).toEqual([]);
  });

  it('od 00207 migracja nie ma wiersza w rejestrze: wystarcza linia „KIEDY WGRAĆ” w nagłówku', () => {
    expect(check({ '00207_x.sql': goodNew }, '')).toEqual([]);
    expect(check({ '00207_x.sql': goodNew.replace('PRZED wdrożeniem kodu', 'PO wdrożeniu kodu') }, '')).toEqual([]);
  });

  it('dwa PR z migracją nie kłócą się o rejestr: różne numery od 00207 przechodzą bez żadnej edycji tabeli', () => {
    expect(check({ '00207_a.sql': goodNew, '00208_b.sql': goodNew }, '')).toEqual([]);
  });

  it.each([
    ['dwa pliki z tym samym numerem', { '00164_a.sql': good, '00164_b.sql': good }, '| 00164 | C | `a` | PR |', /użyty 2 razy[\s\S]*nastepna-migracja\.mjs/],
    ['dwa pliki od 00207 z tym samym numerem (kolizja dwóch PR)', { '00207_a.sql': goodNew, '00207_b.sql': goodNew }, '', /użyty 2 razy[\s\S]*nastepna-migracja\.mjs/],
    ['brak wiersza w rejestrze (numer do 00206)', { '00164_x.sql': good }, '', /brak wiersza w rejestrze/],
    ['zła nazwa pliku', { '00164-X.sql': good }, '', /poza wzorcem/],
    ['nagłówek bez „przed/PO wdrożeniu”', { '00164_x.sql': '-- nowa tabela\nCREATE TABLE x (id int);\n' }, '| 00164 | C | `x` | PR |', /PRZED, czy PO/],
    ['od 00207 nagłówek ze starym zapisem bez linii „KIEDY WGRAĆ”', { '00207_x.sql': good }, '', /KIEDY WGRAĆ: PRZED wdrożeniem|KIEDY WGRAĆ: PO wdrożeniu/],
    ['od 00207 „KIEDY WGRAĆ” bez PRZED ani PO', { '00207_x.sql': '-- KIEDY WGRAĆ: kiedyś\nCREATE TABLE public.x (id int);\n' }, '', /KIEDY WGRAĆ: PRZED wdrożeniem|KIEDY WGRAĆ: PO wdrożeniu/],
    ['od 00207 linia „KIEDY WGRAĆ” dopiero w treści, nie w nagłówku', { '00207_x.sql': 'CREATE TABLE public.x (id int);\n-- KIEDY WGRAĆ: PRZED wdrożeniem\n' }, '', /KIEDY WGRAĆ: PRZED wdrożeniem|KIEDY WGRAĆ: PO wdrożeniu/],
    ['DELETE FROM przy wgraniu bez opisu', { '00164_x.sql': `${good}DELETE FROM public.x;\n` }, '| 00164 | C | `x` | PR |', /DROP\/DML/],
    ['od 00207 DELETE FROM przy wgraniu bez opisu', { '00207_x.sql': `${goodNew}DELETE FROM public.x;\n` }, '', /DROP\/DML/],
  ])('wyłapuje: %s', (_name, files, rows, expected) => {
    expect(check(files, rows).join('\n')).toMatch(expected);
  });

  it('DELETE w ciele funkcji i DROP z opisem przechodzą', () => {
    const body = `${good}CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $$ DELETE FROM public.x $$;\n`;
    const described = `-- PO wdrożeniu\n-- DROP/DML: stara kolumna, kod jej nie czyta od #400; zgoda Bartosza 05.11\nALTER TABLE x DROP COLUMN y;\n`;
    expect(check({ '00164_x.sql': body, '00165_y.sql': described }, '| 00164–00165 | C | `x`, `y` | PR |')).toEqual([]);
  });

  it('rejestr w repo nie ma już wiersza „następny wolny” (numer wylicza scripts/dev/nastepna-migracja.mjs)', () => {
    expect(readFileSync(REGISTRY, 'utf8')).not.toMatch(/^\| \*\*\d{5}\*\* \| — \| następny wolny/m);
  });
});
