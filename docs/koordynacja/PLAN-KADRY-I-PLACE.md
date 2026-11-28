# Plan: kadry i płace dla mikrofirm (krok 9.1 planu kompletnej aplikacji)

Status: plan, bez kodu (R0). Napisany 28.11.2026. Kod rusza dopiero po
zgodzie Bartosza na decyzję P3 w praktyce i po odhaczeniu warunków z sekcji 7
(co do kodu: warunków prawnych nie trzeba, bo moduł jest za wyłącznikiem).

Nadrzędny plan: [`PLAN-KOMPLETNA-APLIKACJA.md`](PLAN-KOMPLETNA-APLIKACJA.md),
krok 9.1 (decyzja P3), sekcje 7 (prawnik i księgowa) i 8 (żelazny filtr).
Wzór formy inwariantów: sekcja 4 i brama w sekcji 11
[`PLAN-KSIEGOWOSC-JDG.md`](PLAN-KSIEGOWOSC-JDG.md).

## 0. Start sesji: checklista

1. `git status`, `git fetch origin`, gałąź od `origin/main`, jeden PR = jedna
   gałąź `claude/kadry-<temat>`.
2. Przeczytaj tylko: sekcję 9.1 planu kompletnej aplikacji, ten plik,
   `docs/filtr/LISTA-KONTROLNA.md`.
3. Sprawdź w dzienniku (sekcja 10), który krok jest następny. Rób tylko ten.
4. Zasady z `AGENTS.md`: protokół naprawy błędu, `pnpm filtr:lokalnie`.

## 1. Cel i zakres

**Cel.** Mikrofirma (do kilku osób) liczy wynagrodzenia w FaktWay, bez
oddzielnego biura płacowego: rachunek do umowy cywilnoprawnej, składki,
zaliczka na podatek, dokumenty dla ZUS i urzędu skarbowego.

**W zakresie (kolejność = kolejność budowy):**
1. umowa zlecenia i umowa o dzieło: rachunek, składki, podatek, ZUS RCA
   i DRA, PIT-11, PIT-4R;
2. umowa o pracę (do kilku osób): lista płac, zgłoszenia do ZUS,
   przypomnienia o badaniach i szkoleniu BHP;
3. PPK (dopiero po punkcie 2, bo wymaga stałego pracownika).

**Poza zakresem (decyzja P3, 9.1):** czas pracy, grafiki, urlopy jako
ewidencja, akta osobowe, delegacje, wysyłka dokumentów do ZUS i US z
danymi autoryzującymi (osobne pytanie do prawnika, jak w pytaniach 3 i 9 z
sekcji 7 planu kompletnej aplikacji), pełna księgowość płac (konta
księgowe). Integracja z e-Płatnikiem to najwyżej plik KEDU, który klient
sam wczytuje (pytanie 10, ten sam mechanizm co krok 4.4).

**Skąd bierzemy liczby.** Żadnych stawek, progów ani kwot w tym planie.
Wszystko z rejestru parametrów (sekcja 4, inwariant I-4) i z przepisów
wpisanych do `REJESTR-PRZEPISOW-KOMPLETNA.md`. W tym dokumencie każde
źródło przepisu oznaczone „do rejestru” znaczy: wpis (artykuł, publikator,
data obowiązywania) trzeba dopisać przed pierwszym kodem tego obszaru.

## 2. Ryzyko wprost: brak wzorca dla listy płac

Tak zapisano w 8.2 planu kompletnej aplikacji. Konsekwencje dla tego planu:

| Wynik | Kto go sprawdzi | Czy jest wzorzec |
|---|---|---|
| składki w RCA i DRA | e-Płatnik (sam liczy DRA, przyjmuje KEDU) | częściowy |
| PIT-11, PIT-4R (format) | schematy XSD e-Deklaracji | częściowy: tylko format |
| wynagrodzenie netto, zaliczka PIT pracownika, potrącenia, PPK | wyłącznie księgowa kadrowa i druga niezależna implementacja | brak |

Dlatego: (a) moduł nie jest nigdy włączany klientom bez bramy z sekcji 7;
(b) każdy wynik netto ma dwie niezależne implementacje porównywane testem
(inwariant I-12); (c) gdy nie da się potwierdzić parametru, program nie
pokazuje kwoty, tylko komunikat z wyjściem (inwariant I-9).

## 3. Fakty z kodu do sprawdzenia w pierwszej sesji kodowej

