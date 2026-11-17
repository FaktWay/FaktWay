# Ten sam dokument kosztu dwa razy (FZ-022)

Reguła RP-KOSZT-01, kod `lib/expenses/jeden-koszt-dokumentu.ts`, ustalenie
FZ-022 w `docs/filtr/USTALENIA.md`.

## Co widzi klient

Raport KPiR, eksport KPiR (Centrum eksportu, portal księgowej), VAT modułu
księgowości i karty kosztów Pulpitu, Przepływów i Analiz odmawiają z treścią
„Ten sam dokument jest w kosztach więcej niż raz: {numer} z {data} ({ile}
razy: {źródła}) …”, gdy w odczytywanym okresie ten sam dokument jest:

- fakturą z KSeF i kosztem spoza KSeF (zdjęcie, wpis ręczny, import), albo
- dwa razy spoza KSeF z tą samą kwotą brutto (np. zdjęcie wgrane dwa razy).

Dokument to: faktura po NIP-ie sprzedawcy, numerze i roku wystawienia;
paragon po NIP-ie, numerze, dniu i kwocie brutto. Inne okresy liczą się jak
dotąd. Odmowy nie ma przy dwóch kosztach z KSeF (dla KSeF to dwa dokumenty)
ani przy kosztach spoza KSeF z różnymi kwotami (jedna faktura rozpisana na
kolumny KPiR).

## Wyjście klienta

W Kosztach (przycisk „Koszty” w historii eksportu i „Koszty miesiąca” przy
raporcie KPiR prowadzą do miesiąca) przy kopii wyłącza się „Uwzględnij
w KPiR”:

- koszt ze zdjęcia albo wpisany ręcznie: formularz kosztu;
- koszt z KSeF: przegląd kosztu KSeF (RPC `review_ksef_expense`), gdy to on
  jest zbędny (rzadko: koszt z KSeF ma numer KSeF potrzebny w JPK_V7M).

Gdy kopia spoza KSeF ma źle odczytany numer i to inny dokument, poprawia się
numer w formularzu kosztu.

## Ścieżka operatora (zgłoszenie w Pomocy)

Zapytanie kontrolne, tylko odczyt, sesja z dostępem do bazy (firma z
`:tenant`; bez warunku na firmę: wszystkie firmy):

```sql
WITH k AS (
  SELECT id, tenant_id, source, ksef_invoice_id, issue_date, gross_amount,
         regexp_replace(coalesce(seller_nip, ''), '\D', '', 'g') AS nip,
         upper(regexp_replace(coalesce(document_number, ''), '\s', '', 'g')) AS numer,
         coalesce(document_type, 'invoice') AS rodzaj
    FROM public.expenses
   WHERE is_deductible AND tenant_id = :tenant
)
SELECT tenant_id, nip, numer, extract(year FROM issue_date) AS rok,
       count(*) AS ile,
       count(*) FILTER (WHERE source = 'ksef_inbox' OR ksef_invoice_id IS NOT NULL) AS z_ksef,
       array_agg(id ORDER BY issue_date) AS koszty
  FROM k
 WHERE length(nip) = 10 AND numer <> '' AND rodzaj NOT IN ('receipt', 'simplified_invoice')
 GROUP BY 1, 2, 3, 4
HAVING count(*) > 1;
```

Grupa z `z_ksef` od 1 do `ile - 1` to dubel FZ-022: klient wyłącza kopię
spoza KSeF. Grupa bez kosztu z KSeF to dubel tylko przy tej samej kwocie
brutto (zapytanie pokazuje też rozpisanie na kolumny, które odmowy nie daje).
Paragony z NIP-em z odczytu OCR zapisane jako `invoice` zapytanie liczy jak
faktury; o dublu paragonu decyduje dzień i kwota.

Fałszywa odmowa (dwa różne dokumenty z tym samym NIP-em, numerem i rokiem,
które nie są kopią): zgłoszenie do zespołu z identyfikatorami kosztów
z zapytania; klient może do tego czasu poprawić numer kopii spoza KSeF.

## Fala odmów po wdrożeniu

Wyłącznika nie ma. Gdy odmów jest dużo i nie są dublami, decyzję podejmuje
Bartosz: cofnięcie PR i nocne wdrożenie (`docs/runbooks/nocne-wdrozenie.md`).

## Okresy już złożone z dublem

Przed tą zmianą KPiR (raport, eksport), karty i VAT modułu liczyły dubel dwa
razy. Okresy z udanym eksportem KPiR albo JPK i z wysyłką JPK modułu, w
których jest grupa FZ-022, to firmy do kontaktu (korekta KPiR i JPK_V7M);
kto i jak im to mówi, decyduje Bartosz. Zapytanie: jak wyżej, z warunkiem
`issue_date` w okresach z `export_jobs` o stanie `completed` (formaty
`kpir_excel` i `jpk_v7m`) i z `jpk_submissions` firmy.
