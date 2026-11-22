# Faktura w cenach brutto: wyłącznik

Plan cen brutto, reguła RP-FA-BRUTTO-01 (`filtr/przepisy/faktury.json`).
Liczenie w cenach brutto (`P_9B`, `P_11A`, VAT od sumy brutto stawki) jest
w kodzie, ale reguła ma wzorzec poziomu 5 i otwarte pytanie do księgowej.
Według B4.0, zasada 2 (`docs/koordynacja/PLAN-ZELAZNY-FILTR.md`), klienci
dostają ją tylko za wyłącznikiem.

| | |
|---|---|
| Flaga | `grossPricesEnabled` w `public.global_feature_flags` (db-1), bez migracji |
| Domyślnie | wyłączona: brak wiersza, `false`, zły typ albo błąd odczytu = wyłączone |
| Stan | `./scripts/ops/ceny-brutto.sh stan` |
| Włączenie | `./scripts/ops/ceny-brutto.sh wlacz --tak` |
| Wyłączenie | `./scripts/ops/ceny-brutto.sh wylacz --tak` |
| Kto decyduje | Bartosz, po odpowiedzi księgowej na pytanie z RP-FA-BRUTTO-01 |
| Kiedy działa | od następnego zapisu i wysyłki faktury: aplikacja i worker czytają flagę wprost z bazy (`getGlobalFlagForExecution`), bez pamięci podręcznej i bez wdrożenia |

Kod: `lib/invoices/ceny-brutto-wylacznik.ts`. Testy:
`tests/unit/ceny-brutto-wylacznik*.test.ts`.

## Co robi wyłącznik

Przy wyłączonym faktura z `pricesGross: true` dostaje odmowę z wyjściem
(faktura w cenach netto) w trzech miejscach po stronie serwera:

1. **Zapis zwykłej faktury** (`insertInvoiceAndLines`,
   `lib/invoices/issue-regular.ts`): szkic i „Wystaw i wyślij” ze strony
   i z telefonu, „Wystaw teraz” z faktury cyklicznej, faktura z proformy.
   Nic się nie zapisuje: bez numeru z serii, bez okresu faktury cyklicznej,
   bez kolejki.
2. **Kolejka wysyłki** (`enqueueKsefSubmitAfterDraft`): „Wyślij” przy
   szkicu (strona, telefon, API) i „Wyślij ponownie”, także gdy faktura
   w cenach brutto jest tylko w zapisanym `fa3_data`. Szkic zostaje
   szkicem, faktura z błędem wysyłki zostaje z błędem. Dziennik prób:
   `refused` z kodem `INVALID_DOCUMENT` (błąd odczytu flagi: `INFRA`).
3. **Job wysyłki** (`submitInvoiceFullFlow`): ostatnia bramka przed plikiem
   FA(3), archiwum i POST do KSeF, także dla ponowienia z kopii przez cron
   cyklu życia i operatora. Faktura kończy jako `failed` z kodem
   `INVALID_DOCUMENT` i tekstem „Faktura nie trafiła do KSeF. Faktura
   w cenach brutto nie jest jeszcze dostępna w FaktWay. Wystaw fakturę od
   nowa w cenach netto.”, z przyciskiem „Wróć do szkicu”.

Podkład z innej faktury („Duplikuj”, „Wystaw teraz”) z dokumentu w cenach
brutto (faktura FaktWay w cenach brutto albo import z `P_9B` bez ceny netto)
jest w cenach netto: pozycje bez ceny netto w dokumencie mają puste pole ceny,
nigdy 0 zł, a nad formularzem jest komunikat. Baner „Wypełnij z ostatniej
faktury” takiego podkładu nie podsuwa. Formularz faktury (PR (b)) nie ma
wtedy wyboru „Ceny brutto”, faktura do paragonu zostaje w cenach netto,
a schemat formularza odmawia faktury w cenach brutto z tym samym tekstem co
zapis.

Przy włączonym formularz ma wybór „Ceny netto / Ceny brutto” w sekcji
„Pozycje”, faktura do paragonu przy pozycjach bez ceny netto przechodzi na
ceny brutto, a podkład z dokumentu w cenach brutto (faktura z `pricesGross`
albo każda pozycja bez ceny netto z `P_9B`) wraca w cenach brutto z ceną
brutto z dokumentu, także w banerze „Wypełnij”. Dokument z pozycjami w cenach
netto i w cenach brutto zostaje w cenach netto z pustą ceną i komunikatem.

Bez zmian przy wyłączonym:

- faktura w cenach netto, także faktura do paragonu (FP) w cenach netto
  (flaga nie jest wtedy czytana);
- import faktur z KSeF z `P_9B` (dokumenty wystawione przez inne programy);
- PDF, szczegóły, strona nabywcy i JPK_FA faktur w cenach brutto, które już
  są w bazie;