Nie zakładamy ich z pamięci; K0 potwierdza grepem i wpisuje do dziennika:
- rejestr parametrów roku (`lib/ksiegowosc/parametry/`) i podpis księgowej
  (`sprawdzila`, D7): czy służy też parametrom płacowym;
- wyłącznik `lib/ksiegowosc/wylacznik.ts` i flaga `ksiegowosc_enabled`:
  obszar `kadry` czy osobna flaga;
- silniki składek przedsiębiorcy (K1): co do reuse, a co rozdzielić, bo
  pracownik ma inne zasady niż właściciel (do rejestru);
- reuse: `lib/accounting/read-complete-pages.ts`, `lib/format/warsaw-date.ts`,
  `lib/audit/log.ts`; generator XML e-Deklaracji i JPK z etapów 4 i 5.

## 4. Inwarianty PRZED kodem (łamanie to błąd krytyczny)

Każdy ma test. Kolumna „Test” to nazwa pliku do utworzenia w pierwszym PR
danego obszaru; czerwony test powstaje przed kodem (protokół naprawy błędu).

| # | Inwariant | Test |
|---|---|---|
| I-1 | Kwoty w groszach (liczby całkowite), nigdy `number` z ułamkami. Zaokrąglenia według reguły dla danego składnika (podstawa, składka, zaliczka), każda reguła ma test na granicy zaokrąglenia; przepisy: do rejestru | `tests/kadry/zaokraglenia.test.ts` |
| I-2 | Przychód ze zlecenia i dzieła przypada na dzień wypłaty albo postawienia do dyspozycji, zgodnie z przepisem; termin zaliczki zależy od tej daty; przepisy: do rejestru | `tests/kadry/data-przychodu.test.ts` |
| I-3 | Tytuł ubezpieczeniowy wyznacza kod tytułu na podstawie typu umowy i okoliczności (zbieg tytułów, status ucznia, emeryt, drugi etat); brak danych do wyboru tytułu = brak wyliczenia, nie domyślny tytuł | `tests/kadry/tytul-ubezpieczenia.test.ts` |
| I-4 | Parametry (płaca minimalna, stawka godzinowa minimalna, podstawy i stopy składek, limit podstawy rocznej, koszty uzyskania, progi i kwota zmniejszająca, zasady PPK) tylko z rejestru parametrów roku ze źródłem i datą obowiązywania. Żadnej liczby w kodzie ani w tekstach (test skanuje źródła obszaru) | `tests/kadry/brak-stawek-w-kodzie.test.ts` |
| I-5 | Rachunek, lista płac i dokumenty roczne liczone na parametrach z roku wypłaty (przełom roku, wypłata w styczniu za grudzień); test na granicy lat | `tests/kadry/przelom-roku.test.ts` |
| I-6 | Dokument zatwierdzony (rachunek, lista płac za okres) jest niezmienny; poprawka to nowy dokument korygujący z odwołaniem do pierwotnego (RCA i DRA korygujące, PIT-11 korekta) | `tests/rls-kadry-niezmiennosc.test.ts` (na bazie, wyzwalacz) |
| I-7 | Suma składek i zaliczek na DRA = suma po rachunkach i listach płac okresu co do grosza; rozbieżność blokuje generowanie DRA z komunikatem | `tests/kadry/dra-suma-kontrolna.test.ts` |
| I-8 | PIT-4R = suma zaliczek za rok z listy wypłat; PIT-11 pracownika = suma jego wypłat; sumy kontrolne jak w I-7 | `tests/kadry/pit-sumy.test.ts` |
| I-9 | Fail-closed z wyjściem: brak profilu zleceniobiorcy, brak podpisu parametrów, brak tytułu ubezpieczenia, brak ulgi z oświadczenia = brak kwoty. Komunikat z nazwą dokumentu i tym, co klient ma zrobić, oraz ścieżka operatora (ekran w `/admin` albo PR z parametrami). Blokada bez wyjścia to nowy błąd | `tests/kadry/fail-closed-z-wyjsciem.test.ts` |
| I-10 | RLS na każdej nowej tabeli z `tenant_id`; osoby (zleceniobiorcy, pracownicy) widoczne tylko w swojej firmie; test izolacji dwóch firm i roli księgowej | `tests/rls-kadry-izolacja.test.ts` |
| I-11 | Dane osobowe pracowników (PESEL, adres, rachunek, dane o zdrowiu przy zwolnieniach) szyfrowane kluczem aplikacji jak dane uwierzytelniające KSeF, nie trafiają do logów, `audit_logs` ani zdarzeń pg-boss; zdrowie dopiero po pytaniu 11. Retencja i usuwanie: do rejestru (okresy przechowywania dokumentacji płacowej), do pytania 11 | `tests/kadry/dane-osobowe-nie-wyciekaja.test.ts` |
| I-12 | Dwie niezależne implementacje netto (druga w teście, napisana od zera z przepisów, bez wspólnego kodu) dają ten sam wynik na zestawie złotych przypadków i na losowych kwotach (property test) | `tests/kadry/dwie-implementacje.test.ts` |
| I-13 | Zadania w tle (przypomnienia o terminach, generowanie dokumentów): każdy krok z efektem ma klucz idempotencji; test ponowienia po każdym kroku | `tests/jobs/kadry-ponowienie.test.ts` |
| I-14 | Każda zmiana danych płacowych i każde zatwierdzenie idzie do `audit_logs` (kto, co, okres), bez danych osobowych w treści | `tests/kadry/audyt.test.ts` |
| I-15 | Bez porad (D8): tekst nie zaleca formy umowy ani nie mówi „zapłać”; mówi, ile wychodzi z danych i jaki jest termin z przepisu. Test strażnika tekstów obszaru | `tests/kadry/teksty-bez-porad.test.ts` |
| I-16 | Terminy (zaliczka PIT, DRA, PIT-4R, PIT-11, PPK) z kalendarza z dniami wolnymi, strefa Europe/Warsaw; przepisy: do rejestru | `tests/kadry/terminy.test.ts` |
| I-17 | Wyłącznik: przy wyłączonym obszarze `kadry` żadna trasa, akcja, API ani zadanie nie liczy i nie pokazuje kwot (test na każdej wejściowej ścieżce) | `tests/kadry/wylacznik.test.ts` |

