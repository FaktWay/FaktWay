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

Zapytanie kontrolne, tylko odczyt, sesja z dostępem do bazy (firma z
`:tenant`; bez warunku na firmę: wszystkie firmy). Grupuje po kluczu
RP-KOSZT-01 i pokazuje każdy koszt grupy:

```sql
WITH k AS (
  SELECT id, tenant_id, issue_date, gross_amount, kpir_column,
         CASE WHEN source = 'ksef_inbox' OR ksef_invoice_id IS NOT NULL THEN 'ksef' ELSE source::text END AS zrodlo,
         coalesce(document_type, 'invoice') AS rodzaj,
         regexp_replace(coalesce(seller_nip, ''), '\D', '', 'g') AS nip,
         upper(regexp_replace(coalesce(document_number, ''), '\s', '', 'g')) AS numer
    FROM public.expenses
   WHERE is_deductible AND tenant_id = :tenant
)
SELECT tenant_id, nip, numer, extract(year FROM issue_date) AS rok, count(*) AS ile,
       count(*) FILTER (WHERE zrodlo = 'ksef') AS z_ksef,
       array_agg(format('%s %s %s brutto %s kol. %s', id, zrodlo, issue_date, gross_amount, coalesce(kpir_column, '-'))
                 ORDER BY issue_date) AS koszty
  FROM k
 WHERE length(nip) = 10 AND numer <> ''
 GROUP BY 1, 2, 3, 4
HAVING count(*) > 1
 ORDER BY 1, 2, 3, 4;
```

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
razy. Firmy do kontaktu (korekta KPiR i JPK_V7M) to te, u których grupa
FZ-022 z zapytania wyżej leży w okresie z udanym eksportem albo wysyłką JPK:

```sql
-- Dla grup FZ-022 z zapytania wyżej (bez warunku na firmę):
SELECT DISTINCT e.tenant_id, e.format, e.period_start, e.period_end
  FROM public.export_jobs AS e
 WHERE e.status = 'completed' AND e.format IN ('kpir_excel', 'jpk_v7m')
   AND EXISTS (SELECT 1 FROM public.expenses AS x
                WHERE x.tenant_id = e.tenant_id AND x.is_deductible
                  AND x.issue_date BETWEEN e.period_start AND e.period_end
                  AND (x.source = 'ksef_inbox' OR x.ksef_invoice_id IS NOT NULL)
                  AND EXISTS (SELECT 1 FROM public.expenses AS y
                               WHERE y.tenant_id = x.tenant_id AND y.is_deductible
                                 AND y.source <> 'ksef_inbox' AND y.ksef_invoice_id IS NULL
                                 AND regexp_replace(coalesce(y.seller_nip, ''), '\D', '', 'g') = regexp_replace(coalesce(x.seller_nip, ''), '\D', '', 'g')
                                 AND upper(regexp_replace(coalesce(y.document_number, ''), '\s', '', 'g')) = upper(regexp_replace(coalesce(x.document_number, ''), '\s', '', 'g'))
                                 AND extract(year FROM y.issue_date) = extract(year FROM x.issue_date)));
```

To samo dla wysyłek JPK modułu (`jpk_submissions`, okres z miesiąca
wysyłki). Kto i jak mówi o tym firmom, decyduje Bartosz.
