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
 * XML czyta `parseFa3Xml` i elementy pliku, PDF to napisy podane do pdfkit
 * (`PDFDocument.prototype.text`, jak w `tests/unit/invoice-pdf-zw.test.ts`).
 *
 * Na PDF muszą być z XML, każde w swoim napisie: „Nr” (P_2), „Data
 * wystawienia” (P_1), „Data sprzedaży” (P_6, tylko gdy inna niż P_1), blok
 * każdej strony (nazwa, NIP, AdresL1, AdresL2), każdy wiersz tabeli pozycji
 * (Lp, P_7, P_8B, P_8A, P_9A, P_11, P_12, a brutto pozycji razem równe P_15),
 * wiersz podsumowania każdej stawki z P_13_x i P_14_x i żadnego innego (PDF
 * sumuje pozycje sam, XML z generatora, więc to dwa liczenia), „Do zapłaty”
 * równe P_15, podstawa zwolnienia z P_19A, sposób i termin płatności
 * (FormaPlatnosci, Termin) i rachunek (NrRB). Numeru KSeF XML nie ma: PDF
 * drukuje ten, który faktura dostała w KSeF (`ksefNumber`), i tylko wtedy.
 *
 * Zakres: zwykła faktura VAT w złotych ze stawkami 23, 8, 5, 0 i zw, nabywca
 * z NIP-em, przelew albo gotówka. Poza testem: korekty, zaliczki, nabywca bez
 * NIP-u, stawki oo i np, MPP, metoda kasowa, uwagi, kod QR, faktury z importu
 * i FP (część z nich ma własne testy PDF i XML w `tests/unit`). W produkcji
 * XML powstaje z faktury w zadaniu wysyłki (`lib/jobs/runners/submit-invoice-full.ts`,
 * przy ponowieniu z kopii `fa3_data`), a PDF z wierszy tabel
 * (`loadInvoiceForPdf`); test sprawdza renderer i generator na tej samej
 * fakturze, nie zapis i odczyt z bazy.
 */

/** Stawka, jej etykieta w podsumowaniu PDF i elementy sum w XML (`lib/xml/fa3-generator.ts`). */
const STAWKI: ReadonlyArray<{ stawka: VatRate; etykieta: string; netto: string; vat: string | null }> = [
  { stawka: '23', etykieta: '23%', netto: 'P_13_1', vat: 'P_14_1' },
  { stawka: '8', etykieta: '8%', netto: 'P_13_2', vat: 'P_14_2' },
  { stawka: '5', etykieta: '5%', netto: 'P_13_3', vat: 'P_14_3' },
  { stawka: '0', etykieta: '0%', netto: 'P_13_6_1', vat: null },
  { stawka: 'zw', etykieta: 'zw.', netto: 'P_13_7', vat: null },
];
/** Etykieta stawki w kolumnie VAT pozycji, z P_12 pliku. */
const ETYKIETA_P12: Readonly<Record<string, string>> = { '23': '23%', '8': '8%', '5': '5%', '0 KR': '0%', zw: 'zw.' };
/** FormaPlatnosci z pliku i etykieta sposobu płatności na PDF. */
const SPOSOB: Readonly<Record<string, string>> = { '1': 'Gotówka', '6': 'Przelew' };
const PODSTAWA_ZW = 'art. 113 ust. 1 ustawy o VAT';
/** Nazwy z polskimi znakami, znakami zapisywanymi w XML jako encje i napisami, które wyglądają jak liczby. */
const NAZWY = ['Firma & Syn sp. z o.o.', 'Jan Kowalski „Zakład Łódź”', 'Spółdzielnia <Pod Dębem>', 'Firma "Cudzysłów"', "O'Neill i S-ka", '007', '1e3'];
const ADRESY = [
  { countryCode: 'PL', addressLine1: 'ul. Prosta 1', addressLine2: '00-001 Warszawa' },
  { countryCode: 'PL', addressLine1: 'al. Róż 7/12', addressLine2: '31-123 Kraków' },
  { countryCode: 'PL', addressLine1: 'Rynek 5 & 6', addressLine2: '50-001 Wrocław' },
  { countryCode: 'PL', addressLine1: 'ul. <Krzywa> 2', addressLine2: '80-200 Gdańsk' },
];

