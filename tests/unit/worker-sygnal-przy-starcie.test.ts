import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CRON_JOBS } from '@/lib/jobs/queues';

// G1-START (plan „zero zgubionych faktur”, sekcja 8): w kontenerze worker to
// PID 1 (CMD w formie exec, bez tini). Jądro odrzuca sygnał, dla którego PID 1
// nie ma handlera, zamiast zabić proces (man 7 pid_namespaces). `worker.ts`
// rejestrował SIGTERM dopiero na końcu `main()`, po wczytaniu modułów, starcie
// pg-boss, założeniu kolejek i cronów. Zatrzymanie w tym czasie przepadało:
// worker startował dalej, brał joby, a po czasie łaski dostawał SIGKILL
// w środku jobu.
//
// Test uruchamia prawdziwy `lib/jobs/worker.ts` i zamykanie z #577 (`stopBoss`,
// `WORKER_SHUTDOWN_BUDGET`, `trackActiveJobs`). Atrapy: pg-boss (model 12.38.2),
// paczki handlerów, Sentry, pomiar procesu i serwer healthchecku. Sygnał podaje
// `sygnalDoPid1()`: bez handlera przepada, z handlerem czeka na obrót pętli
// zdarzeń, jak w Node.

/** Wywołania pg-boss, które zapisuje atrapa. Joby biorą `work()` i `schedule()`. */
type Operacja = 'work' | 'schedule' | 'createQueue' | 'updateQueue';

const h = vi.hoisted(() => {
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  return {
    sleep,
    /** Kolejki zdarzeń z atrapy paczki handlerów, w kolejności rejestracji. */
    kolejki: ['fixture.pierwsza', 'fixture.druga', 'fixture.trzecia'],
    jobMs: 60_000,
    pg: {
      instancje: 0,
      starty: 0,
      stopy: 0,
      startMs: 1_000,
      startWisi: false,
      startPada: false,
      zapytanieMs: 50,
      /** Wywołania pg-boss po kolei (`Operacja`), z informacją, czy sygnał już poszedł. */
      operacje: [] as { co: Operacja; kolejka: string; poSygnale: boolean }[],
      /** Kolejka → id joba, który worker pobiera zaraz po `work()`. */
      jobNaStarcie: new Map<string, string>(),
      /** Po `work()` i `schedule()`: tu test wysyła sygnał w wybranym miejscu startu. */
      po: null as ((co: Operacja, kolejka: string) => void) | null,
    },
    sygnal: { wyslany: false, przyWczytywaniu: null as (() => void) | null },
    http: { listen: vi.fn(), close: vi.fn() },
    sentry: { init: vi.fn(() => false), report: vi.fn(), flush: vi.fn() },
  };
});

type Handler = (jobs: { id: string; data: object }[]) => Promise<unknown>;

