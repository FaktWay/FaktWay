#!/usr/bin/env node
// „Scalanie na etykietę”: workflow `.github/workflows/scalanie-na-etykiete.yml`.
//
// Jedna ścieżka scalania dla każdego środowiska agenta. Sesja lokalna, Codex
// i sesja w chmurze (gdzie proxy GitHuba odrzuca GraphQL, więc `gh pr merge`
// i `gh pr edit` nie działają) robią to samo: nadają etykietę `scal` przez REST
// (`scripts/ops/scal-pr.sh`). Ten skrypt, po stronie GitHuba, włącza wtedy
// automatyczne scalanie. Przy włączonej kolejce scalania (ruleset „main -
// ochrona podstawowa”) GitHub wstawia PR do kolejki, gdy kontrole są zielone,
// więc agent nie musi czekać na CI.
//
// Zdarzenia (`pull_request_target`):
//   labeled `scal`       włącz, ale tylko gdy nadawca jest w filtr/zgody.json,
//                        PR jest otwarty, nie jest szkicem, ma bazę `main`,
//                        głowę z TEGO repozytorium i nie ma etykiety `wstrzymaj`;
//                        inaczej komentarz z powodem i zdjęcie etykiety;
//   unlabeled `scal`     wyłącz automatyczne scalanie i wyjmij z kolejki;
//   labeled `wstrzymaj`  to samo (kierunek bezpieczny, nadać może każdy);
//   synchronize          nowy push na PR z etykietą `scal`: zdejmij ją i wyłącz
//                        (zgoda dotyczy tego, co przeczytał drugi czytelnik,
//                        jak etykiety zgoda:* w „Filtr: straż”).
// Etykiety nadane i zdjęte przez `github-actions[bot]` pomijamy: to nasze własne
// zdjęcia. Nowy push wyłącza scalanie bez względu na to, kto go zrobił.
//
// Bezpieczeństwo: workflow działa na `pull_request_target` z kodem z gałęzi
// domyślnej. Kodu z PR nie pobiera i nie uruchamia. Z PR czyta tylko liczbę,
// identyfikator węzła, SHA głowy, stan, nazwę repozytorium głowy, nazwę bazy
// i nazwy etykiet; nic z tego nie trafia do powłoki. Tytułu, opisu ani nazwy
// gałęzi PR nie czytamy wcale. Token nie trafia do logu ani do komunikatów.
//
// Użycie (w workflow): node scripts/ci/scalanie-etykieta.mjs
// Kod wyjścia: 0 dobrze (także „nic do zrobienia” i odmowa), 1 błąd API, 2 użycie.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ETYKIETA_SCAL = 'scal';
export const ETYKIETA_WSTRZYMAJ = 'wstrzymaj';
export const BOT_WORKFLOWU = 'github-actions[bot]';
const GALAZ_BAZOWA = 'main';

const ZAPYTANIE_STAN = `query($id: ID!) {
  node(id: $id) { ... on PullRequest { autoMergeRequest { enabledAt } mergeQueueEntry { id } } }
}`;
const MUTACJA_WLACZ = `mutation($id: ID!, $sha: GitObjectID!) {
  enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: MERGE, expectedHeadOid: $sha}) { clientMutationId }
}`;
const MUTACJA_KOLEJKA = `mutation($id: ID!, $sha: GitObjectID!) {
  enqueuePullRequest(input: {pullRequestId: $id, expectedHeadOid: $sha}) { clientMutationId }
}`;
const MUTACJA_WYLACZ = `mutation($id: ID!) {
  disablePullRequestAutoMerge(input: {pullRequestId: $id}) { clientMutationId }
}`;
const MUTACJA_Z_KOLEJKI = `mutation($id: ID!) {
  dequeuePullRequest(input: {id: $id}) { clientMutationId }
}`;

/**
 * @typedef {{ akcja: 'wlacz' | 'odmow' | 'wylacz' | 'ignoruj', powody: string[], zdejmijEtykiete: boolean, komentarz: string | null }} Decyzja
 */

/** @returns {Decyzja} */
function decyzja(akcja, { powody = [], zdejmijEtykiete = false, komentarz = null } = {}) {
  return { akcja, powody, zdejmijEtykiete, komentarz };
}

