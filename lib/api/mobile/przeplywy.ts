import 'server-only';

import type { NextResponse } from 'next/server';

import { limitProps, odlozycProps, podatekProps, type PierscienDane } from '@/components/przeplywy/finora-1do1/adaptery';
import type { MobileCaller } from '@/lib/api/mobile/auth';
import type { CzescTelefonu, KubelekPrzeplywow, PierscienTelefonu, PrzeplywyOdpowiedz, WykresPrzeplywow } from '@/lib/api/mobile/kontrakt-wiecej';
import { mobileJson } from '@/lib/api/mobile/responses';
import { getCashFlowData } from '@/lib/dashboard/cash-flow';
import {
  buildCashFlowChart,
  cashFlowOperations,
  monthFlows,
  nextMonthStart,
  przykladoweWplywy,
  topCashFlowSources,
  upcomingInflows,
  yearsWindowStart,
  type FlowBucket,
} from '@/lib/dashboard/cash-movements';
import { getCostsWithKsefPurchases, type CostEntry } from '@/lib/dashboard/costs';
import { customerErrorDetail } from '@/lib/dashboard/customer-error';
import { getInflows, type InflowEntry } from '@/lib/dashboard/inflows';
import { warsawMonthWindow } from '@/lib/dashboard/rankings';
import { getVatLimit } from '@/lib/dashboard/vat-limit';
import { kontekstDanych, type KontekstStrony, type TrybDanych } from '@/lib/demo/tryb-danych';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { isSubjectiveVatExemption, readTenantVatExemption } from '@/lib/invoices/vat-exemption';
import { czytajOdlozyc } from '@/lib/ksiegowosc/odlozyc';
import { czyKsiegowoscWlaczona } from '@/lib/ksiegowosc/wylacznik';
import { roundToCents } from '@/lib/xml/invoice-calculator';

/**
 * `GET /api/mobile/v1/przeplywy` (plan aplikacji mobilnej, M10e, część 2):
 * karty strony `/przeplywy` tymi samymi funkcjami co sloty strony
 * (`components/przeplywy/finora-1do1/sloty.tsx`): wejście do danych
 * `kontekstDanych` (tryb firmy; przed potwierdzeniem KSeF dane przykładowe
 * z atrapy bazy, jak strona), okna „ostatnie 12 miesięcy” i „lata”,
 * `getInflows` i `getCostsWithKsefPurchases`, czyste funkcje
 * `lib/dashboard/cash-movements.ts`, a pierścień przez adaptery strony
 * (limit zwolnienia z VAT, „Odłóż na podatek” z modułu księgowości w pilotażu
 * albo szacunek liniowy). Kwoty w złotych; telefon tylko pokazuje.
 *
 * Klient z tokenem telefonu w jego firmie (RLS). Każda karta liczy się osobno:
 * wyjątek zabiera kartę z polską treścią strażnika (`customerErrorDetail`), nie
 * cały ekran. Tylko odczyt.
 */

const BLAD_OGOLNY = 'Nie udało się policzyć. Spróbuj ponownie za chwilę.';
const RECENT_MONTHS = 12;
const LIMIT_OPERACJI = 100;

async function czesc<T>(kontekst: string, licz: () => Promise<T> | T): Promise<CzescTelefonu<T>> {
  try {
    return { ok: true, dane: await licz() };
  } catch (error) {
    const szczegol = customerErrorDetail(error);
    if (!szczegol) console.error(`[api.mobile.przeplywy] ${kontekst}:`, error);
    return { ok: false, blad: szczegol ?? BLAD_OGOLNY };
  }
}

function kubelki(b: readonly FlowBucket[]): WykresPrzeplywow {
  const lista: KubelekPrzeplywow[] = b.map((x) => ({
    klucz: x.key,
    etykieta: x.label,
    okres: x.period,
    wplywy: x.inflow,
    koszty: x.outflow,
    saldo: roundToCents(x.inflow - x.outflow),
    liczbaWplywow: x.inflowCount,
  }));
  return {
    kubelki: lista,
    sumaWplywow: roundToCents(b.reduce((s, x) => s + x.inflow, 0)),
    sumaKosztow: roundToCents(b.reduce((s, x) => s + x.outflow, 0)),
  };
}

function pierscien(p: PierscienDane): PierscienTelefonu {
  return { tytul: p.title, podtytul: p.subtitle, procent: p.pct, linie: p.lines, podpis: p.caption };
}

