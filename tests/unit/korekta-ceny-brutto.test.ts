import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoryTables, Row } from './helpers/baza-w-pamieci';

const db = vi.hoisted(() => ({ tables: {} as MemoryTables }));
const TENANT = '11111111-1111-4111-8111-111111111111';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: vi.fn(async () => ({ ok: true })) }));
// Fikcyjny NIP 1234567890 (AGENTS.md) nie ma sumy kontrolnej; reszta kalkulatora prawdziwa.
vi.mock('@/lib/xml/invoice-calculator', async (orig) => {
  const prawdziwy: typeof import('@/lib/xml/invoice-calculator') = await orig();
  return { ...prawdziwy, validateNipChecksum: () => true };
});
vi.mock('@/lib/supabase/admin', async () => {
  const { memoryClient } = await import('./helpers/baza-w-pamieci');
  return { createAdminClient: () => memoryClient(db.tables) };
});
vi.mock('@/lib/supabase/auth-context', async () => {
  const { memoryClient } = await import('./helpers/baza-w-pamieci');
  return {
    requireUserAndActiveOrg: async () => ({ supabase: memoryClient(db.tables), user: { id: 'uzytkownik' }, tenantId: TENANT, role: 'owner' }),
    ActionAuthError: class ActionAuthError extends Error {},
  };
});

import { getCorrectionParentContextAction, saveCorrectionDraftAction } from '@/components/invoices/correction-actions';
import { sprawdzFa3 } from '@/lib/bezpieczniki/fa3';
import { korektaDoFormularza } from '@/lib/api/mobile/schematy-rodzaje';
import { fetchInvoicesForExport } from '@/lib/exports/data-fetcher';
import { generateJpkV7m } from '@/lib/exports/jpk-v7m-generator';
import { validateJpkV7m } from '@/lib/exports/jpk-v7m-validator';
import { generateCorrectionInvoiceXml } from '@/lib/ksef/fa3-correction-generator';
import { finalizeInvoice, type InvoiceInput } from '@/lib/xml/invoice-calculator';
import { validateInvoiceXml } from '@/lib/xml/validator';
import type { CorrectionInvoiceData } from '@/types/invoice-types';

/**
 * Ceny brutto, krok (e), część 2 (decyzja D6 z 25.11.2026): korekta faktury
 * w cenach brutto liczy się tą samą metodą co faktura (art. 106e ust. 7 i 8
 * ustawy o VAT, RP-FA-BRUTTO-01). Stan przed z zapisu pozycji
 * (`invoice_line_items`, `recordedAmounts`), stan po z cenami brutto (`P_9B`,
 * `P_11A`) i podatkiem każdej stawki od sumy brutto stawki,
 * KP = WB × SP / (100 + SP); różnica po stawkach to stan po minus stan przed
 * (art. 106j ust. 2 pkt 5, RP-FA-KOR-01). Korekta kwotowa: nowa suma brutto
 * stawki, podatek od niej ze wzoru, różnica wobec zapisu, nie podatek od samej
 * różnicy brutto. Do części 2 każda korekta takiej faktury odmawiała (#888).
 *
 * Korekta faktury w cenach brutto stoi za tym samym wyłącznikiem co faktura
 * (`grossPricesEnabled`, `docs/runbooks/ceny-brutto-wylacznik.md`): przy
 * wyłączonym zostaje odmowa z #888 (`korekta-ceny-brutto-odmowa.test.ts`).
 *
 * Prawdziwa ścieżka: akcje strony korekty (`getCorrectionParentContextAction`,
 * `saveCorrectionDraftAction`) na bazie w pamięci, koperta z wiersza do
 * generatora FA(3) KOR, XSD MF i strażnik FA(3). Atrapy: sesja, kolejka KSeF,
 * dziennik.
 */

