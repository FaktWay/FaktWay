import fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoryTables, Row } from './helpers/baza-w-pamieci';

const db = vi.hoisted(() => ({ tables: {} as MemoryTables }));
const TENANT = '11111111-1111-4111-8111-111111111111';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: vi.fn(async () => ({ ok: true })) }));
// Fikcyjny NIP 1234567890 (AGENTS.md) nie ma sumy kontrolnej; reszta kalkulatora prawdziwa.
vi.mock('@/lib/xml/invoice-calculator', async (orig) => ({
  ...(await orig<typeof import('@/lib/xml/invoice-calculator')>()),
  validateNipChecksum: () => true,
}));
vi.mock('@/lib/supabase/auth-context', async () => {
  const { memoryClient } = await import('./helpers/baza-w-pamieci');
  return {
    requireUserAndActiveOrg: async () => ({ supabase: memoryClient(db.tables), user: { id: 'uzytkownik' }, tenantId: TENANT, role: 'owner' }),
    ActionAuthError: class ActionAuthError extends Error {},
  };
});

import { getCorrectionParentContextAction, saveCorrectionDraftAction } from '@/components/invoices/correction-actions';
import { generateCorrectionInvoiceXml } from '@/lib/ksef/fa3-correction-generator';
import { GTU_CODES } from '@/lib/invoices/line-codes';
import { calculateLineItem } from '@/lib/xml/invoice-calculator';
import { validateInvoiceXml } from '@/lib/xml/validator';
import type { CorrectionInvoiceData, InvoiceLine } from '@/types/invoice-types';
import type { VatRate } from '@/types/invoice';

/**
 * Kody pozycji w korekcie (plan kompletnej aplikacji, krok 2.6, część 2b-3b):
 * wiersze „stan przed” niosą PKWiU i GTU z dokumentu faktury korygowanej
 * (`fa3_data.lines`), a nie z `invoice_line_items` bez kodów, a wiersze „po”
 * kody swojej pary „przed”, nadane przez serwer (formularz strony i telefon
 * kodów nie edytują; telefon ich nawet nie wysyła). Pozycja dopisana w „po”
 * nie ma kodu. Plik FA(3) KOR: PKWiU po P_7, GTU po P_12, przed StanPrzed.
 *
 * Prawdziwa ścieżka: akcje strony (`getCorrectionParentContextAction`,
 * `saveCorrectionDraftAction`) na bazie w pamięci, koperta z wiersza
 * (`special_data.correctionData`) do generatora FA(3) KOR, XSD MF. Atrapy:
 * sesja, kolejka KSeF, dziennik.
 */