/** Kwota jak na PDF (`money` w `lib/pdf/invoice-renderer.ts`): „1 234,56”. */
const zl = (n: number) => n.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Ilość i cena jak na PDF (`decimal4`): od 2 do 4 miejsc. */
const do4 = (n: number) => n.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
/** „1 234,56” z PDF na grosze, bez liczb zmiennoprzecinkowych. */
const grosze = (napis: string) => {
  const [calk, ulamek = ''] = napis.replace(/[\s  ]/g, '').split(',');
  return Number(calk) * 100 + Number(ulamek.padEnd(2, '0'));
};
/** Treść elementów XML (bez przedrostków przestrzeni nazw, jak w pliku z generatora), z encjami zamienionymi na znaki. */
const elementy = (xml: string, nazwa: string) =>
  [...xml.matchAll(new RegExp(`<${nazwa}>([^<]*)</${nazwa}>`, 'g'))].map((m) =>
    m[1]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'),
  );
/** Gdzie w napisach zaczyna się ciąg tych komórek (wiersz tabeli, blok strony); -1, gdy go nie ma. */
const ciagOd = (napisy: readonly string[], komorki: readonly string[]) =>
  napisy.findIndex((_, i) => komorki.every((k, j) => napisy[i + j] === k));

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
  const brak: string[] = [];
  const musi = (opis: string, ok: boolean) => {
    if (!ok) brak.push(opis);
  };

  // Nagłówek (`drawHeader`): numer, data wystawienia, data sprzedaży tylko inna niż wystawienia.
  musi(`Nr ${z.invoiceNumber}`, napisy.includes(`Nr ${z.invoiceNumber}`));
  musi(`Data wystawienia: ${z.issueDate}`, napisy.includes(`Data wystawienia: ${z.issueDate}`));
  if (z.saleDate && z.saleDate !== z.issueDate) musi(`Data sprzedaży: ${z.saleDate}`, napisy.includes(`Data sprzedaży: ${z.saleDate}`));
  else musi('bez daty sprzedaży równej dacie wystawienia', !napisy.some((n) => n.startsWith('Data sprzedaży:')));

  // Blok strony (`drawParties`): nagłówek, nazwa, „NIP: …”, dwie linie adresu, więc dane należą do właściwej strony.
  const [l1, l2] = [elementy(xml, 'AdresL1'), elementy(xml, 'AdresL2')];
  for (const [i, naglowek, strona] of [[0, 'SPRZEDAWCA', z.seller], [1, 'NABYWCA', z.buyer]] as const) {
    const blok = [naglowek, strona.name, `NIP: ${strona.nip}`, l1[i] ?? '', l2[i] ?? ''];
    musi(`blok: ${blok.join(' | ')}`, ciagOd(napisy, blok) >= 0);
  }

  // Wiersz pozycji (`drawLineItems`): Lp, nazwa, ilość, j.m., cena netto, wartość netto, stawka, brutto.
  const p12 = elementy(xml, 'P_12');
  const p15 = elementy(xml, 'P_15');
  let bruttoGr = 0;
  for (const [i, p] of z.lines.entries()) {
    const komorki = [String(i + 1), p.name, do4(p.quantity), p.unit, do4(p.unitPriceNet), zl(p.netAmount), ETYKIETA_P12[p12[i] ?? ''] ?? `P_12=${p12[i]}`];
    const od = ciagOd(napisy, komorki);
    musi(`pozycja ${i + 1}: ${komorki.join(' | ')}`, od >= 0);
    if (od >= 0) bruttoGr += grosze(napisy[od + komorki.length] ?? '');
  }
  musi(`brutto pozycji razem ${bruttoGr} gr równe P_15 (${p15.join(', ')})`, p15.length === 1 && bruttoGr === Math.round(Number(p15[0]) * 100));

  // Podsumowanie VAT (`drawVatSummary`): wiersz każdej stawki z pliku i żadnego innego.
  let stawekWXml = 0;
  for (const s of STAWKI) {
    const netto = elementy(xml, s.netto);
    if (netto.length === 0) continue;
    stawekWXml += 1;
    const vat = s.vat ? Number(elementy(xml, s.vat)[0] ?? 0) : 0;
    const wiersz = `${s.etykieta}  netto ${zl(Number(netto[0]))}  VAT ${zl(vat)}`;
    musi(`podsumowanie stawki: ${wiersz}`, napisy.includes(wiersz));
  }
  const wierszeStawek = napisy.filter((n) => /^\S+ {2}netto .+ {2}VAT .+$/.test(n)).length;
  musi(`wierszy stawek na PDF ${wierszeStawek}, w XML ${stawekWXml}`, wierszeStawek === stawekWXml);
  musi(`do zapłaty z P_15 (${p15.join(', ')})`, p15.length === 1 && napisy.includes(`Do zapłaty: ${zl(Number(p15[0]))} PLN`));

  // Podstawa zwolnienia (P_19A) w stopce.
  const p19a = elementy(xml, 'P_19A');
  if (p19a.length > 0) musi(`podstawa zwolnienia ${p19a[0]}`, napisy.some((n) => n.startsWith('Zwolnienie z VAT') && n.endsWith(p19a[0]!)));
  else musi('bez podstawy zwolnienia', !napisy.some((n) => n.startsWith('Zwolnienie z VAT')));

  // Płatność (`drawPayment`): sposób i termin, rachunek tylko wtedy, gdy jest w pliku.
  const [forma, termin, nrRb] = [elementy(xml, 'FormaPlatnosci')[0], elementy(xml, 'Termin')[0], elementy(xml, 'NrRB')[0]];
  musi(
    `sposób ${forma} i termin ${termin}`,
    napisy.some((n) => n.startsWith(`Sposób: ${SPOSOB[forma ?? ''] ?? `FormaPlatnosci=${forma}`}`) && n.endsWith(`Termin: ${termin}`)),
  );
  if (nrRb) musi(`rachunek ${nrRb}`, napisy.some((n) => n.startsWith('Nr rachunku: ') && n.slice('Nr rachunku: '.length).replace(/\D/g, '') === nrRb));
  else musi('bez rachunku', !napisy.some((n) => n.startsWith('Nr rachunku:')));

  if (ksefNumber) musi(`numer KSeF ${ksefNumber}`, napisy.includes(`Numer KSeF: ${ksefNumber}`));
  else musi('bez numeru KSeF', !napisy.some((n) => n.startsWith('Numer KSeF:')));
  return brak;
}

