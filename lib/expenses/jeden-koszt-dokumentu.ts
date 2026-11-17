/**
 * Jeden dokument kosztu to w KPiR, w JPK_V7M i na kartach kosztów jeden koszt
 * (FZ-022; ta sama zasada co F11-C1 w KPiR modułu, `lib/ksiegowosc/kpir-dane.ts`).
 *
 * Dokument rozpoznajemy po NIP-ie sprzedawcy i numerze: numer faktury jest
 * jednoznaczny u wystawcy (art. 106e ust. 1 pkt 2 ustawy o VAT). Ta sama
 * faktura ze zdjęcia (OCR) albo wpisana ręcznie i ze Skrzynki KSeF to dwa
 * wiersze `expenses`; zliczone oba dają podwójny koszt i podwójny VAT do
 * odliczenia. Odczyt odmawia wtedy z numerem dokumentu i wyjściem, zamiast
 * po cichu wybierać jeden koszt.
 *
 * Wyjście dla klienta: przy jednym z kosztów wyłącza się „Uwzględnij
 * w KPiR” (koszt ze zdjęcia w formularzu kosztu, koszt z KSeF w przeglądzie
 * kosztu KSeF, `review_ksef_expense`). Ścieżka operatora jak w F11-C1:
 * zgłoszenie w Pomocy (także dokument celowo podzielony na kilka kosztów);
 * grupy dubli firmy pokazuje zapytanie kontrolne z opisu PR FZ-022.
 *
 * Postać do porównań jak `nip10` i `documentKey` z
 * `lib/expenses/document-identity.ts` (PR #834); po jego scaleniu ten moduł
 * bierze je stamtąd. Bez NIP-u z 10 cyfr albo bez numeru dokument nie ma
 * klucza i nie jest porównywany (np. sprzedawca zagraniczny).
 */

export interface DokumentKosztu {
  seller_nip: string | null;
  document_number: string | null;
  seller_name?: string | null;
  source?: string | null;
  ksef_invoice_id?: string | null;
}

export interface ZdublowanyDokument {
  /** Numer z kosztu z KSeF, a bez niego z pierwszego kosztu grupy, bez spacji na brzegach. */
  numer: string;
  sprzedawca: string;
  ile: number;
  /** Jeden z kosztów jest ze Skrzynki KSeF (ma numer KSeF). */
  zKsef: boolean;
}

/** Początek odmowy: rozpoznaje ją zadanie eksportu (komunikat ma numer dokumentu). */
export const ODMOWA_DUBLA_KOSZTU = 'Ten sam dokument jest w kosztach więcej niż raz: ';

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

/** Klucz dokumentu kosztu albo `null`, gdy brakuje NIP-u z 10 cyfr albo numeru. */
export function kluczDokumentuKosztu(w: Pick<DokumentKosztu, 'seller_nip' | 'document_number'>): string | null {
  const nip = nipDoPorownan(w.seller_nip);
  const numer = numerDoPorownan(w.document_number);
  return nip && numer ? `${nip}|${numer}` : null;
}

const zeSkrzynki = (w: DokumentKosztu) => w.source === 'ksef_inbox' || (w.ksef_invoice_id ?? null) !== null;

/** Pierwszy dokument (w kolejności wierszy), który jest wśród kosztów więcej niż raz. */
export function zdublowanyDokument(wiersze: readonly DokumentKosztu[]): ZdublowanyDokument | null {
  const grupy = new Map<string, DokumentKosztu[]>();
  for (const w of wiersze) {
    const klucz = kluczDokumentuKosztu(w);
    if (klucz) grupy.set(klucz, [...(grupy.get(klucz) ?? []), w]);
  }
  for (const grupa of grupy.values()) {
    if (grupa.length < 2) continue;
    // Numer i nazwa jak w KSeF, gdy jest koszt z KSeF (oryginał), inaczej z pierwszego kosztu.
    const wzor = [...grupa.filter(zeSkrzynki), ...grupa.filter((w) => !zeSkrzynki(w))];
    return {
      numer: (wzor[0].document_number ?? '').trim(),
      sprzedawca: wzor.map((w) => w.seller_name?.trim()).find(Boolean) ?? 'sprzedawcy bez nazwy',
      ile: grupa.length,
      zKsef: grupa.some(zeSkrzynki),
    };
  }
  return null;
}

/** Odmowa dla klienta: numer, sprzedawca, co z kosztami i wyjście (bez trybu rozkazującego, D8). */
export function komunikatDublaKosztu(d: ZdublowanyDokument): string {
  const wyjscie = d.zKsef
    ? 'Do kosztów wchodzi koszt z KSeF (ma numer KSeF), a przy koszcie ze zdjęcia albo wpisanym ręcznie wyłącza się w Kosztach „Uwzględnij w KPiR”.'
    : 'Do kosztów wchodzi jeden koszt tego dokumentu, a przy pozostałych wyłącza się w Kosztach „Uwzględnij w KPiR”.';
  return (
    `${ODMOWA_DUBLA_KOSZTU}${d.numer} od ${d.sprzedawca} (${d.ile} razy, np. zdjęcie i ta sama faktura ze Skrzynki KSeF), ` +
    'więc kosztów tego okresu teraz nie liczymy, żeby nie wpisać kosztu ani VAT do odliczenia podwójnie. ' +
    `${wyjscie} Dokument celowo podzielony na kilka kosztów sprawdzimy po zgłoszeniu w Pomocy.`
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

/** Rzuca `ZdublowanyKosztError`, gdy ten sam dokument jest wśród kosztów więcej niż raz. */
export function assertJedenKosztNaDokument(wiersze: readonly DokumentKosztu[]): void {
  const dubel = zdublowanyDokument(wiersze);
  if (dubel) throw new ZdublowanyKosztError(dubel);
}
