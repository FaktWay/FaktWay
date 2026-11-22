import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';

import { generateAdvanceInvoiceXml, generateFinalInvoiceXml } from '@/lib/ksef/fa3-advance-generator';
import { generateCorrectionInvoiceXml } from '@/lib/ksef/fa3-correction-generator';
import { InvoiceXmlSchemaError } from '@/lib/xml/fa3-limits';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { describeFa3SchemaErrors, fa3PoleFor } from '@/lib/xml/fa3-pola';
import { validateFA3 } from '@/lib/xml/validator';

import {
  korekta,
  OPCJE,
  POZYCJA,
  rozliczenie,
  zaliczka,
  zaliczkaDoRozliczenia,
  zwykla,
} from './dane';

/**
 * U3 (obchód aplikacji 20.11.2026): z pierwszego błędu walidatora XSD klient
 * dostaje nazwę pola faktury po polsku. Pole wynika ze ścieżki elementu
 * w wysyłanym pliku, a nie z samej nazwy elementu (`NIP` jest u sprzedawcy
 * i u nabywcy, `P_8B` w każdej pozycji). Komunikaty libxml są prawdziwe:
 * XML z generatora z jedną zepsutą wartością przechodzi przez `validateFA3`.
 */

const dwiePozycje = [
  { ordinal: 1, name: 'Usługa A', unit: 'szt.', quantity: 1, unitPriceNet: 100, vatRate: '23' as const },
  { ordinal: 2, name: 'Usługa B', unit: 'szt.', quantity: 2, unitPriceNet: 100, vatRate: '23' as const },
];

const xmlZwykly = () => generateFA3Xml(zwykla({ lines: dwiePozycje }), { generatedAt: OPCJE.generatedAt });

/** Zamienia treść `n`-tego (od 0) elementu `el` w gotowym XML. */
function podmien(xml: string, el: string, wartosc: string, n = 0): string {
  let od = 0;
  let start = -1;
  for (let i = 0; i <= n; i += 1) {
    start = xml.indexOf(`<${el}>`, od);
    if (start < 0) throw new Error(`Brak elementu ${el} (${n}) w XML`);
    od = start + 1;
  }
  const koniec = xml.indexOf(`</${el}>`, start);
  return xml.slice(0, start + el.length + 2) + wartosc + xml.slice(koniec);
}

async function opis(xml: string) {
  const wynik = await validateFA3(xml);
  expect(wynik.valid, 'XML ma być niezgodny z XSD').toBe(false);
  return describeFa3SchemaErrors(xml, wynik.errors.map((e) => e.message));
}

