import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { NextResponse } from 'next/server';
import { z } from 'zod';

import type { MobileCaller } from '@/lib/api/mobile/auth';
import type { TenMiesiacDodatki } from '@/lib/api/mobile/kontrakt-ksiegowosc';
import { formularzZaplatyRecznej, miesiaceDoWyboru, okresZAdresu, poleNadwyzki, zaplataRecznaTelefonu } from '@/lib/api/mobile/ksiegowosc-vat';
import type {
  PozycjaRozliczeniaTelefonu,
  TenMiesiacOdpowiedz,
  ZaplataRozliczeniaOdpowiedz,
  ZatwierdzenieMiesiacaOdpowiedz,
} from '@/lib/api/mobile/kontrakt';
import { MobileUpstreamError, mobileError, mobileJson } from '@/lib/api/mobile/responses';
import { readJsonBody } from '@/lib/api/mobile/tresc';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { mikrorachunekZNip } from '@/lib/ksiegowosc/mikrorachunek';
import { rokSkladkowyZdrowotnej } from '@/lib/ksiegowosc/parametry';
import { daneDoPrzelewu, podpisKwot } from '@/lib/ksiegowosc/przelew';
import { NAZWY_ROZLICZEN } from '@/lib/ksiegowosc/ten-miesiac';
import { aktualne, czytajTenMiesiac, doZatwierdzenia, miesiacZakonczony, zaplacono } from '@/lib/ksiegowosc/ten-miesiac-dane';
import { oznaczZaplacone, zatwierdzenieSchema, zatwierdzMiesiac } from '@/lib/ksiegowosc/ten-miesiac-zapis';
import { czyKsiegowoscWlaczona } from '@/lib/ksiegowosc/wylacznik';
import { isUuid } from '@/lib/supabase/active-org';

/**
 * Księgowość z telefonu (plan aplikacji mobilnej, M10b): „Ten miesiąc” jak
 * strona `reports/ten-miesiac` (ten sam wyłącznik, wyliczenie, dane do przelewu,
 * stan wersji i zapłat) oraz zatwierdzenie miesiąca i zapłata rozliczenia tymi
 * samymi funkcjami co akcje strony (`lib/ksiegowosc/ten-miesiac-zapis.ts`).
 * Klient z tokenem telefonu w jego firmie (RLS). Zapisy tylko właściciel albo
 * administrator, jak `requireOrgRole(['owner', 'admin'])` na stronie.
 *
 * Ponowienie: zatwierdzenie tych samych skrótów po zapisie daje `nowe: 0`,
 * wyścig łapie UNIQUE wersji (23505, zdanie strony); zapłata ustawia ten sam stan.
 * Od M10d nadwyżka VAT (`?nadwyzka=` jak na stronie, ta sama kwota idzie do
 * zatwierdzenia) i zapłaty spoza wyliczenia (lista i formularz; zapis w
 * `ksiegowosc-vat.ts`). KPiR, ewidencja i eksport zostają na stronie.
 */

const ROLE_ZAPISU = new Set(['owner', 'admin']);
const TYLKO_WLASCICIEL = 'Miesiąc zatwierdza i zapłaty oznacza właściciel albo administrator firmy.';
const MAX_BODY_BYTES = 10_000;

type Db = SupabaseClient;

function orgOf(caller: MobileCaller): NonNullable<MobileCaller['org']> {
  if (!caller.org) throw new Error('Trasa księgowości bez firmy (org: required)');
  return caller.org;
}

