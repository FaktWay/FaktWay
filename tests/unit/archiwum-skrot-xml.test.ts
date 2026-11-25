import { createHash } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { opcje } from '../filtr/generatory/ustawienia';

/**
 * Ustalenie z #732 (plan skalowania 3000, dziennik 14.11; R1 `retencja`):
 * `cron.archive-old-invoices` czytał skrót XML z `xml_documents` bez `error`
 * i po ścieżce pliku. Błąd odczytu (limit czasu, 5xx bramki, przerwa bazy,
 * odpowiedź bez listy wierszy, kilka wierszy dowodu jednej faktury) i wiersz
 * dowodu wskazujący inny plik wyglądały jak brak wiersza. Wtedy XML szedł do
 * Glacier bez kontroli skrótu, a faktura dostawała znaczniki archiwum i datę
 * usunięcia. Kopia niezgodna z dowodem zostawała w archiwum na lata i żaden
 * przebieg już jej nie sprawdzał.
 *
 * Testy idą przez prawdziwy runner, prawdziwy `step` workera, prawdziwego
 * klienta Supabase i prawdziwe `lib/storage/r2.ts` (kontrola skrótu). Atrapy
 * modułów są trzy: `@/lib/supabase/server` (oddaje klienta z atrapą `fetch`,
 * czyli PostgREST w pamięci), `@/lib/storage/r2-client` (klient S3 magazynu
 * R2) i `@/lib/storage/glacier`. Limit czasu klienta to odrzucony `fetch` z tym
 * samym `SupabaseTimeoutError`, który rzuca `createSupabaseFetch`; samego
 * zegara test nie uruchamia.
 */

type Row = Record<string, unknown>;

const m = vi.hoisted(() => ({
  client: null as unknown,
  /** Magazyn R2: klucz → treść pliku. */
  r2: new Map<string, string>(),
  /** Klucze odczytane z R2, w kolejności. */
  r2Reads: [] as string[],
  /** Glacier: klucz → wgrana treść (ostatnia). */
  glacier: new Map<string, string>(),
  /** Id faktur w kolejności udanych wgrań do Glacier. */
  glacierPuts: [] as string[],
}));

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => m.client }));
vi.mock('@/lib/storage/r2-client', () => ({
  getR2Config: () => ({
    accountId: 'test',
    accessKeyId: 'test',
    secretAccessKey: 'test',
    bucketName: 'faktury-test',
    endpoint: 'https://r2.example.invalid',
  }),
  getR2Client: () => ({
    send: async (command: { input: { Key: string } }) => {
      const key = command.input.Key;
      m.r2Reads.push(key);
      const content = m.r2.get(key);
      if (content === undefined) throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
      return { Body: { transformToString: async () => content } };
    },
  }),
}));
vi.mock('@/lib/storage/glacier', () => ({
  // Klucz jak w `lib/storage/glacier.ts`: firma/rok/miesiąc/faktura.
  uploadToGlacier: vi.fn(async (tenantId: string, invoiceId: string, issueDate: string, xml: string) => {
    const [year, month] = issueDate.slice(0, 10).split('-');
    const key = `${tenantId}/${year}/${month}/${invoiceId}.xml`;
    m.glacier.set(key, xml);
    m.glacierPuts.push(invoiceId);
    return key;
  }),
}));

import type { JobContext } from '@/lib/jobs/registry';
import { runArchiveOldInvoices } from '@/lib/jobs/runners/archive-old-invoices';
import { createJobStep } from '@/lib/jobs/step-shim';
import { SupabaseTimeoutError, WORKER_READ_TIMEOUT_MS } from '@/lib/supabase/fetch-timeout';

/** Cron o 3:00 w Polsce (CET), więc granica dwóch lat to 2024-11-11. */
const NOW = new Date('2026-11-11T02:00:00.000Z');
/** Ponowienia `cron.archive-old-invoices` (`DEFAULT_JOB_RETRIES` w `lib/jobs/handlers/package-a.ts`). */
const RETRIES = 4;

