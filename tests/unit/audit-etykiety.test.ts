import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ACTION_LABELS,
  AUDIT_ACTIONS_WITHOUT_CLIENT_LABEL,
  ENTITY_TYPE_LABELS,
  auditActionLabel,
  auditResourceLabel,
} from '@/lib/audit/labels';

/**
 * Obchód w symulatorze (U10): Dziennik zdarzeń w telefonie (i ta sama zakładka
 * strony, `settings/audit`) pokazywał po akcjach z telefonu surowe kody
 * (`ledger_entry.created`, `ksef.session.open`, `invoice.send_enqueued`) i
 * zasób jako `ledger_manual_entry:efe30fc1…`. Słownik `lib/audit/labels.ts`
 * nadążał tylko za częścią zdarzeń, a komentarz w nim nazywał brak nazwy
 * „świadomym zapasem”.
 *
 * Wiersze `audit_logs` czyta klient z RLS `tenant_id = bieżąca firma`, więc
 * każdy kod zapisany z `tenant_id` trafia do jego dziennika. Kody pochodzą z
 * czterech miejsc, i wszystkie sprawdzamy:
 *   1. typ `AuditAction` (`lib/audit/log.ts`), czyli to, co zapisuje aplikacja;
 *   2. migracje SQL (RPC i wyzwalacze zapisują do `audit_logs` same, np.
 *      `invoice.send_enqueued`, `expense.reviewed`), których nie ma w typie;
 *   3. wywołania KSeF z `lib/ksef` (`ksefFetch` dokleja `ksef.` do `audit.action`,
 *      rzutując na typ, więc `ksef.session.invoices` też nie ma w unii);
 *   4. rodzaje obiektów (`entity_type`), z których składa się druga linia wpisu.
 */

