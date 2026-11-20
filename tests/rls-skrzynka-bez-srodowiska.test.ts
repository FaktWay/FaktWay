import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createScriptHarness,
  KONTROLA_SCRIPT,
  labelRows,
  scriptSection,
  type ScriptHarness,
} from './helpers/kontrola-skrypt';
import { getRlsTestDatabaseUrl, getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * S12 (plan zero zgubionych faktur, E1) na prawdziwej bazie.
 *
 * `findExistingInboxNumbers` (`lib/jobs/runners/inbox-polling.ts`) zatrzymuje
 * przebieg skrzynki firmy, gdy w bazie jest faktura przychodząca z numerem
 * KSeF i bez środowiska. Po 00120 takiego wiersza nie ma i nie będzie:
 * preflight migracji odmawia wgrania, gdy jest choć jeden, a reguła CHECK
 * `invoices_incoming_ksef_environment_required` odrzuca każdy zapis i każdą
 * zmianę, także roli postgres, którą wyzwalacz z 00117 przepuszcza. Bez
 * reguły gałąź z błędem w runnerze znów byłaby osiągalna, a indeks 00120
 * pomija wiersze bez środowiska, więc ten sam numer wszedłby drugi raz.
 *
 * Czerwieni przed naprawą nie ma, bo runner się nie zmienia: stanu, który
 * wywołuje błąd, baza nie przyjmie. Stąd kontrole dodatnie w wycofywanych
 * transakcjach: bez reguły ten sam zapis przechodzi, migracja odmawia,
 * a zapytania sekcji 6 `scripts/ops/kontrola-faktur-ksef.sh` (ścieżka
 * operatora) pokazują wiersz i brak reguły.
 *
 * Wymaga bazy testowej (`RLS_TEST_*`, w tym `RLS_TEST_DATABASE_URL`) i programu
 * `psql`. Dane: własna firma i prefiks `e1512`.
 */

const hasDatabase = Boolean(
  process.env.RLS_TEST_SUPABASE_URL?.trim() &&
    process.env.RLS_TEST_SUPABASE_ANON_KEY?.trim() &&
    process.env.RLS_TEST_SUPABASE_SERVICE_ROLE_KEY?.trim() &&
    process.env.RLS_TEST_DATABASE_URL?.trim(),
);
const environment = hasDatabase ? getRlsTestEnvironment() : null;
const admin: SupabaseClient = environment
  ? createClient(environment.url, environment.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  : (null as unknown as SupabaseClient);

const RULE = 'invoices_incoming_ksef_environment_required';
const PREFLIGHT = 'Incoming KSeF invoices without environment require manual reconciliation before 00120';
const RULE_LABEL = 'reguła 00120';
const LIST_LABEL = 'przychodzące z numerem KSeF bez środowiska';

const ORG = 'e1512000-0000-4000-8000-000000000001';
const BUYER_NIP = '1234567890';
const SELLER_NIP = '1111111111';

interface Doc {
  id: string;
  number: string;
  ksef: string;
}

let counter = 0;
function nextDoc(): Doc {
  counter += 1;
  return {
    id: `e1512aaa-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    number: `FV/S12/${counter}`,
    ksef: `${SELLER_NIP}-20261119-E1512${String(counter).padStart(7, '0')}-01`,
  };
}

/** Wiersz jak w runnerze skrzynki (`inbox-polling.ts`, krok zapisu), środowisko TEST. */
function inboxRow(doc: Doc, extra: Record<string, unknown> = {}) {
  return {
    id: doc.id,
    tenant_id: ORG,
    direction: 'incoming',
    origin: 'ksef_inbox',
    internal_number: doc.number,
    invoice_type: 'VAT',
    invoice_kind: 'regular',
    issue_date: '2026-11-02',
    seller_nip: SELLER_NIP,
    buyer_nip: BUYER_NIP,
    gross_total: 123,
    net_total: 100,
    vat_total: 23,
    currency: 'PLN',
    ksef_number: doc.ksef,
    ksef_status: 'accepted',
    ksef_environment: 'test',
    ksef_accepted_at: '2026-11-02T10:00:00Z',
    fa3_data: { _source: 'inbox-metadata', _pendingFullFetch: true },
    seller_data: {},
    buyer_data: {},
    ...extra,
  };
}

async function insertRow(row: Record<string, unknown>): Promise<void> {
  const { error } = await admin.from('invoices').insert(row);
  if (error) throw new Error(`faktura ${String(row.internal_number)}: ${error.message}`);
}

async function invoiceOf(id: string) {
  const { data, error } = await admin.from('invoices')
    .select('ksef_number, ksef_environment, ksef_status')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function cleanup(): Promise<void> {
  const { error } = await admin.from('invoices').delete().eq('tenant_id', ORG);
  if (error) throw new Error(`sprzątanie faktur: ${error.message}`);
}

interface SqlRunner {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}
interface TransactionalDb extends SqlRunner {
  withTransaction<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

/** Koniec transakcji kontroli dodatniej: wycofanie, nic nie zostaje w bazie. */
class Rollback extends Error {}

/** Wiersz bez środowiska zapisany rolą postgres (wyzwalacz 00117 ją przepuszcza). */
const INSERT_WITHOUT_ENVIRONMENT = `
  INSERT INTO public.invoices (id, tenant_id, direction, origin, internal_number, invoice_type, invoice_kind,
    issue_date, seller_nip, buyer_nip, gross_total, net_total, vat_total, currency, ksef_number, ksef_status,
    ksef_environment, ksef_accepted_at, fa3_data, seller_data, buyer_data)
  VALUES ($1, $2, 'incoming', 'ksef_inbox', $3, 'VAT', 'regular', '2026-11-02', $4, $5, 123, 100, 23, 'PLN', $6,
    'accepted', NULL, '2026-11-02T10:00:00Z', '{"_source":"inbox-metadata","_pendingFullFetch":true}'::jsonb,
    '{}'::jsonb, '{}'::jsonb)`;

const insertWithoutEnvironment = (runner: SqlRunner, doc: Doc) =>
  runner.executeSql(INSERT_WITHOUT_ENVIRONMENT, [doc.id, ORG, doc.number, SELLER_NIP, BUYER_NIP, doc.ksef]);

/** Treść 00120 bez własnej transakcji: uruchamiamy ją wewnątrz wycofywanej. */
const migrationBody = () => readFileSync(join(process.cwd(), 'supabase/migrations/00120_incoming_ksef_identity.sql'), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/^BEGIN;$/m, '')
  .replace(/^COMMIT;$/m, '');

/** Zapytanie `sql "<etykieta>" "<zapytanie>"` ze źródła skryptu, to samo, które dostaje psql. */
function declaredQuery(labelStart: string): string {
  const source = readFileSync(KONTROLA_SCRIPT, 'utf8').replace(/\r\n/g, '\n');
  const re = /^\s*sql "((?:[^"\\]|\\.)*)"\s*(?:\\\n\s*)?"((?:[^"\\]|\\.)*)"/gm;
  const found = [...source.matchAll(re)].filter((m) => m[1]!.startsWith(labelStart));
  expect(found.map((m) => m[1]), `etykieta „${labelStart}” w skrypcie`).toHaveLength(1);
  return found[0]![2]!;
}

function pgEnv(url: string): Record<string, string> {
  const u = new URL(url);
  return {
    PGHOST: u.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username || 'postgres'),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: u.pathname.replace(/^\//, '') || 'postgres',
    PGCONNECT_TIMEOUT: '10',
  };
}

const FAKE_DOCKER = `#!/usr/bin/env bash
# Atrapa docker: \`exec <kontener> psql …\` → psql do lokalnej bazy testowej
# (PG* z testu); -U/-d skryptu pominięte. Reszta: nic (brak kontenerów).
[ "$1" = exec ] || exit 0
shift; [ "$1" = -e ] && { export "$2"; shift 2; }
[ "$2" = psql ] || exit 0
shift 2
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    -U|-d) shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
exec psql "\${args[@]}"
`;

describe.skipIf(!hasDatabase)('S12: faktura przychodząca z numerem KSeF bez środowiska na prawdziwej bazie (00120)', () => {
  let boss: PgBoss;
  const db = () => boss.getDb() as unknown as TransactionalDb;

  beforeAll(async () => {
    await cleanup();
    await admin.from('tenants').delete().eq('id', ORG);
    const { error } = await admin.from('tenants').insert({ id: ORG, nip: BUYER_NIP, name: 'Firma S12' });
    if (error) throw error;
    boss = new PgBoss({ connectionString: getRlsTestDatabaseUrl(), schema: 'pgboss', schedule: false, supervise: false });
    await boss.start();
  }, 60_000);

  afterAll(async () => {
    if (!hasDatabase) return;
    await boss?.stop({ graceful: false, close: true });
    await cleanup();
    await admin.from('tenants').delete().eq('id', ORG);
  });

  const ruleState = async () => (await db().executeSql(
    `SELECT contype::text AS contype, convalidated, pg_get_constraintdef(oid) AS definition
       FROM pg_catalog.pg_constraint
      WHERE conrelid = 'public.invoices'::regclass AND conname = $1`,
    [RULE],
  )).rows;

  describe('reguła 00120 w bazie', () => {
    it('jest, sprawdzona na wszystkich wierszach (convalidated) i ma warunek preflightu', async () => {
      const rows = await ruleState();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ contype: 'c', convalidated: true });
      const definition = String(rows[0]!.definition);
      expect(definition).toContain("direction <> 'incoming'");
      expect(definition).toContain('ksef_number IS NULL');
      expect(definition).toContain('ksef_environment IS NOT NULL');
    });

    it('serwis: przyjęta bez środowiska odpada już w wyzwalaczu 00117 (42501), wiersza nie ma', async () => {
      const doc = nextDoc();
      const { error } = await admin.from('invoices').insert(inboxRow(doc, { ksef_environment: null }));
      expect(error?.code, error?.message).toBe('42501');
      expect(error?.message).toContain('Accepted KSeF invoice requires environment provenance');
      expect(await invoiceOf(doc.id)).toBeNull();
    });

    it('serwis: faktura w innym stanie bez środowiska odpada na regule (23514), wiersza nie ma', async () => {
      const doc = nextDoc();
      const { error } = await admin.from('invoices')
        .insert(inboxRow(doc, { ksef_environment: null, ksef_status: 'received', ksef_accepted_at: null }));
      expect(error?.code, error?.message).toBe('23514');
      expect(error?.message).toContain(RULE);
      expect(await invoiceOf(doc.id)).toBeNull();
    });

    it('postgres: wyzwalacz 00117 przepuszcza przyjętą bez środowiska, reguła nie (23514)', async () => {
      const doc = nextDoc();
      await expect(insertWithoutEnvironment(db(), doc)).rejects.toMatchObject({ code: '23514', constraint: RULE });
      expect(await invoiceOf(doc.id)).toBeNull();
    });

    it('postgres: zdjęcie środowiska z faktury ze skrzynki odpada na regule (23514), wiersz bez zmian', async () => {
      const doc = nextDoc();
      await insertRow(inboxRow(doc));

      await expect(db().executeSql('UPDATE public.invoices SET ksef_environment = NULL WHERE id = $1', [doc.id]))
        .rejects.toMatchObject({ code: '23514', constraint: RULE });

      expect(await invoiceOf(doc.id)).toEqual({ ksef_number: doc.ksef, ksef_environment: 'test', ksef_status: 'accepted' });
    });

    it('postgres: numer KSeF dopisany do faktury przychodzącej bez środowiska odpada na regule (23514)', async () => {
      const doc = nextDoc();
      await insertRow(inboxRow(doc, {
        ksef_number: null, ksef_environment: null, ksef_status: 'received', ksef_accepted_at: null,
      }));

      await expect(db().executeSql('UPDATE public.invoices SET ksef_number = $2 WHERE id = $1', [doc.id, doc.ksef]))
        .rejects.toMatchObject({ code: '23514', constraint: RULE });

      expect(await invoiceOf(doc.id)).toEqual({ ksef_number: null, ksef_environment: null, ksef_status: 'received' });
    });

    it('kontrola dodatnia: bez reguły ten sam zapis przechodzi, a migracja 00120 odmawia wgrania', async () => {
      const doc = nextDoc();

      await expect(db().withTransaction(async (tx) => {
        await tx.executeSql(`ALTER TABLE public.invoices DROP CONSTRAINT ${RULE}`);
        await insertWithoutEnvironment(tx, doc);
        await tx.executeSql(migrationBody());
      })).rejects.toThrow(PREFLIGHT);

      expect(await ruleState()).toEqual([expect.objectContaining({ convalidated: true })]);
      expect(await invoiceOf(doc.id)).toBeNull();
    });
  });

  describe('kontrola-faktur-ksef.sh, sekcja 6 (ścieżka operatora)', () => {
    let harness: ScriptHarness;
    let section = '';

    beforeAll(() => {
      harness = createScriptHarness(FAKE_DOCKER);
      const result = harness.run(pgEnv(getRlsTestDatabaseUrl()));
      expect(result.status, result.stderr).toBe(0);
      section = scriptSection(result.stdout, 6) ?? '';
      expect(section, 'brak sekcji 6').not.toBe('');
    }, 120_000);

    afterAll(() => {
      harness?.cleanup();
    });

    it('każde zapytanie sekcji działa na schemacie po wszystkich migracjach', () => {
      expect(section).not.toContain('zapytanie nieudane');
    });

    it('baza po 00120: reguła sprawdzona na wszystkich wierszach, lista S12 pusta', () => {
      expect(labelRows(section, RULE_LABEL)).toEqual(['jest, sprawdzona na wszystkich wierszach']);
      expect(labelRows(section, LIST_LABEL)).toEqual([]);
    });

    it('kontrola dodatnia: te same zapytania bez reguły pokazują BRAK i wiersz bez środowiska, z regułą NOT VALID ostrzeżenie', async () => {
      const doc = nextDoc();
      const ruleQuery = declaredQuery(RULE_LABEL);
      const listQuery = declaredQuery(LIST_LABEL);
      const seen: Record<string, Array<Record<string, unknown>>> = {};

      await expect(db().withTransaction(async (tx) => {
        await tx.executeSql(`ALTER TABLE public.invoices DROP CONSTRAINT ${RULE}`);
        seen.missing = (await tx.executeSql(ruleQuery)).rows;
        await insertWithoutEnvironment(tx, doc);
        seen.listed = (await tx.executeSql(listQuery)).rows;
        await tx.executeSql(`ALTER TABLE public.invoices ADD CONSTRAINT ${RULE}
          CHECK (direction <> 'incoming' OR ksef_number IS NULL OR ksef_environment IS NOT NULL) NOT VALID`);
        seen.notValid = (await tx.executeSql(ruleQuery)).rows;
        throw new Rollback();
      })).rejects.toBeInstanceOf(Rollback);

      expect(seen.missing).toEqual([{ regula: 'BRAK: 00120 niewgrana, skrzynka moze stanac (S12)' }]);
      expect(seen.listed).toEqual([expect.objectContaining({
        tenant_id: ORG, origin: 'ksef_inbox', zrodlo: 'inbox-metadata', stan: 'accepted', liczba: '1',
      })]);
      expect(seen.notValid).toEqual([{ regula: 'jest, NOT VALID: stare wiersze niesprawdzone' }]);
      expect(await ruleState()).toEqual([expect.objectContaining({ convalidated: true })]);
      expect(await invoiceOf(doc.id)).toBeNull();
    });
  });
});
