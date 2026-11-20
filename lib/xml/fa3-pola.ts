/**
 * Opis błędu schematu FA(3) dla klienta (U3 z obchodu aplikacji 20.11.2026).
 *
 * Walidator XSD (`xmllint-wasm`) zwraca tekst libxml: nazwę elementu bez
 * rodzica, fragment wzorca i numer linii (plik jest w jednej linii, więc
 * zawsze „Linia 1”). Klient nie ma tego widzieć. Ten moduł wyprowadza z
 * PIERWSZEGO błędu zdanie z nazwą pola faktury po polsku i podpowiedź.
 *
 * Nazwa elementu sama nie wystarcza: `NIP` jest u sprzedawcy, u nabywcy i
 * w innych miejscach, `P_8B` w każdej pozycji. Dlatego pole ustalamy ze
 * ścieżki elementu w wysyłanym pliku (nazwa elementu i wartość z komunikatu).
 * Bez zgadywania: gdy ścieżki nie da się ustalić jednoznacznie, element nie
 * ma nazwy w tabeli albo błąd jest inny niż błąd wartości pola, funkcja
 * zwraca `null`, a wołający pokazuje ogólne zdanie bez surowego tekstu.
 *
 * Pełny komunikat libxml zostaje w `InvoiceXmlSchemaError.errors` (log workera,
 * audyt, dziennik prób). Moduł jest czystą funkcją nad tekstem XML i
 * komunikatami: bez bazy, sieci i dysku.
 */

import { XMLParser } from 'fast-xml-parser';
import { FA3_ISSUE_LEAD, type Fa3CustomerIssue } from '@/lib/xml/fa3-limits';

interface Fa3Pole {
  /** Nazwa pola po polsku; przy pozycjach bez „Pozycja N:”. */
  readonly label: string;
  /** Pole pozycji faktury: nazwę poprzedza „Pozycja N:”. */
  readonly row?: true;
  /** Dane sprzedawcy: poprawia się je w Ustawieniach firmy, nie w szkicu faktury. */
  readonly settings?: true;
  /** Podpowiedź dla błędu formatu tego pola (zamiast ogólnej). */
  readonly formatHint?: string;
}

const NIP_HINT = 'Sprawdź, czy NIP jest wpisany poprawnie: 10 cyfr, bez myślników i spacji.';
const DATE_HINT = 'Wybierz w kalendarzu poprawną datę.';

