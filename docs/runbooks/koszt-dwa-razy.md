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
`scripts/ops/koszt-dwa-razy.sql`, ta sama reguła co odczyty aplikacji):

```bash
./scripts/ops/koszt-dwa-razy.sh
```

Domyślnie same liczby dla wszystkich firm: firmy i grupy z odmową, wzory grup
(z KSeF i spoza KSeF, kopie spoza KSeF, same z KSeF, spoza KSeF z różnymi
kwotami i kolumnami), pary źródeł, grupy z odmową i różną kwotą brutto (do
sprawdzenia: mogą być fałszywą odmową) i firmy z odmową w okresie już
złożonym. `--lista-firm` dopisuje id firm z odmową z liczbami (bez NIP-ów,
numerów i kwot). Jedna firma: `--firma <uuid>`; jej grupy z NIP-em, numerem, kwotami
i kosztami (id, źródło, data, brutto, kolumna, rodzaj): `--firma <uuid>
--szczegoly` (szczegóły tylko dla jednej firmy).

Jak czytać grupę:

- `z_ksef` od 1 do `ile - 1`: dubel FZ-022 (kopia spoza KSeF); klient
  wyłącza kopię;
- `z_ksef` równe `ile`: dwa dokumenty z KSeF, odmowy nie ma;
- bez kosztu z KSeF: dubel tylko przy tej samej kwocie brutto albo kolumnie
  (paragony: ten sam dzień i kwota); pozostałe grupy to rozpisanie na
  kolumny albo różne paragony i odmowy nie dają.

Fałszywa odmowa (dwa różne dokumenty z tym samym NIP-em, numerem i rokiem,
z których żaden nie jest kopią): zgłoszenie do zespołu z identyfikatorami
kosztów z zapytania. Numeru prawdziwego dokumentu nie zmienia się po to, żeby
ominąć odmowę.

## Fala odmów po wdrożeniu

Wyłącznika nie ma. Gdy odmów jest dużo i nie są dublami, decyzję podejmuje
Bartosz: cofnięcie PR i nocne wdrożenie (`docs/runbooks/nocne-wdrozenie.md`).

## Okresy już złożone z dublem

Przed tą zmianą KPiR (raport, eksport), karty i VAT modułu liczyły dubel dwa
razy. Ile firm ma grupę z odmową w okresie z udanym eksportem KPiR albo
JPK_V7M albo z przyjętą wysyłką JPK modułu, pokazuje ostatnia liczba skryptu
(`firmy z odmową w okresie już złożonym`), a które to firmy: `--lista-firm`
(kolumna `okres_zlozony`). To firmy do kontaktu (korekta KPiR i JPK_V7M); kto
i jak mówi o tym firmom, decyduje Bartosz.
