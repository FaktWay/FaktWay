import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * `scripts/ops/scal-pr.sh` (etykieta `scal` przez REST) i
 * `scripts/ops/odswiez-pr.sh` (odświeżenie kontroli po włączeniu kolejki).
 *
 * Uruchamiane są PRAWDZIWE skrypty z atrapami `gh` (tylko `gh api`, odpowiedzi
 * z plików JSON przepuszczone przez PRAWDZIWY `jq` według wyrażenia z `--jq`,
 * więc wyrażenia ze skryptu są sprawdzane naprawdę) i `sleep` (bez czekania).
 * Atrapa `gh` przyjmuje `gh api` oraz jedno `gh pr merge` (krok „scalanie z konta
 * człowieka” w `scal-pr.sh`, który w sesji chmurowej kończy się ostrzeżeniem,
 * bo GraphQL jest tam zablokowany); `odswiez-pr.sh` nadal używa tylko REST.
 * Plik `<nazwa>.<k>.json` odpowiada na k-te wywołanie danej ścieżki (kolejne
 * odpytania w pętli czekania), a `<nazwa>.json` na pozostałe.
 */

const SCAL = resolve(__dirname, '../../scripts/ops/scal-pr.sh');
const ODSWIEZ = resolve(__dirname, '../../scripts/ops/odswiez-pr.sh');
const SHA = 'a'.repeat(40);
const REPO = 'FaktWay/FaktWay';

const jqProbe = spawnSync('bash', ['-c', `printf '{"a":1}' | jq -r .a`], { encoding: 'utf8' });
const hasJq = jqProbe.status === 0 && jqProbe.stdout === '1\n';
const onCi = !['', '0', 'false'].includes(process.env.CI ?? '');
const NO_JQ = 'brak jq w bashu: atrapa gh stosuje wyrażenia --jq prawdziwym jq';
if (!hasJq && !onCi) console.warn(`${NO_JQ}: testy skryptów scalania są pominięte.`);

function itJq(name: string, fn: () => void) {
  it(name, (ctx) => {
    if (!hasJq) {
      if (onCi) throw new Error(`${NO_JQ}. Na CI to błąd obrazu runnera.`);
      ctx.skip(NO_JQ);
    }
    fn();
  });
}

const FAKE_GH = `#!/usr/bin/env bash
if [ "$1" = pr ] && [ "$2" = merge ]; then
  echo "PRMERGE $3 \${*:4}" >> "$FAKE_DIR/calls.log"
  if [ -f "$FAKE_DIR/fail-prmerge" ]; then echo "GraphQL: Resource not accessible by integration" >&2; exit 1; fi
  exit 0
fi
[ "$1" = api ] || { echo "atrapa gh: oczekiwałem api albo pr merge, jest: $*" >&2; exit 9; }
shift
metoda=GET; wyrazenie=""; sciezka=""; pola=""
while [ $# -gt 0 ]; do
  case "$1" in
    --paginate) shift ;;
    --jq) wyrazenie=$2; shift 2 ;;
    -X) metoda=$2; shift 2 ;;
    -f) pola="$pola $2"; shift 2 ;;
    *) sciezka=$1; shift ;;
  esac
done
echo "$metoda $sciezka$pola" >> "$FAKE_DIR/calls.log"
baza=$(printf '%s' "$sciezka" | sed 's/?.*//')
if [ "$metoda" != GET ]; then
  if [ -f "$FAKE_DIR/fail-$metoda" ]; then echo "HTTP 403" >&2; exit 1; fi
  exit 0
fi
case "$baza" in
  repos/FaktWay/FaktWay/pulls) nazwa=list ;;
  repos/FaktWay/FaktWay/pulls/*) nazwa=pr-$(basename "$baza") ;;
  repos/FaktWay/FaktWay/commits/*/check-runs) nazwa=checks-$(basename "$(dirname "$baza")") ;;
  repos/FaktWay/FaktWay/issues/*/events) nazwa=events ;;
  repos/FaktWay/FaktWay/issues/*/comments) nazwa=comments ;;
  *) echo "atrapa gh: nieznana ścieżka $baza" >&2; exit 8 ;;
esac
licznik=$FAKE_DIR/licznik-$nazwa
k=$(cat "$licznik" 2>/dev/null || echo 0); k=$((k + 1)); echo $k > "$licznik"
plik=""; i=$k
while [ $i -ge 1 ]; do
  if [ -f "$FAKE_DIR/$nazwa.$i.json" ]; then plik=$FAKE_DIR/$nazwa.$i.json; break; fi
  i=$((i - 1))
done
[ -n "$plik" ] || plik=$FAKE_DIR/$nazwa.json
[ -f "$plik" ] || { echo "atrapa gh: brak pliku $plik" >&2; exit 7; }
if [ -n "$wyrazenie" ]; then jq -r "$wyrazenie" "$plik"; else cat "$plik"; fi
`;

