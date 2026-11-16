import 'server-only';

import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { logAudit } from '@/lib/audit/log';
import { zglosAlarmy } from '@/lib/bezpieczniki/alarm';
import { odmowaJpkV7m, sprawdzJpkV7m } from '@/lib/bezpieczniki/jpk-v7m';
import { monthLabel, monthRange } from '@/lib/expenses/month';
import { redactXsdMessage } from '@/lib/exports/jpk-schema-check';
import { generateJpkV7m } from '@/lib/exports/jpk-v7m-generator';
import { validateJpkV7m } from '@/lib/exports/jpk-v7m-validator';
import { readTenantTaxOffice } from '@/lib/exports/tax-office';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { BLAD_ODCZYTU_VAT, brakNadwyzki, czytajVat, type ZrodloNadwyzki } from '@/lib/ksiegowosc/vat-dane';
import { czyKsiegowoscWlaczona } from '@/lib/ksiegowosc/wylacznik';
import { srodowiskoMf, type SrodowiskoMf } from '@/lib/ksiegowosc/wysylka-jpk/certyfikaty';
import { daneAutoryzujaceSchema } from '@/lib/ksiegowosc/wysylka-jpk/dane-autoryzujace';
import type { DeklaracjaVat } from '@/lib/ksiegowosc/wysylka-jpk/zapis';

/**
 * Plik JPK_V7M(3) za miesiąc (plan księgowości JDG, K6), wspólny dla akcji
 * strony (`app/actions/ksiegowosc-vat.ts`, sesja z ciasteczek: pobranie
 * i wysyłka do MF) i telefonu (`POST /api/mobile/v1/ksiegowosc/vat/plik`,
 * M10d, sesja z tokenu). Kod przeniesiony z akcji bez zmian. Rolę sprawdza
 * wywołujący (pobranie: właściciel, administrator, księgowa); wyłącznik
 * (obszar `vat`), dane, XSD i strażnika pliku sprawdza ta funkcja. Klient to
 * klient sesji klienta (RLS).
 *
 * Ponowienie: pobranie nic nie zapisuje poza wierszem audytu, więc drugie
 * daje ten sam plik i drugi wpis `jpk_v7m.downloaded`.
 */

export interface KontekstVat {
  client: SupabaseClient;
  tenantId: string;
  userId: string;
}

export type WynikPlikuVat = { success: true; xml: string; nazwa: string } | { success: false; error: string; pole?: string };

export const VAT_NIEDOSTEPNY = 'VAT w Księgowości nie jest jeszcze dostępny dla tej firmy.';

const miesiacSchema = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/, 'Nieprawidłowy miesiąc.');

export const plikVatSchema = z.object({
  miesiac: miesiacSchema,
  /** P_39 wpisane przez klienta, pełne złote; null: z deklaracji przyjętej przez MF. */
  nadwyzka: z.number().int('Nadwyżka w pełnych złotych.').min(0, 'Nadwyżka nie może być ujemna.').max(1e13).nullable(),
  imie: daneAutoryzujaceSchema.shape.imie,
  nazwisko: daneAutoryzujaceSchema.shape.nazwisko,
  dataUrodzenia: daneAutoryzujaceSchema.shape.dataUrodzenia.refine((v) => v < todayInWarsaw(), 'To nie jest poprawna data urodzenia.'),
  /** E-mail podatnika w pliku (Podmiot1/Email); formularz podpowiada adres konta. */
  email: z
    .string()
    .trim()
    .min(3, 'Brak adresu e-mail podatnika.')
    .max(255, 'Adres e-mail ma w JPK najwyżej 255 znaków.')
    .regex(/^[^\s@]+@[^\s@]+$/, 'To nie jest adres e-mail.'),
});

export function bladPlikuVat(parsed: { error: z.ZodError }) {
  const issue = parsed.error.issues[0];
  return { success: false as const, error: issue?.message ?? 'Nieprawidłowe dane do pliku.', pole: issue?.path.join('.') };
}

async function wlaczonyVat(client: SupabaseClient, tenantId: string): Promise<boolean> {
  try {
    return (await czyKsiegowoscWlaczona(client, tenantId, 'vat')).wlaczony;
  } catch {
    return false;
  }
}

export type PlikVat =
  | { ok: true; xml: string; nazwa: string; deklaracja: DeklaracjaVat; nip: string; cel: 1 | 2; zrodloNadwyzki: ZrodloNadwyzki }
  | { ok: false; error: string };

/**
 * Plik JPK_V7M(3) za miesiąc z danych firmy: ta sama droga dla pobrania i wysyłki,
 * więc obie przechodzą przez XSD i strażnika pliku (`sprawdzJpkV7m`, filtr F13).
 * Po deklaracji przyjętej przez MF (w tym środowisku; bez środowiska: na produkcji)
 * kolejny plik za ten miesiąc to korekta (CelZlozenia 2).
 */
