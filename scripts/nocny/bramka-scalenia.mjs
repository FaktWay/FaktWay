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
//    6. jest nowy albo zmieniony test w tests/, żaden test nie znika i nie
//       dostaje `.skip` ani `.only`;
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
//              1 NIE albo wyłącznik włączony; 2 błąd (traktuj jak NIE i jak stop).

import { execFileSync } from 'node:child_process';
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
  'pnpm-workspace.yaml',
  '**/Dockerfile',
  '**/.dockerignore',
  'next.config.ts',
  'ops/**',
  'scripts/ops/**',
  'scripts/hetzner/**',
  // Bramka i instrukcja nocnego zespołu: zespół nie zmienia własnych zasad.
  'scripts/nocny/**',
  'docs/nocny/**',
  'docs/runbooks/nocny-zespol.md',
  // Konfiguracja kontroli, które oceniają PR (lint, testy, typy).
  'eslint.config.mjs',
  'eslint/**',
  'vitest*.config.ts',
  'tsconfig*.json',
  'tests/setup.ts',
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
const POMINIECIE_TESTU = /\b(?:describe|it|test|suite)\s*\.\s*(?:skip|only)\b|\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(/;
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
    if (typeof plik.patch !== 'string') bezPodgladu.push(plik.filename);
    else if (pominieteTesty(plik.patch).length > 0) pominiete.push(plik.filename);
  }

  const powody = [];
  for (const { id, opis } of KATEGORIE) {
    if (kategorie[id].length > 0) powody.push(`${opis}: ${lista(kategorie[id])}.`);
  }
  if (kategorie.wrazliwe.length > 0) {
    powody.push(
      `Obszar wrażliwy z .github/CODEOWNERS: ${lista(kategorie.wrazliwe)}. Etap 1: zgodę (${ETYKIETA_OBSZARU}) daje Bartosz i on scala.`,
    );
  }
  if (testy.length === 0) powody.push('Brak nowego albo zmienionego testu w tests/ (*.test.ts, *.test.tsx).');
  if (wylaczone.length > 0) powody.push(`PR wyłącza testy (plik znika albo przestaje być testem): ${lista(wylaczone)}.`);
  if (pominiete.length > 0) powody.push(`Nowe .skip albo .only w testach: ${lista(pominiete)}.`);
  if (bezPodgladu.length > 0) {
    powody.push(`GitHub nie pokazał zmian w teście (za duży diff), więc bramka nie sprawdzi .skip i .only: ${lista(bezPodgladu)}.`);
  }
  const zgodyFiltra = Object.keys(zgodyStrazy).filter((zgoda) => zgodyStrazy[zgoda].length > 0);
  for (const zgoda of zgodyFiltra) {
    powody.push(
      `„Filtr: straż” zażąda etykiety zgoda:${zgoda} (${lista(zgodyStrazy[zgoda])}). Nocna sesja zgód nie nadaje: czeka na Bartosza, który nadaje ją osobiście.`,
    );
  }
  return { powody, kategorie, testy, zgodyFiltra };
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

  const powody = [];
  if (brakujace.length > 0) {
    powody.push(`Brak kontroli na głowie PR: ${lista(brakujace)}. CI jeszcze nie ruszyło albo workflow się nie uruchomił.`);
  }
  if (wToku.length > 0) powody.push(`Kontrole w toku: ${lista(wToku)}. Poczekaj i sprawdź ponownie.`);
  if (czerwone.length > 0) powody.push(`Najnowszy przebieg nie jest zielony: ${lista(czerwone)}.`);
  const testFirst = najnowsze.get(KONTROLA_TEST_FIRST);
  if (testFirst?.status === 'completed' && testFirst.conclusion === 'success') {
    const powod = ocenTestNaBazie(testFirst, krokiTestFirst);
    if (powod) powody.push(powod);
  }
  return powody;
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