const FAKE_SLEEP = `#!/usr/bin/env bash
echo "sleep $*" >> "$FAKE_DIR/sleep.log"
`;

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

type Wynik = { status: number | null; stdout: string; stderr: string; calls: string[] };

function uruchom(skrypt: string, args: string[], fixtures: Record<string, unknown> = {}, env: Record<string, string> = {}): Wynik {
  const dir = mkdtempSync(join(tmpdir(), 'scal-pr-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'gh'), FAKE_GH, { mode: 0o755 });
  writeFileSync(join(dir, 'sleep'), FAKE_SLEEP, { mode: 0o755 });
  chmodSync(join(dir, 'gh'), 0o755);
  chmodSync(join(dir, 'sleep'), 0o755);
  // Domyślnie PR nie ma zdarzeń kolejki ani komentarzy; test może je nadpisać.
  // `undefined` w teście oznacza „tego pliku nie ma” (atrapa gh odpowie błędem).
  for (const [nazwa, tresc] of Object.entries({ 'events.json': [], 'comments.json': [], ...fixtures })) {
    if (tresc !== undefined) writeFileSync(join(dir, nazwa), JSON.stringify(tresc));
  }
  const wynik = spawnSync('bash', [skrypt, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`, FAKE_DIR: dir, SCAL_ODSTEP: '30', SCAL_LIMIT_MIN: '1', ...env },
  });
  const log = join(dir, 'calls.log');
  return {
    status: wynik.status,
    stdout: wynik.stdout,
    stderr: wynik.stderr,
    calls: existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [],
  };
}

const pr = (nadpisz: Record<string, unknown> = {}) => ({
  state: 'open',
  merged: false,
  draft: false,
  base: { ref: 'main' },
  head: { sha: SHA, repo: { full_name: REPO } },
  mergeable_state: 'clean',
  auto_merge: null,
  labels: [],
  merge_commit_sha: null,
  ...nadpisz,
});
const kontrola = (name: string, id: number, status: string, conclusion: string | null) => ({ name, id, status, conclusion });
const ZIELONE = { check_runs: [kontrola('Next build', 1, 'completed', 'success'), kontrola('Filtr: straż', 2, 'completed', 'success')] };
const etykiety = (...nazwy: string[]) => nazwy.map((name) => ({ name }));
const posty = (calls: string[]) => calls.filter((c) => c.startsWith('POST ')).map((c) => c.replace(`POST repos/${REPO}/issues/42/labels `, ''));
const PR42 = `pr-42.json`;
const CHECKS = `checks-${SHA}.json`;

describe('scal-pr.sh: argumenty', () => {
  it('bez argumentów, zły numer, nieznana opcja i nieznana zgoda: kod 2 i zero wywołań gh', () => {
    for (const args of [[], ['abc'], ['42', '--nieznana'], ['42', '--zgoda', 'cokolwiek'], ['42', '--zgoda']]) {
      const w = uruchom(SCAL, args);
      expect(w.status, args.join(' ')).toBe(2);
      expect(w.calls).toEqual([]);
    }
  });

  it('--zgoda bez --po-drugim-czytelniku: odmowa przed jakimkolwiek wywołaniem GitHuba', () => {
    const w = uruchom(SCAL, ['42', '--zgoda', 'zmiana-filtra']);
    expect(w.status).toBe(1);
    expect(w.stderr).toMatch(/po drugim czytelniku/);
    expect(w.stderr).toContain('--po-drugim-czytelniku');
    expect(w.calls).toEqual([]);
  });
});

describe('scal-pr.sh: odmowy (nic nie jest nadawane)', () => {
  const odmowy: Array<[string, Record<string, unknown>, RegExp]> = [
    ['PR zamknięty', pr({ state: 'closed' }), /stan „closed”/],
    ['szkic', pr({ draft: true }), /szkicem/],
    ['baza inna niż main', pr({ base: { ref: 'claude/stos' } }), /bazę|bazą „claude\/stos”/],
    ['fork', pr({ head: { sha: SHA, repo: { full_name: 'ktos/FaktWay' } } }), /fork/],
    ['usunięte repozytorium głowy', pr({ head: { sha: SHA, repo: null } }), /fork/],
    ['etykieta wstrzymaj', pr({ labels: etykiety('wstrzymaj') }), /wstrzymaj/],
    ['konflikt z main', pr({ mergeable_state: 'dirty' }), /konflikt/],
  ];
  it.each(odmowy)('odmawia: %s', (_nazwa, wejscie, powod) => {
    if (!hasJq) return;
    const w = uruchom(SCAL, ['42'], { [PR42]: wejscie, [CHECKS]: ZIELONE });
    expect(w.status).toBe(1);
    expect(w.stderr).toMatch(powod);
    expect(posty(w.calls)).toEqual([]);
  });

  itJq('czerwona kontrola: odmowa z jej nazwą, czerwonej się nie obchodzi', () => {
    const w = uruchom(SCAL, ['42'], {
      [PR42]: pr(),
      [CHECKS]: { check_runs: [kontrola('Next build', 1, 'completed', 'failure'), kontrola('Secret scan', 2, 'completed', 'success')] },
    });
    expect(w.status).toBe(1);
    expect(w.stderr).toContain('Next build (failure)');
    expect(w.stderr).not.toContain('Secret scan');
    expect(posty(w.calls)).toEqual([]);
  });

  itJq('anulowana, przeterminowana i wymagająca akcji też są czerwone', () => {
    for (const wynik of ['cancelled', 'timed_out', 'action_required', 'startup_failure']) {
      const w = uruchom(SCAL, ['42'], { [PR42]: pr(), [CHECKS]: { check_runs: [kontrola('Vitest (część 1/3)', 1, 'completed', wynik)] } });
      expect(w.status, wynik).toBe(1);
      expect(w.stderr).toContain(`Vitest (część 1/3) (${wynik})`);
      expect(w.calls.some((c) => c.startsWith('PRMERGE'))).toBe(false);
    }
  });

  itJq('starsza anulowana kontrola przy nowszej zielonej tej samej nazwy nie blokuje', () => {
    const w = uruchom(SCAL, ['42'], {
      [PR42]: pr(),
      [CHECKS]: { check_runs: [kontrola('Filtr: straż', 3, 'completed', 'cancelled'), kontrola('Filtr: straż', 7, 'completed', 'success')] },
    });
    expect(w.status).toBe(0);
    expect(posty(w.calls)).toEqual(['labels[]=scal']);
  });

  itJq('brak odpowiedzi o PR: odmowa', () => {
    const w = uruchom(SCAL, ['42']);
    expect(w.status).toBe(1);
    expect(w.stderr).toMatch(/Nie mogę odczytać PR #42/);
  });
});

describe('scal-pr.sh: nadanie etykiety', () => {
  itJq('zwykły PR: tylko etykieta scal przez REST POST, kontrole w toku nie przeszkadzają', () => {
    const w = uruchom(SCAL, ['42'], {
      [PR42]: pr(),
      [CHECKS]: { check_runs: [kontrola('Next build', 1, 'in_progress', null), kontrola('Secret scan', 2, 'completed', 'success')] },
    });
    expect(w.status).toBe(0);
    expect(posty(w.calls)).toEqual(['labels[]=scal']);
    expect(w.calls.every((c) => !c.includes('graphql') && !c.includes('--admin'))).toBe(true);
    expect(w.stdout).toContain('etykieta scal nadana');
    expect(w.stdout).toContain('gh api repos/FaktWay/FaktWay/pulls/42');
  });

  itJq('po etykiecie włącza scalanie z konta człowieka: gh pr merge z SHA głowy, bez --admin i bez wskazania metody', () => {
    // Auto-merge i wpis do kolejki zrobione przez GITHUB_TOKEN nie uruchamiają kontroli grupy
    // (#765) i nie wstawiły do kolejki żadnego PR (#757, #759, #760, #761, #767, #769, #785, #786).
    const w = uruchom(SCAL, ['42'], { [PR42]: pr(), [CHECKS]: ZIELONE });
    expect(w.status).toBe(0);
    const merge = w.calls.filter((c) => c.startsWith('PRMERGE'));
    expect(merge).toEqual([`PRMERGE 42 -R ${REPO} --match-head-commit ${SHA}`]);
    expect(w.calls.indexOf(`POST repos/${REPO}/issues/42/labels labels[]=scal`)).toBeLessThan(w.calls.indexOf(merge[0]));
    expect(w.stdout).toContain('scalanie włączone z Twojego konta');
  });

  itJq('GraphQL zablokowany (sesja chmurowa): ostrzeżenie z SCAL_TOKEN, etykieta zostaje, kod 0', () => {
    const w = uruchom(SCAL, ['42'], { [PR42]: pr(), [CHECKS]: ZIELONE, 'fail-prmerge': '' });
    expect(w.status).toBe(0);
    expect(posty(w.calls)).toEqual(['labels[]=scal']);
    expect(w.stderr).toContain('ostrzeżenie: nie włączyłem scalania z konta gh');
    expect(w.stderr).toContain('SCAL_TOKEN');
    expect(w.stdout).not.toContain('scalanie włączone z Twojego konta');
  });

  itJq('PR z włączonym scalaniem albo w kolejce: gh pr merge nie jest wołane (zostaje miejsce w kolejce)', () => {
    const w = uruchom(SCAL, ['42'], { [PR42]: pr({ auto_merge: { enabled_by: { login: 'ezior8888-cpu' } }, labels: etykiety('scal') }), [CHECKS]: ZIELONE });
    expect(w.status).toBe(0);
    expect(w.calls.some((c) => c.startsWith('PRMERGE'))).toBe(false);
    const wKolejce = uruchom(SCAL, ['42'], { [PR42]: pr(), [CHECKS]: ZIELONE, 'events.json': [{ event: 'added_to_merge_queue' }] });
    expect(wKolejce.status).toBe(0);
    expect(wKolejce.calls.some((c) => c.startsWith('PRMERGE'))).toBe(false);
  });

  itJq('etykieta scal już na PR: gh pr merge wystarcza, etykiety nie zdejmuje (zdjęcie to zdarzenie, które workflow obsłuży jako wyłączenie scalania)', () => {
    // Wyścig z przeglądu: DELETE etykiety przez konto człowieka uruchamia workflow `unlabeled`,
    // który mógłby wyłączyć scalanie włączone chwilę później przez `gh pr merge`.
    const w = uruchom(SCAL, ['42'], { [PR42]: pr({ labels: etykiety('scal') }), [CHECKS]: ZIELONE });
    expect(w.status).toBe(0);
    expect(w.calls.filter((c) => c.startsWith('DELETE') || c.startsWith('POST'))).toEqual([]);
    expect(w.calls.filter((c) => c.startsWith('PRMERGE'))).toEqual([`PRMERGE 42 -R ${REPO} --match-head-commit ${SHA}`]);
    expect(w.stdout).toContain('scalanie włączone z Twojego konta');
  });

  itJq('etykieta scal już na PR, a gh pr merge zawodzi (chmura): etykieta zdjęta i nadana od nowa, żeby workflow z SCAL_TOKEN zadziałał', () => {
    const w = uruchom(SCAL, ['42'], { [PR42]: pr({ labels: etykiety('scal') }), [CHECKS]: ZIELONE, 'fail-prmerge': '' });
    expect(w.status).toBe(0);
    const iDelete = w.calls.indexOf(`DELETE repos/${REPO}/issues/42/labels/scal`);
    const iPost = w.calls.indexOf(`POST repos/${REPO}/issues/42/labels labels[]=scal`);
    expect(iDelete).toBeGreaterThan(-1);
    expect(iPost).toBeGreaterThan(iDelete);
    expect(w.stderr).toContain('SCAL_TOKEN');
  });

  itJq('gh pr merge zawodzi, bo głowa PR zmieniła się po odczycie (ktoś wypchnął commit): nie nadaje etykiety od nowa na nieprzejrzany commit', () => {
    // Workflow z SCAL_TOKEN bierze SHA z zdarzenia etykiety, więc ponowne nadanie uzbroiłoby scalanie nowego commita.
    const nowaGlowa = 'b'.repeat(40);
    const w = uruchom(SCAL, ['42'], {
      [PR42]: pr({ labels: etykiety('scal') }),
      'pr-42.2.json': pr({ labels: etykiety('scal'), head: { sha: nowaGlowa, repo: { full_name: REPO } } }),
      [CHECKS]: ZIELONE,
      'fail-prmerge': '',
    });
    expect(w.status).toBe(1);
    expect(w.stderr).toMatch(/Głowa PR zmieniła się po odczycie/);
    expect(w.calls.filter((c) => c.startsWith('DELETE') || c.startsWith('POST'))).toEqual([]);
  });

  itJq('scalanie włączone wcześniej przez bota (github-actions[bot]) nie liczy się jako „w drodze”: wyłącza je i włącza z konta człowieka', () => {
    // Auto-merge z tokenu Actions nie wstawia PR do kolejki (docs/runbooks/scalanie-pr.md).
    const w = uruchom(SCAL, ['42'], {
      [PR42]: pr({ labels: etykiety('scal'), auto_merge: { enabled_by: { login: 'github-actions[bot]' } } }),
      [CHECKS]: ZIELONE,
    });
    expect(w.status).toBe(0);
    const merge = w.calls.filter((c) => c.startsWith('PRMERGE'));
    expect(merge).toEqual([`PRMERGE 42 -R ${REPO} --disable-auto`, `PRMERGE 42 -R ${REPO} --match-head-commit ${SHA}`]);
    expect(w.stdout).not.toMatch(/już włączone scalanie albo jest w kolejce/);
  });

  itJq('scal i włączone automatyczne scalanie: etykiety nie rusza (nie traci miejsca w kolejce)', () => {
    const w = uruchom(SCAL, ['42'], { [PR42]: pr({ labels: etykiety('scal'), auto_merge: { merge_method: 'merge' } }), [CHECKS]: ZIELONE });
    expect(w.status).toBe(0);
    expect(w.stdout).toMatch(/już włączone scalanie albo jest w kolejce/);
    expect(w.calls.filter((c) => c.startsWith('POST') || c.startsWith('DELETE'))).toEqual([]);
  });

  itJq('PR jest w kolejce (ostatnie zdarzenie: added_to_merge_queue): etykiety nie rusza', () => {
    const w = uruchom(SCAL, ['42'], {
      [PR42]: pr({ labels: etykiety('scal') }),
      [CHECKS]: ZIELONE,
      'events.json': [{ id: 1, event: 'added_to_merge_queue' }],
    });
    expect(w.status).toBe(0);
    expect(w.calls.filter((c) => c.startsWith('POST') || c.startsWith('DELETE'))).toEqual([]);
  });

  itJq('wypadł z kolejki (po wejściu nastąpiło wyjście): ponowny wpis gh pr merge, etykieta zostaje', () => {
    const w = uruchom(SCAL, ['42'], {
      [PR42]: pr({ labels: etykiety('scal') }),
      [CHECKS]: ZIELONE,
      'events.json': [{ id: 1, event: 'added_to_merge_queue' }, { id: 2, event: 'removed_from_merge_queue' }],
    });
    expect(w.status).toBe(0);
    // Etykieta już jest: wystarczy ponowny wpis kontem człowieka (bez DELETE, które wyłączyłoby scalanie).
    expect(w.calls.filter((c) => c.startsWith('DELETE') || c.startsWith('POST'))).toEqual([]);
    expect(w.calls.filter((c) => c.startsWith('PRMERGE'))).toHaveLength(1);
  });

  itJq('scalanie włączone poleceniem gh pr merge --auto (bez etykiety): etykiety nie nadaje, --czekaj nie żąda scal', () => {
    const autoMerge = { auto_merge: { merge_method: 'merge' } };
    const w = uruchom(SCAL, ['42', '--czekaj'], { [PR42]: pr(autoMerge), [CHECKS]: ZIELONE, 'pr-42.2.json': pr(autoMerge) });
    expect(w.stderr).not.toMatch(/Etykieta scal została zdjęta/);
    expect(posty(w.calls)).toEqual([]);
    expect(w.status).toBe(3);
  });

  itJq('nie da się odczytać zdarzeń kolejki: odmowa bez zmian (nie zgadujemy, czy PR jest w kolejce)', () => {
    const w = uruchom(SCAL, ['42'], { [PR42]: pr({ labels: etykiety('scal') }), [CHECKS]: ZIELONE, 'events.json': undefined });
    expect(w.status).toBe(1);
    expect(w.stderr).toMatch(/zdarzeń kolejki/);
    expect(w.calls.filter((c) => c.startsWith('POST') || c.startsWith('DELETE'))).toEqual([]);
  });

  itJq('--zgoda po drugim czytelniku: etykiety zgody PRZED scal, straż czerwona z braku etykiet nie blokuje', () => {
    const w = uruchom(
      SCAL,
      ['42', '--zgoda', 'zmiana-filtra', '--zgoda', 'wiedza-prawna', '--po-drugim-czytelniku'],
      {
        [PR42]: pr(),
        [`checks-${SHA}.1.json`]: { check_runs: [kontrola('Filtr: straż', 5, 'completed', 'failure'), kontrola('Next build', 1, 'completed', 'success')] },
        // Po nadaniu etykiet straż ruszyła od nowa (nowy przebieg w toku).
        [`checks-${SHA}.2.json`]: {
          check_runs: [kontrola('Filtr: straż', 5, 'completed', 'failure'), kontrola('Filtr: straż', 9, 'in_progress', null), kontrola('Next build', 1, 'completed', 'success')],
        },
      },
    );
    expect(w.status).toBe(0);
    expect(posty(w.calls)).toEqual(['labels[]=zgoda:zmiana-filtra', 'labels[]=zgoda:wiedza-prawna', 'labels[]=scal']);
  });

  itJq('--zgoda: inna czerwona kontrola niż straż nadal blokuje i nic nie nadaje', () => {
    const w = uruchom(SCAL, ['42', '--zgoda', 'wyjatek-filtra', '--po-drugim-czytelniku'], {
      [PR42]: pr(),
      [CHECKS]: { check_runs: [kontrola('Next build', 1, 'completed', 'failure'), kontrola('Filtr: straż', 5, 'completed', 'failure')] },
    });
    expect(w.status).toBe(1);
    expect(w.stderr).toContain('Next build (failure)');
    expect(posty(w.calls)).toEqual([]);
  });

  itJq('--zgoda: straż nadal czerwona po etykietach: scal NIE jest nadane, zgody zostają', () => {
    const w = uruchom(SCAL, ['42', '--zgoda', 'zmiana-filtra', '--po-drugim-czytelniku'], {
      [PR42]: pr(),
      [CHECKS]: { check_runs: [kontrola('Filtr: straż', 5, 'completed', 'failure')] },
    });
    expect(w.status).toBe(1);
    expect(w.stderr).toMatch(/Filtr: straż.*nadal czerwona/);
    expect(posty(w.calls)).toEqual(['labels[]=zgoda:zmiana-filtra']);
  });

  itJq('brak uprawnień do etykiety: komunikat o liście zgody.json i kod 1', () => {
    const w = uruchom(SCAL, ['42'], { [PR42]: pr(), [CHECKS]: ZIELONE, 'fail-POST': true });
    expect(w.status).toBe(1);
    expect(w.stderr).toMatch(/filtr\/zgody\.json/);
  });
});

describe('scal-pr.sh --czekaj', () => {
  const zScal = pr({ labels: etykiety('scal') });

  itJq('PR scalony: MERGED z SHA commitu scalenia', () => {
    const w = uruchom(SCAL, ['42', '--czekaj'], {
      [PR42]: pr(),
      [CHECKS]: ZIELONE,
      'pr-42.2.json': pr({ state: 'closed', merged: true, labels: etykiety('scal'), merge_commit_sha: 'b'.repeat(40) }),
    });
    expect(w.status).toBe(0);
    expect(w.stdout).toContain(`MERGED PR #42: ${'b'.repeat(40)}`);
  });

  itJq('PR zamknięty bez scalenia: kod 1', () => {
    const w = uruchom(SCAL, ['42', '--czekaj'], { [PR42]: pr(), [CHECKS]: ZIELONE, 'pr-42.2.json': pr({ state: 'closed' }) });
    expect(w.status).toBe(1);
    expect(w.stderr).toMatch(/zamknięty bez scalenia/);
  });

  itJq('workflow zdjął etykietę scal: wypisuje jego ostatni komentarz i kod 1', () => {
    const w = uruchom(SCAL, ['42', '--czekaj'], {
      [PR42]: pr(),
      [CHECKS]: ZIELONE,
      'pr-42.2.json': pr({ labels: [] }),
      'comments.json': [{ body: 'stary' }, { body: 'Nie włączam scalania: PR jest szkicem.' }],
    });
    expect(w.status).toBe(1);
    expect(w.stderr).toMatch(/Etykieta scal została zdjęta/);
    expect(w.stderr).toContain('Nie włączam scalania: PR jest szkicem.');
  });

  itJq('kontrola zaczerwieniła się w trakcie: kod 1 z jej nazwą', () => {
    const w = uruchom(SCAL, ['42', '--czekaj'], {
      [PR42]: pr(),
      [`checks-${SHA}.1.json`]: ZIELONE,
      [`checks-${SHA}.2.json`]: { check_runs: [kontrola('RLS isolation (lokalny Supabase)', 4, 'completed', 'failure')] },
      'pr-42.2.json': zScal,
    });
    expect(w.status).toBe(1);
    expect(w.stderr).toContain('RLS isolation (lokalny Supabase) (failure)');
  });

  itJq('PR wypadł z kolejki (nowe zdarzenie removed_from_merge_queue): kod 1', () => {
    const w = uruchom(SCAL, ['42', '--czekaj'], {
      [PR42]: pr(),
      [CHECKS]: ZIELONE,
      'pr-42.2.json': zScal,
      'events.1.json': [{ id: 1, event: 'labeled' }],
      'events.2.json': [{ id: 1, event: 'labeled' }, { id: 2, event: 'removed_from_merge_queue' }],
    });
    expect(w.status).toBe(1);
    expect(w.stderr).toMatch(/wypadł z kolejki/);
  });

  itJq('stare wyrzucenie z kolejki sprzed uruchomienia nie liczy się', () => {
    const w = uruchom(SCAL, ['42', '--czekaj'], {
      [PR42]: pr(),
      [CHECKS]: ZIELONE,
      'pr-42.2.json': pr({ state: 'closed', merged: true, merge_commit_sha: 'c'.repeat(40) }),
      'events.json': [{ id: 2, event: 'removed_from_merge_queue' }],
    });
    expect(w.status).toBe(0);
    expect(w.stdout).toContain('MERGED');
  });

  itJq('brak scalenia w limicie czasu: kod 3 i wskazówka', () => {
    const w = uruchom(SCAL, ['42', '--czekaj'], { [PR42]: pr(), [CHECKS]: ZIELONE, 'pr-42.2.json': zScal });
    expect(w.status).toBe(3);
    expect(w.stderr).toMatch(/nie został scalony w 1 min/);
  });
});

describe('odswiez-pr.sh', () => {
  const sha = (znak: string) => znak.repeat(40);
  const wszystkieNowe = (z: string) => ({
    check_runs: [
      kontrola('Mobile (typy i eslint)', 1, 'completed', 'success'),
      kontrola('Filtr: straż', 2, 'completed', z),
      kontrola('Filtr: testy prawne', 3, 'completed', 'success'),
      kontrola('RLS isolation (lokalny Supabase)', 4, 'completed', 'success'),
    ],
  });
  const fixtures = {
    'list.json': [
      { number: 10, title: 'Brak mobile' },
      { number: 11, title: 'Wszystko jest | zielone' },
      { number: 12, title: 'Szkic' },
      { number: 13, title: 'Konflikt' },
      { number: 14, title: 'W drodze do kolejki' },
      { number: 15, title: 'Straż czerwona' },
      { number: 16, title: 'Straż anulowana' },
      { number: 17, title: 'Scalanie włączone przez gh pr merge --auto' },
    ],
    'pr-10.json': pr({ head: { sha: sha('b'), repo: { full_name: REPO } } }),
    'pr-11.json': pr({ head: { sha: sha('c'), repo: { full_name: REPO } } }),
    'pr-12.json': pr({ draft: true }),
    'pr-13.json': pr({ mergeable_state: 'dirty' }),
    'pr-14.json': pr({ labels: etykiety('scal') }),
    'pr-15.json': pr({ head: { sha: sha('d'), repo: { full_name: REPO } } }),
    'pr-16.json': pr({ head: { sha: sha('e'), repo: { full_name: REPO } } }),
    // Włączone automatyczne scalanie bez etykiety: zamknięcie wyjęłoby PR z kolejki.
    'pr-17.json': pr({ auto_merge: { merge_method: 'merge' }, head: { sha: sha('f'), repo: { full_name: REPO } } }),
    [`checks-${sha('b')}.json`]: { check_runs: wszystkieNowe('success').check_runs.slice(1) },
    [`checks-${sha('c')}.json`]: wszystkieNowe('success'),
    [`checks-${sha('d')}.json`]: wszystkieNowe('failure'),
    [`checks-${sha('e')}.json`]: wszystkieNowe('cancelled'),
  };

  itJq('bez argumentów tylko listuje PR z brakami i podaje polecenie, nic nie zmienia', () => {
    const w = uruchom(ODSWIEZ, [], fixtures);
    expect(w.status).toBe(0);
    expect(w.stdout).toContain('#10 brak kontroli „Mobile (typy i eslint)”');
    expect(w.stdout).toContain('#15 „Filtr: straż”: failure');
    expect(w.stdout).toContain('#16 „Filtr: straż”: cancelled');
    expect(w.stdout).not.toMatch(/#11 /);
    expect(w.stdout).toMatch(/#12 szkic/);
    expect(w.stdout).toMatch(/#13 konflikt z main.*git merge origin\/main/);
    expect(w.stdout).toMatch(/#14 ma scal albo włączone scalanie/);
    expect(w.stdout).toMatch(/#17 ma scal albo włączone scalanie/);
    expect(w.stdout).toContain('./scripts/ops/odswiez-pr.sh 10 15 16');
    expect(w.calls.some((c) => c.startsWith('PATCH') || c.startsWith('POST') || c.startsWith('DELETE'))).toBe(false);
  });

  itJq('wskazane PR: zamknięcie i ponowne otwarcie przez REST PATCH, w tej kolejności; szkic, scal i konflikt pomija', () => {
    const w = uruchom(ODSWIEZ, ['10', '12', '14', '17', '13'], fixtures);
    expect(w.status).toBe(1); // konflikt to błąd do naprawy po stronie autora
    const patche = w.calls.filter((c) => c.startsWith('PATCH'));
    expect(patche).toEqual([`PATCH repos/${REPO}/pulls/10 state=closed`, `PATCH repos/${REPO}/pulls/10 state=open`]);
    expect(w.stdout).toContain('#10 odświeżony');
    expect(w.stdout).toMatch(/#12 szkic: pomijam/);
    expect(w.stdout).toMatch(/#14 ma scal albo włączone scalanie: pomijam/);
    expect(w.stdout).toMatch(/#17 ma scal albo włączone scalanie: pomijam/);
    expect(w.stdout).toMatch(/#13 ma konflikt z main/);
  });

  itJq('PR bez braków odświeża na wyraźne polecenie, z uwagą', () => {
    const w = uruchom(ODSWIEZ, ['11'], fixtures);
    expect(w.status).toBe(0);
    expect(w.stdout).toMatch(/#11 nie ma braków.*odświeżam/);
    expect(w.calls.filter((c) => c.startsWith('PATCH'))).toHaveLength(2);
  });

  itJq('błąd zamknięcia: kod 1, próba przywrócenia otwartego PR', () => {
    const w = uruchom(ODSWIEZ, ['10'], { ...fixtures, 'fail-PATCH': true });
    expect(w.status).toBe(1);
    expect(w.stdout).toMatch(/#10: odświeżenie nie przeszło/);
    expect(w.calls.filter((c) => c === `PATCH repos/${REPO}/pulls/10 state=open`).length).toBeGreaterThanOrEqual(1);
  });

  it('zły numer: kod 2 bez wywołań', () => {
    const w = uruchom(ODSWIEZ, ['abc']);
    expect(w.status).toBe(2);
    expect(w.calls).toEqual([]);
  });
});

describe('GraphQL tylko tam, gdzie jego brak nie psuje skryptu', () => {
  const bezKomentarzy = (plik: string) =>
    readFileSync(plik, 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');

  it('odswiez-pr.sh: żadnego `gh pr` ani `gh api graphql` (tylko REST)', () => {
    const tresc = bezKomentarzy(ODSWIEZ);
    expect(tresc).not.toMatch(/\bgh pr (merge|edit|view|close|reopen)\b/);
    expect(tresc).not.toMatch(/graphql/);
  });

  it('scal-pr.sh: jedyny `gh pr` to merge w kroku „scalanie z konta człowieka” (jego błąd to ostrzeżenie), bez --admin i bez graphql', () => {
    const tresc = bezKomentarzy(SCAL);
    expect(tresc).not.toMatch(/\bgh pr (edit|view|close|reopen)\b/);
    expect(tresc).not.toMatch(/graphql/);
    expect(tresc).not.toMatch(/--admin/);
    // Wykonywane są dwa wywołania: włączenie scalania i wyłączenie dawnego scalania bota (`--disable-auto`);
    // pozostałe wzmianki to podpowiedź w tekście ostrzeżenia (`say`).
    const wiersze = tresc.split('\n').filter((l) => /\bgh pr merge\b/.test(l) && !l.trimStart().startsWith('say '));
    expect(wiersze).toHaveLength(2);
    expect(wiersze.filter((l) => l.includes('--disable-auto'))).toHaveLength(1);
    expect(tresc).toMatch(/if blad=\$\(gh pr merge "\$NUMER" -R "\$REPO" --match-head-commit "\$sha" 2>&1\); then/);
  });
});
