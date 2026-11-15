import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Nocne wdrożenie (`scripts/ops/nocne-wdrozenie.sh`): migracje po kontroli,
 * worker, aplikacja, ratunek, raport.
 *
 * Skrypt źródłujemy w trybie biblioteki (`NOCNE_BIBLIOTEKA=1`) i podmieniamy
 * funkcje, które dotykają produkcji (SSH do db-1/app-1, tinker Coolify, GHCR,
 * `wgraj-migracje.sh`, `wdroz-produkcje.sh`, `curl`). Prawdziwe zostają:
 * kolejność kroków, bramki, git na tymczasowym repozytorium z `origin`,
 * kontrola migracji (`kontrola-migracji.mjs`), `jq` i składanie raportu.
 */

const SKRYPT = resolve(__dirname, '../../scripts/ops/nocne-wdrozenie.sh');
const KONTROLA = resolve(__dirname, '../../scripts/ops/kontrola-migracji.mjs');
const TOKEN = 'TEST-SEKRET-123:ABC';

const jqProbe = spawnSync('bash', ['-c', `printf '{"a":1}' | jq -r .a`], { encoding: 'utf8' });
const hasJq = jqProbe.status === 0 && jqProbe.stdout === '1\n';
const onCi = !['', '0', 'false'].includes(process.env.CI ?? '');
const itJq = (name: string, fn: () => void) =>
  it(name, (ctx) => {
    if (!hasJq) {
      if (onCi) throw new Error('brak jq w bashu: nocne wdrożenie czyta nim odpowiedź GitHuba i plan migracji');
      ctx.skip('brak jq w bashu');
    }
    fn();
  });

const NAGL = (faza: string) => `-- 00300: test\n--\n-- Wdrożenie: ${faza}\n\n`;
const CI_ZIELONE = {
  check_runs: [
    { name: 'Typecheck + Lint + Unit tests', status: 'completed', conclusion: 'success' },
    { name: 'Next build', status: 'completed', conclusion: 'success' },
    { name: 'RLS isolation (lokalny Supabase)', status: 'completed', conclusion: 'success' },
    { name: 'Test-first (agent)', status: 'completed', conclusion: 'skipped' },
  ],
};

interface Scenariusz {
  /** Pliki dodane w commicie docelowym (B), np. { '00300_a.sql': '...' }. */
  migracje?: Record<string, string>;
  /** Wersje wgrane w bazie (domyślnie 00001). Błąd odczytu: 'blad'. */
  wersje?: string | 'blad';
  ci?: unknown;
  obrazy?: 'ok' | 'brak';
  aktywne?: string;
  kopiaH?: string;
  godzina?: string;
  stop?: boolean;
  brakMiejsca?: boolean;
  /** Stan produkcji przed przebiegiem: 'A' (poprzedni), 'B' (cel), 'mix'. */
  stan?: 'A' | 'B' | 'mix' | 'nowszy';
  /** `udaje`: wdroz kończy 0, ale kontenery zostają na starym SHA. */
  wdroz?: 'ok' | 'czesciowe' | 'brak' | 'udaje';
  ratunek?: 'ok' | 'brak';
  wgrajKod?: Record<string, number>;
  args?: string[];
  bezTelegramu?: boolean;
}

