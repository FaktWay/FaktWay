/**
 * C5b: treść z pliku KSeF, którą import zapisuje na wierszu faktury — data
 * sprzedaży (`invoices.sale_date`) oraz adnotacje, daty pozycji i oznaczenia
 * w `fa3_data` (na górnym poziomie, tam gdzie czytają je JPK, PDF i korekta).
 * Jedno źródło dla silnika importu i dla zapisu oryginału po decyzji klienta
 * (D-A4-1b-3 PR C). Moduł czysty.
 */

import type { InvoiceAnnotations } from '@/types/invoice';
import {
  annotationsJpkCannotExpress,
  exemptionMismatch,
  invoiceAnnotationsFromFa3,
  markersJpkCannotExpress,
  type Fa3Markers,
} from '@/lib/xml/fa3-annotations';
import { isGtuCode } from '@/lib/invoices/line-codes';
import type { ParsedInvoice } from './fa3-parser';

export interface ImportSaleDates {
  /** OkresFa z pliku. */
  period?: { from: string; to: string };
  /** P_6A pozycji (po numerze pozycji). */
  lines?: Array<{ ordinal: number; date: string }>;
  /** Pozycje mają różne daty albo daty nie dało się odczytać — JPK odmawia. */
  unclear?: true;
}

export interface ImportContent {
  saleDate: string | null;
  /** `undefined` = parser nie czytał Adnotacji (pliki JPK/CSV) — nic nie zapisujemy. */
  annotations?: InvoiceAnnotations;
  annotationProblems: string[];
  saleDates?: ImportSaleDates;
  markers?: Fa3Markers;
}

/**
 * Data sprzedaży:
 * - zaliczka i korekta → NULL (P_6 to tam data otrzymania zaliczki albo stan
 *   po korekcie; FaktWay nie zapisuje `sale_date` dla własnych ZAL/KOR);
 * - jedna data w pliku (P_6, P_6_Do z OkresFa albo ta sama P_6A wszystkich
 *   pozycji) → ta data, także gdy równa dacie wystawienia (wiersz wierny plikowi);
 * - kilka dat — {P_6 albo P_6_Do} ∪ {P_6A}, a pozycja bez P_6A przy braku daty
 *   nagłówka ma datę wystawienia; P_6A poza OkresFa też — „niejasna”: nagłówek
 *   albo NULL, i odmowa JPK (jedna data sprzedaży na dokument).
 */
export function fa3ImportContent(inv: ParsedInvoice): ImportContent {
  const annotations = inv.ksefAnnotations ? invoiceAnnotationsFromFa3(inv.ksefAnnotations) : undefined;
  const annotationProblems = [...(inv.annotationProblems ?? [])];

  const headerDate = inv.saleDate ?? inv.salePeriod?.to;
  const lineDates = inv.lines
    .filter((l): l is typeof l & { saleDate: string } => Boolean(l.saleDate))
    .map((l) => ({ ordinal: l.position, date: l.saleDate }));
  const dates = new Set<string>(headerDate ? [headerDate] : []);
  for (const l of lineDates) dates.add(l.date);
  if (!headerDate && lineDates.length > 0 && lineDates.length < inv.lines.length && inv.issueDate) dates.add(inv.issueDate);
  const outsidePeriod = inv.salePeriod
    ? lineDates.some((l) => l.date < inv.salePeriod!.from || l.date > inv.salePeriod!.to)
    : false;
  const unclear = Boolean(inv.saleDateProblems?.length) || dates.size > 1 || outsidePeriod;

  const saleDates: ImportSaleDates = {
    ...(inv.salePeriod ? { period: inv.salePeriod } : {}),
    ...(lineDates.length ? { lines: lineDates } : {}),
    ...(unclear ? { unclear: true as const } : {}),
  };

  const special = inv.invoiceType === 'advance' || inv.invoiceType === 'correction';
  const saleDate = special
    ? null
    : unclear
      ? headerDate ?? null
      : dates.size === 1 ? [...dates][0]! : null;

  return {
    saleDate,
    ...(annotations ? { annotations } : {}),
    annotationProblems,
    ...(Object.keys(saleDates).length ? { saleDates } : {}),
    ...(inv.ksefMarkers ? { markers: inv.ksefMarkers } : {}),
  };
}

export type HeldJpkFile = 'JPK_FA' | 'JPK_V7M';

export interface HeldReason {
  text: string;
  /** Pliki, których ten powód nie pozwala wygenerować (to samo, co robią generatory). */
  files: readonly HeldJpkFile[];
}

