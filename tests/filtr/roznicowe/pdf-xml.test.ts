import fc from 'fast-check';
import PDFDocument from 'pdfkit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { parseFa3Xml } from '@/lib/import/fa3-parser';
import { renderInvoicePdf } from '@/lib/pdf/invoice-renderer';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { finalizeInvoice, type InvoiceInput } from '@/lib/xml/invoice-calculator';
import type { Invoice, VatRate } from '@/types/invoice';

import { dzien, nip } from '../generatory/ksiegowosc';
import { opcje, PRZYPADKI } from '../generatory/ustawienia';

/**
 * NZ-FA-11 (żelazny filtr, uzupełnienie po spisie luk z 16.11): PDF pokazuje
 * te same kwoty, numer KSeF i dane co XML. Test różnicowy na prawdziwych
 * `generateFA3Xml` i `renderInvoicePdf` z tą samą fakturą (`finalizeInvoice`):
 * XML czyta `parseFa3Xml` i elementy sum stawek, PDF to napisy podane do
 * pdfkit (`PDFDocument.prototype.text`, jak w `tests/unit/invoice-pdf-zw.test.ts`).
 *
 * Na PDF muszą być z XML: numer (P_2), data wystawienia (P_1) i sprzedaży
 * (P_6), nazwa i NIP sprzedawcy i nabywcy we własnym bloku, każda pozycja
 * wierszem tabeli (Lp, P_7, P_8B, P_8A, P_9A, P_11, P_12), wiersz
 * podsumowania każdej stawki z netto i VAT z P_13_x i P_14_x
 * (PDF sumuje pozycje sam, XML z generatora, więc to dwa liczenia), „Do
 * zapłaty” równe P_15 i numer KSeF, gdy faktura go ma. Zwykła faktura VAT
 * w złotych; korekty, zaliczki i waluty mają własne testy.
 */

/** Stawka, jej etykieta w podsumowaniu PDF i elementy sum w XML (`lib/xml/fa3-generator.ts`). */
const STAWKI: ReadonlyArray<{ stawka: VatRate; etykieta: string; netto: string; vat: string | null }> = [
  { stawka: '23', etykieta: '23%', netto: 'P_13_1', vat: 'P_14_1' },
  { stawka: '8', etykieta: '8%', netto: 'P_13_2', vat: 'P_14_2' },
  { stawka: '5', etykieta: '5%', netto: 'P_13_3', vat: 'P_14_3' },
  { stawka: '0', etykieta: '0%', netto: 'P_13_6_1', vat: null },
  { stawka: 'zw', etykieta: 'zw.', netto: 'P_13_7', vat: null },
];
const PODSTAWA_ZW = 'art. 113 ust. 1 ustawy o VAT';
const ADRES = { countryCode: 'PL', addressLine1: 'ul. Prosta 1', addressLine2: '00-001 Warszawa' };
/** Nazwy z polskimi znakami i znakami, które XML musi zapisać jako encje. */
const NAZWY = ['Firma & Syn sp. z o.o.', 'Jan Kowalski „Zakład Łódź”', 'Spółdzielnia <Pod Dębem>', 'ABC'];

/** Kwota jak na PDF (`money` w `lib/pdf/invoice-renderer.ts`): „1 234,56”. */
const zl = (n: number) => n.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Wartości elementu XML (bez przedrostków przestrzeni nazw, jak w pliku z generatora). */
const elementy = (xml: string, nazwa: string) => [...xml.matchAll(new RegExp(`<${nazwa}>([^<]*)</${nazwa}>`, 'g'))].map((m) => m[1]!);
/** Ilość i cena jak na PDF (`decimal4`): od 2 do 4 miejsc. */
const do4 = (n: number) => n.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
/** Etykieta stawki w kolumnie VAT pozycji, z P_12 pliku. */
const ETYKIETA_P12: Readonly<Record<string, string>> = { '23': '23%', '8': '8%', '5': '5%', '0 KR': '0%', zw: 'zw.' };
/** Czy napisy mają te komórki jedna po drugiej (wiersz tabeli pozycji). */
const maCiag = (napisy: readonly string[], komorki: readonly string[]) =>
  napisy.some((_, i) => komorki.every((k, j) => napisy[i + j] === k));