/** Stan PR: gałąź, etykiety (`zgoda:*`, `wstrzymaj`) i możliwość scalenia. */
export function ocenStanPR(pr) {
  const powody = ocenGalaz(pr);
  const etykiety = (pr.labels ?? []).map((etykieta) => etykieta.name);
  const zgody = etykiety.filter((nazwa) => nazwa?.startsWith(PREFIKS_ZGODY));
  if (zgody.length > 0) {
    powody.push(`Etykiety zgody na PR (${zgody.join(', ')}): nocna sesja zgód nie nadaje, taki PR prowadzi Bartosz.`);
  }
  if (etykiety.includes(ETYKIETA_WSTRZYMAJ)) powody.push(`Etykieta ${ETYKIETA_WSTRZYMAJ}: ktoś zatrzymał scalanie tego PR.`);
  if (pr.mergeable === null || pr.mergeable === undefined) {
    powody.push('GitHub jeszcze liczy, czy PR da się scalić. Sprawdź za minutę.');
  } else if (pr.mergeable === false || pr.mergeable_state !== 'clean') {
    powody.push(`PR nie jest gotowy do scalenia: ${STANY_SCALENIA[pr.mergeable_state] ?? pr.mergeable_state ?? 'stan nieznany'}.`);
  }
  return powody;
}

/**
 * Jedna linia do wykonania przez Bartosza, gdy da się ją podać; inaczej null.
 * Zgody nadaje Bartosz osobiście: `zgoda:obszar-wrazliwy` etykietą, zgody straży
 * flagą `--zgoda` w scal-pr.sh.
 */
export function liniaDlaBartosza({ numer, kategorie, etykiety, zgodyFiltra = [] }) {
  if (kategorie.migracje.length + kategorie.zasady.length + kategorie.wiedza.length > 0) {
    return `zmiana poza zasięgiem nocnego zespołu, przejrzyj ją i zdecyduj: gh pr view ${numer} --web`;
  }
  if (kategorie.wrazliwe.length === 0 && zgodyFiltra.length === 0) return null;
  const flagi = zgodyFiltra.map((zgoda) => ` --zgoda ${zgoda}`).join('');
  const scal = `./${SKRYPT_SCALANIA} ${numer}${flagi}${flagi ? ' --po-drugim-czytelniku' : ''} --czekaj`;
  if (kategorie.wrazliwe.length === 0 || etykiety.includes(ETYKIETA_OBSZARU)) return `po przeczytaniu zmian: ${scal}`;
  // `sleep`: „Agent guard” liczy się od nowa po nadaniu etykiety, a scal-pr.sh odmawia przy czerwonej kontroli.
  return `po przeczytaniu zmian: gh pr edit ${numer} --add-label ${ETYKIETA_OBSZARU} && sleep 30 && ${scal}`;
}

