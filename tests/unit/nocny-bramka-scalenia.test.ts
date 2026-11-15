import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { parseCodeowners } from '@/scripts/ci/agent-guard.mjs';
import {
  BladApi,
  KONTROLE_WYMAGANE,
  KROK_TESTU_NA_BAZIE,
  WIEDZA_I_ZLOTE,
  SCIEZKI_BRAMKI,
  glowna,
  kategoriaPliku,
  ocenPR,
  oznaczDoScalenia,
  polaczWymagane,
  pominieteTesty,
  repoZAdresu,
  sekcjaOpisu,
  sprawdzWylacznik,
  sprawdzZrodlo,
  utworzApi,
  wszystkieStrony,
  zmiennaWlacza,
} from '@/scripts/nocny/bramka-scalenia.mjs';

/**
 * Bramka scalenia nocnego zespołu (docs/runbooks/nocny-zespol.md, „Bramki
 * scalenia”): TAK tylko, gdy wszystkie warunki są spełnione; każdy warunek
 * osobno zmienia wynik na NIE. GitHub i git przez atrapy.
 */

const REPO = 'FaktWay/FaktWay';
const SHA = 'a'.repeat(40);
const INNE_SHA = 'd'.repeat(40);
const CODEOWNERS = parseCodeowners('/lib/ksef/ @wlasciciel\n/supabase/migrations/ @wlasciciel\n/AGENTS.md @wlasciciel\n');

const OPIS = [
  '## Co naprawia',
  '',
  'N-01: lista faktur pokazywała zły status.',
  '',
  '## Najpierw test',
  '',
  '<!-- podpowiedź z szablonu -->',
  '`tests/unit/lista-status.test.ts`: 3 przypadki czerwone na main, zielone po naprawie.',
  '',
  '## Zmiana',
  '',
  '`lib/invoices/list-row-facts.ts`: status z daty zapłaty.',
].join('\n');

type Obiekt = Record<string, unknown>;

function pr(zmiany: Obiekt = {}): Obiekt {
  return {
    number: 900,
    state: 'open',
    merged: false,
    draft: false,
    base: { ref: 'main', repo: { full_name: REPO } },
    head: { ref: 'agent/nocny-2026-11-18-n01-lista', sha: SHA, repo: { full_name: REPO } },
    labels: [],
    mergeable: true,
    mergeable_state: 'clean',
    changed_files: 2,
    body: OPIS,
    ...zmiany,
  };
}

const PLIK_TESTU = { filename: 'tests/unit/lista-status.test.ts', status: 'added', changes: 30, patch: "@@ -0,0 +1,2 @@\n+it('status', () => {\n+});" };
const PLIK_KODU = { filename: 'lib/invoices/list-row-facts.ts', status: 'modified', changes: 4, patch: '@@ -1,1 +1,1 @@\n-a\n+b' };

const przebiegi = () =>
  KONTROLE_WYMAGANE.map((name, i) => ({ id: 1000 + i, name, status: 'completed', conclusion: 'success' }));
const kroki = [
  { name: 'Detect agent PR', conclusion: 'success' },
  { name: KROK_TESTU_NA_BAZIE, conclusion: 'success' },
];

function dane(zmiany: Obiekt = {}): Obiekt {
  return {
    zrodlo: { zgodne: true },
    wylacznik: { wlaczony: false },
    pr: pr(),
    pliki: [PLIK_TESTU, PLIK_KODU],
    przebiegi: przebiegi(),
    statusy: [],
    wymagane: KONTROLE_WYMAGANE,
    krokiTestFirst: kroki,
    skladowe: null,
    codeowners: CODEOWNERS,
    uwagi: [],
    ...zmiany,
  };
}

const ocena = (zmiany: Obiekt = {}) => ocenPR(dane(zmiany));
const powody = (zmiany: Obiekt = {}) => ocena(zmiany).powody.join('\n');

describe('ocenPR: wszystko spełnione', () => {
  it('daje TAK bez powodów, z SHA i gałęzią do scalenia', () => {
    const wynik = ocena();
    expect(wynik.powody).toEqual([]);
    expect(wynik).toMatchObject({ wynik: 'TAK', numer: 900, sha: SHA, galaz: 'agent/nocny-2026-11-18-n01-lista', linia: null });
  });

  it('uwaga wyłącznika nie blokuje, ale idzie do raportu', () => {
    const wynik = ocena({ wylacznik: { wlaczony: false, uwaga: 'Zmiennej NOCNY_STOP nie da się odczytać' } });
    expect(wynik.wynik).toBe('TAK');
    expect(wynik.uwagi).toEqual(['Zmiennej NOCNY_STOP nie da się odczytać']);
  });

  it('etykieta spoza zgoda:* nie blokuje', () => {
    expect(ocena({ pr: pr({ labels: [{ name: 'nocny:dziennik' }] }) }).wynik).toBe('TAK');
  });
});

describe('ocenPR: źródło bramki i wyłącznik', () => {
  it('bramka spoza main to NIE', () => {
    expect(powody({ zrodlo: { zgodne: false, powod: 'Pliki bramki różnią się od origin/main' } })).toContain('różnią się od origin/main');
  });

  it('wyłącznik włączony albo nieznany to NIE', () => {
    expect(powody({ wylacznik: { wlaczony: true, powod: 'otwarte zgłoszenie #5 z etykietą nocny:stop' } })).toContain('nocny:stop');
    expect(ocena({ wylacznik: undefined }).wynik).toBe('NIE');
  });
});

