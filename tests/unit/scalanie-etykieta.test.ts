import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ETYKIETA_SCAL,
  ETYKIETA_WSTRZYMAJ,
  decyduj,
  przetworz,
  utworzApi,
  wykonaj,
} from '@/scripts/ci/scalanie-etykieta.mjs';

/**
 * Scalanie na etykietę `scal` (workflow „Scalanie na etykietę”): decyzja na
 * danych zdarzenia, bez GitHuba, i wykonanie przez atrapę API. Jedna ścieżka
 * dla sesji lokalnych i chmurowych: etykieta nadana przez REST, a automatyczne
 * scalanie (kolejka scalania) włącza workflow.
 */

const REPO = 'FaktWay/FaktWay';
const OSOBY = ['ezior8888-cpu', 'masloigor'];
const SHA = 'a'.repeat(40);

type Zdarzenie = ReturnType<typeof zdarzenie>;

function zdarzenie(
  nadpisz: {
    action?: string;
    label?: string;
    sender?: string;
    pr?: Record<string, unknown>;
    labele?: string[];
  } = {},
) {
  const { action = 'labeled', label = ETYKIETA_SCAL, sender = 'ezior8888-cpu', pr = {}, labele } = nadpisz;
  return {
    action,
    label: { name: label },
    sender: { login: sender },
    repository: { full_name: REPO },
    pull_request: {
      number: 42,
      node_id: 'PR_node_42',
      state: 'open',
      merged: false,
      draft: false,
      base: { ref: 'main' },
      head: { sha: SHA, repo: { full_name: REPO } },
      labels: (labele ?? [label]).map((name) => ({ name })),
      ...pr,
    },
  };
}

