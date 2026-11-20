import { readFileSync } from 'node:fs';

import PDFDocument from 'pdfkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { noteEmailIdempotencyKey } from '@/lib/noty/mail';
import { renderNotePdf, type NotePdfInput } from '@/lib/noty/pdf';
import { LOGO_PDF_GAP, logoPdfSize } from '@/lib/pdf/logo';
import { prepareLogoUpload, type PreparedLogo } from '@/lib/pdf/logo-obraz';

import { kanonPdf, skrotKanonuPdf } from '../helpers/pdf-kanon';

/**
 * Logo firmy na PDF noty obciążeniowej i uznaniowej (plan kompletnej
 * aplikacji, krok 2.2, reszta): jak na fakturze, proformie i ofercie.
 *
 * „Bez logo wydruk taki sam jak dziś” (decyzja D1): skróty kanonu PDF
 * (`tests/helpers/pdf-kanon.ts`) policzone na `origin/main` @ 74309835, przed
 * tą zmianą, przy stałej dacie utworzenia pliku. Inny skrót = inny wydruk.
 * Zmiana pdfkit albo czcionek zmienia skróty: wtedy porównaj wydruki i wpisz
 * nowe w osobnym PR.
 */

const PRZED_ZMIANA = {
  obciazeniowa: '436f2990ce951b78ee035a3e05241182c8c4f95cc97bd91c95c5ffd9b592c7c0',
  uznaniowa: '100dfceb1766d5c697f8a68a1e6046af0e9050c3b9133b871ef88d46b2b5afdd',
};

const MARGINES = 42;

