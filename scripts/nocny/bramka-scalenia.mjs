#!/usr/bin/env node
// Bramka scalenia nocnego zespołu (docs/runbooks/nocny-zespol.md, „Bramki scalenia”).
//
// Nocna sesja nadaje PR etykietę `scal` tylko przy TAK z tej bramki i tylko
// przez nią (decyzja Bartosza z 14.11.2026, „Pełny automat”; AGENTS.md,
// niezmiennik 1). Agent w dzień scala przez `scripts/ops/scal-pr.sh` od razu;
// noc najpierw przechodzi ostrzejsze warunki niżej, a dopiero potem bramka woła
// ten sam skrypt, a kolejka scalania GitHuba scala PR po zielonych kontrolach.
// Każde NIE trafia do raportu jako „czeka na Bartosza”. TAK wymaga naraz:
//    1. wyłącznik nocnego zespołu jest wyłączony;
//    2. pliki bramki są takie jak w origin/main (PR nie zmieni reguł, którymi
//       jest oceniany);
//    3. PR jest otwarty, nie jest szkicem, idzie do main z tego repozytorium,
//       z gałęzi zaczynającej się od `agent/nocny-`, bez etykiety `wstrzymaj`;
//    4. na PR nie ma etykiet `zgoda:*`, a „Filtr: straż” żadnej nie zażąda
//       (zmienione linie testów filtra, nowy komentarz wyjątku): nocna sesja
//       zgód nie nadaje, taki PR czeka na Bartosza, który nadaje je osobiście;
//    5. żadnego pliku z migracji, zasad i infrastruktury, wiedzy prawnej
//       i złotych plików ani z obszarów `.github/CODEOWNERS` (etap 1);
//    6. jest nowy albo zmieniony test w tests/; żaden test nie znika, istniejące
//       testy dostają tylko nowe linie (zmiana oczekiwań to decyzja człowieka),
//       a dodane linie nie pomijają testów (`.skip`, `.only`, `.todo`, `.fails`);
//    7. opis ma sekcję „Najpierw test” z plikiem testu z tego PR;
//    8. najnowszy przebieg każdej kontroli na głowie PR jest zielony, a
//       kontrole wymagane (lista niżej i ruleset main) są obecne i mają wynik
//       `success`; „Test-first (agent)” naprawdę uruchomił nowe testy na
//       kodzie bazowym;
//    9. GitHub mówi, że PR nie ma konfliktu (`mergeable`, stan `clean`).
// Przy `--scal` bramka sprawdza tuż przed i tuż po `scal-pr.sh`, że głowa PR to
// wciąż ocenione SHA; nowy commit w tym czasie zdejmuje `scal` (ocena od nowa).
//
// GitHub tylko przez REST (`gh api`): w sesji w chmurze proxy GitHuba odrzuca
// GraphQL, więc `gh pr view`, `gh pr merge` i `gh issue` tam nie działają.
//
// Użycie:
//   node scripts/nocny/bramka-scalenia.mjs <numer PR> [--repo właściciel/nazwa] [--json]
//   node scripts/nocny/bramka-scalenia.mjs <numer PR> --scal   przy TAK: ./scripts/ops/scal-pr.sh <numer PR>
//   node scripts/nocny/bramka-scalenia.mjs --wylacznik          czy noc może pracować
// Kod wyjścia: 0 TAK (przy --scal: etykieta `scal` nadana) albo wyłącznik wyłączony;
//              1 NIE albo wyłącznik włączony (także: `scal` niepewna, ale bramka dodała `wstrzymaj`);
//              2 błąd (traktuj jak NIE i jak stop) albo `scal` może wisieć na nieocenionym
//                commicie, a `wstrzymaj` nie weszła: człowiek dodaje `wstrzymaj` od razu.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ownersFor, parseCodeowners } from '../ci/agent-guard.mjs';
import { KATALOG_REPO, pasujeDoWzorca } from '../filtr/mapa.mjs';
import { MASZYNERIA, TESTY_FILTRA, WIEDZA, bezKomentarzyHtml, liniePatcha, plikiTestowWPolu } from '../filtr/straz.mjs';

export const PREFIKS_GALEZI = 'agent/nocny-';
export const ETYKIETA_STOP = 'nocny:stop';
export const ZMIENNA_STOP = 'NOCNY_STOP';
export const PREFIKS_ZGODY = 'zgoda:';
export const ETYKIETA_OBSZARU = 'zgoda:obszar-wrazliwy';
export const ETYKIETA_SCAL = 'scal';
export const ETYKIETA_WSTRZYMAJ = 'wstrzymaj';
/** `scripts/ops/scal-pr.sh` ma to repozytorium wpisane na stałe. */
export const REPO_KOLEJKI = 'FaktWay/FaktWay';
export const SKRYPT_SCALANIA = 'scripts/ops/scal-pr.sh';

/** Muszą być na głowie PR z wynikiem `success`; dochodzą do nich wymagane z rulesetu main. */
export const KONTROLE_WYMAGANE = [
  'Typecheck + Lint + Unit tests',
  'Next build',
  'RLS isolation (lokalny Supabase)',
  'Test-first (agent)',
  'Agent guard',
  'Filtr: straż',
  'Filtr: testy prawne',
  'Mobile (typy i eslint)',
  'Secret scan',
  'Offline security inventory',
  'dependency-review',
  'CodeQL (actions)',
  'CodeQL (javascript-typescript)',
];
export const KONTROLA_TEST_FIRST = 'Test-first (agent)';
/** Krok joba „Test-first (agent)” w .github/workflows/ci.yml, który uruchamia nowe testy na kodzie bazowym. */
export const KROK_TESTU_NA_BAZIE = 'New tests must fail on base';
/** Wynik niewymaganej kontroli, który nie blokuje (wymagane muszą mieć `success`). */
export const WYNIKI_ZIELONE = ['success', 'neutral', 'skipped'];

export const MIGRACJE = ['supabase/migrations/**'];

/** Własne reguły zespołu i agentów, CI, hooki, zależności, obraz, serwery i konfiguracja kontroli. */
export const ZASADY_I_INFRASTRUKTURA = [
  '**/AGENTS.md',
  '**/CLAUDE.md',
  '.claude/**',
  '.github/**',
  '.githooks/**',
  'scripts/ci/**',
  'scripts/security/**',
  'scripts/filtr/**',
  'filtr/**',
  '**/package.json',
  '**/pnpm-lock.yaml',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/.npmrc',
  '**/pnpm-workspace.yaml',
  '**/Dockerfile',
  '**/.dockerignore',
  'next.config.ts',
  'ops/**',
  'scripts/ops/**',
  'scripts/hetzner/**',
  // Skrypty, które hooki i ustawienia sesji uruchamiają same (przygotowanie worktree, hook po edycji, core.hooksPath).
  'scripts/dev/**',
  // Bramka, jej testy i instrukcja nocnego zespołu: zespół nie zmienia własnych zasad.
  'scripts/nocny/**',
  'tests/unit/nocny-*',
  'docs/nocny/**',
  // Instrukcje dla agentów: runbooki, plany wykonywane na hasło, lista kontrolna drugiego czytelnika.
  'docs/runbooks/**',
  'docs/koordynacja/**',
  'docs/filtr/**',
  // Konfiguracja kontroli, które oceniają PR (lint, testy, typy, baza RLS), także w mobile/.
  '**/eslint.config.*',
  'eslint/**',
  'vitest*.config.ts',
  '**/tsconfig*.json',
  'tests/setup*.ts',
  'tests/helpers/**',
  'tests/stubs/**',
  'supabase/**',
  'renovate.json',
  ...MASZYNERIA,
];