const BOTH: readonly HeldJpkFile[] = ['JPK_FA', 'JPK_V7M'];
const FA_ONLY: readonly HeldJpkFile[] = ['JPK_FA'];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Powody, dla których JPK FaktWay nie wykaże tej sprzedaży (te same co
 * odmowa w `amountsOf`), z plikiem, którego dotyczą. Oznaczenia, które
 * JPK_V7M wykazuje, a JPK_FA nie (`amountsOf` z `receiptInvoiceAsFp` i
 * `gtuInRow`, plan kompletnej aplikacji 1.2 i 2.6 część 2b-2), wstrzymują
 * tylko JPK_FA:
 * - poprawne GTU (każdy kod z listy) na zwykłej fakturze;
 * - TP (powiązania; element TP w wierszu sprzedaży JPK_V7M, D22), o ile nie ma FP;
 * - zwykła FP (typ dokumentu FP w JPK_V7M), o ile paragon jest z miesiąca
 *   wcześniejszego niż wystawienie faktury (`receiptInvoiceRow`: paragon
 *   z miesiąca wystawienia albo nieznana data sprzedaży to odmowa JPK_V7M).
 * Stawka „oo” (odwrotne obciążenie) wstrzymuje tylko JPK_V7M: JPK_FA ją wykazuje
 * (`JpkV7mReverseChargeNotSupportedError` w generatorze JPK_V7M).
 * Reszta (TP razem z FP, procedury, podmiot upoważniony, P_22, P_23, marża, kod GTU spoza
 * listy, nieczytelne adnotacje i daty, korekta, zaliczka, ROZ) wstrzymuje oba pliki.
 */
export function contentHeldReasonItems(inv: ParsedInvoice, content: ImportContent): HeldReason[] {
  const items: HeldReason[] = [];
  const regular = inv.invoiceType === 'regular';
  const markers = content.markers;
  const gtu = markers?.gtu ?? [];
  const faOnlyGtu = regular && gtu.length > 0 && gtu.every(isGtuCode);
  const plainFp = regular && markers?.fp === true;
  const saleDay = content.saleDate && ISO_DAY.test(content.saleDate.trim()) ? content.saleDate.trim() : inv.issueDate;
  const fpInIssueMonth = plainFp && saleDay.slice(0, 7) >= inv.issueDate.slice(0, 7);

  // TP (D22): JPK_V7M wykazuje je w wierszu sprzedaży, JPK_FA nie ma pola; z FP razem zostaje odmową obu.
  const faOnlyTp = markers?.tp === true && markers.fp !== true;
  const rest: Fa3Markers | undefined = markers
    ? {
        ...markers,
        ...(plainFp ? { fp: undefined } : {}),
        ...(faOnlyGtu ? { gtu: undefined } : {}),
        ...(faOnlyTp ? { tp: undefined } : {}),
      }
    : undefined;
  const cannot = [...annotationsJpkCannotExpress(content.annotations), ...markersJpkCannotExpress(rest)];
  if (cannot.length) items.push({ text: `oznaczenie, którego FaktWay nie wykazuje w JPK: ${cannot.join(', ')}`, files: BOTH });
  if (plainFp) {
    // Przy nieczytelnych datach sprzedaży daty paragonu nie znamy (powód dat wstrzymuje oba pliki osobno).
    const dateKnown = !content.saleDates?.unclear;
    items.push(fpInIssueMonth && dateKnown
      ? {
          text: 'faktura do paragonu (FP) z paragonem z miesiąca wystawienia faktury albo bez daty sprzedaży: JPK_V7M wykazuje FP tylko dla paragonu z wcześniejszego miesiąca, a JPK_FA nie ma dla niej oznaczenia',
          files: BOTH,
        }
      : { text: 'faktura do paragonu (FP): JPK_FA nie ma dla niej oznaczenia', files: FA_ONLY });
  }
  if (faOnlyTp) {
    items.push({ text: 'powiązania między nabywcą a sprzedawcą (TP): FaktWay nie wykazuje oznaczenia TP w JPK_FA', files: FA_ONLY });
  }
  if (faOnlyGtu) {
    items.push({ text: `oznaczenie GTU w pozycjach (${gtu.join(', ')}): FaktWay nie wykazuje oznaczeń GTU w JPK_FA`, files: FA_ONLY });
  }
  if (content.annotationProblems.length) {
    items.push({ text: `adnotacji z KSeF nie udało się odczytać (${content.annotationProblems.join('; ')})`, files: BOTH });
  }
  if (content.annotations && exemptionMismatch(content.annotations, inv.lines.map((l) => l.vatRate))) {
    items.push({ text: 'zwolnienie z VAT (P_19) niezgodne ze stawkami pozycji', files: BOTH });
  }
  if (content.saleDates?.unclear) {
    const lineDates = [...new Set((content.saleDates.lines ?? []).map((l) => l.date))].sort();
    items.push({
      text: inv.saleDateProblems?.length
        ? `daty sprzedaży nie udało się odczytać (${inv.saleDateProblems.join('; ')})`
        : `pozycje mają różne daty sprzedaży (P_6A: ${lineDates.join(', ')}${content.saleDate ? `; P_6: ${content.saleDate}` : ''})`,
      files: BOTH,
    });
  }
  // Stawka „oo” (odwrotne obciążenie) to stawka FaktWay, ale JPK_V7M jej nie wykazuje (`JpkV7mReverseChargeNotSupportedError`).
  // Powód osobny także przy samej „oo” bez innych oznaczeń (JPK_FA takiej faktury powstaje, JPK_V7M nie).
  if (inv.lines.some((l) => l.vatRate.trim().toLowerCase() === 'oo')) {
    items.push({ text: 'stawka „oo” (odwrotne obciążenie): FaktWay nie wykazuje jej w JPK_V7M', files: ['JPK_V7M'] });
  }
  return items;
}

/** Same powody (tekst) do ostrzeżenia na początku raportu importu. */
export function contentHeldReasons(inv: ParsedInvoice, content: ImportContent): string[] {
  return contentHeldReasonItems(inv, content).map((item) => item.text);
}
