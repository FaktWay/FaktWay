import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { NextResponse } from 'next/server';
import { z } from 'zod';

import type { MobileCaller } from '@/lib/api/mobile/auth';
import type {
  KsiegaTelefonuOdpowiedz,
  KpirRaportOdpowiedz,
  PlikKsiegiOdpowiedz,
  PlikKsiegiTelefonu,
  WierszKsiegiTelefonu,
  WpisRecznyTelefonu,
} from '@/lib/api/mobile/kontrakt-ksiegi';
import { MobileUpstreamError, mobileError, mobileJson } from '@/lib/api/mobile/responses';
import { readJsonBody } from '@/lib/api/mobile/tresc';
import {
  buildKpirEntries,
  blockingSaleInvoices,
  COLUMN_BADGE_TEXT,
  costSlices,
  kpirDailySeries,
  marginPct,
  nonDeductedVatSum,
  uncountedCosts,
} from '@/components/reports/kpir/kpir-model';
import { kpirPrzykladowe, trybDanych, type KontekstStrony } from '@/lib/demo/tryb-danych';
import { monthLabel, monthRange, shiftMonth } from '@/lib/expenses/month';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { formatPlMoney } from '@/lib/format/pl';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { brakiOkresu, etykietaStawki, sumyOkresu, type Ewidencja } from '@/lib/ksiegowosc/ewidencja';
import { czytajEwidencje, KOMUNIKAT_ODCZYT } from '@/lib/ksiegowosc/ewidencja-dane';
import { pobierzJpkEwp, pobierzJpkPkpir } from '@/lib/ksiegowosc/ewidencja-pliki';
import { brakiKpirOkresu, NAZWY_KOLUMN, sumyKpir, wierszeKpirOkresu, type Kpir, type WierszKpir } from '@/lib/ksiegowosc/kpir';
import { czytajKpir } from '@/lib/ksiegowosc/kpir-dane';
import { odeslanieDoKsiegi } from '@/lib/ksiegowosc/odeslanie';
import { czytajWersjeProfilu, PROFIL_OD_MIN } from '@/lib/ksiegowosc/profil';
import { spisyPliku, type Spis } from '@/lib/ksiegowosc/spis-z-natury';
import { wersjaMiesiaca } from '@/lib/ksiegowosc/ten-miesiac';
import { NAZWY_RODZAJOW_WPISU } from '@/lib/ksiegowosc/wpisy-reczne';
import { czyKsiegowoscWlaczona, statusObszaru } from '@/lib/ksiegowosc/wylacznik';
import { getKpirData, kpirTotals } from '@/lib/reports/kpir-data';

/**
 * Księgi z telefonu, M10d część 2 (plan aplikacji mobilnej): KPiR raportu jak
 * strona `reports/kpir` (te same funkcje: `trybDanych`, `getKpirData`,
 * `kpirTotals`, `buildKpirEntries`, `kpirDailySeries`, `costSlices`),
 * ewidencja ryczałtu albo KPiR modułu jak `reports/ewidencja` (wyłącznik
 * `ewidencja`, odczyt `czytajEwidencje` albo `czytajKpir`, braki i sumy okresu)
 * oraz pliki JPK_EWP i JPK_PKPIR tą samą funkcją co „Pobierz” na stronie
 * (`pobierzJpkEwp`, `pobierzJpkPkpir`). Klient z tokenem telefonu w jego firmie
 * (RLS). Dodawanie i usuwanie wpisów ręcznych oraz spisu zostaje na stronie.
 *
 * Raport KPiR jak na stronie nie łapie błędów odczytu (środowisko KSeF, proweniencja):
 * wyjątek to 500 z ponowieniem, nigdy księga z niepełnymi danymi.
 *
 * Ponowienie: odczyty nic nie zapisują; plik drugi raz daje ten sam plik i drugi
 * wpis audytu (`jpk_ewp.downloaded`, `jpk_pkpir.downloaded`).
 */

type Db = SupabaseClient;