vi.mock('pg-boss', () => ({
  PgBoss: class {
    private startujacy: Promise<void> | null = null;
    private zatrzymany = false;
    private zamkniety = false;
    private readonly aktywne = new Set<Promise<unknown>>();

    constructor() {
      h.pg.instancje++;
    }

    on() {}

    start() {
      if (!this.startujacy) {
        h.pg.starty++;
        this.startujacy = h.pg.startWisi
          ? new Promise<void>(() => {})
          : h.sleep(h.pg.startMs).then(() => {
              if (h.pg.startPada) throw new Error('baza odmówiła połączenia');
            });
      }
      return this.startujacy;
    }

    // pg-boss 12.38.2: stop() czeka na trwający start() (`dist/index.js:266-268`),
    // potem manager.stop() odcina nowe workery, czeka na aktywne joby do
    // `timeout` (minimum 1 s), oblewa resztę (failWip) i zamyka pulę.
    async stop(options: { timeout?: number } = {}) {
      h.pg.stopy++;
      await this.startujacy?.catch(() => {});
      this.zatrzymany = true;
      const timeout = Math.max(options.timeout ?? 30_000, 1_000);
      const od = Date.now();
      while (this.aktywne.size > 0 && Date.now() - od < timeout) await h.sleep(500);
      await h.sleep(50);
      this.zamkniety = true;
    }

    async work(kolejka: string, _opcje: unknown, handler: Handler) {
      // Zapis przed odmową: liczy się już sama próba brania jobów po sygnale.
      // pg-boss odmawia dopiero po `manager.stop()`, a ten idzie w `stop()` po awaicie.
      this.zapisz('work', kolejka);
      // `dist/manager.js:1160-1163`
      if (this.zatrzymany) throw new Error('Workers are disabled. pg-boss is stopped');
      const id = h.pg.jobNaStarcie.get(kolejka);
      if (id) {
        const job: Promise<unknown> = handler([{ id, data: {} }]).finally(() => this.aktywne.delete(job));
        this.aktywne.add(job);
      }
      h.pg.po?.('work', kolejka);
      return `worker-${kolejka}`;
    }

    // Zapis na początku: sygnał wysłany tu dociera w trakcie zapytania, jak na produkcji,
    // gdzie worker czeka wtedy na bazę.
    async schedule(kolejka: string) {
      this.zapisz('schedule', kolejka);
      h.pg.po?.('schedule', kolejka);
      await this.zapytanie();
    }

    createQueue(kolejka: string) {
      this.zapisz('createQueue', kolejka);
      return this.zapytanie();
    }

    updateQueue(kolejka: string) {
      this.zapisz('updateQueue', kolejka);
      return this.zapytanie();
    }

    unschedule() {
      return this.zapytanie();
    }

    deleteQueue() {
      return this.zapytanie();
    }

    private zapisz(co: Operacja, kolejka: string) {
      h.pg.operacje.push({ co, kolejka, poSygnale: h.sygnal.wyslany });
    }

    private async zapytanie() {
      if (this.zamkniety) throw new Error('Database connection is not opened');
      await h.sleep(h.pg.zapytanieMs);
    }
  },
}));

vi.mock('@/lib/jobs/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/jobs/config')>()),
  getJobsDatabaseUrl: () => 'postgres://fixture',
  getJobsSchema: () => 'pgboss',
}));
// Wrapper jobów (walidacja, ponowienia) ma własne testy; tu liczy się start i zamykanie.
vi.mock('@/lib/jobs/run-job', () => ({
  wrapHandler:
    (def: { handler: (data: unknown, ctx: unknown) => Promise<unknown> }) =>
    async (jobs: { data: unknown }[]) => {
      for (const job of jobs) await def.handler(job.data, {});
      return [];
    },
}));
vi.mock('@/lib/jobs/sentry', () => ({
  initWorkerSentry: h.sentry.init,
  reportWorkerStartupFailure: h.sentry.report,
  flushWorkerSentry: h.sentry.flush,
}));
vi.mock('@/lib/observability/process-metrics', () => ({ startProcessMetrics: vi.fn() }));
vi.mock('@/lib/supabase/fetch-timeout', () => ({ enableWorkerSupabaseTimeouts: vi.fn() }));
vi.mock('node:http', () => ({ createServer: () => ({ listen: h.http.listen, close: h.http.close }) }));

// Paczki handlerów z `worker.ts` (lista pilnowana testem niżej). Te bez skutków przy
// wczytaniu są tu; dwie ze skutkami podpina `atrapyPaczekZeSkutkami()`.
const ATRAPY_PACZEK = [
  'package-a',
  'package-b',
  'package-c',
  'package-d',
  'flo-tick',
  'ops-heartbeat',
  'webhooks',
  'app-notifications',
];
vi.mock('@/lib/jobs/handlers/package-b', () => ({}));
vi.mock('@/lib/jobs/handlers/package-d', () => ({}));
vi.mock('@/lib/jobs/handlers/flo-tick', () => ({}));
vi.mock('@/lib/jobs/handlers/ops-heartbeat', () => ({}));
vi.mock('@/lib/jobs/handlers/webhooks', () => ({}));
vi.mock('@/lib/jobs/handlers/app-notifications', () => ({}));

/**
 * Paczki, które coś robią przy wczytaniu: rejestrują kolejki w świeżym rejestrze
 * i wysyłają sygnał w połowie wczytywania. Vitest nie woła ponownie fabryki
 * `vi.mock` po `vi.resetModules()`, więc podpinamy je przed każdym testem.
 */