/** Ścieżki względem elementu głównego `Faktura`. Tylko elementy, które klient może zmienić. */
const POLA: ReadonlyArray<readonly [RegExp, Fa3Pole]> = [
  // Sprzedawca (dane z Ustawień firmy).
  [/^Podmiot1\/DaneIdentyfikacyjne\/NIP$/, { label: 'NIP sprzedawcy', settings: true, formatHint: NIP_HINT }],
  [/^Podmiot1\/DaneIdentyfikacyjne\/Nazwa$/, { label: 'Nazwa sprzedawcy', settings: true }],
  [/^Podmiot1\/Adres$/, { label: 'Adres sprzedawcy', settings: true }],
  [/^Podmiot1\/Adres\/KodKraju$/, { label: 'Kraj sprzedawcy', settings: true }],
  [/^Podmiot1\/Adres\/AdresL1$/, { label: 'Adres sprzedawcy, linia 1', settings: true }],
  [/^Podmiot1\/Adres\/AdresL2$/, { label: 'Adres sprzedawcy, linia 2', settings: true }],
  [/^Podmiot1\/DaneKontaktowe\/Email$/, { label: 'E-mail sprzedawcy', settings: true }],
  [/^Podmiot1\/DaneKontaktowe\/Telefon$/, { label: 'Telefon sprzedawcy', settings: true }],
  // Nabywca.
  [/^Podmiot2\/DaneIdentyfikacyjne\/NIP$/, { label: 'NIP nabywcy', formatHint: NIP_HINT }],
  [/^Podmiot2\/DaneIdentyfikacyjne\/Nazwa$/, { label: 'Nazwa nabywcy' }],
  [/^Podmiot2\/DaneIdentyfikacyjne\/KodUE$/, { label: 'Kraj UE nabywcy (numer VAT UE)' }],
  [/^Podmiot2\/DaneIdentyfikacyjne\/NrVatUE$/, { label: 'Numer VAT UE nabywcy' }],
  [/^Podmiot2\/DaneIdentyfikacyjne\/KodKraju$/, { label: 'Kraj numeru identyfikacyjnego nabywcy' }],
  [/^Podmiot2\/DaneIdentyfikacyjne\/NrID$/, { label: 'Numer identyfikacyjny nabywcy' }],
  [/^Podmiot2\/Adres$/, { label: 'Adres nabywcy' }],
  [/^Podmiot2\/Adres\/KodKraju$/, { label: 'Kraj nabywcy' }],
  [/^Podmiot2\/Adres\/AdresL1$/, { label: 'Adres nabywcy, linia 1' }],
  [/^Podmiot2\/Adres\/AdresL2$/, { label: 'Adres nabywcy, linia 2' }],
  [/^Podmiot2\/DaneKontaktowe\/Email$/, { label: 'E-mail nabywcy' }],
  [/^Podmiot2\/DaneKontaktowe\/Telefon$/, { label: 'Telefon nabywcy' }],
  // Nagłówek faktury, sumy i płatność.
  [/^Fa\/KodWaluty$/, { label: 'Waluta' }],
  [/^Fa\/P_1$/, { label: 'Data wystawienia', formatHint: DATE_HINT }],
  [/^Fa\/P_2$/, { label: 'Numer faktury' }],
  [/^Fa\/P_6$/, { label: 'Data sprzedaży', formatHint: DATE_HINT }],
  [/^Fa\/P_13_\d+$/, { label: 'Suma netto według stawki VAT' }],
  [/^Fa\/P_14_\d+W?$/, { label: 'Suma VAT według stawki' }],
  [/^Fa\/P_15$/, { label: 'Kwota należności ogółem' }],
  [/^Fa\/Platnosc\/TerminPlatnosci\/Termin$/, { label: 'Termin płatności', formatHint: DATE_HINT }],
  [/^Fa\/Platnosc\/FormaPlatnosci$/, { label: 'Forma płatności' }],
  [/^Fa\/Platnosc\/DataZaplaty$/, { label: 'Data zapłaty', formatHint: DATE_HINT }],
  [/^Fa\/Platnosc\/OpisPlatnosci$/, { label: 'Opis formy płatności' }],
  [/^Fa\/Platnosc\/RachunekBankowy\/NrRB$/, { label: 'Numer rachunku bankowego' }],
  [/^Fa\/Platnosc\/RachunekBankowy\/NazwaBanku$/, { label: 'Nazwa banku' }],
  [/^Fa\/DodatkowyOpis\/(?:Klucz|Wartosc)$/, { label: 'Dodatkowy opis' }],
  [/^Stopka\/Informacje\/StopkaFaktury$/, { label: 'Stopka faktury' }],
  [/^Fa\/Adnotacje\/Zwolnienie\/P_19[A-C]?$/, { label: 'Podstawa zwolnienia z VAT' }],
  // Korekta i faktury zaliczkowe.
  [/^Fa\/PrzyczynaKorekty$/, { label: 'Przyczyna korekty' }],
  [/^Fa\/DaneFaKorygowanej\/NrFaKorygowanej$/, { label: 'Numer korygowanej faktury' }],
  [/^Fa\/DaneFaKorygowanej\/DataWystFaKorygowanej$/, { label: 'Data wystawienia korygowanej faktury', formatHint: DATE_HINT }],
  [/^Fa\/DaneFaKorygowanej\/(?:NrKSeF|NrKSeFFaKorygowanej)$/, { label: 'Numer KSeF korygowanej faktury' }],
  [/^Fa\/FakturaZaliczkowa\/NrFaZaliczkowej$/, { label: 'Numer faktury zaliczkowej' }],
  [/^Fa\/FakturaZaliczkowa\/NrKSeFFaZaliczkowej$/, { label: 'Numer KSeF faktury zaliczkowej' }],
  // Pozycje faktury.
  [/^Fa\/FaWiersz\/P_7$/, { label: 'nazwa', row: true }],
  [/^Fa\/FaWiersz\/PKWiU$/, { label: 'kod PKWiU', row: true }],
  [/^Fa\/FaWiersz\/P_8A$/, { label: 'jednostka miary', row: true }],
  [/^Fa\/FaWiersz\/P_8B$/, { label: 'ilość', row: true }],
  [/^Fa\/FaWiersz\/P_9A$/, { label: 'cena jednostkowa netto', row: true }],
  [/^Fa\/FaWiersz\/P_9B$/, { label: 'cena jednostkowa brutto', row: true }],
  [/^Fa\/FaWiersz\/P_11$/, { label: 'wartość netto', row: true }],
  [/^Fa\/FaWiersz\/P_11A$/, { label: 'wartość brutto', row: true }],
  [/^Fa\/FaWiersz\/P_12$/, { label: 'stawka VAT', row: true }],
  // Zamówienie przy zaliczce (pozycje bez numeru w nazwie pola).
  [/^Fa\/Zamowienie\/WartoscZamowienia$/, { label: 'Wartość zamówienia' }],
  [/^Fa\/Zamowienie\/ZamowienieWiersz\/P_7Z$/, { label: 'Zamówienie, nazwa pozycji' }],
  [/^Fa\/Zamowienie\/ZamowienieWiersz\/P_8AZ$/, { label: 'Zamówienie, jednostka miary' }],
  [/^Fa\/Zamowienie\/ZamowienieWiersz\/P_8BZ$/, { label: 'Zamówienie, ilość' }],
  [/^Fa\/Zamowienie\/ZamowienieWiersz\/P_9AZ$/, { label: 'Zamówienie, cena jednostkowa netto' }],
  [/^Fa\/Zamowienie\/ZamowienieWiersz\/P_11NettoZ$/, { label: 'Zamówienie, wartość netto' }],
  [/^Fa\/Zamowienie\/ZamowienieWiersz\/P_11VatZ$/, { label: 'Zamówienie, kwota VAT' }],
  [/^Fa\/Zamowienie\/ZamowienieWiersz\/P_12Z$/, { label: 'Zamówienie, stawka VAT' }],
];