- „Sprawdź ponownie” (uzgodnienie nic nie wysyła) i uzgodnienie
  wcześniejszej wysyłki w jobie.

Błąd odczytu flagi (baza niedostępna): zapis i kolejka odmawiają z prośbą
o ponowienie, job ponawia próbę. Awaria bazy nie włącza faktury w cenach
brutto.

## Kto decyduje i kiedy włączyć

Włącza wyłącznie Bartosz. Warunki, wszystkie naraz:

1. **Odpowiedź księgowej** na pytanie z RP-FA-BRUTTO-01
   (`docs/filtr/PYTANIA-Z-REJESTRU.md`): kształt pliku (same `P_9B`
   i `P_11A` czy także `P_9A` i `P_11`), VAT od sumy brutto stawki czy przy
   pozycjach, JPK_FA, stawki bez podatku. Jeśli odpowiedź zmienia kształt
   pliku albo liczenie, najpierw ta poprawka (PR R1), potem włączenie.
   Odpowiedź trafia do rejestru (`sprawdzil.ksiegowa`, pewność, wzorzec)
   zmianą z etykietą `zgoda:wiedza-prawna`.
2. **Formularz faktury w cenach brutto** (plan cen brutto, PR (b)) jest
   w `main` i wdrożony; metodę „Ceny brutto” pokazuje tylko przy włączonym
   wyłączniku (`cenyBruttoDostepne()`).
3. **Poprawka telefonu** (plan aplikacji mobilnej): dziś kopia, wzór
   i szczegóły faktury w cenach brutto dają na telefonie cenę 0,00
   (`mobile/src/lib/dane/mapowanie.ts`, `faktury/nowa/[rodzaj].tsx`),
   a faktura na 0 zł przechodzi. Serwer nie przyjmie z telefonu faktury
   w cenach brutto, ale kopia takiej faktury na telefonie dałaby fakturę na
   0 zł. Bez tej poprawki wyłącznik zostaje wyłączony.
4. **Próba na KSeF TEST** (punkt 2 w „Jak sprawdzić po włączeniu”)
   przyjęta, zanim pierwsza faktura w cenach brutto pójdzie na produkcji.

## Jak włączyć

Najpierw stan:

```bash
./scripts/ops/ceny-brutto.sh stan
```

Oczekiwane: `brak wiersza = wyłączone` albo `wyłączone | …`. Potem
włączenie:

```bash
./scripts/ops/ceny-brutto.sh wlacz --tak
```

Skrypt zapisuje wiersz flagi (`INSERT … ON CONFLICT (flag) DO UPDATE`,
z `updated_by` i notatką) i pokazuje stan po zmianie. Bez `--tak` tylko
pokazuje stan.

## Jak sprawdzić po włączeniu

1. `./scripts/ops/ceny-brutto.sh stan` pokazuje
   `włączone | <czas> | operator: ceny-brutto.sh | …`.
2. Na środowisku z `KSEF_ENV=test`: faktura ze strony w cenach brutto
   z przypadku rejestru (trzy pozycje po 1,00 zł przy 23 %: VAT 0,56,
   netto 2,44, `P_15` 3,00). KSeF ją przyjmuje, PDF i szczegóły pokazują
   ceny brutto, JPK_FA za ten miesiąc ją zawiera.
3. Sentry: brak alarmu `FILTR-RT-FA3-*` dla tej faktury (strażnik FA(3)).
4. Druga tabela `stan`: faktury w cenach brutto według stanu wysyłki
   (po próbie `accepted`).
5. Wiersz w dzienniku planu kompletnej aplikacji (sekcja 12): data,
   decyzja i numer faktury próbnej.

## Wyłączenie

```bash
./scripts/ops/ceny-brutto.sh wylacz --tak
```

Działa od następnego zapisu i wysyłki. Nowe faktury w cenach brutto dostają
odmowę z wyjściem. Faktur przyjętych przez KSeF wyłącznik nie zmienia.
Szkice w cenach brutto zostają szkicami: „Wyślij” odmawia, klient wystawia
fakturę od nowa w cenach netto. Faktury w kolejce albo w ponowieniu kończą
w jobie jako `failed` `INVALID_DOCUMENT`, chyba że ich plik doszedł już do
KSeF: wtedy job uzgadnia tamtą wysyłkę zamiast wysyłać nową, więc wyłącznik
ich nie zatrzymuje. Co jest w drodze: druga tabela `stan` (`queued`,
`sending`, `failed`).

Wiersz flagi (jest dopiero po pierwszym `wlacz --tak` albo `wylacz --tak`)
pokazuje też `./scripts/ops/kontrola-go-live-ksef.sh` (sekcja 2, wszystkie
flagi globalne).