function atrapyPaczekZeSkutkami() {
  vi.doMock('@/lib/jobs/handlers/package-a', async () => {
    const { registerJob } = await import('@/lib/jobs/registry');
    for (const queue of h.kolejki) registerJob({ queue, handler: () => h.sleep(h.jobMs) });
    for (const queue of CRONY) registerJob({ queue, handler: async () => null });
    return {};
  });
  vi.doMock('@/lib/jobs/handlers/package-c', () => {
    // W połowie wczytywania paczek handlerów. Na produkcji tsx kompiluje cały graf
    // modułów przy każdym starcie kontenera, więc to okno trwa sekundy.
    h.sygnal.przyWczytywaniu?.();
    return {};
  });
}

/** `flushWorkerSentry()` po `stopBoss()` w `worker.ts` (domyślne 2000 ms, `lib/jobs/sentry.ts`). */
const FLUSH_SENTRY_MS = 2_000;
/** Na `process.exit` i spóźnione timery zostawiamy sekundę (jak `stopboss-czas-laski.test.ts`). */
const ZAPAS_NA_WYJSCIE_MS = 1_000;
/** Dłużej niż start atrapy i cały czas łaski: po tym czasie wynik jest przesądzony. */
const DO_ROZSTRZYGNIECIA_MS = 15_000;

/**
 * Crony, które rejestruje atrapa: pierwszy i ostatni z `CRON_JOBS`. Przy ostatnim
 * pętla cronów się kończy, więc sygnał w jego trakcie łapie dopiero sprawdzenie
 * przed healthcheckiem.
 */
const CRONY = [CRON_JOBS[0]!.queue, CRON_JOBS.at(-1)!.queue];

type Sygnal = 'SIGTERM' | 'SIGINT';
type Sluchacz = (signal: NodeJS.Signals) => void;

let obce: Record<Sygnal, Set<Sluchacz>>;
let zgubione: Sygnal[];
let pierwszySygnalO: number | null;
let wyjscia: { kod: number; o: number }[];

const sluchacze = (sygnal: Sygnal) => process.listeners(sygnal) as Sluchacz[];
/** Słuchacze dodani w teście: Vitest ma w tym procesie własnych. */
const nasze = (sygnal: Sygnal) => sluchacze(sygnal).filter((sluchacz) => !obce[sygnal].has(sluchacz));

/**
 * Docker wysyła sygnał do PID 1 kontenera. Bez handlera jądro go odrzuca, więc
 * przepada. Z handlerem libuv zapisuje go do potoku sygnałów, a Node woła
 * słuchaczy JS w fazie poll pętli zdarzeń, nigdy w środku synchronicznego kodu,
 * np. wczytywania modułów. Zwykle to najbliższa faza poll, przed `setImmediate`
 * zaplanowanym w tym samym kodzie.
 *
 * `obrotPozniej`: kod wykonał się w fazie poll (tak bywa z wejściem, które loader
 * wczytuje asynchronicznie). Ta faza poll ma już swoją porcję zdarzeń, więc
 * słuchacz dostaje sygnał dopiero w fazie poll następnego obrotu, po pierwszym
 * `setImmediate`.
 */
function sygnalDoPid1(sygnal: Sygnal, { obrotPozniej = false } = {}) {
  h.sygnal.wyslany = true;
  pierwszySygnalO ??= Date.now();
  if (nasze(sygnal).length === 0) {
    zgubione.push(sygnal);
    return;
  }
  const dostarcz = () => {
    for (const sluchacz of nasze(sygnal)) sluchacz(sygnal);
  };
  setImmediate(obrotPozniej ? () => setImmediate(dostarcz) : dostarcz);
}

const czekaj = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const kolejkiZWork = () => h.pg.operacje.filter((o) => o.co === 'work').map((o) => o.kolejka);
const planowaneCrony = () => h.pg.operacje.filter((o) => o.co === 'schedule').map((o) => o.kolejka);
const bledy = () => vi.mocked(console.error).mock.calls.map((c) => String(c[0])).join('\n');
const ostrzezenia = () => vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));

async function uruchomWorker() {
  await import('@/lib/jobs/worker');
}