/** Napisy, które renderer podaje do pdfkit. */
async function wydruk(faktura: Invoice, ksefNumber: string | null): Promise<string[]> {
  const text = vi.spyOn(PDFDocument.prototype, 'text');
  try {
    const pdf = await renderInvoicePdf(faktura, { ksefNumber });
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    return text.mock.calls.map((c) => String(c[0]));
  } finally {
    text.mockRestore();
  }
}

/** Różnice PDF względem XML tej samej faktury (pusta lista: zgodne). */
async function roznice(faktura: Invoice, ksefNumber: string | null): Promise<string[]> {
  const xml = generateFA3Xml(faktura, { generatedAt: new Date('2026-11-17T10:00:00Z') });
  const z = parseFa3Xml(xml);
  const napisy = await wydruk(faktura, ksefNumber);
  const caly = napisy.join('\n');
  const brak: string[] = [];
  const musi = (opis: string, ok: boolean) => {
    if (!ok) brak.push(opis);
  };

  musi(`numer ${z.invoiceNumber}`, caly.includes(z.invoiceNumber));
  musi(`data wystawienia ${z.issueDate}`, caly.includes(z.issueDate));
  if (z.saleDate) musi(`data sprzedaży ${z.saleDate}`, caly.includes(z.saleDate));
  // Blok strony na PDF: nagłówek, nazwa, „NIP: …” (`drawParties`), więc NIP i nazwa należą do właściwej strony.
  for (const [naglowek, strona] of [['SPRZEDAWCA', z.seller], ['NABYWCA', z.buyer]] as const) {
    musi(`${naglowek}: nazwa i NIP ${strona.name}, ${strona.nip}`, maCiag(napisy, [naglowek, strona.name, `NIP: ${strona.nip}`]));
  }
  // Wiersz pozycji: Lp, nazwa, ilość, j.m., cena netto, wartość netto, stawka (`drawLineItems`; brutto pozycji nie ma w P_11).
  const p12 = elementy(xml, 'P_12');
  for (const [i, p] of z.lines.entries()) {
    const komorki = [String(i + 1), p.name, do4(p.quantity), p.unit, do4(p.unitPriceNet), zl(p.netAmount), ETYKIETA_P12[p12[i] ?? ''] ?? `P_12=${p12[i]}`];
    musi(`pozycja ${i + 1}: ${komorki.join(' | ')}`, maCiag(napisy, komorki));
  }
  for (const s of STAWKI) {
    const netto = elementy(xml, s.netto);
    if (netto.length === 0) continue;
    const vat = s.vat ? Number(elementy(xml, s.vat)[0] ?? 0) : 0;
    const wiersz = `${s.etykieta}  netto ${zl(Number(netto[0]))}  VAT ${zl(vat)}`;
    musi(`podsumowanie stawki: ${wiersz}`, napisy.includes(wiersz));
  }
  const p15 = elementy(xml, 'P_15');
  musi(`do zapłaty z P_15 (${p15.join(', ')})`, p15.length === 1 && napisy.includes(`Do zapłaty: ${zl(Number(p15[0]))} PLN`));
  if (ksefNumber) musi(`numer KSeF ${ksefNumber}`, napisy.includes(`Numer KSeF: ${ksefNumber}`));
  else musi('bez numeru KSeF', !caly.includes('Numer KSeF:'));
  return brak;
}