## 5. Kolejność i etapy

### Etap A: umowy zlecenia i o dzieło (najpierw)
Dlaczego pierwsze: prośba z recenzji klientów, mniejszy zakres (brak
urlopów, chorobowego i PPK w typowej wersji), jeden dokument wejściowy
(rachunek).

1. dane zleceniobiorcy (osoba, tytuł ubezpieczenia, oświadczenia o
   kosztach uzyskania i innych tytułach);
2. rachunek do umowy: składki, zdrowotna, zaliczka, netto;
3. ZUS RCA i DRA (składki za okres) jako plik do wczytania w e-Płatniku;
4. zaliczki do urzędu skarbowego, PIT-4R roczny, PIT-11 dla osoby.

Zasady umów o dzieło i składek przy zbiegu tytułów: do rejestru (stan
przepisów w chwili kodu może się różnić od znanego dziś, sprawdzić przed
startem etapu).

### Etap B: umowa o pracę (kilku pracowników)
Dlaczego po A: dochodzą stałe parametry, chorobowe, zasiłki, potrącenia,
zgłoszenia do ZUS, przypomnienia o badaniach i BHP; największe ryzyko
brakującego wzorca.

1. kartoteka pracownika i umowa (okres, wymiar, wynagrodzenie);
2. lista płac miesięczna (składki pracownika i pracodawcy, zaliczka,
   ulga, netto, koszty pracodawcy);
3. wynagrodzenie za czas choroby i zasiłki: osobny krok po pytaniu 11
   (dane o zdrowiu), wcześniej tylko wprowadzenie wprost przez klienta;
4. potrącenia (kolejność i limity z przepisów: do rejestru);
5. zgłoszenia ZUS (ZUA, ZWUA, ZCNA) jako pliki do wczytania;
6. przypomnienia o badaniach i szkoleniu BHP (R2).

### Etap C: PPK
Po B i po opinii księgowej kadrowej: zasady uczestnictwa, deklaracje
rezygnacji, wpłaty pracodawcy i pracownika, termin przelewu do instytucji
finansowej. Wszystko z przepisów do rejestru. Wybór instytucji i umowa o
prowadzenie PPK to sprawa klienta; FaktWay tylko liczy i przypomina.

## 6. Podział na małe PR