describe('decyduj: etykieta scal nadana', () => {
  it('nadawca z filtr/zgody.json, zwykły PR do main z tego repo: włącz', () => {
    const d = decyduj(zdarzenie(), OSOBY);
    expect(d.akcja).toBe('wlacz');
    expect(d.powody).toEqual([]);
  });

  it('nazwa nadawcy bez względu na wielkość liter', () => {
    expect(decyduj(zdarzenie({ sender: 'EZIOR8888-cpu' }), OSOBY).akcja).toBe('wlacz');
  });

  // Każdy warunek odmowy osobno zmienia „włącz” na „odmów”.
  const odmowy: Array<[string, Zdarzenie, RegExp]> = [
    ['nadawca spoza listy', zdarzenie({ sender: 'bielczyk17' }), /zgody\.json/],
    ['bot dependabota/renovate jako nadawca', zdarzenie({ sender: 'renovate[bot]' }), /zgody\.json/],
    ['szkic', zdarzenie({ pr: { draft: true } }), /szkic/],
    ['fork', zdarzenie({ pr: { head: { sha: SHA, repo: { full_name: 'ktos/FaktWay' } } } }), /innego repozytorium/],
    ['usunięte repozytorium głowy', zdarzenie({ pr: { head: { sha: SHA, repo: null } } }), /innego repozytorium/],
    ['baza inna niż main', zdarzenie({ pr: { base: { ref: 'claude/stos-bazowy' } } }), /bazę.*main/],
    ['wstrzymaj na PR', zdarzenie({ labele: [ETYKIETA_SCAL, ETYKIETA_WSTRZYMAJ] }), /wstrzymaj/],
    ['PR zamknięty', zdarzenie({ pr: { state: 'closed' } }), /nie jest otwarty/],
    ['PR już scalony', zdarzenie({ pr: { state: 'closed', merged: true } }), /nie jest otwarty/],
  ];
  it.each(odmowy)('odmawia: %s', (_nazwa, wejscie, powod) => {
    const d = decyduj(wejscie, OSOBY);
    expect(d.akcja).toBe('odmow');
    expect(d.zdejmijEtykiete).toBe(true);
    expect(d.powody.join(' ')).toMatch(powod);
  });

  it('zbiera wszystkie powody naraz', () => {
    const d = decyduj(zdarzenie({ sender: 'obcy', pr: { draft: true } }), OSOBY);
    expect(d.powody).toHaveLength(2);
  });

  it('komentarz odmowy nie ma gołego @login', () => {
    const d = decyduj(zdarzenie({ sender: 'obcy' }), OSOBY);
    expect(d.komentarz).not.toMatch(/(^|[^`\w])@\w/);
    expect(d.komentarz).toContain('`scal`');
  });
});

describe('decyduj: wyłączenie scalania', () => {
  it('etykieta scal zdjęta: wyłącz (bez zdejmowania, już jej nie ma)', () => {
    const d = decyduj(zdarzenie({ action: 'unlabeled', labele: [] }), OSOBY);
    expect(d.akcja).toBe('wylacz');
    expect(d.zdejmijEtykiete).toBe(false);
  });

  it('wstrzymaj nadane przez kogokolwiek: wyłącz (kierunek bezpieczny)', () => {
    const d = decyduj(zdarzenie({ label: ETYKIETA_WSTRZYMAJ, sender: 'bielczyk17', labele: [ETYKIETA_SCAL, ETYKIETA_WSTRZYMAJ] }), OSOBY);
    expect(d.akcja).toBe('wylacz');
  });

  it('nowy push na PR z etykietą scal: wyłącz, zdejmij etykietę, komentarz', () => {
    const d = decyduj(zdarzenie({ action: 'synchronize', label: '', labele: [ETYKIETA_SCAL] }), OSOBY);
    expect(d.akcja).toBe('wylacz');
    expect(d.zdejmijEtykiete).toBe(true);
    expect(d.komentarz).toMatch(/nowy push/i);
    expect(d.komentarz).toContain('`scal`');
  });

  it('nowy push na PR bez etykiety scal: nic', () => {
    expect(decyduj(zdarzenie({ action: 'synchronize', label: '', labele: ['inna'] }), OSOBY).akcja).toBe('ignoruj');
  });

  it('wstrzymaj zdjęte: nic (scalanie włącza się dopiero etykietą scal)', () => {
    expect(decyduj(zdarzenie({ action: 'unlabeled', label: ETYKIETA_WSTRZYMAJ, labele: [] }), OSOBY).akcja).toBe('ignoruj');
  });
});

describe('decyduj: zdarzenia do pominięcia', () => {
  it.each(['labeled', 'unlabeled', 'synchronize'])('github-actions[bot] jest ignorowany (%s)', (action) => {
    const d = decyduj(zdarzenie({ action, sender: 'github-actions[bot]', labele: [ETYKIETA_SCAL] }), OSOBY);
    expect(d.akcja).toBe('ignoruj');
  });

  it('inna etykieta i inna akcja: nic', () => {
    expect(decyduj(zdarzenie({ label: 'dependencies' }), OSOBY).akcja).toBe('ignoruj');
    expect(decyduj(zdarzenie({ action: 'opened' }), OSOBY).akcja).toBe('ignoruj');
  });

  it('pusta lista osób nikogo nie wpuszcza', () => {
    expect(decyduj(zdarzenie(), []).akcja).toBe('odmow');
  });
});

type Wywolanie = { rodzaj: 'rest' | 'graphql'; metoda?: string; sciezka?: string; cialo?: unknown; zapytanie?: string; zmienne?: Record<string, unknown> };

/** Atrapa API: zapisuje wywołania, GraphQL odpowiada według zapytania. */
function atrapa(opcje: {
  stan?: { autoMergeRequest: unknown; mergeQueueEntry: unknown };
  bladEnable?: string;
  bladGraphql?: string;
} = {}) {
  const wywolania: Wywolanie[] = [];
  const api = {
    async rest(metoda: string, sciezka: string, cialo?: unknown) {
      wywolania.push({ rodzaj: 'rest', metoda, sciezka, cialo });
      return null;
    },
    async graphql(zapytanie: string, zmienne: Record<string, unknown>) {
      wywolania.push({ rodzaj: 'graphql', zapytanie, zmienne });
      if (opcje.bladGraphql) throw new Error(opcje.bladGraphql);
      if (zapytanie.includes('enablePullRequestAutoMerge') && opcje.bladEnable) throw new Error(opcje.bladEnable);
      if (zapytanie.includes('autoMergeRequest') && zapytanie.includes('query')) {
        return { node: opcje.stan ?? { autoMergeRequest: null, mergeQueueEntry: null } };
      }
      return {};
    },
  };
  return { api, wywolania };
}

const mutacje = (w: Wywolanie[]) => w.filter((x) => x.rodzaj === 'graphql' && /mutation/.test(x.zapytanie ?? '')).map((x) => x.zapytanie ?? '');

describe('wykonaj', () => {
  it('wlacz: enablePullRequestAutoMerge z id PR, MERGE i oczekiwanym SHA głowy; jeden komentarz z nadawcą w backtickach', async () => {
    const z = zdarzenie();
    const { api, wywolania } = atrapa();
    await wykonaj(decyduj(z, OSOBY), z, api);
    const m = wywolania.find((w) => w.zapytanie?.includes('enablePullRequestAutoMerge'));
    expect(m?.zmienne).toMatchObject({ id: 'PR_node_42', sha: SHA });
    expect(m?.zapytanie).toContain('MERGE');
    const komentarze = wywolania.filter((w) => w.rodzaj === 'rest' && w.metoda === 'POST');
    expect(komentarze).toHaveLength(1);
    expect(komentarze[0].sciezka).toBe(`/repos/${REPO}/issues/42/comments`);
    const tresc = (komentarze[0].cialo as { body: string }).body;
    expect(tresc).toContain('`ezior8888-cpu`');
    expect(tresc).not.toMatch(/(^|[^`\w])@\w/);
    expect(wywolania.some((w) => w.metoda === 'DELETE')).toBe(false);
  });

  it('wlacz: PR już gotowy (clean status) trafia do kolejki przez enqueuePullRequest', async () => {
    const z = zdarzenie();
    const { api, wywolania } = atrapa({ bladEnable: 'Pull request Pull request is in clean status' });
    await wykonaj(decyduj(z, OSOBY), z, api);
    const m = mutacje(wywolania);
    expect(m.some((q) => q.includes('enablePullRequestAutoMerge'))).toBe(true);
    expect(m.some((q) => q.includes('enqueuePullRequest'))).toBe(true);
  });

  it('wlacz: inny błąd enable nie jest połykany', async () => {
    const z = zdarzenie();
    const { api } = atrapa({ bladEnable: 'Auto merge is not allowed for this repository' });
    await expect(wykonaj(decyduj(z, OSOBY), z, api)).rejects.toThrow(/not allowed/);
  });

  it('odmow: komentarz z powodem i zdjęcie etykiety scal przez REST DELETE, bez włączania', async () => {
    const z = zdarzenie({ sender: 'obcy' });
    const { api, wywolania } = atrapa();
    await wykonaj(decyduj(z, OSOBY), z, api);
    expect(mutacje(wywolania)).toEqual([]);
    const usuniecie = wywolania.find((w) => w.metoda === 'DELETE');
    expect(usuniecie?.sciezka).toBe(`/repos/${REPO}/issues/42/labels/scal`);
    const komentarz = wywolania.find((w) => w.metoda === 'POST');
    expect((komentarz?.cialo as { body: string }).body).toContain('zgody.json');
  });

  it('wylacz: wyłącza auto-merge i wyjmuje z kolejki, gdy oba istnieją', async () => {
    const z = zdarzenie({ action: 'unlabeled', labele: [] });
    const { api, wywolania } = atrapa({ stan: { autoMergeRequest: { enabledAt: 'x' }, mergeQueueEntry: { id: 'MQE_1' } } });
    await wykonaj(decyduj(z, OSOBY), z, api);
    const m = mutacje(wywolania);
    expect(m.some((q) => q.includes('disablePullRequestAutoMerge'))).toBe(true);
    const dequeue = wywolania.find((w) => w.zapytanie?.includes('dequeuePullRequest'));
    // Wejście dequeuePullRequest to ID PR, nie ID wpisu kolejki.
    expect(dequeue?.zmienne).toMatchObject({ id: 'PR_node_42' });
  });

  it('wylacz: nic nie było włączone, więc zero mutacji i zero błędu', async () => {
    const z = zdarzenie({ action: 'unlabeled', labele: [] });
    const { api, wywolania } = atrapa();
    await expect(wykonaj(decyduj(z, OSOBY), z, api)).resolves.toBeUndefined();
    expect(mutacje(wywolania)).toEqual([]);
  });

  it('wylacz po nowym pushu: zdejmuje etykietę, wyłącza i komentuje', async () => {
    const z = zdarzenie({ action: 'synchronize', label: '', labele: [ETYKIETA_SCAL] });
    const { api, wywolania } = atrapa({ stan: { autoMergeRequest: { enabledAt: 'x' }, mergeQueueEntry: null } });
    await wykonaj(decyduj(z, OSOBY), z, api);
    expect(wywolania.find((w) => w.metoda === 'DELETE')?.sciezka).toBe(`/repos/${REPO}/issues/42/labels/scal`);
    expect(mutacje(wywolania).some((q) => q.includes('disablePullRequestAutoMerge'))).toBe(true);
    expect((wywolania.find((w) => w.metoda === 'POST')?.cialo as { body: string }).body).toMatch(/nowy push/i);
  });

  it('ignoruj: zero wywołań', async () => {
    const z = zdarzenie({ label: 'inna' });
    const { api, wywolania } = atrapa();
    await wykonaj(decyduj(z, OSOBY), z, api);
    expect(wywolania).toEqual([]);
  });
});