function nota(zmiany: Partial<NotePdfInput> = {}): NotePdfInput {
  return {
    kind: 'debit',
    number: 'NO/1/2026',
    issueDate: '2026-11-11',
    title: 'Kara umowna',
    items: [
      { description: 'Kara za opóźnienie dostawy (umowa 7/2026)', amount: 1_200 },
      { description: 'Zwrot kosztów transportu', amount: 99.99 },
    ],
    total: 1_299.99,
    issuer: { name: 'Moja Firma', nip: '1234567890', countryCode: 'PL', addressLine1: 'ul. Przykładowa 1', addressLine2: '00-001 Warszawa' },
    counterparty: { name: 'Kontrahent', nip: '1234567890', countryCode: 'PL', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa' },
    relatedDocument: 'FV/2026/11/3',
    dueDate: '2026-11-25',
    bankAccount: 'PL61109010140000071219812874',
    issuedAt: '2026-11-11T09:30:00.000Z',
    ...zmiany,
  };
}

const UZNANIOWA: Partial<NotePdfInput> = { kind: 'credit', number: 'NU/4/2026', dueDate: null, bankAccount: null };

function logo(bajty: Uint8Array): PreparedLogo {
  const wynik = prepareLogoUpload(bajty);
  if (!wynik.ok) throw new Error(wynik.error);
  return wynik.logo;
}

const LOGO_PNG = logo(readFileSync('docs/brand/logo/zestaw/png/faktway-logo-1200.png'));
const LOGO_JPEG = logo(readFileSync('public/marketing/hero.jpg'));

beforeEach(() => {
  // Data utworzenia pliku (Info, ID) bez zmiany zegarów: zapis PNG i strumieni idzie przez zlib.
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-13T10:00:00.000Z') });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function nagrywaj() {
  const image = vi.spyOn(PDFDocument.prototype, 'image');
  const text = vi.spyOn(PDFDocument.prototype, 'text');
  const moveTo = vi.spyOn(PDFDocument.prototype, 'moveTo');
  return {
    obrazy: () => image.mock.calls.map((c) => ({ x: c[1], y: c[2], opcje: c[3] as { width?: number; height?: number } })),
    teksty: () => text.mock.calls.map((c) => String(c[0])),
    polozenie: (napis: string) => {
      const call = text.mock.calls.find((c) => String(c[0]) === napis);
      return call ? { x: call[1] as number, y: call[2] as number } : null;
    },
    pierwszaLinia: () => moveTo.mock.calls[0]?.[1],
  };
}

describe('nota bez logo: wydruk taki sam jak przed zmianą', () => {
  it.each([
    ['nota obciążeniowa', () => renderNotePdf(nota()), PRZED_ZMIANA.obciazeniowa],
    ['nota obciążeniowa, logo: null', () => renderNotePdf(nota(), { logo: null }), PRZED_ZMIANA.obciazeniowa],
    ['nota obciążeniowa, opcje bez logo', () => renderNotePdf(nota(), {}), PRZED_ZMIANA.obciazeniowa],
    ['nota uznaniowa', () => renderNotePdf(nota(UZNANIOWA)), PRZED_ZMIANA.uznaniowa],
    ['nota uznaniowa, logo: null', () => renderNotePdf(nota(UZNANIOWA), { logo: null }), PRZED_ZMIANA.uznaniowa],
  ])('%s', async (_opis, wydruk, skrot) => {
    expect(skrotKanonuPdf(await wydruk())).toBe(skrot);
  });
});

describe('nota z logo', () => {
  it('logo w lewym górnym rogu, nagłówek niżej o wysokość logo i odstęp, linia pod nagłówkiem też', async () => {
    const zapis = nagrywaj();
    const pdf = await renderNotePdf(nota(), { logo: LOGO_PNG });
    const { width, height } = logoPdfSize(LOGO_PNG);
    expect(zapis.obrazy()).toEqual([{ x: MARGINES, y: MARGINES, opcje: { width, height } }]);
    const gora = MARGINES + height + LOGO_PDF_GAP;
    expect(zapis.polozenie('Nota obciążeniowa')).toEqual({ x: MARGINES, y: gora });
    expect(zapis.polozenie('Nr NO/1/2026')).toEqual({ x: MARGINES, y: gora + 26 });
    expect(zapis.pierwszaLinia()).toBe(gora + 64);
    expect(kanonPdf(pdf)).toMatch(/\/Subtype \/Image[\s\S]*\/SMask/);
  });

  it('nota uznaniowa i JPEG też mają logo', async () => {
    const zapis = nagrywaj();
    const pdf = await renderNotePdf(nota(UZNANIOWA), { logo: LOGO_JPEG });
    const { width, height } = logoPdfSize(LOGO_JPEG);
    expect(zapis.obrazy()).toEqual([{ x: MARGINES, y: MARGINES, opcje: { width, height } }]);
    expect(zapis.polozenie('Nota uznaniowa')?.y).toBe(MARGINES + height + LOGO_PDF_GAP);
    expect(kanonPdf(pdf)).toMatch(/\/Filter \/DCTDecode/);
  });

  it('treść noty bez zmian: te same napisy z logo i bez logo', async () => {
    const bez = nagrywaj();
    await renderNotePdf(nota());
    const napisyBez = bez.teksty();
    vi.restoreAllMocks();
    const z = nagrywaj();
    await renderNotePdf(nota(), { logo: LOGO_PNG });
    expect(z.teksty()).toEqual(napisyBez);
  });

  it('ta sama nota z tym samym logo daje ten sam plik (ponowienie maila z kluczem idempotencji)', async () => {
    vi.useRealTimers();
    const a = await renderNotePdf(nota(), { logo: LOGO_PNG });
    const b = await renderNotePdf(nota(), { logo: LOGO_PNG });
    expect(a.equals(b)).toBe(true);
  });
});

describe('mail z notą: klucz idempotencji a logo w załączniku', () => {
  const ID = '5d0e8a8c-7a3b-4f61-9d2e-1c4b5a6f7e80';
  const KLUCZ_LOGO = 'tenants/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d/logo/5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f.png';

  it('bez logo klucz jak przed zmianą; inne logo w PDF to inny klucz z tym samym przedrostkiem noty', () => {
    const bez = noteEmailIdempotencyKey(ID, 'jan@firma.pl', 0);
    expect(noteEmailIdempotencyKey(ID, 'jan@firma.pl', 0, null)).toBe(bez);
    expect(bez.startsWith(`nota/${ID}/`)).toBe(true);
    const zLogo = noteEmailIdempotencyKey(ID, 'jan@firma.pl', 0, KLUCZ_LOGO);
    expect(zLogo.startsWith(`${bez}/`)).toBe(true);
    expect(noteEmailIdempotencyKey(ID, 'jan@firma.pl', 0, KLUCZ_LOGO.replace('5c6d', '6c6d'))).not.toBe(zLogo);
    expect(zLogo.length).toBeLessThanOrEqual(200);
  });
});
