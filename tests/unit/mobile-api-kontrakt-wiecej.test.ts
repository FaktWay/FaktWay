import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { bladApi } from '../../mobile/src/lib/api/bledy';
import { dzienZnacznika, odmiana } from '../../mobile/src/lib/wiecej';

/**
 * Plan aplikacji mobilnej, M10e: kontrakt zakładki Więcej
 * (`lib/api/mobile/kontrakt-wiecej.ts`) czyta też aplikacja przez Metro, jak
 * `kontrakt.ts`, więc nie może importować kodu serwera. Klient telefonu kładzie
 * zdanie serwera o złym polu kontrahenta pod tym polem.
 */

const SOURCE = readFileSync(resolve(__dirname, '../../lib/api/mobile/kontrakt-wiecej.ts'), 'utf8');

describe('kontrakt zakładki Więcej', () => {
  it('nie ma żadnych importów ani require', () => {
    expect(SOURCE).not.toMatch(/^\s*import\s/m);
    expect(SOURCE).not.toMatch(/\brequire\s*\(/);
    expect(SOURCE).not.toMatch(/\bimport\s*\(/);
  });
});

describe('odmowy kontrahenta w telefonie', () => {
  it('`contractor_invalid`: odmowa ze zdaniem serwera pod polem formularza, bez długich myślników', () => {
    const b = bladApi(422, { error: { code: 'contractor_invalid', message: 'Niepoprawny NIP — sprawdź 10 cyfr.', field: 'nip' } });
    expect(b).toMatchObject({ rodzaj: 'odmowa', kod: 'contractor_invalid', pole: 'nip', komunikat: 'Niepoprawny NIP: sprawdź 10 cyfr.' });
  });

  it('`contractor_exists`: odmowa ze zdaniem serwera; pole tylko przy `contractor_invalid` i `invoice_invalid`', () => {
    const b = bladApi(409, { error: { code: 'contractor_exists', message: 'Kontrahent z NIP 5252241585 jest już zapisany.', field: 'nip' } });
    expect(b).toMatchObject({ rodzaj: 'odmowa', kod: 'contractor_exists', komunikat: 'Kontrahent z NIP 5252241585 jest już zapisany.' });
    expect(b.pole).toBeUndefined();
  });
});

describe('dzień znacznika czasu w Polsce', () => {
  it('koniec okresu o 23:30 UTC to już następny dzień w Warszawie; brak i śmieci to `null`', () => {
    expect(dzienZnacznika('2026-11-30T23:30:00Z')).toBe('2026-12-01');
    expect(dzienZnacznika('2026-07-01T21:59:00Z')).toBe('2026-07-01');
    expect(dzienZnacznika(null)).toBeNull();
    expect(dzienZnacznika('nie-data')).toBeNull();
  });
});

describe('odmiana liczebników', () => {
  it('1 wpis, 3 wpisy, 5 wpisów, 12 wpisów, 22 wpisy', () => {
    const f: [string, string, string] = ['wpis', 'wpisy', 'wpisów'];
    expect([1, 3, 5, 12, 22, 0].map((n) => odmiana(n, f))).toEqual(['1 wpis', '3 wpisy', '5 wpisów', '12 wpisów', '22 wpisy', '0 wpisów']);
  });
});
