'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { RiCameraLine, RiCloseLine } from '@remixicon/react';

import { getOcrJobStatusAction } from '@/app/actions/expenses';
import { OCR_POLL, startPollLoop } from '@/lib/polling/poll-loop';

/** Po tylu milisekundach sumy odstępów przestajemy pytać (harmonogram `OCR_POLL`: 2 s, 3 s, 4,5 s, ..., co 10 s). */
const GIVE_UP_MS = 3 * 60 * 1000;

type Outcome = { kind: 'done'; expenseId: string | null } | { kind: 'failed' } | { kind: 'missing' } | { kind: 'slow' };
/** Wynik zawsze z identyfikatorem zadania: przy innym zadaniu w adresie pasek wraca do „czytamy”. */
type Settled = { jobId: string } & Outcome;

/**
 * Pasek odczytu zdjęcia po udostępnieniu z telefonu (plan kompletnej
 * aplikacji, krok 8.1). `/share-target` przyjmuje zdjęcie, zakłada zadanie
 * odczytu i przekierowuje na `/dashboard?paragon=<zadanie>` (przez `/flo`);
 * pasek z agenta, który miał tu pokazywać postęp, nie jest dziś nigdzie
 * wyświetlany, więc klient nie widział nic. Ten pasek pyta o stan zadania
 * (`getOcrJobStatusAction`, RLS: tylko zadania aktywnej firmy) lekką pętlą
 * `startPollLoop` (jedno pytanie naraz, rosnący odstęp, karta w tle nie pyta,
 * limit 3 minut), z pierwszym pytaniem od razu. Mówi: czytamy, gotowe (link do
 * kosztu), nie udało się (zrób wyraźniejsze zdjęcie), nie znaleźliśmy zadania,
 * trwa dłużej niż zwykle (bez obietnicy wyniku). Wartości `blad` i
 * `brak-zdjecia` pochodzą z trasy udostępniania. Chwilowy błąd odczytu stanu
 * nie kończy czekania (inaczej klient wgrywałby zdjęcie drugi raz i powstał
 * drugi wydatek, E16).
 */
export function OdczytZdjeciaBaner() {
  const searchParams = useSearchParams();
  const paragon = searchParams.get('paragon');
  const router = useRouter();
  const pathname = usePathname();
  const [settled, setSettled] = useState<Settled | null>(null);
  const [hiddenFor, setHiddenFor] = useState<string | null>(null);

  const jobId = paragon && paragon !== 'blad' && paragon !== 'brak-zdjecia' ? paragon : null;
  // Wynik dotyczy zadania, dla którego go zapisano; inne zadanie w adresie to znów „czytamy”.
  const phase: { kind: 'reading' } | Outcome = settled && settled.jobId === jobId ? settled : { kind: 'reading' };

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let stop: () => void = () => {};
    const finish = (outcome: Outcome) => {
      if (cancelled) return;
      stop();
      setSettled({ jobId, ...outcome });
    };

    // Jedno pytanie naraz także dla pierwszego pytania sprzed pętli.
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      let result;
      try {
        result = await getOcrJobStatusAction(jobId);
      } catch {
        result = { success: false as const, retryable: true as const, error: '' };
      } finally {
        busy = false;
      }
      if (cancelled) return;
      if (result.success) {
        if (result.job.status === 'completed') finish({ kind: 'done', expenseId: result.job.expense_id });
        else if (result.job.status === 'failed') finish({ kind: 'failed' });
      } else if (!result.retryable) {
        finish({ kind: 'missing' });
      }
    };

    // Pierwsze pytanie od razu, potem pętla (jedno pytanie naraz).
    void poll();
    stop = startPollLoop({
      schedule: { ...OCR_POLL, budgetMs: GIVE_UP_MS },
      poll,
      onBudgetSpent: () => finish({ kind: 'slow' }),
    });
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
        Nie udało się odczytać tego zdjęcia. Zrób wyraźniejsze zdjęcie i dodaj je{' '}
        <Link href="/expenses" className="font-semibold underline underline-offset-4">
          w Kosztach
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
        Odczyt trwa dłużej niż zwykle. Gotowy koszt pojawi się w{' '}
        <Link href="/expenses" className="font-semibold underline underline-offset-4">
          Kosztach
        </Link>
        . Jeśli nie pojawi się w ciągu kilkunastu minut, dodaj zdjęcie jeszcze raz.
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
          // Usuwamy tylko `paragon`, inne parametry adresu zostają.
          const rest = new URLSearchParams(searchParams.toString());
          rest.delete('paragon');
          const query = rest.toString();
          router.replace(query ? `${pathname}?${query}` : pathname);
        }}
        className="text-muted-foreground hover:text-foreground -m-1 flex size-9 shrink-0 items-center justify-center"
      >
        <RiCloseLine aria-hidden className="size-5" />
      </button>
    </div>
  );
}