const PARENT = '00000000-0000-4000-8000-000000000001';
const KSEF_RODZICA = '1234567890-20261102-0100001AF601-B1';
const SPRZEDAWCA = { nip: '1234567890', name: 'Firma testowa', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } };
const NABYWCA = { nip: '1234567890', name: 'Klient testowy', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' } };
const WYGENEROWANO = new Date('2026-11-16T10:00:00Z');

type Pozycja = { name: string; quantity: number; unitPriceGross: number; vatRate: '23' | '8' | '5' | '0' };

/** Trzy kawy po 1,00 zł brutto przy 23 %: VAT stawki 0,56 od 3,00 (nie 3 × 0,19), netto 2,44 (#835). */
const TRZY_KAWY: Pozycja[] = [1, 2, 3].map((n) => ({ name: `Kawa ${n}`, quantity: 1, unitPriceGross: 1, vatRate: '23' }));

/** Faktura w cenach brutto tak, jak ją zapisuje FaktWay (`finalizeInvoice`, `draftLineRows`). */
function fakturaFaktWay(pozycje: Pozycja[]) {
  const input: InvoiceInput = {
    internalNumber: 'FV 7/11/2026', type: 'VAT', issueDate: '2026-11-02', seller: SPRZEDAWCA, buyer: NABYWCA,
    pricesGross: true,
    lines: pozycje.map((p, i) => ({ ordinal: i + 1, unit: 'szt.', unitPriceNet: 0, ...p })),
    payment: { currency: 'PLN', dueDate: '2026-11-16', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
  };
  const invoice = finalizeInvoice(input);
  db.tables.invoices!.push({
    id: PARENT, tenant_id: TENANT, direction: 'outgoing', invoice_kind: 'regular', invoice_type: 'VAT', origin: 'app',
    ksef_status: 'accepted', ksef_environment: 'test', ksef_number: KSEF_RODZICA, currency: 'PLN',
    internal_number: 'FV 7/11/2026', issue_date: '2026-11-02',
    net_total: invoice.netTotal, vat_total: invoice.vatTotal, gross_total: invoice.grossTotal,
    seller_data: SPRZEDAWCA, buyer_data: NABYWCA,
    fa3_data: invoice,
  });
  db.tables.invoice_line_items!.push(...invoice.lines.map((l) => ({
    id: `${PARENT}-${l.ordinal}`, invoice_id: PARENT, ordinal: l.ordinal, name: l.name, unit: l.unit, quantity: l.quantity,
    unit_price_net: null, net_amount: l.netAmount, vat_rate: l.vatRate, vat_amount: l.vatAmount, gross_amount: l.grossAmount,
  })));
  return invoice;
}

/** Nowa faktura w cenach brutto z tymi pozycjami: wzorzec D6 dla faktury i jej korekt. */
function nowaFaktura(pozycje: Pozycja[]) {
  return finalizeInvoice({
    internalNumber: 'FV 8/11/2026', type: 'VAT', issueDate: '2026-11-02', seller: SPRZEDAWCA, buyer: NABYWCA, pricesGross: true,
    lines: pozycje.map((p, i) => ({ ordinal: i + 1, unit: 'szt.', unitPriceNet: 0, ...p })),
    payment: { currency: 'PLN', dueDate: '2026-11-16', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
  });
}

/** Faktura z importu KSeF w cenach brutto (`P_9B`, `P_11A`, cena netto pusta), z kwotami pozycji i sum. */
function fakturaZImportu(pozycje: Array<{ net: number; vat: number; gross: number }>, polaPliku: Array<Record<string, number>>) {
  const suma = (k: 'net' | 'vat' | 'gross') => Math.round(pozycje.reduce((s, p) => s + p[k] * 100, 0)) / 100;
  db.tables.invoices!.push({
    id: PARENT, tenant_id: TENANT, direction: 'outgoing', invoice_kind: 'regular', invoice_type: 'VAT', origin: 'ksef_import',
    ksef_status: 'accepted', ksef_environment: 'test', ksef_number: KSEF_RODZICA, currency: 'PLN',
    internal_number: 'FV 7/11/2026', issue_date: '2026-11-02',
    net_total: suma('net'), vat_total: suma('vat'), gross_total: suma('gross'),
    seller_data: SPRZEDAWCA, buyer_data: NABYWCA,
    fa3_data: { internalNumber: 'FV 7/11/2026', import: { source: 'ksef' }, ksefLineFields: polaPliku.map((p, i) => ({ ordinal: i + 1, ...p })) },
  });
  db.tables.invoice_line_items!.push(...pozycje.map((p, i) => ({
    id: `${PARENT}-${i + 1}`, invoice_id: PARENT, ordinal: i + 1, name: `Kawa ${i + 1}`, unit: 'szt.', quantity: 1,
    unit_price_net: null, net_amount: p.net, vat_rate: '23', vat_amount: p.vat, gross_amount: p.gross,
  })));
}

function wlaczCenyBrutto(enabled = true) {
  db.tables.global_feature_flags = [{ flag: 'grossPricesEnabled', enabled }];
}

function payload(o: Record<string, unknown>) {
  return {
    invoiceType: 'correction', internalNumber: 'FK/1/11/2026', issueDate: '2026-11-16', paymentMethod: 'transfer', paymentDueDate: '2026-11-30',
    parentInvoiceId: PARENT, parentInvoiceNumber: 'FV 7/11/2026', parentInvoiceIssueDate: '2026-11-02', parentKsefNumber: KSEF_RODZICA,
    correctionReason: 'Zmiana ceny', typKorekty: '2',
    seller: SPRZEDAWCA, buyer: { type: 'b2b', idType: 'nip', ...NABYWCA },
    ...o,
  } as never;
}

const korekty = () => db.tables.invoices!.filter((r) => r.invoice_kind === 'correction');
const koperta = (row: Row) => (row.special_data as { correctionData: CorrectionInvoiceData }).correctionData;
const plik = (data: CorrectionInvoiceData) => generateCorrectionInvoiceXml(data, { generatedAt: WYGENEROWANO, prettyPrint: false });
const pole = (xml: string, nazwa: string) => [...xml.matchAll(new RegExp(`<${nazwa}>([^<]*)</${nazwa}>`, 'g'))].map((m) => m[1]!);

async function sprawdzPlik(xml: string) {
  const wynik = await validateInvoiceXml(xml);
  expect(wynik.errors).toEqual([]);
  expect(wynik.valid).toBe(true);
  expect(sprawdzFa3(xml)).toEqual([]);
  // Art. 106e ust. 8: cena i wartość brutto zamiast netto, jak faktura korygowana.
  expect(pole(xml, 'P_9A')).toEqual([]);
  expect(pole(xml, 'P_11')).toEqual([]);
}

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
  db.tables = {
    tenants: [{ id: TENANT, nip: '1234567890', name: 'Firma testowa', address_json: SPRZEDAWCA.address }],
    invoices: [],
    invoice_line_items: [],
  };
});

describe('korekta faktury FaktWay w cenach brutto (D6): akcja strony, plik KOR, XSD i strażnik', () => {
  it('kontekst formularza przy włączonym wyłączniku: faktura w cenach brutto, stan przed z zapisu z ceną brutto pozycji', async () => {
    fakturaFaktWay(TRZY_KAWY);
    wlaczCenyBrutto();
    const ctx = await getCorrectionParentContextAction(PARENT);
    expect(ctx).toMatchObject({ success: true, grossTotal: 3, pricesGross: true });
    if (!ctx.success) return;
    expect(ctx.linesBefore.map((l) => [l.name, l.unitPriceGross, l.recordedAmounts])).toEqual([
      ['Kawa 1', 1, { netAmount: 0.81, vatAmount: 0.19, grossAmount: 1 }],
      ['Kawa 2', 1, { netAmount: 0.81, vatAmount: 0.19, grossAmount: 1 }],
      ['Kawa 3', 1, { netAmount: 0.82, vatAmount: 0.18, grossAmount: 1 }],
    ]);
    // Formularz korekty pozycji ma dziś tylko ceny netto: powód z wyjściem zamiast pozycji z ceną 0 zł.
    expect(ctx.beforeAfterRefusal).toMatch(/w cenach brutto/);
    expect(ctx.beforeAfterRefusal).toMatch(/Anuluj fakturę albo wystaw korektę kwotową/);
  });

  it('„przed / po”: Kawa 3 z 1,00 na 1,08 zł, VAT stawki po korekcie 0,58 od 3,08, różnica VAT 0,02 (nie 0,01 od samej różnicy 0,08)', async () => {
    fakturaFaktWay(TRZY_KAWY);
    wlaczCenyBrutto();
    const ctx = await getCorrectionParentContextAction(PARENT);
    expect(ctx.success).toBe(true);
    if (!ctx.success) return;
    const po = ctx.linesAfter.map((l, i) => (i === 2 ? { ...l, unitPriceGross: 1.08 } : l));
    const r = await saveCorrectionDraftAction(payload({ pricesGross: true, correctionType: 'before_after', linesBefore: ctx.linesBefore, linesAfter: po }), TENANT);
    expect(r).toMatchObject({ success: true });

    const [kor] = korekty();
    expect(kor).toMatchObject({ net_total: 0.06, vat_total: 0.02, gross_total: 0.08 });
    const data = koperta(kor!);
    expect(data.pricesGross).toBe(true);
    const xml = plik(data);
    await sprawdzPlik(xml);
    expect([pole(xml, 'P_13_1'), pole(xml, 'P_14_1'), pole(xml, 'P_15')]).toEqual([['0.06'], ['0.02'], ['0.08']]);
    // Tylko zmieniona pozycja: stan przed (StanPrzed) i stan po, z ceną i wartością brutto.
    expect(pole(xml, 'P_7')).toEqual(['Kawa 3', 'Kawa 3']);
    expect(pole(xml, 'P_9B')).toEqual(['1.0000', '1.0800']);
    expect(pole(xml, 'P_11A')).toEqual(['1.00', '1.08']);
    expect(pole(xml, 'StanPrzed')).toEqual(['1']);

    // Dokument korekty: stan po w cenach brutto, jak faktura w cenach brutto (cena netto pusta).
    const pozycje = db.tables.invoice_line_items!.filter((l) => l.invoice_id === kor!.id);
    expect(pozycje.map((l) => [l.unit_price_net, l.gross_amount])).toEqual([[null, 1], [null, 1], [null, 1.08]]);
    expect(pozycje.reduce((s, l) => s + Math.round(Number(l.vat_amount) * 100), 0)).toBe(58);
    expect((kor!.fa3_data as { pricesGross?: unknown }).pricesGross).toBe(true);

    // Niezmiennik D6: faktura + korekta = nowa faktura w cenach brutto z pozycjami po korekcie.
    const nowa = nowaFaktura(TRZY_KAWY.map((p, i) => (i === 2 ? { ...p, unitPriceGross: 1.08 } : p)));
    expect(Math.round((0.56 + Number(kor!.vat_total)) * 100)).toBe(Math.round(nowa.vatTotal * 100));
  });

  it('„przed / po” z pozycją dopisaną i usuniętą w dwóch stawkach: różnica każdej stawki od sum brutto stawek', async () => {
    fakturaFaktWay([
      { name: 'Obiad', quantity: 2, unitPriceGross: 20.99, vatRate: '8' },
      { name: 'Deser', quantity: 1, unitPriceGross: 12.5, vatRate: '8' },
      { name: 'Napój', quantity: 3, unitPriceGross: 5.49, vatRate: '23' },
    ]);
    wlaczCenyBrutto();
    const ctx = await getCorrectionParentContextAction(PARENT);
    expect(ctx.success).toBe(true);
    if (!ctx.success) return;
    // Deser znika, Napój 3 → 4, dochodzi Kawa po 7,99 zł przy 23 %.
    const po = [
      ctx.linesAfter[0]!,
      { ...ctx.linesAfter[2]!, quantity: 4 },
      { name: 'Kawa', unit: 'szt.', quantity: 1, unitPriceNet: 0, unitPriceGross: 7.99, vatRate: '23' as const },
    ];
    const r = await saveCorrectionDraftAction(payload({ pricesGross: true, correctionType: 'before_after', linesBefore: ctx.linesBefore, linesAfter: po }), TENANT);
    expect(r).toMatchObject({ success: true });
    const xml = plik(koperta(korekty()[0]!));
    await sprawdzPlik(xml);
    // 8 %: przed WB 54,48, KP 4,04; po WB 41,98, KP = 41,98 × 8 / 108 = 3,11 → brutto −12,50, VAT −0,93, netto −11,57.
    // 23 %: przed WB 16,47, KP 3,08; po WB 21,96 + 7,99 = 29,95, KP 5,60 → brutto +13,48, VAT +2,52, netto +10,96.
    expect([pole(xml, 'P_13_1'), pole(xml, 'P_14_1'), pole(xml, 'P_13_2'), pole(xml, 'P_14_2'), pole(xml, 'P_15')])
      .toEqual([['10.96'], ['2.52'], ['-11.57'], ['-0.93'], ['0.98']]);
  });

  it('anulowanie: wiersze z ceną brutto i wartością brutto z minusem, różnica to zapis faktury z minusem', async () => {
    fakturaFaktWay(TRZY_KAWY);
    wlaczCenyBrutto();
    const ctx = await getCorrectionParentContextAction(PARENT);
    expect(ctx.success).toBe(true);
    if (!ctx.success) return;
    const r = await saveCorrectionDraftAction(payload({ pricesGross: true, correctionType: 'cancellation', linesBefore: ctx.linesBefore, linesAfter: ctx.linesBefore }), TENANT);
    expect(r).toMatchObject({ success: true });
    const [kor] = korekty();
    expect(kor).toMatchObject({ net_total: -2.44, vat_total: -0.56, gross_total: -3 });
    const xml = plik(koperta(kor!));
    await sprawdzPlik(xml);
    expect([pole(xml, 'P_13_1'), pole(xml, 'P_14_1'), pole(xml, 'P_15')]).toEqual([['-2.44'], ['-0.56'], ['-3.00']]);
    expect(pole(xml, 'P_8B')).toEqual(['-1.0000', '-1.0000', '-1.0000']);
    expect(pole(xml, 'P_9B')).toEqual(['1.0000', '1.0000', '1.0000']);
    expect(pole(xml, 'P_11A')).toEqual(['-1.00', '-1.00', '-1.00']);
  
  });

  it('faktura z importu KSeF w cenach brutto (P_9B): anulowanie z plikiem KOR w cenach brutto', async () => {
    fakturaZImportu([{ net: 0.81, vat: 0.19, gross: 1 }, { net: 0.81, vat: 0.19, gross: 1 }, { net: 0.82, vat: 0.18, gross: 1 }], [{ P_9B: 1 }, { P_9B: 1 }, { P_9B: 1 }]);
    wlaczCenyBrutto();
    const ctx = await getCorrectionParentContextAction(PARENT);
    expect(ctx).toMatchObject({ success: true, pricesGross: true });
    if (!ctx.success) return;
    const r = await saveCorrectionDraftAction(payload({ pricesGross: true, correctionType: 'cancellation', linesBefore: ctx.linesBefore, linesAfter: ctx.linesBefore }), TENANT);
    expect(r).toMatchObject({ success: true });
    const xml = plik(koperta(korekty()[0]!));
    await sprawdzPlik(xml);
    expect([pole(xml, 'P_13_1'), pole(xml, 'P_14_1'), pole(xml, 'P_15')]).toEqual([['-2.44'], ['-0.56'], ['-3.00']]);
  });

  it('korekta kwotowa: nowa suma brutto stawki, VAT od niej, różnica wobec zapisu (nie VAT od samej różnicy 0,08)', async () => {
    fakturaFaktWay(TRZY_KAWY);
    wlaczCenyBrutto();
    // Zmiana brutto +0,08: stawka 3,08, VAT 0,58, różnica VAT 0,02, netto +0,06. Od samej różnicy VAT byłby 0,01.
    const r = await saveCorrectionDraftAction(payload({
      pricesGross: true,
      correctionType: 'amount_change',
      amountChange: { description: 'Dopłata', netDelta: 0.06, vatDelta: 0.02, grossDelta: 0.08 },
    }), TENANT);
    expect(r).toEqual(expect.objectContaining({ success: true }));
    const [kor] = korekty();
    expect(kor).toMatchObject({ net_total: 0.06, vat_total: 0.02, gross_total: 0.08 });
    const data = koperta(kor!);
    expect(data.pricesGross).toBe(true);
    const xml = plik(data);
    await sprawdzPlik(xml);
    expect([pole(xml, 'P_13_1'), pole(xml, 'P_14_1'), pole(xml, 'P_15')]).toEqual([['0.06'], ['0.02'], ['0.08']]);
    expect([pole(xml, 'P_9B'), pole(xml, 'P_11A')]).toEqual([['0.0800'], ['0.08']]);
  });

  it('korekta kwotowa z VAT od samej różnicy brutto: odmowa z kwotami, które przejdą', async () => {
    fakturaFaktWay(TRZY_KAWY);
    wlaczCenyBrutto();
    const r = await saveCorrectionDraftAction(payload({
      pricesGross: true,
      correctionType: 'amount_change',
      amountChange: { description: 'Dopłata', netDelta: 0.07, vatDelta: 0.01, grossDelta: 0.08 },
    }), TENANT);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error).toContain('od nowej sumy brutto stawki');
      expect(r.error).toContain('0,02');
      expect(r.error).toContain('0,06');
    }
    expect(korekty()).toHaveLength(0);
  });

  it('wyłącznik cen brutto wyłączony: korekta faktury w cenach brutto zostaje odmową z #888, nic nie zapisane', async () => {
    fakturaFaktWay(TRZY_KAWY);
    wlaczCenyBrutto(false);
    const ctx = await getCorrectionParentContextAction(PARENT);
    expect(ctx.success).toBe(false);
    if (!ctx.success) expect(ctx.error).toMatch(/w cenach brutto/);
    const r = await saveCorrectionDraftAction(payload({
      pricesGross: true,
      correctionType: 'amount_change',
      amountChange: { description: 'Dopłata', netDelta: 0.06, vatDelta: 0.02, grossDelta: 0.08 },
    }), TENANT);
    expect(r.success).toBe(false);
    expect(korekty()).toHaveLength(0);
  });

  it('znacznik pricesGross i stawka z żądania faktury w cenach netto się nie liczą', async () => {
    // Faktura w cenach netto: z żądania nie powstaje korekta w cenach brutto.
    db.tables.invoices!.push({
      id: PARENT, tenant_id: TENANT, direction: 'outgoing', invoice_kind: 'regular', invoice_type: 'VAT', origin: 'app',
      ksef_status: 'accepted', ksef_environment: 'test', ksef_number: KSEF_RODZICA, currency: 'PLN',
      internal_number: 'FV 7/11/2026', issue_date: '2026-11-02', net_total: 100, vat_total: 23, gross_total: 123,
      seller_data: SPRZEDAWCA, buyer_data: NABYWCA, fa3_data: { internalNumber: 'FV 7/11/2026' },
    });
    db.tables.invoice_line_items!.push({
      id: `${PARENT}-1`, invoice_id: PARENT, ordinal: 1, name: 'Usługa', unit: 'szt.', quantity: 1,
      unit_price_net: 100, net_amount: 100, vat_rate: '23', vat_amount: 23, gross_amount: 123,
    });
    wlaczCenyBrutto();
    const r = await saveCorrectionDraftAction(payload({
      pricesGross: true,
      correctionType: 'amount_change',
      amountChange: { description: 'Rabat', netDelta: -10, vatDelta: -2.3, grossDelta: -12.3, grossRate: '8' },
    }), TENANT);
    expect(r).toMatchObject({ success: true });
    const data = koperta(korekty()[0]!);
    expect(data.pricesGross).toBeUndefined();
    expect(data.amountChange?.grossRate).toBeUndefined();
    const xml = plik(data);
    expect(pole(xml, 'P_9B')).toEqual([]);
    expect(pole(xml, 'P_9A')).toEqual(['-10.0000']);
  });

  it('niezmiennik D6: faktura plus korekta „przed / po” = nowa faktura w cenach brutto, w dwóch stawkach i przy zmianach cen, ilości i dopisaniu', async () => {
    // Deterministyczny przegląd: kilka tysięcy układów zamiast jednego punktu.
    let seed = 20261125;
    const los = (n: number) => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed % n; };
    const stawki = ['23', '8'] as const;
    let zapisane = 0;
    for (let i = 0; i < 120; i++) {
      db.tables = { ...db.tables, invoices: [], invoice_line_items: [] };
      const przed: Pozycja[] = Array.from({ length: 1 + los(4) }, (_, k) => ({
        name: `P${k}`, quantity: 1 + los(3), unitPriceGross: (1 + los(9999)) / 100, vatRate: stawki[los(2)]!,
      }));
      fakturaFaktWay(przed);
      wlaczCenyBrutto();
      const ctx = await getCorrectionParentContextAction(PARENT);
      expect(ctx.success).toBe(true);
      if (!ctx.success) return;
      const po = ctx.linesAfter.map((l) => (los(2) ? { ...l, unitPriceGross: (1 + los(9999)) / 100 } : l));
      if (los(3) === 0) po.push({ name: 'Nowa', unit: 'szt.', quantity: 1 + los(2), unitPriceNet: 0, unitPriceGross: (1 + los(500)) / 100, vatRate: stawki[los(2)]! } as never);
      const r = await saveCorrectionDraftAction(payload({
        pricesGross: true, correctionType: 'before_after', linesBefore: ctx.linesBefore, linesAfter: po,
        internalNumber: `FK/${i}/11/2026`,
      }), TENANT);
      if (!r.success) continue;
      zapisane += 1;
      const [kor] = korekty();
      const nowa = nowaFaktura(po.map((l) => ({ name: l.name, quantity: l.quantity, unitPriceGross: l.unitPriceGross!, vatRate: l.vatRate as Pozycja['vatRate'] })));
      expect(Math.round((Number(db.tables.invoices![0]!.vat_total) + Number(kor!.vat_total)) * 100)).toBe(Math.round(nowa.vatTotal * 100));
      expect(Math.round((Number(db.tables.invoices![0]!.gross_total) + Number(kor!.gross_total)) * 100)).toBe(Math.round(nowa.grossTotal * 100));
    }
    expect(zapisane).toBeGreaterThan(80);
  });
});

