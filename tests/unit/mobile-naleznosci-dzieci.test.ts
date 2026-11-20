/**
 * U42 (obchód aplikacji 20.11.2026, R1): karta „Do zapłaty od klientów” na
 * telefonie sumowała po liście faktur, więc niezapłacona zaliczka i jej
 * faktura rozliczająca liczyły się obie (615 zł + 615 zł = 1230 zł), a
 * strona i serwer pokazują 615 zł.
 *
 * Reguła strony (`lib/dashboard/receivables.ts`, widok `invoices_overdue` z
 * 00145, `tests/unit/receivables.test.ts`): faktura z „dzieckiem” nie jest
 * należnością. Dzieckiem jest każdy wiersz tej firmy, który wskazuje ją w
 * `parent_invoice_id` (korekta) albo w `advance_invoice_ids` (rozliczenie),
 * w dowolnym statusie: także szkic, odrzucone i błąd wysyłki. Sama korekta
 * nie jest należnością nigdy. Liczy się też tylko dodatnia reszta do
 * zapłaty. Testy idą przez prawdziwe funkcje telefonu: wiersz bazy,
 * `fakturaZBazy`, `naleznosciOtwarte`, `sumaDoZaplaty`.
 */
import { describe, expect, it, vi } from 'vitest';

// Strona czyta środowisko KSeF w `getReceivables`; tu liczy ją sam predykat, środowisko jest stałe.
vi.mock('@/lib/ksef/claim-environment', () => ({ requireConfiguredKsefEnvironment: () => 'production' }));

import { isReceivableBase } from '../../lib/dashboard/receivables';
import { outstandingOf } from '../../lib/invoices/amount-due';
import { fakturaZBazy, grosze, KOLUMNY_FAKTURY, type WierszFaktury } from '../../mobile/src/lib/dane/mapowanie';
import { naleznosciOtwarte, statusFaktury, sumaDoZaplaty } from '../../mobile/src/lib/status-faktury';

const NIP = '1234567890';
const DZIS = '2026-11-20';

/** Faktura wystawiona jak z lokalnej bazy obchodu: przyjęta, niezapłacona, termin 16.11.2026. */
function wiersz(zmiany: Partial<WierszFaktury> & { id: string }): WierszFaktury {
  return {
    internal_number: `FV/${zmiany.id}`,
    invoice_kind: 'regular',
    issue_date: '2026-11-02',
    sale_date: '2026-11-01',
    payment_due_date: '2026-11-16',
    ksef_status: 'accepted',
    ksef_number: `${NIP}-20261102-ABCDEF-12`,
    net_total: '1000.00',
    vat_total: '230.00',
    gross_total: '1230.00',
    currency: 'PLN',
    payment_status: 'unpaid',
    paid_amount: 0,
    buyer_nip: NIP,
    buyer_data: { name: 'Nabywca Testowy sp. z o.o.', nip: NIP },
    seller_data: { name: 'Sprzedawca Testowy', nip: NIP },
    payment_data: { method: 'transfer' },
    parent_invoice_id: null,
    advance_invoice_ids: [],
    created_at: '2026-11-02T08:00:00Z',
    invoice_line_items: [],
    ...zmiany,
  };
}

/** Zaliczka 615,00 zł brutto, przyjęta, niezapłacona. */
const zaliczka = (zmiany: Partial<WierszFaktury> = {}) =>
  wiersz({ id: 'zal-1', invoice_kind: 'advance', net_total: '500.00', vat_total: '115.00', gross_total: '615.00', ...zmiany });

/** Rozliczenie: pełne zamówienie 1230,00 zł brutto, do zapłaty reszta po zaliczce 615,00 zł. */
const rozliczenie = (zmiany: Partial<WierszFaktury> = {}) =>
  wiersz({
    id: 'roz-1',
    invoice_kind: 'final',
    gross_total: '1230.00',
    payment_data: { method: 'transfer', amountDue: 615 },
    advance_invoice_ids: ['zal-1'],
    ...zmiany,
  });

/** Korekta w minus (różnica brutto -230,00 zł) do faktury `vat-1`. */
const korekta = (zmiany: Partial<WierszFaktury> = {}) =>
  wiersz({ id: 'kor-1', invoice_kind: 'correction', gross_total: '-230.00', net_total: '-187.00', vat_total: '-43.00', parent_invoice_id: 'vat-1', ...zmiany });

const vat = (id: string, brutto: string, zmiany: Partial<WierszFaktury> = {}) => wiersz({ id, gross_total: brutto, ...zmiany });

/** To, co robi karta na ekranie Faktury: lista z bazy, należności, suma i licznik po terminie. */
function karta(wiersze: WierszFaktury[]) {
  const otwarte = naleznosciOtwarte(wiersze.map(fakturaZBazy));
  const zalegle = otwarte.filter((f) => statusFaktury(f, DZIS).zalegla);
  return { id: otwarte.map((f) => f.id), razem: sumaDoZaplaty(otwarte), poTerminie: sumaDoZaplaty(zalegle), ilePoTerminie: zalegle.length };
}