const PARENT = '00000000-0000-4000-8000-000000000001';
const KOR1 = '00000000-0000-4000-8000-000000000101';
/** Numer KSeF faktury korygowanej we wzorze XSD (NIP fikcyjny). */
const KSEF_RODZICA = '1234567890-20261102-0100001AF601-B1';
const SPRZEDAWCA = { nip: '1234567890', name: 'Firma testowa', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } };
const NABYWCA = { nip: '1234567890', name: 'Nabywca testowy', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' } };

interface Poz {
  name: string;
  quantity: number;
  unitPriceNet: number;
  pkwiuCode?: string;
  gtuCode?: string;
}
const DORADZTWO: Poz = { name: 'Doradztwo', quantity: 2, unitPriceNet: 500, pkwiuCode: '69.20.2', gtuCode: 'GTU_12' };
const DOJAZD: Poz = { name: 'Dojazd', quantity: 1, unitPriceNet: 50 };

/** Pozycje dokumentu faktury (`fa3_data.lines`, jak z formularza) i wiersze `invoice_line_items` (bez kodów). */
function faktura(id: string, pozycje: Poz[], o: Row = {}) {
  const lines = pozycje.map((p, i) => ({
    ordinal: i + 1, name: p.name, unit: 'usł.', quantity: p.quantity, unitPriceNet: p.unitPriceNet, vatRate: '23' as VatRate,
    ...calculateLineItem({ quantity: p.quantity, unitPriceNet: p.unitPriceNet, vatRate: '23' }),
    ...(p.pkwiuCode ? { pkwiuCode: p.pkwiuCode } : {}),
    ...(p.gtuCode ? { gtuCode: p.gtuCode } : {}),
  }));
  const net = lines.reduce((s, l) => s + l.netAmount, 0);
  const vat = lines.reduce((s, l) => s + l.vatAmount, 0);
  db.tables.invoices!.push({
    id, tenant_id: TENANT, direction: 'outgoing', invoice_kind: 'regular', invoice_type: 'VAT', origin: 'app',
    ksef_status: 'accepted', ksef_environment: 'test', ksef_number: KSEF_RODZICA, currency: 'PLN',
    internal_number: 'FV 1/11/2026', issue_date: '2026-11-02',
    net_total: net, vat_total: vat, gross_total: Math.round((net + vat) * 100) / 100,
    seller_data: SPRZEDAWCA, buyer_data: NABYWCA,
    fa3_data: { internalNumber: 'FV 1/11/2026', lines },
    ...o,
  });
  db.tables.invoice_line_items!.push(
    ...lines.map((l) => ({
      id: `${id}-${l.ordinal}`, invoice_id: id, ordinal: l.ordinal, name: l.name, unit: l.unit, quantity: l.quantity,
      unit_price_net: l.unitPriceNet, net_amount: l.netAmount, vat_rate: l.vatRate, vat_amount: l.vatAmount, gross_amount: l.grossAmount,
    })),
  );
}

const linia = (p: Poz, o: Partial<InvoiceLine> = {}): InvoiceLine => ({
  name: p.name, unit: 'usł.', quantity: p.quantity, unitPriceNet: p.unitPriceNet, vatRate: '23', ...o,
});

function payload(o: Record<string, unknown>) {
  return {
    invoiceType: 'correction', internalNumber: 'FK/1/11/2026', issueDate: '2026-11-16', paymentMethod: 'transfer', paymentDueDate: '2026-11-30',
    parentInvoiceId: PARENT, parentInvoiceNumber: 'FV 1/11/2026', parentInvoiceIssueDate: '2026-11-02', parentKsefNumber: KSEF_RODZICA,
    correctionReason: 'Zmiana ceny', typKorekty: '2',
    seller: SPRZEDAWCA, buyer: { type: 'b2b', idType: 'nip', ...NABYWCA },
    ...o,
  } as never;
}

function pustaBaza() {
  db.tables = { tenants: [{ id: TENANT, nip: '1234567890', name: 'Firma testowa', address_json: null }], invoices: [], invoice_line_items: [] };
}

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
  pustaBaza();
});

const zapisana = () => db.tables.invoices!.find((r) => r.invoice_kind === 'correction')!;
const koperta = () => (zapisana().special_data as { correctionData: CorrectionInvoiceData }).correctionData;
const kodyWierszy = (xml: string) =>
  (xml.match(/<FaWiersz>[\s\S]*?<\/FaWiersz>/g) ?? []).map((w) => ({
    nazwa: /<P_7>([^<]*)<\/P_7>/.exec(w)?.[1],
    pkwiu: /<PKWiU>([^<]*)<\/PKWiU>/.exec(w)?.[1] ?? null,
    gtu: /<GTU>([^<]*)<\/GTU>/.exec(w)?.[1] ?? null,
    przed: w.includes('<StanPrzed>1</StanPrzed>'),
  }));