const ROOT = join(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    const info = statSync(join(ROOT, rel));
    if (info.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

const stripSqlComments = (sql: string) => sql.replace(/--.*$/gm, '');

/** Kody z `type AuditAction` (bez komentarzy). */
function actionsFromUnion(): Set<string> {
  const source = read('lib/audit/log.ts');
  const start = source.indexOf('export type AuditAction');
  const end = source.indexOf('export interface AuditLogEntry');
  const union = source.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return new Set([...union.matchAll(/'([a-z0-9_]+(?:\.[a-z0-9_-]+)+)'/g)].map((m) => m[1]));
}

const SQL_DIR = 'supabase/migrations';
const migrations = () => readdirSync(join(ROOT, SQL_DIR)).filter((f) => f.endsWith('.sql')).sort();

/** Wartości listy `VALUES (a, b, ...)` rozbite po przecinkach poza nawiasami i apostrofami. */
function splitSqlValues(valuesAndRest: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let inString = false;
  for (const ch of valuesAndRest.replace(/^\(/, '')) {
    if (ch === "'") inString = !inString;
    if (!inString) {
      if (ch === '(') depth += 1;
      if (ch === ')') {
        if (depth === 0) break;
        depth -= 1;
      }
      if (ch === ',' && depth === 0) {
        parts.push(current.trim());
        current = '';
        continue;
      }
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts;
}

/** Kody zapisywane przez bazę: `ksef_send_audit(...)`, `INSERT INTO audit_logs` i `v_action := ...`. */
function actionsFromMigrations(): Map<string, string> {
  const found = new Map<string, string>();
  const literal = /'([a-z0-9_]+\.[a-z0-9_.-]+)'/g;
  for (const file of migrations()) {
    const sql = stripSqlComments(read(join(SQL_DIR, file)));
    for (const m of sql.matchAll(/ksef_send_audit\s*\(([^;]*?)\)\s*;/g)) {
      const first = [...m[1].matchAll(literal)][0]?.[1];
      if (first) found.set(first, file);
    }
    for (const m of sql.matchAll(/INSERT\s+INTO\s+(?:public\.)?audit_logs\s*\([^)]*\)\s*(?:SELECT|VALUES)\s*([\s\S]{0,700}?);/gi)) {
      for (const lit of m[1].matchAll(literal)) found.set(lit[1], file);
    }
    for (const m of sql.matchAll(/v_action\s*:=\s*([\s\S]*?);/g)) {
      for (const lit of m[1].matchAll(literal)) found.set(lit[1], file);
    }
  }
  return found;
}

/**
 * Kody KSeF z wywołań `ksefFetch`, już z przedrostkiem `ksef.`: `audit: { action: 'invoice.send' }`
 * albo pomocnik `audit('session.invoices')` w `lib/ksef/submit.ts`.
 */
function actionsFromKsefCallSites(): Map<string, string> {
  const found = new Map<string, string>();
  const call = /\b(?:action:\s*|audit\(\s*)'((?:session|invoice|inbox|permissions|collective_identifier|history|upo)\.[a-z_.-]+)'/g;
  for (const file of walk('lib/ksef')) {
    if (file.includes('mock')) continue;
    for (const m of read(file).matchAll(call)) found.set(`ksef.${m[1]}`, relative(ROOT, join(ROOT, file)));
  }
  return found;
}

describe('słownik dziennika: nazwy zdarzeń (kody z kodu, z bazy i z wywołań KSeF)', () => {
  const union = actionsFromUnion();
  const sql = actionsFromMigrations();
  const ksef = actionsFromKsefCallSites();

  it('skan źródeł działa (inaczej reszta testu przechodziłaby na pustym zbiorze)', () => {
    expect(union.size).toBeGreaterThan(150);
    expect(union.has('auth.login')).toBe(true);
    expect(union.has('ledger_entry.created')).toBe(true);
    expect(sql.has('invoice.send_enqueued')).toBe(true);
    expect(sql.has('invoice.send_reset')).toBe(true);
    expect(sql.has('expense.reviewed')).toBe(true);
    expect(sql.has('webhook.created')).toBe(true);
    expect(ksef.has('ksef.session.invoices')).toBe(true);
    expect(ksef.has('ksef.invoice.poll')).toBe(true);
  });

  const all = new Map<string, string>();
  for (const code of union) all.set(code, 'typ AuditAction (lib/audit/log.ts)');
  for (const [code, file] of sql) if (!all.has(code)) all.set(code, `migracja ${file}`);
  for (const [code, file] of ksef) if (!all.has(code)) all.set(code, `wywołanie KSeF ${file}`);

  it('każdy kod zdarzenia ma polską nazwę albo jest na jawnej liście wyjątków', () => {
    const bezNazwy = [...all]
      .filter(([code]) => !(code in ACTION_LABELS) && !(code in AUDIT_ACTIONS_WITHOUT_CLIENT_LABEL))
      .map(([code, source]) => `${code}  (${source})`)
      .sort();
    expect(bezNazwy, 'te kody klient zobaczyłby w dzienniku jako surowy tekst').toEqual([]);
  });

  it('wyjątek ma uzasadnienie i nie dubluje nazwy', () => {
    for (const [code, reason] of Object.entries(AUDIT_ACTIONS_WITHOUT_CLIENT_LABEL)) {
      expect(reason.trim().length, code).toBeGreaterThan(20);
      expect(code in ACTION_LABELS, `${code} jest i w słowniku, i w wyjątkach`).toBe(false);
    }
  });

  it('w słowniku nie ma literówek: każdy klucz to prawdziwy kod zdarzenia', () => {
    const znane = new Set(all.keys());
    expect(Object.keys(ACTION_LABELS).filter((code) => !znane.has(code))).toEqual([]);
  });

  it('nazwy są czytelne: z dużej litery, bez długich myślników, nie kodem, każda inna', () => {
    const seen = new Map<string, string>();
    for (const [code, label] of Object.entries(ACTION_LABELS)) {
      expect(label, code).toMatch(/^\p{Lu}/u);
      expect(label, code).not.toMatch(/[\u2013\u2014]/);
      expect(label, code).not.toBe(code);
      expect(label, code).not.toMatch(/[a-z0-9_]+\.[a-z0-9_]+/);
      expect(seen.get(label), `„${label}”: ta sama nazwa przy ${seen.get(label)} i ${code}`).toBeUndefined();
      seen.set(label, code);
    }
  });

  it('auditActionLabel: kody z zrzutu obchodu mają polskie nazwy, nieznany kod zostaje kodem', () => {
    for (const code of [
      'ledger_entry.created',
      'ledger_entry.deleted',
      'ledger_inventory.created',
      'ledger_inventory.deleted',
      'jpk_v7m.downloaded',
      'ksef.history.query',
      'ksef.upo.download',
      'invoice.upo_downloaded',
      'ksef.session.open',
      'ksef.session.close',
      'ksef.invoice.send',
      'ksef.invoice.poll',
      'invoice.send_enqueued',
      'invoice.send_reset',
    ]) {
      expect(auditActionLabel(code), code).not.toBe(code);
      expect(auditActionLabel(code), code).toMatch(/[ \p{Ll}]/u);
    }
    expect(auditActionLabel('ledger_entry.created')).toBe('Dodano wpis ręczny w ewidencji');
    expect(auditActionLabel('ledger_inventory.deleted')).toBe('Usunięto spis z natury');
    expect(auditActionLabel('jpk_v7m.downloaded')).toBe('Pobrano plik JPK_V7M');
    expect(auditActionLabel('nowy.kod_z_przyszlosci')).toBe('nowy.kod_z_przyszlosci');
  });
});

describe('słownik dziennika: druga linia wpisu (rodzaj obiektu zamiast typ:uuid)', () => {
  const UUID = 'efe30fc1-6d6c-4f0e-9b2b-3d9f1a7c5e21';

  /** `entityType: 'x'` w kodzie aplikacji i `entity_type` zapisywany przez bazę. */
  function entityTypes(): Map<string, string> {
    const found = new Map<string, string>();
    for (const dir of ['lib', 'app', 'components']) {
      for (const file of walk(dir)) {
        for (const m of read(file).matchAll(/\bentityType:\s*'([a-z0-9_]+)'/g)) found.set(m[1], file);
      }
    }
    for (const file of migrations()) {
      const sql = stripSqlComments(read(join(SQL_DIR, file)));
      if (/ksef_send_audit\s*\(/.test(sql)) found.set('invoice', file);
      for (const m of sql.matchAll(/INSERT\s+INTO\s+(?:public\.)?audit_logs\s*\(([^)]*)\)\s*(?:SELECT|VALUES)\s*([\s\S]{0,700}?);/gi)) {
        const columns = m[1].split(',').map((c) => c.trim());
        const index = columns.indexOf('entity_type');
        const value = index >= 0 ? splitSqlValues(m[2])[index] : undefined;
        const type = value?.match(/^'([a-z0-9_]+)'$/)?.[1];
        if (type) found.set(type, file);
      }
    }
    return found;
  }

  it('każdy rodzaj obiektu zapisywany do dziennika ma polską nazwę', () => {
    const types = entityTypes();
    expect(types.has('invoice')).toBe(true);
    expect(types.has('ledger_manual_entry')).toBe(true);
    expect(types.has('bank_operation')).toBe(true);
    const bezNazwy = [...types].filter(([type]) => !(type in ENTITY_TYPE_LABELS)).map(([type, source]) => `${type}  (${source})`).sort();
    expect(bezNazwy, 'te rodzaje obiektów klient zobaczyłby jako surowy tekst albo kreskę').toEqual([]);
  });

  it('pokazuje rodzaj obiektu po polsku, bez skrótu identyfikatora i bez dwukropka', () => {
    expect(auditResourceLabel('ledger_manual_entry', UUID)).toBe('Wpis ręczny');
    expect(auditResourceLabel('contractor', 'b4df6802-3c41-4d0a-8d2e-0a5c6a1e9f33')).toBe('Kontrahent');
    expect(auditResourceLabel('invoice', UUID)).toBe('Faktura');
    expect(auditResourceLabel('ledger_inventory_count', UUID)).toBe('Spis z natury');
    for (const type of Object.keys(ENTITY_TYPE_LABELS)) {
      const label = auditResourceLabel(type, UUID);
      expect(label, type).not.toBeNull();
      expect(label, type).not.toContain(':');
      expect(label, type).not.toContain('…');
      expect(label, type).not.toContain('efe30fc1');
      expect(label, type).not.toContain(type);
      expect(label, type).toMatch(/^\p{Lu}/u);
      expect(label, type).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it('bez obiektu albo z nieznanym rodzajem: null (strona pisze kreskę, telefon pomija), nigdy surowy tekst', () => {
    expect(auditResourceLabel(null, UUID)).toBeNull();
    expect(auditResourceLabel('invoice', null)).toBeNull();
    expect(auditResourceLabel('', UUID)).toBeNull();
    expect(auditResourceLabel(undefined, undefined)).toBeNull();
    expect(auditResourceLabel('nowy_rodzaj_z_przyszlosci', UUID)).toBeNull();
  });
});