/** Skrót liczony w teście, bez pomocników programu. */
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Błędy odczytu `xml_documents`, jakie zwraca PostgREST albo bramka przed nim. */
const FAULTS = {
  'limit czasu zapytania (57014)': () =>
    Response.json(
      { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null },
      { status: 500 },
    ),
  // 503 biblioteka ponawia sama (do 3 razy); `Retry-After: 0`, żeby test nie czekał.
  'bramka 503 ze stroną HTML': () =>
    new Response('<html><head><title>503 Service Temporarily Unavailable</title></head></html>', {
      status: 503,
      headers: { 'content-type': 'text/html', 'retry-after': '0' },
    }),
  'baza niedostępna (PGRST001)': () =>
    Response.json(
      { code: 'PGRST001', message: 'Database client error. Retrying the connection.', details: null, hint: null },
      { status: 503, headers: { 'retry-after': '0' } },
    ),
  'brak uprawnień (42501)': () =>
    Response.json(
      { code: '42501', message: 'permission denied for table xml_documents', details: null, hint: null },
      { status: 403 },
    ),
  // Odrzucony `fetch`: biblioteka nie ponawia i oddaje `error` z pustym kodem.
  'limit czasu klienta (SupabaseTimeoutError)': () => {
    throw new SupabaseTimeoutError(WORKER_READ_TIMEOUT_MS, 'GET xml_documents');
  },
  // Odpowiedzi spoza umowy: biblioteka oddaje `data: null` bez `error`.
  'pusta odpowiedź 200 bramki': () => new Response('', { status: 200 }),
  '404 bez treści (biblioteka zgłasza 204)': () => new Response('', { status: 404 }),
  // Lista bez błędu, ale z czymś innym niż wiersz: to też nie brak wiersza
  // (drugi czytelnik #802, ponowny odczyt).
  'lista z null zamiast wiersza': () => Response.json([null]),
} satisfies Record<string, () => Response>;

type Fault = keyof typeof FAULTS;
const FAULT_NAMES = Object.keys(FAULTS) as Fault[];

/** Warunek z adresu: tylko operatory, których używa archiwizacja. */
function condition(column: string, raw: string): (row: Row) => boolean {
  if (raw === 'is.null') return (row) => row[column] == null;
  if (raw === 'not.is.null') return (row) => row[column] != null;
  const dot = raw.indexOf('.');
  const op = raw.slice(0, dot);
  const value = raw.slice(dot + 1);
  switch (op) {
    case 'eq':
      return (row) => row[column] != null && String(row[column]) === value;
    case 'neq':
      return (row) => row[column] != null && String(row[column]) !== value;
    case 'lt':
      return (row) => row[column] != null && String(row[column]) < value;
    default:
      throw new Error(`atrapa PostgREST: nieobsługiwany operator ${raw} (${column})`);
  }
}

const RESERVED = new Set(['select', 'order', 'limit', 'offset']);

/**
 * PostgREST w pamięci. `fault(invoiceId)` decyduje, czy odczyt dowodu tej
 * faktury pada w bieżącej próbie zadania (także w ponowieniach biblioteki).
 */