describe('stan po korekty faktury w cenach brutto (D6): stawka bez zmian zostaje z zapisu', () => {
  it('faktura z importu z VAT stawki innym niż wzór: korekta ceny w drugiej stawce nie wykazuje różnicy w stawce bez zmian', async () => {
    const { correctionStateAmounts } = await import('@/lib/invoices/calculator');
    const { differenceSummaries } = await import('@/lib/xml/invoice-calculator');
    // Stawka 8 %: 2 × 1,00 zł brutto z zapisem VAT 0,08 + 0,08 (wzór od 2,00 dałby 0,15): pochodzi z innego programu.
    const przed = [
      { name: 'A', unit: 'szt.', quantity: 1, unitPriceNet: 0, unitPriceGross: 1, vatRate: '8' as const, recordedAmounts: { netAmount: 0.92, vatAmount: 0.08, grossAmount: 1 } },
      { name: 'B', unit: 'szt.', quantity: 1, unitPriceNet: 0, unitPriceGross: 1, vatRate: '8' as const, recordedAmounts: { netAmount: 0.92, vatAmount: 0.08, grossAmount: 1 } },
      { name: 'C', unit: 'szt.', quantity: 1, unitPriceNet: 0, unitPriceGross: 1, vatRate: '23' as const, recordedAmounts: { netAmount: 0.81, vatAmount: 0.19, grossAmount: 1 } },
    ];
    const po = przed.map(({ recordedAmounts: _z, ...l }, i) => (i === 2 ? { ...l, unitPriceGross: 1.08 } : l));
    const stany = correctionStateAmounts(przed, po);
    const linia = (l: (typeof przed)[number], a: { netAmount: number; vatAmount: number; grossAmount: number }, ordinal: number) =>
      ({ ordinal, name: l.name, unit: l.unit, quantity: 1, unitPriceNet: 0, vatRate: l.vatRate, ...a });
    const roznica = differenceSummaries(przed.map((l, i) => linia(l, stany.before[i]!, i + 1)), po.map((l, i) => linia(l as never, stany.after[i]!, i + 1)));
    expect(roznica).toEqual([{ rate: '23', netSum: 0.07, vatSum: 0.01 }]);
  });
});