describe('U3: nazwa pola z pierwszego błędu XSD', () => {
  it.each<[string, string, number, string, string]>([
    // [element, zła wartość, który z kolei, pole, fragment zdania]
    ['NIP', '1000000012', 0, 'NIP sprzedawcy', 'ma niepoprawny format'],
    ['NIP', '1000000012', 1, 'NIP nabywcy', 'ma niepoprawny format'],
    ['P_1', '2026-13-45', 0, 'Data wystawienia', 'ma niepoprawny format'],
    ['P_2', '', 0, 'Numer faktury', 'jest puste albo za krótkie'],
    ['P_8B', '1.1234567890', 0, 'Pozycja 1: ilość', 'ma za dużo cyfr'],
    ['P_8B', '1.1234567890', 1, 'Pozycja 2: ilość', 'ma za dużo cyfr'],
    ['P_9A', 'abc', 1, 'Pozycja 2: cena jednostkowa netto', 'ma niepoprawny format'],
    ['P_12', '99', 0, 'Pozycja 1: stawka VAT', 'ma wartość spoza dozwolonej listy'],
    ['KodKraju', 'XX', 0, 'Kraj sprzedawcy', 'ma wartość spoza dozwolonej listy'],
    ['KodKraju', 'XX', 1, 'Kraj nabywcy', 'ma wartość spoza dozwolonej listy'],
    ['KodWaluty', 'ZZZ', 0, 'Waluta', 'ma wartość spoza dozwolonej listy'],
    ['Termin', 'jutro', 0, 'Termin płatności', 'ma niepoprawny format'],
    ['NrRB', 'xx', 0, 'Numer rachunku bankowego', 'jest puste albo za krótkie'],
  ])('%s=%j (#%i): „%s”', async (element, wartosc, ktory, pole, fragment) => {
    const issue = await opis(podmien(xmlZwykly(), element, wartosc, ktory));

    expect(issue).not.toBeNull();
    expect(issue?.field).toBe(pole);
    expect(issue?.message).toBe(`Faktura nie trafiła do KSeF. Pole „${pole}” ${fragment}.`);
    expect(issue?.suggestion.length).toBeGreaterThan(10);
  });

  it('dane sprzedawcy: podpowiedź odsyła do Ustawień firmy, dane nabywcy nie', async () => {
    const sprzedawca = await opis(podmien(xmlZwykly(), 'NIP', '1000000012', 0));
    const nabywca = await opis(podmien(xmlZwykly(), 'NIP', '1000000012', 1));

    expect(sprzedawca?.suggestion).toContain('Ustawieniach firmy');
    expect(nabywca?.suggestion).not.toContain('Ustawieniach firmy');
    expect(nabywca?.suggestion).toContain('10 cyfr');
  });

  it('brakujący element: nazwa brakującego pola, gdy rodzic jest jednoznaczny', async () => {
    const issue = await opis(xmlZwykly().replace(/<Podmiot1>(.*?)<Adres>.*?<\/Adres>/, '<Podmiot1>$1'));

    expect(issue).toMatchObject({
      field: 'Adres sprzedawcy',
      message: 'Faktura nie trafiła do KSeF. Brakuje pola „Adres sprzedawcy”.',
    });
  });

  it('ta sama zła wartość w dwóch pozycjach: „Pozycje”, bez wskazywania jednej na chybił trafił', async () => {
    const dwaRazy = podmien(podmien(xmlZwykly(), 'P_8B', '1.1234567890', 0), 'P_8B', '1.1234567890', 1);

    expect((await opis(dwaRazy))?.field).toBe('Pozycje: ilość');
  });

  it('korekta: numer wiersza w pliku to nie numer pozycji z formularza, więc „Pozycje”, nie „Pozycja N”', async () => {
    // Korekta „przed/po” numeruje wiersze XML osobno: pozycja korygowana to dwa wiersze.
    const xml = generateCorrectionInvoiceXml(korekta(), OPCJE);
    const issue = await opis(podmien(xml, 'P_8B', '1.1234567890', 0));

    expect(issue?.field).toBe('Pozycje: ilość');
    expect(issue?.message).not.toMatch(/Pozycja \d/);
  });

  it('zwykła faktura: numer pozycji z formularza (kolejny numer wiersza)', async () => {
    expect((await opis(podmien(xmlZwykly(), 'P_8B', '1.1234567890', 1)))?.field).toBe('Pozycja 2: ilość');
  });

  it('bez zgadywania: ta sama zła wartość u sprzedawcy i u nabywcy to brak nazwy pola', async () => {
    const oba = podmien(podmien(xmlZwykly(), 'NIP', '1000000012', 0), 'NIP', '1000000012', 1);

    expect(await opis(oba)).toBeNull();
  });

  it('bez zgadywania: element spoza pliku, błąd budowy pliku i element bez nazwy w tabeli to null', async () => {
    // Nieoczekiwany element: błąd budowy pliku, nie wartość pola klienta.
    expect(await opis(xmlZwykly().replace('<P_15>', '<Obce>1</Obce><P_15>'))).toBeNull();
    // Element nagłówka: klient go nie zmienia.
    expect(await opis(podmien(xmlZwykly(), 'WariantFormularza', '9'))).toBeNull();
    // Element, którego plik nie ma.
    expect(describeFa3SchemaErrors(xmlZwykly(), [
      "Linia 1: Schemas validity error : Element '{http://crd.gov.pl/wzor/2025/06/25/13775/}Nieznany': [facet 'pattern'] The value 'x' is not accepted by the pattern '[0-9]'.",
    ])).toBeNull();
  });

  it('odporność: pusta lista, zepsuty XML i obcy tekst dają null, nie wyjątek', () => {
    expect(describeFa3SchemaErrors(xmlZwykly(), [])).toBeNull();
    expect(describeFa3SchemaErrors('<Faktura><nie zamknięte', ["Element '{x}NIP': [facet 'pattern'] The value '1' is not accepted by the pattern 'x'."])).toBeNull();
    expect(describeFa3SchemaErrors(xmlZwykly(), ['coś zupełnie innego'])).toBeNull();
  });

  it('zdanie dla klienta nie niesie tekstu libxml, adresu schematu ani numeru linii', async () => {
    for (const [el, wartosc] of [['NIP', '1000000012'], ['P_12', '99'], ['P_8B', '1.1234567890']] as const) {
      const issue = await opis(podmien(xmlZwykly(), el, wartosc));
      const tekst = `${issue?.message} ${issue?.field} ${issue?.suggestion}`;
      for (const fragment of ['Schemas validity', 'facet', 'crd.gov.pl', 'pattern', 'atomic']) {
        expect(tekst.includes(fragment), fragment).toBe(false);
      }
      expect(tekst).not.toMatch(/Linia \d/);
      expect(tekst).not.toContain('—');
    }
  });
});

