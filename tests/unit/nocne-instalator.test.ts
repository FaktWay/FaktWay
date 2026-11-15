import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Instalacja nocnego wdrożenia: instalator (`zainstaluj-nocne-wdrozenie.sh`),
 * wrapper (`scripts/hetzner/nocne-wdrozenie-start.sh`) i jednostki systemd.
 * Nie dotykamy serwera: sprawdzamy spójność plików ze sobą i to, że sekrety
 * nie trafiają do linii poleceń. Zachowanie runnera: nocne-wdrozenie-skrypt.test.ts.
 */

const ROOT = resolve(__dirname, '../..');
const INSTALATOR = join(ROOT, 'scripts/ops/zainstaluj-nocne-wdrozenie.sh');
const WRAPPER = join(ROOT, 'scripts/hetzner/nocne-wdrozenie-start.sh');
const SERVICE = join(ROOT, 'scripts/hetzner/systemd/faktway-nocne-wdrozenie.service');
const TIMER = join(ROOT, 'scripts/hetzner/systemd/faktway-nocne-wdrozenie.timer');
const RUNNER = join(ROOT, 'scripts/ops/nocne-wdrozenie.sh');

const czytaj = (p: string) => readFileSync(p, 'utf8');

describe('instalator nocnego wdrożenia', () => {
  let katalog = '';
  afterEach(() => {
    if (katalog) rmSync(katalog, { recursive: true, force: true });
    katalog = '';
  });

  const infraEnv = () => {
    katalog = mkdtempSync(join(tmpdir(), 'nocne-instalator-'));
    const plik = join(katalog, 'infra.env');
    writeFileSync(plik, 'K=/nie/ma\nOPS=203.0.113.1\nAPP=203.0.113.2\nDB=203.0.113.3\nPGC=pg\nRESTC=rest\nAPP_PREFIX=app\nWORKER_PREFIX=wrk\n');
    return plik;
  };
  const uruchom = (...args: string[]) =>
    spawnSync('bash', [INSTALATOR, ...args], { encoding: 'utf8', env: { ...process.env, FAKTFLOW_INFRA_ENV: infraEnv() } });

  it.each([INSTALATOR, WRAPPER, RUNNER])('%s przechodzi bash -n', (plik) => {
    const r = spawnSync('bash', ['-n', plik], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  });

  it('--help wypisuje użycie bez łączenia się z serwerem', () => {
    const r = uruchom('--help');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Instalacja nocnego wdrożenia/);
    expect(r.stdout).toMatch(/--wstrzymaj/);
    expect(r.stdout).not.toMatch(/set -euo/);
  });

  it('odrzuca nieznaną opcję zanim cokolwiek zrobi na serwerze', () => {
    const r = uruchom('--cos');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Nieznana opcja: --cos/);
  });

  it('sekrety (token, czaty, ping) idą na serwer strumieniem, nigdy w poleceniu zdalnym', () => {
    const tresc = czytaj(INSTALATOR);
    const linieZdalne = tresc.split('\n').filter((l) => l.includes('ssh_do') && !l.trimStart().startsWith('#'));
    for (const linia of linieZdalne) {
      expect(linia, linia).not.toMatch(/\$\{?(TOKEN|CHATY|HC)\b/);
    }
    // Zapis env idzie przez stdin z umask 077.
    expect(tresc).toMatch(/\| ssh_do "\$OPS" "umask 077; cat > \/etc\/faktway-nocne\.env"/);
  });

  it('klucz nocny jest ograniczony: tylko z ops-1, bez forwardingu i pty', () => {
    const tresc = czytaj(INSTALATOR);
    for (const opcja of ['from=', 'no-port-forwarding', 'no-agent-forwarding', 'no-X11-forwarding', 'no-pty']) {
      expect(tresc).toContain(opcja);
    }
  });

  it('wymaga raportów albo jawnej zgody --bez-telegramu', () => {
    const tresc = czytaj(INSTALATOR);
    expect(tresc).toMatch(/--bez-telegramu/);
    expect(tresc).toMatch(/nocna automatyka zawodziłaby po cichu/);
  });
});

describe('wrapper i jednostki systemd', () => {
  it('service woła ścieżkę, pod którą instalator kładzie wrapper', () => {
    const service = czytaj(SERVICE);
    const execStart = /^ExecStart=(.+)$/m.exec(service)?.[1];
    expect(execStart).toBe('/usr/local/sbin/faktway-nocne-wdrozenie');
    expect(czytaj(INSTALATOR)).toContain(`/usr/local/sbin/faktway-nocne-wdrozenie`);
    expect(czytaj(INSTALATOR)).toMatch(/install -m 700 \$T\/start \/usr\/local\/sbin\/faktway-nocne-wdrozenie/);
  });

  it('service jest jednorazowy, z sufitem czasu i bez zmiennych w pliku jednostki', () => {
    const service = czytaj(SERVICE);
    expect(service).toMatch(/^Type=oneshot$/m);
    expect(service).toMatch(/^TimeoutStartSec=3h$/m);
    expect(service).not.toMatch(/TOKEN|PASSWORD|SECRET/i);
  });

  it('timer: 03:30 czasu Warszawy, bez nadrabiania rano, w oknie runnera', () => {
    const timer = czytaj(TIMER);
    expect(timer).toMatch(/^OnCalendar=\*-\*-\* 03:30:00 Europe\/Warsaw$/m);
    expect(timer).toMatch(/^Persistent=false$/m);
    const runner = czytaj(RUNNER);
    const od = Number(/NOCNE_OKNO_OD=\$\{NOCNE_OKNO_OD:-(\d+)\}/.exec(runner)?.[1]);
    const doo = Number(/NOCNE_OKNO_DO=\$\{NOCNE_OKNO_DO:-(\d+)\}/.exec(runner)?.[1]);
    expect(od).toBeLessThanOrEqual(3);
    expect(doo).toBeGreaterThanOrEqual(3);
  });

  it('wrapper odświeża main i oddaje sterowanie runnerowi z repo, także gdy fetch padnie', () => {
    const wrapper = czytaj(WRAPPER);
    expect(wrapper).toMatch(/git fetch --quiet origin main \|\|/);
    expect(wrapper).toMatch(/exec "\$REPO\/scripts\/ops\/nocne-wdrozenie\.sh" "\$@"/);
    expect(wrapper).not.toMatch(/^set -[a-z]*e/m);
  });

  it('wrapper i instalator zgadzają się co do katalogu repo', () => {
    expect(czytaj(WRAPPER)).toContain('/opt/faktway-nocne/repo');
    expect(czytaj(INSTALATOR)).toContain('KATALOG=/opt/faktway-nocne');
  });
});
