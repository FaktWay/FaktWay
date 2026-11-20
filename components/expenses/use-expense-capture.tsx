'use client';

import { useEffect, useRef, useState, useTransition, type ReactNode } from 'react';
import { unstable_isUnrecognizedActionError, useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { getOcrJobStatusAction } from '@/app/actions/expenses';
import { sendExpenseFile } from '@/lib/expenses/photo-upload';
import { OCR_POLL, nextPollDelay } from '@/lib/polling/poll-loop';
import { postExpenseUpload } from '@/lib/uploads/client';

/** Limit czekania na odczyt zdjęcia (komunikat „Przekroczono czas oczekiwania (60 s).”). */
const OCR_TIMEOUT_MS = 60_000;
/** Ostatnie pytanie o odczyt: 2 s przed limitem. */
const OCR_LAST_POLL_MS = OCR_TIMEOUT_MS - 2000;
/**
 * Tyle odrzuconych z rzędu pytań (poza brakiem sieci) daje jedno
 * `router.refresh()`, jak w `hooks/use-status-poll.ts`. Tak bramka logowania
 * (`proxy.ts`) odpowiada na akcję po wygaśnięciu sesji: przekierowaniem,
 * którego akcja nie przeczyta, a odświeżenie strony za nim pójdzie. Nie od
 * pierwszego razu: chwilowe 502 przy restarcie serwera daje to samo
 * odrzucenie, a odświeżenie przeniosłoby kartę na stronę błędu.
 */
const OCR_REJECTIONS_BEFORE_REFRESH = 3;

export type CaptureState =
  | { kind: 'idle' }
  | { kind: 'uploading' }
  | { kind: 'processing'; jobId: string }
  | { kind: 'failed'; error: string };

/**
 * Dodanie kosztu ze zdjęcia albo pliku: wgranie, odpytywanie odczytu (OCR)
 * i przejście do rozpoznanego wydatku. Wspólne dla przycisku „+ Dodaj
 * wydatek” na Kosztach i plusa dolnego paska telefonu — obie drogi muszą
 * zachowywać się tak samo (E16: chwilowy błąd nie kończy czekania).
 * Nowe wdrożenie i bramka logowania w trakcie czekania kończą się
 * odświeżeniem strony, a nie komunikatem o czasie.
 *
 * `inputs` trzeba wyrenderować: to ukryte pola pliku, które otwierają aparat
 * i galerię. `click()` na nich musi paść w obsłudze dotknięcia, inaczej iOS
 * nie otworzy aparatu.
 */
export function useExpenseCapture({
  onFileChosen,
}: {
  /** Plik wybrany — np. zamknięcie arkusza z wyborem źródła. */
  onFileChosen?: () => void;
} = {}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<CaptureState>({ kind: 'idle' });
  const [, startUpload] = useTransition();

  const processingJobId =
    state.kind === 'processing' ? state.jobId : null;

  useEffect(() => {
    if (!processingJobId) return;

    const jobId = processingJobId;
    let cancelled = false;
    const timers: {
      tick?: ReturnType<typeof setTimeout>;
      deadline?: ReturnType<typeof setTimeout>;
    } = {};
    const stopTicks = () => {
      if (timers.tick) clearTimeout(timers.tick);
      timers.tick = undefined;
    };
    // Jedno pytanie naraz: odpowiedź wolniejsza niż takt nie może
    // nakładać się na następne — dwie odpowiedzi „completed” dałyby
    // podwójny toast i podwójne przejście do wydatku.
    let inFlight = false;
    // Odrzucone pytania z rzędu; odpowiedź serwera liczy od nowa.
    let rejections = 0;

    async function pollOnce() {
      if (cancelled || inFlight) return;
      inFlight = true;
      let status: Awaited<ReturnType<typeof getOcrJobStatusAction>>;
      try {
        status = await getOcrJobStatusAction(jobId);
      } catch (error) {
        // Odrzucona obietnica akcji: stan zadania nieznany.
        inFlight = false;
        if (cancelled) return;
        if (unstable_isUnrecognizedActionError(error)) {
          // Nowe wdrożenie: serwer nie zna akcji ze starego buildu, więc
          // dalsze pytania nic nie dadzą, a komunikat o czasie po 60 s
          // skłoniłby klienta do drugiego wgrania, choć odczyt mógł już
          // utworzyć wydatek. Odświeżenie wykryje inny build i przeładuje
          // kartę; do tego czasu przycisk czeka zablokowany.
          cancelled = true;
          stopTicks();
          clearTimeout(timers.deadline);
          router.refresh();
          return;
        }
        // Brak sieci (`fetch` rzuca `TypeError`): pytamy przy następnym takcie.
        if (error instanceof TypeError) return;
        // Inne odrzucenie (chwilowe 502 przy restarcie, przekierowanie bramki
        // logowania): pytamy dalej, a trzecie z rzędu odświeża stronę.
        rejections += 1;
        if (rejections < OCR_REJECTIONS_BEFORE_REFRESH) return;
        rejections = 0;
        router.refresh();
        return;
      }
      inFlight = false;
      rejections = 0;
      if (cancelled) return;

      if (!status.success) {
        // Chwilowy błąd odczytu: zadanie mogło się udać, więc nie pokazujemy
        // porażki (klient wgrałby zdjęcie drugi raz → drugi wydatek). Pytamy
        // dalej; limit 60 s niżej i tak zakończy czekanie.
        if (status.retryable) return;
        stopTicks();
        setState({ kind: 'failed', error: status.error });
        toast.error(status.error);
        return;
      }

      if (status.job.status === 'completed' && status.job.expense_id) {
        stopTicks();
        toast.success('Wydatek rozpoznany!');
        router.push(`/expenses/${status.job.expense_id}`);
        setState({ kind: 'idle' });
        return;
      }

      if (status.job.status === 'failed') {
        stopTicks();
        setState({
          kind: 'failed',
          error: status.job.error_message ?? 'Nieznany błąd',
        });
        toast.error('Nie udało się rozpoznać');
      }
    }

    // Pytanie od razu, potem takty z rosnącym odstępem: 2 s, 3 s, 4,5 s,
    // 6,75 s i co 10 s, a ostatni 2 s przed limitem, jak przy dawnym takcie
    // co 2 s (plan skalowania, sesja 11; dawniej 31 pytań na minutę, teraz
    // 10). Bez ostatniego odczyt gotowy w ostatnich sekundach skończyłby się
    // komunikatem o czasie i drugim wgraniem zdjęcia. Takt w trakcie pytania
    // przepada. Na karcie w tle pytamy dalej: limit 60 s niżej liczy czas
    // ścienny, więc pauza kończyłaby czekanie porażką zaraz po powrocie.
    let gap = OCR_POLL.firstMs;
    let scheduledMs = 0;
    const scheduleTick = () => {
      const wait = Math.min(gap, OCR_LAST_POLL_MS - scheduledMs);
      if (wait <= 0) return;
      scheduledMs += wait;
      timers.tick = setTimeout(() => {
        gap = nextPollDelay(gap, OCR_POLL);
        scheduleTick();
        void pollOnce();
      }, wait);
    };
    void pollOnce();
    scheduleTick();

    timers.deadline = setTimeout(() => {
      cancelled = true;
      stopTicks();
      setState((s) =>
        s.kind === 'processing' && s.jobId === jobId
          ? {
              kind: 'failed',
              error: 'Przekroczono czas oczekiwania (60 s).',
            }
          : s,
      );
      toast.error('Przekroczono czas oczekiwania');
    }, OCR_TIMEOUT_MS);

    return () => {
      cancelled = true;
      stopTicks();
      clearTimeout(timers.deadline);
    };
  }, [processingJobId, router]);

  const handleFile = (file: File) => {
    onFileChosen?.();
    setState({ kind: 'uploading' });

    startUpload(async () => {
      // Zdjęcie zmniejszone, plik ponad limit zatrzymany z komunikatem
      // (sesja 4), wysyłka trasą `/api/uploads/expense` zamiast Server
      // Action z limitem 1 MB (sesja 31).
      const result = await sendExpenseFile(file, postExpenseUpload);

      if (!result.success) {
        setState({ kind: 'failed', error: result.error });
        toast.error(result.error);
        return;
      }

      setState({ kind: 'processing', jobId: result.ocrJobId });
    });
  };

  const inputs: ReactNode = (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          e.target.value = '';
        }}
      />
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/*,application/pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          e.target.value = '';
        }}
      />
    </>
  );

  return {
    state,
    busy: state.kind === 'uploading' || state.kind === 'processing',
    openCamera: () => fileInputRef.current?.click(),
    openGallery: () => galleryInputRef.current?.click(),
    inputs,
  };
}
