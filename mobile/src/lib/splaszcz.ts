import { Children, cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react';

/**
 * Dzieci z rozwiniętymi fragmentami (`<>...</>`), żeby linie szły między
 * wszystkimi wierszami (`Sekcja` w `komponenty/lista.tsx`).
 *
 * `Children.toArray` nadaje klucze („.0”, „.1”, „.$klucz”) osobno na każdym
 * poziomie, więc dzieci fragmentu dostawały te same klucze co rodzeństwo na
 * zewnątrz fragmentu, a `Sekcja` opakowuje każdy element w
 * `<Fragment key={el.key}>` (obchód 20.11.2026, U6: „Encountered two children
 * with the same key”). Klucze elementów z fragmentu są dlatego poprzedzone
 * kluczem fragmentu (rekurencyjnie), jak ścieżka: „.4” + „.0” to „.4.0”.
 * Elementy spoza fragmentu zostają bez zmian (ten sam obiekt, ten sam klucz).
 *
 * Plik bez React Native: czyta go test strony (`tests/unit/mobile-splaszcz-klucze.test.ts`).
 */
export function splaszcz(children: ReactNode, prefiks = ''): ReactElement[] {
  return Children.toArray(children)
    .filter(isValidElement)
    .flatMap((el) => {
      // `Children.toArray` zawsze nadaje klucz, więc `?? ''` tylko uspokaja typy.
      const klucz = `${prefiks}${el.key ?? ''}`;
      if (el.type === Fragment) return splaszcz((el as ReactElement<{ children?: ReactNode }>).props.children, klucz);
      return [prefiks ? cloneElement(el, { key: klucz }) : el];
    });
}