Każdy PR ma jedną rzecz, własny czerwony test i opis według szablonu.
Praca: S mały, M średni, L duży. Migracje: numer przydziela rejestr w
chwili otwarcia PR (`docs/runbooks/wgrywanie-migracji.md`), nagłówek
„KIEDY WGRAĆ: PRZED wdrożeniem” (migracje tylko addytywne).

| PR | Zakres | Ryzyko | Praca | Migracja |
|---|---|---|---|---|
| K0 | rejestr przepisów i parametrów płacowych: wpisy bez wartości liczbowych w kodzie, rozpoznanie z sekcji 3, mapa ryzyka dla `lib/kadry/` | R1 (mapa), R0 reszta | S | nie |
| K1 | wyłącznik `kadry` (obszar w `wylacznik.ts` albo flaga), strona informacyjna „wkrótce” za wyłącznikiem | R2 | S | tak, jeśli osobna flaga (addytywna) |
| K2 | tabele osób i umów (zleceniobiorca), RLS, szyfrowanie danych osobowych, audyt | R1 | M | tak, nowe tabele |
| K3 | silnik rachunku do zlecenia i dzieła: czyste funkcje, dwie implementacje, parametry z rejestru | R1 | L | nie |
| K4 | ekran i akcje rachunku, zatwierdzenie niezmienne (wyzwalacz), komunikaty fail-closed | R1 | M | tak, wyzwalacz i status |
| K5 | ZUS RCA i DRA: generator pliku, suma kontrolna, test na wzorcu z e-Płatnika (konto płatnika, człowiek) | R1 | L | nie |
| K6 | PIT-4R i PIT-11: generator XML, walidacja XSD, sumy z I-8 | R1 | L | nie |
| K7 | terminy i przypomnienia (zlecenia): kalendarz, zadania z idempotencją | R2 | S | nie |
| K8 | pilotaż etapu A (brama z sekcji 7), lista kontrolna jak K8 księgowości | R1 | S | nie |
| K9 | kartoteka pracownika i umowa o pracę | R1 | M | tak |
| K10 | lista płac (silnik i ekran), potrącenia | R1 | L | tak |
| K11 | zgłoszenia ZUS, przypomnienia o badaniach i BHP | R1 i R2 | M | tak |
| K12 | PPK | R1 | L | tak |

Kolejność wewnątrz etapu: silnik, ekran, pliki.

## 7. Wyłącznik i brama dla klientów (B1-B5)

Kod pisany od razu, za wyłącznikiem `kadry` (decyzja do K1: obszar w
istniejącym mechanizmie czy osobna flaga; domyślnie wyłączony,
fail-closed). Klientom moduł włączamy, dopiero gdy odhaczone z datą:

| # | Warunek | Kto | Stan 28.11.2026 |
|---|---|---|---|
| B1 | Spółka (OC, regulamin, umowy, umowa powierzenia przetwarzania dla płac) | Bartosz | brak, na końcu |
| B2 | Pisemna opinia prawnika, w tym pytanie 11 (odpowiedzialność, dane o zdrowiu, umowy powierzenia) | Bartosz | brak, na końcu |
| B3 | Polisa OC obejmująca ten obszar | Bartosz | brak, na końcu |
| B4 | Księgowa kadrowa sprawdziła parametry roku i podpisała złote przypadki płacowe (osobny arkusz, dwie niezależne osoby) | Bartosz + sesja | brak |
| B5 | Regulamin modułu kadr i płac | prawnik | brak |
| B6 | Pilotaż: 3-5 firm, kadrowa kontroluje dwa pierwsze miesiące | Bartosz + sesja | po B1-B5 |

Pytanie 11 jest już w `PYTANIA-DO-PRAWNIKA.md`. Przed bramą do pytania
dopisujemy (przez Bartosza, do pakietu prawnika): czy liczenie wynagrodzeń
i dokumentów rocznych to usługa wymagająca OC jak usługowe prowadzenie
ksiąg, i jakie sformułowania w tekstach są bezpieczne (jak pytanie 1
księgowości).

## 8. Co czeka na ludzi

