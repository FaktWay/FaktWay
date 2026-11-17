import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ZMIANY_2027_ARTICLE_SLUG } from '@/lib/zmiany-2027/okno';

/**
 * Krok 1.6, część 2a: wpis w pomocy o trzech zmianach z 1 stycznia 2027 r.
 * (przepisy L1 do L3 planu kompletnej aplikacji): koniec progu 10 000 zł,
 * faktura do paragonu, numer KSeF w tytule przelewu. Każda zmiana ma źródło
 * urzędowe, a artykuł nie jest poradą podatkową (D8 planu księgowości).
 * Co robi FaktWay: tylko to, co jest w aplikacji.
 */

const ARTYKUL = readFileSync(join(__dirname, '..', '..', 'content', 'help', `${ZMIANY_2027_ARTICLE_SLUG}.mdx`), 'utf8');

function sekcja(naglowek: string): string {
  const start = ARTYKUL.indexOf(`## ${naglowek}`);
  expect(start, `brak sekcji „${naglowek}”`).toBeGreaterThanOrEqual(0);
  const next = ARTYKUL.indexOf('\n## ', start + 5);
  return ARTYKUL.slice(start, next === -1 ? undefined : next);
}

describe('artykuł „Zmiany od 1 stycznia 2027 r.”', () => {
  it('slug z komunikatu to ten artykuł', () => {
    expect(ZMIANY_2027_ARTICLE_SLUG).toBe('zmiany-od-1-stycznia-2027');
  });

  it('zaznacza, że to informacja ogólna, nie porada podatkowa', () => {
    expect(ARTYKUL).toMatch(/nie porada podatkowa/i);
    expect(ARTYKUL).toMatch(/księgow/i);
  });

  it.each([
    ['KSeF dla wszystkich', /10 000 zł/, 'ksef.podatki.gov.pl/informacje-ogolne-ksef-20/zakres-obowiazkowego-ksef'],
    ['Paragon a faktura dla firmy', /3 miesięcy/, 'gov.pl/attachment/'],
    ['Numer KSeF w tytule przelewu', /numer KSeF/, 'ksef.podatki.gov.pl/informacje-ogolne-ksef-20/numer-ksef-i-zbiorczy-identyfikator'],
  ])('sekcja „%s” ma treść i źródło urzędowe', (naglowek, tresc, zrodlo) => {
    const s = sekcja(naglowek);
    expect(s).toMatch(tresc);
    expect(s).toContain(zrodlo);
  });

  it('sekcja „Co robi FaktWay” opisuje tylko funkcję z aplikacji: tytuł przelewu z numerem KSeF', () => {
    const s = sekcja('Co robi FaktWay');
    expect(s).toMatch(/tytu\w+ przelewu/i);
    expect(s).toMatch(/numer\w* KSeF/i);
    // Warunki z `tytulPrzelewuNaDokumencie`: numer KSeF, płatność przelewem, kwota do zapłaty.
    expect(s).toMatch(/tylko .*numer\w* KSeF/i);
    expect(s).toMatch(/przelew/i);
    expect(s).toMatch(/kwot\w+ do zapłaty/i);
    // Funkcji, których nie ma w aplikacji, nie obiecujemy.
    expect(s).not.toMatch(/identyfikator zbiorczy w pliku|import faktur spoza KSeF|automatycznie rozlicz/i);
    // Fakturę do paragonu opisujemy w pomocy tylko jako przepis (strażnik stron publicznych: produkt jej publicznie nie obiecuje).
    expect(s).not.toMatch(/faktur\w* do paragonu/i);
  });

  it('Aplikacja Podatnika: identyfikator zbiorczy dziś przez API KSeF, w aplikacji docelowo', () => {
    const s = sekcja('Numer KSeF w tytule przelewu');
    expect(s).toMatch(/docelowo/i);
    expect(s).toMatch(/API KSeF/);
  });

  it('bez obietnic i zaleceń w trybie rozkazującym o podatkach', () => {
    expect(ARTYKUL).not.toMatch(/musisz zapłacić|powinieneś odliczyć|zalecamy odliczyć/i);
  });

  it('nazwa produktu tylko „FaktWay”', () => {
    expect(ARTYKUL).not.toMatch(/FaktFlow|KSeF SaaS/);
  });

  it('data aktualizacji w nagłówku to dzień tej zmiany', () => {
    expect(ARTYKUL).toMatch(/updated: "2026-11-1[6-9]"/);
  });
});