function faktura(input: Omit<InvoiceInput, 'type' | 'payment'>): Invoice {
  const gotowa = finalizeInvoice({
    ...input,
    type: 'VAT',
    payment: { currency: 'PLN', dueDate: '2026-12-31', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
  });
  return input.lines.some((l) => l.vatRate === 'zw') ? { ...gotowa, annotations: { vatExemptionBasis: PODSTAWA_ZW } } : gotowa;
}

const pozycja = fc.record({
  name: fc.constantFrom('Usługa', 'Towar „Łódź”', 'Licencja & wsparcie', 'Mąka <typ 500>'),
  unit: fc.constantFrom('szt', 'h', 'kg'),
  // 0,01 do 100 jednostek i 0,01 do 10 000 zł za jednostkę.
  quantity: fc.integer({ min: 1, max: 10_000 }).map((q) => q / 100),
  unitPriceNet: fc.integer({ min: 1, max: 1_000_000 }).map((c) => c / 100),
  vatRate: fc.constantFrom(...STAWKI.map((s) => s.stawka)),
});
const strona = fc.record({ nip, name: fc.constantFrom(...NAZWY) }).map((s) => ({ ...s, address: ADRES }));
const losowa = fc
  .record({
    numer: fc.integer({ min: 1, max: 999 }),
    wystawiona: dzien(2026),
    dzienWczesniej: fc.integer({ min: 0, max: 20 }),
    seller: strona,
    buyer: strona,
    pozycje: fc.array(pozycja, { minLength: 1, maxLength: 6 }),
    zKsef: fc.boolean(),
  })
  .map(({ numer, wystawiona, dzienWczesniej, seller, buyer, pozycje, zKsef }) => {
    const sprzedaz = new Date(Date.parse(`${wystawiona}T00:00:00Z`) - dzienWczesniej * 86_400_000).toISOString().slice(0, 10);
    const f = faktura({
      internalNumber: `FV ${numer}/${wystawiona.slice(5, 7)}/${wystawiona.slice(0, 4)}`,
      issueDate: wystawiona,
      saleDate: sprzedaz,
      seller,
      buyer,
      lines: pozycje.map((p, i) => ({ ...p, ordinal: i + 1 })),
    });
    return { f, ksef: zKsef ? `${seller.nip}-${wystawiona.replaceAll('-', '')}-0A1B2C3D4E5F-7A` : null };
  });

describe('NZ-FA-11: PDF pokazuje te same kwoty, numer KSeF i dane co XML', () => {
  // Walidacja faktury liczy „za ile dni” od dzisiaj; stały koniec 2026 r. trzyma
  // każdą datę z generatora w dozwolonym oknie bez zależności od dnia uruchomienia.
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-31T12:00:00Z'));
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it('faktura z pięcioma stawkami, kilkoma pozycjami tej samej stawki i numerem KSeF', async () => {
    const f = faktura({
      internalNumber: 'FV 7/11/2026',
      issueDate: '2026-11-17',
      saleDate: '2026-11-16',
      seller: { nip: '5260001246', name: NAZWY[0]!, address: ADRES },
      buyer: { nip: '5252241585', name: NAZWY[2]!, address: ADRES },
      lines: [
        { ordinal: 1, name: 'Usługa', unit: 'h', quantity: 3, unitPriceNet: 123.45, vatRate: '23' },
        { ordinal: 2, name: 'Towar „Łódź”', unit: 'szt', quantity: 0.33, unitPriceNet: 0.07, vatRate: '23' },
        { ordinal: 3, name: 'Mąka <typ 500>', unit: 'kg', quantity: 12.5, unitPriceNet: 3.99, vatRate: '5' },
        { ordinal: 4, name: 'Licencja & wsparcie', unit: 'szt', quantity: 1, unitPriceNet: 1999.99, vatRate: '8' },
        { ordinal: 5, name: 'Usługa', unit: 'szt', quantity: 1, unitPriceNet: 100, vatRate: '0' },
        { ordinal: 6, name: 'Usługa', unit: 'szt', quantity: 2, unitPriceNet: 50, vatRate: 'zw' },
      ],
    });
    expect(await roznice(f, '5260001246-20261117-0A1B2C3D4E5F-7A')).toEqual([]);
  });

  // Przebieg to XML i PDF jednej faktury (kilkadziesiąt milisekund), więc w nocy
  // najwyżej 1000 przebiegów zamiast `FILTR_PRZYPADKI`.
  it('losowe faktury: każda pozycja, stawka, suma, strony, daty i numer KSeF jak w XML', async () => {
    await fc.assert(
      fc.asyncProperty(losowa, async ({ f, ksef }) => {
        expect(await roznice(f, ksef)).toEqual([]);
      }),
      opcje(Math.min(PRZYPADKI, 1000)),
    );
  }, 300_000);
});