describe('przetworz', () => {
  it('zwraca kod 0 i opis przy sukcesie, 1 i komunikat przy błędzie API (bez tokenu)', async () => {
    const dobra = atrapa();
    const ok = await przetworz(zdarzenie(), OSOBY, dobra.api);
    expect(ok.kod).toBe(0);
    expect(ok.linie.join('\n')).toMatch(/włącz/i);

    const zla = atrapa({ bladGraphql: 'Resource not accessible by integration' });
    const blad = await przetworz(zdarzenie(), OSOBY, zla.api);
    expect(blad.kod).toBe(1);
    expect(blad.linie.join('\n')).toContain('Resource not accessible by integration');
  });
});

describe('utworzApi', () => {
  it('REST: ścieżka, metoda i token w nagłówku; 404 przy DELETE jest dozwolone', async () => {
    const zapytania: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = async (url: string, init: RequestInit) => {
      zapytania.push({ url, init });
      return new Response('{}', { status: 404 });
    };
    const api = utworzApi({ token: 'TAJNY-TOKEN', fetchFn: fetchFn as unknown as typeof fetch });
    await expect(api.rest('DELETE', '/repos/x/y/issues/1/labels/scal')).resolves.toBeNull();
    expect(zapytania[0].url).toBe('https://api.github.com/repos/x/y/issues/1/labels/scal');
    expect(zapytania[0].init.method).toBe('DELETE');
    expect((zapytania[0].init.headers as Record<string, string>).Authorization).toBe('Bearer TAJNY-TOKEN');
  });

  it('REST: błąd HTTP niesie metodę, ścieżkę i status, nigdy token', async () => {
    const fetchFn = async () => new Response('{"message":"x"}', { status: 403 });
    const api = utworzApi({ token: 'TAJNY-TOKEN', fetchFn: fetchFn as unknown as typeof fetch });
    const blad = await api.rest('POST', '/repos/x/y/issues/1/comments', { body: 'a' }).catch((e: Error) => e);
    expect(blad).toBeInstanceOf(Error);
    expect((blad as Error).message).toMatch(/POST \/repos\/x\/y\/issues\/1\/comments: HTTP 403/);
    expect((blad as Error).message).not.toContain('TAJNY-TOKEN');
  });

  it('GraphQL: tablica errors staje się wyjątkiem z komunikatami GitHuba', async () => {
    const fetchFn = async () => new Response(JSON.stringify({ errors: [{ message: 'Pull request is in clean status' }] }), { status: 200 });
    const api = utworzApi({ token: 'TAJNY-TOKEN', fetchFn: fetchFn as unknown as typeof fetch });
    await expect(api.graphql('mutation { x }', {})).rejects.toThrow(/clean status/);
  });

  it('GraphQL: zwraca pole data', async () => {
    const fetchFn = async () => new Response(JSON.stringify({ data: { node: { a: 1 } } }), { status: 200 });
    const api = utworzApi({ token: 't', fetchFn: fetchFn as unknown as typeof fetch });
    await expect(api.graphql('query { node }', {})).resolves.toEqual({ node: { a: 1 } });
  });
});

