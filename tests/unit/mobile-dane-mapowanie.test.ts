/**
 * Faktury i skrzynka KSeF z bazy na ekranach telefonu
 * (mobile/src/lib/dane/mapowanie.ts, etap M7): te same reguły co strona
 * (`components/invoices/status-badge.tsx`, `(koszty)/inbox/_components/inbox-rows.ts`),
 * kwoty z bazy w złotych na grosze, dzień w Warszawie. NIP-y testowe.
 */
import { describe, expect, it } from 'vitest';

import { amountDueOf, outstandingOf } from '../../lib/invoices/amount-due';
import { bruttoPozycji, nettoPozycji, stawkaTekst, vatPozycji } from '../../mobile/src/dane-przykladowe';
import { doZaplaty, pozostaloDoZaplaty, statusFaktury } from '../../mobile/src/lib/status-faktury';
import {
  dzienWarszawa,
  fakturaZBazy,
  grosze,
  KOLUMNY_FAKTURY,
  KOLUMNY_SKRZYNKI,
  skrzynkaZBazy,
  sprzedawcaSkrzynki,
  statusZBazy,
  type WierszFaktury,
} from '../../mobile/src/lib/dane/mapowanie';

const NIP = '1234567890';

function wiersz(zmiany: Partial<WierszFaktury> = {}): WierszFaktury {
  return {
    id: 'f-1',
    internal_number: 'FV/11/2026/1',
    invoice_kind: 'regular',
    issue_date: '2026-11-02',
    sale_date: '2026-11-01',
    payment_due_date: '2026-11-16',
    ksef_status: 'accepted',
    ksef_number: `${NIP}-20261102-ABCDEF-12`,
    net_total: '1000.10',
    vat_total: '230.02',
    gross_total: '1230.12',
    currency: 'PLN',
    payment_status: 'unpaid',
    paid_amount: 0,
    buyer_nip: NIP,
    buyer_data: { name: 'Nabywca Testowy sp. z o.o.', nip: '0000000000', address: { addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' }, email: 'nabywca@example.test' },
    seller_data: { name: 'Sprzedawca Testowy', nip: NIP, address: { addressLine1: 'ul. Próbna 2' } },
    payment_data: { method: 'transfer', bankAccount: '12 3456 7890', bankName: 'Bank Testowy' },
    notes: null,
    last_error: null,
    last_error_field: null,
    last_error_suggestion: null,
    created_at: '2026-11-02T08:00:00Z',
    invoice_line_items: [
      { ordinal: 2, name: 'Druga', unit: 'szt.', quantity: '1', unit_price_net: '0.10', vat_rate: 'zw', net_amount: '0.10', vat_amount: '0', gross_amount: '0.10' },
      { ordinal: 1, name: 'Pierwsza', unit: 'usł.', quantity: '2.5', unit_price_net: '400.0000', vat_rate: '23', net_amount: '1000.00', vat_amount: '230.02', gross_amount: '1230.02' },
    ],
    ...zmiany,
  };
}

describe('statusy KSeF jak na stronie', () => {
  it('każdy stan bazy ma stan telefonu', () => {
    expect(statusZBazy('accepted')).toBe('przyjeta');
    expect(statusZBazy('rejected')).toBe('odrzucona');
    expect(statusZBazy('failed')).toBe('blad');
    for (const s of ['pending', 'queued', 'sending', 'offline_queued']) expect(statusZBazy(s)).toBe('wysylanie');
    expect(statusZBazy('draft')).toBe('robocza');
    // Nowy stan, którego telefon nie zna: bez obietnicy, że coś trwa albo że KSeF przyjął.
    expect(statusZBazy('cos_nowego')).toBe('robocza');
    expect(statusZBazy(null)).toBe('robocza');
  });

  it('błąd wysyłki nie jest „Odrzucona przez KSeF” i nie czeka na zapłatę', () => {
    const f = fakturaZBazy(wiersz({ ksef_status: 'failed', last_error: 'Brak certyfikatu KSeF', last_error_suggestion: 'Wgraj certyfikat.' }));
    expect(statusFaktury(f, '2026-11-13').tekst).toBe('Błąd wysyłki do KSeF');
    expect(doZaplaty(f)).toBe(false);
    expect(f.blad).toEqual({ komunikat: 'Brak certyfikatu KSeF', pole: '', podpowiedz: 'Wgraj certyfikat.' });
  });

  it('powód błędu tylko przy odrzuconej albo z błędem wysyłki', () => {
    expect(fakturaZBazy(wiersz({ last_error: 'stary błąd' })).blad).toBeUndefined();
    expect(fakturaZBazy(wiersz({ ksef_status: 'rejected', last_error: 'NIP', last_error_field: 'Podmiot2/NIP' })).blad?.pole).toBe('Podmiot2/NIP');
  });
});

describe('faktura wystawiona z bazy', () => {
  it('kwoty w groszach bez błędów zaokrągleń', () => {
    expect(grosze('1230.12')).toBe(123012);
    expect(grosze(0.1 + 0.2)).toBe(30);
    expect(grosze('19.99')).toBe(1999);
    expect(grosze(null)).toBe(0);
    expect(grosze('abc')).toBe(0);
    const f = fakturaZBazy(wiersz());
    expect(f.brutto).toBe(123012);
    expect(f.netto).toBe(100010);
  });

  it('nabywca, sprzedawca, płatność i daty z faktury', () => {
    const f = fakturaZBazy(wiersz());
    expect(f).toMatchObject({
      numer: 'FV/11/2026/1',
      kontrahent: 'Nabywca Testowy sp. z o.o.',
      // `buyer_nip` z kolumny, jak strona; `buyer_data.nip` tylko awaryjnie.
      nipKontrahenta: NIP,
      adresKontrahenta: 'ul. Testowa 1, 00-001 Warszawa',
      emailKontrahenta: 'nabywca@example.test',
      dataWystawienia: '2026-11-02',
      dataSprzedazy: '2026-11-01',
      terminPlatnosci: '2026-11-16',
      statusKsef: 'przyjeta',
      zaplacona: false,
      rodzaj: 'vat',
      metodaPlatnosci: 'Przelew',
      rachunek: '12 3456 7890',
      bank: 'Bank Testowy',
      waluta: 'PLN',
      sprzedawca: { nazwa: 'Sprzedawca Testowy', nip: NIP, adres: 'ul. Próbna 2' },
    });
    expect(fakturaZBazy(wiersz({ buyer_nip: null })).nipKontrahenta).toBe('0000000000');
  });

  it('pozycje po kolei, z kwotami z faktury i stawką zw jako tekst', () => {
    const [a, b] = fakturaZBazy(wiersz()).pozycje;
    expect(a).toMatchObject({ nazwa: 'Pierwsza', ilosc: 2.5, cenaNetto: 40000, stawkaVat: 23, netto: 100000, vat: 23002, brutto: 123002 });
    // Kwoty z faktury, nie przeliczone od nowa (2,5 × 400 × 23% = 230,00, a faktura ma 230,02).
    expect(vatPozycji(a)).toBe(23002);
    expect(bruttoPozycji(a)).toBe(123002);
    expect(stawkaTekst(a)).toBe('23%');
    expect(b).toMatchObject({ nazwa: 'Druga', stawkaVat: 0, stawkaOpis: 'zw' });
    expect(stawkaTekst(b)).toBe('zw');
    expect(nettoPozycji(b)).toBe(10);
  });

  it('rodzaje faktur i forma płatności jak na stronie', () => {
    expect(fakturaZBazy(wiersz({ invoice_kind: 'advance' })).rodzaj).toBe('zaliczkowa');
    expect(fakturaZBazy(wiersz({ invoice_kind: 'correction' })).rodzaj).toBe('korygujaca');
    expect(fakturaZBazy(wiersz({ invoice_kind: 'final' })).rodzaj).toBe('rozliczajaca');
    expect(fakturaZBazy(wiersz({ payment_data: { method: 'cash' } })).metodaPlatnosci).toBe('Gotówka');
    expect(fakturaZBazy(wiersz({ payment_data: { method: 'mobile' } })).metodaPlatnosci).toBe('Płatność mobilna');
  });

  it('zapłata częściowa: nie „Zapłacona”, wpłacona kwota osobno', () => {
    const f = fakturaZBazy(wiersz({ payment_status: 'partial', paid_amount: '200.00' }));
    expect(f.zaplacona).toBe(false);
    expect(f.zaplacono).toBe(20000);
    expect(doZaplaty(f)).toBe(true);
    // „Do zapłaty” na liście i w szczególe: bez wpłaconej części.
    expect(pozostaloDoZaplaty(f)).toBe(123012 - 20000);
    const z = fakturaZBazy(wiersz({ payment_status: 'paid', paid_amount: '1230.12' }));
    expect(z.zaplacona).toBe(true);
    expect(z.zaplacono).toBeUndefined();
    expect(pozostaloDoZaplaty(z)).toBe(0);
  });

  it('szkic bez numeru i bez terminu', () => {
    const f = fakturaZBazy(wiersz({ ksef_status: 'draft', internal_number: null, payment_due_date: null, payment_data: null, ksef_number: null }));
    expect(f).toMatchObject({ numer: 'Bez numeru', statusKsef: 'robocza', terminPlatnosci: '2026-11-02', numerKsef: undefined });
  });

  it('waluta obca zostaje przy fakturze', () => {
    expect(fakturaZBazy(wiersz({ currency: 'eur' })).waluta).toBe('EUR');
    expect(fakturaZBazy(wiersz({ currency: null })).waluta).toBe('PLN');
  });

  it('zapytania nie ciągną całego XML-a faktury (`fa3_data`)', () => {
    expect(KOLUMNY_FAKTURY).not.toMatch(/fa3_data/);
    expect(KOLUMNY_SKRZYNKI).toMatch(/seller_fa3:fa3_data->seller/);
    expect(KOLUMNY_SKRZYNKI).not.toMatch(/fa3_data,/);
  });
});

/**
 * U26 (obchód 20.11.2026): faktura rozliczająca (ROZ, `invoice_kind = 'final'`)
 * ma w `gross_total` PEŁNE zamówienie, a nabywca płaci resztę po zaliczkach,
 * zapisaną przy wystawieniu w `payment_data.amountDue` (art. 106f ust. 3,
 * RP-FA-ROZ-01: P_15 to kwota pozostała do zapłaty). Telefon pokazywał
 * „Do zapłaty” 1230,00 zł zamiast 615,00 zł. Reguła jest kopią `amountDueOf`
 * i `outstandingOf` strony (`lib/invoices/amount-due.ts`); zgodność sprawdza
 * ostatni test z tej grupy na tej samej tabeli przypadków.
 */
describe('faktura rozliczająca: do zapłaty po zaliczkach (U26)', () => {
  /** Szkic z obchodu: pozycja 1000 zł netto + 23% = 1230 brutto, zaliczka ZAL/1/2026 na 615 zł. */
  const rozliczenie = (zmiany: Partial<WierszFaktury> = {}): WierszFaktury =>
    wiersz({
      invoice_kind: 'final',
      net_total: '1000.00',
      vat_total: '230.00',
      gross_total: '1230.00',
      payment_data: { method: 'transfer', amountDue: 615, bankAccount: '12 3456 7890', bankName: 'Bank Testowy' },
      ...zmiany,
    });

  it('do zapłaty to reszta po zaliczce (615,00), a brutto zostaje pełnym zamówieniem (1230,00)', () => {
    const f = fakturaZBazy(rozliczenie());
    expect(f.rodzaj).toBe('rozliczajaca');
    expect(f.brutto).toBe(123000);
    expect(pozostaloDoZaplaty(f)).toBe(61500);
    expect(doZaplaty(f)).toBe(true);
  });

  it('zwykła faktura i zaliczkowa: do zapłaty to całe brutto, `amountDue` poza ROZ nie zmienia kwoty', () => {
    expect(pozostaloDoZaplaty(fakturaZBazy(wiersz()))).toBe(123012);
    // `amountDue` jest w `payment_data` każdej faktury; tylko ROZ liczy od niego (jak `amountDueOf`).
    for (const rodzaj of ['regular', 'advance', 'correction']) {
      const f = fakturaZBazy(wiersz({ invoice_kind: rodzaj, gross_total: '615.00', payment_data: { method: 'transfer', amountDue: 100 } }));
      expect(pozostaloDoZaplaty(f)).toBe(61500);
    }
    // Zwykła faktura bez `payment_data` w ogóle (szkic, stary wiersz).
    expect(pozostaloDoZaplaty(fakturaZBazy(wiersz({ payment_data: null })))).toBe(123012);
  });

  it('rozliczona w całości zaliczkami (`amountDue` 0): do zapłaty 0, brutto bez zmian', () => {
    // Wyzwalacz bazy (00145) oznacza taką ROZ jako zapłaconą od wystawienia.
    const zaplacona = fakturaZBazy(rozliczenie({ payment_data: { method: 'transfer', amountDue: 0 }, payment_status: 'paid' }));
    expect(zaplacona.brutto).toBe(123000);
    expect(pozostaloDoZaplaty(zaplacona)).toBe(0);
    // Nawet gdyby status nie zdążył się przeliczyć, nie żądamy zapłaty pełnego brutto.
    const nieprzeliczona = fakturaZBazy(rozliczenie({ payment_data: { method: 'transfer', amountDue: 0 }, payment_status: 'unpaid' }));
    expect(pozostaloDoZaplaty(nieprzeliczona)).toBe(0);
  });

  it('zapłata częściowa na rozliczeniu liczy się od reszty po zaliczce, nie od brutto', () => {
    const f = fakturaZBazy(rozliczenie({ payment_status: 'partial', paid_amount: '200.00' }));
    expect(f.zaplacono).toBe(20000);
    expect(pozostaloDoZaplaty(f)).toBe(61500 - 20000);
    // Wpłata równa reszcie po zaliczce domyka rozliczenie (wyzwalacz bazy 00145 ustawia wtedy `paid`).
    expect(pozostaloDoZaplaty(fakturaZBazy(rozliczenie({ payment_status: 'partial', paid_amount: '615.00' })))).toBe(0);
    // Zapłacona w całości: 0, jak dotąd.
    expect(pozostaloDoZaplaty(fakturaZBazy(rozliczenie({ payment_status: 'paid', paid_amount: '615.00' })))).toBe(0);
  });

  it('`amountDue` tekstem liczbowym działa jak liczba (z groszami bez błędu zaokrąglenia)', () => {
    expect(pozostaloDoZaplaty(fakturaZBazy(rozliczenie({ payment_data: { amountDue: '615.00' } })))).toBe(61500);
    expect(pozostaloDoZaplaty(fakturaZBazy(rozliczenie({ payment_data: { amountDue: ' 615.10 ' } })))).toBe(61510);
    expect(pozostaloDoZaplaty(fakturaZBazy(rozliczenie({ payment_data: { amountDue: 0.1 + 0.2 } })))).toBe(30);
  });

  it('śmieci w `amountDue` nie psują kwoty: wraca reguła od pełnego brutto (bezpieczniej gonić zbyt dużo niż za mało)', () => {
    for (const zle of ['abc', '', '   ', null, undefined, -5, '-5', Number.NaN, Number.POSITIVE_INFINITY, [615], { kwota: 615 }, true]) {
      const f = fakturaZBazy(rozliczenie({ payment_data: { method: 'transfer', amountDue: zle } }));
      expect(pozostaloDoZaplaty(f), `amountDue = ${JSON.stringify(zle)}`).toBe(123000);
    }
    // Brak `payment_data`, brak klucza, `payment_data` nie będące obiektem.
    for (const pd of [null, undefined, {}, [], 'tekst', 615]) {
      expect(pozostaloDoZaplaty(fakturaZBazy(rozliczenie({ payment_data: pd }))), `payment_data = ${JSON.stringify(pd)}`).toBe(123000);
    }
    // `amountDue` większe od zamówienia (zepsuty wiersz) nie zażąda więcej niż cała faktura.
    expect(pozostaloDoZaplaty(fakturaZBazy(rozliczenie({ payment_data: { amountDue: 5000 } })))).toBe(123000);
  });

  it('brak brutto w wierszu: jak strona (`amountDueOf` bierze brutto 0), bez kwoty ujemnej ani nieskończonej', () => {
    const f = fakturaZBazy(rozliczenie({ gross_total: null }));
    expect(f.brutto).toBe(0);
    expect(pozostaloDoZaplaty(f)).toBe(0);
    expect(amountDueOf({ invoice_kind: 'final', gross_total: null, payment_data: { amountDue: 615 } })).toBe(0);
  });

  it('ta sama kwota co strona (`amountDueOf`, `outstandingOf`) na tej samej tabeli przypadków', () => {
    const przypadki: WierszFaktury[] = [
      wiersz(),
      wiersz({ payment_status: 'partial', paid_amount: '200.00' }),
      wiersz({ invoice_kind: 'advance', gross_total: '615.00', payment_data: { amountDue: 615 } }),
      rozliczenie(),
      rozliczenie({ payment_status: 'partial', paid_amount: '200.00' }),
      rozliczenie({ payment_status: 'partial', paid_amount: '615.00' }),
      rozliczenie({ payment_data: { amountDue: 0 } }),
      rozliczenie({ payment_data: { amountDue: '615.5' } }),
      rozliczenie({ payment_data: { amountDue: 5000 } }),
      rozliczenie({ payment_data: { amountDue: -1 } }),
      rozliczenie({ payment_data: { amountDue: 'abc' } }),
      rozliczenie({ payment_data: { amountDue: '' } }),
      rozliczenie({ payment_data: null }),
    ];
    for (const w of przypadki) {
      const f = fakturaZBazy(w);
      // Strona liczy „zaległość” z wpłat; telefon z `payment_status`. Przypadki mają je spójne.
      const strona = { invoice_kind: w.invoice_kind, gross_total: w.gross_total, payment_data: w.payment_data, paid_amount: w.paid_amount };
      const zapisane = JSON.stringify({ rodzaj: w.invoice_kind, brutto: w.gross_total, platnosc: w.payment_data, wplacono: w.paid_amount });
      expect(pozostaloDoZaplaty(f) / 100, zapisane).toBeCloseTo(outstandingOf(strona), 2);
      // Dla faktury bez wpłat „do zapłaty” to dokładnie `amountDueOf`.
      if (grosze(w.paid_amount) === 0) expect(pozostaloDoZaplaty(f) / 100, zapisane).toBeCloseTo(Math.max(0, amountDueOf(strona)), 2);
    }
  });
});

describe('skrzynka KSeF z bazy', () => {
  const faktura = (zmiany = {}) => ({
    id: 'k-1',
    internal_number: 'TW/1',
    ksef_number: `${NIP}-20261106-000001-01`,
    issue_date: '2026-11-06',
    seller_nip: '1111111111',
    seller_data: { name: 'Dostawca Testowy', nip: NIP },
    seller_fa3: { name: 'Z XML', nip: '2222222222' },
    gross_total: '98.40',
    net_total: '80.00',
    currency: 'PLN',
    ksef_accepted_at: '2026-11-12T23:30:00Z',
    origin: 'ksef_inbox',
    invoice_line_items: [],
    ...zmiany,
  });

  it('sprzedawca: seller_data, potem XML, potem kolumna (jak `sellerDisplay`)', () => {
    expect(sprzedawcaSkrzynki(faktura())).toEqual({ nazwa: 'Dostawca Testowy', nip: NIP });
    expect(sprzedawcaSkrzynki(faktura({ seller_data: null }))).toEqual({ nazwa: 'Z XML', nip: '2222222222' });
    expect(sprzedawcaSkrzynki(faktura({ seller_data: null, seller_fa3: null }))).toEqual({ nazwa: '(bez nazwy sprzedawcy)', nip: '1111111111' });
  });

  it('status z wydatku: nowa, opisana, bez wydatku nic', () => {
    const lista = [faktura({ id: 'a' }), faktura({ id: 'b' }), faktura({ id: 'c' })];
    const [a, b, c] = skrzynkaZBazy(lista, [
      { id: 'w-a', ksef_invoice_id: 'a', is_reviewed: false },
      { id: 'w-b', ksef_invoice_id: 'b', is_reviewed: true },
    ]);
    expect([a.status, a.wydatekId]).toEqual(['nowa', 'w-a']);
    expect([b.status, b.wydatekId]).toEqual(['opisana', 'w-b']);
    expect([c.status, c.wydatekId]).toEqual([undefined, undefined]);
  });

  it('odczyt wydatków się nie udał: wiersze bez statusu, lista zostaje', () => {
    const [a] = skrzynkaZBazy([faktura()], null);
    expect(a.status).toBeUndefined();
    expect(a.sprzedawca).toBe('Dostawca Testowy');
  });

  it('historia z KSeF to archiwum', () => {
    expect(skrzynkaZBazy([faktura({ origin: 'ksef_import' })], [])[0].zHistorii).toBe(true);
  });

  it('dzień przyjęcia w KSeF liczony w Warszawie, nie w UTC', () => {
    expect(skrzynkaZBazy([faktura()], [])[0]).toMatchObject({ otrzymano: '2026-11-13', brutto: 9840, netto: 8000 });
    expect(dzienWarszawa(new Date('2026-06-30T22:30:00Z'))).toBe('2026-07-01');
    expect(dzienWarszawa('nie-data')).toBe('');
  });
});
