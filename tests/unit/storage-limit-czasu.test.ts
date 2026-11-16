import { readFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { join } from 'node:path';

import { S3Client } from '@aws-sdk/client-s3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { uploadSnapshot } from '@/lib/backup/r2-backup-client';
import { uploadExpensePhoto } from '@/lib/storage/expenses';
import { uploadToGlacier } from '@/lib/storage/glacier';
import { newTenantLogoKey, putTenantLogo } from '@/lib/storage/logo';
import {
  downloadFromR2,
  getSignedInvoiceUrl,
  invoiceXmlExists,
  uploadInvoiceXml,
  uploadToR2,
  uploadToR2IfAbsent,
} from '@/lib/storage/r2';
import { getR2Client } from '@/lib/storage/r2-client';
import {
  REQUEST_STORAGE_TIMEOUTS,
  StorageTimeoutError,
  UPLOAD_MIN_BYTES_PER_SECOND,
  WORKER_STORAGE_TIMEOUTS,
  enableWorkerStorageTimeouts,
  s3TimeoutConfig,
  setStorageTimeoutsForTests,
  uploadRequestOptions,
  type StorageTimeouts,
} from '@/lib/storage/s3-timeouts';

/**
 * LIM-05, reszta z opisu #732 (plan skalowania 3000, sesja 5): limity czasu
 * klientów S3 (`lib/storage/r2-client.ts`, `lib/storage/glacier.ts`).
 *
 * Do tej zmiany `new S3Client` nie miał limitu połączenia ani odpowiedzi,
 * a AWS SDK sam żadnego nie ustawia. Zawieszony magazyn (przyjmuje połączenie
 * i milczy) trzymał żądanie strony albo zadanie workera bez końca.
 *
 * Testy idą przez PRAWDZIWE funkcje magazynu, prawdziwy `S3Client` i prawdziwe
 * gniazda do atrapy na pętli zwrotnej (`node:net`). Atrapa rozpoznaje zachowanie
 * po kluczu: `cisza` (przyjmuje i milczy), `stoi-w-tresci` (nagłówki i początek
 * treści, potem cisza), `zerwane` (zamyka połączenie), `brak` (404), `duzy`
 * (jak MinIO: „100 Continue”, cała treść, potem 200), reszta 200.
 * Limity procesu są tu w setnych sekundy (`setStorageTimeoutsForTests`), żeby
 * test nie czekał 20 s; wartości produkcyjne sprawdza osobny test. Limit ciszy
 * od 6 s biblioteka rejestruje dopiero po 3 s, więc tę ścieżkę (produkcyjną)
 * sprawdza jeden wolniejszy test.
 */

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INVOICE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MIB = 1024 * 1024;
/** Atrapa: limity w setnych sekundy; `idleMs` > `responseMs`, żeby było wiadomo, który limit zadziałał. */
const MALE: StorageTimeouts = { connectMs: 200, responseMs: 300, idleMs: 1_000, maxAttempts: 2 };
/** Po tym czasie test uznaje, że wywołanie wisi. */
const STRAZNIK_MS = 4_000;
const TEST_TIMEOUT_MS = 15_000;

type Zadanie = {
  metoda: string;
  sciezka: string;
  /** Nagłówki żądania, nazwy małymi literami. */
  naglowki: Record<string, string>;
  /** Bajty treści żądania, które atrapa przeczytała (tylko `duzy`). */
  odebraneBajty: number;
};

const atrapa = {
  serwer: null as Server | null,
  port: 0,
  zadania: [] as Zadanie[],
  gniazda: new Set<Socket>(),
};

function zadaniaZ(znacznik: string): Zadanie[] {
  return atrapa.zadania.filter((zadanie) => zadanie.sciezka.includes(znacznik));
}

function odpowiedz(socket: Socket, zadanie: Zadanie, poczatekTresci: Buffer): void {
  const { sciezka } = zadanie;
  if (sciezka.includes('cisza')) return;
  if (sciezka.includes('zerwane')) {
    socket.destroy();
    return;
  }
  if (sciezka.includes('stoi-w-tresci')) {
    socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/xml\r\nContent-Length: 100\r\n\r\n<Faktura>');
    return;
  }
  if (sciezka.includes('brak')) {
    socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    return;
  }
  if (sciezka.includes('duzy')) {
    // Jak MinIO i S3: „100 Continue” od razu, potem cała treść, potem odpowiedź.
    if (zadanie.naglowki.expect?.toLowerCase() === '100-continue') socket.write('HTTP/1.1 100 Continue\r\n\r\n');
    const dlugosc = Number(zadanie.naglowki['content-length'] ?? 0);
    const przyjmij = (kawalek: Buffer) => {
      zadanie.odebraneBajty += kawalek.length;
      if (zadanie.odebraneBajty < dlugosc) return;
      socket.off('data', przyjmij);
      socket.end('HTTP/1.1 200 OK\r\nETag: "etag"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    };
    socket.on('data', przyjmij);
    przyjmij(poczatekTresci);
    return;
  }
  socket.end('HTTP/1.1 200 OK\r\nContent-Type: application/xml\r\nContent-Length: 10\r\nConnection: close\r\n\r\n<Faktura/>');
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
      const naglowki = Object.fromEntries(
        linie.map((naglowek) => {
          const dwukropek = naglowek.indexOf(':');
          return [naglowek.slice(0, dwukropek).trim().toLowerCase(), naglowek.slice(dwukropek + 1).trim()];
        }),
      );
      const zadanie: Zadanie = { metoda, sciezka, naglowki, odebraneBajty: 0 };
      atrapa.zadania.push(zadanie);
      odpowiedz(socket, zadanie, bufor.subarray(koniecNaglowkow + 4));
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

beforeEach(() => {
  atrapa.zadania = [];
  vi.stubEnv('R2_ACCOUNT_ID', 'konto-testowe');
  vi.stubEnv('R2_ACCESS_KEY_ID', 'klucz-testowy');
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 's'.repeat(40));
  vi.stubEnv('R2_BUCKET_NAME', 'faktury');
  vi.stubEnv('R2_ENDPOINT', `http://127.0.0.1:${atrapa.port}`);
  vi.stubEnv('R2_FORCE_PATH_STYLE', 'true');
  vi.stubEnv('R2_BACKUPS_BUCKET', '');
  setStorageTimeoutsForTests(MALE);
});

afterEach(() => {
  setStorageTimeoutsForTests(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type Wynik = { stan: 'wynik' | 'blad' | 'wisi'; wartosc?: unknown; blad?: unknown; ms: number };

/** Wynik albo błąd wywołania, a „wisi”, gdy przez `straznikMs` nic nie przyszło. */
async function zmierz(praca: Promise<unknown>, straznikMs = STRAZNIK_MS): Promise<Wynik> {
  const start = performance.now();
  let straznik: NodeJS.Timeout | undefined;
  const wynik = await Promise.race<Omit<Wynik, 'ms'>>([
    praca.then(
      (wartosc) => ({ stan: 'wynik', wartosc }),
      (blad: unknown) => ({ stan: 'blad', blad }),
    ),
    new Promise((resolve) => {
      straznik = setTimeout(() => resolve({ stan: 'wisi' }), straznikMs);
    }),
  ]);
  clearTimeout(straznik);
  return { ...wynik, ms: performance.now() - start };
}

function opis(wynik: Wynik): string {
  if (wynik.stan === 'wisi') return `wywołanie wisi po ${Math.round(wynik.ms)} ms`;
  if (wynik.stan === 'wynik') return `wywołanie zwróciło wynik: ${String(wynik.wartosc)}`;
  return `błąd: ${wynik.blad instanceof Error ? wynik.blad.message : String(wynik.blad)}`;
}

/** Błąd limitu z nazwą operacji i liczbą prób; bez klucza i firmy w treści. */
function oczekujLimitu(wynik: Wynik, operacja: string, proby: number): StorageTimeoutError {
  expect(wynik.stan, opis(wynik)).toBe('blad');
  expect(wynik.blad).toBeInstanceOf(StorageTimeoutError);
  const blad = wynik.blad as StorageTimeoutError;
  expect(blad).toMatchObject({ name: 'TimeoutError', code: 'ETIMEDOUT', operation: operacja, attempts: proby });
  expect(blad.message).toBe(`Magazyn plików nie odpowiedział w limicie czasu (${operacja}, prób: ${proby})`);
  expect(blad.message).not.toContain(TENANT);
  expect(blad.cause).toMatchObject({ name: 'TimeoutError' });
  return blad;
}

describe('LIM-05: zawieszony magazyn plików kończy wywołanie błędem po limicie', () => {
  it('odczyt: magazyn przyjmuje połączenie i milczy → błąd limitu po 2 próbach, gniazda zamknięte', { timeout: TEST_TIMEOUT_MS }, async () => {
    const wynik = await zmierz(downloadFromR2(`${TENANT}/2026/11/cisza.xml`, TENANT));

    oczekujLimitu(wynik, 'GetObject', MALE.maxAttempts);
    expect(zadaniaZ('cisza'), 'jawna liczba prób').toHaveLength(MALE.maxAttempts);
    expect(wynik.ms).toBeGreaterThanOrEqual(MALE.maxAttempts * MALE.responseMs - 5);
    await vi.waitFor(() => expect(atrapa.gniazda.size, 'połączenia zamknięte, gniazda wolne').toBe(0));
  });

  it('sprawdzenie, czy plik jest: milczenie to błąd, a nie „pliku nie ma”', { timeout: TEST_TIMEOUT_MS }, async () => {
    const wynik = await zmierz(invoiceXmlExists(`${TENANT}/2026/11/cisza.xml`));

    oczekujLimitu(wynik, 'HeadObject', MALE.maxAttempts);
  });

  it('wgranie: magazyn milczy po przyjęciu treści → błąd limitu po 2 próbach', { timeout: TEST_TIMEOUT_MS }, async () => {
    const wynik = await zmierz(
      uploadToR2IfAbsent(`exports/${TENANT}/archiwum/cisza/paczka.zip`, Buffer.from('PK-paczka'), 'application/zip'),
    );

    oczekujLimitu(wynik, 'PutObject', MALE.maxAttempts);
    expect(zadaniaZ('cisza').map((zadanie) => zadanie.metoda)).toEqual(['PUT', 'PUT']);
  });

  it('archiwum Glacier: wgranie do milczącego magazynu → błąd limitu po 2 próbach', { timeout: TEST_TIMEOUT_MS }, async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'klucz-archiwum');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 's'.repeat(40));
    vi.stubEnv('AWS_REGION', 'eu-central-1');
    vi.stubEnv('AWS_ARCHIVE_BUCKET', 'archiwum');
    // Klient Glacier nie ma własnego adresu; SDK bierze go z tej zmiennej.
    vi.stubEnv('AWS_ENDPOINT_URL_S3', `http://127.0.0.1:${atrapa.port}`);

    const wynik = await zmierz(uploadToGlacier(TENANT, 'cisza-faktura', '2026-11-16', '<Faktura/>'));

    oczekujLimitu(wynik, 'PutObject', MALE.maxAttempts);
    expect(zadaniaZ('cisza-faktura')).toHaveLength(MALE.maxAttempts);
  });

  it('nagłówki i początek treści, potem cisza → błąd limitu ciszy, nie ucięty plik', { timeout: TEST_TIMEOUT_MS }, async () => {
    const wynik = await zmierz(downloadFromR2(`${TENANT}/2026/11/stoi-w-tresci.xml`, TENANT));

    expect(wynik.stan, opis(wynik)).toBe('blad');
    expect(wynik.blad).toMatchObject({ name: 'TimeoutError', message: expect.stringContaining('inactivity') });
    // Treść czyta wywołujący, więc biblioteka jej nie ponawia.
    expect(zadaniaZ('stoi-w-tresci')).toHaveLength(1);
    expect(wynik.ms).toBeGreaterThanOrEqual(MALE.idleMs - 5);
  });

  it('limit ciszy od 6 s (jak na produkcji: biblioteka rejestruje go po 3 s) też przerywa stojącą treść', { timeout: 30_000 }, async () => {
    setStorageTimeoutsForTests({ ...MALE, idleMs: 6_000 });

    const wynik = await zmierz(downloadFromR2(`${TENANT}/2026/11/stoi-w-tresci-dlugo.xml`, TENANT), 15_000);

    expect(wynik.stan, opis(wynik)).toBe('blad');
    expect(wynik.blad).toMatchObject({ name: 'TimeoutError', message: expect.stringContaining('6000 ms of inactivity') });
    // Rejestracja po 3 s, potem 6 s ciszy.
    expect(wynik.ms).toBeGreaterThanOrEqual(6_000);
    expect(wynik.ms).toBeLessThan(6_000 + 3_000 + 2_000);
  });

  it('duże wgranie (od 2 MiB biblioteka wysyła „Expect: 100-continue”) przechodzi w limicie liczonym od rozmiaru', { timeout: TEST_TIMEOUT_MS }, async () => {
    const paczka = Buffer.alloc(3 * MIB, 1);

    const wynik = await zmierz(uploadToR2IfAbsent(`exports/${TENANT}/archiwum/duzy/paczka.zip`, paczka, 'application/zip'));

    expect(wynik.stan, opis(wynik)).toBe('wynik');
    expect(wynik.wartosc).toBe(true);
    expect(zadaniaZ('duzy')).toEqual([
      expect.objectContaining({ metoda: 'PUT', naglowki: expect.objectContaining({ expect: '100-continue' }), odebraneBajty: paczka.length }),
    ]);
  });

  it('zerwane połączenie to nie limit czasu: zostaje swoim błędem, po 2 próbach', { timeout: TEST_TIMEOUT_MS }, async () => {
    const wynik = await zmierz(downloadFromR2(`${TENANT}/2026/11/zerwane.xml`, TENANT));

    expect(wynik.stan, opis(wynik)).toBe('blad');
    expect(wynik.blad).not.toBeInstanceOf(StorageTimeoutError);
    expect(wynik.blad).toMatchObject({ code: 'ECONNRESET' });
    expect(zadaniaZ('zerwane'), 'jawna liczba prób').toHaveLength(MALE.maxAttempts);
  });

  it('zwykła odpowiedź w limicie przechodzi bez zmian; 404 to dalej „pliku nie ma”', { timeout: TEST_TIMEOUT_MS }, async () => {
    const plik = await zmierz(downloadFromR2(`${TENANT}/2026/11/zdrowy.xml`, TENANT));
    const brak = await zmierz(invoiceXmlExists(`${TENANT}/2026/11/brak.xml`));

    expect(plik.stan, opis(plik)).toBe('wynik');
    expect(String(plik.wartosc)).toBe('<Faktura/>');
    expect(brak).toMatchObject({ stan: 'wynik', wartosc: false });
    expect(atrapa.zadania).toHaveLength(2);
  });

  it('podpisany link do pliku działa z klientem z limitami (bez połączenia z magazynem)', async () => {
    const link = await getSignedInvoiceUrl(`${TENANT}/2026/11/zdrowy.xml`, TENANT, 60);

    expect(link).toContain(`/faktury/${TENANT}/2026/11/zdrowy.xml?`);
    expect(link).toContain('X-Amz-Signature=');
    expect(atrapa.zadania).toHaveLength(0);
  });
});

describe('profile limitów: żądanie strony, worker, duże pliki', () => {
  it('stałe: strona 3/10/10 s i 2 próby, worker 5/60/60 s i 3 próby', () => {
    expect(REQUEST_STORAGE_TIMEOUTS).toEqual({ connectMs: 3_000, responseMs: 10_000, idleMs: 10_000, maxAttempts: 2 });
    expect(WORKER_STORAGE_TIMEOUTS).toEqual({ connectMs: 5_000, responseMs: 60_000, idleMs: 60_000, maxAttempts: 3 });
    expect(s3TimeoutConfig(WORKER_STORAGE_TIMEOUTS)).toEqual({
      maxAttempts: 3,
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 60_000, socketTimeout: 60_000, throwOnRequestTimeout: true },
    });
  });

  it('klient magazynu ma liczbę prób profilu; worker dostaje nowego klienta z 3 próbami', async () => {
    setStorageTimeoutsForTests(null);
    const strona = getR2Client();
    expect(await strona.config.maxAttempts()).toBe(REQUEST_STORAGE_TIMEOUTS.maxAttempts);
    expect(getR2Client(), 'jeden klient na profil').toBe(strona);

    enableWorkerStorageTimeouts();
    const worker = getR2Client();
    expect(worker).not.toBe(strona);
    expect(await worker.config.maxAttempts()).toBe(WORKER_STORAGE_TIMEOUTS.maxAttempts);
  });

  it('wgranie: limit odpowiedzi rośnie o czas pliku przy 1 MiB/s', () => {
    expect(UPLOAD_MIN_BYTES_PER_SECOND).toBe(MIB);
    expect(uploadRequestOptions(0, REQUEST_STORAGE_TIMEOUTS)).toEqual({ requestTimeout: 10_000 });
    expect(uploadRequestOptions(10 * MIB, REQUEST_STORAGE_TIMEOUTS)).toEqual({ requestTimeout: 20_000 });
    // Paczka archiwum (do 150 MiB) w workerze.
    expect(uploadRequestOptions(150 * MIB, WORKER_STORAGE_TIMEOUTS)).toEqual({ requestTimeout: 210_000 });
  });

  it('każde wgranie (faktura, plik, eksport, kopia bazy, logo, zdjęcie kosztu, Glacier) dostaje ten limit', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'klucz-archiwum');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 's'.repeat(40));
    vi.stubEnv('AWS_ARCHIVE_BUCKET', 'archiwum');
    const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation((async () => ({})) as never);
    const xml = '<Faktura>zażółć</Faktura>';
    const limit = (bytes: number) => ({ requestTimeout: MALE.responseMs + Math.ceil((bytes * 1000) / MIB) });

    await uploadInvoiceXml(TENANT, INVOICE, '2026-11-16', xml);
    await uploadToR2(`upo/${TENANT}/plik.pdf`, Buffer.alloc(MIB), 'application/pdf');
    await uploadToR2IfAbsent(`exports/${TENANT}/archiwum/zlecenie/paczka.zip`, Buffer.alloc(3 * MIB), 'application/zip');
    await uploadSnapshot('backups/db/2026/11/16-000000.json.gz', new Uint8Array(2 * MIB), 'a'.repeat(64));
    await putTenantLogo(newTenantLogoKey(TENANT, 'png'), TENANT, Buffer.alloc(1_000), 'png');
    await uploadExpensePhoto(TENANT, INVOICE, Buffer.alloc(5_000), 'image/jpeg');
    await uploadToGlacier(TENANT, INVOICE, '2026-11-16', xml);

    expect(send.mock.calls.map(([, options]) => options)).toEqual([
      limit(Buffer.byteLength(xml)),
      limit(MIB),
      limit(3 * MIB),
      limit(2 * MIB),
      limit(1_000),
      limit(5_000),
      limit(Buffer.byteLength(xml)),
    ]);
  });

  it('przekroczenie w jobie to zwykły błąd, który się ponawia (nie NonRetriableError)', async () => {
    const { NonRetriableError } = await import('@/lib/jobs/errors');
    const error = new StorageTimeoutError('GetObject', 3);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NonRetriableError);
    expect(error.name).toBe('TimeoutError');
  });

  it('worker włącza dłuższe limity magazynu przed startem pg-boss', () => {
    const source = readFileSync(join(process.cwd(), 'lib/jobs/worker.ts'), 'utf8');
    const main = source.slice(source.indexOf('async function main()'));

    expect(main.indexOf('enableWorkerStorageTimeouts();')).toBeGreaterThan(-1);
    expect(main.indexOf('enableWorkerStorageTimeouts();')).toBeLessThan(main.indexOf('await startBoss()'));
  });
});
