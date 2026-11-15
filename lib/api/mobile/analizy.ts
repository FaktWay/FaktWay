import 'server-only';

import type { NextResponse } from 'next/server';

import { incomeExpenseNet, salesAvgDaily } from '@/components/analizy/adapters';
import type { MobileCaller } from '@/lib/api/mobile/auth';
import type { AnalizyOdpowiedz, CzescPodzialu, CzescTelefonu } from '@/lib/api/mobile/kontrakt-wiecej';
import { mobileJson } from '@/lib/api/mobile/responses';
import { dailyTotals, type BreakdownSlice } from '@/lib/analytics-finance/breakdown';
import { heatmapIntensityLevel } from '@/lib/analytics-finance/heatmap';
import { saleBuyerName } from '@/lib/analytics-finance/clients';
import { costCategoryBreakdown, costMonthStats, costOfMonth, costTrend, costVatSummary, recentCosts } from '@/lib/analytics-finance/costs';
import {
  analyticsDataRange,
  analyticsMonthOptions,
  currentMonthKey,
  HEATMAP_DAYS,
  monthKeysEnding,
  monthRange,
  resolveAnalyticsMonth,
  shiftMonthKey,
  TREND_MONTHS,
} from '@/lib/analytics-finance/months';
import { productBreakdown } from '@/lib/analytics-finance/products';
import { RECURRING_MONTHS, recurringClients, recurringSuppliers, type RecurringItem } from '@/lib/analytics-finance/recurring';
import { getSalesInvoices, recentSales, salesMonthStats, salesOfMonth, salesTrend, type SaleInvoice } from '@/lib/analytics-finance/sales';
import { getCostsWithKsefPurchases, type CostEntry } from '@/lib/dashboard/costs';
import { customerErrorDetail } from '@/lib/dashboard/customer-error';
import { fetchProductLines } from '@/lib/dashboard/rankings';
import { getReceivables } from '@/lib/dashboard/receivables';
import { kontekstDanych, type KontekstStrony } from '@/lib/demo/tryb-danych';
import { todayInWarsaw } from '@/lib/format/warsaw-date';

/**
 * `GET /api/mobile/v1/analizy?widok=sprzedaz|koszty&miesiac=RRRR-MM` (plan
 * aplikacji mobilnej, M10e, część 2): karty stron `/analizy/sprzedaz` i
 * `/analizy/koszty` tymi samymi funkcjami co siatki strony
 * (`components/analizy/{sprzedaz,koszty}-grid.tsx`): `kontekstDanych` (tryb
 * firmy, dane przykładowe przed potwierdzeniem KSeF), okno danych
 * `analyticsDataRange`, miesiąc `resolveAnalyticsMonth` (jeden z sześciu, jak
 * przełącznik strony) i czyste funkcje `lib/analytics-finance`. Kwoty w
 * złotych, procenty udziałów liczy serwer; telefon tylko pokazuje.
 *
 * Każda karta osobno: wyjątek zabiera kartę z polską treścią strażnika.
 * Należności w danych przykładowych strona liczy z terminów wpływów; telefon
 * ich wtedy nie pokazuje (karta mówi dlaczego). Klient z tokenem, tylko odczyt.
 */

const BLAD_OGOLNY = 'Nie udało się policzyć. Spróbuj ponownie za chwilę.';
/** Jak `RECURRING_LIST_LIMIT` kart „Stali klienci” i „Stałe koszty” strony. */
const LIMIT_STALYCH = 6;

async function czesc<T>(kontekst: string, licz: () => Promise<T> | T): Promise<CzescTelefonu<T>> {
  try {
    return { ok: true, dane: await licz() };
  } catch (error) {
    const szczegol = customerErrorDetail(error);
    if (!szczegol) console.error(`[api.mobile.analizy] ${kontekst}:`, error);
    return { ok: false, blad: szczegol ?? BLAD_OGOLNY };
  }
}

function podzial(slices: readonly BreakdownSlice[]): CzescPodzialu[] {
  return slices.map((s) => ({ klucz: s.key, etykieta: s.label, kwota: s.amount, procent: s.percentage, pozostale: s.other }));
}

function stali(items: readonly RecurringItem[]) {
  return items.map((r) => ({ klucz: r.key, nazwa: r.name, srednio: r.averageAmount, dzien: r.typicalDay, miesiace: r.months }));
}

/** Odcień pola kalendarza jak na stronie: kwantyl wśród dni z kwotą (`heatmapIntensityLevel`). */
function kalendarzDni(days: ReadonlyArray<{ date: string; amount: number }>) {
  const dodatnie = days.map((d) => d.amount).filter((a) => a > 0).sort((a, b) => a - b);
  return days.map((d) => ({ dzien: d.date, kwota: d.amount, poziom: heatmapIntensityLevel(d.amount, dodatnie) }));
}

type Okno<T> = { ok: true; dane: T } | { ok: false; error: unknown };
const okno = <T,>(p: Promise<T>): Promise<Okno<T>> => p.then((dane) => ({ ok: true as const, dane }), (error: unknown) => ({ ok: false as const, error }));
const z = <T,>(o: Okno<T>): T => {
  if (!o.ok) throw o.error;
  return o.dane;
};

