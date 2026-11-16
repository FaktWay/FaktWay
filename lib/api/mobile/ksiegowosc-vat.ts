import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { NextResponse } from 'next/server';
import { z } from 'zod';

import type { MobileCaller } from '@/lib/api/mobile/auth';
import type {
  FormularzZaplatyRecznej,
  PlikVatOdpowiedz,
  PoleNadwyzkiTelefonu,
  VatTelefonuOdpowiedz,
  ZaplataRecznaOdpowiedz,
  ZaplataRecznaTelefonu,
} from '@/lib/api/mobile/kontrakt-ksiegowosc';
import { MobileUpstreamError, mobileError, mobileJson } from '@/lib/api/mobile/responses';
import { readJsonBody } from '@/lib/api/mobile/tresc';
import { monthLabel, monthRange, shiftMonth } from '@/lib/expenses/month';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { formatPlMoney } from '@/lib/format/pl';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { countLabel } from '@/lib/i18n/plural';
import { terminDla } from '@/lib/ksiegowosc/kalendarz';
import { miesiacZParametrow } from '@/lib/ksiegowosc/miesiac-strony';
import { mikrorachunekZNip } from '@/lib/ksiegowosc/mikrorachunek';
import { daneDoPrzelewu } from '@/lib/ksiegowosc/przelew';
import { NAZWY_ROZLICZEN } from '@/lib/ksiegowosc/ten-miesiac';
import type { Rozliczenie } from '@/lib/ksiegowosc/ten-miesiac-dane';
import { dodajZaplateReczna } from '@/lib/ksiegowosc/ten-miesiac-zapis';
import { brakNadwyzki, czytajVat, nadwyzkaZAdresu, type ZrodloNadwyzki } from '@/lib/ksiegowosc/vat-dane';
import { pobierzJpkV7m } from '@/lib/ksiegowosc/vat-plik';
import { czyKsiegowoscWlaczona } from '@/lib/ksiegowosc/wylacznik';
import { srodowiskoMf } from '@/lib/ksiegowosc/wysylka-jpk/certyfikaty';
import { NAZWY_STANOW_WYSYLKI, opisOdmowyWysylki } from '@/lib/ksiegowosc/wysylka-jpk/statusy';
import { ostatniMiesiacZaplatyRecznej, ZAPLATA_RECZNA_OD } from '@/lib/ksiegowosc/zaplata-reczna';

/**
 * Księgowość z telefonu, M10d (plan aplikacji mobilnej): ekran VAT jak strona
 * `reports/vat` (ten sam wyłącznik `vat`, odczyt `czytajVat`, termin, dane do
 * przelewu, nadwyżka, lista wysyłek), plik JPK_V7M tą samą funkcją co „Pobierz”
 * strony (`pobierzJpkV7m`) i zapłata spoza wyliczenia tą samą funkcją co akcja
 * strony (`dodajZaplateReczna`). Nadwyżka i zapłaty przy „Ten miesiąc” dokłada
 * `lib/api/mobile/ksiegowosc.ts` z pomocników niżej. Klient z tokenem telefonu
 * w jego firmie (RLS); role jak `requireOrgRole` akcji strony.
 *
 * Wysyłka do MF, status i UPO zostają na stronie (wysyłka za obszarem
 * `wysylka_jpk`, zablokowanym do opinii prawnika); telefon pokazuje listę.
 *
 * Ponowienie: odczyt nic nie zapisuje. Plik: drugi raz ten sam plik i drugi
 * wpis audytu. Zapłata spoza wyliczenia: bez klucza, jak na stronie; druga
 * wersja nie dubluje odliczenia (`przyrostyZaplat` liczy przyrost ponad
 * najwyższą zapłaconą wersję okresu).
 */

type Db = SupabaseClient;

const MIESIAC = /^20\d{2}-(0[1-9]|1[0-2])$/;
/** Moduł księgowości liczy od 2026 r. (parametry roku), jak „Ten miesiąc”. */
const PIERWSZY_MIESIAC = '2026-01';
const MAX_BODY_BYTES = 10_000;
const ROLE_PLIKU = new Set(['owner', 'admin', 'accountant']);
const ROLE_ZAPISU = new Set(['owner', 'admin']);
const TYLKO_PLIK = 'Plik JPK_V7M pobiera właściciel, administrator albo księgowa firmy.';
const TYLKO_ZAPLATY = 'Zapłaty zapisuje właściciel albo administrator firmy.';
const POZA_KONTRAKTEM = 'Treść żądania nie pasuje do kontraktu. Zaktualizuj aplikację FaktWay.';
const PRZED_V7M3 = 'JPK_V7M(3) obowiązuje od rozliczenia za luty 2026 r.';

/** Kwota w groszach jak na stronie („1 234,56 zł”). */
const zl = (gr: number) => `${formatPlMoney(gr / 100)} zł`;