/**
 * Czysta decyzja na danych zdarzenia `pull_request_target`.
 * @param {any} zdarzenie ładunek zdarzenia (GITHUB_EVENT_PATH)
 * @param {string[]} osoby konta z filtr/zgody.json (z gałęzi domyślnej)
 * @returns {Decyzja}
 */
export function decyduj(zdarzenie, osoby) {
  const pr = zdarzenie?.pull_request;
  const nadawca = String(zdarzenie?.sender?.login ?? '');
  if (!pr) return decyzja('ignoruj');
  // Własne zdjęcia etykiety przez workflow pomijamy; nowy push wyłącza scalanie
  // niezależnie od autora (zgoda dotyczy treści, którą przeczytał drugi czytelnik).
  if (nadawca === BOT_WORKFLOWU && zdarzenie.action !== 'synchronize') return decyzja('ignoruj');
  const etykiety = (pr.labels ?? []).map((/** @type {{ name: string }} */ l) => l.name);
  const nazwa = zdarzenie.label?.name;

  if (zdarzenie.action === 'labeled' && nazwa === ETYKIETA_SCAL) {
    const powody = powodyOdmowy(zdarzenie, pr, nadawca, etykiety, osoby);
    if (powody.length === 0) return decyzja('wlacz');
    return decyzja('odmow', {
      powody,
      zdejmijEtykiete: true,
      komentarz: `Nie włączam scalania: ${powody.join('; ')}. Zdjąłem etykietę \`${ETYKIETA_SCAL}\`; po usunięciu przeszkód nadaj ją ponownie.`,
    });
  }
  if (zdarzenie.action === 'labeled' && nazwa === ETYKIETA_WSTRZYMAJ) {
    const mialaScal = etykiety.includes(ETYKIETA_SCAL);
    return decyzja('wylacz', {
      powody: [`PR dostał etykietę \`${ETYKIETA_WSTRZYMAJ}\``],
      zdejmijEtykiete: mialaScal,
      komentarz: mialaScal
        ? `Scalanie wstrzymane (\`${ETYKIETA_WSTRZYMAJ}\`). Po zdjęciu wstrzymania nadaj \`${ETYKIETA_SCAL}\` ponownie.`
        : null,
    });
  }
  if (zdarzenie.action === 'unlabeled' && nazwa === ETYKIETA_SCAL) {
    return decyzja('wylacz', { powody: [`zdjęto etykietę \`${ETYKIETA_SCAL}\``] });
  }
  if (zdarzenie.action === 'synchronize' && etykiety.includes(ETYKIETA_SCAL)) {
    return decyzja('wylacz', {
      powody: ['nowy push'],
      zdejmijEtykiete: true,
      komentarz: `Nowy push: scalanie wyłączone, nadaj \`${ETYKIETA_SCAL}\` ponownie po przeglądzie.`,
    });
  }
  return decyzja('ignoruj');
}

/**
 * @param {any} zdarzenie
 * @param {any} pr
 * @param {string} nadawca
 * @param {string[]} etykiety
 * @param {string[]} osoby
 */
function powodyOdmowy(zdarzenie, pr, nadawca, etykiety, osoby) {
  const powody = [];
  const dozwoleni = (osoby ?? []).map((o) => String(o).toLowerCase());
  if (!dozwoleni.includes(nadawca.toLowerCase())) {
    powody.push(`nadawca etykiety (\`${nadawca}\`) nie jest na liście z filtr/zgody.json`);
  }
  if (pr.state !== 'open' || pr.merged) powody.push('PR nie jest otwarty');
  if (pr.draft) powody.push('PR jest szkicem');
  if (pr.base?.ref !== GALAZ_BAZOWA) powody.push(`PR ma bazę \`${pr.base?.ref ?? '?'}\`, a scalać wolno tylko do \`${GALAZ_BAZOWA}\``);
  if (pr.head?.repo?.full_name !== zdarzenie.repository?.full_name) powody.push('gałąź PR pochodzi z innego repozytorium (fork)');
  if (etykiety.includes(ETYKIETA_WSTRZYMAJ)) powody.push(`PR ma etykietę \`${ETYKIETA_WSTRZYMAJ}\``);
  return powody;
}

