'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { RiCameraLine, RiCloseLine } from '@remixicon/react';

import { getOcrJobStatusAction } from '@/app/actions/expenses';

/** Co ile pytamy o stan odczytu. */
const POLL_MS = 4000;
/** Po tylu minutach bez wyniku przestajemy pytać i odsyłamy do Kosztów. */
const GIVE_UP_MS = 3 * 60 * 1000;

type Phase =
  | { kind: 'reading' }
  | { kind: 'done'; expenseId: string | null }
  | { kind: 'failed' }
  | { kind: 'missing' }
  | { kind: 'slow' };

/**
 * Pasek odczytu zdjęcia po udostępnieniu z telefonu (plan kompletnej
 * aplikacji, krok 8.1). `/share-target` przyjmuje zdjęcie, zakłada zadanie
 * odczytu i przekierowuje na `/dashboard?paragon=<zadanie>` (przez `/flo`);
 * pasek z agenta, który miał tu pokazywać postęp, nie jest dziś nigdzie
 * wyświetlany, więc klient nie widział nic. Ten pasek pyta o stan zadania
 * (`getOcrJobStatusAction`, RLS: tylko zadania aktywnej firmy) i mówi: czytamy,
 * gotowe (link do kosztu), nie udało się (droga wyjścia: dodaj wydatek
 * ręcznie), nie znaleźliśmy zadania, trwa dłużej niż zwykle (wynik pojawi się
 * w Kosztach). Wartości `blad` i `brak-zdjecia` pochodzą z trasy udostępniania.
 * Chwilowy błąd odczytu stanu nie kończy czekania (inaczej klient wgrywałby
 * zdjęcie drugi raz i powstał drugi wydatek, E16).
 */
export function OdczytZdjeciaBaner() {
  const paragon = useSearchParams().get('paragon');
  const router = useRouter();
  const pathname = usePathname();
  const [phase, setPhase] = useState<Phase>({ kind: 'reading' });
  const [hiddenFor, setHiddenFor] = useState<string | null>(null);

  const jobId = paragon && paragon !== 'blad' && paragon !== 'brak-zdjecia' ? paragon : null;

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const startedAt = Date.now();

    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const poll = async () => {
      let result;
      try {
        result = await getOcrJobStatusAction(jobId);
      } catch {
        result = { success: false as const, retryable: true as const, error: '' };
      }
      if (cancelled) return;
      if (result.success) {
        const { status, expense_id: expenseId } = result.job;
        if (status === 'completed') {
          stop();
          setPhase({ kind: 'done', expenseId });
          return;
        }
        if (status === 'failed') {
          stop();
          setPhase({ kind: 'failed' });
          return;
        }
      } else if (!result.retryable) {
        stop();
        setPhase({ kind: 'missing' });
        return;
      }
      if (Date.now() - startedAt >= GIVE_UP_MS) {
        stop();
        setPhase({ kind: 'slow' });
      }
    };

    void poll();
    timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      stop();
    };
  }, [jobId]);

  if (!paragon || hiddenFor === paragon) return null;

  let alert = false;
  let text: React.ReactNode;
  if (paragon === 'blad') {
    alert = true;
    text = (
      <>
        Nie udało się przyjąć tego zdjęcia. Spróbuj udostępnić je jeszcze raz albo{' '}
        <Link href="/expenses" className="font-semibold underline underline-offset-4">
          dodaj wydatek w Kosztach
        </Link>
        .
      </>
    );
  } else if (paragon === 'brak-zdjecia') {
    alert = true;
    text = 'Nie dostaliśmy zdjęcia. Spróbuj udostępnić je jeszcze raz.';
  } else if (phase.kind === 'done') {
    text = (
      <>
        Paragon odczytany.{' '}
        <Link href={phase.expenseId ? `/expenses/${phase.expenseId}` : '/expenses'} className="font-semibold underline underline-offset-4">
          Zobacz koszt
        </Link>
        .
      </>
    );
  } else if (phase.kind === 'failed') {
    alert = true;
    text = (
      <>
        Nie udało się odczytać tego zdjęcia.{' '}
        <Link href="/expenses" className="font-semibold underline underline-offset-4">
          Dodaj wydatek ręcznie w Kosztach
        </Link>
        .
      </>
    );
  } else if (phase.kind === 'missing') {
    alert = true;
    text = (
      <>
        Nie znaleźliśmy tego odczytu. Sprawdź listę w{' '}
        <Link href="/expenses" className="font-semibold underline underline-offset-4">
          Kosztach
        </Link>
        , a jeśli kosztu nie ma, udostępnij zdjęcie jeszcze raz.
      </>
    );
  } else if (phase.kind === 'slow') {
    text = (
      <>
        Odczyt trwa dłużej niż zwykle. Wynik pojawi się w{' '}
        <Link href="/expenses" className="font-semibold underline underline-offset-4">
          Kosztach
        </Link>
        , nie musisz tu czekać.
      </>
    );
  } else {
    text = 'Czytamy Twój paragon. Wynik pojawi się tutaj za chwilę.';
  }

  return (
    <div
      data-testid="odczyt-zdjecia-baner"
      role={alert ? 'alert' : 'status'}
      className="mb-6 flex items-start gap-3 border border-[var(--ff-accent)]/25 bg-[var(--ff-accent-tint)] p-4 text-sm leading-relaxed"
    >
      <RiCameraLine aria-hidden className="mt-0.5 size-5 shrink-0 text-[var(--ff-accent)]" />
      <p className="min-w-0 flex-1">{text}</p>
      <button
        type="button"
        aria-label="Zamknij komunikat o odczycie zdjęcia"
        onClick={() => {
          setHiddenFor(paragon);
          router.replace(pathname);
        }}
        className="text-muted-foreground hover:text-foreground -m-1 flex size-9 shrink-0 items-center justify-center"
      >
        <RiCloseLine aria-hidden className="size-5" />
      </button>
    </div>
  );
}
