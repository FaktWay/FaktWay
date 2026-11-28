import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { logAudit } from '@/lib/audit/log';
import { monthLabel } from '@/lib/expenses/month';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import {
  outsideKsefInvoiceSchema,
  outsideKsefRefusal,
  type OutsideKsefInvoiceInput,
} from '@/lib/import/outside-ksef-schema';
import { usunOryginalSpozaKsef } from '@/lib/import/outside-ksef-oryginal';
import { czySpozaKsefWlaczone, SPOZA_KSEF_NIEZNANE, SPOZA_KSEF_WYLACZONE } from '@/lib/import/outside-ksef-wylacznik';
import { czyKsiegowoscWlaczona } from '@/lib/ksiegowosc/wylacznik';
import { sellerFromTenantProfile } from '@/lib/invoices/tenant-seller';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { roundToCents, toGrosze } from '@/lib/xml/invoice-calculator';

/**
 * Zapis i usunięcie faktury wystawionej poza KSeF (krok 1.6, część 2b, PR B;
 * decyzje D19-D23 z `DECYZJE-2026-11-25.md`). Wpis jest kopią dokumentu klienta:
 * liczy się w KPiR albo w ewidencji przychodów (numer w kolumnie 4, kolumna 3
 * pusta, D20), w JPK_V7M z oznaczeniem BFK (D19) i na Pulpicie, a FaktWay go nie
 * wystawia i nie wysyła do KSeF. Całość za wyłącznikiem `outsideKsefImportEnabled`
 * (domyślnie wyłączony). Rolę (właściciel, administrator) sprawdza wywołujący;
 * klient to klient sesji (RLS).
 *
 * Ponowienie od zera: dodanie nie ma klucza, ale numer faktury jest unikalny
 * w firmie (`uq_invoices_tenant_outgoing_internal_number`), więc drugie
 * kliknięcie kończy się komunikatem „ten numer już jest”, a nie drugim wpisem.
 * Błąd zapisu pozycji usuwa nagłówek (bez sierot); gdyby i to się nie udało,
 * wiersz bez pozycji widać na liście i usuwa go klient. Usunięcie drugi raz:
 * „Tej faktury już nie ma w historii”. Audyt wpisuje się po udanej zmianie.
 */

export interface KontekstSpozaKsef {
  client: SupabaseClient;
  tenantId: string;
  userId: string;
}

export type WynikDodaniaSpozaKsef =
  | { success: true; id: string }
  | { success: false; error: string; pole?: string };

export type WynikUsunieciaSpozaKsef =
  | { success: true }
  | {
      success: false;
      error: string;
      /** Usunięcie dotyka miesiąca z wysłanym JPK_V7M albo zatwierdzonym rozliczeniem: klient potwierdza ponownie z `potwierdzam`. */
      wymagaPotwierdzenia?: true;
      miesiace?: string[];
    };

export const BLAD_ZAPISU_SPOZA_KSEF = 'Nie udało się zapisać faktury i nic się nie zmieniło. Można spróbować jeszcze raz.';
export const BLAD_USUNIECIA_SPOZA_KSEF = 'Nie udało się usunąć faktury i nic się nie zmieniło. Można spróbować jeszcze raz.';
export const SPOZA_KSEF_BRAK_DANYCH_FIRMY =
  'Uzupełnij dane firmy (nazwa, NIP i adres) w Ustawieniach, a potem dopisz fakturę. Bez nich nie zapiszemy sprzedawcy na fakturze.';
export const SPOZA_KSEF_SRODOWISKO =
  'Nie udało się ustalić środowiska KSeF tej firmy, więc faktury nie zapisaliśmy. Napisz do nas w Pomocy.';

const JEDNOSTKA = 'szt.';

type Wiersz = Record<string, unknown>;

