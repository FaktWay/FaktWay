import { createElement, Fragment, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { splaszcz } from '../../mobile/src/lib/splaszcz';

/**
 * Obchód w symulatorze 20.11.2026, ustalenie U6: `Sekcja` rozwija fragmenty
 * (`<>...</>`) w swoich dzieciach, a `Children.toArray` nadaje klucze „.0”,
 * „.1”... osobno na każdym poziomie. Dzieci fragmentu dostawały więc te same
 * klucze co rodzeństwo na zewnątrz („Dane korekty” w formularzu korekty),
 * a `Sekcja` opakowuje każdy element w `<Fragment key={el.key}>`: React
 * zgłasza „Encountered two children with the same key”, a pola mogą się
 * dublować albo znikać przy aktualizacji.
 */

const el = (typ: string, key?: string): ReactElement => createElement(typ, key ? { key } : null);
const fragment = (key: string | null, ...dzieci: ReactNode[]): ReactElement => createElement(Fragment, key ? { key } : null, ...dzieci);

function klucze(elementy: ReactElement[]): string[] {
  return elementy.map((e) => String(e.key));
}

function bezPowtorzen(elementy: ReactElement[]): void {
  const k = klucze(elementy);
  expect(new Set(k).size, `klucze: ${k.join(' | ')}`).toBe(k.length);
}

describe('splaszcz: unikalne klucze po rozwinięciu fragmentów', () => {
  it('układ jak w formularzu korekty (pola, null, pole, fragment z trzema polami): 6 elementów, klucze różne', () => {
    // Sekcja „Dane korekty”: numer, data, (data sprzedaży tylko dla VAT: tu null),
    // termin płatności, a potem fragment z trzema polami tylko dla korekty.
    const dzieci = [el('input'), el('input'), null, el('input'), fragment(null, el('select'), el('select'), el('textarea'))];
    const wynik = splaszcz(dzieci);
    expect(wynik).toHaveLength(6);
    expect(wynik.map((e) => e.type)).toEqual(['input', 'input', 'input', 'select', 'select', 'textarea']);
    bezPowtorzen(wynik);
  });

  it('ten sam układ podany jak w JSX (dzieci osobnymi argumentami) ma te same klucze', () => {
    const wynik = splaszcz(createElement('div', null, el('input'), el('input'), null, el('input'), fragment(null, el('select'), el('select'), el('textarea'))).props.children);
    expect(wynik).toHaveLength(6);
    bezPowtorzen(wynik);
  });

  it('dwa fragmenty obok siebie: klucze różne w obrębie obu i względem rodzeństwa', () => {
    const wynik = splaszcz([el('input'), fragment(null, el('select'), el('select')), fragment(null, el('textarea'), el('textarea')), el('input')]);
    expect(wynik).toHaveLength(6);
    expect(wynik.map((e) => e.type)).toEqual(['input', 'select', 'select', 'textarea', 'textarea', 'input']);
    bezPowtorzen(wynik);
  });

  it('fragment we fragmencie z kluczami nadanymi przez autora: klucze różne mimo tych samych kluczy autora na różnych poziomach', () => {
    const wynik = splaszcz([
      el('input', 'x'),
      fragment('a', el('select', 'x'), fragment('b', el('textarea', 'x'), el('textarea', 'y')), el('select', 'y')),
      fragment('c', el('input', 'x')),
    ]);
    expect(wynik).toHaveLength(6);
    bezPowtorzen(wynik);
  });

  it('fragment w fragmencie bez kluczy: trzy poziomy, klucze różne', () => {
    const wynik = splaszcz([el('input'), fragment(null, el('input'), fragment(null, el('input'), fragment(null, el('input'), el('input')), el('input')))]);
    expect(wynik).toHaveLength(6);
    bezPowtorzen(wynik);
  });

  it('elementy bez fragmentu zachowują dotychczasowe klucze i tożsamość', () => {
    const a = el('input');
    const b = el('input', 'moj');
    const wynik = splaszcz([a, null, b, false, 'tekst', el('select')]);
    expect(wynik).toHaveLength(3);
    // Klucze tak jak nadaje je Children.toArray: indeks (z pominięciem null) albo `$klucz` autora.
    expect(klucze(wynik)).toEqual(['.0', '.$moj', '.5']);
    expect(wynik[0]?.type).toBe('input');
    expect(wynik[1]?.props).toEqual(b.props);
  });

  it('rodzeństwo przed fragmentem zachowuje klucze, tylko dzieci fragmentu dostają przedrostek', () => {
    const przed = klucze(splaszcz([el('input'), el('input')]));
    const wynik = splaszcz([el('input'), el('input'), fragment(null, el('select'))]);
    expect(klucze(wynik).slice(0, 2)).toEqual(przed);
    expect(String(wynik[2]?.key).startsWith('.2')).toBe(true);
  });

  it('pomija null, false, tekst i pusty fragment', () => {
    expect(splaszcz([null, false, 'tekst', 3, fragment(null)])).toEqual([]);
    expect(splaszcz(null)).toEqual([]);
    expect(splaszcz(undefined)).toEqual([]);
  });

  it('tablica w tablicy (lista z map) w fragmencie: klucze różne', () => {
    const wiersze = ['a', 'b', 'c'].map((k) => el('input', k));
    const wynik = splaszcz([el('input'), fragment(null, wiersze), wiersze.map((e) => el(String(e.type), String(e.key)))]);
    expect(wynik).toHaveLength(7);
    bezPowtorzen(wynik);
  });
});
