import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * FZ-022: `scripts/ops/koszt-dwa-razy.sh` (zapytanie operatora o ten sam
 * dokument kosztu dwa razy) bez serwerów: atrapy `ssh` i `scp` zapisują, co
 * skrypt by wykonał. Pilnuje argumentów (szczegóły tylko dla jednej firmy,
 * UUID), transakcji tylko do odczytu (PGOPTIONS i `BEGIN READ ONLY` w pliku)
 * i tego, że plik SQL nie ma poleceń zapisu. Wynik SQL na prawdziwej bazie
 * sprawdza `tests/rls-koszt-dwa-razy-skrypt.test.ts`.
 */

const ROOT = join(__dirname, '..', '..');
const SKRYPT = join(ROOT, 'scripts/ops/koszt-dwa-razy.sh');
const SQL = readFileSync(join(ROOT, 'scripts/ops/koszt-dwa-razy.sql'), 'utf8').replace(/\r\n/g, '\n');
const FIRMA = '00222022-0000-4000-8000-00000000000a';

let dir = '';

function atrapa(nazwa: string, tresc: string): void {
  writeFileSync(join(dir, 'bin', nazwa), `#!/usr/bin/env bash\n${tresc}\n`);
  chmodSync(join(dir, 'bin', nazwa), 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'koszt-dwa-razy-'));
  mkdirSync(join(dir, 'bin'));
  // ssh: zapis polecenia zdalnego; scp: kopia wysyłanego pliku (przedostatni argument).
  atrapa('ssh', 'printf "%s\\n" "$*" >> "$FAKE_DIR/ssh.log"');
  atrapa('scp', 'cp "${@: -2:1}" "$FAKE_DIR/wyslany.sql"; printf "%s\\n" "$*" >> "$FAKE_DIR/scp.log"');
  writeFileSync(join(dir, 'infra.env'), ['K=/nie/ma/klucza', 'DB=db.example.test', 'PGC=pgc-test'].join('\n'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function uruchom(...args: string[]) {
  const r = spawnSync('bash', [SKRYPT, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { NODE_ENV: 'test', PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`, HOME: dir, FAKTFLOW_INFRA_ENV: join(dir, 'infra.env'), FAKE_DIR: dir },
  });
  const ssh = existsSync(join(dir, 'ssh.log')) ? readFileSync(join(dir, 'ssh.log'), 'utf8') : '';
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ssh };
}

/** Kod SQL bez komentarzy `--` (polecenia psql zostają). */
const kod = SQL.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

describe('scripts/ops/koszt-dwa-razy.sh', () => {
  it('bez argumentów: liczby dla wszystkich firm, psql w transakcji tylko do odczytu i z limitem czasu', () => {
    const r = uruchom();
    expect(r.status, r.stderr).toBe(0);
    expect(r.ssh).toContain("docker exec -e 'PGOPTIONS=-c statement_timeout=60s -c default_transaction_read_only=on' pgc-test psql");
    expect(r.ssh).toContain('-v ON_ERROR_STOP=1 -v firma= -v lista=0 -v szczegoly=0');
    expect(readFileSync(join(dir, 'wyslany.sql'), 'utf8')).toBe(SQL);
    expect(r.stdout).toContain('wszystkie firmy · same liczby · tylko odczyt');
  });

  it('jedna firma ze szczegółami: UUID i szczegoly=1 trafiają do psql', () => {
    const r = uruchom('--firma', FIRMA, '--szczegoly');
    expect(r.status, r.stderr).toBe(0);
    expect(r.ssh).toContain(`-v firma=${FIRMA} -v lista=0 -v szczegoly=1`);
  });

  it('lista firm: lista=1 bez szczegółów i bez firmy', () => {
    const r = uruchom('--lista-firm');
    expect(r.status, r.stderr).toBe(0);
    expect(r.ssh).toContain('-v firma= -v lista=1 -v szczegoly=0');
  });

  it.each([
    [['--szczegoly'], 'tylko dla jednej firmy'],
    [['--firma', 'FIRMA; rm -rf /'], 'UUID małymi literami'],
    [['--firma'], 'Użycie'],
    [['--wszystko'], 'Nieznana opcja'],
  ])('%j: odmowa przed połączeniem z serwerem', (args, komunikat) => {
    const r = uruchom(...args);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(komunikat);
    expect(r.ssh).toBe('');
  });
});

describe('scripts/ops/koszt-dwa-razy.sql tylko do odczytu', () => {
  it('zaczyna od BEGIN READ ONLY, kończy na ROLLBACK, bez poleceń zapisu', () => {
    const polecenia = kod.split('\n').map((l) => l.trim()).filter(Boolean);
    expect(polecenia[0]).toBe('BEGIN READ ONLY;');
    expect(polecenia.at(-1)).toBe('ROLLBACK;');
    // Bez treści napisów i poleceń psql (`\echo` z polskim „do sprawdzenia”).
    const sam = kod
      .replace(/'(?:[^']|'')*'/g, "''")
      .split('\n')
      .filter((l) => !l.trim().startsWith('\\'))
      .join('\n');
    expect(sam).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|CALL|DO)\b/i);
  });

  it('szczegóły (NIP, numer, kwoty) tylko w bloku \\if :szczegoly i tylko dla podanej firmy', () => {
    const [przed, poBloku] = kod.split('\\if :szczegoly\n\\echo');
    expect(poBloku).toBeDefined();
    // Poza blokiem szczegółów żadne zapytanie nie wypisuje NIP-u, numeru ani kwoty.
    const wyniki = [...przed!.matchAll(/^SELECT[\s\S]*?;$/gm)].map((m) => m[0]);
    expect(wyniki.length).toBeGreaterThanOrEqual(2);
    for (const w of wyniki.filter((x) => !x.includes('jest_firma'))) {
      expect(w.split(/\bFROM\b/)[0]).not.toMatch(/\b(nip|numer|gross_amount|seller_nip|document_number)\b/);
    }
    expect(poBloku).toContain("e.tenant_id::text = :'firma'");
  });
});