describe('JPK_V7M: korekta faktury w cenach brutto (D6)', () => {
  it('korekta „przed / po” w JPK_V7M: różnica VAT stawki 0,02 i netto 0,06 (z kopert stanów), plik zgodny z XSD', async () => {
    fakturaFaktWay(TRZY_KAWY);
    wlaczCenyBrutto();
    const ctx = await getCorrectionParentContextAction(PARENT);
    expect(ctx.success).toBe(true);
    if (!ctx.success) return;
    const po = ctx.linesAfter.map((l, i) => (i === 2 ? { ...l, unitPriceGross: 1.08 } : l));
    const r = await saveCorrectionDraftAction(payload({ pricesGross: true, correctionType: 'before_after', linesBefore: ctx.linesBefore, linesAfter: po }), TENANT);
    expect(r).toMatchObject({ success: true });
    // Korekta przyjęta w KSeF (eksport czyta tylko przyjęte).
    const kor = korekty()[0]!;
    Object.assign(kor, { ksef_status: 'accepted', ksef_environment: 'test', ksef_number: '1234567890-20261116-0100002AF601-B2' });

    const { issuedInvoices } = await fetchInvoicesForExport({ tenantId: TENANT, periodStart: '2026-11-01', periodEnd: '2026-11-30', direction: 'issued' });
    const xml = generateJpkV7m({
      issuer: { nip: '1234567890', name: 'Firma testowa', email: 'biuro@example.test', taxOfficeCode: '1433' },
      periodStart: '2026-11-01', periodEnd: '2026-11-30', generatedAt: new Date('2026-12-05T10:00:00Z'),
      issuedInvoices, expenses: [], previousSurplus: 0,
    });
    expect((await validateJpkV7m(xml)).errors).toEqual([]);
    const wiersze = [...xml.matchAll(/<SprzedazWiersz>([\s\S]*?)<\/SprzedazWiersz>/g)].map((m) => m[1]!);
    expect(wiersze).toHaveLength(2);
    const k = (w: string, n: string) => pole(w, n);
    // Faktura 0,56 od 3,00; korekta: różnica stanów, VAT 0,02 (nie 0,01 od samej różnicy brutto 0,08).
    expect([k(wiersze[0]!, 'K_19'), k(wiersze[0]!, 'K_20')]).toEqual([['2.44'], ['0.56']]);
    expect([k(wiersze[1]!, 'K_19'), k(wiersze[1]!, 'K_20')]).toEqual([['0.06'], ['0.02']]);
  });
});

