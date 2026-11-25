# Ten sam dokument kosztu dwa razy (FZ-022)

Reguła RP-KOSZT-01, kod `lib/expenses/jeden-koszt-dokumentu.ts`, ustalenie
FZ-022 w `docs/filtr/USTALENIA.md`.

## Co widzi klient

Raport KPiR, eksport KPiR (Centrum eksportu, portal księgowej), VAT modułu
księgowości i karty kosztów Pulpitu, Przepływów i Analiz odmawiają z treścią
„Ten sam dokument jest w kosztach więcej niż raz: {numer} z {data} ({ile}
razy: {źródła}) …”, gdy w odczytywanym okresie ten sam dokument (NIP
sprzedawcy, numer i rok wystawienia, bez względu na rodzaj) jest:

- w kosztach z KSeF i spoza KSeF (zdjęcie, wpis ręczny, import), albo
- dwa razy spoza KSeF jako kopia: ta sama kwota brutto albo, przy fakturach,
  ta sama kolumna KPiR; dwa paragony tylko przy tym samym dniu i kwocie (wiele
  kas pod jednym NIP-em daje ten sam numer innego paragonu).

Inne okresy liczą się jak dotąd. Odmowy nie ma przy dwóch kosztach z KSeF
(dla KSeF to dwa dokumenty, np. faktura i korekta) ani przy fakturze spoza
KSeF rozpisanej na dwie kolumny KPiR z różnymi kwotami.

## Wyjście klienta

W Kosztach (przycisk „Koszty” w historii eksportu i „Koszty miesiąca” przy
raporcie KPiR prowadzą do miesiąca) przy kopii wyłącza się „Uwzględnij
w KPiR”:

- koszt ze zdjęcia albo wpisany ręcznie: formularz kosztu;
- koszt z KSeF: przegląd kosztu KSeF (RPC `review_ksef_expense`), gdy to on
  jest zbędny (rzadko: koszt z KSeF ma numer KSeF potrzebny w JPK_V7M).

Gdy kopia spoza KSeF ma źle odczytany numer albo datę i to w rzeczywistości
inny dokument, poprawia się te dane w formularzu kosztu tak, jak są na
dokumencie.

## Ścieżka operatora (zgłoszenie w Pomocy)

Jedną linią (sesja z `.agents/infra.env`, tylko odczyt: `BEGIN READ ONLY`
i transakcja tylko do odczytu w PGOPTIONS; logika w
`scripts/ops/koszt-dwa-razy.sql`, ta sama reguła i ten sam filtr środowiska
KSeF co odczyty aplikacji):

```bash
./scripts/ops/koszt-dwa-razy.sh
```

Skrypt najpierw czyta `KSEF_ENV` z kontenera aplikacji (koszt z faktury
z innego środowiska KSeF aplikacja pomija, skrypt też); gdy się nie uda,
przerywa i prosi o `--srodowisko test|demo|production`.

Domyślnie same liczby dla wszystkich firm: koszty przeczytane (gdy zero, skrypt
nic nie przeczytał, a nie „brak dubli”), firmy i grupy z odmową, wzory grup
(z KSeF i spoza KSeF, kopie spoza KSeF, same z KSeF, spoza KSeF z różnymi
kwotami i kolumnami), grupy z odmową i różną kwotą brutto (do sprawdzenia: mogą
być fałszywą odmową), firmy z odmową w okresie już złożonym, miesiące z odmową
i pary źródeł. Grupa to rok, tak jak w KPiR modułu i kartach kosztów; raport
KPiR, eksport i JPK_V7M czytają miesiąc albo okres zadania, więc odmawiają
tylko wtedy, gdy oba koszty są w tym samym okresie (liczba `miesiące z
odmową`). `--lista-firm` dopisuje id firm z odmową z liczbami (bez NIP-ów,
numerów i kwot). Jedna firma: `--firma <uuid>`; jej grupy z NIP-em, numerem
i kosztami: `--firma <uuid> --szczegoly` (szczegóły tylko dla jednej firmy).