describe('workflow scalanie-na-etykiete.yml', () => {
  const yml = readFileSync(join(process.cwd(), '.github/workflows/scalanie-na-etykiete.yml'), 'utf8').replace(/\r\n/g, '\n');

  it('pull_request_target z labeled, unlabeled, synchronize; bez merge_group', () => {
    expect(yml).toMatch(/^ {2}pull_request_target:\n {4}types: \[labeled, unlabeled, synchronize\]/m);
    expect(yml).not.toMatch(/^ {2}merge_group:/m);
    expect(yml).not.toMatch(/^ {2}pull_request:\n/m);
  });

  it('nie pobiera kodu z PR i nie wstawia danych z PR do poleceń powłoki', () => {
    expect(yml).not.toMatch(/^\s+ref:/m);
    expect(yml).toContain('persist-credentials: false');
    const polecenia = yml.split('\n').filter((l) => /^\s+(- )?run:/.test(l) || /^\s{10,}\S/.test(l)).join('\n');
    expect(polecenia).not.toMatch(/github\.event\.pull_request\.(title|body|head)/);
    expect(yml).not.toMatch(/\$\{\{\s*github\.(head_ref|event\.(pull_request|label|comment|issue))/);
  });

  it('job `scal`, minimalne uprawnienia, akcje przypięte do SHA, wywołuje skrypt', () => {
    expect(yml).toMatch(/^ {2}scal:\n/m);
    expect(yml).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(yml).toContain('node scripts/ci/scalanie-etykieta.mjs');
    for (const uses of yml.match(/uses: \S+/g) ?? []) expect(uses).toMatch(/@[0-9a-f]{40}/);
    expect(yml).toMatch(/timeout-minutes: 5/);
    expect(yml).toMatch(/cancel-in-progress: false/);
  });
});