export async function cashFlowForMobile(caller: MobileCaller, now: Date = new Date()): Promise<NextResponse> {
  if (!caller.org) throw new Error('Trasa przepływów bez firmy (org: required)');
  // Klient z tokenem telefonu w miejscu klienta z ciasteczek strony (ten sam typ zapytań, RLS).
  const ctx = await kontekstDanych({ supabase: caller.db as unknown as KontekstStrony['supabase'], tenantId: caller.org.tenantId, user: { id: caller.user.id } }, now);
  const { supabase, tenantId } = ctx;
  const tryb: TrybDanych = ctx.tryb;
  const today = todayInWarsaw(now);
  const recent = warsawMonthWindow(now, RECENT_MONTHS);
  const years = { from: yearsWindowStart(today), toExclusive: nextMonthStart(today) };

  // Jak `loadInflows` strony: od początku okna, bez końca (przyszłe terminy też: Spodziewane wpływy).
  const wplywy = (from: string) =>
    getInflows(supabase, tenantId, { from }).then((e): InflowEntry[] => (tryb === 'przyklad' ? przykladoweWplywy(e, today) : e));
  const [ostatnie, lata] = await Promise.all([
    Promise.all([wplywy(recent.from), getCostsWithKsefPurchases(supabase, tenantId, recent)]).then(
      ([inflows, costs]) => ({ ok: true as const, inflows, costs }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    Promise.all([wplywy(years.from), getCostsWithKsefPurchases(supabase, tenantId, years)]).then(
      ([inflows, costs]) => ({ ok: true as const, inflows, costs }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  ]);
  const zOstatnich = <T>(k: string, f: (inflows: InflowEntry[], costs: CostEntry[]) => T) =>
    czesc(k, () => {
      if (!ostatnie.ok) throw ostatnie.error;
      return f(ostatnie.inflows, ostatnie.costs);
    });

  const [wykres, miesiac, pierscienKarta, zrodla, spodziewane, operacje] = await Promise.all([
    czesc('wykres', () => {
      if (!lata.ok) throw lata.error;
      const c = buildCashFlowChart(lata.inflows, lata.costs, today);
      return { tydzien: kubelki(c.week), miesiac: kubelki(c.month), rok: kubelki(c.year) };
    }),
    zOstatnich('miesiac', (inflows, costs) => {
      const m = monthFlows(inflows, costs, today);
      return {
        wplywy: { kwota: m.inflow.amount, poprzednio: m.inflow.prevAmount, liczba: m.inflow.count, zmianaPct: m.inflow.changePct },
        koszty: { kwota: m.outflow.amount, poprzednio: m.outflow.prevAmount, liczba: m.outflow.count, zmianaPct: m.outflow.changePct },
      };
    }),
    // Jak `PierscienKarta` strony: zwolniona podmiotowo widzi limit, płatnik VAT „Odłóż na podatek”.
    czesc('pierscien', async () => {
      const zwolnienie = await readTenantVatExemption(supabase, tenantId);
      if (isSubjectiveVatExemption(zwolnienie)) return pierscien(limitProps(await getVatLimit(supabase, tenantId, now), tryb));
      const pilotaz = tryb !== 'przyklad' && (await czyKsiegowoscWlaczona(supabase, tenantId, 'terminy').then((w) => w.wlaczony, () => false));
      if (pilotaz) return pierscien(odlozycProps(await czytajOdlozyc(supabase, tenantId, today)));
      return pierscien(podatekProps((await getCashFlowData(supabase, tenantId, now)).taxEstimate, tryb));
    }),
    zOstatnich('zrodla', (inflows, costs) =>
      topCashFlowSources(inflows, costs, today).map((s) => ({ klucz: s.key, nazwa: s.name, kierunek: s.direction, kwota: s.amount, liczba: s.count, udzial: s.share })),
    ),
    zOstatnich('spodziewane', (inflows) => {
      const u = upcomingInflows(inflows, today);
      return {
        pozycje: u.items.map((i) => ({ id: i.id, nazwa: i.name, numer: i.internalNumber, termin: i.dueDate, dniDoTerminu: i.daysLeft, kwota: i.amount })),
        liczba: u.count,
        suma: u.total,
      };
    }),
    zOstatnich('operacje', (inflows, costs) =>
      cashFlowOperations(inflows, costs, today)
        .slice(0, LIMIT_OPERACJI)
        .map((o) => ({ id: o.id, kierunek: o.direction, data: o.date, kontrahent: o.counterparty, numer: o.reference, kategoria: o.category, status: o.status, kwota: o.amount })),
    ),
  ]);

  const odpowiedz: PrzeplywyOdpowiedz = {
    tryb,
    kosztyKsefOd: ctx.kosztyKsefOd,
    wykres,
    miesiac,
    pierscien: pierscienKarta,
    zrodla,
    spodziewane,
    operacje,
  };
  return mobileJson(odpowiedz, 200, caller.headers);
}