describe('zaliczka i jej rozliczenie: dług liczy się raz (U42)', () => {
  it('ZAL 615 + ROZ (brutto 1230, do zapłaty 615): karta pokazuje 615,00 zł, nie 1230,00 zł', () => {
    const k = karta([zaliczka(), rozliczenie()]);
    expect(k.razem).toBe(61500);
    expect(k.id).toEqual(['roz-1']);
    // Obie po terminie (16.11), ale zaległa jest jedna pozycja: reszta po zaliczce.
    expect(k.poTerminie).toBe(61500);
    expect(k.ilePoTerminie).toBe(1);
  });

  it('kolejność wierszy na liście nie ma znaczenia', () => {
    expect(karta([rozliczenie(), zaliczka()]).razem).toBe(61500);
  });

  it('niezapłacona zaliczka bez rozliczenia liczy się w całości (615,00 zł)', () => {
    expect(karta([zaliczka()])).toMatchObject({ razem: 61500, id: ['zal-1'], ilePoTerminie: 1 });
  });

  it('rozliczenie dotyczy tylko wskazanych zaliczek: druga zaliczka zostaje należnością', () => {
    const druga = zaliczka({ id: 'zal-2', gross_total: '100.00' });
    expect(karta([zaliczka(), druga, rozliczenie()])).toMatchObject({ razem: 61500 + 10000, id: ['zal-2', 'roz-1'] });
  });

  it('rozliczenie kilku zaliczek wyklucza każdą z nich', () => {
    const druga = zaliczka({ id: 'zal-2', gross_total: '100.00' });
    const roz = rozliczenie({ advance_invoice_ids: ['zal-1', 'zal-2'], payment_data: { method: 'transfer', amountDue: 515 } });
    expect(karta([zaliczka(), druga, roz])).toMatchObject({ razem: 51500, id: ['roz-1'] });
  });

  // Dziecko w dowolnym statusie wyklucza zaliczkę (jak NOT EXISTS w widoku 00145). Rozliczenie samo liczy się
  // tak jak każda faktura na telefonie: przyjęte albo w drodze do KSeF (`doZaplaty`), niezapłacone.
  it.each([
    ['przyjęte', 'accepted', 61500, ['roz-1']],
    ['w drodze do KSeF (telefon liczy je już jako należność)', 'pending', 61500, ['roz-1']],
    ['szkic', 'draft', 0, []],
    ['odrzucone przez KSeF', 'rejected', 0, []],
    ['błąd wysyłki', 'failed', 0, []],
  ])('rozliczenie %s: zaliczka wykluczona', (_opis, statusKsef, razem, id) => {
    expect(karta([zaliczka(), rozliczenie({ ksef_status: statusKsef })])).toMatchObject({ razem, id });
  });

  it('rozliczenie opłacone: zaliczka nie wraca do należności', () => {
    const roz = rozliczenie({ payment_status: 'paid', paid_amount: '615.00' });
    expect(karta([zaliczka(), roz])).toMatchObject({ razem: 0, id: [], ilePoTerminie: 0 });
  });

  it('rozliczenie opłacone częściowo: do zapłaty reszta rozliczenia, zaliczka wykluczona', () => {
    const roz = rozliczenie({ payment_status: 'partial', paid_amount: '200.00' });
    expect(karta([zaliczka(), roz])).toMatchObject({ razem: 41500, id: ['roz-1'] });
  });

  it('rozliczenie bez nic do zapłaty (reszta 0, stary status) nie jest pozycją „po terminie”', () => {
    const roz = rozliczenie({ payment_data: { method: 'transfer', amountDue: 0 } });
    expect(karta([zaliczka(), roz])).toMatchObject({ razem: 0, id: [], ilePoTerminie: 0 });
  });

  it('inne faktury zostają: zwykła VAT 1000 zł obok pary zaliczka i rozliczenie', () => {
    expect(karta([vat('vat-2', '1000.00'), zaliczka(), rozliczenie()]).razem).toBe(100000 + 61500);
  });

  it('para w walucie obcej nie dodaje się do złotówek, a pozostałe pozycje liczą się jak dotąd', () => {
    const eur = { currency: 'EUR' };
    expect(karta([zaliczka(eur), rozliczenie(eur), vat('vat-2', '500.00')]).razem).toBe(50000);
  });
});

describe('korekta: oryginał z korektą nie liczy się, sama korekta też nie (U42)', () => {
  it.each([
    ['przyjętą', 'accepted'],
    ['w szkicu', 'draft'],
    ['odrzuconą przez KSeF', 'rejected'],
    ['z błędem wysyłki', 'failed'],
  ])('faktura z korektą %s: wypada z należności', (_opis, statusKsef) => {
    expect(karta([vat('vat-1', '1230.00'), korekta({ ksef_status: statusKsef })])).toMatchObject({ razem: 0, id: [] });
  });

  it('korekta w minus nie obniża sumy innych faktur', () => {
    expect(karta([vat('vat-1', '1230.00'), korekta(), vat('vat-2', '500.00')])).toMatchObject({ razem: 50000, id: ['vat-2'] });
  });

  it('korekta w plus też nie jest należnością (korekt nie liczymy nigdy)', () => {
    expect(karta([korekta({ gross_total: '200.00', parent_invoice_id: 'inna-faktura' })]).razem).toBe(0);
  });
});