export async function plikJpkV7m(ctx: KontekstVat, w: z.infer<typeof plikVatSchema>, srodowisko: SrodowiskoMf | null): Promise<PlikVat> {
  const client = ctx.client;
  const { from, to } = monthRange(w.miesiac);
  if (w.miesiac < '2026-02') return { ok: false, error: 'JPK_V7M(3) obowiązuje od rozliczenia za luty 2026 r.' };
  if (to >= todayInWarsaw()) return { ok: false, error: `Plik za ${monthLabel(w.miesiac)} powstaje po zakończeniu miesiąca.` };

  const [dane, { data: firma, error: bladFirmy }, urzad] = await Promise.all([
    czytajVat(client, ctx.tenantId, w.miesiac, w.nadwyzka),
    client.from('tenants').select('nip, name').eq('id', ctx.tenantId).maybeSingle(),
    readTenantTaxOffice(client, ctx.tenantId).then(
      (kod) => ({ kod }),
      (e: unknown) => ({ blad: e }),
    ),
  ]);
  if (!dane.ok) return { ok: false, error: dane.komunikat };
  // F11-A4: błąd odczytu to nie brak NIP-u ani urzędu (klient nie ma czego poprawiać).
  if (bladFirmy || 'blad' in urzad) {
    Sentry.captureException(bladFirmy ?? ('blad' in urzad ? urzad.blad : null), {
      tags: { area: 'ksiegowosc.vat' },
      extra: { tenantId: ctx.tenantId, miesiac: w.miesiac, etap: 'dane_firmy_jpk_v7m' },
    });
    return { ok: false, error: BLAD_ODCZYTU_VAT };
  }
  const kodUrzedu = urzad.kod;
  if (!dane.nadwyzka || !dane.wynik) return { ok: false, error: brakNadwyzki(w.miesiac) };
  if (!dane.wynik.ok) return { ok: false, error: dane.wynik.brak };

  const nip = String((firma as { nip?: unknown } | null)?.nip ?? '').replace(/\D/g, '');
  if (!/^[1-9]((\d[1-9])|([1-9]\d))\d{7}$/.test(nip)) {
    return { ok: false, error: 'Plik JPK_V7M potrzebuje poprawnego NIP firmy. NIP jest w Ustawieniach, w danych firmy.' };
  }
  if (!kodUrzedu) {
    return { ok: false, error: 'Plik JPK_V7M potrzebuje urzędu skarbowego firmy. Urząd ustawia się w Ustawieniach, w części Księgowa.' };
  }
  const cel = dane.wysylki.some((x) => x.stan === 'przyjeta' && x.srodowisko === (srodowisko ?? 'produkcja')) ? 2 : 1;

  const xml = generateJpkV7m({
    issuer: {
      nip,
      name: String((firma as { name?: unknown } | null)?.name ?? ''),
      email: w.email,
      taxOfficeCode: kodUrzedu,
      naturalPerson: { firstName: w.imie, lastName: w.nazwisko, birthDate: w.dataUrodzenia },
    },
    periodStart: from,
    periodEnd: to,
    issuedInvoices: dane.dane.issuedInvoices,
    expenses: dane.dane.expenses,
    previousSurplus: dane.nadwyzka.zl,
    goal: cel === 2 ? '2' : '1',
  });
  const kontrola = await validateJpkV7m(xml);
  if (!kontrola.valid) {
    const bledy = kontrola.errors.slice(0, 20).map(redactXsdMessage);
    console.error('[jpk_v7m] niezgodny ze schematem', ctx.tenantId, bledy);
    Sentry.captureMessage('JPK_V7M niezgodny ze schematem XSD', {
      level: 'error',
      tags: { area: 'ksiegowosc.vat' },
      fingerprint: ['jpk_v7m_xsd', w.miesiac],
      extra: { tenantId: ctx.tenantId, miesiac: w.miesiac, bledy: bledy.slice(0, 5) },
    });
    return {
      ok: false,
      error:
        'Plik JPK_V7M nie przeszedł kontroli schematu Ministerstwa Finansów, więc go nie wydajemy. ' +
        'Szczegóły są w naszych logach i sprawdzimy dane z tego miesiąca.',
    };
  }
  // Strażnik (żelazny filtr F13): sumy kontrolne i deklaracja pliku po XSD. Plik
  // z alarmem nie trafia ani do klienta, ani do bramki MF; operator dostaje alarm.
  const alarmy = sprawdzJpkV7m(xml, w.miesiac);
  if (alarmy.length > 0) {
    zglosAlarmy(alarmy, { tenantId: ctx.tenantId, straznik: 'jpk-v7m' });
    return { ok: false, error: odmowaJpkV7m(alarmy[0].kod) };
  }
  const r = dane.wynik;
  const deklaracja: DeklaracjaVat = {
    P_38: r.naleznyGr / 100,
    P_39: r.nadwyzkaPoprzedniaGr / 100,
    P_48: r.naliczonyGr / 100,
    P_51: r.doZaplatyGr / 100,
    P_62: r.nadwyzkaNaNastepnyGr / 100,
  };
  return {
    ok: true,
    xml,
    nazwa: `JPK_V7M_${nip}_${w.miesiac}${cel === 2 ? '_korekta' : ''}.xml`,
    deklaracja,
    nip,
    cel,
    zrodloNadwyzki: dane.nadwyzka.zrodlo,
  };
}

/** Pobranie pliku: schemat, wyłącznik, plik i audyt; rola (właściciel, administrator, księgowa) sprawdzona przez wywołującego. */
export async function pobierzJpkV7m(ctx: KontekstVat, wejscie: z.input<typeof plikVatSchema>): Promise<WynikPlikuVat> {
  const parsed = plikVatSchema.safeParse(wejscie);
  if (!parsed.success) return bladPlikuVat(parsed);
  if (!(await wlaczonyVat(ctx.client, ctx.tenantId))) return { success: false, error: VAT_NIEDOSTEPNY };

  const plik = await plikJpkV7m(ctx, parsed.data, srodowiskoMf());
  if (!plik.ok) return { success: false, error: plik.error };
  await logAudit({
    action: 'jpk_v7m.downloaded',
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    entityType: 'jpk_v7m',
    // Bez imienia, nazwiska i daty urodzenia: tych danych nie zapisujemy (D9).
    metadata: { miesiac: parsed.data.miesiac, cel: plik.cel, deklaracja: plik.deklaracja, nadwyzkaZ: plik.zrodloNadwyzki },
  });
  return { success: true, xml: plik.xml, nazwa: plik.nazwa };
}