export async function analyticsForMobile(caller: MobileCaller, request: Request, now: Date = new Date()): Promise<NextResponse> {
  if (!caller.org) throw new Error('Trasa analiz bez firmy (org: required)');
  const params = new URL(request.url).searchParams;
  const widok = params.get('widok') === 'koszty' ? 'koszty' : 'sprzedaz';
  const month = resolveAnalyticsMonth(params.get('miesiac') ?? undefined, now);
  // Klient z tokenem telefonu w miejscu klienta z ciasteczek strony (RLS).
  const ctx = await kontekstDanych({ supabase: caller.db as unknown as KontekstStrony['supabase'], tenantId: caller.org.tenantId, user: { id: caller.user.id } }, now);
  const { supabase, tenantId, tryb } = ctx;
  const today = todayInWarsaw(now);
  const range = analyticsDataRange(now);
  const prev = shiftMonthKey(month, -1);
  const trendKeys = monthKeysEnding(currentMonthKey(now), TREND_MONTHS);
  const recurringKeys = monthKeysEnding(currentMonthKey(now), RECURRING_MONTHS);

  const [sprzedaz, koszty] = await Promise.all([
    okno<SaleInvoice[]>(getSalesInvoices(supabase, tenantId, range)),
    okno<CostEntry[]>(getCostsWithKsefPurchases(supabase, tenantId, range)),
  ]);
  const wynik = czesc('wynik', () => incomeExpenseNet(salesOfMonth(z(sprzedaz), month), costOfMonth(z(koszty), month))).then((c) =>
    c.ok ? { ok: true as const, dane: { przychody: c.dane.income, koszty: c.dane.expense, wynik: c.dane.net } } : c,
  );

  const wspolne = { tryb, widok, miesiac: month, miesiace: analyticsMonthOptions(now).map((o) => ({ klucz: o.value, etykieta: o.label })), kosztyKsefOd: ctx.kosztyKsefOd } as const;

  if (widok === 'sprzedaz') {
    const [kafle, trend, produkty, ostatnie, naleznosci, w, staliKlienci, kalendarz] = await Promise.all([
      czesc('kafle', () => {
        const s = salesMonthStats(z(sprzedaz), month, prev);
        return { suma: s.total, srednioDziennie: salesAvgDaily(s.total, month, today), zmianaPct: s.changePct, najlepszy: s.bestClient };
      }),
      czesc('trend', () => salesTrend(z(sprzedaz), trendKeys).map((p) => ({ klucz: p.key, etykieta: p.label, kwota: p.amount }))),
      czesc('produkty', async () => podzial(productBreakdown(await fetchProductLines(supabase, tenantId, monthRange(month))))),
      czesc('ostatnie', () =>
        recentSales(z(sprzedaz), month, saleBuyerName).map((r) => ({ id: r.id, nazwa: r.name, numer: r.number, data: r.date, kwota: r.amount, korekta: r.kind === 'correction' })),
      ),
      // Dane przykładowe: strona liczy należności z terminów wpływów atrapy; telefon ich nie pokazuje (`null`, ekran mówi dlaczego).
      tryb === 'przyklad'
        ? Promise.resolve(null)
        : czesc('naleznosci', async () => {
            const r = await getReceivables(supabase, tenantId, now);
            return { doZaplaty: r.total, poTerminie: r.overdue, liczba: r.count, liczbaPoTerminie: r.overdueCount, najstarszaDni: r.oldestOverdueDays, pominieteWWalucie: r.foreignCurrencyCount };
          }),
      wynik,
      czesc('stali', () => stali(recurringClients(z(sprzedaz), recurringKeys, LIMIT_STALYCH))),
      czesc('kalendarz', () => kalendarzDni(dailyTotals(z(sprzedaz), (inv) => inv.issueDate, (inv) => inv.net, today, HEATMAP_DAYS))),
    ]);
    const odpowiedz: AnalizyOdpowiedz = { ...wspolne, kafle, trend, podzial: produkty, ostatnie, naleznosci, vat: null, wynik: w, stali: staliKlienci, kalendarz };
    return mobileJson(odpowiedz, 200, caller.headers);
  }

  const [kafle, trend, kategorie, ostatnie, vat, w, staleKoszty, kalendarz] = await Promise.all([
    czesc('kafle', () => {
      const s = costMonthStats(z(koszty), month, prev, today);
      return { suma: s.total, srednioDziennie: s.avgDaily, zmianaPct: s.changePct, najlepszy: s.topCategory };
    }),
    czesc('trend', () => costTrend(z(koszty), trendKeys).map((p) => ({ klucz: p.key, etykieta: p.label, kwota: p.amount }))),
    czesc('kategorie', () => podzial(costCategoryBreakdown(z(koszty), month))),
    czesc('ostatnie', () => recentCosts(z(koszty), month).map((r) => ({ id: r.id, nazwa: r.name, numer: null, data: r.date, kwota: r.amount, korekta: false }))),
    czesc('vat', () => {
      const v = costVatSummary(z(koszty), month);
      return { vat: v.vat, doOdliczenia: v.vatDeductible, doOpisania: v.toReview };
    }),
    wynik,
    czesc('stale', () => stali(recurringSuppliers(z(koszty), recurringKeys, LIMIT_STALYCH))),
    czesc('kalendarz', () => kalendarzDni(dailyTotals(z(koszty), (e) => e.issueDate, (e) => e.outflow, today, HEATMAP_DAYS))),
  ]);
  const odpowiedz: AnalizyOdpowiedz = { ...wspolne, kafle, trend, podzial: kategorie, ostatnie, naleznosci: null, vat, wynik: w, stali: staleKoszty, kalendarz };
  return mobileJson(odpowiedz, 200, caller.headers);
}