describe('ocenPR: stan PR', () => {
  it.each([
    ['zamknięty', { state: 'closed' }, 'nie jest otwarty'],
    ['już scalony', { state: 'closed', merged: true }, 'już scalony'],
    ['szkic', { draft: true }, 'szkicem'],
    ['baza inna niż main', { base: { ref: 'develop', repo: { full_name: REPO } } }, 'nie do main'],
    ['fork', { head: { ref: 'agent/nocny-x', sha: SHA, repo: { full_name: 'obcy/repo' } } }, 'fork'],
    ['usunięty fork', { head: { ref: 'agent/nocny-x', sha: SHA, repo: null } }, 'fork'],
    ['gałąź człowieka', { head: { ref: 'claude/n01-lista', sha: SHA, repo: { full_name: REPO } } }, 'nie zaczyna się od agent/nocny-'],
    ['gałąź agenta z issue', { head: { ref: 'agent/issue-12', sha: SHA, repo: { full_name: REPO } } }, 'nie zaczyna się od agent/nocny-'],
    ['etykieta zgody', { labels: [{ name: 'zgoda:obszar-wrazliwy' }] }, 'zgód nie nadaje'],
    ['etykieta zgody filtra', { labels: [{ name: 'zgoda:wiedza-prawna' }] }, 'zgód nie nadaje'],
    ['etykieta wstrzymaj', { labels: [{ name: 'wstrzymaj' }] }, 'ktoś zatrzymał scalanie'],
    ['GitHub jeszcze liczy', { mergeable: null, mergeable_state: 'unknown' }, 'jeszcze liczy'],
    ['konflikt', { mergeable: false, mergeable_state: 'dirty' }, 'konflikt z main'],
    ['gałąź za main', { mergeable: true, mergeable_state: 'behind' }, 'za main'],
    ['blokada rulesetu', { mergeable: true, mergeable_state: 'blocked' }, 'blokada rulesetu'],
    ['czerwona kontrola niewymagana', { mergeable: true, mergeable_state: 'unstable' }, 'spoza wymaganych'],
  ])('%s to NIE', (_nazwa, zmiany, oczekiwany) => {
    const wynik = ocena({ pr: pr(zmiany) });
    expect(wynik.wynik).toBe('NIE');
    expect(wynik.powody.join('\n')).toContain(oczekiwany);
  });
});

