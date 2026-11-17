import { describe, expect, it } from 'vitest';

import {
  kluczDokumentuKosztu,
  komunikatDublaKosztu,
  ODMOWA_DUBLA_KOSZTU,
  zdublowanyDokument,
  type DokumentKosztu,
} from '@/lib/expenses/jeden-koszt-dokumentu';

/**
 * FZ-022 (RP-KOSZT-01): klucz dokumentu kosztu, kiedy grupa jest dublem
 * i odmowa (`lib/expenses/jeden-koszt-dokumentu.ts`). Klucz: NIP sprzedawcy,
 * numer i rok wystawienia, bez rodzaju (numeracja od nowa co rok daje ten sam
 * numer innej faktury; faktura uproszczona z KSeF ma rodzaj „invoice”, a jej
 * zdjęcie „simplified_invoice”). Dubel: KSeF i spoza KSeF dowolnego rodzaju
 * albo kopia spoza KSeF (to samo brutto albo, przy fakturach, ta sama kolumna
 * KPiR; dwa paragony tylko przy tym samym dniu i brutto). Pełna ścieżka
 * (runnery i odczyty) jest w `tests/unit/koszt-jeden-dokument.test.ts`.
 */

const faktura = (o: Partial<DokumentKosztu> = {}): DokumentKosztu => ({
  seller_nip: '5260001246',
  document_number: 'FV/7/02/2027',
  issue_date: '2027-02-05',
  seller_name: 'Sklep Przykład',
  source: 'ocr_photo',
  ksef_invoice_id: null,
  document_type: 'invoice',
  ocr_extracted_data: { document_type: 'invoice' },
  gross_amount: 123,
  ...o,
});
const zKsef = (o: Partial<DokumentKosztu> = {}) =>
  faktura({ source: 'ksef_inbox', ksef_invoice_id: '11111111-1111-4111-8111-111111111111', ocr_extracted_data: null, ...o });
const paragon = (o: Partial<DokumentKosztu> = {}) =>
  faktura({ document_number: '4711', document_type: 'receipt', ocr_extracted_data: { document_type: 'receipt' }, gross_amount: 61.5, ...o });

describe('FZ-022: klucz dokumentu kosztu', () => {
  it('faktura: NIP bez kresek i z PL, numer bez spacji i wielkości liter to ten sam dokument w tym samym roku', () => {
    const a = kluczDokumentuKosztu(faktura());
    expect(a).not.toBeNull();
    expect(kluczDokumentuKosztu(faktura({ seller_nip: '526-000-12-46', document_number: ' fv/7/02/2027 ' }))).toBe(a);
    expect(kluczDokumentuKosztu(faktura({ seller_nip: 'PL5260001246', issue_date: '2027-03-01' }))).toBe(a);
  });

  it('faktura z tym samym NIP-em i numerem w innym roku to inna faktura', () => {
    expect(kluczDokumentuKosztu(faktura({ issue_date: '2026-02-05' }))).not.toBe(kluczDokumentuKosztu(faktura()));
    expect(zdublowanyDokument([faktura({ document_number: '15', issue_date: '2026-12-15' }), zKsef({ document_number: '15' })])).toBeNull();
  });

  it('rodzaj nie rozdziela kopii od faktury z KSeF: zdjęcie faktury uproszczonej albo paragonu z tym numerem to dubel', () => {
    for (const kopia of [
      faktura({ document_type: 'simplified_invoice', ocr_extracted_data: { document_type: 'simplified_invoice' } }),
      faktura({ document_type: 'receipt', ocr_extracted_data: { document_type: 'receipt' } }),
      faktura({ document_type: 'invoice', ocr_extracted_data: { document_type: 'simplified_invoice' } }),
    ]) {
      expect(zdublowanyDokument([kopia, zKsef()])).toMatchObject({ ile: 2, zKsef: true });
    }
  });

  it('paragon: ten sam numer z innego dnia albo z inną kwotą to inny paragon (sieć z jednym NIP-em ma wiele kas)', () => {
    expect(zdublowanyDokument([paragon(), paragon({ issue_date: '2027-02-06' })])).toBeNull();
    expect(zdublowanyDokument([paragon(), paragon({ gross_amount: 61.51 })])).toBeNull();
    // Zdjęcie tego samego paragonu wgrane dwa razy.
    expect(zdublowanyDokument([paragon(), paragon()])).toMatchObject({ numer: '4711', ile: 2 });
    // Paragon z NIP-em z odczytu OCR (zapisany jako `invoice`) liczy się jak paragon.
    const zNipem = (o: Partial<DokumentKosztu> = {}) => paragon({ document_type: 'invoice', ocr_extracted_data: { document_type: 'simplified_invoice' }, ...o });
    expect(zdublowanyDokument([zNipem(), zNipem({ issue_date: '2027-02-07' })])).toBeNull();
  });

  it('bez NIP-u z 10 cyfr albo bez numeru: bez klucza i bez odmowy', () => {
    expect(kluczDokumentuKosztu(faktura({ seller_nip: null }))).toBeNull();
    expect(kluczDokumentuKosztu(faktura({ seller_nip: 'DE123456789' }))).toBeNull();
    expect(kluczDokumentuKosztu(faktura({ document_number: '  ' }))).toBeNull();
    expect(zdublowanyDokument([faktura({ seller_nip: null }), faktura({ seller_nip: null })])).toBeNull();
  });
});