const MIESIAC = /^20\d{2}-(0[1-9]|1[0-2])$/;
const ROLE_PLIKU = new Set(['owner', 'admin', 'accountant']);
const ROLE_ZAPISU = new Set(['owner', 'admin']);
const MAX_BODY_BYTES = 10_000;
const TYLKO_PLIK = 'Plik pobiera właściciel, administrator albo księgowa firmy.';
const POZA_KONTRAKTEM = 'Treść żądania nie pasuje do kontraktu. Zaktualizuj aplikację FaktWay.';
const PROFIL_TEKST = 'Ustawienia są w Księgowości, w zakładce „Ustawienia podatkowe”.';

/** Kwota w groszach jak na stronie („1 234,56 zł”). */
const zl = (gr: number) => `${formatPlMoney(gr / 100)} zł`;
const wOkresie = (dzien: string, od: string, doDnia: string) => dzien >= od && dzien <= doDnia;

function orgOf(caller: MobileCaller): NonNullable<MobileCaller['org']> {
  if (!caller.org) throw new Error('Trasa ksiąg bez firmy (org: required)');
  return caller.org;
}

/** Od bieżącego miesiąca wstecz, najwyżej `ile`, nie wcześniej niż `od`. */
function miesiaceDoWyboru(dzis: string, od: string, ile: number): string[] {
  const wynik: string[] = [];
  for (let m = dzis.slice(0, 7); m >= od && wynik.length < ile; m = shiftMonth(m, -1)) wynik.push(m);
  return wynik;
}

/** Miesiąc z adresu; domyślnie bieżący, jak `resolveKpirPeriod` strony. Zły kształt albo przyszłość: 400. */
function miesiacZAdresu(request: Request, dzis: string): { ok: true; miesiac: string } | { ok: false } {
  const m = new URL(request.url).searchParams.get('miesiac');
  if (m === null) return { ok: true, miesiac: dzis.slice(0, 7) };
  return MIESIAC.test(m) && m <= dzis.slice(0, 7) ? { ok: true, miesiac: m } : { ok: false };
}
const ZLY_MIESIAC = 'Wybierz miesiąc z listy (RRRR-MM, najpóźniej bieżący).';

// ─── KPiR raportu ───────────────────────────────────────────────────────────

