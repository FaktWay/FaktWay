import Papa from 'papaparse';

import type { ParsedInvoice } from '@/lib/import/fa3-parser';
import { parseCsv, type CsvSource } from '@/lib/import/csv-parsers';
import {
  OUTSIDE_KSEF_REFUSAL_MESSAGE,
  outsideKsefInvoiceSchema,
  type OutsideKsefInvoiceInput,
} from '@/lib/import/outside-ksef-schema';
import { roundToCents, toGrosze } from '@/lib/xml/invoice-calculator';

/**
 * Import CSV z opcją „wlicz do ksiąg” (krok 1.6, część 2b, D25c; zakres treści
 * D22, zakres dat D21). Funkcje czyste: z pliku CSV czterech programów
 * (Fakturownia, inFakt, wFirma, iFirma) robią wpisy `outsideKsefInvoiceSchema`
 * albo odmowy z powodem. Zapis robi `outside-ksef-csv-zapis.ts` przez
 * `dodajFakturaSpozaKsef`, więc wyłącznik, daty, środowisko i audyt są te same.
 *
 * Zasada: plik CSV niesie tylko sumy faktury i stawkę, która w parserach bywa
 * domyślna („23”, gdy pliku brak stawki). Do ksiąg (KPiR, JPK_V7M) wchodzi więc
 * tylko to, co da się sprawdzić liczbą: VAT z pliku musi zgadzać się ze stawką
 * (jak w schemacie), brutto z netto plus VAT, suma pozycji z netto faktury.
 * Wszystko inne to odmowa z wyjściem (formularz ręczny albo księgowanie poza
 * FaktWay), nie zgadywanie. Przy niepewności faktura nie wchodzi do ksiąg.
 */

export const CSV_STAWKI = ['23', '8', '5'] as const;
type CsvStawka = (typeof CSV_STAWKI)[number];

const WYJSCIE =
  'Dopisz ją ręcznie na ekranie „Faktura wystawiona poza KSeF” albo ujmij ją w księgach poza FaktWay.';

export interface OdrzuconaFakturaCsv {
  numer: string;
  powod: string;
}

export interface PodgladCsvSpozaKsef {
  wpisy: OutsideKsefInvoiceInput[];
  odrzucone: OdrzuconaFakturaCsv[];
  /** Ostrzeżenia całego pliku (pominięte rekordy, błędy składni): nigdy po cichu. */
  ostrzezeniaPliku: string[];
  /** Plik odrzucony w całości (waluta, rodzaj dokumentu): wtedy `wpisy` jest puste. */
  odmowaPliku: string | null;
}

const KOLUMNY_WALUTY = /^(waluta|currency)$/i;
const KOLUMNY_RODZAJU = /^(rodzaj|typ|kind|type|invoice_kind|invoice_type|rodzaj dokumentu|typ dokumentu)$/i;
// Rodzaje spoza zakresu D22; „vat”, „faktura”, „sprzedaż” to zwykła faktura i nie pasują.
const RODZAJE_ODMOWY =
  /korekt|koryg|correct|zaliczk|advance|rozlicz|final|paragon|receipt|mar[żz]|margin|proforma|pro forma|samofaktur|self.?bill|kasow|cash.?method/i;

/**
 * Kontrola surowego pliku przed mapowaniem: parsery CSV nie czytają kolumn
 * waluty ani rodzaju dokumentu, więc faktura w EUR bez symbolu przy kwocie
 * albo korekta z kolumny „Rodzaj” wyglądałaby jak zwykła faktura w PLN.
 * Odmowa dotyczy całego pliku (parsery gubią powiązanie wiersza z numerem), z
 * wyjściem: wyeksportować tylko faktury w złotych bez korekt albo dopisać ręcznie.
 */