describe('U3: pozostałe błędy schematu niosą opis dla klienta', () => {
  it('InvoiceXmlSchemaError bez opisu zostaje poprawny (operator nadal dostaje `errors`)', () => {
    const e = new InvoiceXmlSchemaError(['Linia 1: surowy tekst libxml']);

    expect(e.customer).toBeUndefined();
    expect(e.errors).toEqual(['Linia 1: surowy tekst libxml']);
    expect(e.message).toContain('surowy tekst libxml');
    expect(e.name).toBe('InvoiceXmlSchemaError');
  });
});

describe('U3: tabela nazw pól obejmuje to, co generatory FA(3) piszą', () => {
  /**
   * Każdy element liścia z czterech generatorów ma nazwę w tabeli albo jest na
   * liście pól, których klient nie zmienia (nagłówek, adnotacje, znaczniki).
   * Nowy element w generatorze bez wpisu daje tu czerwony test zamiast ogólnego
   * zdania u klienta bez wyjaśnienia.
   */
  const NIE_DO_POPRAWY = [
    /^Naglowek(\/|$)/,
    /^Fa\/RodzajFaktury$/,
    /^Fa\/TypKorekty$/,
    /^Fa\/Adnotacje(\/|$)/,
    /^Fa\/FaWiersz\/(NrWierszaFa|StanPrzed)$/,
    // Znacznik „numer KSeF korygowanej faktury istnieje” (TWybor1, stała wartość 1), nie numer.
    /^Fa\/DaneFaKorygowanej\/NrKSeF$/,
    /^Fa\/Zamowienie\/ZamowienieWiersz\/NrWierszaZam$/,
    /^Fa\/Platnosc\/FormaPlatnosci$/,
    /^Podmiot2\/(JST|GV)$/,
  ];

  const sciezki = new Set<string>();
  function zbierz(nodes: Array<Record<string, unknown>>, trail: string[]): void {
    for (const node of nodes) {
      for (const [tag, content] of Object.entries(node)) {
        if (tag === ':@' || tag === '#text' || !Array.isArray(content)) continue;
        const sciezka = [...trail, tag];
        const dzieci = content as Array<Record<string, unknown>>;
        if (dzieci.some((c) => Object.keys(c).some((k) => k !== '#text' && k !== ':@'))) zbierz(dzieci, sciezka);
        else sciezki.add(sciezka.slice(1).join('/'));
      }
    }
  }

  it('żaden liść z generatorów nie zostaje bez nazwy (poza polami, których klient nie zmienia)', () => {
    const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: true, ignoreDeclaration: true, removeNSPrefix: true, parseTagValue: false });
    const pliki = [
      generateFA3Xml(zwykla({ lines: dwiePozycje }), { generatedAt: OPCJE.generatedAt }),
      generateCorrectionInvoiceXml(korekta(), OPCJE),
      generateAdvanceInvoiceXml(zaliczka(), OPCJE),
      generateFinalInvoiceXml(rozliczenie({ lines: [{ ...POZYCJA, unitPriceNet: 1000 }] }), [zaliczkaDoRozliczenia()], OPCJE),
    ];
    for (const xml of pliki) zbierz(parser.parse(xml) as Array<Record<string, unknown>>, []);

    const bezNazwy = [...sciezki]
      .filter((p) => !fa3PoleFor(p))
      .filter((p) => !NIE_DO_POPRAWY.some((wzorzec) => wzorzec.test(p)));
    expect(bezNazwy).toEqual([]);
    expect(sciezki.size).toBeGreaterThan(30);
  });
});
