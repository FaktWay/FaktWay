/**
 * Brak urzędu skarbowego firmy w aplikacji na telefon (ustalenie U14 z obchodu
 * w symulatorze, 20.11.2026; protokół naprawy, punkt 4: „fail-closed musi mieć
 * wyjście”).
 *
 * Czerwone przed poprawką (origin/main po #852): firma bez `tax_office_code`
 * dostawała od serwera odmowę „Plik JPK_V7M potrzebuje urzędu skarbowego firmy.
 * Urząd ustawia się w Ustawieniach, w części Księgowa.” (też JPK_EWP, JPK_PKPIR
 * i eksport JPK_FA), a karta Księgowa pokazywała samo „Urząd skarbowy: Nie
 * wybrano”, bez przycisku i bez odsyłacza na faktway.pl. Stopka karty mówiła
 * „Potrzebny do pliku JPK_FA.”, choć urząd jest potrzebny do czterech plików.
 * Klient dostawał blokadę bez wyjścia.
 *
 * Logika leży w `mobile/src/lib/urzad-skarbowy.ts` (bez React Native); wiązanie
 * z ekranami sprawdzamy po źródle, jak `mobile-wybor-rodzaju-stopka.test.ts`
 * (ekrany są w osobnym workspace i nie uruchomią się w vitest).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  jestBrakiemUrzedu,
  kartaUrzedu,
  PLIKI_Z_URZEDEM,
  STOPKA_URZEDU,
  STRONA_URZEDU,
  TYTUL_USTAW_URZAD,
  wyjscieBrakUrzedu,
} from '../../mobile/src/lib/urzad-skarbowy';

const KORZEN = join(__dirname, '../..');
const zrodlo = (sciezka: string) => readFileSync(join(KORZEN, sciezka), 'utf8');

const KARTA = zrodlo('mobile/src/app/(zakladki)/wiecej/ustawienia/ksiegowa.tsx');
const EKRANY_PLIKOW = {
  vat: zrodlo('mobile/src/app/(zakladki)/ksiegowosc/vat.tsx'),
  ewidencja: zrodlo('mobile/src/app/(zakladki)/ksiegowosc/ewidencja.tsx'),
  eksport: zrodlo('mobile/src/app/(zakladki)/ksiegowosc/eksport.tsx'),
};

const URZAD = { kod: '1433', nazwa: 'Pierwszy Urząd Skarbowy Warszawa-Śródmieście' };
const DLUGIE_MYSLNIKI = /[—–]/;

describe('karta Księgowa: urząd skarbowy ma wyjście', () => {
  it('firma bez urzędu dostaje akcję „Ustaw urząd na faktway.pl” prowadzącą na stronę z polem urzędu', () => {
    const karta = kartaUrzedu(null, true);
    expect(karta.tytul).toBe('Nie wybrano');
    expect(karta.akcja).toEqual({ tytul: TYTUL_USTAW_URZAD, sciezka: STRONA_URZEDU });
    expect(TYTUL_USTAW_URZAD).toBe('Ustaw urząd na faktway.pl');
    expect(STRONA_URZEDU).toBe('/settings/accountant');
  });

  it('firma z urzędem nie dostaje akcji, tylko jego nazwę (a bez nazwy kod)', () => {
    expect(kartaUrzedu(URZAD, true)).toMatchObject({ tytul: URZAD.nazwa, akcja: null });
    expect(kartaUrzedu({ kod: '1433', nazwa: null }, true)).toMatchObject({ tytul: '1433', akcja: null });
  });

  it('bez adresu serwera (nie ma dokąd odesłać) akcji nie ma, żeby nie było martwego przycisku', () => {
    expect(kartaUrzedu(null, false).akcja).toBeNull();
  });

  it('stopka wymienia wszystkie cztery pliki, które wymagają urzędu', () => {
    expect(PLIKI_Z_URZEDEM).toEqual(['JPK_V7M', 'JPK_FA', 'JPK_EWP', 'JPK_PKPIR']);
    for (const plik of PLIKI_Z_URZEDEM) expect(STOPKA_URZEDU).toContain(plik);
    expect(STOPKA_URZEDU).toBe('Potrzebny do plików JPK_V7M, JPK_FA, JPK_EWP i JPK_PKPIR.');
    expect(kartaUrzedu(null, true).stopka).toBe(STOPKA_URZEDU);
    expect(kartaUrzedu(URZAD, true).stopka).toBe(STOPKA_URZEDU);
  });

  it('teksty dla klienta bez długich myślników', () => {
    const karta = kartaUrzedu(null, true);
    for (const tekst of [karta.tytul, karta.stopka, karta.akcja?.tytul ?? '', STOPKA_URZEDU, TYTUL_USTAW_URZAD]) {
      expect(tekst).not.toMatch(DLUGIE_MYSLNIKI);
    }
  });

  it('ekran karty bierze tytuł, stopkę i akcję z funkcji, a nie ze starej stopki o samym JPK_FA', () => {
    expect(KARTA).not.toContain('Potrzebny do pliku JPK_FA.');
    expect(KARTA).toContain('kartaUrzedu(');
    expect(KARTA).toContain('STOPKA_URZEDU');
    // Wiersz akcji otwiera stronę z karty, a po powrocie (zamknięcie przeglądarki) karta wczytuje się od nowa.
    expect(KARTA).toMatch(/<SekcjaUrzedu\s+urzad=\{d\.urzad\}\s+poPowrocie=\{\(\)\s*=>\s*void odczyt\.odswiez\(\)\}\s*\/>/);
    expect(KARTA).toMatch(/otworzStrone\(ustaw\.sciezka,\s*poPowrocie\)/);
  });
});

describe('odmowa o brakującym urzędzie: telefon ją rozpoznaje i daje wyjście', () => {
  /** Zdania, które serwer i telefon naprawdę wysyłają przy braku urzędu (te same pliki, które ekran pokazuje). */
  const ZRODLA_ODMOW = [
    'lib/ksiegowosc/vat-plik.ts',
    'lib/ksiegowosc/ewidencja-pliki.ts',
    'lib/api/mobile/ksiegowosc-eksport.ts',
    'lib/exports/tax-office.ts',
    'mobile/src/app/(zakladki)/ksiegowosc/eksport.tsx',
  ];
  const odmowy = ZRODLA_ODMOW.flatMap((sciezka) =>
    [...zrodlo(sciezka).matchAll(/'([^'\n]*(?:urzędu skarbowego firmy|ustaw urząd skarbowy)[^'\n]*)'/gi)].map((m) => m[1] ?? ''),
  );

  it('znajduje w źródłach wszystkie znane odmowy (JPK_V7M, JPK_EWP, JPK_PKPIR, eksport, wyjątek jobu)', () => {
    // 3 pliki JPK + zdanie eksportu na serwerze i w telefonie + `MissingTaxOfficeError`.
    expect(odmowy.length).toBeGreaterThanOrEqual(6);
    expect(odmowy.some((o) => o.includes('JPK_V7M'))).toBe(true);
    expect(odmowy.some((o) => o.includes('JPK_EWP'))).toBe(true);
    expect(odmowy.some((o) => o.includes('JPK_PKPIR'))).toBe(true);
  });

  it.each(odmowy.map((o) => [o]))('rozpoznaje zdanie serwera: %s', (komunikat) => {
    expect(jestBrakiemUrzedu(komunikat)).toBe(true);
  });

  it('nie bierze za brak urzędu innych odmów (NIP, miesiąc w trakcie, braki w ewidencji, błąd odczytu)', () => {
    for (const inne of [
      'Plik JPK_V7M potrzebuje poprawnego NIP firmy. NIP jest w Ustawieniach, w danych firmy.',
      'Plik za listopad 2026 powstaje po zakończeniu miesiąca.',
      'Plik JPK_EWP nie powstanie, dopóki ewidencja ma braki.',
      'Nie udało się zapisać pliku na telefonie. Zwolnij trochę miejsca i spróbuj ponownie.',
      '',
    ]) {
      expect(jestBrakiemUrzedu(inne)).toBe(false);
    }
  });

  it('właściciel dostaje odsyłacz na stronę, gdy jest dokąd odesłać', () => {
    expect(wyjscieBrakUrzedu('owner', true)).toEqual({ strona: true, podpowiedz: null });
  });

  it('administrator i księgowa nie mają dostępu do tej strony (tylko właściciel), więc dostają zdanie, kto urząd ustawia, bez martwego odsyłacza', () => {
    for (const rola of ['admin', 'accountant', 'member', undefined]) {
      const wyjscie = wyjscieBrakUrzedu(rola, true);
      expect(wyjscie.strona).toBe(false);
      expect(wyjscie.podpowiedz).toBe('Urząd skarbowy ustawia właściciel firmy.');
    }
  });

  it('bez adresu serwera nawet właściciel nie dostaje odsyłacza', () => {
    expect(wyjscieBrakUrzedu('owner', false).strona).toBe(false);
  });

  it('teksty wyjścia bez długich myślników', () => {
    expect(wyjscieBrakUrzedu('admin', true).podpowiedz ?? '').not.toMatch(DLUGIE_MYSLNIKI);
  });
});

