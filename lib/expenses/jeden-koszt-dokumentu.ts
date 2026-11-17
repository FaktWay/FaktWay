import { formatIsoDatePl } from '@/lib/format/iso-date';
import { costDocumentType } from '@/lib/expenses/vat-deduction-document';

/**
 * Jeden dokument kosztu to w KPiR, w JPK_V7M i na kartach kosztów jeden koszt
 * (FZ-022, reguła RP-KOSZT-01; ta sama zasada co F11-C1 w KPiR modułu,
 * `lib/ksiegowosc/kpir-dane.ts`).
 *
 * Tożsamość dokumentu: NIP sprzedawcy, numer i rok wystawienia, bez względu
 * na rodzaj. Numer jest jednoznaczny u wystawcy (art. 106e ust. 1 pkt 2 ustawy
 * o VAT), ale sprzedawca może co rok zaczynać numerację od nowa („15”, „1/01”),
 * więc ten sam numer w innym roku to inny dokument. Rodzaju w kluczu nie ma,
 * bo OCR nazywa fakturę uproszczoną (UPR, jest w KSeF) „simplified_invoice”, a
 * koszt z KSeF ma zawsze rodzaj „invoice”.
 *
 * Dubel, przy którym odczyt okresu odmawia (z numerem, datą, źródłami
 * i wyjściem, zamiast po cichu wybierać jeden koszt):
 * - ten sam dokument z KSeF i spoza KSeF (zdjęcie, wpis ręczny, import),
 *   dowolnego rodzaju: koszt z KSeF jest oryginałem, drugi to kopia (wzór FZ-022);
 * - dwa koszty spoza KSeF z tą samą kwotą brutto albo (przy fakturach) w tej
 *   samej kolumnie KPiR, np. zdjęcie wgrane dwa razy albo kopia ze źle
 *   odczytaną kwotą. Paragon numeruje kasa, a sieć z jednym NIP-em ma wiele
 *   kas, więc dwa paragony to kopia tylko przy tym samym dniu i brutto.
 * Bez odmowy: dwa koszty z KSeF (dla KSeF to różne dokumenty, np. faktura
 * i korekta z tym samym numerem) i faktura spoza KSeF rozpisana na dwie
 * kolumny KPiR z różnymi kwotami. Każdy odczyt sprawdza tylko swoje wiersze,
 * więc inne okresy liczą się jak dotąd. Nie łapie: pary w dwóch okresach
 * albo przez przełom roku (np. OCR wziął datę sprzedaży), numeru zapisanego
 * inaczej niż odstępami i wielkością liter („FV-7” i „FV/7”, zero na początku),
 * NIP-u z błędną cyfrą, dwóch kopii spoza KSeF z różną kwotą i kolumną
 * (FZ-022; parę ze Skrzynką zamknie zapis przy drugim źródle).
 *
 * Wyjście dla klienta: przy kopii wyłącza się „Uwzględnij w KPiR” (koszt ze
 * zdjęcia w formularzu kosztu, koszt z KSeF w przeglądzie kosztu KSeF,
 * `review_ksef_expense`). Ścieżka operatora: `docs/runbooks/koszt-dwa-razy.md`.
 * Komunikat nie ma nazwy sprzedawcy (bywa osobą fizyczną), bo treść odmowy
 * eksportu trafia też do dziennika zadań.
 *
 * Postać NIP-u i numeru do porównań jak `nip10` i `documentKey` z
 * `lib/expenses/document-identity.ts` (PR #834); po jego scaleniu ten moduł
 * bierze je stamtąd. Bez NIP-u z 10 cyfr albo bez numeru dokument nie ma
 * klucza i nie jest porównywany (np. sprzedawca zagraniczny).
 */

export interface DokumentKosztu {
  seller_nip: string | null;
  document_number: string | null;
  issue_date?: string | null;
  seller_name?: string | null;
  source?: string | null;
  ksef_invoice_id?: string | null;
  document_type?: string | null;
  ocr_extracted_data?: unknown;
  gross_amount?: number | string | null;
  kpir_column?: string | null;
}