/** `GET /api/mobile/v1/ksiegowosc?miesiac=RRRR-MM&nadwyzka=N`. */
export async function monthForMobile(caller: MobileCaller, request: Request): Promise<NextResponse> {
  const headers = caller.headers;
  const org = orgOf(caller);
  const db = caller.db as Db;
  const dzis = todayInWarsaw();
  // M10d: nadwyżka VAT wpisana przy pozycji VAT, jak `?nadwyzka=` strony.
  const okres = okresZAdresu(request, dzis);
  if (!okres.ok) return mobileError(400, 'invalid_request', okres.komunikat, headers);
  const { miesiac } = okres;
  const mozeEdytowac = ROLE_ZAPISU.has(org.role);

  let wlaczona: boolean;
  try {
    wlaczona = (await czyKsiegowoscWlaczona(db, org.tenantId, 'ten_miesiac')).wlaczony;
  } catch {
    // Jak strona: „nie wiem” to nie „tak”; telefon ponawia.
    throw new MobileUpstreamError('ksiegowosc.wylacznik');
  }
  const pusta: TenMiesiacOdpowiedz & TenMiesiacDodatki = {
    wlaczona, miesiac, miesiace: miesiaceDoWyboru(dzis), dzis, podpis: '', forma: null, braki: null, przychodGr: null, kosztyGr: null,
    pozycje: [], mozeEdytowac, miesiacZakonczony: miesiacZakonczony(miesiac, dzis), doZatwierdzenia: 0, skroty: {}, historia: [],
    nadwyzkaVat: null, zaplatyReczne: [], zaplataReczna: null,
  };
  if (!wlaczona) return mobileJson(pusta, 200, headers);

  const [dane, firma] = await Promise.all([
    czytajTenMiesiac(db, org.tenantId, miesiac, { nadwyzkaVat: okres.nadwyzka }),
    db.from('tenants').select('nip').eq('id', org.tenantId).maybeSingle(),
  ]);
  // `null`: NIP-u nie udało się odczytać (inne zdanie niż „brak NIP w ustawieniach”), jak na stronie.
  const nip = firma.error ? null : String((firma.data as { nip?: unknown } | null)?.nip ?? '').replace(/\D/g, '');
  const mikro = nip ? mikrorachunekZNip(nip) : null;
  const historia = [...dane.rozliczenia]
    .sort((a, b) => (a.zatwierdzoneO < b.zatwierdzoneO ? 1 : a.zatwierdzoneO > b.zatwierdzoneO ? -1 : b.wersja - a.wersja))
    .map((r) => ({ rodzaj: r.rodzaj, nazwa: NAZWY_ROZLICZEN[r.rodzaj], wersja: r.wersja, kwotaGr: r.kwotaGr, zatwierdzoneO: r.zatwierdzoneO, zaplaconeO: r.zaplaconeO }));
  const podpis = podpisKwot(Number(miesiac.slice(0, 4)), rokSkladkowyZdrowotnej(miesiac));

  // Zapłaty spoza wyliczenia jak na stronie: także przy miesiącu z brakami; formularz dla właściciela i administratora.
  const zaplaty = { zaplatyReczne: dane.zaplatyReczne.map(zaplataRecznaTelefonu), zaplataReczna: mozeEdytowac ? formularzZaplatyRecznej(miesiac, dzis) : null };
  if (!dane.ok) {
    return mobileJson({ ...pusta, ...zaplaty, podpis, braki: dane.braki, historia } satisfies TenMiesiacOdpowiedz & TenMiesiacDodatki, 200, headers);
  }

  const ostatnie = aktualne(dane.rozliczenia);
  const { profil } = dane.wynik;
  const pozycje: PozycjaRozliczeniaTelefonu[] = dane.pozycje.map((p) => {
    const ostatnia = ostatnie.get(p.rodzaj);
    return {
      rodzaj: p.rodzaj,
      nazwa: NAZWY_ROZLICZEN[p.rodzaj],
      kwotaGr: p.ok ? p.kwotaGr : null,
      brak: p.ok ? null : p.brak,
      termin: p.termin ? { faktyczny: p.termin.faktyczny, nominalny: p.termin.nominalny, przesuniety: p.termin.przesuniety } : null,
      przelew: daneDoPrzelewu(p.rodzaj, miesiac, nip, mikro, profil.nrsZus, profil.forma),
      rozliczenie: ostatnia ? { id: ostatnia.id, wersja: ostatnia.wersja, kwotaGr: ostatnia.kwotaGr, status: ostatnia.status, zaplaconeO: ostatnia.zaplaconeO } : null,
      zaplaconoGr: zaplacono(dane.rozliczenia, p.rodzaj),
      zmiana: Boolean(p.ok && ostatnia && ostatnia.wejsciaHash !== p.wejsciaHash),
    };
  });
  const vat = dane.wynik.vat;
  const odpowiedz: TenMiesiacOdpowiedz & TenMiesiacDodatki = {
    ...pusta,
    ...zaplaty,
    // Pole przy pozycji VAT jak `NadwyzkaVat` strony: bez nadwyżki z innego powodu niż nieznana kwota pole nic nie zmieni.
    nadwyzkaVat: vat && (vat.nadwyzka || vat.nadwyzkaNieznana) ? poleNadwyzki(vat.nadwyzka, miesiac, 'ten_miesiac') : null,
    podpis,
    forma: profil.forma,
    przychodGr: dane.wynik.przychodGr,
    kosztyGr: dane.wynik.kosztyGr,
    pozycje,
    doZatwierdzenia: doZatwierdzenia(dane).length,
    // Zatwierdzenie zapisze tylko to, co klient widział: skróty pozycji z tego widoku.
    skroty: Object.fromEntries(dane.pozycje.flatMap((p) => (p.ok ? [[p.rodzaj, p.wejsciaHash]] : []))),
    historia,
  };
  return mobileJson(odpowiedz, 200, headers);
}

