#!/usr/bin/env node
// „Scalanie na etykietę”: workflow `.github/workflows/scalanie-na-etykiete.yml`.
//
// Jedna ścieżka scalania dla każdego środowiska agenta. Sesja lokalna, Codex
// i sesja w chmurze (gdzie proxy GitHuba odrzuca GraphQL, więc `gh pr merge`
// i `gh pr edit` nie działają) robią to samo: nadają etykietę `scal` przez REST
// (`scripts/ops/scal-pr.sh`). Sesja lokalna włącza potem scalanie sama (`gh pr
// merge` z konta człowieka). Ten skrypt, po stronie GitHuba, pilnuje warunków,
// a scalanie włącza tylko z sekretem SCAL_TOKEN (sesje chmurowe). Przy włączonej
// kolejce scalania (ruleset „main - ochrona podstawowa”) GitHub wstawia PR do
// kolejki, gdy kontrole są zielone, więc agent nie musi czekać na CI.
//
// TOŻSAMOŚĆ (ustalenie z 15.11.2026): włączenie scalania i wpis do kolejki
// muszą iść z konta człowieka (sekret `SCAL_TOKEN`, PAT albo token aplikacji),
// NIE z `GITHUB_TOKEN`. Zdarzenia wywołane `GITHUB_TOKEN` nie tworzą przebiegów
// workflowów, więc wpis do kolejki zrobiony tym tokenem nie dostaje kontroli
// grupy (AWAITING_CHECKS bez przebiegów, #765), a scalanie włączone tym
// tokenem nie wpisało do kolejki żadnego z ok. 10 PR (#757, #759, #760, #761,
// #767, #769, #785, #786 i dalsze: zawsze ręczny wpis człowieka). Bez sekretu
// skrypt niczego nie włącza i komentuje, co zrobić. Docs: scalanie-pr.md.
//
// Zdarzenia (`pull_request_target`):
//   labeled `scal`       włącz (kontem człowieka, patrz wyżej; cudzego włączenia
//                        i wpisu w kolejce nie ruszaj), ale tylko gdy nadawca jest w filtr/zgody.json,
//                        PR jest otwarty, nie jest szkicem, ma bazę `main`,
//                        głowę z TEGO repozytorium i nie ma etykiety `wstrzymaj`;
//                        inaczej komentarz z powodem i zdjęcie etykiety;
//   unlabeled `scal`     wyłącz automatyczne scalanie i wyjmij z kolejki, chyba że
//                        etykieta jest już z powrotem na PR (skrypt zdjął i nadał
//                        ją od nowa: wyłączenie cofnęłoby świeże włączenie);
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
// gałęzi PR nie czytamy wcale. Token nie trafia do logu ani do komunikatów (wyjątki `fetch` są zastępowane opisem bez treści nagłówka).
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
  node(id: $id) { ... on PullRequest { autoMergeRequest { enabledAt enabledBy { __typename login } } mergeQueueEntry { id } } }
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

const KOMENTARZ_NIE_WYLACZONO = (/** @type {number} */ numer) =>
  `Nie udało się wyłączyć scalania automatycznie (błąd API, szczegóły w logu zadania „Scal”): scalanie mogło zostać włączone. Wyłącz je ręcznie: \`gh pr merge ${numer} --disable-auto\`, a gdy PR jest już w kolejce, wyjmij go z kolejki (docs/runbooks/scalanie-pr.md, „Wpis w kolejce stoi w AWAITING_CHECKS”).`;

/** @param {number} numer */
const KOMENTARZ_BRAK_TOKENU = (numer) =>
  `Nie włączam scalania z workflow: brak sekretu \`SCAL_TOKEN\` (konto człowieka). Wpis do kolejki zrobiony tokenem Actions nie uruchamia kontroli grupy, więc PR utknąłby w AWAITING_CHECKS. Włącz scalanie kontem człowieka: \`gh pr merge ${numer} --auto\` (robi to \`./scripts/ops/scal-pr.sh ${numer}\` w sesji lokalnej). Etykietę \`${ETYKIETA_SCAL}\` zostawiam. Sekret zakłada Bartosz (docs/runbooks/scalanie-pr.md, „Sekret SCAL_TOKEN”).`;

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
 * `graphql` idzie tokenem Actions (odczyt stanu, wyłączenie scalania, wyjęcie z kolejki: kierunek
 * bezpieczny nie może zależeć od ważności tokenu człowieka). `graphqlCzlowieka` (tylko z sekretem
 * SCAL_TOKEN) służy wyłącznie do włączenia scalania i wpisu do kolejki.
 * @typedef {{
 *   rest: (metoda: string, sciezka: string, cialo?: unknown) => Promise<any>,
 *   graphql: (zapytanie: string, zmienne: Record<string, unknown>) => Promise<any>,
 *   graphqlCzlowieka?: (zapytanie: string, zmienne: Record<string, unknown>) => Promise<any>,
 *   tozsamosc?: 'czlowiek' | 'bot',
 * }} Api
 */

