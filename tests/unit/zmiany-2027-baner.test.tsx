// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Zmiany2027Baner } from '@/components/dashboard/zmiany-2027-baner';
import { ZMIANY_2027_ARTICLE_SLUG, zmiany2027Widoczne } from '@/lib/zmiany-2027/okno';

/**
 * Krok 1.6, część 2a: jeden komunikat o zmianach z 1 stycznia 2027 r. na
 * pulpicie. Do zamknięcia, zamknięcie zapamiętane osobno dla każdego
 * użytkownika (w tej przeglądarce), widoczny tylko w oknie czasu. Prawdziwy
 * komponent, bez atrap.
 */

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.localStorage.clear();
});

async function pokaz(userId: string, today = '2026-12-01') {
  await act(async () => {
    root.render(<Zmiany2027Baner userId={userId} today={today} />);
  });
}

const baner = () => host.querySelector('[data-testid="zmiany-2027-baner"]');
const zamknij = () => host.querySelector<HTMLButtonElement>('button[aria-label^="Zamknij"]');

describe('okno wyświetlania', () => {
  it.each([
    ['2026-10-31', false],
    ['2026-11-01', true],
    ['2026-12-31', true],
    ['2027-01-01', true],
    ['2027-02-28', true],
    ['2027-03-01', false],
  ])('%s → %s', (dzien, widoczny) => {
    expect(zmiany2027Widoczne(dzien)).toBe(widoczny);
  });

  it('niepoprawna data to brak komunikatu', () => {
    expect(zmiany2027Widoczne('')).toBe(false);
    expect(zmiany2027Widoczne('wczoraj')).toBe(false);
  });
});

describe('komunikat na pulpicie', () => {
  it('pokazuje trzy zmiany i link do artykułu w pomocy', async () => {
    await pokaz(USER_A);
    expect(baner()).not.toBeNull();
    const tekst = baner()!.textContent ?? '';
    expect(tekst).toMatch(/1 stycznia 2027/);
    expect(tekst).toMatch(/10 000 zł/);
    expect(tekst).toMatch(/paragon\w* z NIP/i);
    expect(tekst).toMatch(/450 zł/);
    expect(tekst).toMatch(/faktur\S* uproszczon/i);
    expect(tekst).toMatch(/31 grudnia 2026/);
    // Numer KSeF w przelewie dotyczy czynnych podatników VAT, nie wszystkich „przelewów między firmami”.
    expect(tekst).toMatch(/czynni podatnicy VAT/i);
    expect(tekst).not.toMatch(/przelewach między firmami/i);
    expect(tekst).not.toMatch(/zasady dla faktury do paragonu/i);
    expect(tekst).toMatch(/numer KSeF/i);
    const link = host.querySelector<HTMLAnchorElement>(`a[href="/pomoc/${ZMIANY_2027_ARTICLE_SLUG}"]`);
    expect(link).not.toBeNull();
  });

  it('daje odnośnik do źródła urzędowego (MF) otwierany bezpiecznie', async () => {
    await pokaz(USER_A);
    const zrodlo = host.querySelector<HTMLAnchorElement>('a[href^="https://ksef.podatki.gov.pl/"]');
    expect(zrodlo).not.toBeNull();
    expect(zrodlo!.rel).toContain('noopener');
  });

  it('nie jest poradą podatkową: odsyła do księgowej, bez zaleceń „musisz” i „powinieneś”', async () => {
    await pokaz(USER_A);
    const tekst = baner()!.textContent ?? '';
    expect(tekst).toMatch(/księgow/i);
    expect(tekst).not.toMatch(/musisz|powinieneś|powinnaś|zalecamy|doradzamy/i);
  });

  it('nazwa produktu tylko „FaktWay”', async () => {
    await pokaz(USER_A);
    expect(baner()!.textContent).not.toMatch(/FaktFlow|KSeF SaaS/i);
  });

  it('zamknięcie chowa komunikat i zapamiętuje go dla tego użytkownika', async () => {
    await pokaz(USER_A);
    await act(async () => { zamknij()!.click(); });
    expect(baner()).toBeNull();
    // Po ponownym wyrenderowaniu (odświeżenie strony) komunikat nie wraca.
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await pokaz(USER_A);
    expect(baner()).toBeNull();
  });

  it('zamknięcie jednego użytkownika nie chowa komunikatu drugiemu w tej samej przeglądarce', async () => {
    await pokaz(USER_A);
    await act(async () => { zamknij()!.click(); });
    await pokaz(USER_B);
    expect(baner()).not.toBeNull();
  });

  it('poza oknem czasu nic nie pokazuje', async () => {
    await pokaz(USER_A, '2027-03-01');
    expect(baner()).toBeNull();
  });

  it('przeglądarka bez dostępu do pamięci lokalnej: komunikat działa, zamknięcie chowa go do odświeżenia', async () => {
    const zapis = Storage.prototype.setItem;
    const odczyt = Storage.prototype.getItem;
    Storage.prototype.setItem = () => { throw new Error('zablokowane'); };
    Storage.prototype.getItem = () => { throw new Error('zablokowane'); };
    try {
      await pokaz(USER_A);
      expect(baner()).not.toBeNull();
      await act(async () => { zamknij()!.click(); });
      expect(baner()).toBeNull();
    } finally {
      Storage.prototype.setItem = zapis;
      Storage.prototype.getItem = odczyt;
    }
  });

  it('przycisk zamknięcia ma czytelną nazwę, a komunikat jest regionem z nagłówkiem', async () => {
    await pokaz(USER_A);
    expect(zamknij()!.getAttribute('aria-label')).toMatch(/zmian\w* od 1 stycznia 2027/i);
    expect(baner()!.getAttribute('role')).toBe('region');
    expect(baner()!.getAttribute('aria-labelledby')).toBeTruthy();
  });
});