// Schemat strony (M10d: z nadwyżką VAT wpisaną przy pozycji): treść spoza kontraktu to 400, nie odmowa rozliczenia.
const zatwierdzenieTelefonuSchema = zatwierdzenieSchema.strict();

/** `POST /api/mobile/v1/ksiegowosc/zatwierdz`. */
export async function approveMonthFromMobile(caller: MobileCaller, request: Request): Promise<NextResponse> {
  const headers = caller.headers;
  const org = orgOf(caller);
  if (!ROLE_ZAPISU.has(org.role)) return mobileError(403, 'forbidden', TYLKO_WLASCICIEL, headers);
  const raw = await readJsonBody(request, headers, { maxBytes: MAX_BODY_BYTES, tooLarge: 'Treść jest za długa.' });
  if (!raw.ok) return raw.response;
  const parsed = zatwierdzenieTelefonuSchema.safeParse(raw.value);
  if (!parsed.success) return mobileError(400, 'invalid_request', 'Treść żądania nie pasuje do kontraktu. Zaktualizuj aplikację FaktWay.', headers);
  const wynik = await zatwierdzMiesiac(
    { client: caller.db as Db, tenantId: org.tenantId, userId: caller.user.id },
    // Wpisana przy pozycji VAT nadwyżka (K7.1): zatwierdzenie liczy VAT z tą samą kwotą, którą klient widział.
    { miesiac: parsed.data.miesiac, skroty: parsed.data.skroty, nadwyzkaVat: parsed.data.nadwyzkaVat ?? null },
  );
  if (!wynik.success) return mobileError(422, 'settlement_refused', wynik.error, headers);
  const odpowiedz: ZatwierdzenieMiesiacaOdpowiedz = { nowe: wynik.nowe };
  return mobileJson(odpowiedz, 200, headers);
}

const zaplataSchema = z.object({ zaplacone: z.boolean(), dzien: z.string().nullable() }).strict();

/** `POST /api/mobile/v1/ksiegowosc/rozliczenia/{id}/zaplata`. */
export async function settlementPaymentFromMobile(caller: MobileCaller, id: string, request: Request): Promise<NextResponse> {
  const headers = caller.headers;
  const org = orgOf(caller);
  if (!isUuid(id)) return mobileError(404, 'not_found', 'Tego rozliczenia nie ma na liście. Odśwież „Ten miesiąc”.', headers);
  if (!ROLE_ZAPISU.has(org.role)) return mobileError(403, 'forbidden', TYLKO_WLASCICIEL, headers);
  const raw = await readJsonBody(request, headers, { maxBytes: MAX_BODY_BYTES, tooLarge: 'Treść jest za długa.' });
  if (!raw.ok) return raw.response;
  const parsed = zaplataSchema.safeParse(raw.value);
  if (!parsed.success) return mobileError(400, 'invalid_request', 'Treść żądania nie pasuje do kontraktu. Zaktualizuj aplikację FaktWay.', headers);
  const wynik = await oznaczZaplacone(
    { client: caller.db as Db, tenantId: org.tenantId, userId: caller.user.id },
    { id: id.toLowerCase(), zaplacone: parsed.data.zaplacone, data: parsed.data.dzien },
  );
  if (!wynik.success) return mobileError(422, 'settlement_refused', wynik.error, headers);
  const odpowiedz: ZaplataRozliczeniaOdpowiedz = { zaplacone: parsed.data.zaplacone };
  return mobileJson(odpowiedz, 200, headers);
}