describe('ocenPR: pliki', () => {
  const zPlikiem = (plik: Obiekt) => ({ pliki: [PLIK_TESTU, PLIK_KODU, plik], pr: pr({ changed_files: 3 }) });

  // Lista z polecenia (14.11.2026) plus własna bramka, zależności poza katalogiem głównym i konfiguracja kontroli.
  it.each([
    'supabase/migrations/00205_nowa.sql',
    'AGENTS.md',
    'CLAUDE.md',
    'mobile/AGENTS.md',
    '.claude/settings.json',
    '.github/workflows/ci.yml',
    '.github/CODEOWNERS',
    '.githooks/pre-push',
    'scripts/ci/agent-guard.mjs',
    'scripts/security/inwentarz.sh',
    'scripts/filtr/straz.mjs',
    'filtr/zapadka.json',
    'filtr/mapa-ryzyka.json',
    'package.json',
    'mobile/package.json',
    'pnpm-lock.yaml',
    'Dockerfile',
    '.dockerignore',
    'next.config.ts',
    'ops/bramka/index.ts',
    'scripts/ops/wdroz-produkcje.sh',
    'scripts/hetzner/serwer.sh',
    'scripts/nocny/bramka-scalenia.mjs',
    'scripts/nocny/telegram.mjs',
    'docs/nocny/PROMPT.md',
    'docs/runbooks/nocny-zespol.md',
    'vitest.config.ts',
    'tsconfig.json',
    'eslint.config.mjs',
    'tests/setup.ts',
    'tests/setup-rls.ts',
    'tests/helpers/blokada-sieci.ts',
    'tests/stubs/server-only.ts',
    'tests/unit/nocny-telegram.test.ts',
    'scripts/dev/przygotuj-worktree.sh',
    'scripts/dev/wlacz-hooki.mjs',
    'mobile/tsconfig.json',
    'mobile/eslint.config.js',
    'mobile/pnpm-workspace.yaml',
    'supabase/config.toml',
    'docs/runbooks/scalanie-pr.md',
    'docs/koordynacja/PLAN-FINORA.md',
    'docs/filtr/LISTA-KONTROLNA.md',
  ])('zasady, infrastruktura i migracje: %s to NIE', (sciezka) => {
    const wynik = ocena(zPlikiem({ filename: sciezka, status: 'modified', changes: 1, patch: '@@\n+x' }));
    expect(wynik.wynik).toBe('NIE');
    expect(wynik.powody.join('\n')).toMatch(/Migracje|Zasady i infrastruktura/);
  });

  it.each([
    'lib/ksiegowosc/parametry/2027.ts',
    'tests/filtr/wyrocznia/ryczalt.ts',
    'tests/filtr/zlote-pliki/jpk.xml',
    'tests/fixtures/ksiegowosc/zlote/przypadek-01.json',
    'tests/filtr/przyklady-urzedowe/zus.json',
    'tests/unit/__snapshots__/import-wiersze-tozsamosc.test.ts.snap',
    'tests/unit/ksiegowosc-zlote.test.ts',
    'lib/xml/schemas/fa3/schemat.xsd',
    'docs/ksiegowosc/ZLOTE-PRZYPADKI.md',
  ])('wiedza prawna i złote pliki: %s to NIE', (sciezka) => {
    const wynik = ocena(zPlikiem({ filename: sciezka, status: 'modified', changes: 1, patch: '@@\n+x' }));
    expect(wynik.wynik).toBe('NIE');
    expect(wynik.powody.join('\n')).toContain('Wiedza prawna i złote pliki');
  });

  it('rejestr przepisów (filtr/przepisy) jest zablokowany', () => {
    expect(ocena(zPlikiem({ filename: 'filtr/przepisy/ksiegowosc.json', status: 'modified', changes: 1, patch: '@@\n+x' })).wynik).toBe('NIE');
  });

  it('przeniesienie pliku z zakazanej ścieżki też jest zablokowane', () => {
    const wynik = ocena(zPlikiem({ filename: 'docs/zapadka.json', previous_filename: 'filtr/zapadka.json', status: 'renamed', changes: 0 }));
    expect(wynik.powody.join('\n')).toContain('Zasady i infrastruktura: nocny zespół nie zmienia własnych reguł, CI, zależności ani serwerów: docs/zapadka.json');
  });

  it('obszar z CODEOWNERS: NIE z linią zgody i scalenia dla Bartosza', () => {
    const wynik = ocena(zPlikiem({ filename: 'lib/ksef/submit.ts', status: 'modified', changes: 2, patch: '@@\n+x' }));
    expect(wynik.wynik).toBe('NIE');
    expect(wynik.powody.join('\n')).toContain('Obszar wrażliwy z .github/CODEOWNERS: lib/ksef/submit.ts');
    expect(wynik.linia).toBe(
      'po przeczytaniu zmian: gh pr edit 900 --add-label zgoda:obszar-wrazliwy && sleep 30 && ./scripts/ops/scal-pr.sh 900 --czekaj',
    );
  });

  it('obszar z CODEOWNERS z nadaną już zgodą: linia bez nadawania etykiety', () => {
    const wynik = ocena({
      pliki: [PLIK_TESTU, PLIK_KODU, { filename: 'lib/ksef/submit.ts', status: 'modified', changes: 2, patch: '@@\n+x' }],
      pr: pr({ changed_files: 3, labels: [{ name: 'zgoda:obszar-wrazliwy' }] }),
    });
    expect(wynik.wynik).toBe('NIE');
    expect(wynik.linia).toBe('po przeczytaniu zmian: ./scripts/ops/scal-pr.sh 900 --czekaj');
  });

  it('fork albo cudza gałąź z obszarem wrażliwym: bez linii do scalenia', () => {
    const plik = { filename: 'lib/ksef/submit.ts', status: 'modified', changes: 2, patch: '@@\n+x' };
    const fork = { head: { ref: 'agent/nocny-x', sha: SHA, repo: { full_name: 'obcy/repo' } }, changed_files: 3 };
    expect(ocena({ pliki: [PLIK_TESTU, PLIK_KODU, plik], pr: pr(fork) }).linia).toBeNull();
    const zamkniety = { state: 'closed', changed_files: 3 };
    expect(ocena({ pliki: [PLIK_TESTU, PLIK_KODU, plik], pr: pr(zamkniety) }).linia).toBeNull();
  });

  it('zakazana kategoria: linia do przejrzenia PR, bez scalania', () => {
    expect(ocena(zPlikiem({ filename: 'supabase/migrations/00205_x.sql', status: 'added', changes: 3, patch: '@@\n+x' })).linia).toBe(
      'zmiana poza zasięgiem nocnego zespołu, przejrzyj ją i zdecyduj: gh pr view 900 --web',
    );
  });

  it('bez nowego albo zmienionego testu to NIE', () => {
    expect(powody({ pliki: [PLIK_KODU], pr: pr({ changed_files: 1 }) })).toContain('Brak nowego albo zmienionego testu');
    // Samo przeniesienie testu bez zmian treści nie jest nowym testem.
    const przeniesiony = { filename: 'tests/unit/lista-status.test.ts', previous_filename: 'tests/unit/stary.test.ts', status: 'renamed', changes: 0 };
    expect(powody({ pliki: [przeniesiony, PLIK_KODU] })).toContain('Brak nowego albo zmienionego testu');
  });

  it('test, który znika albo przestaje być testem, to NIE', () => {
    const usuniety = { filename: 'tests/unit/inny.test.ts', status: 'removed', changes: 10 };
    expect(ocena({ pliki: [PLIK_TESTU, PLIK_KODU, usuniety], pr: pr({ changed_files: 3 }) }).powody.join('\n')).toContain('PR wyłącza testy');
    const wylaczony = { filename: 'tests/unit/inny.ts', previous_filename: 'tests/unit/inny.test.ts', status: 'renamed', changes: 0 };
    expect(ocena({ pliki: [PLIK_TESTU, PLIK_KODU, wylaczony], pr: pr({ changed_files: 3 }) }).powody.join('\n')).toContain('tests/unit/inny.test.ts');
  });

  it.each([
    ["+it.skip('a', () => {});", true],
    ['+  describe.only(\'b\', () => {});', true],
    ["+test.skip.each([1])('c', () => {});", true],
    ["+xit('d', () => {});", true],
    ["+fdescribe('e', () => {});", true],
    ["+it.concurrent.skip('g', () => {});", true],
    ["+describe.sequential.only('h', () => {});", true],
    ['+  ctx.skip();', true],
    ["+it.skipIf(true)('i', () => {});", true],
    ["+it.runIf(false)('j', () => {});", true],
    ["+it.todo('k');", true],
    ["+it.fails('FZ-001: znane naruszenie', () => {});", true],
    ["+describe.skipIf(!bazaDostepna)('rls', () => {});", false],
    ["+it.runIf(process.env.CI)('f', () => {});", false],
    ["-it.skip('usunięte pominięcie', () => {});", false],
  ])('pominięcie testu w dodanej linii %s: %s', (linia, blokuje) => {
    expect(pominieteTesty(`@@ -1,1 +1,1 @@\n${linia}`).length > 0).toBe(blokuje);
    const plik = { ...PLIK_TESTU, patch: `@@ -1,1 +1,1 @@\n${linia}` };
    expect(ocena({ pliki: [plik, PLIK_KODU] }).wynik).toBe(blokuje ? 'NIE' : 'TAK');
  });

  it('istniejący test dostaje tylko nowe linie: zmieniona albo usunięta linia to NIE', () => {
    const zmieniony = { filename: 'tests/unit/stary.test.ts', status: 'modified', changes: 2, patch: '@@ -1,1 +1,1 @@\n-expect(vat(100)).toBe(23);\n+expect(vat(100)).toBe(22);' };
    const wynik = ocena({ pliki: [PLIK_TESTU, PLIK_KODU, zmieniony], pr: pr({ changed_files: 3 }) });
    expect(wynik.powody.join('\n')).toContain('PR zmienia albo usuwa linie istniejących testów: tests/unit/stary.test.ts');
    const dopisany = { ...zmieniony, patch: "@@ -1,0 +2,1 @@\n+it('nowy przypadek', () => {});" };
    expect(ocena({ pliki: [PLIK_TESTU, PLIK_KODU, dopisany], pr: pr({ changed_files: 3 }) }).wynik).toBe('TAK');
  });

  it('linia zgody i scalenia tylko wtedy, gdy brak zgody to jedyna przeszkoda', () => {
    const wrazliwy = { filename: 'lib/ksef/submit.ts', status: 'modified', changes: 2, patch: '@@\n+x' };
    const zgoda = 'po przeczytaniu zmian: gh pr edit 900 --add-label zgoda:obszar-wrazliwy && sleep 30 && ./scripts/ops/scal-pr.sh 900 --czekaj';
    const przejrzyj = 'czeka na zgodę, ale ma też inne powody NIE, przejrzyj ją i zdecyduj: gh pr view 900 --web';
    const z = (zmiany: Obiekt) => ocena({ pliki: [PLIK_TESTU, PLIK_KODU, wrazliwy], pr: pr({ changed_files: 3 }), ...zmiany }).linia;
    // Skutki samego braku zgody: czerwony „Agent guard”, stan blocked.
    const agentCzerwony = [...przebiegi(), { id: 5000, name: 'Agent guard', status: 'completed', conclusion: 'failure' }];
    expect(z({ przebiegi: agentCzerwony })).toBe(zgoda);
    expect(z({ pr: pr({ changed_files: 3, mergeable_state: 'blocked' }) })).toBe(zgoda);
    // Inne powody: usunięty test, pominięty test na bazie, kontrole w toku, czerwony test jednostkowy.
    const usuniety = { filename: 'tests/unit/inny.test.ts', status: 'removed', changes: 9 };
    expect(ocena({ pliki: [PLIK_TESTU, PLIK_KODU, wrazliwy, usuniety], pr: pr({ changed_files: 4 }) }).linia).toBe(przejrzyj);
    expect(z({ krokiTestFirst: [{ name: KROK_TESTU_NA_BAZIE, conclusion: 'skipped' }] })).toBe(przejrzyj);
    expect(z({ przebiegi: [...przebiegi(), { id: 5000, name: 'Next build', status: 'in_progress', conclusion: null }] })).toBe(przejrzyj);
    expect(z({ przebiegi: [...przebiegi(), { id: 5000, name: 'Typecheck + Lint + Unit tests', status: 'completed', conclusion: 'failure' }] })).toBe(przejrzyj);
  });

  it('test bez podglądu zmian (za duży diff) to NIE', () => {
    const { patch: _bez, ...bezPatcha } = PLIK_TESTU;
    expect(powody({ pliki: [bezPatcha, PLIK_KODU] })).toContain('za duży diff');
  });

  it('niepełna lista plików to NIE', () => {
    expect(powody({ pr: pr({ changed_files: 3001 }) })).toContain('Lista plików niepełna');
  });
});