/** Zamknięcie po sygnale: kod 0 przed czasem łaski, bez brania jobów po sygnale i bez fałszywej awarii startu. */
async function oczekujZamknieciaWBudzecie() {
  const { WORKER_SHUTDOWN_BUDGET: budzet, getBoss } = await import('@/lib/jobs/boss');
  expect(zgubione, 'sygnał przepadł: proces nie miał jeszcze handlera').toEqual([]);
  expect(wyjscia.length, 'proces nie wyszedł sam: po czasie łaski dostałby SIGKILL').toBeGreaterThan(0);
  expect(wyjscia.map((w) => w.kod)).toEqual(wyjscia.map(() => 0));
  expect(wyjscia[0]!.o - pierwszySygnalO!).toBeLessThanOrEqual(budzet.containerGraceMs - ZAPAS_NA_WYJSCIE_MS);
  // Krok zaczęty, zanim sygnał dotarł do procesu (np. zakładanie kolejki), może
  // się skończyć. Nowego `work()` ani `schedule()` po sygnale już nie ma.
  expect(
    h.pg.operacje.filter((o) => (o.co === 'work' || o.co === 'schedule') && o.poSygnale),
    'po sygnale worker wołał work() albo schedule(): zamykany proces brałby joby',
  ).toEqual([]);
  expect(() => getBoss()).toThrow(/zamyka/);
  expect(h.sentry.report).not.toHaveBeenCalled();
  expect(bledy()).not.toContain('Worker padł przy starcie');
}

