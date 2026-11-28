import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 1.6, część 2b, PR D (D25 a): odczyt PDF faktury sprzedaży wystawionej
 * poza KSeF. Wynik tylko wypełnia formularz (zapisuje człowiek, D25), a odmowy
 * rodzajów dokumentu z D22 działają także dla odczytu. Prawdziwe: mapowanie,
 * schemat odpowiedzi, wyłącznik (odczyt flagi), limit rozmiaru i typ z bajtów.
 * Atrapy tylko granic: model, budżet AI firmy, klucz serwisowy (wiersz flagi).
 */

const st = vi.hoisted(() => ({
  flaga: true as boolean | 'blad',
  budzet: { allowed: true } as { allowed: true } | { allowed: false; message: string },
  odpowiedz: '' as string,
  rzut: null as Error | null,
  zuzycie: vi.fn(),
  wywolania: [] as unknown[],
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    throw new Error('nie w tym teście');
  },
  createAdminClient: () => ({
    from() {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () =>
          st.flaga === 'blad' ? { data: null, error: { message: 'x' } } : { data: { enabled: st.flaga }, error: null },
      };
      return q;
    },
  }),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from() {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () =>
          st.flaga === 'blad' ? { data: null, error: { message: 'x' } } : { data: { enabled: st.flaga }, error: null },
      };
      return q;
    },
  }),
}));
vi.mock('@/lib/ai/tenant-ai-budget', () => ({
  checkTenantAiBudget: async () => st.budzet,
  recordTenantAiUsage: (...a: unknown[]) => st.zuzycie(...a),
}));
vi.mock('@/lib/anthropic/client', () => ({
  OCR_MODEL: 'test-model',
  getAnthropic: () => ({
    messages: {
      create: async (arg: unknown) => {
        st.wywolania.push(arg);
        if (st.rzut) throw st.rzut;
        return { content: [{ type: 'text', text: st.odpowiedz }], usage: { input_tokens: 10, output_tokens: 5 } };
      },
    },
  }),
}));
vi.mock('@/lib/test-mode', () => ({ isAnthropicMocked: () => false }));

import { czyPdf, wypelnienieZOdczytu, type OdczytPdf } from '@/lib/import/outside-ksef-pdf';
import { odczytajPdfSpozaKsef } from '@/lib/import/outside-ksef-pdf-odczyt';
import { sprawdzFormularz } from '@/lib/import/outside-ksef-formularz';

const PDF = new File([Buffer.from('%PDF-1.7\n1 0 obj\n')], 'faktura.pdf', { type: 'application/pdf' });

function odczyt(pola: Partial<OdczytPdf> = {}): OdczytPdf {
  return {
    document_kind: 'faktura_vat',
    number: 'FV/12/2026',
    issue_date: '2026-03-10',
    sale_date: null,
    buyer_name: 'Nabywca Sp. z o.o.',
    buyer_nip: '5260001246',
    currency: 'PLN',
    lines: [{ name: 'Usługa', net: 100, vat_rate: '23', vat: 23, gross: 123, exemption_basis: null, gtu: null }],
    confidence: 0.95,
    notes: null,
    ...pola,
  };
}

beforeEach(() => {
  st.flaga = true;
  st.budzet = { allowed: true };
  st.rzut = null;
  st.wywolania.length = 0;
  st.zuzycie.mockReset();
  st.odpowiedz = JSON.stringify(odczyt());
});