describe('ocenPR: zgody, których zażąda „Filtr: straż”', () => {
  // Znacznik wyjątku składany z części: dosłowny w tym pliku straż wzięłaby za nowy wyjątek.
  const ZNACZNIK = ['filtr', 'wyjatek'].join('-');
  const zPlikiem = (plik: Obiekt) => ({ pliki: [PLIK_TESTU, PLIK_KODU, plik], pr: pr({ changed_files: 3 }) });
  const testFiltra = (zmiany: Obiekt) => ({ filename: 'tests/filtr/niezmienniki/kwoty.test.ts', status: 'modified', changes: 2, ...zmiany });

  it('zmieniona albo usunięta linia testu filtra: NIE z dokładną etykietą i linią dla Bartosza', () => {
    const wynik = ocena(zPlikiem(testFiltra({ patch: "@@ -1,1 +1,1 @@\n-expect(a).toBe(1);\n+expect(a).toBe(2);" })));
    expect(wynik.wynik).toBe('NIE');
    expect(wynik.powody.join('\n')).toContain('„Filtr: straż” zażąda etykiety zgoda:zmiana-filtra (tests/filtr/niezmienniki/kwoty.test.ts)');
    expect(wynik.linia).toBe('po przeczytaniu zmian: ./scripts/ops/scal-pr.sh 900 --zgoda zmiana-filtra --po-drugim-czytelniku --czekaj');
  });

  it('przeniesiony test filtra też wymaga zgody, same dopisane linie nie', () => {
    expect(ocena(zPlikiem(testFiltra({ status: 'renamed', previous_filename: 'tests/filtr/stary.test.ts', patch: "@@\n+it('x', () => {});" }))).powody.join('\n')).toContain(
      'zgoda:zmiana-filtra',
    );
    expect(ocena(zPlikiem(testFiltra({ status: 'added', patch: "@@ -0,0 +1,1 @@\n+it('nowy niezmiennik', () => {});" }))).wynik).toBe('TAK');
  });

  it('nowy komentarz wyjątku filtra: NIE z zgoda:wyjatek-filtra', () => {
    const wynik = ocena(zPlikiem({ filename: 'lib/invoices/inny.ts', status: 'modified', changes: 1, patch: `@@\n+// ${ZNACZNIK}: kwoty-bez-float powód` }));
    expect(wynik.powody.join('\n')).toContain('zgoda:wyjatek-filtra (lib/invoices/inny.ts)');
    expect(wynik.linia).toBe('po przeczytaniu zmian: ./scripts/ops/scal-pr.sh 900 --zgoda wyjatek-filtra --po-drugim-czytelniku --czekaj');
  });

  it('obszar z CODEOWNERS i zgoda straży naraz: etykieta obszaru, potem scal-pr.sh z flagą', () => {
    const wynik = ocena({
      pliki: [PLIK_TESTU, PLIK_KODU, testFiltra({ patch: '@@\n-a\n+b' }), { filename: 'lib/ksef/submit.ts', status: 'modified', changes: 2, patch: '@@\n+x' }],
      pr: pr({ changed_files: 4 }),
    });
    expect(wynik.linia).toBe(
      'po przeczytaniu zmian: gh pr edit 900 --add-label zgoda:obszar-wrazliwy && sleep 30 && ./scripts/ops/scal-pr.sh 900 --zgoda zmiana-filtra --po-drugim-czytelniku --czekaj',
    );
  });
});

