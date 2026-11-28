/** PostgREST may cap a successful response. A partial accounting read is an error. */
export const ACCOUNTING_PAGE_SIZE = 500;

/** Najwięcej odczytów jednego kompletu stron (FZ-031, D70). */
const MAX_ODCZYTOW = 3;

/**
 * Migawka przy odczycie stronami (FZ-031, D70). Odczyt z jednej strony to
 * jedna migawka i zostaje jak jest. Odczyt z więcej niż jednej strony jest
 * czytany drugi raz tym samym zapytaniem i porównywany wiersz po wierszu
 * (wszystkie wybrane kolumny, w kolejności `id`): równe to wynik, różne to
 * kolejny odczyt, najwyżej trzy w sumie. Bez dwóch równych z rzędu wyjątek
 * „niestabilna kolejność stron danych”. Odczyt po zmianie różni się od
 * mieszanego (część przed zmianą, część po niej), więc zmiany po obu stronach
 * kursora naraz nie przechodzą. Wymaga, by wybrane kolumny nie zależały od
 * czasu odczytu (nie liczone z `now()`).
 */
async function zPodwojnymOdczytem<T extends { id: string }>(
  label: string,
  odczyt: () => Promise<{ rows: T[]; pages: number }>,
): Promise<T[]> {
  const pierwszy = await odczyt();
  if (pierwszy.pages <= 1) return pierwszy.rows;
  let poprzedni = pierwszy.rows;
  for (let n = 1; n < MAX_ODCZYTOW; n += 1) {
    const kolejny = (await odczyt()).rows;
    if (takieSameWiersze(poprzedni, kolejny)) return kolejny;
    poprzedni = kolejny;
  }
  throw new Error(`${label}: niestabilna kolejność stron danych`);
}

function takieSameWiersze<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false;
  }
  return true;
}

type Page<T> = {
  data: T[] | null;
  count: number | null;
  error: { message: string } | null;
};

/**
 * Komplet wierszy zakresami (`range` z `count: 'exact'` przy każdej stronie).
 * Każda strona po pierwszej zaczyna się od ostatniego przeczytanego wiersza
 * (zakładka): gdy w trakcie odczytu ktoś usunie albo dopisze wiersz w części
 * już przeczytanej, zakresy przesuwają się i zakładka jest innym wierszem,
 * więc odczyt kończy się wyjątkiem, a nie listą z dwóch stanów, także gdy
 * druga zmiana w części nieprzeczytanej zachowuje liczbę wierszy (FZ-017).
 * Strona ma dalej najwyżej `ACCOUNTING_PAGE_SIZE` wierszy (z zakładką), więc
 * mieści się w limicie serwera; każda dalsza strona daje o jeden nowy wiersz
 * mniej, więc czasem potrzeba jednej strony więcej. Zmiany po obu stronach
 * kursora naraz (wiersz usunięty i dopisany przed zakładką oraz za nią) łapie
 * podwójny odczyt (FZ-031, D70, `zPodwojnymOdczytem`).
 */
export async function readCompletePages<T extends { id: string }>(
  label: string,
  fetchPage: (from: number, to: number) => PromiseLike<Page<T>>,
): Promise<T[]> {
  return zPodwojnymOdczytem(label, () => readPagesOnce(label, fetchPage));
}

async function readPagesOnce<T extends { id: string }>(
  label: string,
  fetchPage: (from: number, to: number) => PromiseLike<Page<T>>,
): Promise<{ rows: T[]; pages: number }> {
  const rows: T[] = [];
  let pages = 0;
  let total: number | null = null;
  let lastId: string | null = null;

  while (total === null || rows.length < total) {
    // Zakładka: od drugiej strony zakres zaczyna się od ostatniego przeczytanego wiersza.
    const from = rows.length === 0 ? 0 : rows.length - 1;
    const page = await fetchPage(from, from + ACCOUNTING_PAGE_SIZE - 1);
    pages += 1;
    if (page.error) throw new Error(`${label}: ${page.error.message}`);
    if (!page.data || typeof page.count !== 'number' ||
        !Number.isSafeInteger(page.count) || page.count < 0 ||
        (total !== null && page.count !== total)) {
      throw new Error(`${label}: nie można potwierdzić liczby rekordów`);
    }
    total = page.count;
    const zakladka = rows.length === 0 ? 0 : 1;
    // Inny wiersz na miejscu zakładki: zakresy przesunęły się (zapis w części przeczytanej) albo serwer zmienił kolejność.
    if (zakladka === 1 && page.data.length > 0 && page.data[0]?.id !== lastId) {
      throw new Error(`${label}: niestabilna kolejność stron danych`);
    }
    // Od drugiej strony brakuje co najmniej dwóch wierszy (zakładka i następny), więc pełna strona zawsze posuwa odczyt.
    if (page.data.length !== Math.min(ACCOUNTING_PAGE_SIZE, Math.max(0, total - from))) {
      throw new Error(`${label}: niepełna strona danych`);
    }
    for (const row of page.data.slice(zakladka)) {
      // Callers page by immutable id; a duplicate/reordered row must not be
      // counted twice as a different invoice or cost.
      if (typeof row.id !== 'string' || !row.id ||
          (lastId !== null && row.id <= lastId)) {
        throw new Error(`${label}: niestabilna kolejność stron danych`);
      }
      rows.push(row);
      lastId = row.id;
    }
  }

  return { rows, pages };
}

/** Strona odczytu po kluczu: `count` tylko tam, gdzie zapytanie go prosiło. */
type KeysetPage<T> = {
  data: T[] | null;
  count?: number | null;
  error: { message: string } | null;
};

