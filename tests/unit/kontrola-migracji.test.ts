import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { blokadyZapisu, faza, instrukcje, naglowek, ocenMigracje, oczyscSql, planMigracji } from '@/scripts/ops/kontrola-migracji.mjs';

/**
 * Kontrola migracji przed automatycznym wgraniem (nocne wdrożenie,
 * `wgraj-migracje.sh`). Automat wgrywa tylko to, co ta kontrola przepuści;
 * reszta zostaje ręczna (docs/runbooks/wgrywanie-migracji.md, zasada 4).
 */

const SKRYPT = resolve(__dirname, '../../scripts/ops/kontrola-migracji.mjs');
const MIGRACJE = resolve(__dirname, '../../supabase/migrations');
const NAGL_PRZED = '-- 00300: test\n--\n-- Wdrożenie: PRZED kodu. Addytywna.\n\n';
const NAGL_PO = '-- 00301: test\n--\n-- Wdrożenie: PO wdrożeniu kodu.\n\n';

const zablokowane = (sql: string) => blokadyZapisu(NAGL_PRZED + sql);

describe('oczyszczanie SQL', () => {
  it('usuwa komentarze liniowe i blokowe, także zagnieżdżone', () => {
    const sql = "SELECT 1; -- DELETE FROM x;\n/* DROP TABLE a; /* DROP TABLE b; */ DROP TABLE c; */ SELECT 2;";
    expect(instrukcje(sql)).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('usuwa treść tekstów w apostrofach, też z podwojonym apostrofem i ucieczką E', () => {
    const sql = "COMMENT ON TABLE t IS 'DROP TABLE x; DELETE FROM y; it''s';\nSELECT E'a\\'b DELETE FROM z';";
    expect(instrukcje(sql)).toEqual(["COMMENT ON TABLE t IS ''", "SELECT E''"]);
  });

  it('pomija ciało funkcji, ale czyta ciało bloku DO (wykonuje się przy wgraniu)', () => {
    const funkcja = 'CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN DELETE FROM t; UPDATE t SET a = 1; END $$;';
    expect(oczyscSql(funkcja)).not.toMatch(/DELETE|UPDATE/);
    const blok = 'DO $do$ BEGIN DELETE FROM t; END $do$;';
    expect(oczyscSql(blok)).toMatch(/DELETE FROM t/);
  });

  it('nie bierze parametrów $1 za ciało w dolarach', () => {
    expect(instrukcje('SELECT $1, $2; DELETE FROM t;')).toEqual(['SELECT $1, $2', 'DELETE FROM t']);
  });
});

describe('nagłówek i faza', () => {
  it('bierze tylko pierwszy blok komentarzy', () => {
    const sql = '-- jedna\n-- dwie\n\nSELECT 1;\n-- Wdrożenie: PO\n';
    expect(naglowek(sql)).toBe('jedna\ndwie');
  });

  it.each([
    ['-- Wdrożenie: PRZED kodu\nSELECT 1;', 'przed'],
    ['-- Wdrożenie: PO wdrożeniu\nSELECT 1;', 'po'],
    ['-- KIEDY WGRAĆ: PRZED wdrożeniem kodu z tego PR. Addytywna.\nSELECT 1;', 'przed'],
    ['-- KIEDY WGRAĆ: PO wdrożeniu, bo odbiera uprawnienie.\nSELECT 1;', 'po'],
    ['-- KIEDY WGRAĆ: po wdrożeniu\nSELECT 1;', 'po'],
    ['-- Migracja trzeba wgrać PRZED wdrożeniem.\nSELECT 1;', 'przed'],
    ['-- Wgraj PO wdrożeniu kodu.\nSELECT 1;', 'po'],
    ['-- Wgraj PRZED wdrożeniem, nie PO wdrożeniu.\nSELECT 1;', 'niejednoznaczna'],
    ['-- bez słowa o kolejności\nSELECT 1;', null],
    ['SELECT 1;', null],
  ])('faza %j = %s', (sql, oczekiwana) => {
    expect(faza(sql)).toBe(oczekiwana);
  });

  it('jawna linia ma pierwszeństwo przed zdaniami opisu', () => {
    const sql = '-- Wdrożenie: PRZED\n-- Opis: stary kod działa także PO wdrożeniu.\nSELECT 1;';
    expect(faza(sql)).toBe('przed');
  });
});

describe('blokady zapisu: zakazane bez człowieka', () => {
  it.each([
    ['DROP TABLE public.t;', 'DROP TABLE/SCHEMA/DATABASE/ROLE/TYPE/SEQUENCE/EXTENSION'],
    ['DROP TABLE IF EXISTS public.t CASCADE;', 'DROP TABLE/SCHEMA/DATABASE/ROLE/TYPE/SEQUENCE/EXTENSION'],
    ['DROP SCHEMA ops CASCADE;', 'DROP TABLE/SCHEMA/DATABASE/ROLE/TYPE/SEQUENCE/EXTENSION'],
    ['DROP TYPE foo;', 'DROP TABLE/SCHEMA/DATABASE/ROLE/TYPE/SEQUENCE/EXTENSION'],
    ['ALTER TABLE t DROP COLUMN a;', 'DROP COLUMN'],
    ['ALTER TABLE t DROP COLUMN IF EXISTS a;', 'DROP COLUMN'],
    ['ALTER TABLE t DROP a;', 'DROP COLUMN'],
    ['ALTER TABLE t DROP CONSTRAINT c, DROP COLUMN a;', 'DROP COLUMN'],
    ['TRUNCATE t;', 'TRUNCATE'],
    ['TRUNCATE TABLE t RESTART IDENTITY;', 'TRUNCATE'],
    ['DELETE FROM t WHERE a = 1;', 'DELETE FROM'],
    ['UPDATE t SET a = 1;', 'UPDATE na wierszach'],
    ['UPDATE public.t AS x SET a = 1 WHERE x.id = 2;', 'UPDATE na wierszach'],
    ['UPDATE ONLY t SET a = 1;', 'UPDATE na wierszach'],
    ['ALTER TABLE t RENAME COLUMN a TO b;', 'RENAME w ALTER TABLE'],
    ['ALTER TABLE t RENAME TO u;', 'RENAME w ALTER TABLE'],
    ['ALTER TABLE t ALTER COLUMN a TYPE bigint;', 'zmiana typu kolumny'],
    ['ALTER TABLE t ALTER COLUMN a SET DATA TYPE text;', 'zmiana typu kolumny'],
    ['ALTER TABLE t DISABLE ROW LEVEL SECURITY;', 'wyłączenie RLS'],
    ['ALTER TABLE t NO FORCE ROW LEVEL SECURITY;', 'wyłączenie RLS'],
    ['CREATE ROLE r LOGIN SUPERUSER;', 'SUPERUSER/BYPASSRLS'],
    ['ALTER ROLE r BYPASSRLS;', 'SUPERUSER/BYPASSRLS'],
    ["ALTER SYSTEM SET work_mem = '1GB';", 'ALTER SYSTEM'],
    ["COPY t FROM PROGRAM 'ls';", 'COPY … PROGRAM'],
  ])('%s', (sql, powod) => {
    expect(zablokowane(sql)).toContain(powod);
  });

  it('blokuje też operację ukrytą w bloku DO', () => {
    expect(zablokowane('DO $$ BEGIN DELETE FROM t WHERE a = 1; END $$;')).toContain('DELETE FROM');
    expect(zablokowane('DO $$ BEGIN UPDATE t SET a = 1; END $$;')).toContain('UPDATE na wierszach');
    expect(zablokowane('DO $$ BEGIN ALTER TABLE t DROP COLUMN a; END $$;')).toContain('DROP COLUMN');
    expect(zablokowane("DO $$ BEGIN EXECUTE 'DROP TABLE t'; END $$;")).toContain('EXECUTE w bloku DO (dynamiczny SQL)');
  });
});

describe('blokady zapisu: dozwolone wzorce addytywne i zastępowanie', () => {
  it.each([
    'CREATE TABLE public.t (id uuid PRIMARY KEY);',
    'CREATE TABLE IF NOT EXISTS public.t (id uuid);',
    'ALTER TABLE t ADD COLUMN a text;',
    'ALTER TABLE t ADD CONSTRAINT c CHECK (a > 0);',
    'ALTER TABLE t DROP CONSTRAINT IF EXISTS c;',
    'ALTER TABLE t ALTER COLUMN a DROP NOT NULL;',
    'ALTER TABLE t ALTER COLUMN a DROP DEFAULT;',
    'ALTER TABLE t ALTER COLUMN a SET DEFAULT 1;',
    'ALTER TABLE t ENABLE ROW LEVEL SECURITY;',
    'DROP POLICY IF EXISTS p ON t;',
    'DROP TRIGGER IF EXISTS tr ON t;',
    'DROP FUNCTION IF EXISTS f(int);',
    'DROP INDEX IF EXISTS i;',
    'DROP VIEW IF EXISTS v;',
    'GRANT SELECT, UPDATE (a) ON t TO authenticated;',
    'REVOKE UPDATE ON t FROM authenticated;',
    'CREATE POLICY p ON t FOR UPDATE USING (true) WITH CHECK (true);',
    'CREATE TRIGGER tr BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION f();',
    'CREATE TRIGGER tr AFTER DELETE ON t FOR EACH ROW EXECUTE FUNCTION f();',
    'ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES u (id) ON DELETE CASCADE ON UPDATE CASCADE;',
    'INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET b = 2;',
    "INSERT INTO global_feature_flags (flag, enabled) VALUES ('x', false) ON CONFLICT DO NOTHING;",
    "COMMENT ON TABLE t IS 'Zawiera DELETE FROM i DROP TABLE tylko w opisie';",
    'CREATE OR REPLACE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN DELETE FROM t; UPDATE t SET a = 1; TRUNCATE t; END $$;',
    "NOTIFY pgrst, 'reload schema';",
  ])('przepuszcza %s', (sql) => {
    expect(zablokowane(sql)).toEqual([]);
  });

  it('komentarz z zakazaną frazą w nagłówku nie blokuje', () => {
    const sql = '-- Wdrożenie: PRZED. Bez DROP tabel i kolumn, bez TRUNCATE, bez DELETE FROM.\n\nCREATE TABLE t (id int);';
    expect(blokadyZapisu(sql)).toEqual([]);
  });
});

describe('ocena jednej migracji', () => {
  it('przepuszcza migrację addytywną z oznaczoną fazą', () => {
    const o = ocenMigracje('00300_dodaj_tabele.sql', `${NAGL_PRZED}CREATE TABLE t (id int);`);
    expect(o).toMatchObject({ numer: '00300', faza: 'przed', powody: [] });
  });

  it('blokuje brak oznaczenia fazy, bo bez niej nie wiadomo, czy wgrać przed kodem', () => {
    const o = ocenMigracje('00300_x.sql', '-- opis\nCREATE TABLE t (id int);');
    expect(o.powody.join(' ')).toMatch(/brak oznaczenia fazy/);
  });

  it('blokuje sprzeczny nagłówek', () => {
    const o = ocenMigracje('00300_x.sql', '-- Wgraj PRZED wdrożeniem, a nie PO wdrożeniu.\nCREATE TABLE t (id int);');
    expect(o.powody.join(' ')).toMatch(/i „PRZED wdrożeniem”, i „PO wdrożeniu”/);
  });

  it('blokuje nazwę poza wzorcem', () => {
    expect(ocenMigracje('300_x.sql', `${NAGL_PRZED}SELECT 1;`).powody.join(' ')).toMatch(/poza wzorcem/);
    expect(ocenMigracje('00300_Duze.sql', `${NAGL_PRZED}SELECT 1;`).powody.join(' ')).toMatch(/poza wzorcem/);
  });

  it('podaje powód zakazanej instrukcji z nazwą', () => {
    const o = ocenMigracje('00300_x.sql', `${NAGL_PRZED}UPDATE t SET a = 1;`);
    expect(o.powody).toEqual(['zakazane bez człowieka: UPDATE na wierszach']);
  });
});

describe('plan dla zbioru oczekujących migracji', () => {
  const m = (plik: string, sql: string) => ({ plik, sql });

  it('dzieli na PRZED i PO i sortuje po numerze', () => {
    const plan = planMigracji([
      m('00303_c.sql', `${NAGL_PO}CREATE TABLE c (id int);`),
      m('00301_a.sql', `${NAGL_PRZED}CREATE TABLE a (id int);`),
      m('00302_b.sql', `${NAGL_PRZED}CREATE TABLE b (id int);`),
    ]);
    expect(plan).toEqual({ przed: ['00301', '00302'], po: ['00303'], zablokowane: [], kolejnosc: null });
  });

  it('zablokowana migracja nie trafia ani do PRZED, ani do PO', () => {
    const plan = planMigracji([m('00301_a.sql', `${NAGL_PRZED}DELETE FROM t;`), m('00302_b.sql', `${NAGL_PRZED}CREATE TABLE b (id int);`)]);
    expect(plan.przed).toEqual(['00302']);
    expect(plan.zablokowane).toEqual([{ numer: '00301', plik: '00301_a.sql', powody: ['zakazane bez człowieka: DELETE FROM'] }]);
  });

  it('PRZED o numerze wyższym niż PO łamie kolejność (nie da się zachować numeracji)', () => {
    const plan = planMigracji([m('00301_a.sql', `${NAGL_PO}CREATE TABLE a (id int);`), m('00302_b.sql', `${NAGL_PRZED}CREATE TABLE b (id int);`)]);
    expect(plan.kolejnosc).toMatch(/00302.*wyższy numer niż 00301/);
  });

  it('PO przed PRZED w numeracji nie jest problemem, gdy PRZED ma niższy numer', () => {
    const plan = planMigracji([m('00301_a.sql', `${NAGL_PRZED}CREATE TABLE a (id int);`), m('00302_b.sql', `${NAGL_PO}CREATE TABLE b (id int);`)]);
    expect(plan.kolejnosc).toBeNull();
  });

  it('pusty zbiór to czysty plan', () => {
    expect(planMigracji([])).toEqual({ przed: [], po: [], zablokowane: [], kolejnosc: null });
  });
});

describe('istniejące migracje (kalibracja)', () => {
  const pliki = readdirSync(MIGRACJE).filter((f) => f.endsWith('.sql'));

  it('migracje od 00164 z nagłówkiem fazy przechodzą kontrolę (poza 00200 sprzed zasad nagłówka)', () => {
    const problemy = pliki
      .filter((f) => Number(f.slice(0, 5)) >= 164 && !f.startsWith('00200_'))
      .map((f) => ocenMigracje(f, readFileSync(join(MIGRACJE, f), 'utf8')))
      .filter((o) => o.powody.length > 0)
      .map((o) => `${o.plik}: ${o.powody.join('; ')}`);
    expect(problemy).toEqual([]);
  });

  it('łapie znane migracje z danymi (backfill) i usunięciem kolumny: wymagają człowieka', () => {
    const powody = (numer: string) => {
      const plik = pliki.find((f) => f.startsWith(`${numer}_`)) as string;
      return blokadyZapisu(readFileSync(join(MIGRACJE, plik), 'utf8'));
    };
    expect(powody('00036')).toContain('DROP COLUMN');
    expect(powody('00010')).toContain('DELETE FROM');
    expect(powody('00161')).toContain('UPDATE na wierszach');
  });
});

describe('wiersz poleceń', () => {
  let katalog = '';
  afterEach(() => {
    if (katalog) rmSync(katalog, { recursive: true, force: true });
    katalog = '';
  });

  const uruchom = (...args: string[]) => spawnSync(process.execPath, [SKRYPT, ...args], { encoding: 'utf8' });
  const zapisz = (nazwa: string, tresc: string) => {
    katalog = katalog || mkdtempSync(join(tmpdir(), 'kontrola-migracji-'));
    const sciezka = join(katalog, nazwa);
    writeFileSync(sciezka, tresc);
    return sciezka;
  };

  it('kod 0 i lista PRZED/PO dla czystego zbioru', () => {
    const a = zapisz('00301_a.sql', `${NAGL_PRZED}CREATE TABLE a (id int);`);
    const b = zapisz('00302_b.sql', `${NAGL_PO}CREATE TABLE b (id int);`);
    const wynik = uruchom('--plik', a, b);
    expect(wynik.status).toBe(0);
    expect(wynik.stdout).toBe('00301\tprzed\tOK\n00302\tpo\tOK\n');
  });

  it('--json zwraca plan do dalszej obróbki w skryptach', () => {
    const a = zapisz('00301_a.sql', `${NAGL_PRZED}CREATE TABLE a (id int);`);
    const wynik = uruchom('--json', '--plik', a);
    expect(JSON.parse(wynik.stdout)).toEqual({ przed: ['00301'], po: [], zablokowane: [], kolejnosc: null });
  });

  it('kod 3 i powód przy zakazanej instrukcji', () => {
    const a = zapisz('00301_a.sql', `${NAGL_PRZED}TRUNCATE t;`);
    const wynik = uruchom('--plik', a);
    expect(wynik.status).toBe(3);
    expect(wynik.stdout).toContain('00301\t-\tZABLOKOWANA\tzakazane bez człowieka: TRUNCATE');
  });

  it('działa też przez dowiązanie do katalogu (macOS: /var to dowiązanie do /private/var)', () => {
    // Regresja: porównanie import.meta.url z argv[1] bez realpath kończyło skrypt po cichu, bez wyniku.
    katalog = mkdtempSync(join(tmpdir(), 'kontrola-migracji-'));
    const link = join(katalog, 'link');
    symlinkSync(resolve(SKRYPT, '..'), link);
    const plik = zapisz('00301_a.sql', `${NAGL_PRZED}CREATE TABLE a (id int);`);
    const wynik = spawnSync(process.execPath, [join(link, 'kontrola-migracji.mjs'), '--json', '--plik', plik], { encoding: 'utf8' });
    expect(wynik.status).toBe(0);
    expect(JSON.parse(wynik.stdout).przed).toEqual(['00301']);
  });

  it('kod 2 przy złym użyciu albo brakującym numerze w gicie', () => {
    expect(uruchom().status).toBe(2);
    expect(uruchom('--git', 'HEAD', '99999').status).toBe(2);
    expect(uruchom('--git', 'HEAD', 'abc').status).toBe(2);
  });

  it('czyta pliki z gita po numerze (istniejąca migracja)', () => {
    const wynik = uruchom('--json', '--git', 'HEAD', '00206');
    expect(wynik.status).toBe(0);
    expect(JSON.parse(wynik.stdout).przed).toEqual(['00206']);
  });
});