describe('ocenPR: opis z czerwonym testem', () => {
  it.each([
    ['bez sekcji', OPIS.replace('## Najpierw test', '## Testy'), 'bez sekcji „## Najpierw test”'],
    ['sekcja z samym n/d', OPIS.replace('`tests/unit/lista-status.test.ts`: 3 przypadki czerwone na main, zielone po naprawie.', 'n/d'), 'nie wskazuje pliku testu'],
    ['test spoza PR', OPIS.replace('tests/unit/lista-status.test.ts', 'tests/unit/inny.test.ts'), 'nie wskazuje pliku testu'],
    ['ścieżka tylko w komentarzu szablonu', OPIS.replace('`tests/unit/lista-status.test.ts`: 3', '<!-- tests/unit/lista-status.test.ts --> 3'), 'nie wskazuje pliku testu'],
    ['pusty opis', null, 'bez sekcji'],
  ])('%s to NIE', (_nazwa, opis, oczekiwany) => {
    expect(powody({ pr: pr({ body: opis }) })).toContain(oczekiwany);
  });

  it('sama nazwa pliku testu wystarcza, nagłówek „Czerwony test” też', () => {
    expect(ocena({ pr: pr({ body: '## Najpierw test\n\nlista-status.test.ts padał na main.' }) }).wynik).toBe('TAK');
    expect(ocena({ pr: pr({ body: '## Czerwony test\n\n`tests/unit/lista-status.test.ts`' }) }).wynik).toBe('TAK');
  });

  it('sekcja kończy się na następnym nagłówku ## i obejmuje ###', () => {
    expect(sekcjaOpisu('## A\nx\n### B\ny\n## C\nz', /^##\s+A\b/)).toBe('x\n### B\ny');
    expect(sekcjaOpisu('## A\n<!-- ukryte -->\nwidoczne', /^##\s+A\b/)).toBe('widoczne');
    expect(sekcjaOpisu('brak', /^##\s+A\b/)).toBeNull();
  });
});

describe('ocenPR: kontrole', () => {
  const bez = (nazwa: string) => przebiegi().filter((p) => p.name !== nazwa);

  it.each(['Filtr: straż', 'Filtr: testy prawne', 'Agent guard', 'Test-first (agent)', 'Typecheck + Lint + Unit tests', 'RLS isolation (lokalny Supabase)'])(
    'brak kontroli %s to NIE',
    (nazwa) => {
      expect(powody({ przebiegi: bez(nazwa) })).toContain(`Brak kontroli na głowie PR: ${nazwa}`);
    },
  );

  it('wymagana kontrola pominięta (skipped) to NIE', () => {
    const lista = przebiegi().map((p) => (p.name === 'Filtr: straż' ? { ...p, conclusion: 'skipped' } : p));
    expect(powody({ przebiegi: lista })).toContain('Filtr: straż: skipped');
  });

  it('liczy się najnowszy przebieg: stary sukces i nowa porażka to NIE, odwrotnie TAK', () => {
    const porazkaPoSukcesie = [...przebiegi(), { id: 5000, name: 'Filtr: straż', status: 'completed', conclusion: 'failure' }];
    expect(powody({ przebiegi: porazkaPoSukcesie })).toContain('Filtr: straż: failure');
    const sukcesPoPorazce = [
      { id: 1, name: 'Agent guard', status: 'completed', conclusion: 'cancelled' },
      { id: 2, name: 'Filtr: straż', status: 'completed', conclusion: 'failure' },
      ...przebiegi(),
    ];
    expect(ocena({ przebiegi: sukcesPoPorazce }).wynik).toBe('TAK');
  });

  it('kontrola w toku to NIE', () => {
    const lista = [...przebiegi(), { id: 5000, name: 'Next build', status: 'in_progress', conclusion: null }];
    expect(powody({ przebiegi: lista })).toContain('Kontrole w toku: Next build');
  });

  it('niewymagana kontrola: neutral i skipped przechodzą, failure i cancelled nie', () => {
    // „Filtr (TZ UTC)”: job macierzy filtra, niewymagany (wymagany jest „Filtr: testy prawne”).
    const z = (conclusion: string) => [...przebiegi(), { id: 5000, name: 'Filtr (TZ UTC)', status: 'completed', conclusion }];
    expect(ocena({ przebiegi: z('neutral') }).wynik).toBe('TAK');
    expect(ocena({ przebiegi: z('skipped') }).wynik).toBe('TAK');
    expect(powody({ przebiegi: z('failure') })).toContain('Filtr (TZ UTC): failure');
    expect(powody({ przebiegi: z('cancelled') })).toContain('Filtr (TZ UTC): cancelled');
  });

  it('stare statusy commita: najnowszy na kontekst musi być success', () => {
    expect(ocena({ statusy: [{ id: 1, context: 'zewn', state: 'failure' }, { id: 2, context: 'zewn', state: 'success' }] }).wynik).toBe('TAK');
    expect(powody({ statusy: [{ id: 1, context: 'zewn', state: 'pending' }] })).toContain('Kontrole w toku: zewn');
    expect(powody({ statusy: [{ id: 1, context: 'zewn', state: 'error' }] })).toContain('zewn: error');
  });

  it('Test-first bez uruchomionego testu na kodzie bazowym to NIE', () => {
    const pominiety = [{ name: 'Detect agent PR', conclusion: 'success' }, { name: KROK_TESTU_NA_BAZIE, conclusion: 'skipped' }];
    expect(powody({ krokiTestFirst: pominiety })).toContain('pominął test na kodzie bazowym');
    expect(powody({ krokiTestFirst: [{ name: 'Detect agent PR', conclusion: 'success' }] })).toContain(`bez kroku „${KROK_TESTU_NA_BAZIE}”`);
    expect(powody({ krokiTestFirst: null })).toContain(`bez kroku „${KROK_TESTU_NA_BAZIE}”`);
  });

  it('kontrola wymagana w rulesecie main dochodzi do listy', () => {
    const wymagane = polaczWymagane([
      { type: 'pull_request' },
      { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'Nowa kontrola' }, { context: 'Agent guard' }] } },
    ]);
    expect(wymagane).toEqual([...KONTROLE_WYMAGANE, 'Nowa kontrola']);
    expect(powody({ wymagane })).toContain('Brak kontroli na głowie PR: Nowa kontrola');
    expect(polaczWymagane(null)).toEqual(KONTROLE_WYMAGANE);
  });
});

describe('listy bramki', () => {
  it('wiedza prawna z „Filtra: straż” obejmuje ścieżki z polecenia', () => {
    for (const wzorzec of ['filtr/przepisy/**', 'lib/ksiegowosc/parametry/**', 'tests/filtr/wyrocznia/**']) {
      expect(WIEDZA_I_ZLOTE).toContain(wzorzec);
    }
  });

  it('kategorie: migracje i zasady przed obszarem wrażliwym, kod domenowy bez kategorii', () => {
    expect(kategoriaPliku('supabase/migrations/00205_x.sql', CODEOWNERS)).toBe('migracje');
    expect(kategoriaPliku('AGENTS.md', CODEOWNERS)).toBe('zasady');
    expect(kategoriaPliku('lib/ksef/submit.ts', CODEOWNERS)).toBe('wrazliwe');
    expect(kategoriaPliku('lib/invoices/list-row-facts.ts', CODEOWNERS)).toBeNull();
    expect(kategoriaPliku('components/invoices/correction-form.tsx', CODEOWNERS)).toBeNull();
  });

  it('nazwy kontroli i krok testu na kodzie bazowym istnieją w workflow (inaczej bramka zawsze mówi NIE)', () => {
    const katalog = join(process.cwd(), '.github/workflows');
    const workflow = readdirSync(katalog)
      .filter((plik) => plik.endsWith('.yml'))
      .map((plik) => readFileSync(join(katalog, plik), 'utf8'))
      .join('\n');
    for (const nazwa of KONTROLE_WYMAGANE.filter((n) => !n.startsWith('CodeQL ('))) {
      const jakoNazwa = workflow.includes(`name: ${nazwa}\n`) || workflow.includes(`name: '${nazwa}'`);
      const jakoJob = workflow.includes(`\n  ${nazwa}:\n`);
      expect(jakoNazwa || jakoJob, nazwa).toBe(true);
    }
    expect(workflow).toContain('name: CodeQL (${{ matrix.language }})');
    expect(readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')).toContain(`- name: ${KROK_TESTU_NA_BAZIE}\n`);
  });
});

describe('wyłącznik', () => {
  it.each([
    ['1', true],
    ['tak', true],
    ['stop', true],
    ['', false],
    ['0', false],
    ['nie', false],
    ['false', false],
    [' OFF ', false],
  ])('NOCNY_STOP=%j włącza: %s', (wartosc, wlacza) => {
    expect(zmiennaWlacza(wartosc)).toBe(wlacza);
  });

  const apiWylacznika = (zgloszenia: unknown, zmienna: unknown, etykieta: unknown = { name: 'nocny:stop' }) =>
    vi.fn(async (sciezka: string) => {
      if (sciezka.includes('/issues?')) return zgloszenia;
      if (sciezka === `repos/${REPO}/labels/nocny%3Astop`) return etykieta;
      if (sciezka.includes('/actions/variables/NOCNY_STOP')) {
        if (zmienna instanceof Error) throw zmienna;
        return zmienna;
      }
      throw new Error(`nieoczekiwane: ${sciezka}`);
    });

  it('otwarte zgłoszenie z etykietą nocny:stop zatrzymuje noc', async () => {
    const api = apiWylacznika([{ number: 5 }], null);
    await expect(sprawdzWylacznik({ api, repo: REPO })).resolves.toEqual({ wlaczony: true, powod: 'otwarte zgłoszenie #5 z etykietą nocny:stop' });
    expect(api.mock.calls[0][0]).toBe(`repos/${REPO}/issues?state=open&labels=nocny%3Astop&per_page=5`);
  });

  it('zmienna: brak (404) to praca, wartość 1 to stop, 0 to praca', async () => {
    await expect(sprawdzWylacznik({ api: apiWylacznika([], null), repo: REPO })).resolves.toEqual({ wlaczony: false });
    await expect(sprawdzWylacznik({ api: apiWylacznika([], { name: 'NOCNY_STOP', value: '1' }), repo: REPO })).resolves.toMatchObject({ wlaczony: true });
    await expect(sprawdzWylacznik({ api: apiWylacznika([], { name: 'NOCNY_STOP', value: '0' }), repo: REPO })).resolves.toEqual({ wlaczony: false });
  });

  it('zmiennej bez uprawnień (403) nie da się odczytać: uwaga, działa sama etykieta', async () => {
    const wynik = await sprawdzWylacznik({ api: apiWylacznika([], new BladApi('repos/x/actions/variables/NOCNY_STOP', 403, 'brak')), repo: REPO });
    expect(wynik.wlaczony).toBe(false);
    expect(wynik.uwaga).toContain('HTTP 403');
  });

  it('bez etykiety nocny:stop w repozytorium: praca, ale z uwagą (wyłącznik przez etykietę nie zadziała)', async () => {
    const wynik = await sprawdzWylacznik({ api: apiWylacznika([], null, null), repo: REPO });
    expect(wynik.wlaczony).toBe(false);
    expect(wynik.uwaga).toContain('Etykiety nocny:stop nie ma w repozytorium');
  });

  it('błąd odczytu zgłoszeń albo inny błąd zmiennej przerywa (stop)', async () => {
    await expect(sprawdzWylacznik({ api: apiWylacznika({ message: 'x' }, null), repo: REPO })).rejects.toThrow('stan wyłącznika nieznany');
    await expect(sprawdzWylacznik({ api: apiWylacznika([], new BladApi('x', 500, 'awaria')), repo: REPO })).rejects.toThrow('HTTP 500');
  });
});

describe('GitHub przez gh api i git', () => {
  it('składa polecenie gh api, a 404 z dopusc404 to null', async () => {
    const uruchom = vi.fn((argumenty: string[]) => {
      if (argumenty.includes('repos/x/brak')) throw Object.assign(new Error('exit 1'), { stderr: 'gh: Not Found (HTTP 404)\n', stdout: '{"message":"Not Found"}' });
      return '{"ok":true}';
    });
    const api = utworzApi(uruchom);
    await expect(api('repos/x/y')).resolves.toEqual({ ok: true });
    expect(uruchom).toHaveBeenLastCalledWith(['api', '--method', 'GET', 'repos/x/y']);
    await api('repos/x/y/pulls/1/merge', { metoda: 'PUT', pola: { merge_method: 'merge', sha: SHA } });
    expect(uruchom).toHaveBeenLastCalledWith(['api', '--method', 'PUT', 'repos/x/y/pulls/1/merge', '-f', 'merge_method=merge', '-f', `sha=${SHA}`]);
    await expect(api('repos/x/brak', { dopusc404: true })).resolves.toBeNull();
    await expect(api('repos/x/brak')).rejects.toMatchObject({ status: 404 });
  });

  it('czyta wszystkie strony listy', async () => {
    const api = vi.fn(async (sciezka: string) => {
      const strona = Number(/[?&]page=(\d+)/.exec(sciezka)?.[1]);
      const ile = strona === 1 ? 100 : 5;
      return { check_runs: Array.from({ length: ile }, (_, i) => ({ id: strona * 1000 + i })) };
    });
    const lista = await wszystkieStrony(api, 'repos/x/commits/s/check-runs?filter=all', 'check_runs');
    expect(lista).toHaveLength(105);
    expect(api.mock.calls.map((c) => c[0])).toEqual([
      'repos/x/commits/s/check-runs?filter=all&per_page=100&page=1',
      'repos/x/commits/s/check-runs?filter=all&per_page=100&page=2',
    ]);
    await expect(wszystkieStrony(vi.fn(async () => ({ message: 'x' })), 'repos/x/pulls/1/files')).rejects.toThrow('nie zwrócił listy');
  });

  it('źródło bramki: pobiera main i porównuje pliki bramki', () => {
    const git = vi.fn((argumenty: string[]) => (argumenty[0] === 'diff' ? '' : ''));
    expect(sprawdzZrodlo(git)).toEqual({ zgodne: true });
    expect(git.mock.calls[0][0]).toEqual(['fetch', '--quiet', 'origin', 'main']);
    expect(git.mock.calls[1][0]).toEqual(['diff', '--name-only', 'origin/main', '--', ...SCIEZKI_BRAMKI]);
    expect(SCIEZKI_BRAMKI).toContain('scripts/ops/scal-pr.sh');

    const zmieniona = vi.fn((argumenty: string[]) => (argumenty[0] === 'diff' ? 'scripts/nocny/bramka-scalenia.mjs\n' : ''));
    expect(sprawdzZrodlo(zmieniona)).toMatchObject({ zgodne: false, powod: expect.stringContaining('scripts/nocny/bramka-scalenia.mjs') });

    expect(git.mock.calls[2][0]).toEqual(['ls-files', '--others', '--exclude-standard', '--', ...SCIEZKI_BRAMKI]);
    const nowyModul = vi.fn((argumenty: string[]) => (argumenty[0] === 'ls-files' ? 'scripts/filtr/nowy.mjs\n' : ''));
    expect(sprawdzZrodlo(nowyModul)).toMatchObject({ zgodne: false, powod: expect.stringContaining('scripts/filtr/nowy.mjs') });

    const bezSieci = vi.fn(() => {
      throw new Error('fetch');
    });
    expect(sprawdzZrodlo(bezSieci)).toMatchObject({ zgodne: false, powod: expect.stringContaining('git fetch') });
  });

  it.each([
    ['https://github.com/wlasciciel/repo.git', 'wlasciciel/repo'],
    ['git@github.com:wlasciciel/repo.git', 'wlasciciel/repo'],
    ['http://local_proxy@127.0.0.1:43215/git/wlasciciel/repo', 'wlasciciel/repo'],
    ['', null],
    ['nie-adres', null],
  ])('repozytorium z adresu %s', (adres, oczekiwane) => {
    expect(repoZAdresu(adres)).toBe(oczekiwane);
  });
});

describe('glowna', () => {
  function router(stan: { pr?: Array<Obiekt | Error>; zgloszenia?: unknown[]; zdjecieScal?: 'ok' | 'blad' } = {}) {
    const odpowiedziPr = stan.pr ?? [pr()];
    let ktoryPr = 0;
    const api = vi.fn(async (sciezka: string, opcje?: { metoda?: string; pola?: Record<string, string> }) => {
      if (sciezka === `repos/${REPO}`) return { full_name: REPO };
      if (sciezka.startsWith(`repos/${REPO}/issues?`)) return stan.zgloszenia ?? [];
      if (sciezka === `repos/${REPO}/labels/nocny%3Astop`) return { name: 'nocny:stop' };
      if (sciezka === `repos/${REPO}/actions/variables/NOCNY_STOP`) return null;
      if (sciezka === `repos/${REPO}/issues/900/labels/scal` && opcje?.metoda === 'DELETE') {
        if (stan.zdjecieScal === 'blad') throw new BladApi(sciezka, 502, 'Bad Gateway');
        return [];
      }
      if (sciezka === `repos/${REPO}/pulls/900`) {
        const odpowiedz = odpowiedziPr[Math.min(ktoryPr++, odpowiedziPr.length - 1)];
        if (odpowiedz instanceof Error) throw odpowiedz;
        return odpowiedz;
      }
      if (sciezka.startsWith(`repos/${REPO}/pulls/900/files?`)) return [PLIK_TESTU, PLIK_KODU];
      if (sciezka.startsWith(`repos/${REPO}/commits/${SHA}/check-runs?`)) return { total_count: KONTROLE_WYMAGANE.length, check_runs: przebiegi() };
      if (sciezka.startsWith(`repos/${REPO}/commits/${SHA}/statuses?`)) return [];
      if (sciezka === `repos/${REPO}/rules/branches/main`) return [];
      if (sciezka === `repos/${REPO}/actions/jobs/${1000 + KONTROLE_WYMAGANE.indexOf('Test-first (agent)')}`) return { steps: kroki };
      throw new BladApi(sciezka, 404, `nieoczekiwane ${opcje?.metoda ?? 'GET'}`);
    });
    return api;
  }

  type Api = (sciezka: string, opcje?: { metoda?: string; pola?: Record<string, string> }) => Promise<unknown>;

  async function uruchom(argv: string[], api: Api, uruchomScal: (numer: number) => string = vi.fn(() => '✔ etykieta scal nadana')) {
    const wyjscie: string[] = [];
    const bledy: string[] = [];
    const czekaj = vi.fn(async () => {});
    const kod = await glowna(argv, {
      api,
      git: () => '',
      czytajCodeowners: () => '/lib/ksef/ @wlasciciel\n',
      repoDomyslne: () => REPO,
      wypisz: (tekst: string) => wyjscie.push(tekst),
      bledy: (tekst: string) => bledy.push(tekst),
      czekaj,
      uruchomScal,
    });
    return { kod, wyjscie: wyjscie.join('\n'), bledy: bledy.join('\n'), czekaj };
  }

  it('TAK bez --scal: kod 0, etykiety scal nie nadaje', async () => {
    const skrypt = vi.fn(() => '');
    const wynik = await uruchom(['900'], router(), skrypt);
    expect(wynik.kod).toBe(0);
    expect(wynik.wyjscie).toContain(`TAK: #900 spełnia warunki nocy (gałąź agent/nocny-2026-11-18-n01-lista, głowa ${SHA})`);
    expect(skrypt).not.toHaveBeenCalled();
  });

  it('TAK z --scal: woła scal-pr.sh dla tego PR i sprawdza głowę przed i po', async () => {
    const api = router();
    const skrypt = vi.fn(() => '✔ etykieta scal nadana');
    const wynik = await uruchom(['#900', '--scal'], api, skrypt);
    expect(wynik.kod).toBe(0);
    expect(skrypt).toHaveBeenCalledWith(900);
    expect(api.mock.calls.filter((c) => c[0] === `repos/${REPO}/pulls/900`)).toHaveLength(3);
    expect(wynik.wyjscie).toContain('✔ etykieta scal nadana');
    expect(wynik.wyjscie).toContain(`SCAL: #900 ma etykietę scal; kolejka scalania scali go po zielonych kontrolach (głowa ${SHA}).`);
  });

  it('NIE z --scal: scal-pr.sh nie rusza, kod 1', async () => {
    const skrypt = vi.fn(() => '');
    const wynik = await uruchom(['900', '--scal'], router({ pr: [pr({ draft: true })] }), skrypt);
    expect(wynik.kod).toBe(1);
    expect(wynik.wyjscie).toContain('NIE: #900 czeka na Bartosza.');
    expect(skrypt).not.toHaveBeenCalled();
  });

  it('scal-pr.sh odmawia: kod 1 z jego powodem', async () => {
    const skrypt = vi.fn(() => {
      throw Object.assign(new Error('exit 1'), { stderr: '✘ PR #900 ma etykietę wstrzymaj. Zdejmij ją, gdy wolno scalać. Nic nie zmieniłem.\n', stdout: '' });
    });
    const wynik = await uruchom(['900', '--scal'], router(), skrypt);
    expect(wynik.kod).toBe(1);
    expect(wynik.wyjscie).toContain('NIE: etykiety scal na #900 nie ma: scripts/ops/scal-pr.sh odmówił: ✘ PR #900 ma etykietę wstrzymaj');
  });

  it('nowy commit po ocenie: scal-pr.sh nie rusza', async () => {
    const skrypt = vi.fn(() => '');
    const zmieniony = pr({ head: { ref: 'agent/nocny-2026-11-18-n01-lista', sha: INNE_SHA, repo: { full_name: REPO } } });
    const wynik = await uruchom(['900', '--scal'], router({ pr: [pr(), zmieniony] }), skrypt);
    expect(wynik.kod).toBe(1);
    expect(skrypt).not.toHaveBeenCalled();
    expect(wynik.wyjscie).toContain('głowa PR zmieniła się po ocenie (dddddddd)');
  });

  it('nowy commit w trakcie nadawania scal: zdejmuje etykietę', async () => {
    const zmieniony = pr({ head: { ref: 'agent/nocny-2026-11-18-n01-lista', sha: INNE_SHA, repo: { full_name: REPO } } });
    const api = router({ pr: [pr(), pr(), zmieniony] });
    const wynik = await uruchom(['900', '--scal'], api, vi.fn(() => '✔ etykieta scal nadana'));
    expect(wynik.kod).toBe(1);
    expect(api).toHaveBeenCalledWith(`repos/${REPO}/issues/900/labels/scal`, { metoda: 'DELETE', dopusc404: true });
    expect(wynik.wyjscie).toContain('etykietę zdjąłem');
  });

  it('nie da się potwierdzić głowy po scal-pr.sh albo zdjąć scal: kod 2 i prośba o wstrzymaj', async () => {
    const bladOdczytu = await uruchom(['900', '--scal'], router({ pr: [pr(), pr(), new BladApi(`repos/${REPO}/pulls/900`, 502, 'Bad Gateway')] }));
    expect(bladOdczytu.kod).toBe(2);
    expect(bladOdczytu.wyjscie).toContain('UWAGA: scal nadana, ale nie mogę sprawdzić głowy PR');
    expect(bladOdczytu.wyjscie).toContain('dodaj etykietę wstrzymaj na #900');

    const zmieniony = pr({ head: { ref: 'agent/nocny-2026-11-18-n01-lista', sha: INNE_SHA, repo: { full_name: REPO } } });
    const api = router({ pr: [pr(), pr(), zmieniony], zdjecieScal: 'blad' });
    const bladZdjecia = await uruchom(['900', '--scal'], api);
    expect(bladZdjecia.kod).toBe(2);
    expect(api.mock.calls.filter((c) => c[0] === `repos/${REPO}/issues/900/labels/scal`)).toHaveLength(2);
    expect(bladZdjecia.wyjscie).toContain('a etykiety nie dało się zdjąć');
  });

  it('scal-pr.sh działa tylko na FaktWay/FaktWay', async () => {
    const api = vi.fn(async () => pr());
    await expect(oznaczDoScalenia({ api, repo: 'inny/repo', numer: 900, sha: SHA, uruchomScal: vi.fn() })).rejects.toThrow('działa tylko na FaktWay/FaktWay');
    expect(api).not.toHaveBeenCalled();
  });

  it('mergeable liczone w tle: czeka i pyta ponownie', async () => {
    const api = router({ pr: [pr({ mergeable: null, mergeable_state: 'unknown' }), pr()] });
    const wynik = await uruchom(['900'], api);
    expect(wynik.kod).toBe(0);
    expect(wynik.czekaj).toHaveBeenCalledTimes(1);
  });

  it('--json daje ocenę do odczytu przez sesję', async () => {
    const wynik = await uruchom(['900', '--json'], router());
    expect(JSON.parse(wynik.wyjscie)).toMatchObject({ wynik: 'TAK', numer: 900, sha: SHA, powody: [], scal: null, odmowa: null });
  });

  it('--wylacznik: 0 gdy wyłączony, 1 gdy włączony', async () => {
    expect((await uruchom(['--wylacznik'], router())).kod).toBe(0);
    const stop = await uruchom(['--wylacznik'], router({ zgloszenia: [{ number: 7 }] }));
    expect(stop.kod).toBe(1);
    expect(stop.wyjscie).toContain('STOP: wyłącznik włączony (otwarte zgłoszenie #7 z etykietą nocny:stop)');
  });

  it('wyłącznik włączony blokuje też etykietę scal', async () => {
    const skrypt = vi.fn(() => '');
    const wynik = await uruchom(['900', '--scal'], router({ zgloszenia: [{ number: 7 }] }), skrypt);
    expect(wynik.kod).toBe(1);
    expect(wynik.wyjscie).toContain('Wyłącznik nocnego zespołu jest włączony');
    expect(skrypt).not.toHaveBeenCalled();
  });

  it.each([[[]], [['900', '901']], [['--wylacznik', '900']], [['900', '--nieznany']], [['900', '--repo', 'zla nazwa']]])(
    'złe argumenty %j: kod 2',
    async (argv) => {
      expect((await uruchom(argv, router())).kod).toBe(2);
    },
  );

  it('błąd GitHuba: kod 2 (traktuj jak NIE)', async () => {
    const api = vi.fn(async () => {
      throw new BladApi('repos/x', 502, 'Bad Gateway');
    });
    const wynik = await uruchom(['900'], api);
    expect(wynik.kod).toBe(2);
    expect(wynik.bledy).toContain('Traktuj to jak NIE');
  });

  it('wiersz poleceń: złe użycie kończy kodem 2 bez połączenia z GitHubem', () => {
    try {
      execFileSync('node', ['scripts/nocny/bramka-scalenia.mjs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      expect.unreachable('powinno skończyć się błędem');
    } catch (blad) {
      const e = blad as { status: number; stderr: string };
      expect(e.status).toBe(2);
      expect(e.stderr).toContain('Podaj numer PR');
    }
  });
});