/** `GET /api/mobile/v1/raport-kpir?miesiac=RRRR-MM`. */
export async function kpirReportForMobile(caller: MobileCaller, request: Request): Promise<NextResponse> {
  const headers = caller.headers;
  const org = orgOf(caller);
  const db = caller.db as Db;
  const dzis = todayInWarsaw();
  const okres = miesiacZAdresu(request, dzis);
  if (!okres.ok) return mobileError(400, 'invalid_request', ZLY_MIESIAC, headers);
  const { miesiac } = okres;
  const rok = Number(miesiac.slice(0, 4));
  const mies = Number(miesiac.slice(5, 7));
  const { from: periodStart, to: periodEnd } = monthRange(miesiac);

  const kontekst: KontekstStrony = { supabase: caller.db as unknown as KontekstStrony['supabase'], tenantId: org.tenantId, user: { id: caller.user.id } };
  const przyklad = (await trybDanych(kontekst, new Date())).tryb === 'przyklad';
  // Po danych raportu, nie równolegle (jak strona): błąd środowiska KSeF zatrzymuje, zanim cokolwiek innego czyta bazę.
  let expenses;
  let invoices;
  let currencyBlocked: string | null = null;
  let settledError: string | null = null;
  if (przyklad) {
    ({ expenses, invoices } = kpirPrzykladowe(mies, rok));
  } else {
    const data = await getKpirData(kontekst.supabase, org.tenantId, { month: String(mies), year: String(rok) });
    ({ expenses, invoices, currencyBlocked, settledError } = data);
  }
  const odeslanie = await odeslanieDoKsiegi(db, org.tenantId, miesiac);

  const odpowiedz: KpirRaportOdpowiedz = {
    miesiac,
    miesiace: miesiaceDoWyboru(dzis, '2020-01', 24),
    dzis,
    tryb: przyklad ? 'przyklad' : 'dane',
    odeslanie: odeslanie ? odeslanie.tekst : null,
    blokada: currencyBlocked,
    blokujace: currencyBlocked !== null ? blockingSaleInvoices(invoices).map((i) => i.number) : [],
    zaliczkiBlad: currencyBlocked === null ? settledError : null,
    sumy: null,
    kolumny: [],
    seria: [],
    doOpisania: null,
    vatBezOdliczenia: 0,
    wpisy: [],
  };
  if (currencyBlocked !== null) return mobileJson(odpowiedz, 200, headers);

  const sumy = kpirTotals(expenses, invoices);
  const nieliczone = uncountedCosts(expenses);
  const wpisy = buildKpirEntries(invoices, expenses, { periodStart, settledUnavailable: Boolean(settledError) });
  odpowiedz.sumy = { przychod: sumy.totalRevenue, koszty: sumy.totalExpenses, dochod: sumy.profit, marza: marginPct(sumy) };
  odpowiedz.kolumny = costSlices(sumy).map((s) => ({ kolumna: s.filterKey, nazwa: s.label, kwota: s.amount, udzial: s.share }));
  odpowiedz.seria = kpirDailySeries({ invoices, expenses, periodStart, periodEnd, today: dzis }).map((p) => ({ dzien: p.day, data: p.date, przychod: p.revenue, koszty: p.costs }));
  odpowiedz.doOpisania = nieliczone.count > 0 ? { liczba: nieliczone.count, kwota: nieliczone.amount } : null;
  odpowiedz.vatBezOdliczenia = nonDeductedVatSum(expenses);
  odpowiedz.wpisy = wpisy.map((e) => ({
    id: e.id,
    lp: e.lp,
    rodzaj: e.kind === 'revenue' ? 'przychod' : 'koszt',
    data: e.date,
    uwagaDaty: e.saleChip,
    dokument: e.documentNumber,
    kontrahent: e.counterparty,
    opis: e.description,
    kolumna: e.column,
    kolumnaNazwa: COLUMN_BADGE_TEXT[e.column],
    wSumie: e.inSum,
    kwota: e.amount,
    dopisek: e.amountRemark,
    dopisekOstrzezenie: e.amountRemarkTone === 'warning',
  }));
  return mobileJson(odpowiedz, 200, headers);
}

// ─── Ewidencja albo KPiR modułu ─────────────────────────────────────────────

/** Kolumna wiersza KPiR z kwotą (jak `kolumnaWiersza` strony). */
function nazwaKolumny(w: WierszKpir): string {
  const k = Object.entries(w.kwoty).find(([, gr]) => gr !== 0)?.[0] as keyof typeof NAZWY_KOLUMN | undefined;
  return k ? NAZWY_KOLUMN[k] : '';
}
const jestPrzychodem = (w: WierszKpir) => w.kwoty.k7 !== 0 || w.kwoty.k8 !== 0;

/** Faktury poza księgą jak „Poza ewidencją: …” strony; `null`, gdy nic nie pominięto. */
function zdaniePominietych(prefiks: string, p: ReadonlyArray<{ numer: string; powod: string }>): string | null {
  return p.length > 0 ? `${prefiks}: ${p.map((x) => x.numer).join(', ')}. ${p[0]!.powod}` : null;
}

function plik(p: Omit<PlikKsiegiTelefonu, 'mozna' | 'powod' | 'spis'> & { mozna?: boolean; spis?: string | null }, mozePobrac: boolean): PlikKsiegiTelefonu {
  const gotowy = p.mozna === true;
  return { ...p, mozna: gotowy && mozePobrac, powod: gotowy && !mozePobrac ? TYLKO_PLIK : null, spis: p.spis ?? null };
}