function faktura(input: Omit<InvoiceInput, 'type'>): Invoice {
  const gotowa = finalizeInvoice({ ...input, type: 'VAT' });
  return input.lines.some((l) => l.vatRate === 'zw') ? { ...gotowa, annotations: { vatExemptionBasis: PODSTAWA_ZW } } : gotowa;
}

/** Rachunek PL z poprawną sumą kontrolną IBAN (mod 97), bank 1090 1014 jak w innych testach. */
const rachunek = fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 16, maxLength: 16 }).map((cyfry) => {
  const bban = `10901014${cyfry.join('')}`;
  return `PL${String(98 - Number(BigInt(`${bban}252100`) % BigInt(97))).padStart(2, '0')}${bban}`;
});
const pozycja = fc.record({
  name: fc.constantFrom('Usługa', 'Towar „Łódź”', 'Licencja & wsparcie', 'Mąka <typ 500>', '007'),
  unit: fc.constantFrom('szt', 'h', 'kg'),
  // 0,0001 do 100 jednostek i 0,0001 do 10 000 zł za jednostkę (P_8B i P_9A mają 4 miejsca).
  quantity: fc.integer({ min: 1, max: 1_000_000 }).map((q) => q / 10_000),
  unitPriceNet: fc.integer({ min: 1, max: 100_000_000 }).map((c) => c / 10_000),
  vatRate: fc.constantFrom(...STAWKI.map((s) => s.stawka)),
});
const strona = fc.record({ nip, name: fc.constantFrom(...NAZWY), address: fc.constantFrom(...ADRESY) });
const dzienPo = (iso: string, dni: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + dni * 86_400_000).toISOString().slice(0, 10);
const losowa = fc
  .record({
    numer: fc.integer({ min: 1, max: 999 }),
    wystawiona: dzien(2026),
    sprzedazDniWczesniej: fc.integer({ min: 0, max: 20 }),
    terminDni: fc.integer({ min: 0, max: 60 }),
    seller: strona,
    buyer: strona,
    pozycje: fc.array(pozycja, { minLength: 1, maxLength: 6 }),
    przelew: fc.option(rachunek, { nil: null }),
    zKsef: fc.boolean(),
  })
  .map(({ numer, wystawiona, sprzedazDniWczesniej, terminDni, seller, buyer, pozycje, przelew, zKsef }) => {
    const f = faktura({
      internalNumber: `FV ${numer}/${wystawiona.slice(5, 7)}/${wystawiona.slice(0, 4)}`,
      issueDate: wystawiona,
      saleDate: dzienPo(wystawiona, -sprzedazDniWczesniej),
      seller,
      buyer,
      lines: pozycje.map((p, i) => ({ ...p, ordinal: i + 1 })),
      payment: przelew
        ? { currency: 'PLN', dueDate: dzienPo(wystawiona, terminDni), method: 'transfer', bankAccount: przelew }
        : { currency: 'PLN', dueDate: dzienPo(wystawiona, terminDni), method: 'cash' },
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

  it('przelew, pięć stawek, kilka pozycji tej samej stawki, zwolnienie, inna data sprzedaży i numer KSeF', async () => {
    const f = faktura({
      internalNumber: 'FV 7/11/2026',
      issueDate: '2026-11-17',
      saleDate: '2026-11-16',
      seller: { nip: '5260001246', name: NAZWY[0]!, address: ADRESY[2]! },
      buyer: { nip: '5252241585', name: NAZWY[2]!, address: ADRESY[3]! },
      lines: [
        { ordinal: 1, name: 'Usługa', unit: 'h', quantity: 3, unitPriceNet: 123.45, vatRate: '23' },
        { ordinal: 2, name: 'Towar „Łódź”', unit: 'szt', quantity: 0.3333, unitPriceNet: 0.0725, vatRate: '23' },
        { ordinal: 3, name: 'Mąka <typ 500>', unit: 'kg', quantity: 12.5, unitPriceNet: 3.99, vatRate: '5' },
        { ordinal: 4, name: 'Licencja & wsparcie', unit: 'szt', quantity: 1, unitPriceNet: 1999.99, vatRate: '8' },
        { ordinal: 5, name: 'Usługa', unit: 'szt', quantity: 1, unitPriceNet: 100, vatRate: '0' },
        { ordinal: 6, name: 'Usługa', unit: 'szt', quantity: 2, unitPriceNet: 50, vatRate: 'zw' },
      ],
      payment: { currency: 'PLN', dueDate: '2026-12-01', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
    });
    expect(await roznice(f, '5260001246-20261117-0A1B2C3D4E5F-7A')).toEqual([]);
  });

  it('gotówka, jedna stawka, sprzedaż w dniu wystawienia i bez numeru KSeF', async () => {
    const f = faktura({
      internalNumber: '007',
      issueDate: '2026-03-02',
      saleDate: '2026-03-02',
      seller: { nip: '5260001246', name: NAZWY[5]!, address: ADRESY[0]! },
      buyer: { nip: '5252241585', name: NAZWY[4]!, address: ADRESY[1]! },
      lines: [{ ordinal: 1, name: '1e3', unit: 'szt', quantity: 1234.5, unitPriceNet: 1000.01, vatRate: '23' }],
      payment: { currency: 'PLN', dueDate: '2026-03-02', method: 'cash' },
    });
    expect(await roznice(f, null)).toEqual([]);
  });

  // Przebieg to XML i PDF jednej faktury (kilkanaście milisekund), więc w nocy
  // najwyżej 1000 przebiegów zamiast `FILTR_PRZYPADKI`.
  it('losowe faktury: nagłówek, strony, pozycje, stawki, suma, zwolnienie, płatność i numer KSeF jak w XML', async () => {
    await fc.assert(
      fc.asyncProperty(losowa, async ({ f, ksef }) => {
        expect(await roznice(f, ksef)).toEqual([]);
      }),
      opcje(Math.min(PRZYPADKI, 1000)),
    );
  }, 300_000);
});