/** Nagłówek `invoices`, pozycje i `fa3_data` wpisu; kwoty sumowane w groszach. */
export function zbudujWpisSpozaKsef(
  ctx: { tenantId: string; userId: string },
  wpis: OutsideKsefInvoiceInput,
  sprzedawca: NonNullable<ReturnType<typeof sellerFromTenantProfile>>,
  srodowisko: string,
  teraz: string,
): { naglowek: Wiersz; pozycje: Wiersz[] } {
  const netto = wpis.lines.reduce((s, l) => s + toGrosze(l.netAmount), 0);
  const vat = wpis.lines.reduce((s, l) => s + toGrosze(l.vatAmount), 0);
  const zl = (gr: number) => roundToCents(gr / 100);

  const pozycje = wpis.lines.map((l, i) => ({
    ordinal: i + 1,
    name: l.name,
    unit: JEDNOSTKA,
    quantity: 1,
    unit_price_net: l.netAmount,
    net_amount: l.netAmount,
    vat_rate: l.vatRate,
    vat_amount: l.vatAmount,
    gross_amount: l.grossAmount,
  }));

  const znaczniki = {
    ...(wpis.lines.some((l) => l.tp) ? { tp: true as const } : {}),
    ...(wpis.lines.some((l) => l.gtuCode)
      ? { gtu: [...new Set(wpis.lines.flatMap((l) => (l.gtuCode ? [l.gtuCode] : [])))] }
      : {}),
  };
  const fa3Data = {
    _source: 'outside-ksef',
    outsideKsef: { enteredAt: teraz, enteredBy: ctx.userId },
    lines: wpis.lines.map((l, i) => ({
      ordinal: i + 1,
      name: l.name,
      unit: JEDNOSTKA,
      quantity: 1,
      unitPriceNet: l.netAmount,
      netAmount: l.netAmount,
      vatRate: l.vatRate,
      vatAmount: l.vatAmount,
      grossAmount: l.grossAmount,
      ...(l.gtuCode ? { gtuCode: l.gtuCode } : {}),
      ...(l.exemptionBasis ? { exemptionBasis: l.exemptionBasis } : {}),
    })),
    ...(Object.keys(znaczniki).length ? { ksefMarkers: znaczniki } : {}),
  };

  const bezNip = !wpis.buyerNip;
  const naglowek: Wiersz = {
    tenant_id: ctx.tenantId,
    direction: 'outgoing',
    origin: 'outside_ksef',
    internal_number: wpis.number,
    ksef_status: 'accepted',
    ksef_environment: srodowisko,
    ksef_number: null,
    invoice_kind: 'regular',
    invoice_type: 'VAT',
    issue_date: wpis.issueDate,
    sale_date: wpis.saleDate ?? null,
    seller_nip: sprzedawca.nip,
    buyer_nip: wpis.buyerNip ?? null,
    is_b2c: bezNip,
    buyer_id_type: bezNip ? 'no_id' : 'nip',
    currency: 'PLN',
    net_total: zl(netto),
    vat_total: zl(vat),
    gross_total: zl(netto + vat),
    fa3_data: fa3Data,
    seller_data: sprzedawca,
    buyer_data: {
      ...(wpis.buyerNip ? { nip: wpis.buyerNip } : { noIdMarker: true }),
      name: wpis.buyerName,
      address: { countryCode: 'PL', addressLine1: ' ', addressLine2: ' ' },
    },
    payment_data: {},
  };
  return { naglowek, pozycje };
}

function bladBazy(error: { code?: string; message?: string }): string {
  const tekst = error.message ?? '';
  if (error.code === '23505') {
    return 'Faktura o tym numerze jest już w historii FaktWay. Jeśli to ta sama faktura, nie dopisuj jej drugi raz; jeśli inna, nadaj jej inny numer.';
  }
  if (tekst.includes('OUTSIDE_KSEF_ENVIRONMENT')) return SPOZA_KSEF_SRODOWISKO;
  if (error.code === '23514') {
    return 'Baza odrzuciła tę fakturę (data wystawienia spoza 2026 r. albo niedozwolony kształt wpisu). Sprawdź dane; jeśli są dobre, napisz do nas w Pomocy.';
  }
  return BLAD_ZAPISU_SPOZA_KSEF;
}

async function sprawdzWylacznik(): Promise<string | null> {
  try {
    return (await czySpozaKsefWlaczone()) ? null : SPOZA_KSEF_WYLACZONE;
  } catch {
    return SPOZA_KSEF_NIEZNANE;
  }
}

/**
 * `rodzajDokumentu` to rodzaj, który klient wskazał na formularzu (D22: faktura
 * do paragonu, korekta, zaliczka itd.); odmowa pada przed zapisem, z wyjściem.
 */