/** Karta pliku JPK_EWP jak `PlikJpk` strony. */
function plikEwp(ewidencja: Ewidencja, rok: number, miesiac: number, koniecMiesiaca: string, dzis: string, mozePobrac: boolean): PlikKsiegiTelefonu {
  const od = `${rok}-01-01`;
  const doDnia = koniecMiesiaca < dzis ? koniecMiesiaca : dzis;
  const okres = `od ${formatIsoDatePl(od)} do ${formatIsoDatePl(doDnia)}`;
  const baza = { plik: 'JPK_EWP' as const, rok, doMiesiaca: miesiac };
  if (od > dzis) return plik({ ...baza, opis: `Plik za ${rok} r. powstanie po rozpoczęciu roku.` }, mozePobrac);
  const braki = brakiOkresu(ewidencja, od, doDnia);
  const wiersze = ewidencja.wiersze.filter((w) => wOkresie(w.dataPrzychodu, od, doDnia));
  if (braki.length > 0) {
    const miesiace = [...new Set(braki.map((b) => b.dzien.slice(0, 7)))].map(monthLabel);
    return plik({ ...baza, opis: `Plik ${okres} powstanie, gdy ewidencja nie będzie mieć braków. Braki są w miesiącach: ${miesiace.join(', ')}.` }, mozePobrac);
  }
  if (wiersze.length === 0) return plik({ ...baza, opis: `Ewidencja ${okres} nie ma wpisów, więc plik byłby pusty.` }, mozePobrac);
  return plik(
    {
      ...baza,
      mozna: true,
      opis:
        `Plik ${okres}: wiersze ${wiersze.length}, przychód razem ${zl(sumyOkresu(wiersze).razemGr)}. ` +
        'Plik za cały zamknięty rok ma cel „złożenie po raz pierwszy”, za część roku „na żądanie urzędu”.',
    },
    mozePobrac,
  );
}

/** Zdanie o spisie z natury w pliku jak `opisSpisu` strony. */
function zdanieSpisu(spis: ReturnType<typeof spisyPliku>, rok: number, doDnia: string): string {
  const poczatek = `${zl(spis.poczatekGr)} (${spis.poczatekZ ? `spis z ${formatIsoDatePl(spis.poczatekZ)}` : 'bez spisu'})`;
  const koniec = doDnia === `${rok}-12-31` ? `${zl(spis.koniecGr)} (${spis.koniecZ ? `spis z ${formatIsoDatePl(spis.koniecZ)}` : 'bez spisu'})` : 'w pliku za cały rok';
  return `Spis z natury w pliku: na początek roku ${poczatek}, na koniec roku ${koniec}.`;
}

/** Karta pliku JPK_PKPIR jak `PlikJpkPkpir` strony. */
function plikPkpir(kpir: Kpir, spisy: Spis[], rok: number, miesiac: number, koniecMiesiaca: string, dzis: string, mozePobrac: boolean): PlikKsiegiTelefonu {
  const od = `${rok}-01-01`;
  const doDnia = koniecMiesiaca < dzis ? koniecMiesiaca : dzis;
  const okres = `od ${formatIsoDatePl(od)} do ${formatIsoDatePl(doDnia)}`;
  const baza = { plik: 'JPK_PKPIR' as const, rok, doMiesiaca: miesiac };
  if (od > dzis) return plik({ ...baza, opis: `Plik za ${rok} r. powstanie po rozpoczęciu roku.` }, mozePobrac);
  const braki = brakiKpirOkresu(kpir, od, doDnia);
  const wiersze = wierszeKpirOkresu(kpir, od, doDnia);
  if (braki.length > 0) {
    const miesiace = [...new Set(braki.map((b) => b.dzien.slice(0, 7)))].map(monthLabel);
    return plik({ ...baza, opis: `Plik ${okres} powstanie, gdy KPiR nie będzie mieć braków. Braki są w miesiącach: ${miesiace.join(', ')}.` }, mozePobrac);
  }
  if (wiersze.length === 0) return plik({ ...baza, opis: `KPiR ${okres} nie ma wpisów, więc plik byłby pusty.` }, mozePobrac);
  const sumy = sumyKpir(wiersze);
  return plik(
    {
      ...baza,
      mozna: true,
      opis:
        `Plik ${okres}: wiersze ${wiersze.length}, przychód ${zl(sumy.przychodGr)}, koszty ${zl(sumy.kosztyGr)}. ` +
        'Plik za cały zamknięty rok ma cel „złożenie po raz pierwszy”, za część roku „na żądanie urzędu”.',
      spis: sumy.kolumny.k10 !== 0 || spisy.length > 0 ? zdanieSpisu(spisyPliku(spisy, od, doDnia), rok, doDnia) : null,
    },
    mozePobrac,
  );
}

