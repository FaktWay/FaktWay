import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';

import { S3Client } from '@aws-sdk/client-s3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';
import { setStorageTimeoutsForTests, type StorageTimeouts } from '@/lib/storage/s3-timeouts';

/**
 * LIM-05, wyłącznik retencji (`cron.retention-delete`): pierwszy limit czasu
 * magazynu plików (`StorageTimeoutError`) kończy usuwanie plików w przebiegu.
 * Do tej zmiany pętla łapała błąd plików każdej faktury osobno i szła dalej,
 * więc przy zawieszonym magazynie każda faktura czekała pełny limit workera
 * (do 3 × 60 s na wywołanie magazynu), a paczka 100 faktur trzymała worker
 * ok. 2 h 15 min.
 *
 * Prawdziwa ścieżka: runner, `collectInvoiceStorageKeys` i
 * `deleteInvoiceStorage` (`lib/retention/invoice-files.ts`), listowanie prób
 * wysyłki (`lib/storage/r2.ts`), prawdziwy `S3Client` magazynu i archiwum
 * z limitami w setnych sekundy i prawdziwe gniazda do atrapy magazynu na pętli
 * zwrotnej (`node:net`), jak w `storage-limit-czasu.test.ts`. Atrapy tylko dla
 * bazy (`createAdminClient`, wpis audytu) i Sentry. Rozpoznanie limitu po
 * `name` i `code` sprawdza osobny blok z atrapą `send` klienta.
 */

type Row = Record<string, unknown>;

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
/** Limity procesu w setnych sekundy, żeby milczący magazyn nie trzymał testu. */
const MALE: StorageTimeouts = { connectMs: 200, responseMs: 300, idleMs: 1_000, maxAttempts: 2 };
/** Jedno wywołanie do milczącego magazynu: wszystkie próby po limicie odpowiedzi. */
const JEDNO_WYWOLANIE_MS = MALE.maxAttempts * MALE.responseMs;
const TEST_TIMEOUT_MS = 30_000;

const m = vi.hoisted(() => ({
  tabele: {} as Record<string, Array<Record<string, unknown>>>,
  usunieteWiersze: [] as unknown[],
  /** Faktury, których wiersza baza nie da usunąć (DELETE zwraca błąd, wiersz zostaje). */
  bledyUsuniecia: new Set<unknown>(),
  dziennik: [] as Array<{ action: string; entityId: string }>,
  sentry: [] as Array<{ message: string; context?: { level?: string; tags?: Record<string, unknown>; extra?: Record<string, unknown> } }>,
}));

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn((message: string, context?: (typeof m.sentry)[number]['context']) => {
    m.sentry.push({ message, context });
  }),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));
vi.mock('@/lib/audit/log-system', () => ({
  logAuditSystem: async (e: { action: string; entityId: string }) => {
    m.dziennik.push({ action: e.action, entityId: e.entityId });
  },
}));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const predicates: Array<(r: Row) => boolean> = [];
      let tryb: 'select' | 'update' | 'delete' = 'select';
      let patch: Row = {};
      let limit = Infinity;
      const q = {
        select: () => q,
        update: (p: Row) => {
          tryb = 'update';
          patch = p;
          return q;
        },
        delete: () => {
          tryb = 'delete';
          return q;
        },
        not: (k: string) => {
          predicates.push((r) => r[k] != null);
          return q;
        },
        lt: (k: string, v: string) => {
          predicates.push((r) => r[k] != null && Date.parse(String(r[k])) < Date.parse(v));
          return q;
        },
        gt: (k: string, v: string) => {
          predicates.push((r) => String(r[k]) > v);
          return q;
        },
        eq: (k: string, v: unknown) => {
          predicates.push((r) => r[k] === v);
          return q;
        },
        in: (k: string, v: unknown[]) => {
          predicates.push((r) => v.includes(r[k]));
          return q;
        },
        order: () => q,
        limit: (n: number) => {
          limit = n;
          return q;
        },
        then: (ok: (v: unknown) => unknown) => {
          const wiersze = m.tabele[table] ?? [];
          const trafione = wiersze.filter((r) => predicates.every((p) => p(r)));
          if (tryb === 'delete') {
            if (table === 'invoices' && trafione.some((r) => m.bledyUsuniecia.has(r.id))) {
              return Promise.resolve({ data: null, error: { message: 'baza nie dała usunąć wiersza' } }).then(ok);
            }
            const usuwane = new Set(trafione.map((r) => r.id));
            if (table === 'invoices') m.usunieteWiersze.push(...usuwane);
            m.tabele[table] = wiersze.filter((r) => !usuwane.has(r.id));
            return Promise.resolve({ data: null, error: null }).then(ok);
          }
          if (tryb === 'update') {
            for (const r of trafione) Object.assign(r, patch);
            return Promise.resolve({ data: null, error: null }).then(ok);
          }
          return Promise.resolve({ data: trafione.slice(0, limit).map((r) => ({ ...r })), error: null }).then(ok);
        },
      };
      return q;
    },
  }),
}));