| Co | Kto | Blokuje |
|---|---|---|
| zlecenie dla księgowej kadrowej: sprawdzenie parametrów roku, reguł zaokrągleń i złotych przypadków (państwowego wzorca listy płac nie ma, więc to jedyny niezależny wzorzec obok drugiej implementacji) | Bartosz | K3 (start), B4 |
| druga niezależna osoba do podpisu złotych przypadków | Bartosz | B4 |
| konto płatnika w e-Płatniku do porównania RCA i DRA (co roku) | Bartosz | K5 |
| odpowiedź prawnika na pytanie 11 i dopisane pytanie o OC | prawnik | zdrowie (K10 pkt 3, K11), B2 |
| spółka, OC, regulamin | Bartosz | B1, B3, B5 |
| zgoda firm pilotażowych na porównanie z ich dotychczasowymi listami | Bartosz | B6 |
| potwierdzenie, że kod startuje po etapach 1-5 planu kompletnej aplikacji (kolejność terminów z sekcji 9 tamtego planu) | Bartosz | start K0 |

Czego sesja agenta nie robi sama: nie zgaduje stawek i przepisów, nie
podpisuje parametrów, nie włącza wyłącznika klientom.

## 9. Złote przypadki do zebrania

Arkusz `docs/ksiegowosc/ZLOTE-PRZYPADKI-KADRY.md` (do utworzenia w K0, puste
wyniki, liczy je księgowa; szkielet jak G15-G30). Kolejność zbierania
pokrywa kolejność etapów. Wartości w arkuszu wpisuje wyłącznie księgowa.

Etap A (zlecenie i dzieło):
- Z1 zlecenie, jedyny tytuł, pełne składki;
- Z2 zlecenie przy innym etacie (zbieg tytułów);
- Z3 zlecenie dla ucznia lub studenta w wieku z przepisu (do rejestru);
- Z4 zlecenie dla emeryta albo rencisty;
- Z5 dzieło bez składek, z kosztami uzyskania zwykłymi;
- Z6 dzieło z prawami autorskimi (koszty podwyższone, do rejestru);
- Z7 dzieło na rzecz własnego pracodawcy (tytuł zmienia kwalifikację);
- Z8 wypłata w styczniu za grudzień (przełom roku, I-5);
- Z9 przekroczenie rocznego limitu podstawy składek (do rejestru);
- Z10 zlecenie z płacą poniżej stawki godzinowej minimalnej (ostrzeżenie).

Etap B (umowa o pracę):
- P1 pełny etat, standardowe koszty, ulga zwykła;
- P2 niepełny etat, wynagrodzenie proporcjonalne;
- P3 praca w miejscu zamieszkania lub dojeżdżająca (koszty podwyższone);
- P4 pracownik z drugim pracodawcą, przekroczenie limitu podstawy;
- P5 wynagrodzenie chorobowe w pierwszym okresie choroby;
- P6 zasiłek chorobowy po okresie wynagrodzenia;
- P7 potrącenie komornicze i zaliczka (kolejność i kwota wolna);
- P8 premia kwartalna i rozliczenie w miesiącu wypłaty;
- P9 pracownik poniżej wieku z przepisu na zwolnienie z zaliczki (do rejestru);
- P10 umowa kończąca się w trakcie miesiąca.

Etap C (PPK):
- PPK1 zapis automatyczny, wpłata podstawowa;
- PPK2 rezygnacja w terminie;
- PPK3 wpłata dodatkowa pracodawcy;
- PPK4 pracownik poniżej progu płacy z przepisu (obniżona wpłata, do rejestru);
- PPK5 przekroczenie limitu podstawy składek na PPK w roku.

Dokumenty roczne: ZR1 PIT-11 dla zleceniobiorcy z kilkoma wypłatami i
korektą; ZR2 PIT-4R z wieloma osobami i tytułami; ZR3 DRA korygująca.

## 10. Dziennik

| Data | Krok | PR | Stan | Uwagi |
|---|---|---|---|---|
| 28.11.2026 | plan 9.1 | (ten PR) | do scalenia | sam dokument, R0; K0 dopiero po zgodzie z sekcji 8 |

## 11. Źródła (do rejestru)

Plan nie cytuje przepisów. Przed K0 do `REJESTR-PRZEPISOW-KOMPLETNA.md`
dopisujemy wpisy (artykuł, publikator, data, źródło) dla: ustaw o systemie
ubezpieczeń społecznych, o świadczeniach z ubezpieczenia społecznego, o PIT
(zaliczki, koszty, ulgi, PIT-11, PIT-4R), o PPK, Kodeksu pracy i
rozporządzeń wykonawczych, tabel ZUS i obwieszczeń o płacy minimalnej oraz
schematów XSD PIT-11, PIT-4R i dokumentacji KEDU.