/** `GET /api/mobile/v1/ksiegowosc/ewidencja?miesiac=RRRR-MM`. */
export async function ledgerForMobile(caller: MobileCaller, request: Request): Promise<NextResponse> {
  const headers = caller.headers;
  const org = orgOf(caller);
  const db = caller.db as Db;
  const dzis = todayInWarsaw();
  const okres = miesiacZAdresu(request, dzis);
  if (!okres.ok) return mobileError(400, 'invalid_request', ZLY_MIESIAC, headers);
  const { miesiac } = okres;
  const rok = Number(miesiac.slice(0, 4));
  const mies = Number(miesiac.slice(5, 7));
  const { from: od, to: doDnia } = monthRange(miesiac);
  const tytul = monthLabel(miesiac);
  const canEdit = ROLE_ZAPISU.has(org.role);
  const mozePobrac = ROLE_PLIKU.has(org.role);

  let wlaczona: boolean;
  try {
    wlaczona = (await czyKsiegowoscWlaczona(db, org.tenantId, 'ewidencja')).wlaczony;
  } catch {
    // Jak strona: „nie wiem” to nie „tak”; telefon ponawia.
    throw new MobileUpstreamError('ksiegowosc.ewidencja.wylacznik');
  }
  const pusta: KsiegaTelefonuOdpowiedz = {
    wlaczona, miesiac, miesiace: miesiaceDoWyboru(dzis, PROFIL_OD_MIN.slice(0, 7), 12), dzis, rodzaj: null, komunikat: null, braki: [], pominiete: null,
    wiersze: [], sumy: null, podpisSum: null, uwaga: null, wpisyReczne: [], spisy: [], plik: null, mozeEdytowac: canEdit,
  };
  if (!wlaczona) return mobileJson(pusta, 200, headers);
  if (doDnia < PROFIL_OD_MIN) {
    return mobileJson({ ...pusta, komunikat: 'Ewidencja przychodów w FaktWay obejmuje przychody od 1 stycznia 2026 r.' }, 200, headers);
  }

  // Forma z ustawień na ten miesiąc: skala i liniowy prowadzą KPiR (K7), ryczałt ewidencję; bez odczytu ustawień formy nie znamy.
  const wersje = await czytajWersjeProfilu(db, org.tenantId).catch(() => null);
  const forma = wersje ? wersjaMiesiaca(wersje, miesiac)?.forma : undefined;

  if (forma === 'skala' || forma === 'liniowy') {
    // Globalny stop i flagę firmy sprawdził obszar `ewidencja`; `kpir` różni się tylko blokadą w kodzie (K7).
    if (!statusObszaru('kpir').wlaczony) {
      return mobileJson({ ...pusta, rodzaj: 'kpir', komunikat: 'KPiR w module księgowości jest chwilowo wyłączona. Faktury i koszty są dalej w raporcie w zakładce „KPiR”.' }, 200, headers);
    }
    const wynik = await czytajKpir(db, org.tenantId, rok, { wersje: wersje ?? undefined });
    if (!wynik.ok) return mobileJson({ ...pusta, rodzaj: 'kpir', komunikat: wynik.komunikat }, 200, headers);
    const { kpir } = wynik;
    const wiersze = wierszeKpirOkresu(kpir, od, doDnia);
    const braki = brakiKpirOkresu(kpir, od, doDnia);
    const sumy = braki.length === 0 ? sumyKpir(wiersze) : null;
    // K_1 numeruje się od początku roku; tabela miesiąca pokazuje numer z księgi.
    const lpRoku = new Map(kpir.wiersze.map((w) => [`${w.zrodlo.typ}-${w.zrodlo.id}`, w.lp]));
    const odpowiedz: KsiegaTelefonuOdpowiedz = {
      ...pusta,
      rodzaj: 'kpir',
      braki: braki.map((b) => b.komunikat),
      pominiete: zdaniePominietych('Poza księgą', kpir.pominiete.filter((p) => wOkresie(p.dzien, od, doDnia))),
      wiersze: wiersze.map(
        (w): WierszKsiegiTelefonu => ({
          lp: lpRoku.get(`${w.zrodlo.typ}-${w.zrodlo.id}`) ?? w.lp,
          data: w.data,
          dowod: w.dowod,
          numerKsef: w.numerKsef,
          kontrahent: w.nazwaKontrahenta,
          identyfikator: w.idKontrahenta ? `${w.krajKontrahenta ?? ''} ${w.idKontrahenta}`.trim() : null,
          dataWpisu: null,
          opis: w.opis,
          kwotaGr: Object.values(w.kwoty).reduce((s, gr) => s + gr, 0),
          przychod: jestPrzychodem(w),
          kolumna: nazwaKolumny(w),
          uwagi: [w.uwagi, w.br ? `B+R: ${zl(w.br.kwotaGr)}` : null].filter(Boolean).join('; ') || null,
        }),
      ),
      sumy: sumy
        ? [
            { podpis: 'Przychód w miesiącu', kwotaGr: sumy.przychodGr },
            { podpis: 'Koszty w miesiącu', kwotaGr: sumy.kosztyGr },
            { podpis: 'Dochód w miesiącu (przychód minus koszty)', kwotaGr: sumy.przychodGr - sumy.kosztyGr },
          ]
        : null,
      podpisSum: sumy && wiersze.length > 0 ? `Według Twoich danych za ${tytul}; spis z natury nie wchodzi do sum.` : null,
      wpisyReczne: wynik.wpisy
        .filter((w) => wOkresie(w.data, od, doDnia))
        .map((w): WpisRecznyTelefonu => ({
          id: w.id,
          tytul: w.dokument,
          szczegoly: `${NAZWY_RODZAJOW_WPISU[w.rodzaj]}, ${NAZWY_KOLUMN[w.kolumna]}, ${formatIsoDatePl(w.data)}: ${zl(w.kwotaGr)}${w.opis ? `. ${w.opis}` : ''}`,
        })),
      spisy: wynik.spisy.map((s): WpisRecznyTelefonu => ({ id: s.id, tytul: `Spis z natury z ${formatIsoDatePl(s.data)}`, szczegoly: `${zl(s.kwotaGr)}${s.opis ? `. ${s.opis}` : ''}` })),
      plik: plikPkpir(kpir, wynik.spisy, rok, mies, doDnia, dzis, mozePobrac),
    };
    return mobileJson(odpowiedz, 200, headers);
  }

  const wynik = wersje === null ? { ok: false as const, komunikat: KOMUNIKAT_ODCZYT } : await czytajEwidencje(db, org.tenantId, rok, { wersje });
  if (!wynik.ok) return mobileJson({ ...pusta, rodzaj: 'ewidencja', komunikat: wynik.komunikat }, 200, headers);
  const { ewidencja } = wynik;
  const wiersze = ewidencja.wiersze.filter((w) => wOkresie(w.dataPrzychodu, od, doDnia));
  const braki = brakiOkresu(ewidencja, od, doDnia);
  const sumy = braki.length === 0 ? sumyOkresu(wiersze) : null;
  const odpowiedz: KsiegaTelefonuOdpowiedz = {
    ...pusta,
    rodzaj: 'ewidencja',
    uwaga: !ewidencja.ryczaltWRoku
      ? `W ${ewidencja.rok} r. ustawienia podatkowe nie mają ryczałtu, więc ewidencja przychodów jest pusta. Przy skali i podatku liniowym przychody są w KPiR. ${PROFIL_TEKST}`
      : null,
    braki: braki.map((b) => b.komunikat),
    pominiete: zdaniePominietych('Poza ewidencją', ewidencja.pominiete.filter((p) => wOkresie(p.dzien, od, doDnia))),
    wiersze: wiersze.map(
      (w): WierszKsiegiTelefonu => ({
        lp: w.lp,
        data: w.dataPrzychodu,
        dowod: w.dowod,
        numerKsef: w.numerKsef,
        kontrahent: w.idKontrahenta ? `${w.krajKontrahenta ?? ''} ${w.idKontrahenta}`.trim() : '',
        identyfikator: null,
        dataWpisu: w.dataWpisu,
        opis: null,
        kwotaGr: w.kwotaGr,
        przychod: true,
        kolumna: etykietaStawki(w.stawkaPb),
        uwagi: w.uwagi,
      }),
    ),
    sumy: sumy
      ? [...[...sumy.stawki].map(([pb, gr]) => ({ podpis: `Przychód ze stawką ${etykietaStawki(pb)}`, kwotaGr: gr })), { podpis: 'Razem', kwotaGr: sumy.razemGr }]
      : null,
    podpisSum: sumy && wiersze.length > 0 ? `Według Twoich danych i stawek ryczałtu na ${ewidencja.rok} r.` : null,
    wpisyReczne: wynik.wpisy
      .filter((w) => wOkresie(w.dataPrzychodu, od, doDnia))
      .map((w): WpisRecznyTelefonu => ({
        id: w.id,
        tytul: w.dokument,
        szczegoly: `${NAZWY_RODZAJOW_WPISU[w.rodzaj]}, wpis z ${formatIsoDatePl(w.dataWpisu)}, przychód z ${formatIsoDatePl(w.dataPrzychodu)}: ${zl(w.kwotaGr)}, stawka ${etykietaStawki(w.stawkaPb)}${w.opis ? `. ${w.opis}` : ''}`,
      })),
    plik: plikEwp(ewidencja, rok, mies, doDnia, dzis, mozePobrac),
  };
  return mobileJson(odpowiedz, 200, headers);
}