/** Pole z tabeli dla ścieżki względem `Faktura`; `null`, gdy klient go nie zmienia albo nie znamy. */
export function fa3PoleFor(path: string): Fa3Pole | null {
  return POLA.find(([pattern]) => pattern.test(path))?.[1] ?? null;
}

// ─── Rodzaj błędu z komunikatu libxml ───────────────────────────────────────

type Kind = 'format' | 'cyfry' | 'zakres' | 'dlugie' | 'krotkie' | 'lista' | 'brak';

interface ParsedError {
  /** Nazwa elementu bez przestrzeni nazw; przy `brak` to rodzic, któremu czegoś brakuje. */
  readonly element: string;
  readonly kind: Kind;
  /** Wartość z komunikatu (gdy ją podaje); przy `brak` brakujący element potomny. */
  readonly value: string | null;
  readonly missing: string | null;
}

const ELEMENT_RE = /Element '(?:\{[^}]*\})?([^']+)': ([\s\S]*)$/;
const VALUE_RE = /^(?:\[facet '[^']+'\] )?(?:The value )?'([\s\S]*?)' (?:is not|has more)/;
const MISSING_RE = /^Missing child element\(s\)\. Expected is \( \{[^}]*\}([^ ,)]+) \)\./;

function classify(rest: string): { kind: Kind; missing: string | null } | null {
  const missing = MISSING_RE.exec(rest);
  if (missing) return { kind: 'brak', missing: missing[1] };
  if (/\[facet '(?:fractionDigits|totalDigits)'\]/.test(rest)) return { kind: 'cyfry', missing: null };
  if (/\[facet '(?:min|max)(?:In|Ex)clusive'\]/.test(rest)) return { kind: 'zakres', missing: null };
  if (/\[facet 'maxLength'\]/.test(rest)) return { kind: 'dlugie', missing: null };
  if (/\[facet 'minLength'\]/.test(rest)) return { kind: 'krotkie', missing: null };
  if (/\[facet 'enumeration'\]/.test(rest)) return { kind: 'lista', missing: null };
  if (/\[facet '(?:pattern|length)'\]|is not a valid value of the (?:atomic|union) type/.test(rest)) {
    return { kind: 'format', missing: null };
  }
  // „This element is not expected”, „Character content other than whitespace”
  // i reszta: błąd budowy pliku, nie wartość pola, które klient wpisał.
  return null;
}