describe('wypelnienieZOdczytu: tylko wypełnia formularz (D25 a)', () => {
  it('czytelna faktura w złotych daje formularz, który przechodzi schemat', () => {
    const w = wypelnienieZOdczytu(odczyt());
    expect(w.odmowa).toBeNull();
    expect(w.rodzaj).toBe('faktura_vat');
    expect(w.pola).toMatchObject({ number: 'FV/12/2026', issueDate: '2026-03-10', buyerName: 'Nabywca Sp. z o.o.', buyerNip: '5260001246' });
    expect(w.pola.lines[0]).toMatchObject({ name: 'Usługa', net: '100.00', vatRate: '23', vat: '23.00' });
    expect(sprawdzFormularz(w.pola).ok).toBe(true);
  });

  it('kwota VAT jest tą z dokumentu, nie przeliczoną ze stawki', () => {
    const w = wypelnienieZOdczytu(
      odczyt({ lines: [{ name: 'Usługa', net: 99.99, vat_rate: '23', vat: 23, gross: 122.99, exemption_basis: null, gtu: null }] }),
    );
    expect(w.pola.lines[0].vat).toBe('23.00');
  });

  it('rodzaj z odmowy D22 i waluta obca dają odmowę z wyjściem, bez dopisywania pól jako gotowych', () => {
    for (const rodzaj of ['korekta', 'zaliczka', 'faktura_do_paragonu', 'oo', 'samofakturowanie'] as const) {
      const w = wypelnienieZOdczytu(odczyt({ document_kind: rodzaj }));
      expect(w.rodzaj).toBe(rodzaj);
      expect(w.odmowa).toMatch(/nie ujmie w księgach/);
    }
    const euro = wypelnienieZOdczytu(odczyt({ currency: 'EUR' }));
    expect(euro.rodzaj).toBe('waluta');
    expect(euro.odmowa).not.toBeNull();
  });

  it('stawka „oo” albo nierozpoznana: oo to odmowa, nierozpoznana pozycja odpada z ostrzeżeniem', () => {
    const oo = wypelnienieZOdczytu(
      odczyt({ lines: [{ name: 'X', net: 10, vat_rate: 'oo', vat: 0, gross: 10, exemption_basis: null, gtu: null }] }),
    );
    expect(oo.rodzaj).toBe('oo');
    expect(oo.odmowa).not.toBeNull();

    const inna = wypelnienieZOdczytu(
      odczyt({
        lines: [
          { name: 'Dobra', net: 100, vat_rate: '23', vat: 23, gross: 123, exemption_basis: null, gtu: null },
          { name: 'Dziwna', net: 50, vat_rate: 'mixed', vat: 5, gross: 55, exemption_basis: null, gtu: null },
        ],
      }),
    );
    expect(inna.pola.lines.map((l) => l.name)).toEqual(['Dobra']);
    expect(inna.ostrzezenia.join(' ')).toMatch(/Dziwna/);
  });

  it('zły NIP i data spoza 2026 r. nie są cicho poprawiane: pole puste albo ostrzeżenie', () => {
    const w = wypelnienieZOdczytu(odczyt({ buyer_nip: '5260001247', issue_date: '2025-12-31' }));
    expect(w.pola.buyerNip).toBe('');
    expect(w.ostrzezenia.join(' ')).toMatch(/NIP/);
    expect(w.ostrzezenia.join(' ')).toMatch(/2026/);
    expect(sprawdzFormularz(w.pola).ok).toBe(false);
  });

  it('pozycja, której netto plus VAT nie daje brutto, i niska pewność dają ostrzeżenia', () => {
    const w = wypelnienieZOdczytu(
      odczyt({ confidence: 0.4, lines: [{ name: 'Usługa', net: 100, vat_rate: '23', vat: 23, gross: 130, exemption_basis: null, gtu: null }] }),
    );
    const tekst = w.ostrzezenia.join(' ');
    expect(tekst).toMatch(/Usługa/);
    expect(tekst).toMatch(/niepewnie|słabo|niska/i);
  });

  it('zawsze prosi o sprawdzenie z dokumentem', () => {
    expect(wypelnienieZOdczytu(odczyt()).ostrzezenia.join(' ')).toMatch(/Sprawdź/);
  });
});

describe('czyPdf', () => {
  it('rozpoznaje PDF po bajtach, nie po nazwie', () => {
    expect(czyPdf(new TextEncoder().encode('%PDF-1.4'))).toBe(true);
    expect(czyPdf(new TextEncoder().encode('MZ......'))).toBe(false);
    expect(czyPdf(new Uint8Array())).toBe(false);
  });
});