describe('ekrany plików (VAT, ewidencja, eksport) pokazują odmowę o urzędzie z wyjściem', () => {
  it.each(Object.entries(EKRANY_PLIKOW))('%s: odmowa przechodzi przez OdmowaPliku z rolą i powrotem ze strony', (_nazwa, ekran) => {
    expect(ekran).toContain("from '@/komponenty/odmowa-pliku'");
    expect(ekran).toMatch(/<OdmowaPliku\b[^>]*rola=\{konto\.firma\?\.rola\}/);
    expect(ekran).toMatch(/<OdmowaPliku\b[^>]*poPowrocie=/);
  });

  it.each(Object.entries(EKRANY_PLIKOW))('%s: odmowa o urzędzie otwiera też arkusz, więc nie ginie poza widokiem długiej listy', (_nazwa, ekran) => {
    expect(ekran).toMatch(/odmowaPlikuNaStronie\(/);
  });

  it('eksport: zdanie telefonu (urząd nieustawiony według GET) też idzie przez arkusz, a nie tylko przez tekst pod przyciskiem', () => {
    // Zdanie zostaje (ten sam tekst co na serwerze, więc `jestBrakiemUrzedu` je rozpoznaje).
    expect(EKRANY_PLIKOW.eksport).toMatch(/odmowaPlikuNaStronie\(\s*BRAK_URZEDU/);
    expect(EKRANY_PLIKOW.eksport).toMatch(/setBlad\(BRAK_URZEDU\)/);
  });
});