export interface ZdublowanyDokument {
  /** Numer z kosztu z KSeF, a bez niego z pierwszego kosztu grupy, bez spacji na brzegach. */
  numer: string;
  sprzedawca: string;
  /** Data wystawienia (RRRR-MM-DD) tego samego kosztu co numer, gdy jest. */
  data?: string | null;
  ile: number;
  /** Jeden z kosztów jest ze Skrzynki KSeF (ma numer KSeF). */
  zKsef: boolean;
  /** Źródła kosztów grupy, bez powtórzeń, najpierw KSeF („ze Skrzynki KSeF”, „ze zdjęcia”…). */
  zrodla?: readonly string[];
  /** Ile dokumentów w odczycie ma dubla (ten i pozostałe). */
  dokumentow?: number;
}

/** Początek odmowy: rozpoznają ją zadanie eksportu, historia eksportu i raport KPiR. */
export const ODMOWA_DUBLA_KOSZTU = 'Ten sam dokument jest w kosztach więcej niż raz: ';

const PARAGONY = new Set(['receipt', 'simplified_invoice']);

/** NIP do porównań: same cyfry, dokładnie 10, inaczej brak. */
function nipDoPorownan(value: unknown): string | null {
  const cyfry = typeof value === 'string' ? value.replace(/\D/g, '') : '';
  return cyfry.length === 10 ? cyfry : null;
}

/** Numer do porównań: bez odstępów, wielkimi literami („fv 1/10” = „FV1/10”). */
function numerDoPorownan(value: unknown): string | null {
  const klucz = typeof value === 'string' ? value.replace(/\s+/g, '').toUpperCase() : '';
  return klucz || null;
}

const dzien = (value: unknown): string => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '');
/**
 * Kwota brutto tylko do porównań (bez liczenia): ta sama kwota z bazy jako liczba
 * albo tekst `numeric` („123.00”) daje ten sam zapis liczby.
 */
const brutto = (value: unknown): string => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? String(n) : '';
};

/** Klucz dokumentu kosztu (NIP, numer i rok wystawienia) albo `null`, gdy brakuje NIP-u z 10 cyfr albo numeru. */
export function kluczDokumentuKosztu(w: DokumentKosztu): string | null {
  const nip = nipDoPorownan(w.seller_nip);
  const numer = numerDoPorownan(w.document_number);
  if (!nip || !numer) return null;
  return `${nip}|${numer}|${dzien(w.issue_date).slice(0, 4)}`;
}

const zeSkrzynki = (w: DokumentKosztu) => w.source === 'ksef_inbox' || (w.ksef_invoice_id ?? null) !== null;

const paragon = (w: DokumentKosztu) => PARAGONY.has(costDocumentType(w));
const kolumna = (w: DokumentKosztu) => (typeof w.kpir_column === 'string' && w.kpir_column ? w.kpir_column : null);

/** Dwa koszty spoza KSeF tego samego klucza to kopia: to samo brutto (paragon także ten sam dzień) albo faktura w tej samej kolumnie KPiR. */
function kopiaSpozaKsef(a: DokumentKosztu, b: DokumentKosztu): boolean {
  if (paragon(a) || paragon(b)) return dzien(a.issue_date) === dzien(b.issue_date) && brutto(a.gross_amount) === brutto(b.gross_amount);
  return brutto(a.gross_amount) === brutto(b.gross_amount) || (kolumna(a) !== null && kolumna(a) === kolumna(b));
}

/** Grupa kosztów jednego dokumentu jest dublem: KSeF i spoza KSeF albo kopia spoza KSeF. */
function jestDublem(grupa: readonly DokumentKosztu[]): boolean {
  const spoza = grupa.filter((w) => !zeSkrzynki(w));
  if (spoza.length === 0) return false;
  if (spoza.length < grupa.length) return true;
  return spoza.some((a, i) => spoza.slice(i + 1).some((b) => kopiaSpozaKsef(a, b)));
}