/** Ocena całego PR. Zwraca { wynik: 'TAK'|'NIE', numer, sha, galaz, powody, uwagi, linia }. */
export function ocenPR(dane) {
  const powody = [];
  const uwagi = [...(dane.uwagi ?? [])];
  if (!dane.zrodlo?.zgodne) powody.push(dane.zrodlo?.powod ?? 'Nie wiadomo, czy bramka działa na zasadach z main.');
  if (!dane.wylacznik || dane.wylacznik.wlaczony) {
    powody.push(`Wyłącznik nocnego zespołu jest włączony: ${dane.wylacznik?.powod ?? 'stan nieznany'}.`);
  }
  if (dane.wylacznik?.uwaga) uwagi.push(dane.wylacznik.uwaga);

  powody.push(...ocenStanPR(dane.pr));
  const pliki = ocenPliki(dane.pliki, dane.codeowners);
  powody.push(...pliki.powody);
  if (typeof dane.pr.changed_files === 'number' && dane.pliki.length < dane.pr.changed_files) {
    powody.push(`Lista plików niepełna (${dane.pliki.length} z ${dane.pr.changed_files}): bramka nie widzi całego PR.`);
  }
  const opis = ocenOpis(dane.pr.body, pliki.testy);
  if (opis) powody.push(opis);
  powody.push(
    ...ocenKontrole({
      przebiegi: dane.przebiegi,
      statusy: dane.statusy,
      wymagane: dane.wymagane ?? KONTROLE_WYMAGANE,
      krokiTestFirst: dane.krokiTestFirst,
    }),
  );

  const wynik = powody.length === 0 ? 'TAK' : 'NIE';
  const etykiety = (dane.pr.labels ?? []).map((etykieta) => etykieta.name);
  return {
    wynik,
    numer: dane.pr.number,
    sha: dane.pr.head?.sha,
    galaz: dane.pr.head?.ref,
    powody,
    uwagi,
    // Linia tylko dla własnego, otwartego PR nocnego zespołu: forka ani cudzej gałęzi nie podsuwamy do scalenia.
    linia: wynik === 'NIE' && ocenGalaz(dane.pr).length === 0 ? liniaDlaBartosza({ numer: dane.pr.number, kategorie: pliki.kategorie, etykiety, zgodyFiltra: pliki.zgodyFiltra }) : null,
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
 */
export async function sprawdzWylacznik({ api, repo }) {
  const zgloszenia = await api(`repos/${repo}/issues?state=open&labels=${encodeURIComponent(ETYKIETA_STOP)}&per_page=5`);
  if (!Array.isArray(zgloszenia)) throw new Error('GitHub nie zwrócił listy zgłoszeń: stan wyłącznika nieznany');
  if (zgloszenia.length > 0) {
    return { wlaczony: true, powod: `otwarte zgłoszenie #${zgloszenia[0].number} z etykietą ${ETYKIETA_STOP}` };
  }
  try {
    const zmienna = await api(`repos/${repo}/actions/variables/${ZMIENNA_STOP}`, { dopusc404: true });
    if (zmienna && zmiennaWlacza(zmienna.value)) {
      return { wlaczony: true, powod: `zmienna repozytorium ${ZMIENNA_STOP}=${String(zmienna.value).trim().slice(0, 40)}` };
    }
    return { wlaczony: false };
  } catch (blad) {
    if (blad instanceof BladApi && (blad.status === 401 || blad.status === 403)) {
      return {
        wlaczony: false,
        uwaga: `Zmiennej ${ZMIENNA_STOP} nie da się odczytać (HTTP ${blad.status}): wyłącznik działa tylko przez zgłoszenie z etykietą ${ETYKIETA_STOP}.`,
      };
    }
    throw blad;
  }
}

// ---------------------------------------------------------------------------
// GitHub i git

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

function uruchomSkryptScalania(numer) {
  return execFileSync('bash', [join(KATALOG_REPO, SKRYPT_SCALANIA), String(numer)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10 * 60_000,
  });
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
  const po = await api(`repos/${repo}/pulls/${numer}`);
  if (po?.head?.sha !== sha) {
    await api(`repos/${repo}/issues/${numer}/labels/${ETYKIETA_SCAL}`, { metoda: 'DELETE', dopusc404: true });
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
    if (ocena.wynik === 'TAK' && opcje.scal) {
      try {
        scal = await oznaczDoScalenia({ api, repo, numer: ocena.numer, sha: ocena.sha, uruchomScal });
      } catch (blad) {
        odmowa = blad instanceof Error ? blad.message : 'nieznany błąd';
      }
    }
    if (opcje.json) wypisz(JSON.stringify({ ...ocena, scal, odmowa }, null, 2));
    else {
      wypisz(opisOceny(ocena));
      if (scal !== null) {
        if (scal) wypisz(scal);
        wypisz(`SCAL: #${ocena.numer} ma etykietę ${ETYKIETA_SCAL}; kolejka scalania scali go po zielonych kontrolach (głowa ${ocena.sha}).`);
      }
      if (odmowa) wypisz(`NIE: etykiety ${ETYKIETA_SCAL} na #${ocena.numer} nie ma: ${odmowa}`);
    }
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