describe('worker w procesie (atrapy pg-boss i paczek)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    atrapyPaczekZeSkutkami();
    vi.useFakeTimers();
    vi.stubEnv('JOBS_BACKEND', 'pgboss');
    vi.stubEnv('WORKER_DISABLE_SCHEDULES', '');
    vi.stubEnv('WORKER_ONLY_CRONS', '');
    Object.assign(h.pg, {
      instancje: 0,
      starty: 0,
      stopy: 0,
      startMs: 1_000,
      startWisi: false,
      startPada: false,
      zapytanieMs: 50,
      operacje: [],
      po: null,
    });
    h.pg.jobNaStarcie.clear();
    Object.assign(h.sygnal, { wyslany: false, przyWczytywaniu: null });
    h.sentry.flush.mockImplementation(() => h.sleep(FLUSH_SENTRY_MS));
    obce = { SIGTERM: new Set(sluchacze('SIGTERM')), SIGINT: new Set(sluchacze('SIGINT')) };
    zgubione = [];
    pierwszySygnalO = null;
    wyjscia = [];
    vi.spyOn(process, 'exit').mockImplementation(((kod?: number) => {
      wyjscia.push({ kod: kod ?? 0, o: Date.now() });
    }) as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const sygnal of ['SIGTERM', 'SIGINT'] as const) {
      for (const sluchacz of nasze(sygnal)) process.removeListener(sygnal, sluchacz);
    }
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('sygnał w trakcie startu (G1-START)', () => {
    it.each(['SIGTERM', 'SIGINT'] as const)(
      '%s w trakcie wczytywania modułów: dociera, worker nie łączy się z bazą i wychodzi kodem 0',
      async (sygnal) => {
        h.sygnal.przyWczytywaniu = () => sygnalDoPid1(sygnal);

        await uruchomWorker();
        await czekaj(DO_ROZSTRZYGNIECIA_MS);

        await oczekujZamknieciaWBudzecie();
        expect(h.pg.instancje).toBe(0);
        expect(h.pg.operacje).toEqual([]);
        expect(h.http.listen).not.toHaveBeenCalled();
      },
    );

    it('sygnał z wczytywania, gdy wejście wykonało się w fazie poll (słuchacz obrót pętli później): worker nie łączy się z bazą', async () => {
      h.sygnal.przyWczytywaniu = () => sygnalDoPid1('SIGTERM', { obrotPozniej: true });

      await uruchomWorker();
      await czekaj(DO_ROZSTRZYGNIECIA_MS);

      await oczekujZamknieciaWBudzecie();
      expect(h.pg.instancje, 'worker zaczął start pg-boss, zanim sygnał z wczytywania dotarł do zamykania').toBe(0);
      expect(h.pg.operacje).toEqual([]);
      expect(h.http.listen).not.toHaveBeenCalled();
    });

    it('w trakcie startu pg-boss: zamyka instancję po starcie, bez kolejek i healthchecku', async () => {
      await uruchomWorker();
      await czekaj(h.pg.startMs / 2);
      expect(h.pg.starty).toBe(1);

      sygnalDoPid1('SIGTERM');
      await czekaj(DO_ROZSTRZYGNIECIA_MS);

      await oczekujZamknieciaWBudzecie();
      expect(h.pg.stopy).toBe(1);
      expect(h.pg.instancje).toBe(1);
      expect(h.pg.operacje).toEqual([]);
      expect(h.http.listen).not.toHaveBeenCalled();
    });

    it('baza nie odpowiada przy starcie: zamykanie i tak kończy się przed czasem łaski', async () => {
      h.pg.startWisi = true;
      await uruchomWorker();
      await czekaj(500);

      sygnalDoPid1('SIGTERM');
      await czekaj(DO_ROZSTRZYGNIECIA_MS);

      await oczekujZamknieciaWBudzecie();
      expect(h.pg.operacje).toEqual([]);
      expect(h.http.listen).not.toHaveBeenCalled();
    });

    it('po części kolejek, z jobem w toku: bez następnych kolejek, job dostaje czas z budżetu i trafia do logu przerwanych', async () => {
      const [pierwsza, druga] = h.kolejki;
      h.pg.jobNaStarcie.set(pierwsza!, 'job-w-toku-0001');
      h.pg.po = (co, kolejka) => {
        if (co === 'work' && kolejka === druga) sygnalDoPid1('SIGTERM');
      };

      await uruchomWorker();
      await czekaj(DO_ROZSTRZYGNIECIA_MS);

      await oczekujZamknieciaWBudzecie();
      expect(kolejkiZWork()).toEqual([pierwsza, druga]);
      expect(planowaneCrony()).toEqual([]);
      expect(h.pg.stopy).toBe(1);
      expect(h.http.listen).not.toHaveBeenCalled();
      const przerwany = ostrzezenia().find((linia) => linia.includes('job-w-toku-0001'));
      expect(przerwany).toMatch(/przerwan/);
      expect(przerwany).toContain(pierwsza);
    });

    it.each([
      ['pierwszego', 1],
      ['ostatniego', 2],
    ] as const)('w trakcie planowania %s cronu: bez następnych cronów i bez healthchecku', async (_ktory, ile) => {
      h.pg.po = (co, kolejka) => {
        if (co === 'schedule' && kolejka === CRONY[ile - 1]) sygnalDoPid1('SIGTERM');
      };

      await uruchomWorker();
      await czekaj(DO_ROZSTRZYGNIECIA_MS);

      await oczekujZamknieciaWBudzecie();
      expect(planowaneCrony()).toEqual(CRONY.slice(0, ile));
      expect(h.pg.stopy).toBe(1);
      expect(h.http.listen).not.toHaveBeenCalled();
    });

    it('drugi SIGTERM w trakcie zamykania: to samo zamykanie, jeden stop() pg-boss', async () => {
      const [pierwsza, druga] = h.kolejki;
      h.pg.jobNaStarcie.set(pierwsza!, 'job-w-toku-0002');
      h.pg.po = (co, kolejka) => {
        if (co === 'work' && kolejka === druga) sygnalDoPid1('SIGTERM');
      };

      await uruchomWorker();
      await czekaj(h.pg.startMs + 1_000);
      sygnalDoPid1('SIGTERM');
      await czekaj(DO_ROZSTRZYGNIECIA_MS);

      await oczekujZamknieciaWBudzecie();
      expect(h.pg.stopy).toBe(1);
    });
  });

  describe('start i zatrzymanie bez wyścigu (kontrola)', () => {
    it('bez sygnału: wszystkie kolejki, crony i healthcheck, proces działa dalej', async () => {
      await uruchomWorker();
      await czekaj(DO_ROZSTRZYGNIECIA_MS);

      expect(kolejkiZWork()).toEqual([...h.kolejki, ...CRONY, 'jobs.smoke']);
      expect(planowaneCrony()).toEqual(CRONY);
      expect(h.http.listen).toHaveBeenCalledTimes(1);
      expect(wyjscia).toEqual([]);
      expect(h.pg.stopy).toBe(0);
    });

    it('SIGTERM po pełnym starcie: zamyka healthcheck i pg-boss, kod 0 przed czasem łaski', async () => {
      await uruchomWorker();
      await czekaj(DO_ROZSTRZYGNIECIA_MS);
      expect(h.http.listen).toHaveBeenCalledTimes(1);

      sygnalDoPid1('SIGTERM');
      await czekaj(DO_ROZSTRZYGNIECIA_MS);

      await oczekujZamknieciaWBudzecie();
      expect(h.http.close).toHaveBeenCalled();
      expect(h.pg.stopy).toBe(1);
    });

    it('prawdziwa awaria startu bez sygnału: alarm w Sentry i kod 1', async () => {
      h.pg.startPada = true;

      await uruchomWorker();
      await czekaj(DO_ROZSTRZYGNIECIA_MS);

      expect(h.sentry.report).toHaveBeenCalledTimes(1);
      expect(bledy()).toContain('Worker padł przy starcie');
      expect(wyjscia.map((w) => w.kod)).toEqual([1]);
      expect(h.pg.operacje).toEqual([]);
    });
  });
});

