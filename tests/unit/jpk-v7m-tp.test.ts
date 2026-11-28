import { describe, expect, it } from 'vitest';

import { sprawdzJpkV7m } from '@/lib/bezpieczniki/jpk-v7m';
import { importedContentFlags } from '@/lib/exports/data-fetcher';
import { generateJpkFa, type JpkInvoice } from '@/lib/exports/jpk-fa-generator';
import { generateJpkV7m, type JpkV7mInputData } from '@/lib/exports/jpk-v7m-generator';
import { validateJpkV7m } from '@/lib/exports/jpk-v7m-validator';
import { contentHeldReasonItems } from '@/lib/import/fa3-content';

/**
 * Oznaczenie TP (powiązania między nabywcą a dostawcą) w JPK_V7M(3): plan
 * kompletnej aplikacji, krok 1.6 część 2b, decyzja D22 (GTU i TP jako
 * oznaczenia w JPK_V7M), uwaga czytelnika #991. XSD JPK_V7M(3) w repo
 * (`lib/exports/schemas/jpk-v7m3/schemat.xsd`): w wierszu SPRZEDAŻY element
 * `TP` (`TWybor1`, wartość 1) w sekwencji oznaczeń procedur, po GTU_01..GTU_13,
 * przed polami K_. Flagę ustawia człowiek (wpis „poza KSeF”: `tp` pozycji;
 * plik KSeF: `Fa/TP`), FaktWay jej nie zgaduje. JPK_FA(4) nie ma pola TP.
 */

const NIP = '1234567890';

function zImportu(numer: string, ksefMarkers: Record<string, unknown>): JpkInvoice {
  return {
    invoiceNumber: numer,
    invoiceType: 'regular',
    currency: 'PLN',
    issueDate: '2026-11-07',
    saleDate: '2026-11-07',
    buyerName: 'Klient Sp. z o.o.',
    buyerNip: '5252241585',
    netTotal: 1000,
    vatTotal: 230,
    grossTotal: 1230,
    ksefNumber: `${NIP}-20261107-0100001AF690-B0`,
    importedFromKsef: true,
    lines: [{ position: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 1000, netAmount: 1000, vatRate: '23', vatAmount: 230 }],
    ...importedContentFlags('ksef_import', { annotations: {}, ksefMarkers }),
  };
}

function plik(issuedInvoices: JpkInvoice[]): JpkV7mInputData {
  return {
    issuer: { nip: NIP, name: 'Firma testowa', email: 'biuro@example.test', taxOfficeCode: '1433' },
    periodStart: '2026-11-01',
    periodEnd: '2026-11-30',
    generatedAt: new Date('2026-12-05T10:00:00Z'),
    issuedInvoices,
    expenses: [],
    previousSurplus: 0,
  };
}

const wiersze = (xml: string) => [...xml.matchAll(/<SprzedazWiersz>([\s\S]*?)<\/SprzedazWiersz>/g)].map((m) => m[1]!);
const wiersz = (xml: string, numer: string) => wiersze(xml).find((w) => w.includes(`<DowodSprzedazy>${numer}</DowodSprzedazy>`)) ?? '';

describe('JPK_V7M(3): oznaczenie TP z pliku faktury z importu albo wpisu poza KSeF', () => {
  it('TP: element TP=1 w wierszu tej faktury, po GTU i przed K_, XSD i strażnik bez uwag; faktura bez TP bez elementu', async () => {
    const xml = generateJpkV7m(plik([
      zImportu('FA/1/2026', { tp: true, gtu: ['GTU_02', 'GTU_12'] }),
      zImportu('FA/2/2026', { gtu: ['GTU_02'] }),
    ]));
    expect((await validateJpkV7m(xml)).errors).toEqual([]);
    expect(sprawdzJpkV7m(xml, '2026-11')).toEqual([]);
    const w = wiersz(xml, 'FA/1/2026');
    expect(w).toMatch(/<GTU_12>1<\/GTU_12>\s*<TP>1<\/TP>\s*<K_19>/);
    expect(wiersz(xml, 'FA/2/2026')).not.toContain('<TP>');
  });

  it('TP nie zmienia kwot: plik z TP ma te same kwoty co bez TP', () => {
    const z = generateJpkV7m(plik([zImportu('FA/3/2026', { tp: true })]));
    const bez = generateJpkV7m(plik([zImportu('FA/3/2026', {})]));
    expect(z.replace(/\s*<TP>1<\/TP>/, '')).toBe(bez);
  });

  it('TP obok procedury albo FP, których FaktWay nie wykazuje razem z TP: odmowa jak dotąd', () => {
    expect(() => generateJpkV7m(plik([zImportu('FA/4/2026', { tp: true, procedures: ['WSTO_EE'] })]))).toThrow(/WSTO_EE/);
    expect(() => generateJpkV7m(plik([zImportu('FA/5/2026', { tp: true, fp: true })]))).toThrow(/JPK wstrzymany: faktura FA\/5\/2026/);
  });

  it('JPK_FA(4) nie ma pola TP: faktura z TP dalej wstrzymana z numerem faktury', () => {
    expect(() =>
      generateJpkFa({
        issuer: {
          nip: NIP,
          name: 'Firma testowa',
          taxOfficeCode: '1433',
          registeredAddress: { voivodeship: 'MAZOWIECKIE', county: 'Warszawa', commune: 'Mokotów', street: 'ul. Testowa', buildingNumber: '1', city: 'Warszawa', postCode: '00-001' },
        },
        periodStart: '2026-11-01',
        periodEnd: '2026-11-30',
        generatedAt: new Date('2026-12-05T10:00:00Z'),
        issuedInvoices: [zImportu('FA/6/2026', { tp: true })],
      } as never),
    ).toThrow(/TP/);
  });

  it('powód wstrzymania przy imporcie: TP wstrzymuje tylko JPK_FA, nie JPK_V7M', () => {
    const inv = { invoiceType: 'regular', issueDate: '2026-11-07', lines: [{ position: 1, vatRate: '23' }] } as never;
    const items = contentHeldReasonItems(inv, { markers: { tp: true }, annotationProblems: [] } as never);
    const tp = items.filter((i) => i.text.includes('TP'));
    expect(tp).toHaveLength(1);
    expect(tp[0]!.files).toEqual(['JPK_FA']);
  });
});