/**
 * Włączenie scalania przez `github-actions` (token Actions): GraphQL podaje login bez „[bot]”
 * (REST ma `github-actions[bot]`). Inne boty (aplikacja GitHub, Renovate) to nie ta pula.
 * @param {{ __typename?: string, login?: string } | null | undefined} wlaczajacy
 */
function czyBot(wlaczajacy) {
  return /^github-actions(\[bot\])?$/.test(wlaczajacy?.login ?? '');
}

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
    const wynik = await wlacz(api, pr);
    if (wynik === 'brak-tokenu') await komentarz(KOMENTARZ_BRAK_TOKENU(pr.number));
    else if (wynik === 'wlaczone') {
      await komentarz(
        `Scalanie włączone na prośbę \`${zdarzenie.sender.login}\`: PR wejdzie do kolejki po zielonych kontrolach. Nowy push je wyłączy.`,
      );
    }
    return wynik;
  }
  if (d.akcja === 'odmow') {
    // Skrypt lokalny (`scal-pr.sh`) włącza scalanie sam, z pominięciem tej bramki, więc odmowa
    // cofa też to, co mogło zostać włączone w międzyczasie. Błąd cofania nie blokuje zdjęcia etykiety.
    let nieWylaczono = false;
    try {
      await wylacz(api, pr);
    } catch (blad) {
      nieWylaczono = true;
      console.warn(`Nie udało się wyłączyć scalania PR #${pr.number} przy odmowie: ${blad instanceof Error ? blad.message : 'nieznany błąd'}`);
    }
    await zdejmij();
    if (d.komentarz) await komentarz(d.komentarz);
    if (nieWylaczono) await komentarz(KOMENTARZ_NIE_WYLACZONO(pr.number));
    return;
  }
  // `scal-pr.sh` zdejmuje i nadaje etykietę od nowa (gdy samo `gh pr merge` zawiodło): zdarzenie
  // `unlabeled` dociera po nadaniu z powrotem i wyłączyłoby scalanie, które właśnie zostało włączone.
  if (zdarzenie.action === 'unlabeled' && zdarzenie.label?.name === ETYKIETA_SCAL) {
    /** @type {unknown} */
    let aktualne = null;
    try {
      aktualne = await api.rest('GET', `${sciezkaPR}/labels?per_page=100`);
    } catch {
      // Nie umiemy ustalić, czy etykieta wróciła: człowiek zdjął ją, żeby anulować scalanie,
      // więc przy wątpliwości wyłączamy (kierunek bezpieczny).
    }
    if (Array.isArray(aktualne) && aktualne.some((/** @type {{ name: string }} */ l) => l.name === ETYKIETA_SCAL)) return 'ponownie-nadana';
  }
  // Etykietę zdejmujemy nawet wtedy, gdy wyłączenie zawiodło (inaczej nowy commit zostałby w drodze
  // z etykietą po zgodzie na poprzedni SHA); błąd wyłączenia wraca po zdjęciu, więc zadanie jest czerwone.
  /** @type {unknown} */
  let bladWylaczenia = null;
  try {
    await wylacz(api, pr);
  } catch (blad) {
    bladWylaczenia = blad;
  }
  if (d.zdejmijEtykiete) await zdejmij();
  // Gdy wyłączenie zawiodło, komentarz nie może twierdzić, że scalanie wyłączono.
  if (bladWylaczenia) await komentarz(KOMENTARZ_NIE_WYLACZONO(pr.number));
  else if (d.komentarz) await komentarz(d.komentarz);
  if (bladWylaczenia) throw bladWylaczenia;
}

