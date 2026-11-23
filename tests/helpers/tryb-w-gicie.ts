import { spawnSync } from 'node:child_process';
import { posix } from 'node:path';

/**
 * Tryb pliku w indeksie gita: `100755` (wykonywalny), `100644`, `120000`
 * (dowiązanie) albo pusty napis, gdy git pliku nie śledzi. `plik` jest względny
 * wobec `repo`. Katalog albo plik w konflikcie kończą się wyjątkiem.
 *
 * Zamiast `statSync(plik).mode & 0o100`, które na Windowsie zawsze daje 0:
 * NTFS nie ma bitu wykonywalności (Node widzi `100666`), a git trzyma go
 * wtedy tylko w indeksie (`core.fileMode=false`). Z indeksu tryb trafia do
 * commita, a z niego do każdego klonu (na Linuksie i macOS także na dysk),
 * więc wynik jest ten sam na każdym systemie.
 */
export function trybWGicie(plik: string, repo: string = process.cwd()): string {
  // `--literal-pathspecs`: `*` albo `[` w nazwie to znak, nie wzorzec. `-z`: ścieżki bez cytowania.
  const wynik = spawnSync('git', ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', plik], {
    cwd: repo,
    encoding: 'utf8',
  });
  if (wynik.status !== 0) {
    throw new Error(`git ls-files --stage -- ${plik}: ${(wynik.stderr || wynik.error?.message || '').trim()}`);
  }
  // Wpis: `<tryb> <obiekt> <etap>\t<ścieżka>`. Pod ścieżką katalogu git poda pliki z jego wnętrza,
  // więc liczy się tylko wpis z dokładnie tą ścieżką. Plik w konflikcie ma ich kilka (etapy od 1 do 3).
  const wpisy = wynik.stdout.split('\0').filter(Boolean);
  const sciezki = wpisy.map((wpis) => wpis.slice(wpis.indexOf('\t') + 1));
  const doPliku = wpisy.filter((_, i) => sciezki[i] === posix.normalize(plik));
  if (doPliku.length === 0 && wpisy.length > 0) {
    throw new Error(`${plik}: to nie plik, git ma pod tą ścieżką np. ${sciezki.slice(0, 3).join(', ')} (katalog?)`);
  }
  if (doPliku.length > 1) throw new Error(`${plik}: git podał kilka wpisów (${doPliku.length}), plik w konflikcie?`);
  return doPliku[0]?.split(' ', 1)[0] ?? '';
}