// ─── Plik JPK_EWP / JPK_PKPIR ───────────────────────────────────────────────

/** Kształt treści (typy pól); zasady pól sprawdza schemat strony w `pobierzJpkEwp` i `pobierzJpkPkpir`. */
const plikTelefonuSchema = z
  .object({ plik: z.enum(['JPK_EWP', 'JPK_PKPIR']), rok: z.number(), doMiesiaca: z.number(), imie: z.string(), nazwisko: z.string(), dataUrodzenia: z.string() })
  .strict();

/** `POST /api/mobile/v1/ksiegowosc/ewidencja/plik`. */
export async function ledgerFileFromMobile(caller: MobileCaller, request: Request): Promise<NextResponse> {
  const headers = caller.headers;
  const org = orgOf(caller);
  if (!ROLE_PLIKU.has(org.role)) return mobileError(403, 'forbidden', TYLKO_PLIK, headers);
  const raw = await readJsonBody(request, headers, { maxBytes: MAX_BODY_BYTES, tooLarge: 'Treść jest za długa.' });
  if (!raw.ok) return raw.response;
  const parsed = plikTelefonuSchema.safeParse(raw.value);
  if (!parsed.success) return mobileError(400, 'invalid_request', POZA_KONTRAKTEM, headers);
  const { plik: rodzaj, ...wejscie } = parsed.data;
  const ctx = { client: caller.db as Db, tenantId: org.tenantId, userId: caller.user.id };
  const wynik = rodzaj === 'JPK_EWP' ? await pobierzJpkEwp(ctx, wejscie) : await pobierzJpkPkpir(ctx, wejscie);
  if (!wynik.success) return mobileError(422, 'settlement_refused', wynik.error, headers, wynik.pole);
  const odpowiedz: PlikKsiegiOdpowiedz = { nazwa: wynik.nazwa, xml: wynik.xml };
  return mobileJson(odpowiedz, 200, headers);
}