/**
 * Zapytanie strony dla `readCompletePagesByKey`. Za każdym razem świeży
 * builder z tymi samymi filtrami:
 * `select(kolumny, count ? { count: 'exact', head } : undefined)`, potem
 * `gt('id', afterId)` przy `afterId !== null`, `order('id')` i `limit(limit)`.
 */
export type KeysetPageQuery = {
  afterId: string | null;
  limit: number;
  /** `count: 'exact'` — pierwsza strona i licznik kontrolny. */
  count: boolean;
  /** Sam licznik, bez wierszy (licznik kontrolny po kilku stronach). */
  head: boolean;
};

const validCount = (count: number | null | undefined): count is number =>
  typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;

/**
 * To samo co `readCompletePages` — komplet wierszy albo błąd — taniej przy
 * kilku stronach (QRY-07, sesja 19 planu skalowania): `count` liczy baza
 * tylko przy pierwszej stronie, kolejne strony idą po kluczu
 * (`id > ostatni`, bez OFFSET), a przy więcej niż jednej stronie na końcu
 * jeden licznik kontrolny (`head`). `readCompletePages` liczy COUNT nad
 * całym filtrem przy KAŻDEJ stronie i przewija OFFSET-em. Od sesji 33 po
 * kluczu czytają też KPiR, ewidencja przychodów i eksporty (złoty wzorzec
 * wyników: `tests/unit/kpir-eksporty-po-kluczu.test.ts`); `readCompletePages`
 * zostaje dla pozostałych odczytów, dopóki nie przeniesie ich osobna sesja.
 *
 * Bezpieczniki (te same komunikaty co w `readCompletePages`):
 * - błąd strony → `${label}: <treść błędu>`;
 * - brak liczby rekordów na pierwszej stronie albo w liczniku kontrolnym, albo
 *   licznik kontrolny inny niż pierwszy (zapis w trakcie odczytu) →
 *   „nie można potwierdzić liczby rekordów”;
 * - strona krótsza albo dłuższa niż brakuje do licznika (cichy limit wierszy
 *   serwera, usunięcie w trakcie odczytu) → „niepełna strona danych”;
 * - id nie rosną (zignorowane `gt` albo `order`) → „niestabilna kolejność
 *   stron danych”.
 *
 * Jedna strona to jedna migawka: licznik i wiersze przychodzą w tej samej
 * odpowiedzi, więc licznika kontrolnego wtedy nie ma. Ostatnia strona prosi
 * o więcej wierszy, niż brakuje do licznika (przy pełnej stronie o jeden
 * więcej), więc wiersz, który został za licznikiem, bo w trakcie odczytu
 * usunięto przeczytany i dopisano nieprzeczytany, daje „niepełna strona
 * danych” (FZ-017); wymaga to limitu serwera ponad `ACCOUNTING_PAGE_SIZE`
 * (produkcja: 1000), bo przy limicie równym stronie serwer utnie prośbę o 501.
 * Zmiany po obu stronach kursora naraz (usunięty i dopisany wiersz w części
 * przeczytanej oraz w nieprzeczytanej) łapie podwójny odczyt (FZ-031, D70,
 * `zPodwojnymOdczytem`).
 */
export async function readCompletePagesByKey<T extends { id: string }>(
  label: string,
  fetchPage: (page: KeysetPageQuery) => PromiseLike<KeysetPage<T>>,
): Promise<T[]> {
  return zPodwojnymOdczytem(label, () => readKeysetOnce(label, fetchPage));
}

async function readKeysetOnce<T extends { id: string }>(
  label: string,
  fetchPage: (page: KeysetPageQuery) => PromiseLike<KeysetPage<T>>,
): Promise<{ rows: T[]; pages: number }> {
  const rows: T[] = [];
  let total: number | null = null;
  let lastId: string | null = null;
  let pages = 0;

  while (total === null || rows.length < total) {
    // Ostatnia strona, której brakuje pełnej strony do licznika, prosi o jeden wiersz więcej: wiersz za licznikiem
    // (np. dopisany w części nieprzeczytanej, gdy usunięto przeczytany) daje stronę dłuższą, a nie cichy brak (FZ-017).
    const limit = total !== null && total - rows.length === ACCOUNTING_PAGE_SIZE ? ACCOUNTING_PAGE_SIZE + 1 : ACCOUNTING_PAGE_SIZE;
    const page = await fetchPage({ afterId: lastId, limit, count: total === null, head: false });
    pages += 1;
    if (page.error) throw new Error(`${label}: ${page.error.message}`);
    if (!page.data || (total === null && !validCount(page.count))) {
      throw new Error(`${label}: nie można potwierdzić liczby rekordów`);
    }
    if (total === null) total = page.count as number;
    if (page.data.length !== Math.min(ACCOUNTING_PAGE_SIZE, total - rows.length)) {
      throw new Error(`${label}: niepełna strona danych`);
    }
    for (const row of page.data) {
      if (typeof row.id !== 'string' || !row.id ||
          (lastId !== null && row.id <= lastId)) {
        throw new Error(`${label}: niestabilna kolejność stron danych`);
      }
      rows.push(row);
      lastId = row.id;
    }
  }

  if (pages > 1) {
    const check = await fetchPage({ afterId: null, limit: ACCOUNTING_PAGE_SIZE, count: true, head: true });
    if (check.error) throw new Error(`${label}: ${check.error.message}`);
    if (!validCount(check.count) || check.count !== total) {
      throw new Error(`${label}: nie można potwierdzić liczby rekordów`);
    }
  }

  return { rows, pages };
}