/**
 * Włącza automatyczne scalanie TYLKO tożsamością człowieka (sekret `SCAL_TOKEN`).
 * Powód (dziennik scalania z 15.11.2026): wpis do kolejki, który zrobił
 * `GITHUB_TOKEN`, nie uruchamia kontroli grupy (zdarzenia wywołane tym tokenem
 * nie tworzą przebiegów workflowów), więc PR stoi w AWAITING_CHECKS (#765), a
 * automatyczne scalanie włączone tym tokenem nie wstawiło do kolejki żadnego
 * z ok. 10 PR. Bez sekretu nie robimy więc nic i mówimy to wprost.
 * Cudzego włączenia nie nadpisujemy: człowiek, który włączył scalanie sam
 * (`gh pr merge --auto`), zostaje wpisem, a wpis w kolejce zostaje w kolejce.
 * @param {Api} api @param {any} pr
 * @returns {Promise<'wlaczone' | 'juz-wlaczone' | 'w-kolejce' | 'brak-tokenu'>}
 */
async function wlacz(api, pr) {
  const stan = (await api.graphql(ZAPYTANIE_STAN, { id: pr.node_id }))?.node ?? {};
  if (stan.mergeQueueEntry) return 'w-kolejce';
  const wlaczone = stan.autoMergeRequest;
  if (wlaczone && !czyBot(wlaczone.enabledBy)) return 'juz-wlaczone';
  if (api.tozsamosc !== 'czlowiek' || !api.graphqlCzlowieka) return 'brak-tokenu';
  // Dawne włączenie przez bota zdejmujemy, zanim włączy człowiek: nie zakładamy, jak GitHub
  // potraktuje drugie `enablePullRequestAutoMerge` na PR, który już je ma.
  if (wlaczone) await api.graphql(MUTACJA_WYLACZ, { id: pr.node_id });
  const zmienne = { id: pr.node_id, sha: pr.head.sha };
  try {
    await api.graphqlCzlowieka(MUTACJA_WLACZ, zmienne);
  } catch (blad) {
    // PR już gotowy do scalenia: GitHub odmawia „auto-merge” i każe scalać
    // od razu, a przy kolejce scalania to znaczy wstawić PR do kolejki.
    if (blad instanceof Error && /clean status|already mergeable/i.test(blad.message)) {
      await api.graphqlCzlowieka(MUTACJA_KOLEJKA, zmienne);
      return 'wlaczone';
    }
    throw blad;
  }
  return 'wlaczone';
}

/**
 * Wyłączenie idzie najpierw tokenem Actions (nie zależy od ważności PAT; sprawdzone 15.11.2026:
 * token z `contents: write` i `pull-requests: write` wyłącza scalanie włączone przez człowieka).
 * Gdy GitHub odmówi (np. dequeue cudzego wpisu, czego nie sprawdzono), powtarzamy kontem
 * człowieka, jeśli jest.
 * @param {Api} api @param {string} zapytanie @param {Record<string, unknown>} zmienne
 */
async function graphqlZZapasem(api, zapytanie, zmienne) {
  try {
    return await api.graphql(zapytanie, zmienne);
  } catch (blad) {
    if (!api.graphqlCzlowieka) throw blad;
    return api.graphqlCzlowieka(zapytanie, zmienne);
  }
}

/** @param {Api} api @param {any} pr */
async function wylacz(api, pr) {
  const stan = (await graphqlZZapasem(api, ZAPYTANIE_STAN, { id: pr.node_id }))?.node ?? {};
  if (stan.autoMergeRequest) await graphqlZZapasem(api, MUTACJA_WYLACZ, { id: pr.node_id });
  // Wejście `dequeuePullRequest` to identyfikator PR, nie wpisu kolejki.
  if (stan.mergeQueueEntry) await graphqlZZapasem(api, MUTACJA_Z_KOLEJKI, { id: pr.node_id });
}

/**
 * Klient API na `fetch` (wstrzykiwany w testach). Błąd niesie metodę, ścieżkę
 * i status HTTP albo komunikaty GraphQL; nigdy nagłówków ani tokenu.
 * REST (etykiety, komentarze) i `graphql` idą tokenem Actions, więc nasze własne
 * zdjęcia etykiety mają nadawcę `github-actions[bot]` i workflow je pomija, a
 * wyłączenie scalania nie zależy od ważności tokenu człowieka. `graphqlCzlowieka`
 * (włączenie scalania, wpis do kolejki) idzie tokenem człowieka, gdy jest: tylko
 * wtedy wpis uruchamia kontrole grupy. `tozsamosc` mówi, który to przypadek.
 * @param {{ token: string, tokenCzlowieka?: string, fetchFn?: typeof fetch }} opcje
 * @returns {Api & { tozsamosc: 'czlowiek' | 'bot' }}
 */