import { runRetentionDelete } from '@/lib/jobs/runners/retention-delete';

type Zadanie = { metoda: string; sciezka: string; host: string };
type Zachowanie = 'odpowiada' | 'milczy' | 'zrywa';

/**
 * Atrapa magazynu: listowanie prób (`ListObjectsV2`) dostaje pustą listę,
 * usunięcie obiektu 204. `zachowanie` decyduje po żądaniu: odpowiada, milczy
 * (przyjmuje połączenie i nic nie wysyła) albo zrywa połączenie.
 */
const atrapa = {
  serwer: null as Server | null,
  port: 0,
  zadania: [] as Zadanie[],
  gniazda: new Set<Socket>(),
  zachowanie: (_zadanie: Zadanie): Zachowanie => 'odpowiada',
};

const PUSTA_LISTA =
  '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
  '<Name>faktury</Name><KeyCount>0</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>';

function odpowiedz(socket: Socket, zadanie: Zadanie): void {
  const zachowanie = atrapa.zachowanie(zadanie);
  if (zachowanie === 'milczy') return;
  if (zachowanie === 'zrywa') {
    socket.destroy();
    return;
  }
  if (zadanie.metoda === 'DELETE') {
    socket.end('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n');
    return;
  }
  if (zadanie.metoda === 'GET' && zadanie.sciezka.includes('list-type=2')) {
    socket.end(
      `HTTP/1.1 200 OK\r\nContent-Type: application/xml\r\nContent-Length: ${Buffer.byteLength(PUSTA_LISTA)}\r\nConnection: close\r\n\r\n${PUSTA_LISTA}`,
    );
    return;
  }
  socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
}

