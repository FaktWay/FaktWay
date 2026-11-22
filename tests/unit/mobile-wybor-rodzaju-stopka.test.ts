/**
 * Ekran „Nowa faktura” > „Rodzaj faktury” w aplikacji na telefon (ustalenie U1
 * z obchodu w symulatorze, 20.11.2026).
 *
 * Czerwone przed poprawką (origin/main po #850): na prawdziwym koncie ekran miał
 * stopkę „Z telefonu wystawisz fakturę zwykłą. Korektę, zaliczkę i rozliczenie
 * wystawisz na faktway.pl.” To nieprawda od M8b (#789): zaliczka, rozliczenie
 * (szkic; wysyłka rozliczenia jest wstrzymana tak samo na stronie, a formularz
 * sam przełącza główny przycisk na „Zapisz szkic”) i korekta idą z telefonu
 * przez `POST /faktury`. Klient czytał więc, że musi iść na stronę, choć
 * formularz za wierszem działa.
 *
 * Test czyta źródło ekranu (jak `mobile-android.test.ts`): ekran jest w
 * osobnym workspace i nie da się go uruchomić w vitest bez React Native.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../../mobile/src/app/(zakladki)/faktury/nowa');
const WYBOR = readFileSync(join(SRC, 'index.tsx'), 'utf8');
const FORMULARZ = readFileSync(join(SRC, '[rodzaj].tsx'), 'utf8');

const RODZAJE = ['vat', 'korygujaca', 'zaliczkowa', 'rozliczajaca'] as const;

describe('wybór rodzaju faktury: nie odsyła na stronę tego, co działa z telefonu', () => {
  it('nie obiecuje wystawiania korekty, zaliczki ani rozliczenia na faktway.pl', () => {
    expect(WYBOR).not.toMatch(/wystawisz[^'"`\n]*faktway\.pl/i);
    expect(WYBOR).not.toMatch(/Z telefonu wystawisz fakturę zwykłą/);
    expect(WYBOR).not.toMatch(/Korektę, zaliczkę i rozliczenie/);
  });

  it('nie odsyła na stronę w żadnym tekście ani komentarzu (wszystkie cztery rodzaje są z telefonu)', () => {
    expect(WYBOR).not.toMatch(/faktway\.pl/i);
  });

  it.each(RODZAJE)('wiersz rodzaju „%s” nadal otwiera formularz', (rodzaj) => {
    expect(WYBOR).toContain(`otworz('${rodzaj}')`);
  });

  it('formularz za wierszami obsługuje wszystkie cztery rodzaje (to, co obiecuje lista, jest prawdą)', () => {
    for (const rodzaj of RODZAJE) {
      expect(FORMULARZ).toContain(`'${rodzaj}'`);
    }
    // Rodzaj spoza listy wraca do zwykłej faktury, a nie do ekranu „na stronie”.
    expect(FORMULARZ).toMatch(/\(\['vat', 'zaliczkowa', 'rozliczajaca', 'korygujaca'\] as const\)\.find\(\(r\) => r === rodzajParam\) \?\? 'vat'/);
  });
});
