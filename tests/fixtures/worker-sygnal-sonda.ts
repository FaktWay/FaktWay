/**
 * Sonda G1-START dla `tests/unit/worker-sygnal-przy-starcie.test.ts`. Test
 * uruchamia ją z TYMI SAMYMI flagami Node co CMD etapu `worker` w Dockerfile,
 * więc Node wczytuje ją tak jak `lib/jobs/worker.ts`. Tylko Linux: na Windowsie
 * `process.kill` kończy proces od razu.
 *
 * W trakcie wczytywania wejścia wysyła sobie SIGTERM, jak Docker przy zatrzymaniu
 * kontenera, i sprawdza, czy sygnał dociera do zamykania przed bramką
 * `receiveQueuedSignals()`, czyli zanim worker połączyłby się z bazą.
 * Wypisuje jedną linię JSON i kończy się kodem 0.
 */
import { onShutdownSignal, receiveQueuedSignals, shutdownRequested } from '../../lib/jobs/shutdown-signals';

let odebrany: string | null = null;

process.kill(process.pid, 'SIGTERM');
// Sygnał może trafić do innego wątku procesu; handler libuv i tak zapisze go do
// potoku sygnałów pętli. Chwila synchronicznego czekania daje mu na to czas.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);

// Jak w worker.ts: zamykanie podpięte po wczytaniu modułów, tuż przed bramką.
onShutdownSignal((signal) => {
  odebrany ??= signal;
});
// Słuchacz JS nie działa w środku synchronicznego kodu: tu sygnału jeszcze nie ma.
const przedPetla = odebrany;

// Co zobaczyłaby bramka z jednym obrotem pętli: to `setImmediate` idzie przed jej pierwszym.
let poJednymObrocie: string | null = null;
setImmediate(() => {
  poJednymObrocie = odebrany;
});

void receiveQueuedSignals().then(() => {
  console.log(JSON.stringify({ przedPetla, poJednymObrocie, poBramce: odebrany, shutdownRequested: shutdownRequested() }));
  process.exit(0);
});
