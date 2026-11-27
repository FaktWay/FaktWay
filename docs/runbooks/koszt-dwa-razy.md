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

## Łączenie kopii z kosztem z KSeF (decyzja D29, 00215)

Za przełącznikiem `KOSZTY_LACZ_KOPIE_KSEF=true` w workerze (domyślnie
wyłączony). **Włączać dopiero po potwierdzeniu Bartosza i księgowej i tylko
przy `KSEF_ENV=production`.** Interfejs (PR z interfejsem D29) jest gotowy: na
stronie kosztu z KSeF zadanie „Połącz koszty” z wyborem kopii i „To osobne
dokumenty”, przy połączeniu „Rozłącz”; przy kopii informacja z odesłaniem do
faktury z KSeF i zablokowane „Uwzględnij w KPiR”; w Skrzynce KSeF dopisek
„Kopia w kosztach: do decyzji”, na liście kosztów dopisek „Kopia faktury
z KSeF”. Bez przełącznika nic się nie łączy i zostaje odmowa opisana wyżej;
wyłączenie przełącznika nie cofa połączeń, które już są.

Same nie połączą się (zostaje odmowa i jej wyjście): pary sprzed włączenia
przełącznika, pary po błędzie łączenia w runnerze zdjęć, kopie wpisane po
koszcie z KSeF, koszt z KSeF w walucie obcej (powstaje poza KPiR, a po
przeglądzie waluty nic się już nie uruchamia) i druga kopia, gdy pierwsza jest
już połączona (zostaje w KPiR, więc odmowa wraca; wyjście „Uwzględnij
w KPiR”).

Po zapisie kosztu runner Skrzynki (`auto-categorize-inbox`, także przy
ponowieniu, gdy koszt już jest) i runner zdjęć (`process-ocr`) wołają
`link_ksef_expense_copy` ze środowiskiem KSeF aplikacji. Baza liczy klucz
dokumentu jak odczyt (NIP z 10 cyfr, numer bez odstępów wielkimi literami,
rok wystawienia; odstępy tą samą klasą co zapytanie operatora niżej, a rzadki
rozjazd `upper` bazy i JS daje tylko brak połączenia) i:

- łączy, gdy jest dokładnie jeden koszt z KSeF tego dokumentu z faktury
  przyjętej w środowisku aplikacji i dokładnie jedna kopia spoza KSeF z tym
  samym brutto, oba liczą się dziś w KPiR, a miesiąc wystawienia żadnego z nich
  nie jest złożony. Kopia zostaje na liście, ale wypada z KPiR i odliczenia
  (`is_deductible = false`, wartość sprzed połączenia w
  `expense_ksef_copies.copy_was_deductible`); kategoria nadana kopii ręcznie
  przechodzi na koszt z KSeF, chyba że jemu też nadano ją ręcznie. Audyt:
  `expense.ksef_copy_linked`;
- przy kilku kopiach, innym brutto, kopii czekającej już na decyzję albo
  miesiącu złożonym zapisuje zadanie (`candidate`; audyt
  `expense.ksef_copy_candidates` z przyczyną `several_copies`,
  `amount_differs`, `pending_decision` albo `filed_period` i miesiącami), a
  odmowa odczytu zostaje do decyzji klienta. Koszt z KSeF się nie zmienia;
- nie łączy przy dwóch kosztach z KSeF z tym samym numerem, koszcie z KSeF
  z faktury z innego środowiska (np. TEST po przejściu na PROD), kopii
  wyłączonej już przez klienta i koszcie z KSeF poza KPiR (np. przegląd waluty).

Miesiąc złożony: rozliczenie w module zależne od kosztów (`tax_settlements`:
zaliczka PIT, VAT, składka zdrowotna), wysyłka JPK_V7M z FaktWay na bramkę
produkcyjną w każdym stanie poza odrzuconą i przerwaną albo udany eksport KPiR
lub JPK_V7M za okres z tym miesiącem. Zapytanie operatora niżej liczy „okresy
złożone” węziej (tylko eksporty i przyjęta wysyłka). Miesiące późniejsze nie są
sprawdzane (zaliczka PIT narastająco, nadwyżka VAT z poprzedniej deklaracji):
pytanie do księgowej przed włączeniem.

