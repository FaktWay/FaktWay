import type { OutsideKsefInvoiceInput } from '@/lib/import/outside-ksef-schema';
import { outsideKsefInvoiceSchema } from '@/lib/import/outside-ksef-schema';
import { roundToCents, toGrosze } from '@/lib/xml/invoice-calculator';

/**
 * Logika formularza „Dodaj fakturę spoza KSeF” (krok 1.6, PR C): zamiana pól
 * tekstowych na wejście schematu z #977 i podpowiedź kwoty VAT. Schemat i akcja
 * serwera sprawdzają to samo drugi raz (walidacja po obu stronach).
 */

export interface PozycjaFormularza {
  name: string;
  net: string;
  vatRate: string;
  /** Pusty tekst = VAT liczony ze stawki (podpowiedź); wpisany = kwota z faktury. */
  vat: string;
  exemptionBasis: string;
  gtuCode: string;
  tp: boolean;
}

export interface FormularzSpozaKsef {
  number: string;
  issueDate: string;
  saleDate: string;
  buyerName: string;
  buyerNip: string;
  lines: PozycjaFormularza[];
}

export const PUSTA_POZYCJA: PozycjaFormularza = {
  name: '',
  net: '',
  vatRate: '23',
  vat: '',
  exemptionBasis: '',
  gtuCode: '',
  tp: false,
};

/** „1 234,50” i „1234.5” na liczbę; błąd to `null`. */
export function parseKwota(tekst: string): number | null {
  const t = tekst.replace(/\s/g, '').replace(',', '.');
  if (t === '' || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

const STAWKI_LICZBOWE: Record<string, number> = { '23': 23, '8': 8, '5': 5 };

/** VAT ze stawki (podpowiedź): zaokrąglony do grosza; stawki 0, zw i np dają 0. */
export function podpowiedzVat(net: number, vatRate: string): number {
  const stawka = STAWKI_LICZBOWE[vatRate] ?? 0;
  return roundToCents((toGrosze(net) * stawka) / 10000);
}

/** VAT pozycji: wpisany albo podpowiedź ze stawki. `null`, gdy netto nie jest liczbą. */
export function vatPozycji(p: PozycjaFormularza): number | null {
  const net = parseKwota(p.net);
  if (net === null) return null;
  if (p.vat.trim() !== '') return parseKwota(p.vat);
  return podpowiedzVat(net, p.vatRate);
}

/** Brutto pozycji w złotych (netto + VAT w groszach); `null`, gdy brak kwot. */
export function bruttoPozycji(p: PozycjaFormularza): number | null {
  const net = parseKwota(p.net);
  const vat = vatPozycji(p);
  if (net === null || vat === null) return null;
  return roundToCents((toGrosze(net) + toGrosze(vat)) / 100);
}

/** Wejście dla schematu i akcji; pola, których nie da się odczytać, zostają jako tekst i schemat je odrzuci. */
export function doWejscia(f: FormularzSpozaKsef): unknown {
  return {
    number: f.number,
    issueDate: f.issueDate,
    ...(f.saleDate ? { saleDate: f.saleDate } : {}),
    buyerName: f.buyerName,
    ...(f.buyerNip.trim() ? { buyerNip: f.buyerNip.replace(/[\s-]/g, '') } : {}),
    currency: 'PLN',
    lines: f.lines.map((p) => {
      const net = parseKwota(p.net);
      const vat = vatPozycji(p);
      const brutto = bruttoPozycji(p);
      return {
        name: p.name,
        netAmount: net ?? p.net,
        vatRate: p.vatRate,
        vatAmount: vat ?? p.vat,
        grossAmount: brutto ?? '',
        ...(p.exemptionBasis.trim() ? { exemptionBasis: p.exemptionBasis } : {}),
        ...(p.gtuCode ? { gtuCode: p.gtuCode } : {}),
        ...(p.tp ? { tp: true } : {}),
      };
    }),
  };
}

export type WynikSprawdzenia =
  | { ok: true; wpis: OutsideKsefInvoiceInput }
  | { ok: false; blad: string };

/** Pierwszy błąd schematu jako komunikat z nazwą pola (numer pozycji dla pozycji). */
export function sprawdzFormularz(f: FormularzSpozaKsef): WynikSprawdzenia {
  const wynik = outsideKsefInvoiceSchema.safeParse(doWejscia(f));
  if (wynik.success) return { ok: true, wpis: wynik.data };
  const issue = wynik.error.issues[0];
  const sciezka = issue?.path ?? [];
  const gdzie = sciezka[0] === 'lines' && typeof sciezka[1] === 'number' ? `Pozycja ${sciezka[1] + 1}: ` : '';
  return { ok: false, blad: `${gdzie}${issue?.message ?? 'Sprawdź dane faktury.'}` };
}