describe('FZ-022: kiedy grupa jest dublem', () => {
  it('dwa koszty z KSeF z tym samym kluczem (np. faktura i korekta z tym samym numerem): dla KSeF to dwa dokumenty', () => {
    expect(zdublowanyDokument([zKsef(), zKsef({ ksef_invoice_id: '11111111-1111-4111-8111-111111111112' })])).toBeNull();
  });

  it('koszty spoza KSeF z różnymi kwotami (dokument rozpisany na dwie kolumny KPiR): bez odmowy, z tą samą kwotą: dubel', () => {
    expect(zdublowanyDokument([faktura({ gross_amount: 73.8, kpir_column: 'col_10' }), faktura({ source: 'manual', gross_amount: 49.2, kpir_column: 'col_11' })])).toBeNull();
    // Ta sama kolumna i inna kwota to raczej kopia ze źle odczytaną kwotą niż rozpisanie.
    expect(zdublowanyDokument([faktura({ gross_amount: 123, kpir_column: 'col_13' }), faktura({ source: 'manual', gross_amount: 132, kpir_column: 'col_13' })])).toMatchObject({ ile: 2 });
    expect(zdublowanyDokument([faktura(), faktura({ source: 'manual' })])).toMatchObject({ ile: 2, zKsef: false });
    // Kwota jako tekst (`numeric` z bazy) to ta sama kwota.
    expect(zdublowanyDokument([faktura({ gross_amount: '123.00' }), faktura({ gross_amount: 123 })])).toMatchObject({ ile: 2 });
  });

  it('koszt z KSeF i kopia spoza KSeF to dubel także przy innej kwocie (OCR bywa błędny)', () => {
    expect(zdublowanyDokument([faktura({ gross_amount: 132 }), zKsef()])).toMatchObject({ ile: 2, zKsef: true });
  });

  it('kilka dokumentów z dublem: odmowa podaje pierwszy i liczbę wszystkich', () => {
    const d = zdublowanyDokument([faktura(), zKsef(), faktura({ document_number: 'FV/9/02/2027' }), zKsef({ document_number: 'FV/9/02/2027' })]);
    expect(d).toMatchObject({ numer: 'FV/7/02/2027', dokumentow: 2 });
    expect(komunikatDublaKosztu(d!)).toContain('Takich dokumentów w tym okresie jest 2.');
  });
});

describe('FZ-022: odmowa z numerem, datą i źródłami', () => {
  it('zdjęcie i faktura z KSeF: numer, data i nazwa z KSeF, oba źródła, wyjście przy koszcie ze zdjęcia', () => {
    const d = zdublowanyDokument([faktura({ document_number: 'fv/7/02/2027', issue_date: '2027-02-04', seller_name: 'SKLEP' }), zKsef()]);
    expect(d).toEqual({
      numer: 'FV/7/02/2027',
      sprzedawca: 'Sklep Przykład',
      data: '2027-02-05',
      ile: 2,
      zKsef: true,
      zrodla: ['ze Skrzynki KSeF', 'ze zdjęcia'],
      dokumentow: 1,
    });
    const komunikat = komunikatDublaKosztu(d!);
    expect(komunikat.startsWith(ODMOWA_DUBLA_KOSZTU)).toBe(true);
    expect(komunikat).toContain('FV/7/02/2027 z 05.02.2027 (2 razy: ze Skrzynki KSeF i ze zdjęcia)');
    // Bez nazwy sprzedawcy: treść odmowy eksportu trafia też do dziennika zadań.
    expect(komunikat).not.toContain('Sklep');
    expect(komunikat).toContain('przy koszcie ze zdjęcia albo wpisanym ręcznie wyłącza się w Kosztach „Uwzględnij w KPiR”');
  });

  it('trzy koszty z trzech źródeł: liczba i wszystkie źródła; bez KSeF wyjście przy pozostałych', () => {
    const d = zdublowanyDokument([faktura(), faktura({ source: 'manual' }), faktura({ source: 'import' })]);
    expect(d).toMatchObject({ ile: 3, zKsef: false, zrodla: ['ze zdjęcia', 'wpisany ręcznie', 'z importu'] });
    const komunikat = komunikatDublaKosztu(d!);
    expect(komunikat).toContain('(3 razy: ze zdjęcia, wpisany ręcznie i z importu)');
    expect(komunikat).toContain('przy pozostałych wyłącza się w Kosztach');
  });

  it('bez trybu rozkazującego i bez długich myślników, także bez daty', () => {
    const teksty = [
      komunikatDublaKosztu({ numer: 'FV/1', sprzedawca: 'A', data: null, ile: 2, zKsef: true, zrodla: ['ze Skrzynki KSeF', 'ze zdjęcia'] }),
      komunikatDublaKosztu({ numer: 'FV/1', sprzedawca: 'A', ile: 2, zKsef: false }),
    ];
    for (const t of teksty) {
      expect(t).not.toMatch(/[—–]/);
      expect(t).not.toMatch(/\b(wyłącz|zostaw|sprawdź|usuń|kliknij)\b/i);
    }
  });
});
