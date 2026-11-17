'use client';

import Link from 'next/link';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { RiCloseLine, RiInformationLine } from '@remixicon/react';

import { ZMIANY_2027_ARTICLE_SLUG, zmiany2027Widoczne } from '@/lib/zmiany-2027/okno';

/**
 * Komunikat na pulpicie o zmianach z 1 stycznia 2027 r. (plan kompletnej
 * aplikacji, krok 1.6, część 2a): koniec wyjątku dla sprzedaży do 10 000 zł
 * brutto miesięcznie, faktura do paragonu, numer KSeF w tytule przelewu.
 * Informacja ogólna, nie porada podatkowa (D8): odsyła do artykułu w pomocy
 * i do źródła urzędowego, a szczegóły sytuacji firmy zostawia księgowej.
 *
 * Zamknięcie jest zapamiętane osobno dla każdego użytkownika, w tej
 * przeglądarce (`localStorage`, klucz z identyfikatorem użytkownika), bez
 * zapisu w bazie. Przeglądarka bez dostępu do pamięci lokalnej: komunikat
 * działa, a zamknięcie trzyma się do odświeżenia strony.
 */
const KEY_PREFIX = 'faktway:zmiany-2027:';
const ZRODLO_MF = 'https://ksef.podatki.gov.pl/informacje-ogolne-ksef-20/zakres-obowiazkowego-ksef/';
const EVENT = 'faktway:zmiany-2027-zamkniete';

function czyZamkniete(userId: string): boolean {
  try {
    return window.localStorage.getItem(KEY_PREFIX + userId) === '1';
  } catch {
    return false;
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(EVENT, onChange);
  };
}

export function Zmiany2027Baner({ userId, today }: { userId: string; today: string }) {
  // Serwer i pierwszy render w przeglądarce: „zamknięte” (bez migania komunikatu
  // u kogoś, kto go już zamknął); po hydratacji czytamy pamięć lokalną.
  const zamknieteZapisane = useSyncExternalStore(
    subscribe,
    () => czyZamkniete(userId),
    () => true,
  );
  // Gdy pamięć lokalna jest zablokowana, zamknięcie trzyma się w stanie do odświeżenia.
  const [zamknieteDlaUzytkownika, setZamknieteDlaUzytkownika] = useState<string | null>(null);

  const zamknij = useCallback(() => {
    setZamknieteDlaUzytkownika(userId);
    try {
      window.localStorage.setItem(KEY_PREFIX + userId, '1');
      window.dispatchEvent(new Event(EVENT));
    } catch {
      // Bez pamięci lokalnej komunikat wróci po odświeżeniu strony.
    }
  }, [userId]);

  if (!zmiany2027Widoczne(today) || zamknieteZapisane || zamknieteDlaUzytkownika === userId) return null;

  return (
    <section
      data-testid="zmiany-2027-baner"
      aria-labelledby="zmiany-2027-tytul"
      role="region"
      className="mb-6 flex items-start gap-3 border border-[var(--ff-accent)]/25 bg-[var(--ff-accent-tint)] p-4"
    >
      <RiInformationLine aria-hidden className="mt-0.5 size-5 shrink-0 text-[var(--ff-accent)]" />
      <div className="min-w-0 flex-1 text-sm leading-relaxed">
        <h2 id="zmiany-2027-tytul" className="font-semibold">
          Zmiany od 1 stycznia 2027 r.
        </h2>
        <p className="mt-1">
          Od 1 stycznia 2027 r. według źródeł urzędowych kończy się wyjątek dla sprzedaży do 10 000 zł brutto miesięcznie
          (KSeF dla wszystkich), zmieniają się zasady dla faktury do paragonu, a w przelewach między firmami w tytule
          podaje się numer KSeF faktury. To informacja ogólna, nie porada podatkowa: jak to dotyczy Twojej firmy, ustal z
          księgową.
        </p>
        <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          <Link href={`/pomoc/${ZMIANY_2027_ARTICLE_SLUG}`} className="font-semibold text-[var(--ff-accent)] underline-offset-4 hover:underline">
            Zobacz, co się zmienia i co robi FaktWay
          </Link>
          <a
            href={ZRODLO_MF}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground underline underline-offset-4"
          >
            Źródło: Ministerstwo Finansów
          </a>
        </p>
      </div>
      <button
        type="button"
        onClick={zamknij}
        aria-label="Zamknij komunikat o zmianach od 1 stycznia 2027 r."
        className="text-muted-foreground hover:text-foreground -m-1 flex size-9 shrink-0 items-center justify-center"
      >
        <RiCloseLine aria-hidden className="size-5" />
      </button>
    </section>
  );
}