/**
 * @typedef {{
 *   rest: (metoda: string, sciezka: string, cialo?: unknown) => Promise<any>,
 *   graphql: (zapytanie: string, zmienne: Record<string, unknown>) => Promise<any>,
 * }} Api
 */

/**
 * Wykonuje decyzję przez API. Operacje są idempotentne: ponowienie po błędzie
 * włącza to samo, wyłącza tylko to, co jest włączone, a zdjęcie nieistniejącej
 * etykiety (404) nie jest błędem. Komentarz idzie na końcu, po skutku.
 * @param {Decyzja} d
 * @param {any} zdarzenie
 * @param {Api} api
 */
export async function wykonaj(d, zdarzenie, api) {
  if (d.akcja === 'ignoruj') return;
  const pr = zdarzenie.pull_request;
  const repo = zdarzenie.repository.full_name;
  const sciezkaPR = `/repos/${repo}/issues/${pr.number}`;
  const zdejmij = () => api.rest('DELETE', `${sciezkaPR}/labels/${encodeURIComponent(ETYKIETA_SCAL)}`);
  // Komentarz idzie po skutku i jest dodatkiem: jego błąd nie może wywrócić zadania,
  // bo ponowienie powtórzyłoby skutek i komentarz.
  const komentarz = async (/** @type {string} */ tresc) => {
    try {
      await api.rest('POST', `${sciezkaPR}/comments`, { body: tresc });
    } catch (blad) {
      console.warn(`Komentarz do PR #${pr.number} nie został dodany: ${blad instanceof Error ? blad.message : 'nieznany błąd'}`);
    }
  };

  if (d.akcja === 'wlacz') {
    await wlacz(api, pr);
    await komentarz(
      `Scalanie włączone przez \`${zdarzenie.sender.login}\`: PR wejdzie do kolejki po zielonych kontrolach. Nowy push je wyłączy.`,
    );
    return;
  }
  if (d.akcja === 'odmow') {
    await zdejmij();
    if (d.komentarz) await komentarz(d.komentarz);
    return;
  }
  await wylacz(api, pr);
  if (d.zdejmijEtykiete) await zdejmij();
  if (d.komentarz) await komentarz(d.komentarz);
}

/** @param {Api} api @param {any} pr */
async function wlacz(api, pr) {
  const zmienne = { id: pr.node_id, sha: pr.head.sha };
  try {
    await api.graphql(MUTACJA_WLACZ, zmienne);
  } catch (blad) {
    // PR już gotowy do scalenia: GitHub odmawia „auto-merge” i każe scalać
    // od razu, a przy kolejce scalania to znaczy wstawić PR do kolejki.
    if (blad instanceof Error && /clean status|already mergeable/i.test(blad.message)) {
      await api.graphql(MUTACJA_KOLEJKA, zmienne);
      return;
    }
    throw blad;
  }
}

/** @param {Api} api @param {any} pr */
async function wylacz(api, pr) {
  const stan = (await api.graphql(ZAPYTANIE_STAN, { id: pr.node_id }))?.node ?? {};
  if (stan.autoMergeRequest) await api.graphql(MUTACJA_WYLACZ, { id: pr.node_id });
  // Wejście `dequeuePullRequest` to identyfikator PR, nie wpisu kolejki.
  if (stan.mergeQueueEntry) await api.graphql(MUTACJA_Z_KOLEJKI, { id: pr.node_id });
}

/**
 * Klient API na `fetch` (wstrzykiwany w testach). Błąd niesie metodę, ścieżkę
 * i status HTTP albo komunikaty GraphQL; nigdy nagłówków ani tokenu.
 * @param {{ token: string, fetchFn?: typeof fetch }} opcje
 * @returns {Api}
 */
