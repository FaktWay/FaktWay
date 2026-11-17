import type { AutosaveStatus } from './use-form-autosave';

const WARSAW = 'Europe/Warsaw';

/** „15 listopada, 18:30” w czasie polskim (stała strefa: ten sam tekst na serwerze i w przeglądarce). */
function whenLabel(iso: string): string {
  return new Date(iso).toLocaleString('pl-PL', { timeZone: WARSAW, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString('pl-PL', { timeZone: WARSAW, hour: '2-digit', minute: '2-digit' });
}

/** Propozycja przywrócenia niezakończonej pracy (kopia z autozapisu, krok 2.8). */
export function AutosaveRestoreBanner({
  savedAt,
  onRestore,
  onDiscard,
}: {
  savedAt: string;
  onRestore: () => void;
  onDiscard: () => void;
}) {
  return (
    <div role="region" aria-label="Niezapisana faktura" className="border border-[var(--ff-accent)]/25 bg-[var(--ff-accent-tint)] p-4 text-sm leading-relaxed">
      <p>
        Masz niezapisaną fakturę z {whenLabel(savedAt)}. Przywrócić ją? Numer i daty ustawimy od nowa, resztę wpiszemy
        w formularz tak, jak była.
      </p>
      <div className="mt-3 flex flex-wrap gap-4">
        <button type="button" onClick={onRestore} className="font-semibold text-[var(--ff-accent)] underline-offset-4 hover:underline">
          Przywróć
        </button>
        <button type="button" onClick={onDiscard} className="text-muted-foreground font-semibold underline-offset-4 hover:underline">
          Zacznij od nowa
        </button>
      </div>
    </div>
  );
}

/** Mały wiersz stanu autozapisu pod nagłówkiem formularza. */
export function AutosaveStatusLine({ status }: { status: AutosaveStatus }) {
  if (status.kind === 'idle') return null;
  let text = '';
  if (status.kind === 'saved') text = `Autozapis: kopia robocza zapisana o ${timeLabel(status.at)}.`;
  if (status.kind === 'failed') text = 'Autozapis niedostępny. Zapisz szkic ręcznie, żeby nie stracić pracy.';
  return (
    <p aria-live="polite" className={status.kind === 'failed' ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>
      {text}
    </p>
  );
}