export function odmowaSurowegoPliku(content: string): string | null {
  const wynik = Papa.parse<Record<string, string | undefined>>(content, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  const kolumny = wynik.meta.fields ?? [];
  const waluta = kolumny.filter((k) => KOLUMNY_WALUTY.test(k));
  const rodzaj = kolumny.filter((k) => KOLUMNY_RODZAJU.test(k));
  let obcaWaluta = 0;
  let innyRodzaj = 0;
  for (const wiersz of wynik.data) {
    if (!wiersz || typeof wiersz !== 'object') continue;
    for (const k of waluta) {
      const v = (wiersz[k] ?? '').trim();
      if (v && !/^(pln|zł|zl)$/i.test(v)) obcaWaluta++;
    }
    for (const k of rodzaj) {
      if (RODZAJE_ODMOWY.test(wiersz[k] ?? '')) innyRodzaj++;
    }
  }
  if (obcaWaluta > 0) {
    return `W pliku są faktury w innej walucie niż złoty (${obcaWaluta}). ${OUTSIDE_KSEF_REFUSAL_MESSAGE} Wyeksportuj z programu same faktury w złotych albo dopisz je ręcznie.`;
  }
  if (innyRodzaj > 0) {
    return `W pliku są dokumenty, których FaktWay nie ujmie w księgach: korekty, zaliczki, faktury końcowe, do paragonu, marża albo kasowe (${innyRodzaj}). ${OUTSIDE_KSEF_REFUSAL_MESSAGE} Wyeksportuj z programu same zwykłe faktury VAT albo dopisz resztę ręcznie.`;
  }
  return null;
}

const NUMER_KOREKTY = /(^|[\s/_-])(kor|korekta|fk|fkor)([\s/_-]|\d|$)/i;

function odmowaFaktury(f: ParsedInvoice, nipFirmy: string): string | null {
  if (f.invoiceType !== 'regular' || NUMER_KOREKTY.test(f.invoiceNumber)) {
    return `${OUTSIDE_KSEF_REFUSAL_MESSAGE} Korekty, zaliczek i faktur rozliczających nie wlicza się z pliku.`;
  }
  // Każde ostrzeżenie parsera przy fakturze to wątpliwość co do daty, waluty albo kwot: fail-closed.
  if (f.warnings.length > 0) {
    return `Plik budzi wątpliwość przy tej fakturze (${f.warnings[0]}), więc nie wchodzi do ksiąg. ${WYJSCIE}`;
  }
  if (f.seller.nip && f.seller.nip !== nipFirmy) {
    return 'Sprzedawcą tej faktury jest inna firma niż Twoja (NIP z pliku nie zgadza się z NIP firmy), więc nie wchodzi do ksiąg Twojej firmy.';
  }
  if (!f.buyer.name.trim() || f.buyer.name.trim() === 'Nieznany') {
    return `W pliku brakuje nabywcy tej faktury. ${WYJSCIE}`;
  }
  return null;
}

function stawkaLinii(vatRate: string): CsvStawka | null {
  return (CSV_STAWKI as readonly string[]).includes(vatRate) ? (vatRate as CsvStawka) : null;
}

/** Jedna faktura z pliku na wpis albo odmowa. Kwoty w groszach, bez zgadywania stawki. */
export function mapujFakturaCsv(f: ParsedInvoice, nipFirmy: string): OutsideKsefInvoiceInput | OdrzuconaFakturaCsv {
  const odrzuc = (powod: string): OdrzuconaFakturaCsv => ({ numer: f.invoiceNumber, powod });
  const odmowa = odmowaFaktury(f, nipFirmy);
  if (odmowa) return odrzuc(odmowa);

  const nettoGr = toGrosze(f.totals.netTotal);
  const vatGr = toGrosze(f.totals.vatTotal);
  const bruttoGr = toGrosze(f.totals.grossTotal);
  if (nettoGr <= 0) return odrzuc(`Kwota netto z pliku nie jest dodatnia. ${WYJSCIE}`);
  if (vatGr <= 0) {
    // Stawki 0, „zw” i „np” różnią się w JPK_V7M, a plik CSV ich nie rozróżnia.
    return odrzuc(`Plik nie mówi, czy to stawka 0, „zw” czy „np” (VAT wynosi 0,00), więc FaktWay nie zgaduje. ${WYJSCIE}`);
  }
  if (Math.abs(bruttoGr - (nettoGr + vatGr)) > 1) {
    return odrzuc(`Brutto z pliku nie zgadza się z netto plus VAT. ${WYJSCIE}`);
  }

  const stawki = f.lines.map((l) => stawkaLinii(l.vatRate));
  if (f.lines.length === 0 || stawki.some((s) => s === null)) {
    return odrzuc(`Stawka VAT z pliku to nie 23, 8 ani 5 procent (albo brak stawki). ${WYJSCIE}`);
  }
  const sumaNettoLinii = f.lines.reduce((s, l) => s + toGrosze(l.netAmount), 0);
  if (sumaNettoLinii !== nettoGr) {
    return odrzuc(`Suma pozycji z pliku nie zgadza się z kwotą netto faktury. ${WYJSCIE}`);
  }

  let pozycje;
  if (f.lines.length === 1) {
    // Jedna pozycja: VAT z nagłówka; schemat sprawdza go ze stawką (tolerancja grosza).
    const l = f.lines[0]!;
    pozycje = [
      {
        name: l.name.trim() || 'Pozycja z importu',
        netAmount: roundToCents(nettoGr / 100),
        vatRate: stawki[0]!,
        vatAmount: roundToCents(vatGr / 100),
        grossAmount: roundToCents((nettoGr + vatGr) / 100),
      },
    ];
  } else {
    // Wiele pozycji: VAT liczony ze stawki każdej i musi dać dokładnie VAT z pliku;
    // błędna (np. domyślna) stawka którejkolwiek pozycji rozjedzie sumę.
    const liczone = f.lines.map((l, i) => {
      const netGr = toGrosze(l.netAmount);
      return { l, netGr, vatLiniiGr: toGrosze(roundToCents((netGr * Number(stawki[i])) / 10000)), stawka: stawki[i]! };
    });
    if (liczone.reduce((s, x) => s + x.vatLiniiGr, 0) !== vatGr) {
      return odrzuc(`VAT z pliku nie zgadza się ze stawkami pozycji. ${WYJSCIE}`);
    }
    pozycje = liczone.map((x) => ({
      name: x.l.name.trim() || 'Pozycja z importu',
      netAmount: roundToCents(x.netGr / 100),
      vatRate: x.stawka,
      vatAmount: roundToCents(x.vatLiniiGr / 100),
      grossAmount: roundToCents((x.netGr + x.vatLiniiGr) / 100),
    }));
  }

  const wpis = {
    number: f.invoiceNumber,
    issueDate: f.issueDate,
    buyerName: f.buyer.name.trim(),
    ...(f.buyer.nip ? { buyerNip: f.buyer.nip } : {}),
    currency: 'PLN' as const,
    lines: pozycje,
  };
  const sprawdzony = outsideKsefInvoiceSchema.safeParse(wpis);
  if (!sprawdzony.success) {
    return odrzuc(`${sprawdzony.error.issues[0]?.message ?? 'Nieprawidłowe dane faktury.'} ${WYJSCIE}`);
  }
  return sprawdzony.data;
}

function czyOdmowa(x: OutsideKsefInvoiceInput | OdrzuconaFakturaCsv): x is OdrzuconaFakturaCsv {
  return 'powod' in x;
}

/** Podgląd importu (bez zapisu): co wejdzie do ksiąg, co zostaje poza nimi i dlaczego. */
export function przygotujCsvSpozaKsef(content: string, source: CsvSource, nipFirmy: string): PodgladCsvSpozaKsef {
  const odmowaPliku = odmowaSurowegoPliku(content);
  if (odmowaPliku) return { wpisy: [], odrzucone: [], ostrzezeniaPliku: [], odmowaPliku };

  const wynik = parseCsv(content, source);
  const wpisy: OutsideKsefInvoiceInput[] = [];
  const odrzucone: OdrzuconaFakturaCsv[] = [];
  for (const f of wynik.invoices) {
    const r = mapujFakturaCsv(f, nipFirmy);
    if (czyOdmowa(r)) odrzucone.push(r);
    else wpisy.push(r);
  }
  return { wpisy, odrzucone, ostrzezeniaPliku: wynik.warnings, odmowaPliku: null };
}