export async function dodajFakturaSpozaKsef(
  ctx: KontekstSpozaKsef,
  wejscie: unknown,
  rodzajDokumentu?: string,
): Promise<WynikDodaniaSpozaKsef> {
  const odmowa = rodzajDokumentu ? outsideKsefRefusal(rodzajDokumentu) : null;
  if (odmowa) return { success: false, error: odmowa, pole: 'rodzaj' };

  const parsed = outsideKsefInvoiceSchema.safeParse(wejscie);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { success: false, error: issue?.message ?? 'Nieprawidłowe dane faktury.', pole: issue?.path.join('.') };
  }
  const wpis = parsed.data;

  const wylaczony = await sprawdzWylacznik();
  if (wylaczony) return { success: false, error: wylaczony };

  let srodowisko: string;
  try {
    srodowisko = requireConfiguredKsefEnvironment();
  } catch {
    return { success: false, error: SPOZA_KSEF_SRODOWISKO };
  }

  const client = ctx.client;
  const { data: firma, error: firmaBlad } = await client
    .from('tenants')
    .select('id, nip, name, address_json')
    .eq('id', ctx.tenantId)
    .maybeSingle();
  if (firmaBlad || !firma) return { success: false, error: BLAD_ZAPISU_SPOZA_KSEF };
  const sprzedawca = sellerFromTenantProfile(firma as { nip: unknown; name: unknown; address_json: unknown });
  if (!sprzedawca) return { success: false, error: SPOZA_KSEF_BRAK_DANYCH_FIRMY };

  const { naglowek, pozycje } = zbudujWpisSpozaKsef(ctx, wpis, sprzedawca, srodowisko, new Date().toISOString());

  const { data: zapisany, error } = await client.from('invoices').insert(naglowek).select('id').single();
  if (error || !zapisany) return { success: false, error: bladBazy(error ?? {}) };
  const id = (zapisany as { id: string }).id;

  const { error: pozycjeBlad } = await client
    .from('invoice_line_items')
    .insert(pozycje.map((p) => ({ ...p, invoice_id: id })));
  if (pozycjeBlad) {
    // Bez sierot: nagłówek bez pozycji nie ma prawa zostać (KPiR liczy z nagłówka, JPK z pozycji).
    await client.from('invoices').delete().eq('id', id).eq('tenant_id', ctx.tenantId);
    return { success: false, error: BLAD_ZAPISU_SPOZA_KSEF };
  }

  await logAudit({
    action: 'invoice.outside_ksef_created',
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    entityType: 'invoice',
    entityId: id,
    metadata: {
      number: wpis.number,
      issueDate: wpis.issueDate,
      netTotal: naglowek.net_total,
      vatTotal: naglowek.vat_total,
      grossTotal: naglowek.gross_total,
      lines: wpis.lines.length,
    },
  });
  revalidatePath('/invoices');
  revalidatePath('/reports/ewidencja');
  return { success: true, id };
}

/** Miesiące (RRRR-MM), których dotyka faktura: wystawienia i sprzedaży, bez powtórzeń. */
function miesiaceFaktury(issueDate: string, saleDate: string | null): string[] {
  return [...new Set([issueDate.slice(0, 7), ...(saleDate ? [saleDate.slice(0, 7)] : [])])];
}

/**
 * D23: miesiące faktury, za które jest JPK_V7M wysłany z FaktWay (w toku albo
 * przyjęty) albo zatwierdzone rozliczenie w module. Tabele należą do modułu
 * księgowości, więc czytamy je tylko tam, gdzie obszar (`vat`, `ten_miesiac`)
 * jest dla firmy włączony (wyłącznik modułu, NZ-WYL-01); przy wyłączonym
 * module firma nie ma takich plików ani rozliczeń do pokazania. Błąd odczytu
 * rzuca: „nie wiem” nie pozwala usunąć bez ostrzeżenia.
 */
async function miesiaceZeSladem(client: SupabaseClient, tenantId: string, miesiace: string[]): Promise<string[]> {
  const okresy = miesiace.map((m) => `${m}-01`);
  const [vat, rozliczenie] = await Promise.all([
    czyKsiegowoscWlaczona(client, tenantId, 'vat'),
    czyKsiegowoscWlaczona(client, tenantId, 'ten_miesiac'),
  ]);
  const [jpk, rozliczenia] = await Promise.all([
    vat.wlaczony
      ? client.from('jpk_submissions').select('okres').eq('tenant_id', tenantId).in('okres', okresy).in('stan', ['w_toku', 'przyjeta'])
      : { data: [], error: null },
    rozliczenie.wlaczony
      ? client.from('tax_settlements').select('okres').eq('tenant_id', tenantId).in('okres', okresy)
      : { data: [], error: null },
  ]);
  if (jpk.error || rozliczenia.error) throw new Error('Nie udało się sprawdzić wysłanych plików i rozliczeń');
  const slad = new Set<string>();
  for (const w of [...((jpk.data ?? []) as Array<{ okres: string }>), ...((rozliczenia.data ?? []) as Array<{ okres: string }>)]) {
    slad.add(w.okres.slice(0, 7));
  }
  return miesiace.filter((m) => slad.has(m));
}