function orgOf(caller: MobileCaller): NonNullable<MobileCaller['org']> {
  if (!caller.org) throw new Error('Trasa księgowości bez firmy (org: required)');
  return caller.org;
}

/** Od bieżącego miesiąca wstecz do stycznia 2026, najwyżej 12 (jak „Ten miesiąc”). */
export function miesiaceDoWyboru(dzis: string): string[] {
  const wynik: string[] = [];
  for (let m = dzis.slice(0, 7); m >= PIERWSZY_MIESIAC && wynik.length < 12; m = shiftMonth(m, -1)) wynik.push(m);
  return wynik;
}

/**
 * Miesiąc i nadwyżka z adresu, jak `miesiacZParametrow` i `nadwyzkaZAdresu` strony;
 * wartość w złym kształcie to 400 (strona ją pomija, telefon wysłał coś spoza kontraktu).
 */
export function okresZAdresu(request: Request, dzis: string): { ok: true; miesiac: string; nadwyzka: number | null } | { ok: false; komunikat: string } {
  const sp = new URL(request.url).searchParams;
  const miesiac = sp.get('miesiac');
  // Jak `miesiacZParametrow` strony: rok od 2026 (parametry modułu), najpóźniej bieżący miesiąc.
  if (miesiac !== null && (!MIESIAC.test(miesiac) || miesiac > dzis.slice(0, 7) || miesiac < PIERWSZY_MIESIAC)) {
    return { ok: false, komunikat: 'Wybierz miesiąc z listy (RRRR-MM, najpóźniej bieżący).' };
  }
  const surowa = sp.get('nadwyzka');
  const nadwyzka = surowa === null ? null : nadwyzkaZAdresu(surowa);
  if (surowa !== null && nadwyzka === null) return { ok: false, komunikat: 'Nadwyżkę wpisuje się w pełnych złotych, bez znaku (także 0).' };
  return { ok: true, miesiac: miesiac ?? miesiacZParametrow({}, dzis), nadwyzka };
}

/**
 * Nadwyżka z poprzedniej deklaracji (P_39) z tymi samymi zdaniami co strona: ekran
 * VAT (`Nadwyzka` w `reports/vat/page.tsx`) albo pozycja VAT „Ten miesiąc”
 * (`NadwyzkaVat` w `reports/ten-miesiac/page.tsx`). Kwota zawsze z serwera.
 */
export function poleNadwyzki(
  nadwyzka: { zl: number; zrodlo: ZrodloNadwyzki } | null,
  miesiac: string,
  ekran: 'vat' | 'ten_miesiac',
): PoleNadwyzkiTelefonu {
  const poprzedni = monthLabel(shiftMonth(miesiac, -1));
  const wpisana = nadwyzka?.zrodlo === 'klient' ? nadwyzka.zl : null;
  const kwota = nadwyzka ? `Nadwyżka z deklaracji za ${poprzedni} (P_39): ${zl(nadwyzka.zl * 100)}` : '';
  const inna = ekran === 'vat' ? ' Inna kwota z deklaracji złożonej poza FaktWay wpisuje się niżej.' : '';
  let opis: string | null = null;
  if (nadwyzka?.zrodlo === 'mf') opis = `${kwota}, z deklaracji przyjętej przez MF.`;
  else if (nadwyzka?.zrodlo === 'zatwierdzone') opis = `${kwota}, z rozliczenia VAT za ${poprzedni} zatwierdzonego w „Ten miesiąc”.${inna}`;
  else if (nadwyzka?.zrodlo === 'ten_miesiac') {
    opis = `${kwota}, z zatwierdzonego rozliczenia VAT za ${monthLabel(miesiac)}${ekran === 'vat' ? ' w „Ten miesiąc”' : ''}.${inna}`;
  } else if (!nadwyzka && ekran === 'vat') opis = brakNadwyzki(miesiac);
  return { nadwyzka, opis, pole: nadwyzka?.zrodlo !== 'mf', poprzedni, wpisana };
}

/** Zapłata spoza wyliczenia jak wiersz listy strony (`ZaplatySpozaWyliczenia`). */
export function zaplataRecznaTelefonu(r: Rozliczenie): ZaplataRecznaTelefonu {
  const bezFp = r.rodzaj === 'zus_spoleczne' ? `, w tym bez Funduszu Pracy i FS ${zl(r.spoleczneBezFpGr)}` : '';
  const tytul = `${NAZWY_ROZLICZEN[r.rodzaj]} za ${monthLabel(r.miesiac)}`;
  const szczegoly = `${zl(r.kwotaGr)}${bezFp}. ${r.zaplaconeO ? `Zapłacone ${formatIsoDatePl(r.zaplaconeO)}.` : 'Bez daty zapłaty.'}`;
  return {
    id: r.id,
    rodzaj: r.rodzaj as ZaplataRecznaTelefonu['rodzaj'],
    tytul,
    szczegoly,
    opis: `${tytul}: ${szczegoly}`,
    zaplacone: r.status === 'zaplacone',
    najwczesniej: `${r.miesiac}-01`,
  };
}