export function utworzApi({ token, fetchFn = fetch }) {
  const naglowki = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  return {
    async rest(metoda, sciezka, cialo) {
      const odpowiedz = await fetchFn(`https://api.github.com${sciezka}`, {
        method: metoda,
        headers: naglowki,
        body: cialo === undefined ? undefined : JSON.stringify(cialo),
      });
      if (metoda === 'DELETE' && odpowiedz.status === 404) return null;
      if (!odpowiedz.ok) throw new Error(`GitHub API ${metoda} ${sciezka}: HTTP ${odpowiedz.status}`);
      if (odpowiedz.status === 204) return null;
      return odpowiedz.json();
    },
    async graphql(zapytanie, zmienne) {
      const odpowiedz = await fetchFn('https://api.github.com/graphql', {
        method: 'POST',
        headers: naglowki,
        body: JSON.stringify({ query: zapytanie, variables: zmienne }),
      });
      if (!odpowiedz.ok) throw new Error(`GitHub GraphQL: HTTP ${odpowiedz.status}`);
      const json = await odpowiedz.json();
      if (Array.isArray(json.errors) && json.errors.length > 0) {
        throw new Error(`GitHub GraphQL: ${json.errors.map((/** @type {{ message: string }} */ e) => e.message).join('; ')}`);
      }
      return json.data;
    },
  };
}

/**
 * Decyzja i wykonanie w jednym kroku; zwraca kod wyjścia i linie do logu.
 * @param {any} zdarzenie
 * @param {string[]} osoby
 * @param {Api} api
 */
export async function przetworz(zdarzenie, osoby, api) {
  const numer = zdarzenie?.pull_request?.number;
  /** @type {Decyzja | null} */
  let d = null;
  try {
    d = decyduj(zdarzenie, osoby);
    await wykonaj(d, zdarzenie, api);
    const opis = {
      wlacz: `Włączono automatyczne scalanie PR #${numer} (etykieta ${ETYKIETA_SCAL} od ${zdarzenie.sender?.login}).`,
      odmow: `Odmowa dla PR #${numer}: ${d.powody.join('; ')}.`,
      wylacz: `Wyłączono automatyczne scalanie PR #${numer} (${d.powody.join('; ')}).`,
      ignoruj: `Nic do zrobienia dla PR #${numer} (zdarzenie ${zdarzenie?.action ?? '?'}).`,
    };
    return { kod: 0, linie: [opis[d.akcja]] };
  } catch (blad) {
    const komunikat = blad instanceof Error ? blad.message : 'nieznany błąd';
    if (d?.akcja === 'wlacz') {
      // Agent widzi tylko PR: bez komentarza etykieta zostaje i nic nie mówi, dlaczego.
      try {
        await api.rest('POST', `/repos/${zdarzenie.repository.full_name}/issues/${numer}/comments`, {
          body: `Nie udało się włączyć scalania (błąd API: ${komunikat}). Zdejmij \`${ETYKIETA_SCAL}\` i nadaj ją jeszcze raz albo użyj zapasu lokalnego: \`gh pr merge ${numer} --auto\`.`,
        });
      } catch {
        // log zadania i tak ma przyczynę
      }
    }
    return { kod: 1, linie: [`Scalanie na etykietę: błąd przy PR #${numer}: ${komunikat}`] };
  }
}

async function glowna() {
  const sciezkaZdarzenia = process.env.GITHUB_EVENT_PATH;
  const token = process.env.GITHUB_TOKEN;
  if (!sciezkaZdarzenia || !token) {
    console.error('Użycie: GITHUB_EVENT_PATH=… GITHUB_TOKEN=… node scripts/ci/scalanie-etykieta.mjs (w workflow)');
    return 2;
  }
  const zdarzenie = JSON.parse(readFileSync(sciezkaZdarzenia, 'utf8'));
  const zgody = JSON.parse(readFileSync(new URL('../../filtr/zgody.json', import.meta.url), 'utf8'));
  const wynik = await przetworz(zdarzenie, zgody.osoby ?? [], utworzApi({ token }));
  for (const linia of wynik.linie) (wynik.kod === 0 ? console.log : console.error)(linia);
  return wynik.kod;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  glowna()
    .then((kod) => {
      process.exitCode = kod;
    })
    .catch((blad) => {
      console.error(`Scalanie na etykietę: ${blad instanceof Error ? blad.message : 'nieznany błąd'}`);
      process.exitCode = 2;
    });
}