Decyzja klienta (`decide_ksef_expense_copy`, akcja serwerowa po MFA
`app/actions/kopia-faktury-ksef.ts`): wybór kopii z zadania łączy ją (tylko w środowisku faktury
kosztu z KSeF), „to osobne koszty” albo „Rozłącz” przywraca kopię do KPiR
(w każdym środowisku, więc para sprzed zmiany `KSEF_ENV` ma wyjście) i zostaje
śladem (`dismissed`), więc ponowienie runnera jej nie łączy. Uwaga: odczyt
okresu nie zna `expense_ksef_copies`, więc odmawia dalej, gdy oba koszty liczą
się w KPiR: po „to osobne koszty” i „Rozłącz” oraz po wyborze jednej kopii
(pozostałe kandydatki zostają w KPiR razem z kosztem z KSeF); wyjście
„Uwzględnij w KPiR” przy kopii albo poprawienie numeru lub daty w kopii (ekran
mówi tylko o numerze), a czy odczyt ma pomijać takie pary, rozstrzyga sesja decyzji
(do tego czasu bez zmiany odczytu). Po „Rozłącz” koszt z KSeF zostaje z kategorią przejętą od
kopii; poprzednia jest w audycie (`ksefCategoryBefore`). Strażnik
`b_guard_linked_ksef_copy_expense` nie pozwala klientowi wliczyć połączonej
kopii do KPiR inaczej niż przez „Rozłącz”.

Skutki uboczne do wiedzy operatora: połączenie zmienia `is_deductible` kopii
(a przy przejęciu kategorii także kolumnę i nazwę kategorii kosztu z KSeF),
więc akceptacja księgowej tych kosztów (00214) pokaże „Zmieniony po
akceptacji”; karta FLO przy zdjęciu (FLO dziś niezamontowany) powstaje
z odliczeniem sprzed połączenia; faktura do paragonu (00175) nie wyklucza kopii
połączonych tutaj (rzadki przypadek: faktura uproszczona w KSeF, jej zdjęcie
i faktura do paragonu za ten sam zakup).

Przed zmianą `KSEF_ENV` (np. TEST na PROD) rozłączyć pary, których koszt
z KSeF jest z faktury z innego środowiska niż nowe (po zmianie odczyt pominie
koszt z KSeF, a kopia jest poza KPiR, więc dokument zniknąłby z KPiR):

```sql
SELECT m.tenant_id, m.ksef_expense_id, m.copy_expense_id, i.ksef_environment
  FROM public.expense_ksef_copies AS m
  JOIN public.expenses AS e ON e.id = m.ksef_expense_id
  JOIN public.invoices AS i ON i.id = e.ksef_invoice_id
 WHERE m.status = 'linked' AND i.ksef_environment <> '<nowe środowisko>';
```

Klient rozłącza sam („Rozłącz” na stronie kosztu z KSeF). Rozłączenie przez
operatora tylko w wyjątkach (np. firma bez dostępu do aplikacji); `<osoba>` to
aktywny członek firmy, który zgłosił sprawę, i na niego zapisze się decyzja
w audycie; `<środowisko>` to `KSEF_ENV` aplikacji, a rozłączenie działa przy
każdym. Przy zasadzie „przełącznik tylko przy produkcji” pary z innego
środowiska nie powstają, więc zbiorczego rozłączania nie przewidujemy:

```sql
SET ROLE service_role;
SELECT public.decide_ksef_expense_copy('<firma>', '<koszt z KSeF>', '<osoba>', '<środowisko>', NULL);
```

Ponowienie: drugie wywołanie zwraca `already_linked`, `candidates` bez nowych
wierszy albo `dismissed`. W runnerze Skrzynki błąd łączenia zostawia znacznik
`_pendingFullFetch`, a ponowienie (pg-boss albo cron uzupełniający) przechodzi
gałęzią „koszt już jest” i łączy. Przy trwałym błędzie łączenia znacznik zostaje,
a po 6 próbach crona uzupełniającego jego alarm mówi o fakturach „bez kosztu lub
XML” (koszt jest): wtedy Sentry z `link-ksef-copy` pokaże przyczynę, a do jej
usunięcia przełącznik można wyłączyć (znacznik zgaśnie przy następnym
przebiegu). W runnerze zdjęć błąd idzie tylko do logu i Sentry (`step:
link-ksef-copy`), bo koszt ze zdjęcia jest zapisany, a odmowa odczytu i tak
chroni KPiR i JPK.

Sprawdzenie stanu firmy (tylko odczyt):

```sql
SELECT status, count(*) FROM public.expense_ksef_copies WHERE tenant_id = '<firma>' GROUP BY status;
```

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