describe('nocne-wdrozenie.sh', () => {
  let dir = '';
  let fake = '';
  let work = '';
  let shaA = '';
  let shaB = '';

  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nocne-'));
    fake = join(dir, 'fake');
    mkdirSync(fake);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Repozytorium: origin (bare) i kopia robocza z dwoma commitami na main: A (wdrożony) i B (cel). */
  function przygotujRepo(migracjeB: Record<string, string>) {
    const origin = join(dir, 'origin.git');
    work = join(dir, 'work');
    git(dir, 'init', '--bare', '-b', 'main', origin);
    git(dir, 'clone', '-q', origin, work);
    git(work, 'config', 'user.email', 't@example.test');
    git(work, 'config', 'user.name', 'Test');
    git(work, 'checkout', '-q', '-b', 'main');
    mkdirSync(join(work, 'supabase/migrations'), { recursive: true });
    mkdirSync(join(work, 'scripts/ops'), { recursive: true });
    copyFileSync(KONTROLA, join(work, 'scripts/ops/kontrola-migracji.mjs'));
    writeFileSync(join(work, 'supabase/migrations/00001_a.sql'), `${NAGL('PRZED')}CREATE TABLE a (id int);\n`);
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'Merge pull request #1 z testu: stan wdrożony');
    shaA = git(work, 'rev-parse', 'HEAD');
    for (const [nazwa, tresc] of Object.entries(migracjeB)) writeFileSync(join(work, 'supabase/migrations', nazwa), tresc);
    writeFileSync(join(work, 'zmiana.txt'), 'b\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'Merge pull request #2 z testu: nowa funkcja');
    shaB = git(work, 'rev-parse', 'HEAD');
    git(work, 'push', '-q', 'origin', 'main');
    // Kopia robocza stoi na A: `git fetch` w skrypcie ma coś do zrobienia, a nowsze niż cel nie istnieje.
    git(work, 'reset', '-q', '--hard', shaA);
    git(work, 'update-ref', '-d', 'refs/remotes/origin/main');
  }

  function uruchom(s: Scenariusz = {}) {
    przygotujRepo(s.migracje ?? {});
    const stan = s.stan ?? 'A';
    writeFileSync(join(fake, 'worker'), stan === 'A' || stan === 'mix' ? shaA : shaB);
    writeFileSync(join(fake, 'web'), stan === 'A' ? shaA : stan === 'mix' ? shaB : shaB);
    if (stan === 'nowszy') {
      // Produkcja na commicie, którego cel (origin/main) nie obejmuje: cel jest przodkiem wdrożonego.
      writeFileSync(join(fake, 'worker'), shaB);
      writeFileSync(join(fake, 'web'), shaB);
    }
    writeFileSync(join(fake, 'ci.json'), JSON.stringify(s.ci ?? CI_ZIELONE));
    writeFileSync(join(fake, 'obrazy'), s.obrazy ?? 'ok');
    writeFileSync(join(fake, 'aktywne'), s.aktywne ?? '0');
    writeFileSync(join(fake, 'kopia'), s.kopiaH ?? '3');
    writeFileSync(join(fake, 'godzina'), s.godzina ?? '3');
    writeFileSync(join(fake, 'wersje'), s.wersje === 'blad' ? '' : (s.wersje ?? '00001'));
    writeFileSync(join(fake, 'wersje-tryb'), s.wersje === 'blad' ? 'blad' : 'ok');
    writeFileSync(join(fake, 'wdroz-tryb'), s.wdroz ?? 'ok');
    writeFileSync(join(fake, 'ratunek-tryb'), s.ratunek ?? 'ok');
    writeFileSync(join(fake, 'wgraj-kody'), JSON.stringify(s.wgrajKod ?? {}));
    if (s.stop) writeFileSync(join(fake, 'STOP'), '');
    if (s.brakMiejsca) writeFileSync(join(fake, 'brak-miejsca'), '');
    if (stan === 'nowszy') {
      // Cel starszy od wdrożonego: pin SHA na A, wdrożony = B.
      s.args = ['--sha', shaA, ...(s.args ?? [])];
    }

    const skrypt = `
set -uo pipefail
export NOCNE_BIBLIOTEKA=1 NOCNE_ENV=/nie/ma NOCNE_STOP="${fake}/STOP" NOCNE_LOG_DIR="${fake}/log" NOCNE_CI_CZEKAJ_MIN=0 NOCNE_OBRAZY_CZEKAJ_MIN=0
${s.bezTelegramu ? '' : `export TELEGRAM_BOT_TOKEN='${TOKEN}' TELEGRAM_CHAT_IDS='111,222' NOCNE_HC_URL='https://hc.example.test/ping/abc'`}
export FAKE='${fake}'
source '${SKRYPT}'
ROOT='${work}'
cd "$ROOT"
zaladuj_infra_env() { K=k; OPS=o; APP=a; DB=d; PGC=pgc; RESTC=rest; APP_PREFIX=app; WORKER_PREFIX=wrk; }
sha_dzialajacego() { if [ "$1" = "$WORKER_ID" ]; then cat "$FAKE/worker"; else cat "$FAKE/web"; fi; }
godzina_warszawa() { cat "$FAKE/godzina"; }
czekaj_na_obrazy() { [ "$(cat "$FAKE/obrazy")" = ok ] || { echo "Brak obrazów (atrapa)" >&2; return 1; }; }
aktywne_wdrozenia() { cat "$FAKE/aktywne"; }
sprawdz_miejsce_app1() { [ ! -e "$FAKE/brak-miejsca" ]; }
psql_odczyt() {
  case "$1" in
    *schema_migrations*) [ "$(cat "$FAKE/wersje-tryb")" = ok ] && cat "$FAKE/wersje" || return 1 ;;
    *backup_log*) cat "$FAKE/kopia" ;;
  esac
}
curl() {
  local linia="$*"; printf '%s\\n' "\${linia//$'\\n'/⏎}" >> "$FAKE/curl.log"
  case "$*" in
    *api.github.com*) cat "$FAKE/ci.json" ;;
    *) if [ ! -t 0 ]; then cat >> "$FAKE/curl.stdin" 2>/dev/null; fi ;;
  esac
}
wgraj_migracje() {
  local sha=$1; shift
  echo "wgraj $* (ref=\${sha:0:8})" >> "$FAKE/calls"
  local kod; kod=$(node -e "const k=JSON.parse(require('fs').readFileSync('$FAKE/wgraj-kody','utf8')); console.log(k[process.argv[1]] ?? 0)" "$1")
  return "$kod"
}
wdroz() {
  echo "wdroz $1" >> "$FAKE/calls"
  if [ "$1" = "${shaA}" ]; then
    # powrót na poprzedni SHA (ratunek)
    if [ "$(cat "$FAKE/ratunek-tryb")" = ok ]; then echo "\${1}" > "$FAKE/worker"; echo "\${1}" > "$FAKE/web"; return 0; fi
    return 1
  fi
  case "$(cat "$FAKE/wdroz-tryb")" in
    ok) echo "$1" > "$FAKE/worker"; echo "$1" > "$FAKE/web"; return 0 ;;
    czesciowe) echo "$1" > "$FAKE/worker"; return 1 ;;
    udaje) return 0 ;;
    *) return 1 ;;
  esac
}
glowna ${(s.args ?? ['--teraz']).join(' ')}
echo "KOD=$?"
`;
    const wynik = spawnSync('bash', ['-c', skrypt], { encoding: 'utf8', timeout: 60_000 });
    const calls = existsSync(join(fake, 'calls')) ? readFileSync(join(fake, 'calls'), 'utf8').trim().split('\n') : [];
    const curl = existsSync(join(fake, 'curl.log')) ? readFileSync(join(fake, 'curl.log'), 'utf8') : '';
    const stdin = existsSync(join(fake, 'curl.stdin')) ? readFileSync(join(fake, 'curl.stdin'), 'utf8') : '';
    if (process.env.NOCNE_DEBUG) console.log(wynik.stdout + wynik.stderr);
    const kod = Number(/KOD=(\d+)/.exec(wynik.stdout)?.[1] ?? NaN);
    const telegram = curl
      .split('\n')
      .filter((l) => l.includes('chat_id='))
      .map((l) => l.replaceAll('⏎', '\n'));
    const ping = curl.split('\n').filter((l) => l.includes('hc.example.test'));
    return { ...wynik, kod, calls, curl, stdin, telegram, ping, out: `${wynik.stdout}${wynik.stderr}` };
  }

  itJq('nic do wdrożenia, gdy produkcja już działa na celu', () => {
    const r = uruchom({ stan: 'B' });
    expect(r.kod).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.telegram).toEqual([]);
    expect(r.out).toMatch(/Nic do wdrożenia/);
    expect(r.ping.map((l) => l.trim().split(' ').pop())).toEqual(['https://hc.example.test/ping/abc/start', 'https://hc.example.test/ping/abc']);
  });

  itJq('wstrzymane plikiem STOP: nic nie robi, ale raportuje, że nie wdraża', () => {
    const r = uruchom({ stop: true });
    expect(r.kod).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.telegram.join('\n')).toMatch(/wstrzymane/);
  });

  itJq('poza oknem nocnym bez --teraz kończy po cichu', () => {
    const r = uruchom({ godzina: '12', args: [] });
    expect(r.kod).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.telegram).toEqual([]);
    expect(r.out).toMatch(/Poza oknem nocnym/);
  });

  itJq('w oknie nocnym (godzina 3) rusza bez --teraz', () => {
    const r = uruchom({ godzina: '3', args: [] });
    expect(r.calls.some((c) => c.startsWith('wdroz '))).toBe(true);
  });

  itJq('prosty przebieg: wdraża SHA z origin/main i raportuje z listą zmian', () => {
    const r = uruchom();
    expect(r.kod).toBe(0);
    expect(r.calls).toEqual([`wdroz ${shaB}`]);
    const t = r.telegram.join('\n');
    expect(t).toMatch(/✅ FaktWay, nocne wdrożenie: wdrożono/);
    expect(t).toContain('Merge pull request #2 z testu: nowa funkcja');
    expect(r.telegram).toHaveLength(2); // dwa adresaty
  });

  itJq('token Telegrama idzie przez stdin curl, nigdy w argumentach ani w wyjściu', () => {
    const r = uruchom();
    expect(r.curl).not.toContain(TOKEN);
    expect(r.out).not.toContain(TOKEN);
    expect(r.stdin).toContain(`bot${TOKEN}/sendMessage`);
  });

  itJq('bez tokenu Telegrama przebieg działa, tylko bez wiadomości', () => {
    const r = uruchom({ bezTelegramu: true });
    expect(r.kod).toBe(0);
    expect(r.telegram).toEqual([]);
    expect(r.calls).toEqual([`wdroz ${shaB}`]);
  });

  describe('bramki: nic nie wdraża i mówi dlaczego', () => {
    itJq('CI czerwone', () => {
      const r = uruchom({ ci: { check_runs: [...CI_ZIELONE.check_runs, { name: 'Vitest (część 2/3)', status: 'completed', conclusion: 'failure' }] } });
      expect(r.kod).toBe(0);
      expect(r.calls).toEqual([]);
      expect(r.telegram.join('\n')).toMatch(/⚠️.*CI na [0-9a-f]{8} nie jest zielone: czerwone:Vitest \(część 2\/3\)/);
    });

    itJq('CI w toku po czekaniu', () => {
      const r = uruchom({ ci: { check_runs: [...CI_ZIELONE.check_runs, { name: 'Obraz runner', status: 'in_progress', conclusion: null }] } });
      expect(r.calls).toEqual([]);
      expect(r.telegram.join('\n')).toMatch(/w-toku:1/);
    });

    itJq('brak wymaganej kontroli na commicie (np. Next build nie ruszył)', () => {
      const r = uruchom({ ci: { check_runs: CI_ZIELONE.check_runs.filter((k) => k.name !== 'Next build') } });
      expect(r.calls).toEqual([]);
      expect(r.telegram.join('\n')).toMatch(/brak-wymaganych:Next build/);
    });

    itJq('brak obrazów w GHCR', () => {
      const r = uruchom({ obrazy: 'brak' });
      expect(r.calls).toEqual([]);
      expect(r.telegram.join('\n')).toMatch(/nie ma w GHCR/);
    });

    itJq('aktywne wdrożenie w Coolify', () => {
      const r = uruchom({ aktywne: '1' });
      expect(r.calls).toEqual([]);
      expect(r.telegram.join('\n')).toMatch(/aktywne wdrożenia/);
    });

    itJq('za mało miejsca na app-1', () => {
      const r = uruchom({ brakMiejsca: true });
      expect(r.calls).toEqual([]);
      expect(r.telegram.join('\n')).toMatch(/za mało miejsca/);
    });

    itJq('produkcja nowsza niż cel: nie cofa kodu', () => {
      const r = uruchom({ stan: 'nowszy' });
      expect(r.kod).toBe(0);
      expect(r.calls).toEqual([]);
      expect(r.telegram.join('\n')).toMatch(/nowszy/);
    });

    itJq('worker i aplikacja na różnych commitach: stan mieszany, wymaga człowieka', () => {
      const r = uruchom({ stan: 'mix' });
      expect(r.kod).toBe(1);
      expect(r.calls).toEqual([]);
      expect(r.telegram.join('\n')).toMatch(/🔴.*różnych commitach/);
    });
  });

  describe('migracje po kontroli', () => {
    itJq('PRZED przed kodem, PO po kodzie, z SHA przypiętym do wgrania', () => {
      const r = uruchom({
        migracje: {
          '00300_a.sql': `${NAGL('PRZED')}CREATE TABLE x (id int);\n`,
          '00301_b.sql': `${NAGL('PRZED')}CREATE TABLE y (id int);\n`,
          '00302_c.sql': `${NAGL('PO wdrożeniu')}CREATE TABLE z (id int);\n`,
        },
      });
      expect(r.kod).toBe(0);
      expect(r.calls).toEqual([`wgraj 00300 00301 (ref=${shaB.slice(0, 8)})`, `wdroz ${shaB}`, `wgraj 00302 (ref=${shaB.slice(0, 8)})`]);
      expect(r.telegram.join('\n')).toMatch(/przed=00300 00301, po=00302/);
    });

    itJq('migracja z UPDATE: nic nie wgrywa i nic nie wdraża, mówi co zrobić', () => {
      const r = uruchom({
        migracje: {
          '00300_a.sql': `${NAGL('PRZED')}CREATE TABLE x (id int);\n`,
          '00301_b.sql': `${NAGL('PRZED')}UPDATE x SET id = 1;\n`,
        },
      });
      expect(r.kod).toBe(1);
      expect(r.calls).toEqual([]);
      const t = r.telegram.join('\n');
      expect(t).toMatch(/🔴.*czekają na człowieka/);
      expect(t).toContain('• 00301: zakazane bez człowieka: UPDATE na wierszach');
      expect(t).toContain('wgraj ręcznie');
    });

    itJq('migracja bez oznaczenia fazy: blokada z instrukcją', () => {
      const r = uruchom({ migracje: { '00300_a.sql': '-- opis\nCREATE TABLE x (id int);\n' } });
      expect(r.kod).toBe(1);
      expect(r.calls).toEqual([]);
      expect(r.telegram.join('\n')).toMatch(/brak oznaczenia fazy/);
    });

    itJq('PRZED o wyższym numerze niż PO: kolejności nie da się zachować', () => {
      const r = uruchom({
        migracje: {
          '00300_a.sql': `${NAGL('PO wdrożeniu')}CREATE TABLE x (id int);\n`,
          '00301_b.sql': `${NAGL('PRZED')}CREATE TABLE y (id int);\n`,
        },
      });
      expect(r.kod).toBe(1);
      expect(r.calls).toEqual([]);
      expect(r.telegram.join('\n')).toMatch(/Kolejność:.*00301/);
    });

    itJq('kopia bazy starsza niż 26 h: migracji nie wgrywa', () => {
      const r = uruchom({ migracje: { '00300_a.sql': `${NAGL('PRZED')}CREATE TABLE x (id int);\n` }, kopiaH: '30' });
      expect(r.kod).toBe(1);
      expect(r.calls).toEqual([]);
      expect(r.telegram.join('\n')).toMatch(/kopia bazy nieświeża/);
    });

    itJq('brak odczytu kopii: migracji nie wgrywa', () => {
      const r = uruchom({ migracje: { '00300_a.sql': `${NAGL('PRZED')}CREATE TABLE x (id int);\n` }, kopiaH: '' });
      expect(r.kod).toBe(1);
      expect(r.calls).toEqual([]);
    });

    itJq('nieświeża kopia nie blokuje wdrożenia, gdy migracji nie ma', () => {
      const r = uruchom({ kopiaH: '99' });
      expect(r.calls).toEqual([`wdroz ${shaB}`]);
    });

    itJq('błąd odczytu schema_migrations: nie traktuje wszystkiego jako oczekujące, nie wdraża', () => {
      const r = uruchom({ wersje: 'blad', migracje: { '00300_a.sql': `${NAGL('PRZED')}CREATE TABLE x (id int);\n` } });
      expect(r.kod).toBe(1);
      expect(r.calls).toEqual([]);
      expect(r.telegram.join('\n')).toMatch(/nie odczytałem migracji z bazy/);
    });

    itJq('migracja już wgrana nie jest oczekująca nawet bez nagłówka fazy', () => {
      const r = uruchom({ migracje: { '00300_a.sql': '-- stara bez fazy\nUPDATE x SET id = 1;\n' }, wersje: '00001\n00300' });
      expect(r.calls).toEqual([`wdroz ${shaB}`]);
    });

    itJq('migracja „przed” pada: kodu nie wdraża', () => {
      const r = uruchom({ migracje: { '00300_a.sql': `${NAGL('PRZED')}CREATE TABLE x (id int);\n` }, wgrajKod: { '00300': 1 } });
      expect(r.kod).toBe(1);
      expect(r.calls).toEqual([`wgraj 00300 (ref=${shaB.slice(0, 8)})`]);
      expect(r.telegram.join('\n')).toMatch(/migracja „przed” nie weszła/);
    });

    itJq('migracja „po wdrożeniu” pada: kod zostaje, raport mówi jak wgrać ręcznie', () => {
      const r = uruchom({ migracje: { '00300_a.sql': `${NAGL('PO wdrożeniu')}CREATE TABLE x (id int);\n` }, wgrajKod: { '00300': 1 } });
      expect(r.kod).toBe(1);
      expect(r.calls).toEqual([`wdroz ${shaB}`, `wgraj 00300 (ref=${shaB.slice(0, 8)})`]);
      expect(r.telegram.join('\n')).toMatch(/wdrożono [0-9a-f]{8}, ale migracja „po wdrożeniu” nie weszła[\s\S]*wgraj-migracje.sh 00300/);
    });
  });

  describe('wdrożenie padło', () => {
    itJq('po workerze: ratunek wraca na poprzedni SHA, migracje „po” czekają', () => {
      const r = uruchom({
        wdroz: 'czesciowe',
        migracje: {
          '00300_a.sql': `${NAGL('PRZED')}CREATE TABLE x (id int);\n`,
          '00301_b.sql': `${NAGL('PO wdrożeniu')}CREATE TABLE y (id int);\n`,
        },
      });
      expect(r.kod).toBe(1);
      expect(r.calls).toEqual([`wgraj 00300 (ref=${shaB.slice(0, 8)})`, `wdroz ${shaB}`, `wdroz ${shaA}`]);
      const t = r.telegram.join('\n');
      expect(t).toMatch(/🔴.*padło, wróciłem na/);
      expect(t).toContain('Migracje „po” (00301) czekają');
    });

    itJq('ratunek też pada: potrzebny człowiek', () => {
      const r = uruchom({ wdroz: 'czesciowe', ratunek: 'brak' });
      expect(r.kod).toBe(1);
      expect(r.calls).toEqual([`wdroz ${shaB}`, `wdroz ${shaA}`]);
      expect(r.telegram.join('\n')).toMatch(/ratunek się nie udał: potrzebny człowiek/);
    });

    itJq('wdroz kończy 0, ale kontenery nie stoją na SHA: to też porażka, ratunek wraca', () => {
      const r = uruchom({ wdroz: 'udaje' });
      expect(r.kod).toBe(1);
      expect(r.calls).toEqual([`wdroz ${shaB}`, `wdroz ${shaA}`]);
      expect(r.telegram.join('\n')).toMatch(/padło, wróciłem na/);
    });
  });

  itJq('kod już na celu, ale czeka migracja „po”: wgrywa ją bez wdrażania', () => {
    const r = uruchom({ stan: 'B', migracje: { '00300_a.sql': `${NAGL('PO wdrożeniu')}CREATE TABLE x (id int);\n` } });
    expect(r.kod).toBe(0);
    expect(r.calls).toEqual([`wgraj 00300 (ref=${shaB.slice(0, 8)})`]);
  });

  describe('--sucho', () => {
    itJq('pokazuje plan i nic nie zmienia: bez wgrania, wdrożenia, Telegramu i pingów', () => {
      const r = uruchom({
        args: ['--sucho'],
        migracje: { '00300_a.sql': `${NAGL('PRZED')}CREATE TABLE x (id int);\n` },
      });
      expect(r.kod).toBe(0);
      expect(r.calls).toEqual([]);
      expect(r.telegram).toEqual([]);
      expect(r.ping).toEqual([]);
      expect(r.out).toMatch(/Migracje: przed=00300/);
      expect(r.out).toMatch(/--sucho: koniec planu/);
    });

    itJq('--sucho pokazuje też blokady bez raportu na Telegram', () => {
      const r = uruchom({ args: ['--sucho'], migracje: { '00300_a.sql': `${NAGL('PRZED')}DELETE FROM x;\n` } });
      expect(r.kod).toBe(1);
      expect(r.telegram).toEqual([]);
      expect(r.out).toMatch(/00300: zakazane bez człowieka: DELETE FROM/);
    });
  });

  describe('ci_stan i wybór SHA', () => {
    itJq('nie przyjmuje SHA spoza main', () => {
      const r = uruchom({ args: ['--teraz', '--sha', 'a'.repeat(40)] });
      expect(r.kod).toBe(1);
      expect(r.calls).toEqual([]);
      expect(r.telegram.join('\n')).toMatch(/SHA poza main/);
    });

    itJq('nie przyjmuje skróconego SHA', () => {
      const r = uruchom({ args: ['--teraz', '--sha', 'abc1234'] });
      expect(r.kod).toBe(1);
      expect(r.calls).toEqual([]);
    });
  });

  it('skrypt przechodzi bash -n', () => {
    const r = spawnSync('bash', ['-n', SKRYPT], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  });

  it('nie zawiera set -x ani nie wypisuje tokenu w poleceniach curl', () => {
    const tresc = readFileSync(SKRYPT, 'utf8');
    expect(tresc).not.toMatch(/^\s*set -[a-z]*x/m);
    expect(tresc).toMatch(/-K -/);
    expect(tresc).not.toMatch(/api\.telegram\.org\/bot\$\{?TELEGRAM_BOT_TOKEN\}?[^%]/);
  });
});