describe('korekta: kody pozycji z dokumentu faktury korygowanej', () => {
  it('formularz (strona i telefon) dostaje „stan przed” z PKWiU i GTU pozycji faktury, pozycja bez kodów bez kodów', async () => {
    faktura(PARENT, [DORADZTWO, DOJAZD]);
    const ctx = await getCorrectionParentContextAction(PARENT);
    expect(ctx.success).toBe(true);
    if (!ctx.success) return;
    expect(ctx.linesBefore).toEqual([linia(DORADZTWO, { pkwiuCode: '69.20.2', gtuCode: 'GTU_12' }), linia(DOJAZD)]);
    expect(ctx.linesAfter).toEqual(ctx.linesBefore);
  });

  it('korekta „przed/po” z telefonu (pozycje „po” bez kodów): serwer nadaje kody pary „przed”; plik: PKWiU i GTU w obu wierszach, pozycja bez zmian poza plikiem; XSD', async () => {
    faktura(PARENT, [DORADZTWO, DOJAZD]);
    const ctx = await getCorrectionParentContextAction(PARENT);
    if (!ctx.success) throw new Error(ctx.error);
    const r = await saveCorrectionDraftAction(
      payload({ correctionType: 'before_after', linesBefore: ctx.linesBefore, linesAfter: [linia(DORADZTWO, { unitPriceNet: 450 }), linia(DOJAZD)] }),
      TENANT,
    );
    expect(r).toMatchObject({ success: true });

    const k = koperta();
    expect(k.linesAfter).toEqual([linia(DORADZTWO, { unitPriceNet: 450, pkwiuCode: '69.20.2', gtuCode: 'GTU_12' }), linia(DOJAZD)]);
    // Dokument korekty (`fa3_data`, stan po): kody zostają dla kolejnej korekty i dla JPK.
    expect((zapisana().fa3_data as { lines: Row[] }).lines[0]).toMatchObject({ pkwiuCode: '69.20.2', gtuCode: 'GTU_12' });

    const xml = generateCorrectionInvoiceXml(k, { generatedAt: new Date('2026-11-16T10:00:00Z') });
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
    expect(kodyWierszy(xml)).toEqual([
      { nazwa: 'Doradztwo', pkwiu: '69.20.2', gtu: 'GTU_12', przed: true },
      { nazwa: 'Doradztwo', pkwiu: '69.20.2', gtu: 'GTU_12', przed: false },
    ]);
    expect(xml).toMatch(/<P_12>23<\/P_12>\s*<GTU>GTU_12<\/GTU>\s*<StanPrzed>1<\/StanPrzed>/);
  });

  it('kody z żądania (spreparowane) się nie liczą: para dostaje kody z faktury, dopisana pozycja bez kodu', async () => {
    faktura(PARENT, [DORADZTWO, DOJAZD]);
    const ctx = await getCorrectionParentContextAction(PARENT);
    if (!ctx.success) throw new Error(ctx.error);
    const r = await saveCorrectionDraftAction(
      payload({
        correctionType: 'before_after',
        linesBefore: ctx.linesBefore,
        linesAfter: [
          linia(DORADZTWO, { unitPriceNet: 450, pkwiuCode: '62.01.11.0', gtuCode: 'GTU_13' }),
          linia(DOJAZD, { gtuCode: 'GTU_01' }),
          linia({ name: 'Szkolenie', quantity: 1, unitPriceNet: 100 }, { pkwiuCode: '85.59.13.0', gtuCode: 'GTU_12' }),
        ],
      }),
      TENANT,
    );
    expect(r).toMatchObject({ success: true });
    expect(koperta().linesAfter).toEqual([
      linia(DORADZTWO, { unitPriceNet: 450, pkwiuCode: '69.20.2', gtuCode: 'GTU_12' }),
      linia(DOJAZD),
      linia({ name: 'Szkolenie', quantity: 1, unitPriceNet: 100 }),
    ]);
  });

  it('zmiana nazwy pozycji (para po kolejności): wiersz „przed” z kodami, „po” bez kodów, bo FaktWay nie wie, czy to ta sama pozycja; XSD', async () => {
    faktura(PARENT, [DORADZTWO, DOJAZD]);
    const ctx = await getCorrectionParentContextAction(PARENT);
    if (!ctx.success) throw new Error(ctx.error);
    const r = await saveCorrectionDraftAction(
      payload({ correctionType: 'before_after', linesBefore: ctx.linesBefore, linesAfter: [linia({ ...DORADZTWO, name: 'Doradztwo podatkowe' }), linia(DOJAZD)] }),
      TENANT,
    );
    expect(r).toMatchObject({ success: true });
    expect(koperta().linesAfter).toEqual([linia({ ...DORADZTWO, name: 'Doradztwo podatkowe' }), linia(DOJAZD)]);
    const xml = generateCorrectionInvoiceXml(koperta(), { generatedAt: new Date('2026-11-16T10:00:00Z') });
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
    expect(kodyWierszy(xml)).toEqual([
      { nazwa: 'Doradztwo', pkwiu: '69.20.2', gtu: 'GTU_12', przed: true },
      { nazwa: 'Doradztwo podatkowe', pkwiu: null, gtu: null, przed: false },
    ]);
  });

  it('anulowanie: wiersze ujemne z PKWiU i GTU pozycji faktury; XSD', async () => {
    faktura(PARENT, [DORADZTWO, DOJAZD]);
    const ctx = await getCorrectionParentContextAction(PARENT);
    if (!ctx.success) throw new Error(ctx.error);
    const r = await saveCorrectionDraftAction(payload({ correctionType: 'cancellation', linesBefore: ctx.linesBefore, linesAfter: ctx.linesAfter }), TENANT);
    expect(r).toMatchObject({ success: true });
    const xml = generateCorrectionInvoiceXml(koperta(), { generatedAt: new Date('2026-11-16T10:00:00Z') });
    expect((await validateInvoiceXml(xml)).errors).toEqual([]);
    expect(kodyWierszy(xml)).toEqual([
      { nazwa: 'Doradztwo', pkwiu: '69.20.2', gtu: 'GTU_12', przed: false },
      { nazwa: 'Dojazd', pkwiu: null, gtu: null, przed: false },
    ]);
    expect((zapisana().fa3_data as { lines: Row[] }).lines[0]).toMatchObject({ quantity: -2, pkwiuCode: '69.20.2', gtuCode: 'GTU_12' });
  });

  it('łańcuch: po przyjętej korekcie „przed/po” stan przed (jej stan po) niesie kody z jej dokumentu', async () => {
    faktura(PARENT, [DORADZTWO, DOJAZD]);
    // KOR1 „2 → 1” Doradztwa, przyjęta; jej dokument (stan po) z kodami, jak zapisuje go ta zmiana.
    const po = [{ ...DORADZTWO, quantity: 1 }, DOJAZD];
    const kor1Lines = po.map((p, i) => ({
      ordinal: i + 1, name: p.name, unit: 'usł.', quantity: p.quantity, unitPriceNet: p.unitPriceNet, vatRate: '23' as VatRate,
      ...calculateLineItem({ quantity: p.quantity, unitPriceNet: p.unitPriceNet, vatRate: '23' }),
      ...(p.pkwiuCode ? { pkwiuCode: p.pkwiuCode } : {}),
      ...(p.gtuCode ? { gtuCode: p.gtuCode } : {}),
    }));
    db.tables.invoices!.push({
      id: KOR1, tenant_id: TENANT, direction: 'outgoing', invoice_kind: 'correction', parent_invoice_id: PARENT, internal_number: 'FK/0/11/2026',
      correction_type: 'before_after', ksef_status: 'accepted', ksef_accepted_at: '2026-11-10T10:00:00Z', created_at: '2026-11-10T09:00:00Z',
      net_total: -500, vat_total: -115, gross_total: -615, fa3_data: { lines: kor1Lines },
    });
    db.tables.invoice_line_items!.push(...kor1Lines.map((l) => ({
      id: `${KOR1}-${l.ordinal}`, invoice_id: KOR1, ordinal: l.ordinal, name: l.name, unit: l.unit, quantity: l.quantity,
      unit_price_net: l.unitPriceNet, net_amount: l.netAmount, vat_rate: l.vatRate, vat_amount: l.vatAmount, gross_amount: l.grossAmount,
    })));
    const ctx = await getCorrectionParentContextAction(PARENT);
    if (!ctx.success) throw new Error(ctx.error);
    expect(ctx.previousCorrection).toEqual({ internalNumber: 'FK/0/11/2026', correctionType: 'before_after' });
    expect(ctx.linesBefore).toEqual([linia({ ...DORADZTWO, quantity: 1 }, { pkwiuCode: '69.20.2', gtuCode: 'GTU_12' }), linia(DOJAZD)]);
  });
});

