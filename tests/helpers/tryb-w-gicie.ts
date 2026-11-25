import { spawnSync } from 'node:child_process';
import { posix } from 'node:path';

/**
 * Tryb pliku w indeksie gita: `100755` (wykonywalny), `100644`, `120000`
 * (dowiązanie), `160000` (submoduł) albo pusty napis, gdy git pliku nie śledzi.
 * `plik` jest względny wobec `repo`. Wyjątek dostaje katalog, w którym git coś
 * śledzi, i plik w konflikcie.
 *
 * Zamiast `statSync(plik).mode & 0o100`, które na Windowsie zawsze daje 0:
 * NTFS nie ma bitu wykonywalności (Node widzi `100666`), a git trzyma go
 * wtedy tylko w indeksie (`core.fileMode=false`). Z indeksu tryb trafia do
 * commita, a z niego do każdego klonu (na Linuksie i macOS także na dysk),
 * więc wynik jest ten sam na każdym systemie.
 */
export function trybWGicie(plik: string, repo: string = process.cwd()): string {
  // Na Windowsie `\` to separator (tak skleja `join`) i git czyta go jak `/`. Na Linuksie to znak nazwy.
  const sciezka = posix.normalize(process.platform === 'win32' ? plik.replaceAll('\\', '/') : plik);
  // `--literal-pathspecs`: `*` albo `[` w nazwie to znak, nie wzorzec. `-z`: ścieżki bez cytowania.
  const argumenty = ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', sciezka];
  const wynik = spawnSync('git', argumenty, { cwd: repo, encoding: 'utf8' });
  if (wynik.status !== 0) {
    throw new Error(`git ${argumenty.join(' ')}: ${(wynik.stderr || wynik.error?.message || '').trim()}`);
  }
  // Wpis: `<tryb> <obiekt> <etap>\t<ścieżka>`. Pod ścieżką katalogu git poda pliki z jego wnętrza,
  // więc liczy się tylko wpis z dokładnie tą ścieżką. Etap inny niż 0 to plik w konflikcie.
  const wpisy = wynik.stdout
    .split('\0')
    .filter(Boolean)
    .map((wpis) => {
      const tab = wpis.indexOf('\t');
      const [tryb = '', , etap = ''] = wpis.slice(0, tab).split(' ');
      return { tryb, etap, sciezka: wpis.slice(tab + 1) };
    });
  const doPliku = wpisy.filter((wpis) => wpis.sciezka === sciezka);
  if (doPliku.length === 0 && wpisy.length > 0) {
    const przyklady = wpisy.slice(0, 3).map((wpis) => wpis.sciezka).join(', ');
    throw new Error(`${plik}: to nie plik, git ma pod tą ścieżką np. ${przyklady} (katalog?)`);
  }
  if (doPliku.length > 1 || doPliku.some((wpis) => wpis.etap !== '0')) {
    throw new Error(`${plik}: plik w konflikcie, etapy w indeksie: ${doPliku.map((wpis) => wpis.etap).join(', ')}`);
  }
  return doPliku[0]?.tryb ?? '';
}