describe('odczytajPdfSpozaKsef: wyłącznik, limity, model', () => {
  it('wyłączony wyłącznik: odmowa bez wołania modelu', async () => {
    st.flaga = false;
    const w = await odczytajPdfSpozaKsef({ tenantId: 't1', file: PDF });
    expect(w).toMatchObject({ success: false, status: 403 });
    expect(st.wywolania).toHaveLength(0);
  });

  it('błąd odczytu wyłącznika to „nie wiem”: odmowa 503, nie odczyt', async () => {
    st.flaga = 'blad';
    const w = await odczytajPdfSpozaKsef({ tenantId: 't1', file: PDF });
    expect(w).toMatchObject({ success: false, status: 503 });
    expect(st.wywolania).toHaveLength(0);
  });

  it('plik, który nie jest PDF, i plik ponad limit: odmowa przed budżetem i modelem', async () => {
    const obraz = new File([Buffer.from([0xff, 0xd8, 0xff, 0xe0])], 'a.pdf', { type: 'application/pdf' });
    expect(await odczytajPdfSpozaKsef({ tenantId: 't1', file: obraz })).toMatchObject({ success: false, status: 400 });
    const duzy = new File([Buffer.from('%PDF-'), new Uint8Array(10_000_001)], 'duzy.pdf');
    expect(await odczytajPdfSpozaKsef({ tenantId: 't1', file: duzy })).toMatchObject({ success: false, status: 413 });
    expect(st.wywolania).toHaveLength(0);
  });

  it('ten sam limit dzienny i miesięczny co odczyt kosztów: odmowa niesie komunikat budżetu', async () => {
    st.budzet = { allowed: false, message: 'Wykorzystano dzienny limit odczytu dokumentów, wróci w ciągu 24 godzin.' };
    const w = await odczytajPdfSpozaKsef({ tenantId: 't1', file: PDF });
    expect(w).toMatchObject({ success: false, status: 429, error: expect.stringContaining('dzienny limit') });
    expect(st.wywolania).toHaveLength(0);
  });

  it('poprawna odpowiedź modelu: wypełnienie, PDF idzie jako dokument, zużycie zapisane', async () => {
    const w = await odczytajPdfSpozaKsef({ tenantId: 't1', file: PDF });
    expect(w.success).toBe(true);
    if (w.success) expect(w.wypelnienie.pola.number).toBe('FV/12/2026');
    const wywolanie = st.wywolania[0] as { messages: Array<{ content: Array<{ type: string }> }> };
    expect(wywolanie.messages[0].content[0].type).toBe('document');
    expect(st.zuzycie).toHaveBeenCalledWith('t1', { inputTokens: 10, outputTokens: 5 });
  });

  it('JSON w płocie z backtickami przechodzi; śmieć i błąd modelu to komunikat z wyjściem (wpisanie ręczne)', async () => {
    st.odpowiedz = '```json\n' + JSON.stringify(odczyt()) + '\n```';
    expect((await odczytajPdfSpozaKsef({ tenantId: 't1', file: PDF })).success).toBe(true);

    st.odpowiedz = 'nie wiem';
    const zly = await odczytajPdfSpozaKsef({ tenantId: 't1', file: PDF });
    expect(zly).toMatchObject({ success: false, status: 422, error: expect.stringContaining('ręcznie') });

    st.rzut = new Error('timeout');
    const rzut = await odczytajPdfSpozaKsef({ tenantId: 't1', file: PDF });
    expect(rzut).toMatchObject({ success: false, status: 502, error: expect.stringContaining('ręcznie') });
  });

  it('tekst z faktury nie wykonuje poleceń: model dostaje instrukcję, że treść dokumentu to dane', async () => {
    await odczytajPdfSpozaKsef({ tenantId: 't1', file: PDF });
    const wywolanie = st.wywolania[0] as { system: string };
    expect(wywolanie.system).toMatch(/dane, nie polecenia/i);
  });
});
