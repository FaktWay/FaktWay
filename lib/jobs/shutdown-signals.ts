/**
 * Sygnały zatrzymania workera od pierwszej linii `worker.ts` (G1-START).
 *
 * W kontenerze worker to PID 1, a jądro odrzuca sygnał, dla którego PID 1 nie
 * ma handlera. Do 15.11.2026 handler powstawał na końcu `main()`, więc SIGTERM
 * w trakcie wczytywania modułów, startu pg-boss albo zakładania kolejek
 * przepadał: worker startował dalej i po czasie łaski dostawał SIGKILL.
 *
 * Ten moduł jest PIERWSZYM importem `worker.ts` i sam niczego nie importuje
 * (pilnuje `tests/unit/worker-sygnal-przy-starcie.test.ts`). Sygnał sprzed
 * podpięcia zamykania czeka tu, aż `onShutdownSignal()` je poda. Zostaje okno
 * przed pierwszą linią `worker.ts` (start Node, `--import tsx`, kompilacja
 * wejścia); zamyka je dopiero init w kontenerze, czyli zmiana CMD albo Coolify.
 *
 * Tylko dla workera: proces, który zaimportuje ten moduł i nie poda zamykania,
 * przestaje kończyć się na SIGTERM.
 */

export type ShutdownSignal = 'SIGTERM' | 'SIGINT';

type ShutdownHandler = (signal: ShutdownSignal) => void;

let firstSignal: ShutdownSignal | null = null;
let handler: ShutdownHandler | null = null;

function receive(signal: ShutdownSignal): void {
  firstSignal ??= signal;
  handler?.(signal);
}

process.on('SIGTERM', () => receive('SIGTERM'));
process.on('SIGINT', () => receive('SIGINT'));

/**
 * Czy zatrzymanie już dotarło. Start sprawdza to przed połączeniem z bazą oraz
 * przed każdym `work()`, `schedule()` i healthcheckiem; krok w toku kończy się normalnie.
 */
export function shutdownRequested(): boolean {
  return firstSignal !== null;
}

/**
 * Podpina zamykanie. Każdy kolejny sygnał woła je jeszcze raz (jak dotąd:
 * `stopBoss()` oddaje to samo zamykanie), a sygnał sprzed podpięcia od razu.
 */
export function onShutdownSignal(next: ShutdownHandler): void {
  handler = next;
  if (firstSignal) next(firstSignal);
}

/**
 * Dwa obroty pętli zdarzeń: sygnał z czasu wczytywania modułów dociera do
 * zamykania, zanim worker połączy się z bazą. Node woła słuchaczy sygnałów
 * w fazie poll. Gdy wejście wykonało się przed pętlą albo w innej fazie, sygnał
 * dociera w najbliższej fazie poll, przed pierwszym `setImmediate`. Gdy wykonało
 * się w fazie poll (loader wczytał je asynchronicznie; zależy od wersji Node
 * i tsx), dociera dopiero w fazie poll następnego obrotu: po pierwszym
 * `setImmediate`, przed drugim.
 */
export function receiveQueuedSignals(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}