/** Granice i wartości domyślne formularza, jak `ZaplataReczna` na stronie. */
export function formularzZaplatyRecznej(miesiac: string, dzis: string): FormularzZaplatyRecznej {
  const koniec = monthRange(miesiac).to;
  return { od: ZAPLATA_RECZNA_OD, doMiesiaca: ostatniMiesiacZaplatyRecznej(dzis), domyslnyMiesiac: shiftMonth(miesiac, -1), domyslnaData: koniec < dzis ? koniec : dzis };
}

/** `GET /api/mobile/v1/ksiegowosc/vat?miesiac=RRRR-MM&nadwyzka=N`. */
export async function vatForMobile(caller: MobileCaller, request: Request): Promise<NextResponse> {
  const headers = caller.headers;
  const org = orgOf(caller);
  const db = caller.db as Db;
  const dzis = todayInWarsaw();
  const okres = okresZAdresu(request, dzis);
  if (!okres.ok) return mobileError(400, 'invalid_request', okres.komunikat, headers);
  const { miesiac } = okres;
  const zakonczony = monthRange(miesiac).to < dzis;
  const termin = terminDla({ rodzaj: 'vatJpk', rok: Number(miesiac.slice(0, 4)), miesiac: Number(miesiac.slice(5, 7)) });
  const mozePobrac = ROLE_PLIKU.has(org.role);

  let wlaczona: boolean;
  try {
    wlaczona = (await czyKsiegowoscWlaczona(db, org.tenantId, 'vat')).wlaczony;
  } catch {
    // Jak strona: „nie wiem” to nie „tak”; telefon ponawia.
    throw new MobileUpstreamError('ksiegowosc.vat.wylacznik');
  }
  const pusta: VatTelefonuOdpowiedz = {
    wlaczona, miesiac, miesiace: miesiaceDoWyboru(dzis), dzis, komunikat: null, zwolniona: false, nadwyzka: null, kwoty: null, podpis: null,
    termin: termin ? { faktyczny: termin.faktyczny, nominalny: termin.nominalny, przesuniety: termin.przesuniety } : null,
    przelew: '', zakonczony, plik: { mozna: false, powod: null, email: caller.user.email }, wysylkaWlaczona: false, wysylki: [],
  };
  if (!wlaczona) return mobileJson(pusta, 200, headers);

  const srodowisko = srodowiskoMf();
  const [dane, firma, wysylka] = await Promise.all([
    czytajVat(db, org.tenantId, miesiac, okres.nadwyzka),
    db.from('tenants').select('nip').eq('id', org.tenantId).maybeSingle(),
    srodowisko ? czyKsiegowoscWlaczona(db, org.tenantId, 'wysylka_jpk').catch(() => ({ wlaczony: false })) : { wlaczony: false },
  ]);
  // `null`: NIP-u nie udało się odczytać (inne zdanie niż „brak NIP w ustawieniach”), jak na stronie.
  const nip = firma.error ? null : String((firma.data as { nip?: unknown } | null)?.nip ?? '').replace(/\D/g, '');
  const przelew = daneDoPrzelewu('vat', miesiac, nip, nip ? mikrorachunekZNip(nip) : null, null, 'ryczalt');
  const wspolne = { ...pusta, przelew, wysylkaWlaczona: wysylka.wlaczony && srodowisko !== null };

  // Jak strona: termin i przelew tylko przy odczytanym VAT (firma zwolniona nie składa JPK_V7M, więc nie dostaje jego terminu).
  if (!dane.ok) {
    return mobileJson({ ...wspolne, termin: null, przelew: '', komunikat: dane.komunikat, zwolniona: dane.zwolniona === true } satisfies VatTelefonuOdpowiedz, 200, headers);
  }

  const wynik = dane.wynik;
  const policzony = wynik?.ok ? wynik : null;
  // Ta sama granica co `plikJpkV7m`: klient wie od razu, zanim wpisze dane osoby.
  const przedV7m3 = miesiac < '2026-02';
  const odpowiedz: VatTelefonuOdpowiedz = {
    ...wspolne,
    komunikat: wynik && !wynik.ok ? wynik.brak : null,
    nadwyzka: poleNadwyzki(dane.nadwyzka, miesiac, 'vat'),
    kwoty: policzony
      ? {
          naleznyGr: policzony.naleznyGr,
          naliczonyGr: policzony.naliczonyGr,
          nadwyzkaPoprzedniaGr: policzony.nadwyzkaPoprzedniaGr,
          doZaplatyGr: policzony.doZaplatyGr,
          nadwyzkaNaNastepnyGr: policzony.nadwyzkaNaNastepnyGr,
        }
      : null,
    podpis: policzony
      ? `Według Twoich danych za ${monthLabel(miesiac)}: ${countLabel(policzony.liczbaSprzedazy, ['faktura', 'faktury', 'faktur'])} sprzedaży i ` +
        `${countLabel(policzony.liczbaZakupow, ['koszt', 'koszty', 'kosztów'])} z VAT do odliczenia. ` +
        `Podatek naliczony obejmuje nadwyżkę z poprzedniej deklaracji (${zl(policzony.nadwyzkaPoprzedniaGr)}). Kwoty deklaracji są w pełnych złotych.`
      : null,
    plik: {
      mozna: mozePobrac && zakonczony && policzony !== null && !przedV7m3,
      powod: !policzony ? null : przedV7m3 ? PRZED_V7M3 : !mozePobrac ? TYLKO_PLIK : !zakonczony ? `Plik za ${monthLabel(miesiac)} powstaje po zakończeniu miesiąca.` : null,
      email: caller.user.email,
    },
    wysylki: dane.wysylki.map((w) => ({
      id: w.id,
      utworzonoO: w.utworzonoO,
      stan: NAZWY_STANOW_WYSYLKI[w.stan],
      przyjeta: w.stan === 'przyjeta',
      testowe: w.srodowisko === 'test',
      numer: w.numerReferencyjny,
      doWplatyGr: w.deklaracja.P_51 * 100,
      odmowa: w.stan === 'odrzucona' ? opisOdmowyWysylki(w) : null,
    })),
  };
  return mobileJson(odpowiedz, 200, headers);
}