describe('niezmiennik: kody wierszy korekty „przed/po”', () => {
  // Kody „przed” z listy, kody klienta w „po” spoza niej: nie mogą się pojawić w pliku.
  const pozycjaArb = fc.record({
    cena: fc.integer({ min: 1, max: 9_999 }),
    pkwiu: fc.option(fc.constantFrom('62.01.11.0', '69.20.2', '85591300'), { nil: undefined }),
    gtu: fc.option(fc.constantFrom(...GTU_CODES.slice(1, 12)), { nil: undefined }),
    // Co klient robi z pozycją w „po”: bez zmian, nowa cena, usunięcie.
    zmiana: fc.constantFrom('bez zmian', 'cena', 'usuń'),
  });

  it('wiersz „przed” ma kody swojej pozycji, wiersz „po” zaraz za nim kody pary, dopisany „po” żadnych; kody klienta się nie liczą; pozycja bez zmian poza plikiem; XSD', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(pozycjaArb, { minLength: 1, maxLength: 4 }), fc.boolean(), async (opisy, dopisz) => {
        const pozycje = opisy.map((o, i): Poz => ({
          name: `Pozycja ${i + 1}`, quantity: 1, unitPriceNet: o.cena,
          ...(o.pkwiu ? { pkwiuCode: o.pkwiu } : {}), ...(o.gtu ? { gtuCode: o.gtu } : {}),
        }));
        // Klient (strona albo żądanie spreparowane) przysyła w „po” kody spoza faktury.
        const afterKlienta: InvoiceLine[] = opisy.flatMap((o, i) =>
          o.zmiana === 'usuń' ? [] : [linia(pozycje[i]!, { pkwiuCode: '99.99', gtuCode: 'GTU_13', ...(o.zmiana === 'cena' ? { unitPriceNet: o.cena + 1 } : {}) })],
        );
        if (dopisz) afterKlienta.push(linia({ name: 'Nowa pozycja', quantity: 1, unitPriceNet: 10 }, { pkwiuCode: '99.99', gtuCode: 'GTU_01' }));
        // Korekta bez zmiany albo bez żadnej pozycji „po” to odmowa schematu, nie ten niezmiennik.
        if (afterKlienta.length === 0 || (!opisy.some((o) => o.zmiana !== 'bez zmian') && !dopisz)) return;

        // Prawdziwa ścieżka: faktura w bazie, kontekst formularza, zapis korekty, plik z koperty.
        pustaBaza();
        faktura(PARENT, pozycje);
        const ctx = await getCorrectionParentContextAction(PARENT);
        if (!ctx.success) throw new Error(ctx.error);
        const r = await saveCorrectionDraftAction(
          payload({ correctionType: 'before_after', linesBefore: ctx.linesBefore, linesAfter: afterKlienta }),
          TENANT,
        );
        expect(r).toMatchObject({ success: true });
        const xml = generateCorrectionInvoiceXml(koperta(), { generatedAt: new Date('2026-11-16T10:00:00Z') });
        const wiersze = kodyWierszy(xml);

        const kodyPozycji = new Map(opisy.map((o, i) => [`Pozycja ${i + 1}`, { pkwiu: o.pkwiu ?? null, gtu: o.gtu ?? null }]));
        // Wiersze „przed” tylko dla pozycji zmienionych albo usuniętych, w kolejności faktury.
        expect(wiersze.filter((w) => w.przed).map((w) => w.nazwa)).toEqual(
          opisy.flatMap((o, i) => (o.zmiana === 'bez zmian' ? [] : [`Pozycja ${i + 1}`])),
        );
        wiersze.forEach((w, i) => {
          if (w.przed) {
            expect({ pkwiu: w.pkwiu, gtu: w.gtu }).toEqual(kodyPozycji.get(w.nazwa!));
            return;
          }
          const para = wiersze[i - 1];
          // „Po” zaraz za „przed” o tej samej nazwie to jego para (ta sama pozycja po korekcie): te same
          // kody. Inny „po” (dopisany albo sparowany po kolejności ze zmienioną nazwą) bez kodów.
          if (para?.przed && para.nazwa === w.nazwa) expect({ pkwiu: w.pkwiu, gtu: w.gtu }).toEqual({ pkwiu: para.pkwiu, gtu: para.gtu });
          else expect({ pkwiu: w.pkwiu, gtu: w.gtu }).toEqual({ pkwiu: null, gtu: null });
        });
        expect(xml).not.toContain('99.99');
        expect(xml).not.toContain('GTU_13');
        expect(xml).not.toContain('GTU_01');
        expect((await validateInvoiceXml(xml)).errors).toEqual([]);
      }),
      { numRuns: 40 },
    );
  });
});