export function ostrzezenieOUsunieciu(numer: string, miesiace: string[]): string {
  const nazwy = miesiace.map((m) => monthLabel(m)).join(', ');
  return (
    `Za ${nazwy} jest już wysłany plik JPK_V7M albo zatwierdzone rozliczenie. ` +
    `Po usunięciu faktury ${numer} ten plik albo rozliczenie wymaga korekty, a składa ją podatnik. ` +
    'Usuń fakturę dopiero wtedy, gdy wiesz, że ma zniknąć z ksiąg.'
  );
}

/**
 * Usunięcie wpisu (D23): zawsze możliwe, z audytem; blokady nie ma. Gdy miesiąc
 * faktury ma wysłany JPK_V7M albo zatwierdzone rozliczenie, pierwsze wywołanie
 * zwraca ostrzeżenie z nazwą miesiąca i niczego nie usuwa; klient potwierdza
 * ponownie z `potwierdzam: true`. Poprawka wpisu to usunięcie i nowy wpis.
 * Dotyczy tylko wpisów spoza KSeF (zwykła faktura nie wchodzi tą drogą).
 */
export async function usunFakturaSpozaKsef(
  ctx: KontekstSpozaKsef,
  id: string,
  opcje: { potwierdzam?: boolean } = {},
): Promise<WynikUsunieciaSpozaKsef> {
  if (!z.string().uuid().safeParse(id).success) return { success: false, error: BLAD_USUNIECIA_SPOZA_KSEF };

  const wylaczony = await sprawdzWylacznik();
  if (wylaczony) return { success: false, error: wylaczony };

  const client = ctx.client;
  const { data: wiersz, error: odczyt } = await client
    .from('invoices')
    .select('id, internal_number, issue_date, sale_date, net_total, vat_total, gross_total, outside_ksef_original_path')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('origin', 'outside_ksef')
    .maybeSingle();
  if (odczyt) return { success: false, error: BLAD_USUNIECIA_SPOZA_KSEF };
  if (!wiersz) return { success: false, error: 'Tej faktury już nie ma w historii.' };
  const faktura = wiersz as {
    internal_number: string;
    issue_date: string;
    sale_date: string | null;
    net_total: unknown;
    vat_total: unknown;
    gross_total: unknown;
    outside_ksef_original_path?: string | null;
  };

  let miesiace: string[];
  try {
    miesiace = await miesiaceZeSladem(client, ctx.tenantId, miesiaceFaktury(faktura.issue_date, faktura.sale_date));
  } catch {
    return { success: false, error: BLAD_USUNIECIA_SPOZA_KSEF };
  }
  if (miesiace.length > 0 && !opcje.potwierdzam) {
    return { success: false, error: ostrzezenieOUsunieciu(faktura.internal_number, miesiace), wymagaPotwierdzenia: true, miesiace };
  }

  const { data: usuniete, error } = await client
    .from('invoices')
    .delete()
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('origin', 'outside_ksef')
    .select('id');
  if (error) return { success: false, error: BLAD_USUNIECIA_SPOZA_KSEF };
  if (!usuniete || usuniete.length === 0) return { success: false, error: 'Tej faktury już nie ma w historii.' };

  // D40: oryginał PDF ma okres przechowywania faktury, więc znika razem z wpisem. Wiersza już nie ma,
  // więc retencja nie znalazłaby pliku: nieudane kasowanie idzie do audytu i Sentry (operator sprząta klucz).
  const oryginal = faktura.outside_ksef_original_path ?? null;
  const oryginalUsuniety = oryginal ? await usunOryginalSpozaKsef(ctx.tenantId, oryginal) : null;

  await logAudit({
    action: 'invoice.outside_ksef_deleted',
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    entityType: 'invoice',
    entityId: id,
    metadata: {
      number: faktura.internal_number,
      issueDate: faktura.issue_date,
      netTotal: faktura.net_total,
      vatTotal: faktura.vat_total,
      grossTotal: faktura.gross_total,
      // Dzień usunięcia i miesiące, za które plik albo rozliczenie wymaga korekty (D23).
      deletedOn: todayInWarsaw(),
      monthsNeedingCorrection: miesiace,
      ...(oryginal ? { originalDeleted: oryginalUsuniety === true, originalPath: oryginal } : {}),
    },
  });
  revalidatePath('/invoices');
  revalidatePath('/reports/ewidencja');
  return { success: true };
}