/** Kształt treści (typy pól); zasady pól sprawdza schemat strony w `pobierzJpkV7m`. */
const plikTelefonuSchema = z
  .object({ miesiac: z.string(), nadwyzka: z.number().nullable(), imie: z.string(), nazwisko: z.string(), dataUrodzenia: z.string(), email: z.string() })
  .strict();

/** `POST /api/mobile/v1/ksiegowosc/vat/plik`. */
export async function vatFileFromMobile(caller: MobileCaller, request: Request): Promise<NextResponse> {
  const headers = caller.headers;
  const org = orgOf(caller);
  if (!ROLE_PLIKU.has(org.role)) return mobileError(403, 'forbidden', TYLKO_PLIK, headers);
  const raw = await readJsonBody(request, headers, { maxBytes: MAX_BODY_BYTES, tooLarge: 'Treść jest za długa.' });
  if (!raw.ok) return raw.response;
  const parsed = plikTelefonuSchema.safeParse(raw.value);
  if (!parsed.success) return mobileError(400, 'invalid_request', POZA_KONTRAKTEM, headers);
  const wynik = await pobierzJpkV7m({ client: caller.db as Db, tenantId: org.tenantId, userId: caller.user.id }, parsed.data);
  if (!wynik.success) return mobileError(422, 'settlement_refused', wynik.error, headers, wynik.pole);
  const odpowiedz: PlikVatOdpowiedz = { nazwa: wynik.nazwa, xml: wynik.xml };
  return mobileJson(odpowiedz, 200, headers);
}

const zaplataTelefonuSchema = z
  .object({ zaMiesiac: z.string(), rodzaj: z.string(), kwota: z.string(), bezFp: z.string(), dataZaplaty: z.string() })
  .strict();

/** `POST /api/mobile/v1/ksiegowosc/zaplaty-reczne`. */
export async function manualPaymentFromMobile(caller: MobileCaller, request: Request): Promise<NextResponse> {
  const headers = caller.headers;
  const org = orgOf(caller);
  if (!ROLE_ZAPISU.has(org.role)) return mobileError(403, 'forbidden', TYLKO_ZAPLATY, headers);
  const raw = await readJsonBody(request, headers, { maxBytes: MAX_BODY_BYTES, tooLarge: 'Treść jest za długa.' });
  if (!raw.ok) return raw.response;
  const parsed = zaplataTelefonuSchema.safeParse(raw.value);
  if (!parsed.success) return mobileError(400, 'invalid_request', POZA_KONTRAKTEM, headers);
  // Rodzaj, kwoty i daty sprawdza schemat strony (`zaplataRecznaSchema`) w funkcji zapisu.
  const wynik = await dodajZaplateReczna(
    { client: caller.db as Db, tenantId: org.tenantId, userId: caller.user.id },
    parsed.data as Parameters<typeof dodajZaplateReczna>[1],
  );
  if (!wynik.success) return mobileError(422, 'settlement_refused', wynik.error, headers, wynik.pole);
  const odpowiedz: ZaplataRecznaOdpowiedz = { zapisano: true };
  return mobileJson(odpowiedz, 201, headers);
}
