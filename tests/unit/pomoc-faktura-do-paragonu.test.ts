import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { getAllHelpArticles } from '@/lib/help/articles';

/**
 * Decyzja D46: artykuł pomocy o fakturze do paragonu (FP) opisuje granice FP
 * zgodnie z kodem: odmowa JPK_V7M przy paragonie z miesiąca pliku
 * (`JpkV7mReceiptSaleInPeriodError`), brak sum przychodu w okresie z FP
 * (`ReceiptInvoiceRevenueError`), pokrycie raportem z kasy. Treść o podatkach:
 * tylko fakty z przepisów, bez porady.
 */

const SLUG = 'faktura-do-paragonu';
const ARTYKUL = readFileSync(join(__dirname, '..', '..', 'content', 'help', `${SLUG}.mdx`), 'utf8');

describe('artykuł „Faktura do paragonu”', () => {
  it('jest na liście artykułów pomocy', () => {
    expect(getAllHelpArticles().some((a) => a.slug === SLUG)).toBe(true);
  });

  it('mówi, że to informacja ogólna, nie porada podatkowa', () => {
    expect(ARTYKUL).toContain('nie porada podatkowa');
  });

  it('opisuje odmowę JPK_V7M przy paragonie z miesiąca pliku i pokrycie raportem z kasy', () => {
    for (const fragment of ['JPK_V7M', 'z miesiąca, którego dotyczy plik', 'plik nie powstaje', 'raportem z kasy', 'raportów z kasy']) {
      expect(ARTYKUL, fragment).toContain(fragment);
    }
  });

  it('opisuje brak sum przychodu w okresie z FP i wyjście (Pomoc)', () => {
    expect(ARTYKUL).toContain('nie podaje sumy');
    expect(ARTYKUL).toContain('napisz do nas przez Pomoc');
  });

  it('podaje przepisy: art. 106b ust. 3 i 5, art. 109 ust. 3d, art. 145n ust. 1 pkt 2', () => {
    for (const przepis of ['art. 106b ust. 3', 'art. 106b ust. 5', 'art. 109 ust. 3d', 'art. 145n ust. 1 pkt 2']) {
      expect(ARTYKUL, przepis).toContain(przepis);
    }
  });

  it('granice FP: bez zaliczki, korekty i firm z UE', () => {
    for (const fragment of ['korekty', 'zaliczki', 'firmy z UE', '450 zł']) expect(ARTYKUL, fragment).toContain(fragment);
  });

  it('bez obietnic i porad', () => {
    expect(ARTYKUL).not.toMatch(/gwarantuj|zawsze poprawn|na pewno|zalecamy|powinieneś/i);
  });
});
