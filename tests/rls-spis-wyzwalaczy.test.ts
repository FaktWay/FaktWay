import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { spisWyzwalaczy } from './filtr/sql/wyzwalacze';
import { getRlsTestDatabaseUrl } from './helpers/rls-environment';

/**
 * NZ-SQL-01 (żelazny filtr): spis wyzwalaczy czytany z migracji
 * (`tests/filtr/sql/wyzwalacze.ts`, na nim stoi test filtra
 * `tests/filtr/niezmienniki/wyzwalacze.test.ts`) zgadza się z prawdziwą bazą
 * po `supabase migration up`:
 *
 *  - te same wyzwalacze (tabela, nazwa, funkcja) na tabelach schematu
 *    `public` i z funkcjami w `public` (także `auth.users`), bez wewnętrznych
 *    wyzwalaczy kluczy obcych, wszystkie włączone;
 *  - ciało funkcji w bazie (`prosrc`) to ciało ostatniej definicji ze spisu,
 *    więc test filtra czyta komunikaty z tej wersji funkcji, która działa.
 *
 * Gdyby spis zgubił wyzwalacz (np. utworzony przez `EXECUTE`), wziął starszą
 * definicję funkcji albo baza miała wyzwalacz spoza migracji, ten test jest
 * czerwony. Tylko odczyt katalogu, bez danych.
 */

const hasDatabase = Boolean(process.env.RLS_TEST_DATABASE_URL?.trim());

interface SqlRunner {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

let boss: PgBoss;
const db = () => boss.getDb() as unknown as SqlRunner;

describe.skipIf(!hasDatabase)('NZ-SQL-01: spis wyzwalaczy z migracji zgadza się z bazą', () => {
  beforeAll(async () => {
    boss = new PgBoss({ connectionString: getRlsTestDatabaseUrl(), schema: 'pgboss', schedule: false, supervise: false });
    await boss.start();
  }, 60_000);

  afterAll(async () => {
    await boss?.stop({ graceful: false, close: true });
  });

  it('te same wyzwalacze, te same funkcje i ciała funkcji co w spisie', async () => {
    const spis = spisWyzwalaczy();
    expect(spis.nierozpoznane).toEqual([]);

    const { rows } = await db().executeSql(`
      SELECT tn.nspname AS schemat, c.relname AS tabela, t.tgname AS nazwa,
             fn.nspname || '.' || p.proname AS funkcja, t.tgenabled AS wlaczony
        FROM pg_catalog.pg_trigger AS t
        JOIN pg_catalog.pg_class AS c ON c.oid = t.tgrelid
        JOIN pg_catalog.pg_namespace AS tn ON tn.oid = c.relnamespace
        JOIN pg_catalog.pg_proc AS p ON p.oid = t.tgfoid
        JOIN pg_catalog.pg_namespace AS fn ON fn.oid = p.pronamespace
       WHERE NOT t.tgisinternal
         AND (tn.nspname = 'public' OR fn.nspname = 'public')
    `);
    const zBazy = rows.map((r) => `${String(r.schemat)}.${String(r.tabela)}#${String(r.nazwa)} -> ${String(r.funkcja)}`).sort();
    const zeSpisu = spis.wyzwalacze.map((w) => `${w.tabela}#${w.nazwa} -> ${w.funkcja}`).sort();
    expect(zBazy).toEqual(zeSpisu);
    expect(rows.filter((r) => r.wlaczony !== 'O').map((r) => `${String(r.tabela)}#${String(r.nazwa)}: ${String(r.wlaczony)}`)).toEqual([]);

    const funkcje = [...new Set(spis.wyzwalacze.map((w) => w.funkcja))].sort();
    const ciala = await db().executeSql(
      `SELECT n.nspname || '.' || p.proname AS funkcja, p.prosrc AS cialo
         FROM pg_catalog.pg_proc AS p
         JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
        WHERE n.nspname || '.' || p.proname = ANY($1::text[])
          AND p.prorettype = 'pg_catalog.trigger'::regtype`,
      [funkcje],
    );
    const wBazie = new Map(ciala.rows.map((r) => [String(r.funkcja), String(r.cialo).replace(/\r\n/g, '\n')]));
    expect([...wBazie.keys()].sort()).toEqual(funkcje);
    const rozne = funkcje.filter((f) => wBazie.get(f) !== spis.funkcje.get(f)?.cialo.replace(/\r\n/g, '\n'));
    expect(rozne, 'ciało w bazie inne niż ostatnia definicja w migracjach').toEqual([]);
  });
});
