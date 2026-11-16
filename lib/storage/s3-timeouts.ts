import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';

/**
 * Limity czasu klientów S3: magazyn plików aplikacji (`r2-client.ts`)
 * i archiwum Glacier (`glacier.ts`). Plan skalowania 3000, sesja 5 (LIM-05),
 * reszta z opisu #732.
 *
 * AWS SDK sam nie ma żadnego limitu. Zawieszony magazyn (przyjmuje połączenie
 * i milczy) trzymał więc żądanie strony albo zadanie workera bez końca.
 * Klient dostaje trzy limity (`NodeHttpHandler` z biblioteki):
 *
 *  - połączenie (`connectionTimeout`): samo zestawienie połączenia TCP;
 *  - odpowiedź (`requestTimeout`): od wysłania żądania do nagłówków odpowiedzi,
 *    razem z wysłaniem treści, więc przy wgraniu to czas całego pliku. Bez
 *    `throwOnRequestTimeout` biblioteka po limicie tylko ostrzega w logu
 *    i czeka dalej;
 *  - cisza (`socketTimeout`): gniazdo bez ruchu w obie strony, także przy
 *    czytaniu treści po nagłówkach. Łapie magazyn, który wysłał nagłówki
 *    i stanął: czytanie treści kończy się wtedy błędem `TimeoutError`
 *    biblioteki, bez ponowienia (treść czyta wywołujący).
 *
 * Limity połączenia i odpowiedzi biegną od startu żądania w bibliotece, razem
 * z czekaniem na wolne gniazdo w puli klienta (50 gniazd). Przy ponad 50
 * równoległych żądaniach do wolnego magazynu część z nich dostaje więc błąd
 * limitu połączenia, zanim w ogóle dostanie gniazdo.
 *
 * Profile jak w `lib/supabase/fetch-timeout.ts`: żądanie strony krótko, worker
 * pg-boss dłużej (`enableWorkerStorageTimeouts` przy starcie workera). Wgranie
 * ma limit odpowiedzi dłuższy o czas pliku przy 1 MiB/s (`uploadRequestOptions`),
 * więc kopia bazy i paczka archiwum mieszczą się w limicie, a zawieszony
 * magazyn i tak łapie limit ciszy.
 *
 * Ponowienia są jawne (`maxAttempts`, razem z pierwszą próbą). Biblioteka
 * ponawia błędy przejściowe (limit, zerwane połączenie, 5xx) po krótkiej
 * przerwie. Pula ponowień klienta (500 żetonów, 14 za ponowienie po błędzie
 * przejściowym, udane wywołanie oddaje 1) wyłącza ponowienia po ok. 35
 * ponowieniach w długiej awarii, więc awaria nie mnoży czekania.
 *
 * Przekroczenie limitu przy `send` to `StorageTimeoutError` (`name`
 * 'TimeoutError', nazwa operacji i liczba prób w treści, błąd biblioteki
 * w `cause`), bez klucza i identyfikatorów. W jobie to zwykły błąd, więc job
 * się ponawia.
 */

export type StorageTimeouts = {
  /** Zestawienie połączenia TCP. */
  readonly connectMs: number;
  /** Od wysłania żądania do nagłówków odpowiedzi; przy wgraniu dochodzi czas pliku. */
  readonly responseMs: number;
  /** Gniazdo bez ruchu w obie strony, także przy czytaniu treści odpowiedzi. */
  readonly idleMs: number;
  /** Wszystkie próby jednego wywołania, z pierwszą. */
  readonly maxAttempts: number;
};

/** Żądanie strony (RSC, akcja, trasa API): zawieszony magazyn to błąd po ok. 2 × 10 s. */
export const REQUEST_STORAGE_TIMEOUTS: StorageTimeouts = {
  connectMs: 3_000,
  responseMs: 10_000,
  idleMs: 10_000,
  maxAttempts: 2,
};

/** Worker pg-boss: zawieszony magazyn to błąd po ok. 3 × 60 s, potem ponowienie joba. */
export const WORKER_STORAGE_TIMEOUTS: StorageTimeouts = {
  connectMs: 5_000,
  responseMs: 60_000,
  idleMs: 60_000,
  maxAttempts: 3,
};

/**
 * Najwolniejsze przyjęte tempo wgrania: 1 MiB/s, z dużym zapasem wobec
 * zwykłego tempa do magazynu. Paczka archiwum (do 150 MiB) dostaje
 * w workerze 60 s + 150 s na próbę.
 */
