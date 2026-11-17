import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { kluczDokumentuKosztu, zdublowanyDokument, type DokumentKosztu } from '@/lib/expenses/jeden-koszt-dokumentu';

import { getRlsTestDatabaseUrl, getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * FZ-022 (RP-KOSZT-01): zapytanie operatora `scripts/ops/koszt-dwa-razy.sql`
 * (wołane przez `.sh` obok) na prawdziwej bazie daje te same grupy z odmową
 * co odczyty aplikacji (`zdublowanyDokument` z `lib/expenses/jeden-koszt-dokumentu.ts`)
 * na tych samych wierszach: koszt z KSeF i kopia spoza KSeF (także zdjęcie
 * z rodzajem `simplified_invoice`), kopie spoza KSeF (to samo brutto, ta sama
 * kolumna), paragony (dzień i brutto), dwa koszty z KSeF, rozpisanie na
 * kolumny, ten sam numer w innym roku i koszt poza KPiR. Bez firmy wynik ma
 * same liczby, szczegóły tylko dla jednej firmy, a plik nic nie zapisuje
 * (`BEGIN READ ONLY`).
 *
 * psql: `RLS_TEST_PSQL` (domyślnie `psql`; lokalnie np. `wsl -e psql`).
 */

const hasDatabase = Boolean(
  process.env.RLS_TEST_SUPABASE_URL?.trim() &&
    process.env.RLS_TEST_SUPABASE_ANON_KEY?.trim() &&
    process.env.RLS_TEST_SUPABASE_SERVICE_ROLE_KEY?.trim() &&
    process.env.RLS_TEST_DATABASE_URL?.trim(),
);
const environment = hasDatabase ? getRlsTestEnvironment() : null;
const databaseUrl = hasDatabase ? getRlsTestDatabaseUrl() : '';
const admin: SupabaseClient = environment
  ? createClient(environment.url, environment.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  : (null as unknown as SupabaseClient);

// Jak `.sh`: bez CR (checkout z Windowsa), bo psql nie rozpozna „\if :szczegoly\r”.
const SQL = readFileSync(join(process.cwd(), 'scripts/ops/koszt-dwa-razy.sql'), 'utf8').split('\r').join('');
const PSQL = (process.env.RLS_TEST_PSQL?.trim() || 'psql').split(/\s+/);

const ORG = '00222022-0000-4000-8000-00000000000a';
const ORG_B = '00222022-0000-4000-8000-00000000000b';
const EMAIL = 'rls-koszt-dwa-razy@ksef-saas.test';
const PASS = 'RlsKosztDwaRazy2026Aa!';
const NIP = '5260001246';
const NIP_B = '5252241585';

let user = '';
let counter = 0;
const nextId = (kind: string) => {
  counter += 1;
  return `00222022-${kind}-4000-8000-${String(counter).padStart(12, '0')}`;
};

async function userId(email: string): Promise<string> {
  for (let page = 1; page < 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < 1000) break;
  }
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASS, email_confirm: true });
  if (error || !data.user) throw error ?? new Error('createUser');
  return data.user.id;
}

type Koszt = DokumentKosztu & { id: string; tenant_id: string; is_deductible: boolean; issue_date: string };
const wiersze: Koszt[] = [];

/** Koszt z KSeF: faktura zakupu przyjęta w KSeF i koszt ze Skrzynki, jak zapisuje je runner. */
async function zKsef(org: string, numer: string, data: string, brutto: number, nip = NIP): Promise<void> {
  const invoiceId = nextId('1111');
  const invoice = await admin.from('invoices').insert({
    id: invoiceId, tenant_id: org, direction: 'incoming', origin: 'ksef_inbox', internal_number: numer,
    invoice_type: 'VAT', invoice_kind: 'regular', issue_date: data, seller_nip: nip, buyer_nip: '1234567890',
    gross_total: brutto, net_total: brutto, vat_total: 0, currency: 'PLN', ksef_status: 'accepted', ksef_environment: 'test',
    ksef_number: `${nip}-${data.replace(/-/g, '')}-${String(counter).padStart(12, '0')}-00`, xml_storage_path: 'x.xml',
    fa3_data: { _source: 'inbox-metadata', _pendingFullFetch: false },
  });
  if (invoice.error) throw new Error(`faktura ${numer}: ${invoice.error.message}`);
  await koszt(org, numer, data, brutto, { source: 'ksef_inbox', ksef_invoice_id: invoiceId, seller_nip: nip });
}