describe('korekta faktury w cenach brutto z telefonu (D6)', () => {
  const zTelefonu = (o: Record<string, unknown>) => ({
    internalNumber: 'FK/1/11/2026', numberSeriesId: 'seria', numberPreview: 'FK/1/11/2026', issueDate: '2026-11-16',
    paymentMethod: 'transfer', paymentDueDate: '2026-11-30', bankAccount: '', notes: '', parentInvoiceId: PARENT,
    correctionReason: 'Zmiana ceny', typKorekty: '2', linesAfter: [], ...o,
  }) as never;

  it('korekta kwotowa z telefonu (bez znacznika pricesGross): serwer nadaje go z kontekstu i liczy VAT od sumy brutto stawki', async () => {
    fakturaFaktWay(TRZY_KAWY);
    wlaczCenyBrutto();
    const ctx = await getCorrectionParentContextAction(PARENT);
    expect(ctx.success).toBe(true);
    if (!ctx.success) return;
    const wartosci = korektaDoFormularza(
      zTelefonu({ correctionType: 'amount_change', amountChange: { description: 'Dopłata', netDelta: 0.06, vatDelta: 0.02, grossDelta: 0.08 } }),
      ctx as never, 'klucz-1',
    );
    expect(wartosci.pricesGross).toBe(true);
    // Numeracja z bazy numerów jest poza tym testem (atrapa bazy): numer wpisany jak w `payload`.
    delete wartosci.numberSeriesId; delete wartosci.numberPreview; delete wartosci.numberRequestKey;
    const r = await saveCorrectionDraftAction({ ...wartosci, buyer: { type: 'b2b', idType: 'nip', ...NABYWCA } } as never, TENANT);
    expect(r).toEqual(expect.objectContaining({ success: true }));
    expect(korekty()[0]).toMatchObject({ net_total: 0.06, vat_total: 0.02, gross_total: 0.08 });
  });

  it('faktura w cenach netto: telefon nie dostaje znacznika pricesGross', async () => {
    const wartosci = korektaDoFormularza(
      zTelefonu({ correctionType: 'cancellation', amountChange: null }),
      { internalNumber: 'FV 1', issueDate: '2026-11-02', ksefNumber: KSEF_RODZICA, seller: SPRZEDAWCA, buyer: NABYWCA, linesBefore: [], linesAfter: [] } as never,
      'klucz-2',
    );
    expect('pricesGross' in wartosci).toBe(false);
  });
});