function server(tables: Record<string, Row[]>) {
  const srv = {
    fault: null as ((invoiceId: string) => Fault | null) | null,
    client: null as unknown,
  };
  srv.client = createClient('https://database.example.invalid', 'synthetic-local-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        const table = url.pathname.replace(/^\/rest\/v1\//, '');
        const rows = (tables[table] ??= []);
        const body = typeof init?.body === 'string' && init.body !== '' ? (JSON.parse(init.body) as Row) : null;

        if (table === 'xml_documents') {
          const invoiceId = url.searchParams.get('invoice_id')?.replace(/^eq\./, '') ?? '';
          const fault = srv.fault?.(invoiceId) ?? null;
          if (fault) return FAULTS[fault]();
        }

        let filters: Array<(row: Row) => boolean>;
        try {
          filters = [...url.searchParams]
            .filter(([key]) => !RESERVED.has(key))
            .map(([key, raw]) => condition(key, raw));
        } catch (e) {
          return Response.json({ code: 'PGRST100', message: String(e), details: null, hint: null }, { status: 400 });
        }
        const matching = rows.filter((row) => filters.every((f) => f(row)));

        if (method === 'GET') {
          const columns = url.searchParams.get('select')?.split(',').map((c) => c.trim());
          const limit = Number(url.searchParams.get('limit') ?? 1000);
          return Response.json(
            matching
              .slice(0, limit)
              .map((row) => (columns ? Object.fromEntries(columns.map((c) => [c, row[c] ?? null])) : { ...row })),
          );
        }
        if (method === 'PATCH' && body) {
          for (const row of matching) Object.assign(row, body);
          return new Response(null, { status: 204 });
        }
        return Response.json(
          { code: 'PGRST000', message: `atrapa PostgREST: nieobsługiwane ${method} ${table}`, details: null, hint: null },
          { status: 400 },
        );
      },
    },
  });
  return srv;
}

/**
 * Dowód pliku faktury w `xml_documents`:
 * - `zgodny`: jeden wiersz ze skrótem pliku z R2;
 * - `inny`: jeden wiersz ze skrótem innej treści (plik w R2 rozjechał się z dowodem);
 * - `pusty`: jeden wiersz z pustym skrótem (kolumna jest NOT NULL, pusty napis przejdzie);
 * - `dubel`: dwa wiersze jednej faktury (możliwe tylko bez indeksu z 00164);
 * - `inny-plik`: jeden wiersz wskazuje inny plik z inną treścią (konflikt przy
 *   zapisie dowodu, `XmlDocumentConflictError` połknięty w `save-accepted.ts`);
 * - `kopia`: jeden wiersz wskazuje inną ścieżkę z tą samą treścią;
 * - `brak`: żadnego wiersza (np. faktura sprzed AUD-12).
 */
type Evidence = 'zgodny' | 'inny' | 'pusty' | 'dubel' | 'inny-plik' | 'kopia' | 'brak';
const EVIDENCE: Evidence[] = ['zgodny', 'inny', 'pusty', 'dubel', 'inny-plik', 'kopia', 'brak'];
/** Dowód, z którym faktura nie może trafić do Glacier. */
const POISON = new Set<Evidence>(['inny', 'pusty', 'dubel', 'inny-plik']);

