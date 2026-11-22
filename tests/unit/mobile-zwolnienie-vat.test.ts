/**
 * Zwolnienie z VAT z telefonu: pusta „Inna podstawa” (ustalenie U19 z obchodu
 * w symulatorze, 20.11.2026).
 *
 * Czerwone przed poprawką (origin/main po #854): w Więcej > Firma > Podatek VAT
 * włączone „Zwolnienie z VAT” z wyborem „Inna podstawa” i pustym polem tekstowym
 * wysyłało `{ zmiana: 'zwolnienie', podstawa: '' }`. Dla `POST /ustawienia/firma`
 * (jak dla akcji strony) pusty tekst to „czynny podatnik VAT”, więc arkusz
 * zamykał się bez słowa, a `tenants.vat_exemption_basis` wracało do NULL
 * (wpis `tenant.updated` z `art. 113 ust. 1...` na `null`). Użytkownik, który
 * chciał zapisać zwolnienie, tracił je po cichu, a ono decyduje o stawkach „zw”
 * i podstawie prawnej na każdej kolejnej fakturze do KSeF.
 *
 * Te same przypadki sprawdzamy na serwerze (`normalizeExemptionBasis`): to, co
 * telefon uzna za podstawę, serwer musi uznać za zwolnienie, a to, co telefon
 * odrzuci, serwer czytałby jako zdjęcie zwolnienia. Ekran składa się z
 * `podstawaZwolnienia` (odczyt źródła, jak `mobile-wybor-rodzaju-stopka.test.ts`:
 * ekran jest w osobnym workspace i nie działa w vitest bez React Native).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeExemptionBasis } from '@/lib/invoices/vat-exemption';

import { PODSTAWY_ZWOLNIENIA_VAT } from '../../mobile/src/lib/api/kontrakt-ustawienia';
import { INNA_PODSTAWA, KOMUNIKAT_BRAK_PODSTAWY, podstawaZwolnienia } from '../../mobile/src/lib/ustawienia/zwolnienie-vat';

const EKRAN = readFileSync(join(__dirname, '../../mobile/src/app/(zakladki)/wiecej/ustawienia/firma-zmiana.tsx'), 'utf8');

const PRESET = PODSTAWY_ZWOLNIENIA_VAT[0].podstawa;
/** Znaki, które serwer (`trim`) czyta jako puste: spacja, tabulator, nowa linia, twarda spacja, spacja ideograficzna. */
const PUSTE = ['', ' ', '   ', '\t', '\n', '   ', '　'];

/** Co zrobi serwer z podstawą: `null` to zdjęcie zwolnienia; za krótka albo ze znakami sterującymi to odmowa 422 (zdanie pod polem), nie zdjęcie. */
function czytaSerwer(podstawa: string): string | null {
  try {
    return normalizeExemptionBasis(podstawa);
  } catch {
    return 'odmowa serwera';
  }
}

describe('podstawaZwolnienia: pusta „Inna podstawa” nie zdejmuje zwolnienia', () => {
  it.each(PUSTE)('zwolnienie włączone, „Inna podstawa” %j: odmowa ze zdaniem, bez podstawy do wysłania', (inna) => {
    const w = podstawaZwolnienia({ zwolniona: true, wybor: INNA_PODSTAWA, inna });
    expect(w).toEqual({ ok: false, komunikat: 'Podaj podstawę zwolnienia z VAT.' });
    expect(KOMUNIKAT_BRAK_PODSTAWY).toBe('Podaj podstawę zwolnienia z VAT.');
  });

  it('inwariant: nic, co telefon uzna za podstawę zwolnienia, nie jest dla serwera zdjęciem zwolnienia', () => {
    for (const inna of [...PUSTE, 'ab', 'art. 43 ust. 1 pkt 29 lit. c ustawy o VAT', '  art. 43   ust. 1 pkt 29  ']) {
      for (const wybor of [INNA_PODSTAWA, PRESET]) {
        const w = podstawaZwolnienia({ zwolniona: true, wybor, inna });
        if (w.ok) expect(czytaSerwer(w.podstawa), JSON.stringify({ wybor, inna })).not.toBeNull();
      }
    }
  });

  it('serwer czyta pusty tekst jako czynnego podatnika (dlatego telefon go nie wysyła przy włączonym zwolnieniu)', () => {
    for (const pusty of PUSTE) expect(normalizeExemptionBasis(pusty)).toBeNull();
  });

  it('wpisana „Inna podstawa” przechodzi bez zmian (długość i znaki sprawdza serwer, jego zdanie stoi pod polem)', () => {
    expect(podstawaZwolnienia({ zwolniona: true, wybor: INNA_PODSTAWA, inna: 'art. 43 ust. 1 pkt 29 lit. c ustawy o VAT' })).toEqual({
      ok: true,
      podstawa: 'art. 43 ust. 1 pkt 29 lit. c ustawy o VAT',
    });
    expect(podstawaZwolnienia({ zwolniona: true, wybor: INNA_PODSTAWA, inna: 'ab' })).toEqual({ ok: true, podstawa: 'ab' });
  });

  it('podstawa z listy przechodzi, a tekst „Innej podstawy” jej nie zasłania', () => {
    expect(podstawaZwolnienia({ zwolniona: true, wybor: PRESET, inna: '' })).toEqual({ ok: true, podstawa: PRESET });
    expect(podstawaZwolnienia({ zwolniona: true, wybor: PRESET, inna: 'coś innego' })).toEqual({ ok: true, podstawa: PRESET });
  });

  it('zwolnienie wyłączone to pusta podstawa i zgoda (to jedyna droga do „czynnego podatnika VAT”)', () => {
    for (const inna of ['', 'art. 43 ust. 1 pkt 29 lit. c ustawy o VAT']) {
      for (const wybor of [INNA_PODSTAWA, PRESET]) {
        expect(podstawaZwolnienia({ zwolniona: false, wybor, inna })).toEqual({ ok: true, podstawa: '' });
      }
    }
  });
});

describe('ekran Podatek VAT: korzysta z podstawaZwolnienia i nie wysyła zapisu przy odmowie', () => {
  it('podstawa z funkcji, bez własnego trójargumentowego wyboru „inna albo wybór” na pusty tekst', () => {
    expect(EKRAN).toContain("from '@/lib/ustawienia/zwolnienie-vat'");
    expect(EKRAN).toMatch(/podstawaZwolnienia\(\{\s*zwolniona,\s*wybor,\s*inna\s*\}\)/);
    expect(EKRAN).not.toMatch(/wybor === INNA \? inna : wybor\) : ''/);
  });

  it('odmowa staje przed zapisem: zdanie pod polem „Inna podstawa”, żaden zapis nie idzie do serwera', () => {
    const zapisz = EKRAN.slice(EKRAN.indexOf('const zapisz = async'), EKRAN.indexOf('return (\n    <EkranListy keyboardShouldPersistTaps'));
    const odmowa = zapisz.indexOf('!wynikPodstawy.ok');
    expect(odmowa).toBeGreaterThan(-1);
    // Odmowa przed `router.back()` przy braku zmian (bez zmian też nie zamykamy po cichu) i przed pętlą zapisów.
    expect(odmowa).toBeLessThan(zapisz.indexOf('zmiany.length === 0'));
    expect(odmowa).toBeLessThan(zapisz.indexOf('zapis.firma('));
    expect(zapisz.slice(odmowa, zapisz.indexOf('zmiany.length === 0'))).toMatch(/pole: 'podstawa'[\s\S]*return;/);
  });
});
