import { describe, expect, it } from 'vitest';

import { komunikatDublaKosztu as odmowaDubla, type ZdublowanyDokument } from '@/lib/expenses/jeden-koszt-dokumentu';
import { komunikatDublaKosztu as brakDublaKpir } from '@/lib/ksiegowosc/kpir-dane';

/**
 * NZ-TRESC-04 dla odmowy przy tym samym dokumencie kosztu dwa razy (FZ-022,
 * RP-KOSZT-01): treść z `lib/expenses/jeden-koszt-dokumentu.ts` (raport
 * i eksport KPiR, portal księgowej, VAT modułu, karty kosztów) i brak KPiR
 * modułu (`lib/ksiegowosc/kpir-dane.ts`) z datą i źródłami. Te same reguły
 * co w `tests/filtr/niezmienniki/braki-dane.test.ts` (wyrażenia przepisane
 * tutaj, bo zmiana linii tamtego testu wymaga zgody): bez słów z listy
 * roboczej, bez trybu rozkazującego i długich myślników, nazwa braku
 * w pierwszym zdaniu, skutek („nie liczymy”) i jego przedmiot (VAT, koszty).
 */

const ZAKAZANE = /(?<![\p{L}])(?:zapłać\p{L}*|musisz|musicie|powinieneś|powinnaś|powinniście|należy(?!\s+do\s+[^\d\s])|zalecamy|radzimy|wybierz\p{L}*|opłaca się|lepiej|najkorzystniej\p{L}*|oszczędzisz|zaoszczędzisz)(?![\p{L}])/iu;
const ROZKAZUJACE = /(?<![\p{L}])(?:uzupełnij|sprawdź|dodaj|wpisz|zmień|kliknij|przejdź|otwórz|zostaw|wyłącz|włącz|przygotuj|napisz|zapisz|skontaktuj|pamiętaj|ustaw|podaj|złóż|prześlij|wyślij|popraw|zaznacz)(?![\p{L}])/iu;
const DLUGIE_MYSLNIKI = /[—–]/;
const NAZWA = /koszt|KPiR|dokument/iu;
const SKUTEK = /nie liczy/iu;
const pierwszeZdanie = (tekst: string) => tekst.split(/\.\s+(?=[\p{Lu}„])/u)[0];

function bledy(tekst: string, przedmiot: RegExp): string[] {
  const wynik: string[] = [];
  const slowo = ZAKAZANE.exec(tekst) ?? ROZKAZUJACE.exec(tekst);
  if (slowo) wynik.push(`słowo „${slowo[0]}”`);
  if (DLUGIE_MYSLNIKI.test(tekst)) wynik.push('długi myślnik');
  if (!NAZWA.test(pierwszeZdanie(tekst))) wynik.push('bez nazwy braku w pierwszym zdaniu');
  if (!SKUTEK.test(tekst)) wynik.push('bez tego, co z kwotą będzie');
  if (!przedmiot.test(tekst)) wynik.push('skutek bez przedmiotu');
  return wynik.map((b) => `${b}: ${tekst}`);
}

const DUBLE: ZdublowanyDokument[] = [
  { numer: 'FV/7/02/2027', sprzedawca: 'Sklep', data: '2027-02-05', ile: 2, zKsef: true, zrodla: ['ze Skrzynki KSeF', 'ze zdjęcia'], dokumentow: 1 },
  { numer: 'FV/7/02/2027', sprzedawca: 'Sklep', data: '2027-02-05', ile: 3, zKsef: true, zrodla: ['ze Skrzynki KSeF', 'ze zdjęcia', 'wpisany ręcznie'], dokumentow: 4 },
  { numer: '4711', sprzedawca: 'Sklep', data: null, ile: 2, zKsef: false, zrodla: ['ze zdjęcia'], dokumentow: 1 },
  { numer: 'FV/7', sprzedawca: 'Sklep', ile: 2, zKsef: false },
];

describe('NZ-TRESC-04: odmowa przy tym samym dokumencie kosztu dwa razy', () => {
  it('treść odmowy odczytu (KPiR, JPK_V7M, karty): nazwa braku, skutek dla kosztów i VAT, bez trybu rozkazującego', () => {
    expect(DUBLE.flatMap((d) => bledy(odmowaDubla(d), /VAT/u))).toEqual([]);
  });

  it('brak KPiR modułu z datą i źródłami albo bez nich: nazwa braku, skutek dla KPiR, bez trybu rozkazującego', () => {
    const teksty = [
      ...DUBLE.map((d) => brakDublaKpir(d)),
      brakDublaKpir({ numer: 'FV/12/2026', sprzedawca: 'Dostawca Testowy', ile: 2 }),
    ];
    expect(teksty.flatMap((t) => bledy(t, /KPiR/u))).toEqual([]);
  });
});