beforeAll(async () => {
  const serwer = createServer((socket) => {
    atrapa.gniazda.add(socket);
    socket.on('close', () => atrapa.gniazda.delete(socket));
    // Klient po limicie zrywa połączenie; to oczekiwane.
    socket.on('error', () => {});
    let bufor = Buffer.alloc(0);
    let przyjete = false;
    socket.on('data', (chunk: Buffer) => {
      if (przyjete) return;
      bufor = Buffer.concat([bufor, chunk]);
      const koniecNaglowkow = bufor.indexOf('\r\n\r\n');
      if (koniecNaglowkow === -1) return;
      przyjete = true;
      const [linia = '', ...linie] = bufor.subarray(0, koniecNaglowkow).toString('latin1').split('\r\n');
      const [metoda = '', sciezka = ''] = linia.split(' ');
      const host = linie.find((naglowek) => naglowek.toLowerCase().startsWith('host:'))?.slice(5).trim() ?? '';
      const zadanie: Zadanie = { metoda, sciezka, host };
      atrapa.zadania.push(zadanie);
      odpowiedz(socket, zadanie);
    });
  });
  atrapa.serwer = serwer;
  await new Promise<void>((resolve) => serwer.listen(0, '127.0.0.1', resolve));
  atrapa.port = (serwer.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const socket of atrapa.gniazda) socket.destroy();
  const serwer = atrapa.serwer;
  if (serwer) await new Promise<void>((resolve) => serwer.close(() => resolve()));
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const ctx = {
  attempt: 0,
  logger,
  step: { run: async (_n: string, fn: () => unknown) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
} as unknown as JobContext;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const faktura = (n: number, z: Row = {}): Row => ({
  id: id(n),
  tenant_id: T,
  internal_number: `FV/${n}/2016`,
  issue_date: '2016-01-15',
  xml_storage_path: `${T}/2016/01/${id(n)}.xml`,
  pdf_storage_path: `${T}/2016/01/${id(n)}.pdf`,
  archive_storage_path: null,
  parent_invoice_id: null,
  scheduled_deletion_at: '2026-01-01T00:00:00.000Z',
  ksef_status: 'draft',
  submitted_to_ksef_at: null,
  offline_idempotency_key: null,
  ...z,
});
const faktury = (...numery: number[]) => numery.map((n) => faktura(n));
const zadaniaFaktury = (n: number) => atrapa.zadania.filter((zadanie) => zadanie.sciezka.includes(id(n)));
/** Archiwum Glacier ma swój kubeł; adres z IP, więc kubeł jest w ścieżce (albo w nazwie hosta). */
const doArchiwum = (zadanie: Zadanie) => zadanie.sciezka.startsWith('/archiwum/') || zadanie.host.startsWith('archiwum.');
const zostaly = () => (m.tabele.invoices ?? []).map((r) => r.id);
const wykonane = () => m.dziennik.filter((d) => d.action === 'retention.deletion_executed').map((d) => d.entityId);

async function zmierzPrzebieg(): Promise<{ wynik: unknown; ms: number }> {
  const start = performance.now();
  const wynik = await runRetentionDelete(ctx);
  return { wynik, ms: Math.round(performance.now() - start) };
}

beforeEach(() => {
  vi.clearAllMocks();
  atrapa.zadania = [];
  atrapa.zachowanie = () => 'odpowiada';
  m.usunieteWiersze = [];
  m.bledyUsuniecia = new Set();
  m.dziennik = [];
  m.sentry = [];
  m.tabele = {
    invoices: [],
    expenses: [],
    payments: [],
    payment_imports: [],
    xml_documents: [],
    upo_receipts: [],
    payment_reminders: [],
  };
  vi.stubEnv('R2_ACCOUNT_ID', 'konto-testowe');
  vi.stubEnv('R2_ACCESS_KEY_ID', 'klucz-testowy');
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 's'.repeat(40));
  vi.stubEnv('R2_BUCKET_NAME', 'faktury');
  vi.stubEnv('R2_ENDPOINT', `http://127.0.0.1:${atrapa.port}`);
  vi.stubEnv('R2_FORCE_PATH_STYLE', 'true');
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'klucz-archiwum');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 's'.repeat(40));
  vi.stubEnv('AWS_REGION', 'eu-central-1');
  vi.stubEnv('AWS_ARCHIVE_BUCKET', 'archiwum');
  // Klient archiwum nie ma własnego adresu; SDK bierze go z tej zmiennej.
  vi.stubEnv('AWS_ENDPOINT_URL_S3', `http://127.0.0.1:${atrapa.port}`);
  // Nowy obiekt limitów to nowy klient magazynu i archiwum (pełna pula ponowień) w każdym teście.
  setStorageTimeoutsForTests({ ...MALE });
});