describe('model telefonu czyta kolumny „dziecka” z bazy', () => {
  it('zapytanie o listę faktur pyta o `parent_invoice_id` i `advance_invoice_ids`', () => {
    expect(KOLUMNY_FAKTURY).toMatch(/\bparent_invoice_id\b/);
    expect(KOLUMNY_FAKTURY).toMatch(/\badvance_invoice_ids\b/);
  });

  it('wiersz bez tych pól (pamięć z poprzedniego otwarcia) działa jak dotąd, bez wyjątku', () => {
    const stary = wiersz({ id: 'stary-1', gross_total: '100.00' });
    delete stary.parent_invoice_id;
    delete stary.advance_invoice_ids;
    expect(karta([stary]).razem).toBe(10000);
  });
});

/**
 * Zgodność ze stroną na tej samej tabeli przypadków: suma „do zapłaty”
 * telefonu = suma `outstandingOf` faktur, które spełniają `isReceivableBase`
 * strony (bez dzieci) i są otwarte, czyli to, co liczy `getReceivables`
 * (pętla w `lib/dashboard/receivables.ts`). Bez statusu „w drodze do KSeF”,
 * bo tylko telefon liczy go jako należność.
 */
describe('zgodność ze stroną (`isReceivableBase`, `outstandingOf`)', () => {
  /** Wiersz telefonu w kształcie wiersza strony: sprzedaż z aplikacji w produkcyjnym KSeF. */
  const wierszStrony = (w: WierszFaktury) => ({
    ...w,
    direction: 'outgoing',
    origin: 'app',
    ksef_environment: 'production',
    invoice_type: ({ regular: 'VAT', advance: 'ZAL', final: 'ROZ', correction: 'KOR' } as Record<string, string>)[w.invoice_kind ?? ''],
  });

  function sumaStrony(wiersze: WierszFaktury[]): number {
    const childIds = new Set<string>();
    for (const w of wiersze) {
      if (w.parent_invoice_id) childIds.add(w.parent_invoice_id);
      for (const id of w.advance_invoice_ids ?? []) childIds.add(id);
    }
    const ctx = { environment: 'production' as const, childIds };
    return wiersze.map(wierszStrony).reduce((s, w) => {
      const otwarta = ['unpaid', 'partial', 'overdue'].includes(w.payment_status ?? '');
      if (!otwarta || !isReceivableBase(w as never, ctx)) return s;
      const reszta = outstandingOf(w as never);
      return reszta > 0 ? s + grosze(reszta) : s;
    }, 0);
  }

  const przypadki: Array<[string, WierszFaktury[]]> = [
    ['zaliczka i rozliczenie (przyjęte)', [zaliczka(), rozliczenie()]],
    ['zaliczka i rozliczenie w szkicu', [zaliczka(), rozliczenie({ ksef_status: 'draft' })]],
    ['zaliczka i rozliczenie odrzucone', [zaliczka(), rozliczenie({ ksef_status: 'rejected' })]],
    ['zaliczka i rozliczenie z błędem wysyłki', [zaliczka(), rozliczenie({ ksef_status: 'failed' })]],
    ['zaliczka i rozliczenie opłacone częściowo', [zaliczka(), rozliczenie({ payment_status: 'partial', paid_amount: '200.00' })]],
    ['zaliczka i rozliczenie opłacone', [zaliczka(), rozliczenie({ payment_status: 'paid', paid_amount: '615.00' })]],
    ['rozliczenie bez reszty do zapłaty', [zaliczka(), rozliczenie({ payment_data: { method: 'transfer', amountDue: 0 } })]],
    ['zaliczka sama', [zaliczka()]],
    ['dwie zaliczki, rozliczona jedna', [zaliczka(), zaliczka({ id: 'zal-2' }), rozliczenie()]],
    ['faktura z korektą i druga faktura', [vat('vat-1', '1230.00'), korekta(), vat('vat-2', '500.00')]],
    ['faktura z korektą w szkicu', [vat('vat-1', '1230.00'), korekta({ ksef_status: 'draft' })]],
    ['zwykłe faktury', [vat('vat-1', '1230.00'), vat('vat-2', '10.10', { payment_status: 'partial', paid_amount: '0.10' })]],
    ['waluta obca', [zaliczka({ currency: 'EUR' }), rozliczenie({ currency: 'EUR' }), vat('vat-2', '500.00')]],
  ];

  it.each(przypadki)('%s: telefon liczy tyle co strona', (_opis, wiersze) => {
    expect(karta(wiersze).razem).toBe(sumaStrony(wiersze));
  });
});