export function utworzApi({ token, tokenCzlowieka = '', fetchFn = fetch }) {
  // Sekret wklejony z końcowym znakiem nowej linii psułby nagłówek.
  const czlowiek = tokenCzlowieka.trim();
  const naglowki = (/** @type {string} */ t) => ({
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${t}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  });
  // Wyjątek `fetch` bywa z treścią nagłówka, czyli z tokenem, a komunikat błędu trafia do
  // komentarza w publicznym repo: tu dostaje tylko opis bez tokenu.
  const wywolaj = async (/** @type {string} */ opis, /** @type {string} */ url, /** @type {RequestInit} */ init) => {
    try {
      return await fetchFn(url, init);
    } catch (blad) {
      // Zostaje rodzaj awarii (nazwa, kod sieci), nie treść: ta bywa z nagłówkiem, czyli z tokenem.
      const rodzaj = String((blad && /** @type {any} */ (blad).cause?.code) || (blad && /** @type {any} */ (blad).name) || 'Error').replace(/[^A-Za-z0-9_.-]/g, '');
      throw new Error(`${opis}: błąd połączenia albo odrzucony nagłówek (${rodzaj}; treść pominięta, żeby nie ujawnić tokenu)`);
    }
  };
  /** @param {string} t */
  const graphqlTokenem = (t) => async (/** @type {string} */ zapytanie, /** @type {Record<string, unknown>} */ zmienne) => {
    const odpowiedz = await wywolaj('GitHub GraphQL', 'https://api.github.com/graphql', {
      method: 'POST',
      headers: naglowki(t),
      body: JSON.stringify({ query: zapytanie, variables: zmienne }),
    });
    if (!odpowiedz.ok) throw new Error(`GitHub GraphQL: HTTP ${odpowiedz.status}`);
    const json = await odpowiedz.json();
    if (Array.isArray(json.errors) && json.errors.length > 0) {
      throw new Error(`GitHub GraphQL: ${json.errors.map((/** @type {{ message: string }} */ e) => e.message).join('; ')}`);
    }
    return json.data;
  };
  return {
    tozsamosc: czlowiek ? 'czlowiek' : 'bot',
    async rest(metoda, sciezka, cialo) {
      const odpowiedz = await wywolaj(`GitHub API ${metoda} ${sciezka}`, `https://api.github.com${sciezka}`, {
        method: metoda,
        headers: naglowki(token),
        body: cialo === undefined ? undefined : JSON.stringify(cialo),
      });
      if (metoda === 'DELETE' && odpowiedz.status === 404) return null;
      if (!odpowiedz.ok) throw new Error(`GitHub API ${metoda} ${sciezka}: HTTP ${odpowiedz.status}`);
      if (odpowiedz.status === 204) return null;
      return odpowiedz.json();
    },
    graphql: graphqlTokenem(token),
    ...(czlowiek ? { graphqlCzlowieka: graphqlTokenem(czlowiek) } : {}),
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
    const wynik = await wykonaj(d, zdarzenie, api);
    const wlaczono = {
      wlaczone: `Włączono automatyczne scalanie PR #${numer} (etykieta ${ETYKIETA_SCAL} od ${zdarzenie.sender?.login}).`,
      'juz-wlaczone': `PR #${numer}: scalanie już włączone przez człowieka, nie ruszam.`,
      'w-kolejce': `PR #${numer} jest już w kolejce scalania, nie ruszam.`,
      'brak-tokenu': `PR #${numer}: brak sekretu SCAL_TOKEN, scalania z workflow nie włączam (komentarz z instrukcją dodany).`,
    };
    const opis = {
      wlacz: wlaczono[/** @type {keyof typeof wlaczono} */ (wynik ?? 'wlaczone')],
      odmow: `Odmowa dla PR #${numer}: ${d.powody.join('; ')}.`,
      wylacz: `Wyłączono automatyczne scalanie PR #${numer} (${d.powody.join('; ')}).`,
      ignoruj: `Nic do zrobienia dla PR #${numer} (zdarzenie ${zdarzenie?.action ?? '?'}).`,
    };
    if (wynik === 'ponownie-nadana') return { kod: 0, linie: [`PR #${numer}: etykieta ${ETYKIETA_SCAL} jest z powrotem na PR (zdjęta i nadana od nowa), scalania nie wyłączam.`] };
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
  const wynik = await przetworz(zdarzenie, zgody.osoby ?? [], utworzApi({ token, tokenCzlowieka: process.env.SCAL_TOKEN ?? '' }));
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