describe('worker.ts: kolejność, której atrapy nie widzą (G1-START)', () => {
  const worker = readFileSync(join(process.cwd(), 'lib/jobs/worker.ts'), 'utf8');
  const MODUL_SYGNALOW = join(process.cwd(), 'lib/jobs/shutdown-signals.ts');

  it('moduł sygnałów jest pierwszym importem workera i sam niczego nie importuje', () => {
    // W Vitest pg-boss, Sentry i paczki handlerów to atrapy, które wczytują się od
    // razu. W kontenerze te moduły to sekundy, a sygnał z tego czasu łapie tylko
    // handler zarejestrowany przed nimi.
    expect(worker.match(/^import .+$/m)?.[0]).toMatch(/ from '\.\/shutdown-signals';$/);
    expect(existsSync(MODUL_SYGNALOW)).toBe(true);
    const modul = readFileSync(MODUL_SYGNALOW, 'utf8');
    expect(modul).not.toMatch(/^\s*import\s/m);
    expect(modul).not.toMatch(/\brequire\(/);
  });

  it('atrapy obejmują wszystkie paczki handlerów z worker.ts', () => {
    const paczki = [...worker.matchAll(/^import '\.\/handlers\/([\w-]+)';$/gm)].map((m) => m[1]);
    expect(paczki).toEqual(ATRAPY_PACZEK);
  });
});

// Prawdziwy Node z flagami z CMD w Dockerfile. Sygnałów POSIX nie da się wysłać
// na Windowsie (tam kill to TerminateProcess), więc te testy biegną w CI na Linuksie.
// Proces nie jest tu PID 1: bez handlera SIGTERM zabiłby go od razu (kod null),
// z handlerem kończy się sam, kodem 0.
const dockerfile = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');
const etapWorker = dockerfile.split(/^FROM /m).find((etap) => /^\S+ AS worker\b/.test(etap));
const cmd: string[] = JSON.parse(etapWorker?.match(/^CMD (\[.*\])$/m)?.[1] ?? '[]');
const WEJSCIE = 'lib/jobs/worker.ts';
/** Wejście wczytywane jak `worker.ts`, które w trakcie wczytywania wysyła sobie SIGTERM. */
const SONDA_SYGNALU = 'tests/fixtures/worker-sygnal-sonda.ts';
/** Czas łaski z karty G1 (`WORKER_SHUTDOWN_BUDGET.containerGraceMs`, pilnuje `stopboss-czas-laski.test.ts`). */
const CZAS_LASKI_MS = 10_000;
/** Proces jak w obrazie workera: NODE_ENV=production, bez NODE_OPTIONS z Vitest. */
const ENV_OBRAZU = { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'production' };

describe.skipIf(process.platform === 'win32')('prawdziwy Node z flagami z Dockerfile (G1-START)', () => {
  it('sonda: sygnał z czasu wczytywania wejścia dociera do zamykania przed bramką receiveQueuedSignals()', () => {
    expect(cmd.at(-1)).toBe(WEJSCIE);
    const wynik = spawnSync(process.execPath, [...cmd.slice(1, -1), SONDA_SYGNALU], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: ENV_OBRAZU,
      timeout: 170_000,
      // Sonda ma handler SIGTERM, więc domyślny sygnał po limicie czasu by jej nie zakończył.
      killSignal: 'SIGKILL',
    });
    const wyjscie = `${wynik.stdout}${wynik.stderr}`;
    expect({ status: wynik.status, signal: wynik.signal }, wyjscie).toEqual({ status: 0, signal: null });
    const linia = wynik.stdout.trim().split('\n').at(-1) ?? '';
    expect(linia, wyjscie).toMatch(/^\{.*\}$/);
    const pomiar = JSON.parse(linia) as Record<string, unknown>;
    // Do logu CI: czy na tym Node i tsx wejście wykonało się w fazie poll, czyli
    // czy jeden obrót pętli by nie wystarczył (bramka czeka dwa, `shutdown-signals.ts`).
    console.info(
      `G1-START, sonda na Node ${process.version}: po pierwszym obrocie pętli sygnał ${
        pomiar.poJednymObrocie ? 'już był' : 'jeszcze nie dotarł (wejście w fazie poll)'
      }`,
    );
    expect(pomiar).toMatchObject({ przedPetla: null, poBramce: 'SIGTERM', shutdownRequested: true });
  }, 180_000);

  it('SIGTERM, gdy start pg-boss czeka na milczącą bazę: twardy limit zamykania i kod 0 przed czasem łaski', async () => {
    const polaczenia: Socket[] = [];
    let polaczyl: () => void = () => {};
    const pierwszePolaczenie = new Promise<void>((resolve) => {
      polaczyl = () => resolve();
    });
    // Baza przyjmuje połączenie i milczy, więc start pg-boss wisi.
    const baza = createTcpServer((socket) => {
      polaczenia.push(socket);
      polaczyl();
    });
    await new Promise<void>((resolve) => baza.listen(0, '127.0.0.1', resolve));
    const { port } = baza.address() as AddressInfo;

    const worker = spawn(process.execPath, cmd.slice(1), {
      cwd: process.cwd(),
      env: {
        ...ENV_OBRAZU,
        JOBS_BACKEND: 'pgboss',
        JOBS_PGBOSS_SCHEMA: '',
        WORKER_ONLY_CRONS: '',
        WORKER_DISABLE_SCHEDULES: '',
        SENTRY_DSN: '',
        DATABASE_URL: `postgres://worker@127.0.0.1:${port}/faktway`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let wyjscie = '';
    const dopisz = (kawalek: Buffer) => {
      wyjscie += kawalek.toString('utf8');
    };
    worker.stdout.on('data', dopisz);
    worker.stderr.on('data', dopisz);
    const koniec = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      worker.on('exit', (code, signal) => resolve({ code, signal }));
    });

    try {
      // Z bazą łączy się dopiero start pg-boss, po bramce sygnałów w `main()`.
      // SIGTERM trafia więc zawsze w ten sam stan: start czeka na milczącą bazę,
      // a `stop()` pg-boss czeka na start, aż utnie go twardy limit z #577.
      const przedPolaczeniem = await Promise.race([pierwszePolaczenie.then(() => null), koniec]);
      expect(przedPolaczeniem, `worker skończył się, zanim połączył się z bazą:\n${wyjscie}`).toBeNull();

      const wyslanyO = Date.now();
      worker.kill('SIGTERM');
      const wynik = await Promise.race([
        koniec,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 30_000)),
      ]);
      const czasMs = Date.now() - wyslanyO;

      expect(wynik, `worker nie wyszedł w 30 s po SIGTERM:\n${wyjscie}`).not.toBeNull();
      expect(wynik, wyjscie).toEqual({ code: 0, signal: null });
      expect(czasMs, wyjscie).toBeLessThan(CZAS_LASKI_MS);
      expect(wyjscie).toContain('SIGTERM — graceful shutdown');
      expect(wyjscie).toMatch(/pg-boss nie zamknął się w \d+ s/);
      expect(wyjscie).not.toContain('Worker padł przy starcie');
    } finally {
      worker.kill('SIGKILL');
      for (const socket of polaczenia) socket.destroy();
      baza.close();
    }
  }, 180_000);
});