function parseError(message: string): ParsedError | null {
  const match = ELEMENT_RE.exec(message);
  if (!match) return null;
  const [, element, rest] = match;
  const kind = classify(rest);
  if (!kind) return null;
  return { element, kind: kind.kind, value: VALUE_RE.exec(rest)?.[1] ?? null, missing: kind.missing };
}

// ─── Ścieżka elementu w wysyłanym pliku ─────────────────────────────────────

type XNode = Record<string, unknown>;

interface Located {
  /** Ścieżka względem `Faktura`, bez indeksów. */
  readonly path: string;
  /** Numer wiersza faktury (`NrWierszaFa`), gdy element leży w pozycji. */
  readonly row: number | null;
  /** Tekst elementu liścia; `null` dla elementu z potomkami. */
  readonly text: string | null;
}

const PARSER = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: true,
  ignoreDeclaration: true,
  removeNSPrefix: true,
  // Wartości zostają tekstem (NIP z zerem na początku, 1.10 nie może stać się 1.1).
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
});

function textOf(children: XNode[]): string {
  return children.map((c) => (typeof c['#text'] === 'string' ? c['#text'] : '')).join('');
}

function hasElements(children: XNode[]): boolean {
  return children.some((c) => Object.keys(c).some((k) => k !== '#text' && k !== ':@'));
}

function rowNumber(children: XNode[]): number | null {
  for (const c of children) {
    const inner = c.NrWierszaFa;
    if (Array.isArray(inner)) {
      const n = Number.parseInt(textOf(inner as XNode[]), 10);
      return Number.isInteger(n) && n > 0 ? n : null;
    }
  }
  return null;
}

function walk(nodes: XNode[], trail: readonly string[], row: number | null, out: Located[]): void {
  for (const node of nodes) {
    for (const [tag, content] of Object.entries(node)) {
      if (tag === ':@' || tag === '#text' || !Array.isArray(content)) continue;
      const children = content as XNode[];
      const path = [...trail, tag];
      const rowHere = tag === 'FaWiersz' ? rowNumber(children) : row;
      out.push({
        path: path.slice(1).join('/'),
        row: rowHere,
        text: hasElements(children) ? null : textOf(children),
      });
      walk(children, path, rowHere, out);
    }
  }
}

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Element o nazwie `local` w pliku: jego ścieżka i wiersz faktury. Najpierw
 * dopasowanie po wartości z komunikatu (rozróżnia NIP sprzedawcy i nabywcy),
 * potem po samej nazwie. Wiele różnych ścieżek, parser się wywrócił albo brak
 * elementu: `null`, bez zgadywania.
 */
