import { spawnSync } from 'node:child_process';

/**
 * Tryb pliku w indeksie gita: `100755` (wykonywalny), `100644`, `120000`
 * (dowiązanie) albo pusty napis, gdy git pliku nie śledzi. `plik` jest względny
 * wobec `repo`.
 *
 * Zamiast `statSync(plik).mode & 0o100`, które na Windowsie zawsze daje 0:
 * NTFS nie ma bitu wykonywalności (Node widzi `100666`), a git trzyma go
 * wtedy tylko w indeksie (`core.fileMode=false`). Z indeksu tryb trafia do
 * commita i do każdego klonu, więc wynik jest ten sam na każdym systemie.
 */
export function trybWGicie(plik: string, repo: string = process.cwd()): string {
  const wynik = spawnSync('git', ['ls-files', '--stage', '--', plik], { cwd: repo, encoding: 'utf8' });
  if (wynik.status !== 0) {
    throw new Error(`git ls-files --stage -- ${plik}: ${(wynik.stderr || wynik.error?.message || '').trim()}`);
  }
  // Linia: `<tryb> <obiekt> <etap>\t<ścieżka>`. Katalog albo plik w konflikcie dałby kilka.
  const linie = wynik.stdout.split('\n').filter(Boolean);
  if (linie.length > 1) throw new Error(`${plik}: zamiast jednego pliku git podał kilka wpisów (${linie.length})`);
  return linie[0]?.split(' ', 1)[0] ?? '';
}