const uuid = (group: number, n: number) =>
  `${String(group).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface Candidate {
  id: string;
  tenantId: string;
  path: string;
  /** Ścieżka wcześniejszego pliku (`inny-plik`, `kopia`). */
  otherPath: string;
  evidence: Evidence;
}

/** Faktury do archiwizacji z plikami w R2 i dowodami według `evidence`. */
function scenario(evidence: Evidence[]) {
  const invoices: Row[] = [];
  const xmlDocuments: Row[] = [];
  const candidates: Candidate[] = evidence.map((ev, i) => {
    const id = uuid(1, i + 1);
    const tenantId = uuid(9, (i % 3) + 1);
    const path = `${tenantId}/2021/03/${id}.xml`;
    const content = `<Faktura id="${id}"/>`;
    m.r2.set(path, content);
    invoices.push({
      id,
      tenant_id: tenantId,
      issue_date: '2021-03-15',
      xml_storage_path: path,
      origin: 'app',
      archived_at: null,
      archive_storage_path: null,
      scheduled_deletion_at: null,
    });
    const doc = (hash: string, n: number, storagePath = path) => ({
      id: uuid(3, (i + 1) * 10 + n),
      invoice_id: id,
      tenant_id: tenantId,
      storage_path: storagePath,
      sha256_hash: hash,
    });
    // Wcześniejszy plik tej faktury pod inną ścieżką (zostaje w R2).
    const otherPath = `${tenantId}/2021/03/${id}-wczesniejszy.xml`;
    if (ev === 'zgodny') xmlDocuments.push(doc(sha256(content), 1));
    if (ev === 'inny') xmlDocuments.push(doc(sha256(`${content}<!-- inna treść -->`), 1));
    if (ev === 'pusty') xmlDocuments.push(doc('', 1));
    if (ev === 'dubel') xmlDocuments.push(doc(sha256(content), 1), doc(sha256(content), 2));
    if (ev === 'inny-plik') {
      const earlier = `${content}<!-- wcześniejsza wersja -->`;
      m.r2.set(otherPath, earlier);
      xmlDocuments.push(doc(sha256(earlier), 1, otherPath));
    }
    if (ev === 'kopia') {
      m.r2.set(otherPath, content);
      xmlDocuments.push(doc(sha256(content), 1, otherPath));
    }
    return { id, tenantId, path, otherPath, evidence: ev };
  });
  return { tables: { invoices, xml_documents: xmlDocuments } as Record<string, Row[]>, candidates };
}

function context(): JobContext {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { step: createJobStep(logger), logger, attempt: 0 };
}

/**
 * Niezmiennik archiwum po każdym przebiegu: do Glacier trafia tylko plik
 * zgodny ze skrótem z jedynego wiersza dowodu faktury albo plik faktury,
 * która wiersza dowodu nie ma wcale (zachowanie bez zmian); faktura ze
 * znacznikami archiwum ma w Glacier właśnie taki plik i datę usunięcia.
 */
function violations(tables: Record<string, Row[]>, candidates: Candidate[]): string[] {
  const found: string[] = [];
  for (const c of candidates) {
    const docs = tables.xml_documents.filter((d) => d.invoice_id === c.id && d.tenant_id === c.tenantId);
    const key = `${c.tenantId}/2021/03/${c.id}.xml`;
    const copy = m.glacier.get(key);
    if (copy !== undefined) {
      const verified = docs.length === 1 && sha256(copy) === docs[0]!.sha256_hash;
      if (!verified && docs.length !== 0) {
        found.push(`${c.id} (${c.evidence}): w Glacier plik bez zgodnego skrótu z xml_documents`);
      }
    }
    const row = tables.invoices.find((r) => r.id === c.id)!;
    if (row.archived_at != null && (copy === undefined || row.archive_storage_path !== key || row.scheduled_deletion_at == null)) {
      found.push(`${c.id} (${c.evidence}): znaczniki archiwum bez kopii w Glacier albo bez daty usunięcia`);
    }
  }
  return found;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  m.r2.clear();
  m.r2Reads = [];
  m.glacier.clear();
  m.glacierPuts = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('archiwum starych faktur: błąd odczytu skrótu XML to nie brak dowodu (ustalenie z #732)', () => {
  it.each(FAULT_NAMES)(
    '%s: przebieg pada na tej fakturze, nic nie trafia do Glacier; ponowienie od zera archiwizuje ją ze sprawdzonym skrótem',
    async (fault) => {
      const { tables, candidates } = scenario(['zgodny']);
      const [c] = candidates as [Candidate];
      const srv = server(tables);
      m.client = srv.client;
      srv.fault = () => fault;

      await expect(runArchiveOldInvoices(context())).rejects.toThrow(/nie można odczytać skrótu XML/);

      // Nic z magazynu: bez skrótu plik nie jest nawet pobierany.
      expect(m.r2Reads).toEqual([]);
      expect(m.glacierPuts).toEqual([]);
      expect(tables.invoices[0]).toMatchObject({ archived_at: null, archive_storage_path: null, scheduled_deletion_at: null });

      // Ponowienie pg-boss: cały handler od nowa, błąd minął.
      srv.fault = null;
      await expect(runArchiveOldInvoices(context())).resolves.toEqual({ archived: 1 });

      expect(m.glacierPuts).toEqual([c.id]);
      expect(m.glacier.get(c.path)).toBe(m.r2.get(c.path));
      expect(tables.invoices[0]!.archived_at).not.toBeNull();
      expect(violations(tables, candidates)).toEqual([]);
    },
  );

  it.each(FAULT_NAMES)(
    '%s przy pliku niezgodnym z dowodem: niezgodny plik nie trafia do Glacier ani przy błędzie, ani po nim',
    async (fault) => {
      const { tables, candidates } = scenario(['inny']);
      const srv = server(tables);
      m.client = srv.client;
      srv.fault = () => fault;

      await expect(runArchiveOldInvoices(context())).rejects.toThrow(/nie można odczytać skrótu XML/);
      expect(m.glacierPuts).toEqual([]);

      srv.fault = null;
      await expect(runArchiveOldInvoices(context())).rejects.toThrow(/hash mismatch/);
      expect(m.glacierPuts).toEqual([]);
      expect(tables.invoices[0]!.archived_at).toBeNull();
      expect(violations(tables, candidates)).toEqual([]);
    },
  );

  it('dwa wiersze dowodu jednej faktury (bez indeksu z 00164): przebieg pada z nazwą sprawy, nic nie trafia do Glacier', async () => {
    const { tables, candidates } = scenario(['dubel']);
    const srv = server(tables);
    m.client = srv.client;

    await expect(runArchiveOldInvoices(context())).rejects.toThrow(/kilka wierszy xml_documents/);

    expect(m.r2Reads).toEqual([]);
    expect(m.glacierPuts).toEqual([]);
    expect(tables.invoices[0]!.archived_at).toBeNull();
    expect(violations(tables, candidates)).toEqual([]);
  });

  it('wiersz dowodu z pustym skrótem: plik nie idzie do Glacier bez kontroli', async () => {
    const { tables, candidates } = scenario(['pusty']);
    const srv = server(tables);
    m.client = srv.client;

    await expect(runArchiveOldInvoices(context())).rejects.toThrow(/hash mismatch/);

    expect(m.glacierPuts).toEqual([]);
    expect(tables.invoices[0]!.archived_at).toBeNull();
    expect(violations(tables, candidates)).toEqual([]);
  });

  it('wiersz dowodu wskazuje inny plik (konflikt przy zapisie dowodu): plik faktury nie idzie do Glacier bez zgodnego skrótu', async () => {
    const { tables, candidates } = scenario(['inny-plik']);
    const [c] = candidates as [Candidate];
    const srv = server(tables);
    m.client = srv.client;
    const ctx = context();

    await expect(runArchiveOldInvoices(ctx)).rejects.toThrow(/hash mismatch/);

    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/inną ścieżkę pliku niż faktura/));
    // Sprawdzany jest plik faktury, nie plik z wiersza.
    expect(m.r2Reads).toEqual([c.path]);
    expect(m.glacierPuts).toEqual([]);
    expect(tables.invoices[0]!.archived_at).toBeNull();
    expect(violations(tables, candidates)).toEqual([]);
  });

  it('wiersz dowodu z inną ścieżką i tą samą treścią: plik faktury trafia do Glacier po kontroli skrótu', async () => {
    const { tables, candidates } = scenario(['kopia']);
    const [c] = candidates as [Candidate];
    const srv = server(tables);
    m.client = srv.client;

    await expect(runArchiveOldInvoices(context())).resolves.toEqual({ archived: 1 });

    expect(m.r2Reads).toEqual([c.path]);
    expect(m.glacier.get(c.path)).toBe(m.r2.get(c.path));
    expect(tables.invoices[0]!.archived_at).not.toBeNull();
    expect(violations(tables, candidates)).toEqual([]);
  });

  it('limit czasu klienta: komunikat ma „bez kodu” i nazwę błędu zamiast pustego kodu', async () => {
    const { tables } = scenario(['zgodny']);
    const srv = server(tables);
    m.client = srv.client;
    srv.fault = () => 'limit czasu klienta (SupabaseTimeoutError)';

    await expect(runArchiveOldInvoices(context())).rejects.toThrow(
      /nie można odczytać skrótu XML faktury \S+ \(bez kodu: TimeoutError: /,
    );
  });

  it('brak wiersza dowodu (odczyt udany, zero wierszy): bez zmian, plik idzie do Glacier bez kontroli skrótu', async () => {
    const { tables, candidates } = scenario(['brak']);
    const [c] = candidates as [Candidate];
    const srv = server(tables);
    m.client = srv.client;

    await expect(runArchiveOldInvoices(context())).resolves.toEqual({ archived: 1 });

    expect(m.glacier.get(c.path)).toBe(m.r2.get(c.path));
    expect(tables.invoices[0]!.archived_at).not.toBeNull();
    expect(tables.invoices[0]!.scheduled_deletion_at).not.toBeNull();
  });

  it('wiersz dowodu zgodny z plikiem: plik w Glacier, faktura oznaczona', async () => {
    const { tables, candidates } = scenario(['zgodny', 'zgodny']);
    const srv = server(tables);
    m.client = srv.client;

    await expect(runArchiveOldInvoices(context())).resolves.toEqual({ archived: 2 });

    expect(m.glacierPuts).toEqual(candidates.map((c) => c.id));
    expect(violations(tables, candidates)).toEqual([]);
  });
});

describe('archiwum starych faktur: niezmiennik kopii w Glacier przy losowych błędach odczytu (ustalenie z #732)', () => {
  /**
   * Losowe faktury (rodzaje dowodu z `EVIDENCE`) i losowe błędy odczytu
   * dowodu w kolejnych próbach zadania. Próby jak w workerze: pierwsza i 4
   * ponowienia, każda od zera. Po każdej próbie niezmiennik kopii. Gdy żadna
   * faktura nie ma złego dowodu, a błędy ustały, ponowienia kończą archiwum
   * i każdy plik trafia do Glacier dokładnie raz. „Raz” dotyczy tylko tego
   * modelu: błędy są tu wyłącznie w odczycie dowodu, przed wgraniem. Ponowne
   * wgranie po nieudanym zapisie znaczników sprawdza `archiwum-oznaczenie.test.ts`.
   */
  it('do Glacier trafia tylko plik zgodny z dowodem albo plik faktury bez dowodu, a znaczniki tylko z kopią', async () => {
    const arbitrary = fc
      .array(fc.constantFrom(...EVIDENCE), { minLength: 1, maxLength: 6 })
      .chain((evidence) =>
        fc.record({
          evidence: fc.constant(evidence),
          // Błędy odczytu w próbach 0…RETRIES-1: [próba, faktura, rodzaj].
          faults: fc.array(
            fc.tuple(
              fc.integer({ min: 0, max: RETRIES - 1 }),
              fc.integer({ min: 0, max: evidence.length - 1 }),
              fc.constantFrom(...FAULT_NAMES),
            ),
            { maxLength: 8 },
          ),
        }),
      );

    await fc.assert(
      fc.asyncProperty(arbitrary, async ({ evidence, faults }) => {
        m.r2.clear();
        m.r2Reads = [];
        m.glacier.clear();
        m.glacierPuts = [];
        const { tables, candidates } = scenario(evidence);
        const srv = server(tables);
        m.client = srv.client;

        for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
          const now = faults.filter(([a]) => a === attempt);
          srv.fault = (invoiceId) => {
            const hit = now.find(([, i]) => candidates[i]!.id === invoiceId);
            return hit ? hit[2] : null;
          };
          // Wynik próby nieistotny: worker ponawia, test sprawdza stan.
          await runArchiveOldInvoices(context()).catch(() => undefined);
          expect(violations(tables, candidates)).toEqual([]);
        }

        for (const c of candidates) {
          if (POISON.has(c.evidence)) {
            expect(tables.invoices.find((r) => r.id === c.id)!.archived_at).toBeNull();
          }
        }
        if (!evidence.some((ev) => POISON.has(ev))) {
          // Ostatnia próba bez błędów: archiwum kompletne, każdy plik raz.
          expect(tables.invoices.filter((r) => r.archived_at == null).map((r) => r.id)).toEqual([]);
          expect([...m.glacierPuts].sort()).toEqual(candidates.map((c) => c.id).sort());
        }
      }),
      opcje(100),
    );
  }, 60_000);
});