Jak czytać szczegóły grupy (kolumny `nip`, `numer`, `rok`, `wzor`, `odmowa`,
`koszty`):

- `wzor` „z KSeF i spoza KSeF”, `odmowa` t: dubel FZ-022 (kopia spoza KSeF);
  klient wyłącza kopię;
- „kopie spoza KSeF”, t: ten sam dokument dwa razy spoza KSeF (ta sama kwota
  brutto albo kolumna; paragony: ten sam dzień i kwota);
- „same z KSeF”, f: dwa dokumenty z KSeF (np. faktura i korekta), odmowy nie ma;
- „spoza KSeF, różne kwoty i kolumny”, f: rozpisanie na kolumny albo różne
  paragony, odmowy nie ma;
- `koszty`: każdy koszt grupy jako id, źródło (`ksef`, `ocr_photo`, `manual`,
  `import`), data, brutto, kolumna KPiR i rodzaj dokumentu.

Różnice wobec aplikacji: skrypt nie odejmuje kosztów reprezentacji (odpadają
tylko w KPiR modułu), a wielkie litery w numerze daje `upper()` według
ustawień językowych bazy (przy kolacji „C” polskie litery zostają małe). „Okres już złożony” to co najmniej dwa koszty tej samej grupy
z odmową w jednym okresie udanego eksportu KPiR albo JPK_V7M albo przyjętej
wysyłki JPK na bramkę produkcyjną MF.

Wynik `--lista-firm` i `--szczegoly` zostaje w terminalu operatora: nie
wkleja się go do PR, dziennika, notatek ani na Telegram (repozytorium jest
publiczne, a szczegóły mają NIP-y i numery dokumentów). Do zgłoszenia
w Pomocy wystarczą id kosztów.

Fałszywa odmowa (dwa różne dokumenty z tym samym NIP-em, numerem i rokiem,
z których żaden nie jest kopią): zgłoszenie do zespołu z identyfikatorami
kosztów z zapytania. Numeru prawdziwego dokumentu nie zmienia się po to, żeby
ominąć odmowę.

## Przebiegi na produkcji

| Kiedy | Kod | Wynik | Wniosek |
|---|---|---|---|
| 23.11.2026 po 18:00 (Bartosz) | `main` z #839, bez opcji: wszystkie firmy, same liczby, KSeF `test` z kontenera aplikacji | koszty przeczytane 0, firmy z odmową 0, grupy 0, okresy złożone 0, pary źródeł brak | Odmowa wchodzi z nocnym wdrożeniem bez firm do kontaktu. `is_deductible` ma domyślnie TRUE (00034), więc 0 znaczy, że na produkcji nie ma kosztu spoza KSeF; pominięte z założenia są tylko koszty powiązane z fakturą KSeF z innego środowiska niż KSEF_ENV aplikacji (aplikacja też ich nie liczy). Przed zmianą KSEF_ENV aplikacji na `production` przebieg z `--srodowisko production`. |

## Fala odmów po wdrożeniu

Wyłącznika nie ma. Gdy odmów jest dużo i nie są dublami, decyzję podejmuje
Bartosz: cofnięcie PR i nocne wdrożenie (`docs/runbooks/nocne-wdrozenie.md`).

## Okresy już złożone z dublem

Przed tą zmianą KPiR (raport, eksport), karty i VAT modułu liczyły dubel dwa
razy. Ile firm ma co najmniej dwa koszty grupy z odmową w okresie z udanym
eksportem KPiR albo JPK_V7M albo z przyjętą wysyłką JPK modułu, pokazuje liczba
`firmy z odmową w okresie już złożonym`, a które to firmy: `--lista-firm`
(kolumna `okres_zlozony`). To firmy do kontaktu (korekta KPiR i JPK_V7M); kto
i jak mówi o tym firmom, decyduje Bartosz.