afterEach(() => {
  setStorageTimeoutsForTests(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('LIM-05: wyłącznik retencji po limicie czasu magazynu plików', () => {
  it('magazyn milczy przy pierwszej fakturze: następne nie dotykają magazynu, wiersze zostają, wynik mówi, ile czeka', { timeout: TEST_TIMEOUT_MS }, async () => {
    m.tabele.invoices = faktury(1, 2, 3, 4, 5);
    atrapa.zachowanie = (zadanie) => (zadanie.sciezka.includes(id(1)) ? 'milczy' : 'odpowiada');

    const { wynik, ms } = await zmierzPrzebieg();

    for (const n of [2, 3, 4, 5]) {
      expect(zadaniaFaktury(n).map((z) => z.metoda), `faktura ${n}: żądania do magazynu (przebieg ${ms} ms)`).toEqual([]);
    }
    // Jedno wywołanie z limitem: listowanie prób wysyłki pierwszej faktury, wszystkie próby.
    expect(atrapa.zadania.map((z) => z.metoda), `przebieg ${ms} ms`).toEqual(Array(MALE.maxAttempts).fill('GET'));
    expect(zadaniaFaktury(1)).toHaveLength(MALE.maxAttempts);
    expect(m.usunieteWiersze).toEqual([]);
    expect(zostaly()).toEqual([1, 2, 3, 4, 5].map(id));
    expect(wykonane()).toEqual([]);
    expect(wynik).toEqual({ deleted: 0, pending: 5, postponed: 0, storageTimeoutSkipped: 4 });
  });

  it('operator widzi w logu workera i w Sentry, ile faktur czeka i że następny przebieg ponowi; bez kluczy plików', { timeout: TEST_TIMEOUT_MS }, async () => {
    m.tabele.invoices = faktury(1, 2, 3, 4, 5);
    atrapa.zachowanie = (zadanie) => (zadanie.sciezka.includes(id(1)) ? 'milczy' : 'odpowiada');

    await runRetentionDelete(ctx);

    expect(m.sentry).toEqual([
      {
        message: 'Retencja: magazyn plików nie odpowiedział w limicie czasu, faktury czekają na następny przebieg',
        context: {
          level: 'error',
          tags: { job: 'retention-delete' },
          extra: { skipped: 4, pending: 5, deleted: 0, operation: 'ListObjectsV2', attempts: MALE.maxAttempts, attempt: 0 },
        },
      },
    ]);
    const wpisy = logger.error.mock.calls.filter(([tresc]) => String(tresc).includes('Wyłącznik'));
    expect(wpisy).toHaveLength(1);
    const [tresc, dodatki] = wpisy[0]!;
    expect(tresc).toBe(
      `Retencja: magazyn plików nie odpowiedział w limicie czasu (ListObjectsV2, prób: ${MALE.maxAttempts}). ` +
        'Wyłącznik: pominięte faktury: 4, czeka razem: 5; wiersze zostają, następny przebieg ponowi',
    );
    expect(dodatki).toEqual({ invoiceId: id(1), skipped: 4, pending: 5, deleted: 0, operation: 'ListObjectsV2', attempts: MALE.maxAttempts, attempt: 0 });
    // Klucz pliku zaczyna się od katalogu firmy; nie ma go ani w logu, ani w Sentry.
    expect(JSON.stringify([logger.error.mock.calls, logger.warn.mock.calls, logger.info.mock.calls, m.sentry])).not.toContain(`${T}/`);
  });

  it('zawieszony magazyn (milczy na każde żądanie): jedno wywołanie z limitem na przebieg zamiast jednego na fakturę', { timeout: TEST_TIMEOUT_MS }, async () => {
    const N = 10;
    m.tabele.invoices = Array.from({ length: N }, (_, i) => faktura(i + 1));
    atrapa.zachowanie = () => 'milczy';

    const { wynik, ms } = await zmierzPrzebieg();

    expect(atrapa.zadania, `przebieg ${ms} ms, żądań ${atrapa.zadania.length}`).toHaveLength(MALE.maxAttempts);
    // Bez wyłącznika N wywołań po limicie (ok. N × 0,6 s), z wyłącznikiem jedno (ok. 0,6 s).
    expect(ms, `przebieg ${ms} ms`).toBeLessThan((N * JEDNO_WYWOLANIE_MS) / 2);
    expect(m.usunieteWiersze).toEqual([]);
    expect(wynik).toEqual({ deleted: 0, pending: N, postponed: 0, storageTimeoutSkipped: N - 1 });
  });

  it('limit przy usuwaniu kopii z archiwum: wiersz tej faktury zostaje mimo usuniętych już plików, następne nietknięte', { timeout: TEST_TIMEOUT_MS }, async () => {
    m.tabele.invoices = [1, 2, 3].map((n) => faktura(n, { archive_storage_path: `${T}/2016/01/${id(n)}.xml` }));
    atrapa.zachowanie = (zadanie) => (doArchiwum(zadanie) && zadanie.sciezka.includes(id(1)) ? 'milczy' : 'odpowiada');

    const { wynik, ms } = await zmierzPrzebieg();

    // Pierwsza faktura: listowanie i oba pliki w magazynie poszły, kopia w archiwum milczy.
    expect(zadaniaFaktury(1).map((z) => `${z.metoda} ${doArchiwum(z) ? 'archiwum' : 'magazyn'}`), `przebieg ${ms} ms`).toEqual([
      'GET magazyn',
      'DELETE magazyn',
      'DELETE magazyn',
      ...Array(MALE.maxAttempts).fill('DELETE archiwum'),
    ]);
    expect(zadaniaFaktury(2)).toEqual([]);
    expect(zadaniaFaktury(3)).toEqual([]);
    // Fail-closed: wiersz zostaje, następny przebieg usunie resztę plików i wiersz.
    expect(m.usunieteWiersze).toEqual([]);
    expect(wynik).toEqual({ deleted: 0, pending: 3, postponed: 0, storageTimeoutSkipped: 2 });
    expect(m.sentry.map((s) => s.context?.extra)).toEqual([
      { skipped: 2, pending: 3, deleted: 0, operation: 'DeleteObject', attempts: MALE.maxAttempts, attempt: 0 },
    ]);
  });

  it('faktury usunięte przed limitem zostają usunięte; wyłącznik zatrzymuje tylko następne', { timeout: TEST_TIMEOUT_MS }, async () => {
    m.tabele.invoices = faktury(1, 2, 3, 4);
    atrapa.zachowanie = (zadanie) => (zadanie.sciezka.includes(id(3)) ? 'milczy' : 'odpowiada');

    const { wynik } = await zmierzPrzebieg();

    expect(m.usunieteWiersze).toEqual([id(1), id(2)]);
    expect(wykonane()).toEqual([id(1), id(2)]);
    expect(zadaniaFaktury(4)).toEqual([]);
    expect(zostaly()).toEqual([id(3), id(4)]);
    expect(wynik).toEqual({ deleted: 2, pending: 2, postponed: 0, storageTimeoutSkipped: 1 });
  });

  it('zerwane połączenie (ECONNRESET) to nie limit czasu: czeka tylko ta faktura, następne idą jak dotąd', { timeout: TEST_TIMEOUT_MS }, async () => {
    m.tabele.invoices = faktury(1, 2, 3);
    atrapa.zachowanie = (zadanie) => (zadanie.sciezka.includes(id(1)) ? 'zrywa' : 'odpowiada');

    const { wynik } = await zmierzPrzebieg();

    expect(m.usunieteWiersze).toEqual([id(2), id(3)]);
    expect(zostaly()).toEqual([id(1)]);
    expect(wynik).toEqual({ deleted: 2, pending: 1, postponed: 0, storageTimeoutSkipped: 0 });
    expect(m.sentry).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      'Retencja: pliki faktury nieusunięte — wiersz zostaje do następnego przebiegu',
      expect.objectContaining({ invoiceId: id(1) }),
    );
  });

  it('wyłącznik działa w jednym przebiegu: następny przebieg przy zdrowym magazynie usuwa te same faktury', { timeout: TEST_TIMEOUT_MS }, async () => {
    m.tabele.invoices = faktury(1, 2, 3);
    atrapa.zachowanie = () => 'milczy';

    await expect(runRetentionDelete(ctx)).resolves.toEqual({ deleted: 0, pending: 3, postponed: 0, storageTimeoutSkipped: 2 });

    atrapa.zachowanie = () => 'odpowiada';
    await expect(runRetentionDelete(ctx)).resolves.toEqual({ deleted: 3, pending: 0, postponed: 0, storageTimeoutSkipped: 0 });
    expect(m.usunieteWiersze).toEqual([id(1), id(2), id(3)]);
    expect(wykonane()).toEqual([id(1), id(2), id(3)]);
  });

  it('wyłącznik i błąd wiersza w jednym przebiegu: job rzuca jak dotąd, a ponowienie zapala wyłącznik na pierwszej fakturze i kończy się sukcesem', { timeout: TEST_TIMEOUT_MS }, async () => {
    m.tabele.invoices = faktury(1, 2, 3);
    // Faktura 1: pliki usunięte, ale baza nie da usunąć wiersza; przy fakturze 2 magazyn milknie.
    m.bledyUsuniecia = new Set<unknown>([id(1)]);
    atrapa.zachowanie = (zadanie) => (zadanie.sciezka.includes(id(1)) ? 'odpowiada' : 'milczy');
    const wpisyWylacznika = () => logger.error.mock.calls.filter(([tresc]) => String(tresc).includes('Wyłącznik'));

    await expect(runRetentionDelete(ctx)).rejects.toThrow('Retencja: 1 faktur bez usuniętego wiersza po usunięciu plików');

    expect(zadaniaFaktury(3), 'faktura 3 za wyłącznikiem').toEqual([]);
    expect(zostaly()).toEqual([id(1), id(2), id(3)]);
    expect(logger.error).toHaveBeenCalledWith('Retencja: pliki usunięte, wiersz faktury został', expect.objectContaining({ invoiceId: id(1) }));
    // Wpis wyłącznika i zgłoszenie idą przed błędem wierszy, po jednym.
    expect(wpisyWylacznika().map(([, dodatki]) => dodatki)).toEqual([
      { invoiceId: id(2), skipped: 1, pending: 3, deleted: 0, operation: 'ListObjectsV2', attempts: MALE.maxAttempts, attempt: 0 },
    ]);
    expect(m.sentry.map((s) => s.context?.extra)).toEqual([
      { skipped: 1, pending: 3, deleted: 0, operation: 'ListObjectsV2', attempts: MALE.maxAttempts, attempt: 0 },
    ]);

    // Ponowienie (pg-boss, wykonanie 1) przy wciąż zawieszonym magazynie: plan od nowa, pierwsza
    // faktura listuje folder prób, więc wyłącznik zapala się, zanim baza usunie jakikolwiek wiersz.
    atrapa.zadania = [];
    atrapa.zachowanie = () => 'milczy';
    await expect(runRetentionDelete({ ...ctx, attempt: 1 })).resolves.toEqual({ deleted: 0, pending: 3, postponed: 0, storageTimeoutSkipped: 2 });

    expect(atrapa.zadania.map((z) => z.metoda)).toEqual(Array(MALE.maxAttempts).fill('GET'));
    expect(zadaniaFaktury(1)).toHaveLength(MALE.maxAttempts);
    expect(m.usunieteWiersze).toEqual([]);
    expect(zostaly()).toEqual([id(1), id(2), id(3)]);
    // Drugie zgłoszenie to to samo zadanie, poznać je po numerze wykonania.
    expect(m.sentry.map((s) => s.context?.extra)).toEqual([
      { skipped: 1, pending: 3, deleted: 0, operation: 'ListObjectsV2', attempts: MALE.maxAttempts, attempt: 0 },
      { skipped: 2, pending: 3, deleted: 0, operation: 'ListObjectsV2', attempts: MALE.maxAttempts, attempt: 1 },
    ]);
    expect(wpisyWylacznika().map(([, dodatki]) => dodatki)).toEqual([
      expect.objectContaining({ invoiceId: id(2), attempt: 0 }),
      expect.objectContaining({ invoiceId: id(1), attempt: 1 }),
    ]);
  });
});

describe('LIM-05: limit czasu rozpoznany po typie albo po name i code, nie po treści', () => {
  /** Atrapa `send` klienta (bez warstwy zamiany błędu): rzuca `blad` dla pierwszej faktury, reszta przechodzi. */
  function sendRzucaDlaPierwszej(blad: () => Error) {
    return vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: { input: { Prefix?: string; Key?: string } }) => {
      if ((command.input.Prefix ?? command.input.Key ?? '').includes(id(1))) throw blad();
      return {};
    }) as never);
  }
  const celeWywolan = (send: ReturnType<typeof sendRzucaDlaPierwszej>) =>
    send.mock.calls.map(([command]) => {
      const { Prefix, Key } = (command as unknown as { input: { Prefix?: string; Key?: string } }).input;
      return [1, 2, 3].find((n) => (Prefix ?? Key ?? '').includes(id(n)));
    });

  it('błąd z name „TimeoutError” i code „ETIMEDOUT” z innej instancji modułu zapala wyłącznik', async () => {
    m.tabele.invoices = faktury(1, 2, 3);
    const send = sendRzucaDlaPierwszej(() => Object.assign(new Error('Socket timed out'), { name: 'TimeoutError', code: 'ETIMEDOUT' }));

    const wynik = await runRetentionDelete(ctx);

    expect(celeWywolan(send)).toEqual([1]);
    expect(m.usunieteWiersze).toEqual([]);
    expect(wynik).toEqual({ deleted: 0, pending: 3, postponed: 0, storageTimeoutSkipped: 2 });
  });

  it('ta sama treść co przy limicie, ale bez name i code, to zwykły błąd pliku: czeka tylko ta faktura', async () => {
    m.tabele.invoices = faktury(1, 2, 3);
    sendRzucaDlaPierwszej(() => new Error('Magazyn plików nie odpowiedział w limicie czasu (ListObjectsV2, prób: 3)'));

    const wynik = await runRetentionDelete(ctx);

    expect(m.usunieteWiersze).toEqual([id(2), id(3)]);
    expect(wynik).toEqual({ deleted: 2, pending: 1, postponed: 0, storageTimeoutSkipped: 0 });
    expect(m.sentry).toEqual([]);
  });

  it('zerwane połączenie nazwane przez bibliotekę „TimeoutError” (code ECONNRESET) nie zapala wyłącznika', async () => {
    m.tabele.invoices = faktury(1, 2, 3);
    sendRzucaDlaPierwszej(() => Object.assign(new Error('socket hang up'), { name: 'TimeoutError', code: 'ECONNRESET' }));

    const wynik = await runRetentionDelete(ctx);

    expect(m.usunieteWiersze).toEqual([id(2), id(3)]);
    expect(wynik).toEqual({ deleted: 2, pending: 1, postponed: 0, storageTimeoutSkipped: 0 });
  });
});