/** Wiedza prawna z „Filtra: straż” i pliki z oczekiwanym wynikiem (złote, wyrocznia, migawki). */
export const WIEDZA_I_ZLOTE = [...WIEDZA, '**/__snapshots__/**', 'tests/**/*zlote*', 'docs/ksiegowosc/ZLOTE-*'];

/** Pliki, które bramka czyta z kopii lokalnej: muszą być takie jak w origin/main. */
export const SCIEZKI_BRAMKI = ['scripts/nocny', 'scripts/filtr', 'scripts/ci/agent-guard.mjs', '.github/CODEOWNERS', SKRYPT_SCALANIA];

export const NAGLOWEK_TESTU = /^##\s+(?:Najpierw test|Czerwony test)\b/i;

const TEST = /^tests\/.+\.test\.tsx?$/;
// Znacznik komentarza wyjątku filtra (wzór: docs/runbooks/filtr.md). Składany z części, bo
// „Filtr: straż” liczy każdą dodaną linię z nim jako nowy wyjątek, także w kodzie tej bramki.
const ZNACZNIK_WYJATKU = new RegExp(['filtr', 'wyjatek'].join('-'));
// Pominięcie testu w dodanej linii: `.skip`, `.only`, `.todo`, `.fails` także w łańcuchu
// (`it.concurrent.skip`), `ctx.skip()`, `skipIf(true)`, `runIf(false)`, `xit`, `fdescribe`.
// Warunkowe `skipIf(...)` i `runIf(...)` z warunkiem wolno (testy na bazie).
const POMINIECIE_TESTU =
  /\b(?:describe|it|test|suite|bench)(?:\s*\.\s*\w+)*?\s*\.\s*(?:skip|only|todo|fails)\b|\.\s*skip\s*\(|\b(?:skipIf\s*\(\s*true|runIf\s*\(\s*false)\s*\)|\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(/;
/**
 * Testy spoza zestawu Vitest (`exclude` w vitest.config.ts, uruchamia je tylko job RLS). „Test-first”
 * odpala je na kodzie bazowym jako `vitest run plik`, a „No test files found” to kod 1, czyli rzekomo
 * czerwony test: taki plik w PR niczego nie dowodzi.
 */
export const POZA_VITEST = ['tests/rls-isolation.test.ts', 'tests/rls-uprawnienia.test.ts'];
// Dodane linie, które w istniejącym pliku testu potrafią zmienić stare przypadki (uwaga dla czytelnika).
const PRZESTAWIENIE_TESTOW = /\bvi\s*\.\s*(?:mock|doMock|spyOn|stubGlobal|stubEnv|useFakeTimers)\s*\(|\b(?:beforeEach|beforeAll|afterEach|afterAll)\s*\(/;
/** Kontrole, które czerwienieją z samego braku zgody (CODEOWNERS albo filtra). */
const KONTROLE_ZGODY = ['Agent guard', 'Filtr: straż'];
/** Powód NIE: `zgoda` brak zgody, `skutek` jego skutek (czerwona kontrola zgody, blokada), `inny` reszta. */
const wpis = (tekst, rodzaj = 'inny') => ({ tekst, rodzaj });
const REPO = /^[\w.-]+\/[\w.-]+$/;
const SHA = /^[0-9a-f]{40}$/;

const STANY_SCALENIA = {
  clean: 'gotowy do scalenia',
  dirty: 'konflikt z main',
  behind: 'gałąź za main: scal do niej origin/main i poczekaj na CI',
  blocked: 'blokada rulesetu main (wymagana kontrola nie jest zielona)',
  unstable: 'czerwona kontrola spoza wymaganych',
  draft: 'szkic',
  unknown: 'GitHub jeszcze liczy',
  has_hooks: 'nietypowy stan has_hooks',
};

const KATEGORIE = [
  { id: 'migracje', wzorce: MIGRACJE, opis: 'Migracje: nocny zespół ich nie pisze, migrację przygotowuje i wgrywa człowiek' },
  { id: 'zasady', wzorce: ZASADY_I_INFRASTRUKTURA, opis: 'Zasady i infrastruktura: nocny zespół nie zmienia własnych reguł, CI, zależności ani serwerów' },
  { id: 'wiedza', wzorce: WIEDZA_I_ZLOTE, opis: 'Wiedza prawna i złote pliki: zmiana wymaga źródła i zgody Bartosza' },
];

/** Najwyżej `ile` elementów listy po przecinku. */
export function lista(elementy, ile = 8) {
  const reszta = elementy.length - ile;
  return elementy.slice(0, ile).join(', ') + (reszta > 0 ? ` i ${reszta} więcej` : '');
}

const pasuje = (wzorce, plik) => wzorce.some((wzorzec) => pasujeDoWzorca(wzorzec, plik));

// ---------------------------------------------------------------------------
// Ocena (czyste funkcje: dane wchodzą, powody wychodzą)

/** Kategoria pliku, która wyklucza scalenie bez człowieka, albo null. */
export function kategoriaPliku(sciezka, regulyCodeowners = []) {
  for (const kategoria of KATEGORIE) if (pasuje(kategoria.wzorce, sciezka)) return kategoria.id;
  return ownersFor(sciezka, regulyCodeowners) === null ? null : 'wrazliwe';
}

/** Dodane linie z `.skip` albo `.only` (pominięte testy). */
export function pominieteTesty(patch) {
  return liniePatcha(patch).dodane.filter((linia) => POMINIECIE_TESTU.test(linia));
}

/**
 * Pliki PR: zakazane kategorie i testy. `pliki`: lista z API GitHub
 * (`filename`, `status`, `previous_filename`, `patch`, `changes`).
 */
export function ocenPliki(pliki, regulyCodeowners = []) {
  const kategorie = { migracje: [], zasady: [], wiedza: [], wrazliwe: [] };
  const testy = [];
  const wylaczone = [];
  const pominiete = [];
  const bezPodgladu = [];
  const zmienione = [];
  const pozaVitest = [];
  const przestawienia = [];
  // Zgody, których zażąda „Filtr: straż” (te same reguły co scripts/filtr/straz.mjs, ocenPR, krok 3).
  const zgodyStrazy = { 'zmiana-filtra': [], 'wyjatek-filtra': [] };
  for (const plik of pliki) {
    const nazwy = [plik.filename, plik.previous_filename].filter(Boolean);
    const { dodane, usuniete } = liniePatcha(plik.patch);
    if (
      nazwy.some((nazwa) => pasujeDoWzorca(TESTY_FILTRA, nazwa)) &&
      (plik.status === 'removed' || plik.status === 'renamed' || usuniete.length > 0)
    ) {
      zgodyStrazy['zmiana-filtra'].push(plik.filename);
    }
    if (dodane.some((linia) => ZNACZNIK_WYJATKU.test(linia))) zgodyStrazy['wyjatek-filtra'].push(plik.filename);
    const znalezione = nazwy.map((nazwa) => kategoriaPliku(nazwa, regulyCodeowners)).filter(Boolean);
    const kategoria = ['migracje', 'zasady', 'wiedza', 'wrazliwe'].find((id) => znalezione.includes(id));
    if (kategoria) kategorie[kategoria].push(plik.filename);

    const byltest = Boolean(plik.previous_filename && TEST.test(plik.previous_filename));
    const jestTest = TEST.test(plik.filename);
    if (nazwy.some((nazwa) => POZA_VITEST.includes(nazwa))) pozaVitest.push(plik.filename);
    // Istniejący plik w tests/ (test, pomocnik, fixture, zapadka) dostaje tylko nowe linie: zmieniona albo
    // usunięta linia to zmiana oczekiwań. Testy filtra (tests/filtr/) prowadzi zgoda straży wyżej.
    const istniejacyWTestach =
      nazwy.some((nazwa) => nazwa.startsWith('tests/')) && plik.status !== 'added' && plik.status !== 'copied';
    const testFiltra = nazwy.some((nazwa) => pasujeDoWzorca(TESTY_FILTRA, nazwa));
    const testZnika = (plik.status === 'removed' && jestTest) || (byltest && !jestTest);
    if (istniejacyWTestach && !testFiltra && !testZnika) {
      // Bez podglądu zmian (plik binarny albo za duży diff) też nie wiadomo, co się zmieniło.
      const bezPatcha = typeof plik.patch !== 'string' && !jestTest;
      if (plik.status === 'removed' || bezPatcha || usuniete.length > 0) zmienione.push(plik.filename);
      if (jestTest && dodane.some((linia) => PRZESTAWIENIE_TESTOW.test(linia))) przestawienia.push(plik.filename);
    }
    if (plik.status === 'removed') {
      if (jestTest) wylaczone.push(plik.filename);
      continue;
    }
    if (byltest && !jestTest) {
      wylaczone.push(plik.previous_filename);
      continue;
    }
    if (!jestTest || (plik.changes ?? 1) === 0) continue;
    testy.push(plik.filename);
    if (typeof plik.patch !== 'string') {
      bezPodgladu.push(plik.filename);
      continue;
    }
    if (pominieteTesty(plik.patch).length > 0) pominiete.push(plik.filename);
  }

  const wpisy = [];
  for (const { id, opis } of KATEGORIE) {
    if (kategorie[id].length > 0) wpisy.push(wpis(`${opis}: ${lista(kategorie[id])}.`));
  }
  if (kategorie.wrazliwe.length > 0) {
    wpisy.push(
      wpis(
        `Obszar wrażliwy z .github/CODEOWNERS: ${lista(kategorie.wrazliwe)}. Etap 1: zgodę (${ETYKIETA_OBSZARU}) nadaje Bartosz osobiście.`,
        'zgoda',
      ),
    );
  }
  if (testy.length === 0) wpisy.push(wpis('Brak nowego albo zmienionego testu w tests/ (*.test.ts, *.test.tsx).'));
  if (wylaczone.length > 0) wpisy.push(wpis(`PR wyłącza testy (plik znika albo przestaje być testem): ${lista(wylaczone)}.`));
  if (zmienione.length > 0) {
    wpisy.push(
      wpis(
        `PR zmienia albo usuwa linie istniejących plików w tests/ (testy, pomocnicy, dane, zapadki): ${lista(zmienione)}. Zmiana oczekiwań testu to decyzja człowieka.`,
      ),
    );
  }
  if (pozaVitest.length > 0) {
    wpisy.push(
      wpis(
        `Test spoza zestawu Vitest (exclude w vitest.config.ts): ${lista(pozaVitest)}. „Test-first” nie umie go uruchomić, więc nie dowodzi czerwonego testu.`,
      ),
    );
  }
  if (pominiete.length > 0) wpisy.push(wpis(`Dodane linie pomijają testy (.skip, .only, .todo, .fails i podobne): ${lista(pominiete)}.`));
  if (bezPodgladu.length > 0) {
    wpisy.push(wpis(`GitHub nie pokazał zmian w teście (za duży diff), więc bramka nie sprawdzi pominięć i zmian: ${lista(bezPodgladu)}.`));
  }
  const zgodyFiltra = Object.keys(zgodyStrazy).filter((zgoda) => zgodyStrazy[zgoda].length > 0);
  for (const zgoda of zgodyFiltra) {
    wpisy.push(
      wpis(
        `„Filtr: straż” zażąda etykiety zgoda:${zgoda} (${lista(zgodyStrazy[zgoda])}). Nocna sesja zgód nie nadaje: czeka na Bartosza, który nadaje ją osobiście.`,
        'zgoda',
      ),
    );
  }
  const uwagi = [];
  if (przestawienia.length > 0) {
    uwagi.push(
      `Nowe vi.mock, vi.spyOn albo before/after w istniejących testach (${lista(przestawienia)}): drugi czytelnik sprawdza, czy nie zmieniają starych przypadków.`,
    );
  }
  return { wpisy, kategorie, testy, zgodyFiltra, uwagi };
}

/** Treść sekcji `## …` opisu PR bez komentarzy HTML (do następnego nagłówka # albo ##) albo null. */
export function sekcjaOpisu(opis, naglowek) {
  const linie = bezKomentarzyHtml(opis ?? '').split(/\r?\n/);
  const start = linie.findIndex((linia) => naglowek.test(linia.trim()));
  if (start === -1) return null;
  const tresc = [];
  for (const linia of linie.slice(start + 1)) {
    if (/^#{1,2}\s/.test(linia.trim())) break;
    tresc.push(linia);
  }
  return tresc.join('\n').trim();
}

/** Sekcja z czerwonym testem musi wskazać plik testu, który jest w tym PR. Zwraca powód albo null. */
export function ocenOpis(opis, testy) {
  const sekcja = sekcjaOpisu(opis, NAGLOWEK_TESTU);
  if (sekcja === null) {
    return 'Opis bez sekcji „## Najpierw test” (szablon PR): nie wiadomo, który test był czerwony na main.';
  }
  const wymienione = plikiTestowWPolu(sekcja);
  const trafione = testy.filter((test) => wymienione.some((w) => test === w || test.endsWith(`/${w}`)));
  if (trafione.length === 0) {
    return 'Sekcja „Najpierw test” nie wskazuje pliku testu z tego PR (ścieżka tests/….test.ts).';
  }
  return null;
}

/** Najnowszy przebieg każdej kontroli (największe id: ponowienie i nowe zdarzenie dostają nowe). */
export function najnowszePrzebiegi(przebiegi) {
  const najnowsze = new Map();
  for (const przebieg of przebiegi ?? []) {
    const obecny = najnowsze.get(przebieg.name);
    if (!obecny || (przebieg.id ?? 0) > (obecny.id ?? 0)) najnowsze.set(przebieg.name, przebieg);
  }
  return najnowsze;
}

/** Najnowszy status (stare API statusów commita) dla każdego kontekstu. */
export function najnowszeStatusy(statusy) {
  const najnowsze = new Map();
  for (const status of statusy ?? []) {
    const obecny = najnowsze.get(status.context);
    if (!obecny || (status.id ?? 0) > (obecny.id ?? 0)) najnowsze.set(status.context, status);
  }
  return najnowsze;
}

/** Czy „Test-first (agent)” naprawdę uruchomił nowe testy na kodzie bazowym. Zwraca powód albo null. */
export function ocenTestNaBazie(przebiegTestFirst, kroki) {
  if (!przebiegTestFirst || przebiegTestFirst.status !== 'completed' || przebiegTestFirst.conclusion !== 'success') {
    return `„${KONTROLA_TEST_FIRST}” nie jest zielony, więc nie wiadomo, czy nowy test padał na main.`;
  }
  const krok = (kroki ?? []).find((k) => k.name === KROK_TESTU_NA_BAZIE);
  if (!krok) {
    return `„${KONTROLA_TEST_FIRST}” bez kroku „${KROK_TESTU_NA_BAZIE}”: nie da się potwierdzić, że nowy test padał na main.`;
  }
  if (krok.conclusion !== 'success') {
    return (
      `„${KONTROLA_TEST_FIRST}” pominął test na kodzie bazowym (krok: ${krok.conclusion}): zmiana kodu poza ` +
      'lib/, app/, components/ i proxy.ts albo bez testu w tests/, więc nikt nie sprawdził, że test padał na main.'
    );
  }
  return null;
}

/** Kontrole na głowie PR. `wymagane`: nazwy, które muszą mieć `success`. */
export function ocenKontrole({ przebiegi, statusy, wymagane, krokiTestFirst }) {
  const najnowsze = najnowszePrzebiegi(przebiegi);
  const brakujace = [];
  const wToku = [];
  const czerwone = [];
  for (const nazwa of wymagane) {
    const przebieg = najnowsze.get(nazwa);
    if (!przebieg) brakujace.push(nazwa);
    else if (przebieg.status === 'completed' && przebieg.conclusion !== 'success') {
      czerwone.push(`${nazwa}: ${przebieg.conclusion ?? 'brak wyniku'}`);
    }
  }
  for (const [nazwa, przebieg] of najnowsze) {
    if (przebieg.status !== 'completed') wToku.push(nazwa);
    else if (!wymagane.includes(nazwa) && !WYNIKI_ZIELONE.includes(przebieg.conclusion)) {
      czerwone.push(`${nazwa}: ${przebieg.conclusion ?? 'brak wyniku'}`);
    }
  }
  for (const [kontekst, status] of najnowszeStatusy(statusy)) {
    if (status.state === 'pending') wToku.push(kontekst);
    else if (status.state !== 'success') czerwone.push(`${kontekst}: ${status.state}`);
  }

  const wpisy = [];
  if (brakujace.length > 0) {
    wpisy.push(wpis(`Brak kontroli na głowie PR: ${lista(brakujace)}. CI jeszcze nie ruszyło albo workflow się nie uruchomił.`));
  }
  if (wToku.length > 0) wpisy.push(wpis(`Kontrole w toku: ${lista(wToku)}. Poczekaj i sprawdź ponownie.`));
  const czerwoneZgody = czerwone.filter((opis) => KONTROLE_ZGODY.some((nazwa) => opis.startsWith(`${nazwa}: `)));
  const czerwoneInne = czerwone.filter((opis) => !czerwoneZgody.includes(opis));
  if (czerwoneInne.length > 0) wpisy.push(wpis(`Najnowszy przebieg nie jest zielony: ${lista(czerwoneInne)}.`));
  if (czerwoneZgody.length > 0) {
    wpisy.push(wpis(`Najnowszy przebieg nie jest zielony: ${lista(czerwoneZgody)} (te czerwienieją z braku zgody).`, 'skutek'));
  }
  const testFirst = najnowsze.get(KONTROLA_TEST_FIRST);
  if (testFirst?.status === 'completed' && testFirst.conclusion === 'success') {
    const powod = ocenTestNaBazie(testFirst, krokiTestFirst);
    if (powod) wpisy.push(wpis(powod));
  }
  return wpisy;
}

/** Czy to otwarty PR nocnego zespołu z tego repozytorium do main (bez etykiet i stanu scalenia). */
export function ocenGalaz(pr) {
  const powody = [];
  if (pr.state !== 'open') powody.push(`PR nie jest otwarty (${pr.merged ? 'już scalony' : `stan: ${pr.state}`}).`);
  if (pr.draft) powody.push('PR jest szkicem.');
  if (pr.base?.ref !== 'main') powody.push(`PR idzie do ${pr.base?.ref ?? '?'}, a nie do main.`);
  const zrodlo = pr.head?.repo?.full_name?.toLowerCase();
  if (!zrodlo || zrodlo !== pr.base?.repo?.full_name?.toLowerCase()) {
    powody.push('PR spoza tego repozytorium (fork): nocny zespół scala tylko własne gałęzie.');
  }
  if (!pr.head?.ref?.startsWith(PREFIKS_GALEZI)) powody.push(`Gałąź ${pr.head?.ref ?? '?'} nie zaczyna się od ${PREFIKS_GALEZI}.`);
  return powody;
}

/** Stan PR: gałąź, etykiety (`zgoda:*`, `wstrzymaj`) i możliwość scalenia. Zwraca wpisy z rodzajem. */
export function ocenStanPR(pr) {
  const wpisy = ocenGalaz(pr).map((tekst) => wpis(tekst));
  const etykiety = (pr.labels ?? []).map((etykieta) => etykieta.name);
  const zgody = etykiety.filter((nazwa) => nazwa?.startsWith(PREFIKS_ZGODY));
  if (zgody.length > 0) {
    wpisy.push(wpis(`Etykiety zgody na PR (${zgody.join(', ')}): nocna sesja zgód nie nadaje, taki PR prowadzi Bartosz.`, 'skutek'));
  }
  if (etykiety.includes(ETYKIETA_WSTRZYMAJ)) wpisy.push(wpis(`Etykieta ${ETYKIETA_WSTRZYMAJ}: ktoś zatrzymał scalanie tego PR.`));
  if (pr.mergeable === null || pr.mergeable === undefined) {
    wpisy.push(wpis('GitHub jeszcze liczy, czy PR da się scalić. Sprawdź za minutę.'));
  } else if (pr.mergeable === false || pr.mergeable_state !== 'clean') {
    // `blocked` i `unstable` bywają samym skutkiem czerwonej kontroli zgody; konflikt i reszta nie.
    const rodzaj = pr.mergeable === true && ['blocked', 'unstable'].includes(pr.mergeable_state) ? 'skutek' : 'inny';
    wpisy.push(wpis(`PR nie jest gotowy do scalenia: ${STANY_SCALENIA[pr.mergeable_state] ?? pr.mergeable_state ?? 'stan nieznany'}.`, rodzaj));
  }
  return wpisy;
}

/**
 * Jedna linia do wykonania przez Bartosza, gdy da się ją podać; inaczej null.
 * Zgody nadaje Bartosz osobiście: `zgoda:obszar-wrazliwy` etykietą, zgody straży
 * flagą `--zgoda` w scal-pr.sh.
 */
export function liniaDlaBartosza({ numer, kategorie, etykiety, zgodyFiltra = [], tylkoZgody = true }) {
  if (kategorie.migracje.length + kategorie.zasady.length + kategorie.wiedza.length > 0) {
    return `zmiana poza zasięgiem nocnego zespołu, przejrzyj ją i zdecyduj: gh pr view ${numer} --web`;
  }
  if (kategorie.wrazliwe.length === 0 && zgodyFiltra.length === 0) return null;
  // Zgoda i scalenie tylko wtedy, gdy brak zgody to jedyna przeszkoda; reszty (usunięty test, brak
  // sekcji, pominięty test na bazie) CI po zgodzie by nie złapało.
  if (!tylkoZgody) return `czeka na zgodę, ale ma też inne powody NIE, przejrzyj ją i zdecyduj: gh pr view ${numer} --web`;
  const flagi = zgodyFiltra.map((zgoda) => ` --zgoda ${zgoda}`).join('');
  const scal = `./${SKRYPT_SCALANIA} ${numer}${flagi}${flagi ? ' --po-drugim-czytelniku' : ''} --czekaj`;
  if (kategorie.wrazliwe.length === 0 || etykiety.includes(ETYKIETA_OBSZARU)) return `po przeczytaniu zmian: ${scal}`;
  // `sleep`: „Agent guard” liczy się od nowa po nadaniu etykiety, a scal-pr.sh odmawia przy czerwonej kontroli.
  return `po przeczytaniu zmian: gh pr edit ${numer} --add-label ${ETYKIETA_OBSZARU} && sleep 30 && ${scal}`;
}

/** Ocena całego PR. Zwraca { wynik: 'TAK'|'NIE', numer, sha, galaz, powody, uwagi, linia }. */
export function ocenPR(dane) {
  const wpisy = [];
  const uwagi = [...(dane.uwagi ?? [])];
  if (!dane.zrodlo?.zgodne) wpisy.push(wpis(dane.zrodlo?.powod ?? 'Nie wiadomo, czy bramka działa na zasadach z main.'));
  if (!dane.wylacznik || dane.wylacznik.wlaczony) {
    wpisy.push(wpis(`Wyłącznik nocnego zespołu jest włączony: ${dane.wylacznik?.powod ?? 'stan nieznany'}.`));
  }
  if (dane.wylacznik?.uwaga) uwagi.push(dane.wylacznik.uwaga);

  wpisy.push(...ocenStanPR(dane.pr));
  const pliki = ocenPliki(dane.pliki, dane.codeowners);
  wpisy.push(...pliki.wpisy);
  uwagi.push(...pliki.uwagi);
  if (typeof dane.pr.changed_files === 'number' && dane.pliki.length < dane.pr.changed_files) {
    wpisy.push(wpis(`Lista plików niepełna (${dane.pliki.length} z ${dane.pr.changed_files}): bramka nie widzi całego PR.`));
  }
  const opis = ocenOpis(dane.pr.body, pliki.testy);
  if (opis) wpisy.push(wpis(opis));
  wpisy.push(
    ...ocenKontrole({
      przebiegi: dane.przebiegi,
      statusy: dane.statusy,
      wymagane: dane.wymagane ?? KONTROLE_WYMAGANE,
      krokiTestFirst: dane.krokiTestFirst,
    }),
  );

  const wynik = wpisy.length === 0 ? 'TAK' : 'NIE';
  const etykiety = (dane.pr.labels ?? []).map((etykieta) => etykieta.name);
  const tylkoZgody = wpisy.some((w) => w.rodzaj === 'zgoda') && wpisy.every((w) => w.rodzaj !== 'inny');
  return {
    wynik,
    numer: dane.pr.number,
    sha: dane.pr.head?.sha,
    galaz: dane.pr.head?.ref,
    powody: wpisy.map((w) => w.tekst),
    uwagi,
    // Linia tylko dla własnego, otwartego PR nocnego zespołu: forka ani cudzej gałęzi nie podsuwamy do scalenia.
    linia:
      wynik === 'NIE' && ocenGalaz(dane.pr).length === 0
        ? liniaDlaBartosza({ numer: dane.pr.number, kategorie: pliki.kategorie, etykiety, zgodyFiltra: pliki.zgodyFiltra, tylkoZgody })
        : null,
  };
}

/** Tekst oceny dla sesji i raportu. */
export function opisOceny(ocena) {
  const linie = [];
  if (ocena.wynik === 'TAK') {
    linie.push(`TAK: #${ocena.numer} spełnia warunki nocy (gałąź ${ocena.galaz}, głowa ${ocena.sha}).`);
  } else {
    linie.push(`NIE: #${ocena.numer} czeka na Bartosza.`, 'Powody:', ...ocena.powody.map((powod) => `- ${powod}`));
  }
  if (ocena.uwagi.length > 0) linie.push('Uwagi:', ...ocena.uwagi.map((uwaga) => `- ${uwaga}`));
  if (ocena.linia) linie.push(`Dla Bartosza: ${ocena.linia}`);
  return linie.join('\n');
}

// ---------------------------------------------------------------------------
// Wyłącznik

/** Wartość zmiennej NOCNY_STOP, która zatrzymuje noc: każda poza pustą i jawnym „nie”. */
export function zmiennaWlacza(wartosc) {
  return !['', '0', 'nie', 'no', 'false', 'off'].includes(String(wartosc ?? '').trim().toLowerCase());
}

/**
 * Wyłącznik: otwarte zgłoszenie (albo PR) z etykietą `nocny:stop` albo zmienna
 * repozytorium NOCNY_STOP. Błąd odczytu zgłoszeń przerywa (stop); zmiennej bez
 * uprawnień (401, 403) nie da się odczytać, wtedy działa sama etykieta.
 * @returns {Promise<{ wlaczony: boolean, powod?: string, uwaga?: string }>}
 */
export async function sprawdzWylacznik({ api, repo }) {
  const zgloszenia = await api(`repos/${repo}/issues?state=open&labels=${encodeURIComponent(ETYKIETA_STOP)}&per_page=5`);
  if (!Array.isArray(zgloszenia)) throw new Error('GitHub nie zwrócił listy zgłoszeń: stan wyłącznika nieznany');
  if (zgloszenia.length > 0) {
    return { wlaczony: true, powod: `otwarte zgłoszenie #${zgloszenia[0].number} z etykietą ${ETYKIETA_STOP}` };
  }
  const uwagi = [];
  // Zapytanie o etykietę, której nie ma, też daje pustą listę: bez etykiety wyłącznik przez nią nie działa.
  if (!(await api(`repos/${repo}/labels/${encodeURIComponent(ETYKIETA_STOP)}`, { dopusc404: true }))) {
    uwagi.push(`Etykiety ${ETYKIETA_STOP} nie ma w repozytorium: wyłącznik przez etykietę nie zadziała, dopóki jej nie założysz (instrukcja, sekcja 12).`);
  }
  const wynik = (dodatek = {}) => (uwagi.length > 0 ? { wlaczony: false, ...dodatek, uwaga: uwagi.join(' ') } : { wlaczony: false, ...dodatek });
  try {
    const zmienna = await api(`repos/${repo}/actions/variables/${ZMIENNA_STOP}`, { dopusc404: true });
    if (zmienna && zmiennaWlacza(zmienna.value)) {
      return { wlaczony: true, powod: `zmienna repozytorium ${ZMIENNA_STOP}=${String(zmienna.value).trim().slice(0, 40)}` };
    }
    return wynik();
  } catch (blad) {
    if (blad instanceof BladApi && (blad.status === 401 || blad.status === 403)) {
      uwagi.push(`Zmiennej ${ZMIENNA_STOP} nie da się odczytać (HTTP ${blad.status}): wyłącznik działa tylko przez zgłoszenie z etykietą ${ETYKIETA_STOP}.`);
      return wynik();
    }
    throw blad;
  }
}

// ---------------------------------------------------------------------------
// GitHub i git

/**
 * `scal` mógł zostać na commicie, którego bramka nie oceniła. Bramka sama dodaje wtedy `wstrzymaj`
 * (bezpieczny kierunek: workflow wyłącza scalanie i wyjmuje PR z kolejki); `wstrzymane` mówi, czy się udało.
 */
export class NiepewnaEtykieta extends Error {
  constructor(komunikat, wstrzymane = false) {
    super(komunikat);
    this.name = 'NiepewnaEtykieta';
    this.wstrzymane = wstrzymane;
  }
}

/** Dodaje `wstrzymaj` (dwie próby). Zwraca true, gdy etykieta jest na PR. */
async function wstrzymajPR({ api, repo, numer }) {
  for (let proba = 0; proba < 2; proba++) {
    try {
      await api(`repos/${repo}/issues/${numer}/labels`, { metoda: 'POST', pola: { 'labels[]': ETYKIETA_WSTRZYMAJ } });
      return true;
    } catch {
      // druga próba niżej; po dwóch porażkach prośba do człowieka w komunikacie
    }
  }
  return false;
}

async function niepewna({ api, repo, numer, powod }) {
  const wstrzymane = await wstrzymajPR({ api, repo, numer });
  return new NiepewnaEtykieta(
    wstrzymane
      ? `${powod}; dodałem ${ETYKIETA_WSTRZYMAJ} na #${numer} (zdejmuje ją człowiek po sprawdzeniu)`
      : `${powod}, a ${ETYKIETA_WSTRZYMAJ} nie dało się dodać: dodaj ją na #${numer}`,
    wstrzymane,
  );
}

export class BladApi extends Error {
  constructor(sciezka, status, szczegoly) {
    super(`GitHub API ${sciezka.split('?')[0]}: ${status ? `HTTP ${status}` : 'błąd'}${szczegoly ? ` (${szczegoly})` : ''}`);
    this.name = 'BladApi';
    this.status = status;
  }
}

function uruchomGh(argumenty) {
  return execFileSync('gh', argumenty, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
}

/** Klient REST przez `gh api` (w chmurze uwierzytelnia go proxy GitHuba). */
export function utworzApi(uruchom = uruchomGh) {
  return async function api(sciezka, { metoda = 'GET', pola = {}, dopusc404 = false } = {}) {
    const argumenty = ['api', '--method', metoda, sciezka];
    for (const [klucz, wartosc] of Object.entries(pola)) argumenty.push('-f', `${klucz}=${wartosc}`);
    let wyjscie;
    try {
      wyjscie = uruchom(argumenty);
    } catch (blad) {
      const tekst = `${blad?.stderr ?? ''}\n${blad?.stdout ?? ''}`.trim() || String(blad?.message ?? '');
      const status = Number(/HTTP (\d{3})/.exec(tekst)?.[1]) || undefined;
      if (dopusc404 && status === 404) return null;
      throw new BladApi(sciezka, status, tekst.split('\n')[0].slice(0, 200));
    }
    return wyjscie.trim() ? JSON.parse(wyjscie) : null;
  };
}

/** Wszystkie strony listy (po 100). `klucz`: pole z listą, gdy odpowiedź jest obiektem. */
export async function wszystkieStrony(api, sciezka, klucz) {
  const wynik = [];
  for (let strona = 1; strona <= 30; strona++) {
    const dane = await api(`${sciezka}${sciezka.includes('?') ? '&' : '?'}per_page=100&page=${strona}`);
    const partia = klucz ? dane?.[klucz] : dane;
    if (!Array.isArray(partia)) throw new Error(`GitHub nie zwrócił listy: ${sciezka.split('?')[0]}`);
    wynik.push(...partia);
    if (partia.length < 100) return wynik;
  }
  throw new Error(`Za dużo stron (ponad 3000 pozycji): ${sciezka.split('?')[0]}`);
}

function uruchomGit(argumenty) {
  return execFileSync('git', ['-C', KATALOG_REPO, ...argumenty], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
}

/** Pliki bramki z kopii lokalnej muszą być takie jak w origin/main (po świeżym fetch). */
export function sprawdzZrodlo(git) {
  try {
    git(['fetch', '--quiet', 'origin', 'main']);
  } catch {
    return { zgodne: false, powod: 'Nie da się pobrać origin/main (git fetch): bramka nie wie, czy działa na zasadach z main.' };
  }
  let rozne;
  try {
    // Zmienione pliki śledzone i nowe nieśledzone (nowy moduł też zmienia bramkę).
    rozne = [
      git(['diff', '--name-only', 'origin/main', '--', ...SCIEZKI_BRAMKI]),
      git(['ls-files', '--others', '--exclude-standard', '--', ...SCIEZKI_BRAMKI]),
    ]
      .join('\n')
      .trim();
  } catch {
    return { zgodne: false, powod: 'Porównanie z origin/main nie zadziałało: bramka nie wie, czy działa na zasadach z main.' };
  }
  if (rozne) {
    return {
      zgodne: false,
      powod: `Pliki bramki różnią się od origin/main (${lista(rozne.split('\n'))}): uruchom bramkę z czystego main (instrukcja, „Bramki scalenia”).`,
    };
  }
  return { zgodne: true };
}

/** Nazwa repozytorium (właściciel/nazwa) z adresu zdalnego gita, także z adresu proxy w chmurze. */
export function repoZAdresu(adres) {
  const repo = String(adres ?? '')
    .trim()
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .filter(Boolean)
    .slice(-2)
    .join('/');
  return REPO.test(repo) ? repo : null;
}

/** Wymagane kontrole: własna lista i konteksty z rulesetu main. */
export function polaczWymagane(reguly) {
  const zRulesetu = (Array.isArray(reguly) ? reguly : [])
    .filter((regula) => regula?.type === 'required_status_checks')
    .flatMap((regula) => regula.parameters?.required_status_checks ?? [])
    .map((kontrola) => kontrola.context)
    .filter(Boolean);
  return [...new Set([...KONTROLE_WYMAGANE, ...zRulesetu])];
}

async function krokiTestu({ api, repo, przebiegi, uwagi, kto }) {
  const przebieg = najnowszePrzebiegi(przebiegi).get(KONTROLA_TEST_FIRST);
  if (!przebieg || przebieg.status !== 'completed' || przebieg.conclusion !== 'success') return null;
  try {
    const job = await api(`repos/${repo}/actions/jobs/${przebieg.id}`);
    return Array.isArray(job?.steps) ? job.steps : [];
  } catch (blad) {
    uwagi.push(`${kto}: kroków „${KONTROLA_TEST_FIRST}” nie da się odczytać (${blad instanceof Error ? blad.message : 'błąd'}).`);
    return [];
  }
}

const czekajMs = (ms) => new Promise((gotowe) => setTimeout(gotowe, ms));

/** Wszystko, czego potrzebuje `ocenPR`, z GitHub (REST) i gita. */
export async function zbierzDane({ numer, repo, api, git, codeowners, czekaj = czekajMs }) {
  const uwagi = [];
  const zrodlo = sprawdzZrodlo(git);
  const wylacznik = await sprawdzWylacznik({ api, repo });
  let pr = await api(`repos/${repo}/pulls/${numer}`);
  // `mergeable` GitHub liczy w tle po pierwszym zapytaniu: chwila i drugie podejście.
  for (let proba = 0; pr.state === 'open' && (pr.mergeable === null || pr.mergeable === undefined) && proba < 3; proba++) {
    await czekaj(3000);
    pr = await api(`repos/${repo}/pulls/${numer}`);
  }
  const pliki = await wszystkieStrony(api, `repos/${repo}/pulls/${numer}/files`);
  const sha = pr.head.sha;
  const przebiegi = await wszystkieStrony(api, `repos/${repo}/commits/${sha}/check-runs?filter=all`, 'check_runs');
  const statusy = await wszystkieStrony(api, `repos/${repo}/commits/${sha}/statuses`);
  let wymagane = [...KONTROLE_WYMAGANE];
  try {
    wymagane = polaczWymagane(await api(`repos/${repo}/rules/branches/main`));
  } catch (blad) {
    uwagi.push(`Rulesetu main nie da się odczytać (${blad instanceof Error ? blad.message : 'błąd'}): bramka sprawdza własną listę kontroli.`);
  }
  const krokiTestFirst = await krokiTestu({ api, repo, przebiegi, uwagi, kto: `#${numer}` });
  return {
    zrodlo,
    wylacznik,
    pr,
    pliki,
    przebiegi,
    statusy,
    wymagane,
    krokiTestFirst,
    codeowners: parseCodeowners(codeowners ?? ''),
    uwagi,
  };
}

/**
 * `scal-pr.sh` z wyjściem i błędami razem: ostrzeżenia (np. brak sekretu SCAL_TOKEN, bez którego
 * z chmury PR z etykietą nie wejdzie do kolejki) idą na stderr także przy kodzie 0.
 */
function uruchomSkryptScalania(numer) {
  const wynik = spawnSync('bash', [join(KATALOG_REPO, SKRYPT_SCALANIA), String(numer)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10 * 60_000,
  });
  if (wynik.error || wynik.status !== 0) {
    throw Object.assign(new Error(wynik.error?.message ?? `kod ${wynik.status}`), { stdout: wynik.stdout, stderr: wynik.stderr });
  }
  return `${wynik.stdout ?? ''}${wynik.stderr ?? ''}`;
}

/**
 * Etykieta `scal` przez `scripts/ops/scal-pr.sh` (bez `--zgoda`: nocny zespół
 * zgód nie nadaje). Głowa PR musi być ocenionym SHA tuż przed skryptem i tuż
 * po nim; nowy commit w tym czasie zdejmuje `scal`, bo bramka go nie oceniła.
 * Zwraca wyjście skryptu. Rzuca błąd z powodem, gdy etykiety nie ma.
 */
export async function oznaczDoScalenia({ api, repo, numer, sha, uruchomScal = uruchomSkryptScalania }) {
  if (repo !== REPO_KOLEJKI) throw new Error(`${SKRYPT_SCALANIA} działa tylko na ${REPO_KOLEJKI}, a bramka oceniła ${repo}`);
  if (!SHA.test(sha ?? '')) throw new Error('brak pełnego SHA głowy, bez niego bramka nie nadaje scal');
  const przed = await api(`repos/${repo}/pulls/${numer}`);
  if (przed?.head?.sha !== sha) {
    throw new Error(`głowa PR zmieniła się po ocenie (${String(przed?.head?.sha ?? '?').slice(0, 8)}): uruchom bramkę jeszcze raz`);
  }
  let wyjscie;
  try {
    wyjscie = uruchomScal(numer);
  } catch (blad) {
    const tekst = `${blad?.stderr ?? ''}\n${blad?.stdout ?? ''}`.trim() || String(blad?.message ?? 'nieznany błąd');
    throw new Error(`${SKRYPT_SCALANIA} odmówił: ${tekst.split('\n').slice(-3).join(' ').slice(0, 400)}`);
  }
  let po;
  try {
    po = await api(`repos/${repo}/pulls/${numer}`);
  } catch (blad) {
    throw await niepewna({
      api,
      repo,
      numer,
      powod: `${ETYKIETA_SCAL} nadana, ale nie mogę sprawdzić głowy PR (${blad instanceof Error ? blad.message : 'błąd'})`,
    });
  }
  if (po?.head?.sha !== sha) {
    let zdjeta = false;
    let ostatniBlad = null;
    for (let proba = 0; proba < 2 && !zdjeta; proba++) {
      try {
        await api(`repos/${repo}/issues/${numer}/labels/${ETYKIETA_SCAL}`, { metoda: 'DELETE', dopusc404: true });
        zdjeta = true;
      } catch (blad) {
        ostatniBlad = blad;
      }
    }
    if (!zdjeta) {
      throw await niepewna({
        api,
        repo,
        numer,
        powod: `nowy commit w trakcie nadawania ${ETYKIETA_SCAL}, a etykiety nie dało się zdjąć (${ostatniBlad instanceof Error ? ostatniBlad.message : 'błąd'})`,
      });
    }
    throw new Error(`nowy commit w trakcie nadawania ${ETYKIETA_SCAL}: etykietę zdjąłem, uruchom bramkę jeszcze raz`);
  }
  return String(wyjscie ?? '').trim();
}

// ---------------------------------------------------------------------------
// Wiersz poleceń

const UZYCIE =
  'Użycie: node scripts/nocny/bramka-scalenia.mjs <numer PR> [--scal] [--json] [--repo właściciel/nazwa]\n' +
  '        node scripts/nocny/bramka-scalenia.mjs --wylacznik [--repo właściciel/nazwa]';

export function czytajArgumenty(argv) {
  const opcje = { numer: undefined, repo: undefined, scal: false, json: false, wylacznik: false };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--scal') opcje.scal = true;
    else if (argument === '--json') opcje.json = true;
    else if (argument === '--wylacznik') opcje.wylacznik = true;
    else if (argument === '--repo') {
      opcje.repo = argv[++i];
      if (!REPO.test(opcje.repo ?? '')) return { blad: 'Zła wartość --repo (oczekiwane: właściciel/nazwa).' };
    } else if (/^#?\d+$/.test(argument)) {
      if (opcje.numer !== undefined) return { blad: 'Podaj jeden numer PR.' };
      opcje.numer = Number(argument.replace('#', ''));
    } else return { blad: `Nieznany argument: ${argument}` };
  }
  if (opcje.wylacznik && (opcje.numer !== undefined || opcje.scal)) return { blad: '--wylacznik działa bez numeru PR i bez --scal.' };
  if (!opcje.wylacznik && opcje.numer === undefined) return { blad: 'Podaj numer PR.' };
  return opcje;
}

function repoZGita() {
  try {
    return repoZAdresu(uruchomGit(['remote', 'get-url', 'origin']));
  } catch {
    return null;
  }
}

export async function glowna(argv, zaleznosci = {}) {
  const {
    api = utworzApi(),
    git = uruchomGit,
    czytajCodeowners = () => readFileSync(join(KATALOG_REPO, '.github/CODEOWNERS'), 'utf8'),
    repoDomyslne = () => process.env.GH_REPO || repoZGita(),
    wypisz = (tekst) => console.log(tekst),
    bledy = (tekst) => console.error(tekst),
    czekaj = czekajMs,
    uruchomScal = uruchomSkryptScalania,
  } = zaleznosci;
  const opcje = czytajArgumenty(argv);
  if ('blad' in opcje) {
    bledy(`${opcje.blad}\n${UZYCIE}`);
    return 2;
  }
  let repo = opcje.repo ?? repoDomyslne();
  if (!repo || !REPO.test(repo)) {
    bledy(`Nie wiem, które repozytorium sprawdzić: podaj --repo właściciel/nazwa.\n${UZYCIE}`);
    return 2;
  }
  try {
    // Pełna nazwa repozytorium: stary adres (sprzed przeniesienia do organizacji) przekierowuje tylko GET,
    // a `--scal` porównuje ją z repozytorium, na którym działa scal-pr.sh.
    repo = (await api(`repos/${repo}`))?.full_name ?? repo;
    if (opcje.wylacznik) {
      const wylacznik = await sprawdzWylacznik({ api, repo });
      if (wylacznik.uwaga) wypisz(`Uwaga: ${wylacznik.uwaga}`);
      wypisz(wylacznik.wlaczony ? `STOP: wyłącznik włączony (${wylacznik.powod}).` : 'Wyłącznik wyłączony: noc może pracować.');
      return wylacznik.wlaczony ? 1 : 0;
    }
    const dane = await zbierzDane({ numer: opcje.numer, repo, api, git, codeowners: czytajCodeowners(), czekaj });
    const ocena = ocenPR(dane);
    let scal = null;
    let odmowa = null;
    // null: bez wątpliwości; 'wstrzymane': bramka dodała wstrzymaj; 'do-wstrzymania': człowiek musi je dodać.
    let niepewnaEtykieta = null;
    if (ocena.wynik === 'TAK' && opcje.scal) {
      try {
        scal = await oznaczDoScalenia({ api, repo, numer: ocena.numer, sha: ocena.sha, uruchomScal });
      } catch (blad) {
        odmowa = blad instanceof Error ? blad.message : 'nieznany błąd';
        if (blad instanceof NiepewnaEtykieta) niepewnaEtykieta = blad.wstrzymane ? 'wstrzymane' : 'do-wstrzymania';
      }
    }
    // Z chmury scal-pr.sh nie wie, czy workflow ma SCAL_TOKEN (ostrzega zawsze), więc o tym, czy PR
    // wszedł do kolejki, mówi dopiero stan na koniec nocy. Na ten wypadek linia dla Bartosza z ocenionym SHA.
    const liniaZapasowa =
      scal === null ? null : `gh pr merge ${ocena.numer} -R ${repo} --match-head-commit ${ocena.sha} && ./${SKRYPT_SCALANIA} ${ocena.numer} --czekaj`;
    if (opcje.json) wypisz(JSON.stringify({ ...ocena, scal, odmowa, niepewna: niepewnaEtykieta, liniaZapasowa }, null, 2));
    else {
      wypisz(opisOceny(ocena));
      if (scal !== null) {
        if (scal) wypisz(scal);
        wypisz(
          `SCAL: #${ocena.numer} ma etykietę ${ETYKIETA_SCAL} (głowa ${ocena.sha}). Do kolejki wejdzie, gdy scalanie włączy konto człowieka albo workflow z sekretem SCAL_TOKEN; stan sprawdź na koniec nocy (instrukcja, sekcja 3, krok 6).`,
        );
        wypisz(`Dla Bartosza (gdy na koniec nocy PR nie jest w drodze): ${liniaZapasowa}`);
      }
      if (niepewnaEtykieta === 'do-wstrzymania') wypisz(`UWAGA: ${odmowa}`);
      else if (niepewnaEtykieta === 'wstrzymane') wypisz(`NIE: ${odmowa}`);
      else if (odmowa) wypisz(`NIE: etykiety ${ETYKIETA_SCAL} na #${ocena.numer} nie ma: ${odmowa}`);
    }
    if (niepewnaEtykieta === 'do-wstrzymania') return 2;
    if (odmowa) return 1;
    return ocena.wynik === 'TAK' ? 0 : 1;
  } catch (blad) {
    bledy(`Bramka: ${blad instanceof Error ? blad.message : 'nieznany błąd'}. Traktuj to jak NIE (przy --wylacznik: jak stop).`);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  glowna(process.argv.slice(2))
    .then((kod) => {
      process.exitCode = kod;
    })
    .catch((blad) => {
      console.error(`Bramka: ${blad instanceof Error ? blad.message : 'nieznany błąd'}. Traktuj to jak NIE.`);
      process.exitCode = 2;
    });
}