/** Źródło kosztu w odmowie. */
function zrodlo(w: DokumentKosztu): string {
  if (zeSkrzynki(w)) return 'ze Skrzynki KSeF';
  if (w.source === 'ocr_photo') return 'ze zdjęcia';
  if (w.source === 'manual') return 'wpisany ręcznie';
  if (w.source === 'import') return 'z importu';
  return 'z innego źródła';
}

/** Pierwszy dokument (w kolejności wierszy), który jest wśród kosztów dublem, z liczbą takich dokumentów. */
export function zdublowanyDokument(wiersze: readonly DokumentKosztu[]): ZdublowanyDokument | null {
  const grupy = new Map<string, DokumentKosztu[]>();
  for (const w of wiersze) {
    const klucz = kluczDokumentuKosztu(w);
    if (klucz) grupy.set(klucz, [...(grupy.get(klucz) ?? []), w]);
  }
  const duble = [...grupy.values()].filter(jestDublem);
  if (duble.length === 0) return null;
  const grupa = duble[0];
  // Numer, nazwa i data jak w KSeF, gdy jest koszt z KSeF (oryginał), inaczej z pierwszego kosztu.
  const wzor = [...grupa.filter(zeSkrzynki), ...grupa.filter((w) => !zeSkrzynki(w))];
  return {
    numer: (wzor[0].document_number ?? '').trim(),
    sprzedawca: wzor.map((w) => w.seller_name?.trim()).find(Boolean) ?? 'sprzedawcy bez nazwy',
    data: dzien(wzor[0].issue_date) || null,
    ile: grupa.length,
    zKsef: grupa.some(zeSkrzynki),
    zrodla: [...new Set(wzor.map(zrodlo))],
    dokumentow: duble.length,
  };
}

/** Lista po polsku: „a”, „a i b”, „a, b i c”. */
const lista = (xs: readonly string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} i ${xs.at(-1)}`);

/** Odmowa dla klienta: numer, data, źródła, co z kosztami i wyjście (bez trybu rozkazującego, D8; bez nazwy sprzedawcy). */
export function komunikatDublaKosztu(d: ZdublowanyDokument): string {
  const data = d.data ? ` z ${formatIsoDatePl(d.data)}` : '';
  const zrodla = d.zrodla && d.zrodla.length > 0 ? `: ${lista(d.zrodla)}` : '';
  const wyjscie = d.zKsef
    ? 'Do kosztów wchodzi koszt z KSeF (ma numer KSeF), a przy koszcie ze zdjęcia albo wpisanym ręcznie wyłącza się w Kosztach „Uwzględnij w KPiR”.'
    : 'Do kosztów wchodzi jeden z nich, a przy pozostałych wyłącza się w Kosztach „Uwzględnij w KPiR”.';
  const inne = (d.dokumentow ?? 1) > 1 ? ` Takich dokumentów w tym okresie jest ${d.dokumentow}.` : '';
  return (
    `${ODMOWA_DUBLA_KOSZTU}${d.numer}${data} (${d.ile} razy${zrodla}), ` +
    'więc kosztów tego okresu teraz nie liczymy, żeby nie wpisać kosztu ani VAT do odliczenia podwójnie. ' +
    `${wyjscie}${inne}`
  );
}

export class ZdublowanyKosztError extends Error {
  readonly dokument: ZdublowanyDokument;

  constructor(dokument: ZdublowanyDokument) {
    super(komunikatDublaKosztu(dokument));
    this.name = 'ZdublowanyKosztError';
    this.dokument = dokument;
  }
}

/** Rzuca `ZdublowanyKosztError`, gdy w wierszach jest dubel dokumentu kosztu. */
export function assertJedenKosztNaDokument(wiersze: readonly DokumentKosztu[]): void {
  const dubel = zdublowanyDokument(wiersze);
  if (dubel) throw new ZdublowanyKosztError(dubel);
}