/** Koszt spoza KSeF (zdjęcie, wpis ręczny) albo z KSeF, gdy podano `ksef_invoice_id`. */
async function koszt(org: string, numer: string, data: string, brutto: number, pola: Partial<Koszt> = {}): Promise<void> {
  const w: Koszt = {
    id: nextId('2222'), tenant_id: org, source: 'ocr_photo', ksef_invoice_id: null, seller_name: 'Dostawca',
    seller_nip: NIP, document_number: numer, document_type: 'invoice', issue_date: data, gross_amount: brutto,
    kpir_column: 'col_13', ocr_extracted_data: null, is_deductible: true, ...pola,
  };
  const { error } = await admin.from('expenses').insert({
    ...w, created_by: user, net_amount: brutto, vat_amount: 0, vat_deductible_amount: 0, is_reviewed: true,
  });
  if (error) throw new Error(`koszt ${numer}: ${error.message}`);
  wiersze.push(w);
}

async function sprzataj(): Promise<void> {
  for (const org of [ORG, ORG_B]) {
    const e = await admin.from('expenses').delete().eq('tenant_id', org);
    if (e.error) throw e.error;
    const i = await admin.from('invoices').delete().eq('tenant_id', org);
    if (i.error) throw i.error;
  }
}

/** SQL tak, jak uruchamia go `.sh` (wynik bez wyrównania, do odczytu w teście). */
function uruchom(firma: string, szczegoly: boolean, lista = false): { status: number | null; out: string } {
  const [cmd, ...prefix] = PSQL;
  const r = spawnSync(
    cmd!,
    [...prefix, '-X', '-q', '-A', '-F', '|', '-P', 'footer=off', '-v', 'ON_ERROR_STOP=1', '-v', `firma=${firma}`, '-v', `lista=${lista ? 1 : 0}`, '-v', `szczegoly=${szczegoly ? 1 : 0}`, '-f', '-', databaseUrl],
    { input: SQL, encoding: 'utf8', env: { ...process.env, PGOPTIONS: '-c default_transaction_read_only=on' } },
  );
  if (r.error) throw r.error;
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Wiersze tabeli pod nagłówkiem sekcji `=== {poczatek}` (bez nagłówka kolumn), do następnej sekcji. */
function sekcja(out: string, poczatek: string): string[][] {
  const linie = out.split('\n');
  const start = linie.findIndex((l) => l.startsWith(`=== ${poczatek}`));
  if (start === -1) throw new Error(`brak sekcji „${poczatek}”:\n${out}`);
  const wynik: string[][] = [];
  for (const l of linie.slice(start + 2)) {
    if (l.startsWith('=== ')) break;
    if (l.trim()) wynik.push(l.split('|'));
  }
  return wynik;
}
const liczby = (out: string) => new Map(sekcja(out, 'Ten sam dokument').map(([co, ile]) => [co!, Number(ile)]));

describe.skipIf(!hasDatabase)('FZ-022: zapytanie operatora koszt-dwa-razy.sql na prawdziwej bazie', () => {
  beforeAll(async () => {
    user = await userId(EMAIL);
    await sprzataj();
    const tenants = await admin.from('tenants').upsert([
      { id: ORG, nip: '1234567890', name: 'Firma FZ-022 A' },
      { id: ORG_B, nip: '1234567890', name: 'Firma FZ-022 B' },
    ]);
    if (tenants.error) throw tenants.error;

    // G1: faktura z KSeF i zdjęcie tej samej faktury (ta sama kwota): odmowa.
    await zKsef(ORG, 'FV/1/2027', '2027-02-05', 123);
    await koszt(ORG, 'fv/1/2027 ', '2027-02-04', 123);
    // G2: zdjęcie faktury uproszczonej (rodzaj z OCR) i ta sama faktura z KSeF: odmowa (N1).
    await zKsef(ORG, 'UPR/2/2027', '2027-02-06', 61.5);
    await koszt(ORG, 'UPR/2/2027', '2027-02-06', 61.5, { document_type: 'simplified_invoice', ocr_extracted_data: { document_type: 'simplified_invoice' } });
    // G3: z KSeF i zdjęcie ze źle odczytaną kwotą: odmowa, do sprawdzenia (różne brutto).
    await zKsef(ORG, 'FV/3/2027', '2027-02-07', 200);
    await koszt(ORG, 'FV/3/2027', '2027-02-07', 260);
    // G4: dwa koszty z KSeF z tym samym numerem (dla KSeF dwa dokumenty, np. faktura i korekta): bez odmowy.
    await zKsef(ORG, 'FV/4/2027', '2027-02-08', 100);
    await zKsef(ORG, 'FV/4/2027', '2027-02-20', 50);
    // G5: faktura rozpisana na dwie kolumny z różnymi kwotami: bez odmowy.
    await koszt(ORG, 'FV/5/2027', '2027-02-09', 70, { kpir_column: 'col_10' });
    await koszt(ORG, 'FV/5/2027', '2027-02-09', 30, { kpir_column: 'col_11', source: 'manual' });
    // G6: to samo zdjęcie dwa razy: odmowa (kopie spoza KSeF).
    await koszt(ORG, 'FV/6/2027', '2027-02-10', 55);
    await koszt(ORG, 'FV/6/2027', '2027-02-10', 55);
    // G7: dwa paragony z tym samym numerem z innych dni (inne kasy): bez odmowy.
    await koszt(ORG, '4711', '2027-02-11', 12.5, { document_type: 'receipt' });
    await koszt(ORG, '4711', '2027-02-12', 12.5, { document_type: 'receipt' });
    // G8: ten sam paragon dwa razy (ten sam dzień i kwota): odmowa.
    await koszt(ORG, '4712', '2027-02-13', 9.99, { document_type: 'receipt' });
    await koszt(ORG, '4712', '2027-02-13', 9.99, { document_type: 'receipt' });
    // G9: ten sam numer w innym roku: dwie faktury, bez grupy.
    await koszt(ORG, '15', '2026-12-15', 40);
    await zKsef(ORG, '15', '2027-01-15', 40);
    // Kopia poza KPiR nie liczy się wcale.
    await zKsef(ORG, 'FV/10/2027', '2027-02-14', 99, NIP_B);
    await koszt(ORG, 'FV/10/2027', '2027-02-14', 99, { seller_nip: NIP_B, is_deductible: false });
    // Druga firma: jedna odmowa (z KSeF i ręczny).
    await zKsef(ORG_B, 'FV/1/2027', '2027-02-05', 123);
    await koszt(ORG_B, 'FV/1/2027', '2027-02-05', 123, { source: 'manual' });
  }, 120_000);

  afterAll(async () => {
    await sprzataj();
  });

  it('grupy firmy i odmowy są te same co w odczytach aplikacji (zdublowanyDokument na tych samych wierszach)', () => {
    const r = uruchom(ORG, true);
    expect(r.status, r.out).toBe(0);
    const zSql = sekcja(r.out, 'Szczegóły grup firmy')
      .map(([, numer, rok, wzor, odmowa]) => `${numer}|${rok}|${wzor}|${odmowa}`)
      .sort();

    const grupy = new Map<string, Koszt[]>();
    for (const w of wiersze.filter((x) => x.tenant_id === ORG && x.is_deductible)) {
      const klucz = kluczDokumentuKosztu(w);
      if (klucz) grupy.set(klucz, [...(grupy.get(klucz) ?? []), w]);
    }
    const zAplikacji = [...grupy.entries()]
      .filter(([, g]) => g.length > 1)
      .map(([klucz, g]) => {
        const [, numer, rok] = klucz.split('|');
        return `${numer}|${rok}|${zdublowanyDokument(g) ? 't' : 'f'}`;
      })
      .sort();
    expect(zSql.map((w) => { const [numer, rok, , odmowa] = w.split('|'); return `${numer}|${rok}|${odmowa}`; }).sort()).toEqual(zAplikacji);
    expect(zSql).toEqual([
      'FV/1/2027|2027|z KSeF i spoza KSeF|t',
      'FV/3/2027|2027|z KSeF i spoza KSeF|t',
      'FV/4/2027|2027|same z KSeF|f',
      'FV/5/2027|2027|spoza KSeF, różne kwoty i kolumny|f',
      'FV/6/2027|2027|kopie spoza KSeF|t',
      '4711|2027|spoza KSeF, różne kwoty i kolumny|f',
      '4712|2027|kopie spoza KSeF|t',
      'UPR/2/2027|2027|z KSeF i spoza KSeF|t',
    ].sort());
  });

  it('liczby jednej firmy: odmowy, wzory, do sprawdzenia; bez NIP-ów, numerów i kwot', () => {
    const r = uruchom(ORG, false);
    expect(r.status, r.out).toBe(0);
    const l = liczby(r.out);
    expect(l.get('firmy z odmową')).toBe(1);
    expect(l.get('grupy z odmową')).toBe(5);
    expect(l.get('grupy z odmową: z KSeF i spoza KSeF')).toBe(3);
    expect(l.get('grupy z odmową: kopie spoza KSeF')).toBe(2);
    expect(l.get('grupy z odmową i różną kwotą brutto (do sprawdzenia: mogą być fałszywą odmową)')).toBe(1);
    expect(l.get('grupy bez odmowy: same z KSeF')).toBe(1);
    expect(l.get('grupy bez odmowy: spoza KSeF, różne kwoty i kolumny')).toBe(2);
    expect(sekcja(r.out, 'Pary źródeł').map(([zrodla, grup]) => `${zrodla}:${grup}`).sort()).toEqual(
      ['ksef+ksef:1', 'ksef+ocr_photo:3', 'manual+ocr_photo:1', 'ocr_photo+ocr_photo:3'].sort(),
    );
    expect(r.out).not.toContain(NIP);
    expect(r.out).not.toContain('FV/1/2027');
    expect(r.out).not.toContain('Szczegóły grup firmy');
  });

  it('wszystkie firmy: liczby obejmują obie firmy testu; szczegóły bez firmy odmawia', () => {
    const r = uruchom('', false);
    expect(r.status, r.out).toBe(0);
    const l = liczby(r.out);
    // Baza testowa jest wspólna dla testów, więc co najmniej obie firmy z tego testu.
    expect(l.get('firmy z odmową')).toBeGreaterThanOrEqual(2);
    expect(l.get('grupy z odmową')).toBeGreaterThanOrEqual(6);
    expect(r.out).not.toContain(NIP);

    const bez = uruchom('', true);
    expect(bez.out).toContain('Szczegóły tylko dla jednej firmy (--firma <uuid>).');
    expect(bez.out).not.toContain('=== Ten sam dokument');
  });

  it('lista firm: id firm z odmową i liczby, bez NIP-ów, numerów i kwot', () => {
    const r = uruchom('', false, true);
    expect(r.status, r.out).toBe(0);
    const firmy = new Map(sekcja(r.out, 'Firmy z odmową').map(([firma, grup, doSprawdzenia, zlozony]) => [firma!, `${grup}|${doSprawdzenia}|${zlozony}`]));
    expect(firmy.get(ORG)).toBe('5|1|f');
    expect(firmy.get(ORG_B)).toBe('1|0|f');
    expect(r.out).not.toContain(NIP);
    expect(r.out).not.toContain('FV/1/2027');
  });

  it('plik niczego nie zapisuje: zapis dopisany na końcu pliku pada w transakcji tylko do odczytu', () => {
    const [cmd, ...prefix] = PSQL;
    const zapis = SQL.replace(/ROLLBACK;\s*$/, `UPDATE public.expenses SET notes = 'x' WHERE tenant_id = '${ORG}';\nROLLBACK;\n`);
    const r = spawnSync(cmd!, [...prefix, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-v', `firma=${ORG}`, '-v', 'lista=0', '-v', 'szczegoly=0', '-f', '-', databaseUrl], {
      input: zapis,
      encoding: 'utf8',
    });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/read-only transaction/);
  });
});