function locate(xml: string, local: string, value: string | null): { path: string; row: number | null } | null {
  let tree: unknown;
  try {
    tree = PARSER.parse(xml);
  } catch {
    return null;
  }
  if (!Array.isArray(tree)) return null;
  const all: Located[] = [];
  walk(tree as XNode[], [], null, all);
  const named = all.filter((e) => e.path.split('/').at(-1) === local);
  const byValue = value === null ? [] : named.filter((e) => e.text !== null && normalize(e.text) === normalize(value));
  const pool = byValue.length > 0 ? byValue : named;
  const paths = new Set(pool.map((e) => e.path));
  if (paths.size !== 1) return null;
  return { path: pool[0].path, row: pool.length === 1 ? pool[0].row : null };
}

// ─── Zdanie dla klienta ─────────────────────────────────────────────────────

const TAIL: Record<Exclude<Kind, 'brak'>, string> = {
  format: 'ma niepoprawny format',
  cyfry: 'ma za dużo cyfr',
  zakres: 'ma wartość spoza dozwolonego zakresu',
  dlugie: 'jest za długie',
  krotkie: 'jest puste albo za krótkie',
  lista: 'ma wartość spoza dozwolonej listy',
};

const FIX: Record<Kind, string> = {
  format: 'Sprawdź wartość w tym polu i wpisz ją w poprawnym formacie.',
  cyfry: 'Skróć liczbę, na przykład zaokrąglij ją.',
  zakres: 'Wpisz wartość z dozwolonego zakresu.',
  dlugie: 'Skróć tekst w tym polu.',
  krotkie: 'Uzupełnij pole albo wpisz dłuższą wartość.',
  lista: 'Wybierz wartość z listy w formularzu.',
  brak: 'Uzupełnij to pole.',
};

const SETTINGS_FIX = 'Dane sprzedawcy poprawisz w Ustawieniach firmy.';

function fieldLabel(pole: Fa3Pole, row: number | null): string {
  if (!pole.row) return pole.label;
  return row === null ? `Pozycje: ${pole.label}` : `Pozycja ${row}: ${pole.label}`;
}

/**
 * Opis dla klienta z listy błędów walidatora XSD (teksty libxml, najpierw
 * najważniejszy) i z wysyłanego pliku. `null`, gdy pola nie da się nazwać
 * bez zgadywania: wołający pokazuje wtedy ogólne zdanie.
 */
export function describeFa3SchemaErrors(xml: string, errors: readonly string[]): Fa3CustomerIssue | null {
  // Opis jest dodatkiem do błędu schematu: jego awaria nie może zamienić
  // błędu bez ponawiania w zwykły wyjątek (a więc w pięć ponowień).
  try {
    return describe(xml, errors);
  } catch {
    return null;
  }
}

function describe(xml: string, errors: readonly string[]): Fa3CustomerIssue | null {
  const first = errors[0] === undefined ? null : parseError(errors[0]);
  if (!first) return null;

  let located: { path: string; row: number | null } | null;
  if (first.kind === 'brak') {
    // Komunikat nazywa rodzica; brakujący element potomny jest w `missing`.
    const parent = locate(xml, first.element, null);
    located = parent && first.missing ? { path: `${parent.path}/${first.missing}`, row: parent.row } : null;
  } else {
    located = locate(xml, first.element, first.value);
  }
  if (!located) return null;
  const pole = fa3PoleFor(located.path);
  if (!pole) return null;

  const label = fieldLabel(pole, located.row);
  const sentence = first.kind === 'brak' ? `Brakuje pola „${label}”.` : `Pole „${label}” ${TAIL[first.kind]}.`;
  const fix = (first.kind === 'format' && pole.formatHint) || FIX[first.kind];
  return {
    message: `${FA3_ISSUE_LEAD} ${sentence}`,
    field: label,
    suggestion: pole.settings ? `${fix} ${SETTINGS_FIX}` : fix,
  };
}