export const UPLOAD_MIN_BYTES_PER_SECOND = 1024 * 1024;

let processTimeouts: StorageTimeouts = REQUEST_STORAGE_TIMEOUTS;

/**
 * Proces workera pg-boss: dłuższe limity. Klient magazynu powstaje przy
 * pierwszym użyciu, a zmiana profilu tworzy nowego, więc obejmuje to też
 * kod, który użył magazynu przed `main()` workera.
 */
export function enableWorkerStorageTimeouts(): void {
  processTimeouts = WORKER_STORAGE_TIMEOUTS;
}

/**
 * Tylko testy: własne limity procesu (setne części sekundy zamiast sekund),
 * żeby atrapa zawieszonego magazynu nie trzymała testu. `null` przywraca
 * limity żądania strony.
 */
export function setStorageTimeoutsForTests(timeouts: StorageTimeouts | null): void {
  processTimeouts = timeouts ?? REQUEST_STORAGE_TIMEOUTS;
}

/** Limity bieżącego procesu (żądanie strony albo worker). */
export function storageTimeouts(): StorageTimeouts {
  return processTimeouts;
}

/** Część konfiguracji `new S3Client`: limity profilu i liczba prób. */
export function s3TimeoutConfig(timeouts: StorageTimeouts): Pick<S3ClientConfig, 'maxAttempts' | 'requestHandler'> {
  return {
    maxAttempts: timeouts.maxAttempts,
    requestHandler: {
      connectionTimeout: timeouts.connectMs,
      requestTimeout: timeouts.responseMs,
      socketTimeout: timeouts.idleMs,
      // Bez tego przekroczony limit odpowiedzi to tylko ostrzeżenie w logu.
      throwOnRequestTimeout: true,
    },
  };
}

/**
 * Opcje `send` przy wgraniu (`PutObject`): limit odpowiedzi plus czas pliku
 * przy `UPLOAD_MIN_BYTES_PER_SECOND`, bo nagłówki odpowiedzi przychodzą
 * dopiero po wysłaniu całej treści.
 */
export function uploadRequestOptions(
  bytes: number,
  timeouts: StorageTimeouts = processTimeouts,
): { requestTimeout: number } {
  return { requestTimeout: timeouts.responseMs + Math.ceil((bytes * 1000) / UPLOAD_MIN_BYTES_PER_SECOND) };
}

export class StorageTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';

  constructor(
    /** Operacja S3, np. `GetObject`. */
    readonly operation: string,
    /** Liczba prób razem z pierwszą. */
    readonly attempts: number,
    options?: { cause?: unknown },
  ) {
    super(`Magazyn plików nie odpowiedział w limicie czasu (${operation}, prób: ${attempts})`, options);
    this.name = 'TimeoutError';
  }
}

/**
 * Błąd limitu z biblioteki (połączenie, odpowiedź, cisza) jako
 * `StorageTimeoutError`; każdy inny błąd bez zmian.
 */
export function asStorageTimeoutError(error: unknown, operation: string): unknown {
  if (error instanceof StorageTimeoutError || !isLibraryTimeout(error)) return error;
  const attempts = (error as { $metadata?: { attempts?: unknown } }).$metadata?.attempts;
  return new StorageTimeoutError(operation, typeof attempts === 'number' ? attempts : 1, { cause: error });
}

function isLibraryTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  // Biblioteka nazywa 'TimeoutError' także zerwane połączenie (ECONNRESET,
  // EPIPE). To nie limit czasu, więc zostaje swoim błędem.
  return name === 'TimeoutError' && (code === undefined || code === 'ETIMEDOUT');
}

/**
 * Dokleja do klienta zamianę błędu limitu na `StorageTimeoutError`, po
 * wszystkich próbach (krok `initialize` jest na zewnątrz ponowień).
 */
export function withStorageTimeoutErrors(client: S3Client): S3Client {
  client.middlewareStack.add(
    (next, context) => async (args) => {
      try {
        return await next(args);
      } catch (error) {
        throw asStorageTimeoutError(error, (context.commandName ?? 'S3').replace(/Command$/, ''));
      }
    },
    { step: 'initialize', name: 'faktwayStorageTimeoutError', priority: 'high' },
  );
  return client;
}
