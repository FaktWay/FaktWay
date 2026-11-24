# Plan kompletnej aplikacji: FaktWay jako pełny program do faktur i księgowości małej firmy

> **Stan: plan przyjęty.** Bartosz 8.11.2026 przyjął wszystkie rekomendacje
> z sekcji 6 („tak przyjmuje”). Zlecenie Bartosza z 8.11.2026: „pełnoprawny
> program »księgowy«, który ma wszystkie funkcje poza openbankingiem,
> magazynem, integracjami ze sklepami i rzeczami, które dotyczą ogromnych
> firm”, „nic nie odkładaj na później”, „prostym, opisowym językiem”.
>
> Hasło sesji: „Kontynuuj plan kompletnej aplikacji” (tabela haseł
> w `AGENTS.md`, krok 0.1). Każda sesja robi jeden krok z „Następnego kroku”
> (dziennik w sekcji 12), składa raport i STOP.
>
> Odczyt kodu: `origin/main` @ `279e2b4c` (8.11.2026). Przepisy: źródła
> urzędowe odczytane 8.11.2026 (sekcja 11). Aplikacje w App Store i Google Play
> są poza tym planem (Bartosz: „zrobimy potem”).

---

## Najkrócej

1. **Co już działa.** FaktWay wystawia faktury w KSeF (zwykłe, zaliczkowe,
   korekty), odbiera faktury zakupu ze skrzynki KSeF z powiadomieniem
   w telefonie, czyta koszty ze zdjęć, pilnuje należności (lista po terminie,
   „zapłacone”, przypomnienia, wezwania), ma raporty, import z czterech
   programów, dostęp dla księgowej, wiele firm na jednym koncie, zespół
   z rolami, logowanie dwuskładnikowe i biometrię. Moduł księgowości JDG
   (ryczałt, skala, liniowy, ZUS, zdrowotna, VAT, KPiR, JPK) jest gotowy, ale
   klienci go nie widzą do bramy prawnej.

2. **Część rzeczy, które uchodzą za gotowe, jest w kodzie wyłączona:**
   - korekty nie wychodzą do KSeF produkcyjnego, a faktury końcowe nie
     wychodzą nigdzie (blokady do czasu napraw z planu „zero zgubionych
     faktur”, sesje C1-C4);
   - tryb offline24 jest wyłączony wszędzie, a drugi kod QR (CERTYFIKAT) nie
     działa;
   - eksport JPK_V7M i eksporty dla Optimy, Symfonii, Wapro i Subiekta są
     wstrzymane.

   Kompletny program zaczyna się od ich domknięcia.

3. **Najwięcej brakuje w samych fakturach i pieniądzach, nie w księgowości:**
   - faktury tylko w złotych i po polsku, bez sprzedaży WDT i eksportu, bez
     proformy, faktury do paragonu, faktury uproszczonej i VAT marży;
   - jedna numeracja bez serii, produktów nie da się wybrać w formularzu,
     brak logo sprzedawcy;
   - brak wpłat częściowych w interfejsie, importu wyciągu, linku do
     płatności, terminów i zapłaty faktur kosztowych, not odsetkowych i API;
   - kosztu nie da się wpisać ręcznie ani przysłać mailem, a księgowa
     w swoim portalu nie widzi kosztów.

4. **Dwie rzeczy mają termin 1 stycznia 2027 r. i idą na początek:**
   - faktura do paragonu w KSeF: faktury z kasy i paragony z NIP jako faktury
     uproszczone są dozwolone tylko do końca 2026 r. (MF), a projekt zmiany
     rozporządzenia o kasach zabiera kasom faktury od 2027 r.;
   - numer KSeF w tytule przelewu między firmami (płatności od 1.01.2027).

5. **W księgowości brakuje:** rozliczeń kwartalnych, kasowego PIT, Małego ZUS
   Plus, wakacji składkowych, deklaracji DRA, VAT od transakcji z zagranicą
   (pełny JPK_V7, VAT-UE, VAT-8, VAT-9M), samochodu w firmie, środków trwałych
   z JPK_ST, zeznań rocznych z wysyłką i rocznej składki zdrowotnej.

6. **Plan ma 10 etapów i 60 kroków, razem ok. 100-120 PR.** Kolejność:
   (0) start, (1) fundament faktur i obowiązki od 2027 r., (2) faktury,
   (3) pieniądze, (4) księgowość w ciągu roku, (5) środki trwałe i rok,
   (6) księgowa i przeprowadzka, (7) API, (8) wygoda, (9) rzeczy z decyzji
   granicznych. Dla porównania: plan księgowości (K0-K8, ok. 17 PR) zajął
   4 dni (5-8.11.2026). Tempo wyznaczą bardziej prawnik i księgowa niż kod.

7. **Decyzje (sekcja 6):** sześć spraw na granicy zakresu (import wyciągu,
   linki do płatności, kadry i płace, pełna księgowość spółek, OSS, kasy
   fiskalne) i jedenaście mniejszych. Bartosz przyjął wszystkie rekomendacje
   8.11.2026.

8. **Prawo.** Prawie każdy krok to według mapy żelaznego filtra poziom R1
   (faktura, KSeF, JPK, podatek, termin, przechowywanie), więc przechodzi
   pełną kontrolę filtra (sekcja 8). Wszystko z modułu księgowości trafia do
   klientów dopiero po bramie z planu księgowości (spółka, prawnik, OC,
   księgowa, pilotaż). Nowe pytania do prawnika i nowe przykłady dla
   księgowej: sekcja 7.

9. **Na czym sprawdzimy wynik.** Przy każdym kroku z ryzykiem plan podaje
   wzorzec (np. testowy KSeF, bramka testowa MF, e-mikrofirma, e-Płatnik,
   API NBP, urzędowe przykłady, księgowa) i to, czego jeszcze brakuje, żeby
   go użyć (sekcja 8.1). Kadry i płace, pełna księgowość spółek, porównanie
   form opodatkowania i kilka mniejszych rzeczy nie mają takiego wzorca: plan
   mówi to wprost jako ryzyko (sekcja 8.2).

---

## 1. Zakres

**Wchodzi:** wszystko, czego mała firma w Polsce potrzebuje do faktur,
pieniędzy i własnej księgowości:
- JDG na ryczałcie, skali i podatku liniowym, z VAT i zwolniona z VAT;
- klienci w kraju i za granicą, sprzedaż w złotych i w walutach;
- samochód i środki trwałe w firmie;
- rozliczenia miesięczne, kwartalne i roczne, ZUS i składka zdrowotna;
- księgowa klienta, przeprowadzka z innego programu, archiwum i kontrola
  skarbowa;
- API dla tych, którzy chcą coś zautomatyzować.

**Poza zakresem (decyzja Bartosza z 8.11.2026):**
- openbanking: połączenie z bankiem przez API (PSD2) i płacenie z aplikacji;
- magazyn: stany, dokumenty PZ i WZ, inwentaryzacja magazynu;
- integracje ze sklepami: Allegro, BaseLinker, WooCommerce, Shopify,
  PrestaShop;
- funkcje dla dużych firm, np. transport (SENT, e-TOLL, CMR), e-commerce
  (IOSS, wiele magazynów), opakowania i BDO;
- aplikacje w App Store i Google Play (osobny tor po tym planie).

**Na granicy:** import pliku z banku, linki do płatności, kadry i płace,
pełna księgowość spółek, OSS i kasy fiskalne. Plan opisuje każdą z tych
rzeczy i daje rekomendację, a o tym, czy wchodzą, decyduje Bartosz (sekcja 6).

---

## 2. Co FaktWay umie dziś (z kodu, 8.11.2026)

Oznaczenia: **jest**, **częściowo** (działa, ale z ograniczeniem), **brak**.
Ścieżki plików są dowodem; pełne raporty spisu z 8.11.2026 leżą w notatkach
sesji (poza repo, plik `SPIS-KODU-2026-11-08.md`).

### 2.1 Faktury i KSeF

| Obszar | Stan | Szczegóły i dowód |
|---|---|---|
| Faktura VAT krajowa | jest | nabywca: firma z NIP, osoba prywatna, firma z UE z numerem VAT-UE (`components/invoices/invoice-form-parts/constants.ts:42`) |
| Stawki | częściowo | 23, 8, 5, 0 (tylko krajowe), zw, oo, np, np II (`lib/xml/fa3-p12.ts:22-46`); brak WDT i eksportu 0 % (`lib/xml/fa3-generator.ts:57-66`) |
| Zaliczkowa | częściowo | jedna stawka na fakturę; „zw” odrzucane jako „MVP nieobsługiwane” (`lib/ksef/fa3-advance-generator.ts:201`) |
| Końcowa (rozliczeniowa) | częściowo | formularz i XML są, wysyłka wstrzymana we wszystkich środowiskach (`lib/ksef/kind-holds.ts:31-33`) |
| Korekta | częściowo | trzy rodzaje (było/jest, kwotowa, anulowanie), tylko do zwykłej faktury; na KSeF produkcyjnym wstrzymana (`lib/ksef/kind-holds.ts:18-20`); korekta zaliczkowej i końcowej: brak |
| Uproszczona, proforma, do paragonu, VAT marża, samofakturowanie, JST i podmiot trzeci, załącznik, VAT RR | brak | marża jawnie odrzucana (`lib/xml/fa3-generator.ts:463`); P_17 zawsze „nie”; JST i GV na sztywno „nie” (`components/invoices/actions.ts:277`) |
| Adnotacje | częściowo | MPP (P_18A) z podpowiedzią powyżej 15 000 zł; metoda kasowa z ustawień; zwolnienie z podstawą; odwrotne obciążenie tylko automatycznie przy „oo” i „np II” |
| Waluty i języki | brak | KodWaluty zawsze PLN, PDF tylko po polsku (`lib/pdf/invoice-renderer.ts`), `lib/i18n` ma tylko odmianę liczebników |
| PDF | częściowo | jest, z kodem QR weryfikującym (KOD I); bez logo sprzedawcy |
| Numeracja | częściowo | jedna podpowiedź (licznik +1) tylko dla zwykłej faktury; brak serii (`lib/invoices/next-number.ts`) |
| Produkty | częściowo | tabela `products` z ceną, j.m., PKWiU i GTU (00013) wypełniana tylko importem; brak ekranu i podpowiedzi w formularzu; GTU nie trafia do XML |
| Kontrahenci | częściowo | GUS jest; status na białej liście jest; sprawdzenie rachunku na białej liście napisane, ale niepodpięte; VIES tylko w walidacji, nie w formularzu |
| KSeF: wysyłka i odbiór | jest | sesja interaktywna, UPO (XML i PDF), skrzynka co 15 minut, synchronizacja historii; brak sesji wsadowej |
| KSeF: tryby szczególne | brak | offline24 wyłączony wszędzie (`lib/ksef/offline24-policy.ts`), PDF faktury offline odmawiany, certyfikat typu Offline odrzucany; brak trybu awaryjnego i niedostępności; jest baner z Latarni MF |
| KSeF: podłączenie | częściowo | certyfikat przez kreator; token KSeF obsłużony w kodzie bez ekranu; brak zarządzania uprawnieniami i drogi bez plików |
| Wysyłka do nabywcy | częściowo | mail z PDF (limit 30 na godzinę); brak portalu albo linku dla nabywcy; brak wysyłki zbiorczej (jest ZIP do 100 PDF) |
| Szkice, „Duplikuj” | jest | autozapisu szkicu brak |
| Data wystawienia | ograniczenie | wysyłka tylko z dzisiejszą datą (`lib/invoices/issue-date.ts`) |

### 2.2 Pieniądze, koszty, raporty i eksporty

| Obszar | Stan | Szczegóły i dowód |
|---|---|---|
| „Zapłacone” | jest | RPC `mark_invoice_paid` z cofnięciem (00158), zawsze cała pozostała kwota, tylko faktury sprzedaży |
| Wpłaty częściowe | częściowo | status `partial` jest, kwotę częściową wpisze tylko karta FLO; tabela wpłat zamknięta dla klienta (00074), listy wpłat brak |
| Lista „po terminie” | jest | do 100 faktur, tylko w złotych i z bieżącego środowiska KSeF |
| Przypomnienia i wezwania | jest | trzy etapy (domyślnie 3, 7 i 14 dni po terminie), tylko mail; cron proponuje, wysyła człowiek (świadomie: `lib/jobs/runners/reminder-scheduler.ts:11-14`); pauza dla faktury i kontrahenta; wezwanie do zapłaty w PDF ze zdaniem o rekompensacie |
| Odsetki i noty odsetkowe | brak | kalkulator odsetek wyłączony, stawki niesprawdzone (`lib/flo/interest.ts:38`) |
| Faktury cykliczne | częściowo | program przypomina i wypełnia formularz, wystawia człowiek |
| Wyciąg bankowy | brak | tabela `payment_imports` gotowa bez interfejsu (00074), projekt w `PLAN-FINORA.md` (N5) |
| Link do płatności | brak | pole `linkPlatnosci` zawsze puste; Stripe tylko do abonamentu FaktWay |
| Koszty: skąd | częściowo | z KSeF program sam tworzy wydatek (`lib/jobs/runners/auto-categorize-inbox.ts`); zdjęcie albo PDF (do 40 odczytów dziennie na firmę), także udostępnione z telefonu; wpisu ręcznego brak (poza wpisami w module księgowości); faktur z maila brak; zakupy z historii KSeF trafiają tylko do archiwum, bez kosztu |
| Koszty: opis | częściowo | kategorie z regułami, które uczą się z poprawek klienta; kolumny KPiR; kurs NBP dla walut; prosta akceptacja („Do opisania”, „Zaakceptuj”); VAT do odliczenia tylko całość albo zero (bez 50 % przy samochodzie) |
| Koszty: termin i zapłata | brak | tabela `expenses` nie ma tych kolumn; projekt N7 w `PLAN-FINORA.md` |
| Raporty i analizy | jest | Pulpit, Przepływy (z „Odłóż na podatek” albo limitem zwolnienia z VAT), Analizy sprzedaży i kosztów, KPiR za miesiąc, „Twój rok w liczbach” |
| Paczka dla księgowej | jest | Co-Pilot: w wybrany dzień miesiąca paczka mailem do księgowej (klient włącza) |
| Eksporty | częściowo | JPK_FA(4), KPiR (Excel, 17 kolumn) i CSV są; JPK_V7M, Optima, Symfonia, Wapro i Subiekt wstrzymane (`lib/exports/suspended-formats.ts`); waluty odrzucane (`lib/exports/currency-guard.ts`) |
| Import z innych programów | częściowo | CSV z Fakturowni, inFaktu, wFirmy i IFIRMY: faktury sprzedaży, kontrahenci i produkty; kosztów nie; historia z KSeF od 2022 r. pobierana sama co 15 minut |

### 2.3 Księgowość JDG (plan K0-K8, za wyłącznikiem)

Szczegóły w `docs/koordynacja/PLAN-KSIEGOWOSC-JDG.md`. W skrócie:
- ustawienia podatkowe z historią; ryczałt (wszystkie stawki, próg najmu),
  skala i liniowy;
- ZUS: ulga na start, preferencyjny, pełny, „etat obok”, chorobowe; składka
  zdrowotna dla trzech form;
- ewidencja przychodów i KPiR według wzoru 2026, wpisy ręczne (raport kasy),
  spis z natury, Fundusz Pracy w KPiR;
- pliki JPK_EWP(4) i JPK_PKPIR(3) do pobrania, JPK_V7M(3) z wysyłką do MF
  (wysyłka zablokowana do opinii prawnika);
- „Ten miesiąc” z kwotami, terminami, mikrorachunkiem, „Zatwierdź miesiąc”
  i „Zapłacone”, przypomnienia przed terminami, „ile odłożyć”.

Czego moduł nie umie: sekcja 3 i etapy 4-5.

Generator JPK_V7M zna sprzedaż krajową według stawek, „zw”, „np” i 0 %
krajowe oraz zakupy pozostałe (K_42, K_43). Odwrotne obciążenie odrzuca
z komunikatem (`lib/exports/jpk-v7m-generator.ts:69-78`). Nie zna WDT
i eksportu, importu usług i WNT, zakupu środków trwałych, korekt z ulgi na
złe długi, oznaczeń FP, RO i WEW ani zwrotu VAT na rachunek.

### 2.4 Konto, bezpieczeństwo, współpraca

| Obszar | Stan | Szczegóły i dowód |
|---|---|---|
| Wiele firm na jednym koncie | jest | przełącznik „Moje firmy” (`components/dashboard/profile-menu.tsx`) |
| Zespół i role | jest | właściciel, administrator, członek, księgowa (bez zapisu danych); zaproszenia i prośby o dołączenie |
| Portal księgowej | częściowo | link z tokenem na 1-365 dni (w bazie tylko skrót), 100 faktur, eksport JPK_FA i KPiR; bez kosztów i zdjęć dokumentów (`lib/accountant/load-accountant-portal.ts`) |
| Bezpieczeństwo | jest | hasło, 2FA (TOTP z kodami odzyskiwania), biometria (passkeys); brak listy zalogowanych urządzeń i historii logowań |
| Audyt | jest | 200 ostatnich wpisów na ekranie, przechowywane 12 miesięcy |
| RODO | częściowo | eksport danych konta (JSON), usunięcie konta z 14 dniami na wycofanie; usunięcie firmy tylko przez pomoc |
| Retencja i kopie | jest | faktury usuwane po okresie przechowywania razem z plikami; codzienna kopia bazy (30 i 56 dni) |
| Abonament | jest | jeden plan 29,99 zł brutto, 30 dni próby z kartą, BLIK za przełącznikiem; faktura za abonament przez KSeF, bez listy w ustawieniach |
| Powiadomienia | częściowo | push (faktura przyjęta albo odrzucona, wygasający certyfikat, nowa faktura zakupu, księgowość) i maile ze zgodami; push „Otrzymana płatność” nigdy nie przychodzi (nikt nie wysyła zdarzenia, `lib/jobs/events.ts:246`); dzwonek w aplikacji to tylko napis o FLO |
| Ciemny motyw | jest | przełącznik w nagłówku (`lib/theme/theme.ts`) |
| Pomoc | jest | 27 artykułów, czat z bazą wiedzy, „Połącz z człowiekiem”; bez zgłoszeń |
| Panel operatora | jest | użytkownicy, KSeF, błędy wysyłki, kopie, flagi firm (w tym pilotaż księgowości) |
| Język interfejsu | brak | tylko polski |
| FLO | wyłączony | czat i agent niepodpięte; zostały zgody na ponaglenia i tryb cichy (`lib/flo/flags.ts`) |

### 2.5 Mocne strony do zachowania

- Powiadomienie w telefonie o nowej fakturze zakupu w KSeF (z liderów ma je
  tylko inFakt).
- Cały program działa w przeglądarce telefonu.
- Import z czterech programów i całej historii z KSeF.
- Jedna cena miesięcznie, bez limitów faktur.
- Zasady fail-closed: brak pewności to brak kwoty z komunikatem, a nie
  zgadywanie (np. odwrotne obciążenie w JPK, waluty w raportach).

### 2.6 Niespójności znalezione przy spisie

Nie są częścią żadnego kroku z osobna; każda trafia do kroku niżej albo do
osobnej poprawki według protokołu naprawy błędu.

| Co | Gdzie | Krok |
|---|---|---|
| Cennik mówi, że po wyczerpaniu limitu odczytu zdjęć „dane wpisujesz ręcznie”, a nieudany odczyt nie tworzy kosztu, formularza nowego kosztu nie ma, a przycisk „Wpisz ręcznie” prowadzi tylko do listy | `app/(marketing)/pricing/page.tsx:203-204`, `lib/jobs/runners/process-ocr.ts:423-447`, `lib/flo/functions/expense-review.ts:400-406` | 3.8 albo poprawka tekstu wcześniej |
| Powód wstrzymania JPK_V7M w eksporcie mówi o wersji (2), a generator robi już wersję (3); prawdziwy powód to dane osoby fizycznej (D16 planu księgowości) | `lib/exports/suspended-formats.ts:3-8` | 4.5 |
| Push „Otrzymana płatność” da się włączyć, ale nic go nie wysyła | `lib/jobs/events.ts:246-248` | 8.1 |
| Zdjęcie udostępnione z telefonu ląduje na Pulpicie bez paska postępu odczytu (po wyłączeniu FLO) | `app/share-target/route.ts` | 8.1 |
| Szablon czwartego etapu przypomnień istnieje, a harmonogram bierze etapy 1-3 | `lib/reminders/templates.ts:105`, `lib/reminders/scheduler.ts:184-203` | 2.9 |

---

## 3. Czego brakuje wobec przepisów

Każdy wiersz: obowiązek, źródło (sekcja 11), od kiedy, stan FaktWay i krok
planu.

| # | Obowiązek | Od kiedy | FaktWay dziś | Krok |
|---|---|---|---|---|
| L1 | Faktura do paragonu w KSeF. Do końca 2026 r. kasa może wystawiać faktury, a paragon z NIP do 450 zł (100 euro) jest fakturą uproszczoną poza KSeF (MF, okres przejściowy). Od 2027 r. ten wyjątek się kończy; projekt zmiany rozporządzenia o kasach z czerwca 2026 r. zostawia kasie tylko paragony | 1.01.2027 | brak FP; paragon z NIP w kosztach daje odliczenie VAT jak faktura uproszczona (`lib/exports/jpk-v7m-generator.ts:182`) | 1.2, 1.3 |
| L2 | Numer KSeF albo identyfikator zbiorczy w tytule przelewu: czynny podatnik VAT płacący innemu czynnemu podatnikowi, także w MPP (art. 108g ustawy o VAT) | płatności od 1.01.2027 | brak | 1.4 |
| L3 | KSeF dla wszystkich: koniec okresu przejściowego dla sprzedaży do 10 000 zł brutto miesięcznie | 1.01.2027 | FaktWay wysyła wszystko do KSeF | 1.6 |
| L4 | Kary za błędy w KSeF (art. 106ni). Projekt przyjęty przez rząd odracza je do końca 2027 r. | 1.01.2027 albo 1.01.2028 | nie dotyczy | cały etap 1 |
| L5 | Tryby szczególne: offline24 (wysłanie następnego dnia roboczego), niedostępność (1 dzień roboczy po końcu), awaria ogłoszona (7 dni roboczych), awaria całkowita (faktura poza KSeF). Faktura offline przekazana nabywcy poza KSeF ma dwa kody QR: OFFLINE i CERTYFIKAT | od 1.02.2026 | offline24 wyłączony, brak trybu awaryjnego i niedostępności, KOD II nie działa | 1.5 |
| L6 | Noty korygujące uchylone; błąd poprawia tylko faktura korygująca | od 1.02.2026 | korekty są, na produkcji wstrzymane | 1.1 |
| L7 | Obowiązkowe elementy faktury i adnotacje (art. 106e): m.in. MPP przy towarach z załącznika 15 powyżej 15 000 zł, metoda kasowa, samofakturowanie, odwrotne obciążenie, procedura marży, zwolnienie z podstawą | stale | częściowo (sekcja 2.1) | 2.7 |
| L8 | Faktura w walucie: kurs NBP z ostatniego dnia roboczego przed powstaniem obowiązku podatkowego, kwota VAT w złotych (art. 31a, art. 106e ust. 11) | stale | brak | 2.1 |
| L9 | Sprzedaż za granicę: WDT i eksport 0 % (dowody wywozu i dostawy), usługi dla firm z UE poza Polską, VAT-UE co miesiąc do 25., także przy rozliczeniu kwartalnym. Od 18.11.2026 eksport według nowego art. 41 ust. 6 do 9a (Dz.U. 2026 poz. 1446, RP-EX-01): dowody wywozu przed terminem deklaracji za okres dostawy, bez nich dostawa w następnym okresie, bez dowodów także wtedy stawka krajowa, późniejsze dowody to korekta w okresie ich otrzymania, zaliczka z 0 % przy wywozie w 6 miesięcy | stale | brak WDT i eksportu; usługi „np” są | 2.3, 4.5, 4.6 |
| L10 | Zakupy z zagranicy: czynny podatnik sam nalicza VAT w JPK (import usług, WNT); zwolniony z VAT składa VAT-8 (zarejestrowany do VAT-UE) albo VAT-9M | stale | JPK odrzuca odwrotne obciążenie; zakupy tylko K_42, K_43 | 4.5, 4.6 |
| L11 | VAT kwartalny (JPK_V7K): mały podatnik do 2 mln euro sprzedaży z VAT, nie w pierwszych 12 miesiącach, zawiadomienie do 25. drugiego miesiąca kwartału; ewidencja co miesiąc, deklaracja za kwartał; metoda kasowa oznacza kwartał | stale | tylko JPK_V7M | 4.1 |
| L12 | Zaliczki PIT kwartalne (mali podatnicy do 2 mln euro, czyli 8 517 000 zł w 2026 r., i rozpoczynający działalność) i ryczałt kwartalny (przychód do 200 000 euro, czyli 851 720 zł); termin 20. po kwartale | stale | tylko miesięcznie | 4.1 |
| L13 | Kasowy PIT dla JDG (przychód do 2 mln zł według biznes.gov.pl, oświadczenie do 20 lutego): przychód w dniu zapłaty, koszt po zapłacie | od 2025 | brak | 4.2 |
| L14 | Biała lista: zapłata powyżej 15 000 zł na rachunek spoza wykazu to solidarna odpowiedzialność za VAT, chyba że w 7 dni zawiadomisz urząd (ZAW-NR). Zmiana z Dz.U. 2026 poz. 1371 (art. 1 pkt 2 i art. 3): brak kosztu w PIT tylko przy fakturze wystawionej przed 1.01.2027, także przy zapłacie w 2027 r.; od faktur z 1.01.2027 koszt w PIT odbiera tylko płatność ponad 15 000 zł bez rachunku płatniczego (np. gotówką) | stale; w PIT według dnia wystawienia faktury od 1.01.2027 | status NIP jest, sprawdzenie rachunku niepodpięte; uwaga 12.11.2026: ostrzeżenie o PIT według dnia wystawienia faktury (P_1) | 3.4 |
| L15 | Ulga na złe długi w VAT (wierzyciel może skorygować po 90 dniach od terminu, dłużnik musi zmniejszyć odliczenie) i w PIT (dłużnik zwiększa dochód, wierzyciel może zmniejszyć) | stale | brak | 3.5 |
| L16 | Ewidencja środków trwałych i wartości niematerialnych: powyżej 10 000 zł i dłużej niż rok, wpis najpóźniej w miesiącu przekazania do używania; JPK_ST obok JPK_PKPIR i JPK_EWP | stale; JPK_ST z księgami (2027 grupa V7M, potem wszyscy) | brak | 5.1 |
| L17 | Samochód: VAT 100 % tylko z VAT-26 i ewidencją przebiegu, inaczej 50 %; w PIT bez ewidencji 75 % wydatków; limity amortyzacji i leasingu od 2026 r.: 150 000 zł (emisja poniżej 50 g CO2/km), 100 000 zł (50 g i więcej), 225 000 zł (elektryczne, wodór) | stale; limity od 1.01.2026 | brak | 4.7 |
| L18 | DRA co miesiąc, także gdy płacisz tylko za siebie (od 2022 r.) | stale | moduł liczy kwoty, DRA nie tworzy | 4.4 |
| L19 | Mały ZUS Plus (przychód do 120 000 zł, co najmniej 60 dni działalności, 36 miesięcy w każdych 60, zgłoszenie do 31 stycznia) i wakacje składkowe (jeden miesiąc w roku, wniosek RWS miesiąc wcześniej, DRA i tak) | stale | brak | 4.3 |
| L20 | Roczne zeznania PIT-28, PIT-36, PIT-36L (15 lutego - 30 kwietnia); bramka e-Deklaracji przyjmuje je z danymi autoryzującymi | stale | brak | 5.2-5.5 |
| L21 | JPK_PKPIR, JPK_EWP i JPK_ST w terminie zeznania | za 2026 grupa V7M, za 2027 wszyscy | pliki PKPIR i EWP do pobrania, bez wysyłki; JPK_ST brak | 5.6 |
| L22 | Roczne rozliczenie składki zdrowotnej w DRA za kwiecień, do 20 maja | stale | brak | 5.7 |
| L23 | Okres przechowywania: KSeF trzyma faktury 10 lat od końca roku wystawienia, potem podatnik sam do przedawnienia; księgi i dowody do przedawnienia podatku, zwykle 5 lat od końca roku, w którym minął termin jego zapłaty | stale | retencja 10 lat w FaktWay | 6.4 |
| L24 | Ewidencja wyposażenia | zniesiona od 2020 r. | nie budujemy | brak |
| L25 | Kasa rejestrująca po przekroczeniu 20 000 zł sprzedaży dla osób prywatnych (z wyjątkami, np. usługi prawnicze i fryzjerskie od pierwszej złotówki); zwolnienia z rozporządzenia do 31.12.2027 | stale | brak licznika | 9.3 (decyzja P6) |
| L26 | OSS: powyżej 10 000 euro sprzedaży wysyłkowej i usług elektronicznych dla konsumentów z UE VAT według kraju nabywcy | stale | brak licznika | 9.4 (decyzja P5) |
| L27 | Zakupy z zagranicy objęte podatkiem u źródła (np. licencje, doradztwo): płatnik pobiera podatek i składa informacje | stale | brak | 4.6 (ostrzeżenie) |

---

## 4. Czego brakuje wobec liderów

Liderzy: Fakturownia, inFakt, wFirma, IFIRMA (macierz z 28.10.2026, Fakturownia
sprawdzona 8.11.2026).

| Funkcja | Kto ma | FaktWay | Krok |
|---|---|---|---|
| Faktury w walutach z kursem NBP | wszyscy czterej | brak | 2.1 |
| Faktury w językach obcych i dwujęzyczne | wszyscy (12-29 języków) | brak | 2.2 |
| Proforma | Fakturownia, IFIRMA, wFirma | brak | 2.4 |
| Faktura do paragonu; paragony i drukarki | Fakturownia (paragony, e-paragony, drukarki przez płatny moduł), IFIRMA | brak | 1.2; kasy: decyzja P6 |
| Link do płatności | Fakturownia, inFakt, wFirma | brak | 3.3 (decyzja P2) |
| Bank: wyciąg i automatyczne „zapłacone” | wszyscy (Fakturownia także import pliku) | brak | 3.2 (decyzja P1); openbanking poza zakresem |
| API | wszyscy (wFirma prawdopodobnie) | brak | 7.1 |
| Łącze dla asystentów AI (MCP) | Fakturownia (odczyt), inFakt (wtyczka) | brak | 7.2 |
| Samodzielna księgowość | Fakturownia za 19,99 zł netto (rocznie) albo 24,99 zł: KPiR, ryczałt, liniowy, PIT, ZUS z DRA, JPK V7, EWP i PKPiR z wysyłką, VAT-UE, VAT-8, VAT-9M, środki trwałe, terminy; wFirma 60 zł netto: KPiR, ryczałt, JPK_V7, e-Deklaracje, e-ZUS, roczne, środki trwałe; inFakt: KPiR, PIT, VAT, roczny PIT | rdzeń jest za wyłącznikiem; brak DRA, VAT-UE, VAT-8, VAT-9M, środków trwałych, kwartalnych, rocznych | etapy 4-5 |
| Kadry | wFirma (60 zł netto) | brak | decyzja P3 |
| Tryb offline KSeF | Fakturownia (offline i offline24) | wyłączony | 1.5 |
| Wysyłka masowa do KSeF | Fakturownia | brak | 2.8 |
| Prośby z recenzji: autozapis szkicu, domyślna płatność i termin, cena dla kontrahenta, numer zamówienia, cena brutto, sumy przychodów w miesiącu, webhooki, kaucja, delegacje, rachunki do umów | różni | brak (ciemny motyw już jest) | 2.6, 2.7, 2.8, 3.8, 7.1, 8.3; kadry P3 |
| Magazyn, sklepy | Fakturownia, IFIRMA, wFirma | brak | poza zakresem |
| Aplikacja w sklepach | inFakt, Fakturownia, IFIRMA | strona w telefonie | poza tym planem |

---

## 5. Etapy i kroki

**Jak czytać krok.** Każdy krok to jedna gałąź i jeden PR (duże kroki: kilka
PR po kolei). Przy kroku:
- **Klient dostaje:** co zobaczy i zrobi;
- **Po co:** przepis albo rynek;
- **W aplikacji:** co się zmieni;
- **Praca:** wielkość i zależności. S to jedna sesja, M dwie-trzy, L cztery-sześć,
  XL więcej, dzielone na kilka PR;
- **Ryzyko:** poziom z mapy żelaznego filtra (sekcja 8): R1 krytyczny,
  R2 wprowadza w błąd, R3 pomocniczy, R0 bez ryzyka prawnego; przy krokach
  z modułu księgowości także brama dla klientów;
- **Sprawdzamy na:** wzorzec, czyli źródło prawdy, na którym sprawdzimy
  wynik (sekcja 8.1), i czego brakuje, żeby go użyć; gdy wzorca nie ma,
  krok mówi to wprost jako ryzyko;
- **Prawnik / księgowa:** czy potrzebny i w jakiej sprawie.

### Etap 0. Start

#### 0.1 Plan w repo i przygotowanie
- **Klient dostaje:** nic widocznego.
- **Po co:** sesje muszą mieć jedno źródło prawdy i decyzje Bartosza.
- **W aplikacji:** fraza w `AGENTS.md`; decyzje z sekcji 6 oznaczone jako
  przyjęte; nowe pytania do prawnika dopisane do
  `docs/ksiegowosc/PYTANIA-DO-PRAWNIKA.md` (pytania 7-17); nowe złote
  przypadki G15-G30 w drugim arkuszu `docs/ksiegowosc/ZLOTE-PRZYPADKI-2.md`
  (pierwszy arkusz, G1-G14, bez zmian); rejestr przepisów dla nowych obszarów
  (faktury od 2027 r., płatności, tryby KSeF, waluty, VAT i JPK, PIT, ZUS,
  środki trwałe, samochód) w `docs/koordynacja/REJESTR-PRZEPISOW-KOMPLETNA.md`,
  w polach rejestru żelaznego filtra; po fazie F4 filtra wpisy przechodzą do
  `filtr/przepisy/`.
- **Praca:** S, bez zależności.
- **Ryzyko:** R0 (dokumentacja).
- **Prawnik / księgowa:** nie.

### Etap 1. Fundament faktur i obowiązki od 1 stycznia 2027 r.

Cel: do 31.12.2026 wszystkie rodzaje faktur, które FaktWay już pokazuje,
działają na KSeF produkcyjnym, a dwa nowe obowiązki z 2027 r. są obsłużone.

#### 1.1 Korekty i faktury końcowe na produkcji
- **Klient dostaje:** korektę każdej faktury (także zaliczkowej i końcowej,
  także ze stawką „zw”) i fakturę końcową, które naprawdę wychodzą do KSeF;
  zaliczkę z kilkoma stawkami VAT.
- **Po co:** przepis: noty korygujące zniknęły 1.02.2026, więc korekta to
  jedyny sposób poprawienia błędu; rynek: liderzy to mają.
- **W aplikacji:** dokończenie sesji C1-C4 planu „zero zgubionych faktur”
  (granice dat, sprzedawca w korekcie, „zw” w korektach, zdjęcie blokad
  `KOR_HOLD` i `ROZ_HOLD`), potem nowe: korekta zaliczkowej (KOR_ZAL)
  i końcowej (KOR_ROZ), zaliczka z kilkoma stawkami, „zw” w zaliczce i fakturze
  końcowej, numer podpowiadany dla tych rodzajów.
- **Praca:** L; prowadzi plan „zero zgubionych faktur” (nie dublujemy jego
  kart), nowe rodzaje po C4; próby na KSeF TEST.
- **Ryzyko:** R1 (faktury, korekty i zaliczki, wysyłka do KSeF).
- **Sprawdzamy na:** testowy KSeF (przyjęcie i UPO dla każdego rodzaju), schemat FA(3) i przykładowe faktury MF, księgowa (10 faktur z KSeF TEST). **Brakuje:** automatycznej wysyłki każdego rodzaju na KSeF TEST (karta H1b planu zero); KSeF przyjmie złą kwotę różnicy, jeśli pasuje do schematu, więc różnice korekt sprawdzają test i księgowa.
- **Prawnik / księgowa:** księgowa sprawdza 10 faktur z KSeF TEST (kryterium
  G5 z `GOTOWOSC-DO-WYDANIA.md`) i ujęcie korekt w ewidencji, KPiR i JPK.

#### 1.2 Faktura do paragonu (FP)
- **Klient dostaje:** „Faktura do paragonu” w wystawianiu, także ze zdjęcia
  paragonu: program odczyta numer, datę, kwoty i NIP, a faktura wychodzi do
  KSeF z oznaczeniem FP.
- **Po co:** przepis L1; rynek: Fakturownia i IFIRMA.
- **W aplikacji:** nowy rodzaj faktury z polami paragonu (numer, data, numer
  kasy); oznaczenie FP w FA(3); dla firmy tylko, gdy paragon ma jej NIP
  (art. 106b ust. 5 ustawy o VAT); termin: na żądanie zgłoszone w ciągu
  3 miesięcy od końca miesiąca sprzedaży; FP poza przychodem w ewidencji
  i KPiR, gdy sprzedaż weszła już z raportu kasy (zasada 2 planu księgowości);
  typ dokumentu FP w JPK_V7 (generator dziś go nie zna).
- **Praca:** M; OCR jest; zależy od 1.1 tylko w części korekty FP.
- **Ryzyko:** R1 (faktura i oznaczenie w JPK).
- **Sprawdzamy na:** testowy KSeF (FA(3) z oznaczeniem FP), broszura JPK_V7(3) (typ dokumentu FP), e-mikrofirma, księgowa (G30). **Brakuje:** ostatecznego tekstu zmiany rozporządzenia o kasach w Dzienniku Ustaw i przykładu FP z broszur w testach.
- **Prawnik / księgowa:** księgowa: FP w JPK i w przychodzie (złoty przypadek
  G30).

#### 1.3 Paragon z NIP w kosztach od 2027 r.
- **Klient dostaje:** przy paragonie z NIP z datą od 1.01.2027 jasną
  informację, że VAT odliczy tylko z faktury w KSeF, i podpowiedź, żeby
  poprosić sprzedawcę o fakturę; gdy faktura FP przyjdzie do skrzynki, program
  połączy ją z paragonem, żeby koszt nie wszedł dwa razy.
- **Po co:** przepis L1; dziś paragon z NIP daje odliczenie jak faktura
  uproszczona (`lib/categorization/kpir-cost.ts:34`).
- **W aplikacji:** reguła zależna od daty dokumentu w kosztach i JPK; łączenie
  paragonu z fakturą ze skrzynki.
- **Praca:** S-M; zależy od 1.2 (te same oznaczenia).
- **Ryzyko:** R1 (odliczenie VAT w kosztach).
- **Sprawdzamy na:** przepis o okresie przejściowym do 31.12.2026 i broszura JPK_V7(3); księgowa. **Brakuje:** ostatecznego tekstu rozporządzenia o kasach i odpowiedzi księgowej o koszcie w PIT.
- **Prawnik / księgowa:** księgowa: czy paragon bez faktury zostaje kosztem
  w PIT.

#### 1.4 Numer KSeF przy płatnościach
- **Klient dostaje:**
  - na fakturze, w mailu, w przypomnieniu i w wezwaniu gotowy tytuł przelewu
    z numerem KSeF;
  - przy kosztach do zapłaty tytuł do skopiowania z numerem KSeF, a przy kilku
    fakturach jednego dostawcy identyfikator zbiorczy z KSeF;
  - wpłaty rozpoznawane po numerze KSeF (etap 3).
- **Po co:** przepis L2.
- **W aplikacji:** tytuł przelewu w PDF i mailach; wywołanie API KSeF do
  identyfikatora zbiorczego (35 znaków z cyframi kontrolnymi) i walidator
  formatu; przy fakturze offline bez numeru informacja, że numer nie jest
  wymagany.
- **Praca:** M; pełne „do zapłaty” kosztów przychodzi w 3.4.
- **Ryzyko:** R1 (dane do przelewu).
- **Sprawdzamy na:** dokumentacja KSeF 2.0 (CIRFMF) z przykładem identyfikatora zbiorczego; KSeF TEST, który identyfikator generuje. **Brakuje:** testu cyfr kontrolnych na wektorze z dokumentacji i próby na KSeF TEST.
- **Prawnik / księgowa:** nie.

#### 1.5 Tryby szczególne KSeF i drugi kod QR
- **Klient dostaje:** fakturę także wtedy, gdy KSeF albo internet nie działa:
  - offline24 z wyboru albo przy kłopocie z siecią;
  - tryb niedostępności i tryb awaryjny ogłoszony przez MF, z dosłaniem
    w ustawowym terminie;
  - przy awarii całkowitej faktura poza KSeF;
  - PDF z dwoma kodami QR (OFFLINE i CERTYFIKAT), który można dać nabywcy od
    razu.
- **Po co:** przepis L5; rynek: Fakturownia ma offline i offline24.
- **W aplikacji:** certyfikat KSeF typu Offline w kreatorze (dziś odrzucany);
  KOD II w ścieżce produkcyjnej (#122 w planie zero); trwała tożsamość próby
  wysyłki; tryby według tabeli MF (terminy: następny dzień roboczy, 1 dzień
  roboczy, 7 dni roboczych); stan MF z Latarni (jest) uruchamia tryb tylko
  przy ogłoszeniu; dosłanie i UPO jak dziś.
- **Praca:** L; zależy od kart B1 i B2 planu zero (warunki z jego sekcji
  o Offline24).
- **Ryzyko:** R1 (wysyłka do KSeF, tryb offline, kody QR); kara z art. 106ni grozi za zły wzór albo termin w trybie awaryjnym i offline24.
- **Sprawdzamy na:** tabela trybów MF (wersja 12); KSeF TEST (faktura z P_1 sprzed dnia wysyłki przyjęta jako Offline, sprawdzone w H1a planu zero); strona MF do weryfikacji kodów QR. **Brakuje:** certyfikatu typu Offline na KSeF TEST i testu, że oba kody z naszego PDF przechodzą weryfikację MF; awarii KSeF nie da się wywołać na zamówienie, więc tryb awaryjny sprawdzają tylko testy terminów (ryzyko).
- **Prawnik / księgowa:** prawnik: teksty dla klienta o trybach (już na liście
  planu zero, sekcja 9).

#### 1.6 Zmiany z 1 stycznia 2027 r. w komunikatach
- **Klient dostaje:** krótką informację w aplikacji i mailu: koniec progu
  10 000 zł, faktura do paragonu, numer KSeF w przelewie; dla firmy, która
  w 2026 r. wystawiała faktury poza KSeF, możliwość dodania ich do historii
  (plik PDF albo ręcznie).
- **Po co:** przepisy L1-L3.
- **W aplikacji:** jeden komunikat, wpis w pomocy, import faktur spoza KSeF do
  historii bez wysyłki.
- **Praca:** S.
- **Ryzyko:** R1 (import faktur do historii), komunikaty R2.
- **Sprawdzamy na:** import: XSD FA(3) i pliki z KSeF; komunikaty: przegląd treści bez porad (D8 planu księgowości). **Brakuje:** nic istotnego.
- **Prawnik / księgowa:** nie.

### Etap 2. Faktury: pełny zestaw

#### 2.1 Waluty obce
- **Klient dostaje:** fakturę w EUR, USD i każdej walucie z tabeli NBP, z kursem
  wstawionym automatycznie, kwotą VAT w złotych i rachunkiem walutowym; kurs da
  się zmienić, gdy obowiązek podatkowy powstał innego dnia.
- **Po co:** przepis L8; rynek: wszyscy czterej liderzy.
- **W aplikacji:** pole waluty i kursu w formularzu (wszystkie rodzaje, także
  zaliczka, końcowa, korekta i faktura cykliczna); KodWaluty i kwoty w złotych
  w FA(3); PDF z kursem; raporty, KPiR, ewidencja i JPK po kursie z faktury
  (koniec odmowy w `lib/exports/currency-guard.ts`, zasada 3 planu
  księgowości); import faktur walutowych z KSeF (dziś odrzucany).
- **Praca:** L; klient NBP jest (`lib/nbp/client.ts`).
- **Ryzyko:** R1 (waluty i kursy NBP).
- **Sprawdzamy na:** API NBP (archiwalne tabele A) i reguła z art. 31a ustawy o VAT; KSeF TEST (KodWaluty, VAT w złotych); przykład faktury walutowej z broszury FA(3); księgowa (G29). **Brakuje:** testów na archiwalnych tabelach NBP z dniami wolnymi i przełomem roku oraz przykładu z broszury w testach.
- **Prawnik / księgowa:** księgowa: kurs przy zaliczce i korekcie (złoty
  przypadek G29 razem z różnicami kursowymi).

#### 2.2 Języki faktury i wygląd
- **Klient dostaje:** fakturę po angielsku albo dwujęzyczną (polski
  i angielski), potem kolejne języki; logo firmy na fakturze; wybór języka
  zapamiętany przy kontrahencie.
- **Po co:** rynek: wszyscy liderzy (12-29 języków); klienci z zagranicy.
- **W aplikacji:** słownik etykiet PDF i maila w kilku językach; logo
  w ustawieniach firmy; XML zostaje według schematu MF (język dotyczy wydruku).
- **Praca:** M; zależy od 2.1 (kwoty w walucie na wydruku).
- **Ryzyko:** R1 (PDF faktury).
- **Sprawdzamy na:** dane na PDF porównane automatycznie z XML wysłanym do KSeF; kody QR jak w 1.5. **Brakuje:** urzędowego wzorca tłumaczeń etykiet; taki nie istnieje (ryzyko: słownik sprawdzają tłumacz i księgowa).
- **Prawnik / księgowa:** nie. Języki: decyzja D3.

#### 2.3 Sprzedaż za granicę
- **Klient dostaje:** fakturę WDT (towar do firmy z UE, 0 %) i eksportową
  (towar poza UE, 0 %) z wymaganymi adnotacjami, sprawdzenie numeru VAT-UE
  w VIES już w formularzu oraz przypomnienie o dowodach wywozu albo dostawy.
- **Po co:** przepis L9; rynek: wszyscy.
- **W aplikacji:** nowe stawki „0 WDT” i „0 EX” (P_13_6_2, P_13_6_3) we
  wszystkich generatorach; VIES w formularzu (sprawdzenie jest w walidacji
  kontrahentów); pola dowodów przy fakturze; dane trafiają do VAT-UE (4.6)
  i JPK (4.5).
- **Eksport od 18.11.2026 (Dz.U. 2026 poz. 1446, RP-EX-01):** art. 41 ust. 6
  do 9a w nowym brzmieniu. Stawka 0 % tylko z dowodami wywozu (dokumenty celne,
  a także dokument przewoźnika albo spedytora, potwierdzenie operatora
  pocztowego, dokument celny państwa spoza UE z oświadczeniem nabywcy, ust. 6c)
  przed terminem deklaracji za okres dostawy (ust. 6). Bez dowodów dostawy nie
  wykazuje się w tym okresie, tylko w następnym ze stawką 0 %, gdy dowody są
  przed terminem deklaracji za ten okres (ust. 7); bez dowodów także wtedy
  stawka krajowa (ust. 7a); dowody otrzymane później to korekta podatku
  należnego w okresie ich otrzymania (ust. 9). Zaliczka przed eksportem: 0 %,
  gdy wywóz nastąpi w 6 miesięcy od końca miesiąca zapłaty i w tym terminie są
  dowody (ust. 9a). Przejściowo (art. 3 ustawy): nowe zasady dla eksportu,
  dla którego termin deklaracji nie minął przed 18.11.2026; ust. 9a także dla
  zapłaty sprzed 18.11.2026 przy wywozie od tego dnia. Krok potrzebuje więc
  pól dowodu i terminu przy fakturze, przypomnienia przed terminem deklaracji
  i ścieżki przesunięcia, stawki krajowej i korekty w JPK (4.5).
- **Praca:** M; zależy od 2.1.
- **Ryzyko:** R1 (stawki i adnotacje).
- **Sprawdzamy na:** VIES (API UE); KSeF TEST (P_13_6_2, P_13_6_3); broszura JPK_V7(3) (K_21, K_22) i e-mikrofirma; księgowa (G21). **Brakuje:** porównania z e-mikrofirmą i podpisu G21.
- **Prawnik / księgowa:** księgowa: warunki stawki 0 % i termin dowodów
  (złoty przypadek G21).

#### 2.4 Proforma i oferta
- **Klient dostaje:** proformę i ofertę (wycenę) z własną numeracją, wysyłane
  mailem, i zamianę jednym kliknięciem w fakturę albo zaliczkę.
- **Po co:** rynek: Fakturownia, IFIRMA, wFirma; proforma nie idzie do KSeF
  (MF).
- **W aplikacji:** nowe rodzaje dokumentów poza KSeF i poza przychodem;
  wydruk z napisem, że to nie faktura; przeniesienie danych do faktury.
- **Praca:** M.
- **Ryzyko:** R2 (dokument z kwotami, który nie jest fakturą).
- **Prawnik / księgowa:** nie.

#### 2.5 Numeracja
- **Klient dostaje:** serie (np. osobna dla faktur walutowych albo innego
  miejsca sprzedaży), własny wzór numeru (rok, miesiąc, licznik, prefiks)
  i podpowiedź numeru dla każdego rodzaju dokumentu.
- **Po co:** rynek; przepis: numer kolejny w ramach serii (art. 106e).
- **W aplikacji:** tabela serii z licznikami w bazie, wybór serii
  w formularzu; numer zajęty w KSeF dalej blokowany (plan zero).
- **Praca:** M.
- **Ryzyko:** R1 (numeracja faktur).
- **Sprawdzamy na:** art. 106e ustawy o VAT (kolejny numer w serii); KSeF odrzuca duplikat numeru (440); test na prawdziwej bazie dla dwóch wystawień naraz. **Brakuje:** testu wyścigu na bazie.
- **Prawnik / księgowa:** nie.

#### 2.6 Produkty i usługi w formularzu
- **Klient dostaje:** listę produktów i usług z cenami netto albo brutto,
  jednostką, stawką VAT, PKWiU, GTU i stawką ryczałtu; podpowiedź przy pisaniu
  pozycji; ceny dla konkretnego kontrahenta.
- **Po co:** rynek (prośby z recenzji); stawka ryczałtu z produktu odkłada się
  od K2 (D4 planu księgowości).
- **W aplikacji:** ekran katalogu na tabeli `products` (00013); GTU i PKWiU
  w XML (generator je zna, formularz nie przekazuje); cena brutto pozycji
  (P_9B, P_11A).
- **Praca:** M.
- **Ryzyko:** R1 (stawki z katalogu trafiają na faktury).
- **Sprawdzamy na:** słowniki GTU (broszura JPK_V7) i PKWiU (GUS); XSD FA(3). **Brakuje:** nic istotnego.
- **Prawnik / księgowa:** nie (stawkę wybiera klient, D8 planu księgowości).

#### 2.7 Rzadsze rodzaje faktur i adnotacje
- **Klient dostaje:**
  - fakturę uproszczoną (do 450 zł albo 100 euro);
  - fakturę VAT marża (towary używane, turystyka, dzieła sztuki);
  - odwrotne obciążenie z wyboru tam, gdzie przepis go wymaga (gaz, energia,
    uprawnienia do emisji do 30.06.2030);
  - samofakturowanie (po uprawnieniu w KSeF);
  - podmiot trzeci na fakturze (JST jako odbiorca, płatnik, dodatkowy
    nabywca);
  - załącznik do faktury (FA(3));
  - fakturę VAT RR przy zakupie od rolnika ryczałtowego;
  - kaucję na fakturze (system kaucyjny).
- **Po co:** przepis L7; rynek: prośby z recenzji (kaucja, odwrotne
  obciążenie w aplikacji).
- **W aplikacji:** nowe pola i odmowy zamienione na obsługę w generatorach
  (marża i P_22 są dziś jawnie odrzucane); JST i GV z formularza zamiast
  „nie” na sztywno; każdy rodzaj z próbą na KSeF TEST i XSD.
- **Praca:** L, kilka PR (jeden rodzaj na PR).
- **Ryzyko:** R1 (rodzaje faktur i adnotacje).
- **Sprawdzamy na:** XSD FA(3) i przykłady z broszury FA(3) (uproszczona, marża, podmiot trzeci, samofakturowanie, załącznik); KSeF TEST (samofakturowanie po nadaniu uprawnienia, faktura VAT RR); broszura JPK_V7(3) (procedury marży). **Brakuje:** uprawnienia do samofakturowania na KSeF TEST; urzędowego przykładu kaucji na fakturze; taki nie istnieje (ryzyko: decyduje księgowa).
- **Prawnik / księgowa:** księgowa: marża w JPK i ewidencji.

#### 2.8 Wygoda wystawiania i wysyłki
- **Klient dostaje:**
  - autozapis szkicu;
  - domyślne ustawienia (forma i termin płatności, adres księgowej w kopii);
  - numer zamówienia na fakturze;
  - wysyłkę wielu faktur do KSeF naraz (sesja wsadowa) i mailem;
  - wydruk zbiorczy;
  - własny szablon maila;
  - faktury cykliczne wystawiane i wysyłane same, jeśli klient to włączy.
- **Po co:** rynek: najczęstsze prośby w recenzjach Fakturowni i inFaktu.
- **W aplikacji:** zapis szkicu w bazie co kilka sekund; ustawienia
  domyślne firmy; sesja wsadowa KSeF; cron faktur cyklicznych z kluczem
  idempotencji na okres (wzór z `PLAN-FINORA.md`, N1).
- **Praca:** L, kilka PR.
- **Ryzyko:** R1 (wysyłka masowa, faktury cykliczne bez człowieka); autozapis i szablony R0.
- **Sprawdzamy na:** KSeF TEST (sesja wsadowa) i dokumentacja CIRFMF; dla faktur cyklicznych niezmiennik „jedna faktura na okres” na prawdziwej bazie. **Brakuje:** próby sesji wsadowej na KSeF TEST.
- **Prawnik / księgowa:** nie. Automat cyklicznych: decyzja D5.

#### 2.9 Dokumenty poza fakturą
- **Klient dostaje:** notę obciążeniową i uznaniową, notę odsetkową
  z kalkulatorem odsetek ustawowych za opóźnienie w transakcjach handlowych
  i rekompensatą (40, 70 albo 100 euro), potwierdzenie salda i kompensatę
  (rozliczenie wzajemnych należności).
- **Po co:** rynek; noty nie idą do KSeF (MF); prawo do odsetek i rekompensaty
  daje ustawa o przeciwdziałaniu nadmiernym opóźnieniom w transakcjach
  handlowych.
- **W aplikacji:** nowe dokumenty poza KSeF z PDF i mailem; kalkulator odsetek
  z rejestrem stawek ze źródłami (dziś wyłączony, `RATES_VERIFIED=false`);
  przy wezwaniu do zapłaty nota odsetkowa jednym kliknięciem; podpięcie
  czwartego etapu przypomnień, którego szablon już jest.
- **Praca:** M.
- **Ryzyko:** R1 (odsetki, rekompensata, dokumenty dla kontrahenta).
- **Sprawdzamy na:** obwieszczenia o stawce odsetek za opóźnienie w transakcjach handlowych (Monitor Polski) i ustawa o przeciwdziałaniu nadmiernym opóźnieniom (rekompensata w euro po kursie NBP). **Brakuje:** rejestru stawek ze źródłem (dziś `RATES_VERIFIED=false`); urzędowego przykładu wyliczenia; taki nie istnieje (ryzyko: przykłady liczy księgowa).
- **Prawnik / księgowa:** księgowa: przychód z odsetek i not w KPiR.

#### 2.10 Strona faktury dla nabywcy
- **Klient dostaje:** link do faktury, który wysyła nabywcy: podgląd, PDF,
  XML z KSeF, numer KSeF, dane do przelewu, a po kroku 3.3 przycisk zapłaty.
- **Po co:** rynek; nabywca spoza KSeF (konsument, firma zagraniczna) dostaje
  fakturę w uzgodniony sposób.
- **W aplikacji:** strona publiczna z niezgadywalnym adresem, bez danych innych
  faktur, z limitem prób i wygasaniem; zgodność z RODO (dane konsumenta).
- **Praca:** M.
- **Ryzyko:** R1 (dokument dla nabywcy); bezpieczeństwo strony jak przy portalu księgowej.
- **Sprawdzamy na:** jak 2.2 (PDF zgodny z XML, kod QR). **Brakuje:** zewnętrznego testu zabezpieczeń strony.
- **Prawnik / księgowa:** nie.

### Etap 3. Pieniądze

Bez openbankingu: klient sam pobiera plik z banku albo sam podłącza konto
u operatora płatności.

#### 3.1 Wpłaty częściowe i historia wpłat
- **Klient dostaje:** zapis wpłaty częściowej z datą przelewu, historię wpłat
  przy fakturze i cofnięcie pomyłki.
- **Po co:** rynek; dokładna data wpłaty zasila kasowy PIT, metodę kasową VAT
  i ulgę na złe długi.
- **W aplikacji:** RPC wpłaty z kwotą i datą na wzór `mark_invoice_paid`
  (00158), z testem RLS na bazie; karta FLO przestaje być jedyną drogą.
- **Praca:** S-M.
- **Ryzyko:** R1 (data zapłaty zasila kasowy PIT, metodę kasową i złe długi).
- **Sprawdzamy na:** niezmienniki na prawdziwej bazie (suma wpłat równa zapłaconej kwocie, ta sama wpłata zapisana dwa razy liczy się raz); zewnętrznego wzorca nie ma, bo to dane klienta. **Brakuje:** testu RLS nowego RPC.
- **Prawnik / księgowa:** nie.

#### 3.2 Import wyciągu bankowego
- **Klient dostaje:** wgranie pliku z banku (MT940, CAMT.053 albo CSV
  największych banków); program sam dopasuje wpłaty do faktur sprzedaży
  (numer KSeF, numer faktury, kwota), wydatki do faktur kosztowych, a przelewy
  do ZUS i urzędu do rozliczeń w module księgowości; klient potwierdza
  propozycje.
- **Po co:** rynek: wszyscy liderzy mają bank; to podstawa obietnicy „wiesz,
  kto Ci nie zapłacił”.
- **W aplikacji:** projekt N5 z `PLAN-FINORA.md` (tabela `payment_imports`,
  parsery w `lib/import/bank/`, duplikaty, potwierdzanie, blokada przypomnień
  po imporcie); ekran Bank z Finory (P12).
- **Praca:** L; zależy od 1.4 (numer KSeF w tytule) i 3.1.
- **Ryzyko:** R1 (zapisuje zapłaty).
- **Sprawdzamy na:** specyfikacje formatów (MT940 banków, CAMT.053 według ISO 20022) i zanonimizowane prawdziwe wyciągi. **Brakuje:** przykładowych plików od każdego banku (za zgodą firm z pilotażu).
- **Prawnik / księgowa:** prawnik: RODO przy wyciągach (pytanie 8). Wchodzi
  tylko przy „tak” w decyzji P1.

#### 3.3 Link do płatności
- **Klient dostaje:** przycisk „Zapłać” (BLIK, karta, szybki przelew) na
  fakturze, w mailu i na stronie faktury; po wpłacie faktura sama zmienia się
  na „zapłacone”.
- **Po co:** rynek: Fakturownia, inFakt, wFirma.
- **W aplikacji:** podłączenie konta klienta u operatora (np. Przelewy24, PayU,
  Autopay albo Stripe); pieniądze idą prosto do klienta, FaktWay ich nie
  dotyka; klucze operatora szyfrowane jak poświadczenia KSeF; potwierdzenie
  wpłaty z powiadomienia operatora z kluczem idempotencji; numer KSeF
  w tytule.
- **Praca:** L; zależy od 2.10 i 3.1.
- **Ryzyko:** R1 (zapisuje zapłaty, przechowuje klucze operatora).
- **Sprawdzamy na:** tryb testowy operatora płatności. **Brakuje:** konta testowego u wybranego operatora (część wymaga spółki).
- **Prawnik / księgowa:** prawnik: czy to usługa płatnicza (pytanie 7).
  Wchodzi tylko przy „tak” w decyzji P2.

#### 3.4 Koszty do zapłaty
- **Klient dostaje:** termin płatności faktur kosztowych z KSeF, listę „do
  zapłaty” z kwotą, rachunkiem i gotowym tytułem (numer KSeF), oznaczenie
  zapłaty, ostrzeżenie, gdy rachunek jest spoza białej listy przy kwocie
  powyżej 15 000 zł (z przypomnieniem o zawiadomieniu ZAW-NR w 7 dni),
  informację o MPP i plik przelewów do wgrania w banku.
- **Zmiana prawa (uwaga 12.11.2026):** ustawa z 18.09.2026 r. (Dz.U. 2026
  poz. 1371, art. 1 pkt 2 i art. 3, w życie 1.01.2027) zmienia art. 22p
  ustawy o PIT: rachunek spoza wykazu odbiera koszt w PIT tylko przy fakturze
  wystawionej przed 1.01.2027 (także przy zapłacie w 2027 r.), a od faktur
  z 1.01.2027 koszt odbiera tylko płatność ponad 15 000 zł bez rachunku
  płatniczego. VAT i ZAW-NR bez zmian. Ostrzeżenie na liście, na karcie kosztu
  i w powodzie pliku przelewów zależy od dnia wystawienia faktury: P_1
  z faktury KSeF, a bez niego data dokumentu kosztu, dzień w Europe/Warsaw
  (`lib/expenses/biala-lista-pit.ts`). Uwaga o gotówce ponad 15 000 zł tylko
  przy formie płatności „gotówka” z faktury (`FormaPlatnosci` 1). RP-BL-01.
- **Po co:** przepisy L2, L14; rynek.
- **W aplikacji:** projekt N7 z `PLAN-FINORA.md` (termin z
  `Platnosc/TerminPlatnosci`); podpięcie gotowego sprawdzenia rachunku
  (`app/actions/validation.ts:72-91`, `components/validation/bank-account-input.tsx`);
  plik przelewów (format importu banków, np. Elixir-0 albo CSV).
- **Praca:** M; zależy od 1.4.
- **Ryzyko:** R1 (koszt w PIT zależy od białej listy przy fakturach wystawionych przed 1.01.2027).
- **Sprawdzamy na:** API białej listy MF i VIES; specyfikacja pliku przelewów banku. **Brakuje:** testów na odpowiedziach API w każdym stanie (rachunek w wykazie, poza nim, podmiot wykreślony).
- **Prawnik / księgowa:** prawnik: pytanie 18 (co jest datą wystawienia faktury z KSeF na przełomie roku).

#### 3.5 Złe długi
- **Klient dostaje:** po 90 dniach od terminu informację, że może skorygować VAT
  od niezapłaconej faktury sprzedaży (i pomniejszyć dochód), a przy własnej
  niezapłaconej fakturze kosztowej, że musi zmniejszyć odliczenie VAT
  i zwiększyć dochód; korekty trafiają do JPK i KPiR, a po zapłacie wracają.
- **Po co:** przepis L15.
- **W aplikacji:** reguła 90 dni od terminu z datą wpłaty z 3.1-3.4; wiersze
  JPK z oznaczeniem korekty (`KorektaPodstawyOpodt`, termin płatności, data
  zapłaty); wpisy w KPiR i w zaliczce PIT.
- **Praca:** M; zależy od 3.1, 3.4 i 4.5.
- **Ryzyko:** R1, w module księgowości za wyłącznikiem `ksiegowosc` do bramy B1-B5.
- **Sprawdzamy na:** ustawa o VAT (art. 89a, 89b) i broszura JPK_V7(3) (pola korekty); e-mikrofirma; księgowa (G28). **Brakuje:** urzędowego przykładu z terminem 90 dni w testach i podpisu G28.
- **Prawnik / księgowa:** księgowa: złoty przypadek G28.

#### 3.6 Różnice kursowe
- **Klient dostaje:** przy zapłacie faktury w walucie różnicę kursową
  wyliczoną i dopisaną do KPiR (przychód albo koszt).
- **Po co:** przepis (ustawa o PIT, różnice kursowe przy KPiR).
- **W aplikacji:** kurs z dnia zapłaty (NBP) wobec kursu z faktury; wiersz KPiR
  z opisem.
- **Praca:** M; zależy od 2.1 i 3.1.
- **Ryzyko:** R1, w module księgowości za wyłącznikiem `ksiegowosc` do bramy B1-B5.
- **Sprawdzamy na:** API NBP i przepisy ustawy o PIT o różnicach kursowych; księgowa (G29). **Brakuje:** urzędowego kalkulatora; taki nie istnieje (ryzyko: tylko księgowa i przykłady).
- **Prawnik / księgowa:** księgowa: złoty przypadek G29.

#### 3.7 Gotówka
- **Klient dostaje:** dowody wpłaty i wypłaty (KP, KW) i raport kasowy dla
  firmy, która przyjmuje gotówkę.
- **Po co:** rynek (Fakturownia ma KP i KW); porządek w gotówce przy kontroli.
- **W aplikacji:** dokumenty KP i KW powiązane z fakturą („zapłacone
  gotówką”), raport za okres.
- **Praca:** M.
- **Ryzyko:** R1 (dowody kasowe dla kontrahenta).
- **Sprawdzamy na:** rozporządzenie o KPiR (elementy dowodu); księgowa. **Brakuje:** urzędowego wzoru KP i KW; taki nie istnieje, więc dowód musi mieć elementy wymagane rozporządzeniem.
- **Prawnik / księgowa:** nie.

#### 3.8 Koszty bez zdjęcia i podróże służbowe
- **Klient dostaje:** koszt wpisany ręcznie (np. opłata bez faktury, składka
  członkowska), fakturę kosztową przysłaną mailem na adres firmy w FaktWay
  (PDF trafia do odczytu jak zdjęcie) i rozliczenie podróży służbowej (diety,
  noclegi, przejazdy według stawek dla pracowników).
- **Po co:** rynek (prośba z recenzji o dokumenty delegacji); cennik już
  obiecuje ręczne wpisywanie (sekcja 2.6).
- **W aplikacji:** formularz kosztu na tych samych polach co odczyt zdjęcia;
  skrzynka mailowa na firmę z ochroną przed obcymi nadawcami; kalkulator
  podróży z parametrami ze źródłem (rozporządzenie o należnościach przy
  podróży służbowej).
- **Praca:** M.
- **Ryzyko:** R1 (koszty, kolumna KPiR, stawki diet).
- **Sprawdzamy na:** rozporządzenie o należnościach z tytułu podróży służbowej (stawki diet w kraju i za granicą); księgowa. **Brakuje:** rejestru stawek diet ze źródłem i datą.
- **Prawnik / księgowa:** księgowa: podróże właściciela firmy w KPiR.

### Etap 4. Księgowość w ciągu roku (K9, część 1)

Wszystko w module księgowości, za wyłącznikiem `ksiegowosc`, z zasadami
liczenia z sekcji 4 planu księgowości (grosze, zaokrąglenia, parametry ze
źródłem, fail-closed z wyjściem, bez porad).

#### 4.1 Rozliczenia kwartalne
- **Klient dostaje:** VAT kwartalny (JPK_V7K: ewidencja co miesiąc,
  deklaracja za kwartał) z wysyłką, zaliczki PIT kwartalne i ryczałt kwartalny,
  z terminami i przypomnieniami.
- **Po co:** przepisy L11, L12; metoda kasowa VAT wymaga rozliczenia
  kwartalnego.
- **W aplikacji:** wartość `K` w kolumnie `tax_profiles.okres` (dziś CHECK
  dopuszcza tylko `M`, migracja 00166);
  generator i XSD JPK_V7K(3); silniki PIT i ryczałtu narastająco za kwartał;
  kalendarz i przypomnienia; warunki (12 miesięcy, limit, zawiadomienie)
  jako komunikaty, bez porady.
- **Praca:** L.
- **Ryzyko:** R1, w module księgowości za wyłącznikiem `ksiegowosc` do bramy B1-B5.
- **Sprawdzamy na:** XSD i broszura JPK_V7K(3), testowa bramka MF (działa od K6), e-mikrofirma, przykłady zaliczek kwartalnych z podatki.gov.pl; księgowa (G15, G16). **Brakuje:** sprawdzenia, czy e-mikrofirma obsługuje V7K w potrzebnym zakresie, i podpisów G15, G16.
- **Prawnik / księgowa:** księgowa: złote przypadki G15, G16.

#### 4.2 Kasowy PIT
- **Klient dostaje:** przychód liczony w dniu zapłaty, a koszt po zapłacie,
  jeśli wybrał kasowy PIT.
- **Po co:** przepis L13.
- **W aplikacji:** znacznik w ustawieniach podatkowych od 1 stycznia
  (z datą oświadczenia); ewidencja i KPiR według daty wpłaty (3.1); granica
  dwóch lat od wystawienia faktury; `Kasowy_PIT` w JPK_EWP (dziś zawsze „NIE”).
- **Praca:** M; zależy od 3.1 (daty wpłat).
- **Ryzyko:** R1, w module księgowości za wyłącznikiem `ksiegowosc` do bramy B1-B5.
- **Sprawdzamy na:** ustawa o PIT (kasowy PIT) i broszura JPK_EWP(4) (`Kasowy_PIT`); księgowa (G17). **Brakuje:** potwierdzenia limitu w ustawie (biznes.gov.pl: 2 mln zł) i urzędowych przykładów.
- **Prawnik / księgowa:** księgowa: złoty przypadek G17; limit przychodu
  potwierdzić w ustawie (biznes.gov.pl podaje 2 mln zł).

#### 4.3 ZUS: pozostałe przypadki
- **Klient dostaje:** składki dla:
  - Małego ZUS Plus (podstawa z dochodu, przy ryczałcie 50 % przychodu,
    licznik 36 miesięcy w 60, przypomnienie o zgłoszeniu do 31 stycznia);
  - wakacji składkowych (wybrany miesiąc bez składek społecznych, wniosek RWS
    miesiąc wcześniej, zdrowotna i DRA zostają);
  - emeryta i rencisty prowadzącego firmę;
  - osoby współpracującej (np. małżonek w firmie);
  - pracy dla byłego pracodawcy (bez preferencji);
  - zawieszonej działalności.
- **Po co:** przepis L19; rynek.
- **W aplikacji:** nowe etapy w `tax_profiles.zus_etap` (dziś CHECK zna cztery,
  migracja 00166; `maly_zus_plus` przewidział plan księgowości) i w `zus.ts`;
  parametry z tabel ZUS ze źródłem; dochód z poprzedniego roku z modułu albo
  wpisany przez klienta.
- **Praca:** L.
- **Ryzyko:** R1, w module księgowości za wyłącznikiem `ksiegowosc` do bramy B1-B5.
- **Sprawdzamy na:** tabele ZUS i e-Płatnik w eZUS (ZUS sam liczy DRA, także przy Małym ZUS Plus i wakacjach składkowych); księgowa (G18, G19). **Brakuje:** konta płatnika do porównań co rok (robi to człowiek).
- **Prawnik / księgowa:** księgowa: złote przypadki G18, G19; porównanie
  z e-Płatnikiem ZUS.

#### 4.4 DRA i plik dla ZUS
- **Klient dostaje:** co miesiąc dane do deklaracji DRA i plik KEDU do
  wczytania w ePłatniku (eZUS), a w kwietniu z rocznym rozliczeniem zdrowotnej
  (5.7).
- **Po co:** przepis L18; rynek: Fakturownia ma DRA.
- **W aplikacji:** generator KEDU (schemat ZUS) z kwot zatwierdzonego miesiąca;
  walidacja; plik do pobrania (ZUS nie ma bramki dla programów, klient sam
  wczytuje plik).
- **Praca:** M; zależy od 4.3.
- **Ryzyko:** R1, w module księgowości za wyłącznikiem `ksiegowosc` do bramy B1-B5.
- **Sprawdzamy na:** schemat KEDU ZUS i import pliku w ePłatniku (ZUS sprawdza plik przy wczytaniu); e-Płatnik. **Brakuje:** środowiska testowego ZUS; takie nie istnieje, więc plik sprawdzamy wczytaniem na koncie firmy z pilotażu, bez wysyłki.
- **Prawnik / księgowa:** prawnik: pytanie 10; księgowa: porównanie
  z e-Płatnikiem.

#### 4.5 JPK_V7 w komplecie
- **Klient dostaje:** JPK_V7M i JPK_V7K, które obejmują wszystko, co klient
  wystawia i kupuje: WDT i eksport, odwrotne obciążenie, import usług i WNT
  (samonaliczenie), zakup środków trwałych, korekty z ulgi na złe długi,
  faktury do paragonów, raporty z kasy, dokumenty wewnętrzne, marżę, zwrot VAT
  na rachunek.
- **Po co:** przepisy L9, L10, L15; dziś plik odmawia przy odwrotnym
  obciążeniu i nie zna tych pól (sekcja 2.3).
- **W aplikacji:** pola K_21-K_41 i K_44-K_47 w generatorze, typy dokumentów
  FP, RO i WEW, procedury (np. MR_T, MR_UZ, TP), P_54-P_60 (zwrot); faktura
  wewnętrzna przy samonaliczeniu; odwieszenie eksportu JPK_V7M z danymi osoby
  fizycznej (D16 planu księgowości).
- **Praca:** L, kilka PR; zależy od 2.3 i 2.7.
- **Ryzyko:** R1, w module księgowości za wyłącznikiem `ksiegowosc` do bramy B1-B5.
- **Sprawdzamy na:** XSD i broszura JPK_V7(3) z sumami kontrolnymi, testowa bramka MF, e-mikrofirma; księgowa (G20, G21). **Brakuje:** sum kontrolnych z broszury jako testów i porównania z e-mikrofirmą pole po polu.
- **Prawnik / księgowa:** księgowa: złote przypadki G20, G21; porównanie
  z e-mikrofirmą MF.

#### 4.6 VAT-UE, VAT-8 i VAT-9M
- **Klient dostaje:** informację VAT-UE co miesiąc (sprzedaż i zakupy z UE),
  a firma zwolniona z VAT, która kupuje usługi z zagranicy (np. reklamy,
  programy): VAT-8 albo VAT-9M z kwotą do zapłaty; ostrzeżenie, gdy zakup może
  podlegać podatkowi u źródła (np. licencja).
- **Po co:** przepisy L9, L10, L27; rynek: Fakturownia.
- **W aplikacji:** generatory i XSD formularzy; rozpoznanie zakupu
  zagranicznego w kosztach (kraj sprzedawcy, rodzaj usługi); przypomnienie
  o rejestracji VAT-UE (bez porady); wysyłka w 5.5.
- **Praca:** M; zależy od 4.5.
- **Ryzyko:** R1, w module księgowości za wyłącznikiem `ksiegowosc` do bramy B1-B5.
- **Sprawdzamy na:** XSD e-Deklaracji i formularze interaktywne MF (VAT-UE, VAT-8, VAT-9M); VIES; księgowa (G20). **Brakuje:** potwierdzenia środowiska testowego bramki e-Deklaracji; dla podatku u źródła wzorca do liczenia nie ma, więc zostaje tylko ostrzeżenie (ryzyko).
- **Prawnik / księgowa:** księgowa: złoty przypadek G20; podatek u źródła
  tylko jako ostrzeżenie (decyzja prawnika, pytanie 13).

#### 4.7 Samochód w firmie
- **Klient dostaje:** pojazd w firmie z rodzajem użycia (mieszany albo tylko
  firmowy), odliczenie VAT 50 % albo 100 %, koszt w PIT 75 % albo 100 %,
  ewidencję przebiegu w telefonie, przypomnienie i plik VAT-26 (7 dni od
  pierwszego wydatku) oraz limity amortyzacji i leasingu według emisji CO2.
- **Po co:** przepis L17; rynek (prośba z recenzji inFaktu o pojazd
  w telefonie).
- **W aplikacji:** tabela pojazdów; koszty przypisane do pojazdu; reguły VAT
  i PIT w kosztach i JPK; ewidencja przebiegu (data, trasa, cel, kilometry);
  limity 100/150/225 tys. zł dla aut wprowadzonych od 1.01.2026.
- **Praca:** L; zależy od 5.1 dla amortyzacji.
- **Ryzyko:** R1, w module księgowości za wyłącznikiem `ksiegowosc` do bramy B1-B5.
- **Sprawdzamy na:** ustawa o VAT (art. 86a) i o PIT (art. 23), odpowiedź MF o limitach od 2026 r., wzór VAT-26; księgowa (G22). **Brakuje:** urzędowego przykładu limitu przy leasingu w testach.
- **Prawnik / księgowa:** księgowa: złoty przypadek G22.

#### 4.8 Proporcja VAT i zmiana statusu VAT w trakcie roku
- **Klient dostaje:** odliczenie VAT proporcją, gdy ma sprzedaż zwolnioną
  i opodatkowaną, z korektą po roku; przejście ze zwolnienia na czynny VAT po
  przekroczeniu limitu (od której faktury VAT, co z wcześniejszymi zakupami).
- **Po co:** przepis (art. 90 i limit art. 113 ustawy o VAT).
- **W aplikacji:** proporcja w ustawieniach i w JPK; zmiana statusu VAT
  z datą w historii ustawień; limit zwolnienia jest na pulpicie.
- **Praca:** M.
- **Ryzyko:** R1, w module księgowości za wyłącznikiem `ksiegowosc` do bramy B1-B5.
- **Sprawdzamy na:** ustawa o VAT (art. 90, 91) i objaśnienia MF; księgowa. **Brakuje:** urzędowych przykładów proporcji w testach.
- **Prawnik / księgowa:** księgowa.

### Etap 5. Środki trwałe i rozliczenie roku (K9, część 2)

#### 5.1 Środki trwałe i wartości niematerialne
- **Klient dostaje:** ewidencję środków trwałych z klasyfikacją KŚT, wartością
  i stawką; plan amortyzacji (liniowa, degresywna, jednorazowa do 50 000 euro,
  niskocenne do 10 000 zł); odpis co miesiąc w KPiR; sprzedaż i likwidację;
  plik JPK_ST.
- **Po co:** przepis L16; rynek: Fakturownia i wFirma.
- **W aplikacji:** tabele środków trwałych i odpisów; z faktury kosztowej
  „przyjmij jako środek trwały”; zakup w JPK_V7 (K_40, K_41); JPK_ST z XSD
  (schemat jest na gov.pl); przy ryczałcie ewidencja bez odpisów (wymagana do
  JPK_ST).
- **Praca:** L.
- **Ryzyko:** R1, w module księgowości za wyłącznikiem `ksiegowosc` do bramy B1-B5.
- **Sprawdzamy na:** XSD i broszura JPK_ST(1), interaktywny formularz MF JPK_ST(1), KŚT i wykaz stawek amortyzacyjnych z ustawy o PIT; księgowa (G23). **Brakuje:** przykładowych plików z broszury jako testów.
- **Prawnik / księgowa:** księgowa: złoty przypadek G23.

#### 5.2 Zeznanie PIT-28
- **Klient dostaje:** gotowe roczne zeznanie ryczałtu z ewidencji: przychody
  według stawek, odliczenia składek, najem prywatny (jeśli ma), korekty
  przeniesione z grudnia.
- **Po co:** przepis L20; rynek.
- **W aplikacji:** silnik roczny i wzór formularza na dany rok; podgląd pole
  po polu; plik do wysyłki (5.5).
- **Praca:** L.
- **Ryzyko:** R1, w module księgowości za wyłącznikiem `ksiegowosc` do bramy B1-B5.
- **Sprawdzamy na:** XSD PIT-28 na dany rok i formularz w e-Urzędzie Skarbowym (Twój e-PIT), który liczy podatek z wpisanych danych; księgowa (G26). **Brakuje:** wzoru i XSD na dany rok (publikuje MF) oraz ręcznej listy porównań z e-Urzędem przed każdym rokiem.
- **Prawnik / księgowa:** księgowa: złoty przypadek G26; najem prywatny:
  decyzja D6.

#### 5.3 Zeznania PIT-36 i PIT-36L
- **Klient dostaje:** zeznanie z KPiR z załącznikiem PIT/B, stratą z lat
  ubiegłych, odliczeniem składek (przy liniowym także zdrowotnej do limitu)
  i innymi dochodami wpisanymi z PIT-11 (np. etat obok); przy skali także ulgi
  z PIT/O (dzieci, internet, termomodernizacja, darowizny, IKZE,
  rehabilitacja), zwolnienia dla powracających z zagranicy, rodzin 4+
  i pracujących seniorów oraz wspólne rozliczenie z małżonkiem; przy dochodzie
  powyżej 1 mln zł deklarację daniny solidarnościowej (DSF-1).
- **Po co:** przepis L20; rynek (inFakt i wFirma mają roczne).
- **W aplikacji:** silniki roczne, wzory formularzy i załączników; dane
  małżonka i dzieci (RODO, pytanie 12).
- **Praca:** XL, kilka PR (najpierw PIT-36L, potem PIT-36 bez ulg, potem ulgi
  i wspólne rozliczenie).
- **Ryzyko:** R1, w module księgowości za wyłącznikiem `ksiegowosc` do bramy B1-B5.
- **Sprawdzamy na:** jak 5.2 (PIT-36, PIT-36L, PIT/B, PIT/O); księgowa (G24, G25). **Brakuje:** jak 5.2; przy wspólnym rozliczeniu dane małżonka spoza FaktWay.
- **Prawnik / księgowa:** prawnik: pytania 12, 13; księgowa: złote przypadki
  G24, G25.

#### 5.4 IP Box i ulga badawczo-rozwojowa
- **Klient dostaje:** ewidencję IP Box (przychody i koszty na każde prawo
  własności intelektualnej, wskaźnik nexus) i stawkę 5 % w zeznaniu; ulgę B+R
  z kosztów oznaczonych w KPiR (kolumna 16 jest od K7).
- **Po co:** przepis (ustawa o PIT); częste u programistów na B2B.
- **W aplikacji:** osobna ewidencja i formularze PIT/IP i PIT/BR.
- **Praca:** L.
- **Ryzyko:** R1, w module księgowości za wyłącznikiem `ksiegowosc` do bramy B1-B5; łatwo tu o poradę i o błąd w kwalifikacji.
- **Sprawdzamy na:** objaśnienia MF do IP Box z przykładami, formularze PIT/IP i PIT/BR. **Brakuje:** wzorca dla kwalifikacji dochodu i kosztów; taki nie istnieje, bo to ocena, a nie rachunek (ryzyko: decyduje klient z doradcą).
- **Prawnik / księgowa:** prawnik: pytanie 13 (czy to doradztwo);
  księgowa: przykłady.

#### 5.5 Wysyłka zeznań i deklaracji
- **Klient dostaje:** wysyłkę PIT-28, PIT-36, PIT-36L, VAT-UE, VAT-8, VAT-9M
  i VAT-26 z FaktWay danymi autoryzującymi, z UPO; do czasu opinii prawnika
  plik do samodzielnej wysyłki.
- **Po co:** przepis L20; bramka e-Deklaracji przyjmuje te formularze
  z danymi autoryzującymi (MF).
- **W aplikacji:** klient bramki e-Deklaracji według specyfikacji MF, wzór jak
  wysyłka JPK z K6 (dane autoryzujące tylko w pamięci, bez zapisu i logów);
  statusy i UPO; środowisko testowe, jeśli MF je udostępnia.
- **Praca:** L.
- **Ryzyko:** R1, w module księgowości za wyłącznikiem `ksiegowosc` do bramy B1-B5.
- **Sprawdzamy na:** specyfikacja wejścia-wyjścia bramki e-Deklaracji i UPO. **Brakuje:** potwierdzenia, czy MF ma środowisko testowe tej bramki.
- **Prawnik / księgowa:** prawnik: pytanie 9 (jak pytanie 3 dla JPK).

#### 5.6 JPK_PKPIR, JPK_EWP i JPK_ST razem z zeznaniem
- **Klient dostaje:** wysyłkę rocznych plików ksiąg w terminie zeznania, z UPO.
- **Po co:** przepis L21.
- **W aplikacji:** klient bramki JPK z K6 dla nowych struktur; `CelZlozenia`
  i korekty plików; JPK_ST z 5.1.
- **Praca:** M; zależy od 5.1.
- **Ryzyko:** R1, w module księgowości za wyłącznikiem `ksiegowosc` do bramy B1-B5.
- **Sprawdzamy na:** testowa bramka JPK (działa od K6) i XSD. **Brakuje:** próby wysyłki JPK_PKPIR, JPK_EWP i JPK_ST na teście.
- **Prawnik / księgowa:** prawnik: pytanie 3 (to samo co JPK_V7M).

#### 5.7 Roczna składka zdrowotna
- **Klient dostaje:** roczne rozliczenie zdrowotnej (dochód albo przychód
  z całego roku wobec zapłaconych składek), dopłatę albo nadpłatę, dane do DRA
  za kwiecień (termin 20 maja) i kwotę do odliczenia w zeznaniu.
- **Po co:** przepis L22.
- **W aplikacji:** silnik roczny w `zdrowotna.ts`; pozycja w „Ten miesiąc” za
  kwiecień; wpis w KEDU (4.4).
- **Praca:** M; zależy od 4.4.
- **Ryzyko:** R1, w module księgowości za wyłącznikiem `ksiegowosc` do bramy B1-B5.
- **Sprawdzamy na:** e-Płatnik (DRA za kwiecień z rocznym rozliczeniem), kalkulator składki zdrowotnej i przykłady ZUS; księgowa (G27). **Brakuje:** konta płatnika do porównań i przykładów ZUS jako testów.
- **Prawnik / księgowa:** księgowa: złoty przypadek G27; termin potwierdzić
  na zus.pl.

#### 5.8 Koniec i początek roku
- **Klient dostaje:** zamknięcie roku (spis z natury z 31 grudnia jest od K7.4,
  przeniesienie straty i niewykorzystanych odliczeń), nowe parametry od
  1 stycznia, zmianę formy opodatkowania od nowego roku z przypomnieniem
  o terminie (do 20 lutego albo 20. dnia po pierwszym przychodzie)
  i porównanie form na danych klienta, gdy prawnik je dopuści.
- **Po co:** przepis; rynek.
- **W aplikacji:** kreator nowego roku; porównanie form (`tax.simulate`) jako
  wynik trzech wyliczeń bez zalecenia (D8 planu księgowości).
- **Praca:** M; porównanie form L.
- **Ryzyko:** R1, w module księgowości za wyłącznikiem `ksiegowosc` do bramy B1-B5; porównanie form to pozycja „czerwona” planu księgowości, tylko po opinii prawnika.
- **Sprawdzamy na:** nowe parametry: rejestr źródeł i czujka filtra; porównanie form: każdą formę liczą te same silniki co rozliczenia, więc złote przypadki. **Brakuje:** wzorca dla samego porównania; taki nie istnieje, bo to symulacja, a ryzykiem jest porada, nie rachunek.
- **Prawnik / księgowa:** prawnik: pisemna opinia przed porównaniem form
  (pytanie 13).

#### 5.9 Zawieszenie, wznowienie i zamknięcie firmy
- **Klient dostaje:** tryb zawieszonej działalności (bez składek społecznych
  i zaliczek, z informacją, co zostaje), wznowienie oraz zamknięcie firmy:
  spis z natury na dzień likwidacji, VAT od towarów i środków trwałych
  z remanentu likwidacyjnego, ostatnie rozliczenia i archiwum.
- **Po co:** przepis (ustawa o VAT art. 14, przepisy ZUS i PIT).
- **W aplikacji:** okresy zawieszenia w ustawieniach; kreator zamknięcia
  z listą obowiązków.
- **Praca:** M.
- **Ryzyko:** R1, w module księgowości za wyłącznikiem `ksiegowosc` do bramy B1-B5.
- **Sprawdzamy na:** ustawa o VAT (art. 14) i przepisy ZUS; księgowa. **Brakuje:** urzędowego kalkulatora; taki nie istnieje (ryzyko: tylko księgowa i przykłady).
- **Prawnik / księgowa:** księgowa.

### Etap 6. Księgowa, przeprowadzka i dane

#### 6.1 Eksporty dla biur rachunkowych
- **Klient dostaje:** paczkę, którą wczyta program jego biura: Comarch Optima
  (format „Praca rozproszona”), Subiekt i Rewizor (EDI++), Symfonia i Wapro
  (JPK_FA, jest), JPK_V7M w eksporcie (dziś wstrzymany).
- **Po co:** rynek: klient z biurem też chce FaktWay do faktur.
- **W aplikacji:** nowe generatory zgodne z formatami importu tych programów;
  odwieszenie dopiero po próbnym imporcie w każdym programie (decyzja Igora
  z 29.09.2026); waluty po 2.1.
- **Praca:** M, jeden program na PR.
- **Ryzyko:** R2 (eksporty dla księgowych).
- **Sprawdzamy na:** próbny import w programie biura (Optima, Subiekt i Rewizor, Symfonia, Wapro). **Brakuje:** kont próbnych tych programów (przez biuro albo księgową).
- **Prawnik / księgowa:** księgowa z biura: próbny import.

#### 6.2 Księgowa w FaktWay
- **Klient dostaje:** księgowa widzi w swoim portalu także koszty i zdjęcia
  dokumentów (dziś tylko 100 faktur sprzedaży); uprawnienie dla księgowej
  w KSeF nadane z FaktWay (bez logowania do Aplikacji Podatnika); komentarze
  i prośby o dokument przy koszcie; zatwierdzanie kosztów przez księgową;
  księgowa z wieloma klientami widzi ich listę i terminy w jednym miejscu.
- **Po co:** rynek: Fakturownia i wFirma mają moduły dla biur; AGENTS.md:
  „target: mikroprzedsiębiorcy i księgowi”.
- **W aplikacji:** koszty i pliki w portalu z tymi samymi zabezpieczeniami
  co faktury (token, wygasanie, poziom „podgląd” albo „pobieranie”);
  zarządzanie uprawnieniami przez API KSeF (dziś brak); komentarze
  z powiadomieniem; obieg akceptacji kosztów według ról; widok wielu firm dla
  roli księgowej.
- **Praca:** L.
- **Ryzyko:** R1 (uprawnienia w KSeF), portal R2.
- **Sprawdzamy na:** KSeF TEST (API uprawnień) i dokumentacja CIRFMF. **Brakuje:** próby nadania i odebrania uprawnienia na KSeF TEST.
- **Prawnik / księgowa:** nie.

#### 6.3 Przeprowadzka z innego programu
- **Klient dostaje:** ścieżkę „Przenoszę się z Fakturowni / inFaktu / IFIRMY /
  wFirmy” z instrukcją dla każdego programu: kontrahenci, produkty, faktury,
  koszty i cała historia z KSeF w kilka minut; przy przesiadce w trakcie roku
  koszty od 1 stycznia trafiają do KPiR albo ewidencji, żeby rok liczył się
  w całości.
- **Po co:** rynek: to moment przesiadki (`FAKTWAY-1-0.md`); przepis: zaliczka
  PIT i zdrowotna liczą się narastająco od początku roku.
- **W aplikacji:** import CSV jest (faktury sprzedaży, kontrahenci, produkty);
  brakuje importu kosztów, zamiany zakupów z historii KSeF (dziś tylko
  archiwum) w koszty bieżącego roku bez dublowania, ścieżki dla każdego
  programu, produktów w katalogu (2.6) i raportu „co przeniesione, czego brak”.
- **Praca:** M.
- **Ryzyko:** R1 (import faktur i kosztów).
- **Sprawdzamy na:** pliki eksportu z każdego programu (zanonimizowane) i sumy z raportów tych programów; historia z KSeF. **Brakuje:** przykładowych plików z kont próbnych Fakturowni, inFaktu, wFirmy i IFIRMY.
- **Prawnik / księgowa:** nie.

#### 6.4 Wyjście, archiwum i kontrola skarbowa
- **Klient dostaje:** eksport wszystkiego (PDF, XML z KSeF, UPO, JPK, CSV)
  jednym przyciskiem, dostęp tylko do odczytu po rezygnacji do końca okresu
  przechowywania oraz „paczkę na kontrolę”: JPK na żądanie urzędu (JPK_FA dla
  faktur spoza KSeF, JPK_PKPIR, JPK_EWP, JPK_ST) i dokumenty z okresu.
- **Po co:** przepis L23; RODO (przenoszenie danych).
- **W aplikacji:** zadanie w tle składające archiwum; tryb tylko do odczytu po
  końcu abonamentu (decyzja D9); JPK z wybranym celem „na żądanie”.
- **Praca:** M.
- **Ryzyko:** R1 (przechowywanie i usuwanie danych).
- **Sprawdzamy na:** XSD JPK na żądanie i przepisy o przechowywaniu. **Brakuje:** opinii prawnika (pytanie 16).
- **Prawnik / księgowa:** prawnik: pytanie 16.

#### 6.5 KSeF bez plików
- **Klient dostaje:** podłączenie KSeF bez wgrywania certyfikatu: nadaje
  uprawnienie NIP-owi FaktWay albo podaje token.
- **Po co:** rynek: największy spadek w lejku (`FAKTWAY-1-0.md`).
- **W aplikacji:** projekt z hasła „mamy firmę”: kod firmy w opisie
  uprawnienia, typ poświadczeń `delegated`, rozstrzygnięcie tokenu na KSeF
  TEST.
- **Praca:** M; zależy od spółki (brama B1).
- **Ryzyko:** R1 (KSeF).
- **Sprawdzamy na:** KSeF TEST (uprawnienie dla NIP, token). **Brakuje:** NIP spółki (brama B1).
- **Prawnik / księgowa:** prawnik: pytanie 14.

### Etap 7. API i automatyzacja

#### 7.1 Publiczne API i webhooki
- **Klient dostaje:** klucz API dla swojej firmy z zakresami (np. tylko
  odczyt), wystawianie faktur i odczyt kosztów z własnych programów oraz
  powiadomienia do własnego adresu (faktura przyjęta w KSeF, nowa faktura
  kosztowa, wpłata).
- **Po co:** rynek: wszyscy liderzy mają API; prośba o webhooki z recenzji.
- **W aplikacji:** API z kluczami na firmę, limitami i audytem; dokumentacja;
  webhooki z podpisem i ponowieniami; te same reguły co interfejs (RLS,
  walidacja, wysyłka przez kolejkę).
- **Praca:** L.
- **Ryzyko:** R1 (API wystawia faktury); zewnętrzny test zabezpieczeń przed startem.
- **Sprawdzamy na:** te same testy co interfejs, bo API woła te same akcje. **Brakuje:** zewnętrznego testu zabezpieczeń.
- **Prawnik / księgowa:** prawnik: regulamin API (pytanie 15).

#### 7.2 Łącze dla asystentów AI (MCP)
- **Klient dostaje:** podłączenie FaktWay do własnego asystenta (np. Claude,
  ChatGPT) tylko do odczytu: faktury, należności, koszty.
- **Po co:** rynek: Fakturownia (odczyt) i inFakt; w ofercie bez słowa „AI”
  jako hasła (`FAKTWAY-1-0.md`).
- **W aplikacji:** serwer MCP na kluczach z 7.1, tylko odczyt.
- **Praca:** M; zależy od 7.1.
- **Ryzyko:** R2 (pokazuje kwoty).
- **Prawnik / księgowa:** nie.

#### 7.3 Terminy w kalendarzu
- **Klient dostaje:** terminy podatków, ZUS, płatności i faktur cyklicznych
  w swoim kalendarzu (adres iCal).
- **Po co:** rynek; mniej przegapionych terminów.
- **W aplikacji:** adres kalendarza z niezgadywalnym kluczem.
- **Praca:** S.
- **Ryzyko:** R1 (terminy podatkowe).
- **Sprawdzamy na:** kalendarz terminów modułu (testy na lata 2025-2028). **Brakuje:** nic istotnego.
- **Prawnik / księgowa:** nie.

### Etap 8. Wygoda i zasięg

#### 8.1 Powiadomienia w aplikacji i drobne braki
- **Klient dostaje:** dzwonek z prawdziwymi powiadomieniami (nowa faktura
  zakupu, wpłata, odrzucenie w KSeF, termin podatku) zamiast napisu o FLO;
  push „Otrzymana płatność”, który naprawdę przychodzi; po udostępnieniu
  zdjęcia z telefonu widok postępu odczytu; listę faktur za abonament
  FaktWay w ustawieniach.
- **Po co:** rynek; niespójności z sekcji 2.6.
- **W aplikacji:** zdarzenie `invoicePaymentReceived` wysyłane przy zapisie
  wpłaty (3.1, 3.2, 3.3) z kluczem idempotencji; skrzynka powiadomień
  w bazie; ekran po udostępnieniu zdjęcia; lista faktur abonamentu.
- **Praca:** M; zależy od 3.1.
- **Ryzyko:** R2 (powiadomienia o płatnościach i terminach).
- **Prawnik / księgowa:** nie.

#### 8.2 Interfejs po angielsku i ukraińsku
- **Klient dostaje:** aplikację po angielsku albo ukraińsku, dla właścicieli
  firm, którzy słabo znają polski.
- **Po co:** rynek.
- **W aplikacji:** słowniki tekstów; teksty prawne i podatkowe tylko po polsku
  z tłumaczeniem pomocniczym.
- **Praca:** L.
- **Ryzyko:** R2 (tłumaczenie treści o podatkach).
- **Prawnik / księgowa:** prawnik: pytanie 17.

#### 8.3 Pulpit do ułożenia
- **Klient dostaje:** wybór kart na pulpicie i ich kolejność; zbiorcze sumy
  przychodów w miesiącu.
- **Po co:** rynek: prośby z recenzji.
- **W aplikacji:** ustawienia pulpitu na użytkownika.
- **Praca:** M.
- **Ryzyko:** R2 (pulpit i szacunki).
- **Prawnik / księgowa:** nie.

#### 8.4 Dostępność
- **Klient dostaje:** aplikację, z której wygodnie korzysta osoba słabowidząca
  albo używająca tylko klawiatury.
- **Po co:** dobra praktyka (WCAG 2.1 AA).
- **W aplikacji:** przegląd kontrastów, etykiet i kolejności fokusu;
  poprawki za prefiksami telefonu albo po decyzji D1.
- **Praca:** M.
- **Ryzyko:** R0.
- **Prawnik / księgowa:** nie.

#### 8.5 Bezpieczeństwo konta i test zabezpieczeń
- **Klient dostaje:** listę zalogowanych urządzeń z wylogowaniem na odległość,
  historię logowań i powiadomienie o logowaniu z nowego urządzenia.
- **Po co:** rynek: wyciek w Fakturowni z 27-28.09.2026 (`CO-DODAC-500.md`);
  przed mówieniem o bezpieczeństwie potrzebny zewnętrzny test zabezpieczeń.
- **W aplikacji:** ekran sesji na danych GoTrue; wpisy logowań w audycie;
  zewnętrzny test zabezpieczeń całej aplikacji przed startem sprzedaży (zlecenie
  Bartosza, nie kod).
- **Praca:** M.
- **Ryzyko:** R0.
- **Prawnik / księgowa:** nie.

### Etap 9. Zakres z decyzji granicznych

Te kroki wchodzą tylko przy „tak” Bartosza w sekcji 6.

#### 9.1 Kadry i płace dla mikrofirm (decyzja P3)
- **Klient dostaje:** w pierwszym kroku umowy zlecenia i o dzieło: rachunek,
  składki, podatek, ZUS RCA i DRA, PIT-11 i PIT-4R; w drugim pracownika na
  umowie o pracę (do kilku osób): lista płac, PPK, zgłoszenia do ZUS
  i przypomnienia (badania, szkolenie BHP).
- **Po co:** rynek: wFirma ma kadry za 60 zł netto; prośba z recenzji
  o rachunki do umów cywilnoprawnych.
- **W aplikacji:** nowy moduł z osobnymi parametrami (płaca minimalna,
  składki pracownika, koszty uzyskania, PPK) i wyłącznikiem.
- **Praca:** XL (osobny plan z listą inwariantów).
- **Ryzyko:** R1, osobny moduł za wyłącznikiem do bramy B1-B5.
- **Sprawdzamy na:** tylko częściowy: e-Płatnik sprawdza składki w ZUS RCA i DRA; są schematy PIT-4R i PIT-11. **Brakuje:** państwowego wzorca dla listy płac (wynagrodzenie netto, zaliczka PIT pracownika, PPK, potrącenia); taki nie istnieje, więc to ryzyko wprost: wynik sprawdzają tylko księgowa kadrowa i druga niezależna implementacja.
- **Prawnik / księgowa:** prawnik: pytanie 11; księgowa kadrowa.

#### 9.2 Spółka cywilna i jawna na KPiR
- **Klient dostaje:** firmę ze wspólnikami: jedna KPiR i VAT spółki, a podatek
  i ZUS każdego wspólnika według udziału.
- **Po co:** to małe firmy (KPiR do 2,5 mln euro przychodu); dziś FaktWay
  liczy tylko JDG.
- **W aplikacji:** wspólnicy z udziałami i własnymi ustawieniami podatkowymi;
  podział przychodów i kosztów.
- **Praca:** L; zależy od etapów 4 i 5.
- **Ryzyko:** R1, w module księgowości za wyłącznikiem `ksiegowosc` do bramy B1-B5.
- **Sprawdzamy na:** silniki JDG liczone dla każdego wspólnika; księgowa. **Brakuje:** wzorca dla podziału między wspólników; taki nie istnieje (ryzyko: tylko księgowa).
- **Prawnik / księgowa:** księgowa.

#### 9.3 Kasa fiskalna: limit i raporty (decyzja P6)
- **Klient dostaje:** licznik sprzedaży dla osób prywatnych z ostrzeżeniem
  przed limitem 20 000 zł i informacją o usługach, które wymagają kasy od
  początku; raporty z kasy w ewidencji (są) i w JPK (typ RO z 4.5).
- **Po co:** przepis L25.
- **W aplikacji:** licznik z faktur dla konsumentów i wpisów ręcznych;
  bez połączenia z kasami i drukarkami.
- **Praca:** S.
- **Ryzyko:** R2 (licznik limitu).
- **Sprawdzamy na:** rozporządzenie o zwolnieniach z kas (limit, lista czynności). **Brakuje:** nic istotnego.
- **Prawnik / księgowa:** nie.

#### 9.4 OSS: licznik progu (decyzja P5)
- **Klient dostaje:** licznik sprzedaży dla konsumentów z innych krajów UE
  z ostrzeżeniem przed progiem 10 000 euro.
- **Po co:** przepis L26.
- **W aplikacji:** licznik z faktur dla konsumentów z UE; bez deklaracji
  VIU-DO.
- **Praca:** S; zależy od 2.1.
- **Ryzyko:** R2 (licznik progu).
- **Sprawdzamy na:** objaśnienia MF do OSS (próg) i kurs NBP. **Brakuje:** nic istotnego.
- **Prawnik / księgowa:** nie.

#### 9.5 Pełna księgowość (decyzja P4)
Rekomendacja: nie budujemy (sekcja 6). Jeśli Bartosz zdecyduje inaczej,
powstaje osobny plan: księgi rachunkowe, plan kont, sprawozdanie finansowe,
CIT, JPK_KR_PD. Wzorca do sprawdzenia poprawności tu nie ma (sekcja 8.2):
to ryzyko wprost i kolejny powód rekomendacji „nie”.

---

## 6. Decyzje (przyjęte 8.11.2026)

Bartosz przyjął 8.11.2026 wszystkie rekomendacje z tabel 6.1 i 6.2 bez zmian
(odpowiedź „tak przyjmuje” na pytanie o rekomendacje z tej sekcji). Kolumna
„Rekomendacja” jest więc decyzją. Zmiana decyzji wymaga nowego wiersza
w dzienniku (sekcja 12).

### 6.1 Sprawy na granicy zakresu

| # | Sprawa | Rekomendacja | Dlaczego |
|---|---|---|---|
| P1 | Import pliku z banku | **tak** (krok 3.2) | to nie openbanking: klient sam pobiera plik; tabela i projekt są (`PLAN-FINORA.md`, N5); bez tego „zapłacone” zostaje ręczne, a wszyscy liderzy mają bank |
| P2 | Linki do płatności | **tak, przez konto klienta u operatora** (krok 3.3) | pieniądze idą prosto do klienta, FaktWay ich nie dotyka; trzech liderów to ma; warunek: odpowiedź prawnika (pytanie 7); Stripe Connect wymaga spółki |
| P3 | Kadry i płace | **tak, dla mikrofirm, jako ostatni duży krok** (9.1): najpierw umowy zlecenia i o dzieło, potem kilku pracowników na umowie o pracę | wFirma ma kadry, a bez nich mała firma z jednym pracownikiem i tak potrzebuje biura; pełne kadry (czas pracy, urlopy, akta) to już program dla większych firm. Alternatywy: nie (eksport dla biura płacowego) albo pełne kadry |
| P4 | Pełna księgowość spółek | **nie** | inne prawo (ustawa o rachunkowości, plan kont, sprawozdanie finansowe, CIT); to obszar biur i dużych programów; spółka z o.o. dostaje w FaktWay faktury, koszty, VAT i paczkę dla biura. Spółka cywilna i jawna na KPiR to osobna sprawa (D7) |
| P5 | OSS i sprzedaż wysyłkowa | **tylko licznik progu 10 000 euro** (9.4) | deklaracja VIU-DO i sprzedaż do konsumentów w całej UE to świat e-commerce; licznik chroni małą firmę przed niezauważonym przekroczeniem |
| P6 | Kasy i drukarki fiskalne | **bez połączenia z kasami; licznik limitu i raporty z kasy** (9.3) | kasa to osobne urządzenie albo specjalne oprogramowanie dopuszczone tylko w niektórych branżach, a integracje z drukarkami to sprzęt i serwis; faktura do paragonu (1.2) i raporty z kasy (ewidencja, JPK) wystarczą małej firmie z kasą |

### 6.2 Pozostałe decyzje

| # | Sprawa | Rekomendacja |
|---|---|---|
| D1 | Zamrożony wygląd na Macu: waluta, język, rodzaj dokumentu i nowe ekrany muszą zmienić istniejące ekrany | wolno dodawać pola i sekcje z istniejących komponentów; nie wolno przestawiać ani zmieniać wyglądu tego, co jest; pulpit do ułożenia (8.3) i poprawki dostępności (8.4) tylko za osobną zgodą |
| D2 | Kiedy włączać | faktury, pieniądze, przeprowadzka i wygoda od razu po testach i filtrze (nikt jeszcze nie korzysta); wszystko z modułu księgowości za wyłącznikiem `ksiegowosc` do bramy B1-B5 |
| D3 | Języki faktur | najpierw angielski i dwujęzyczna polsko-angielska; potem niemiecki i ukraiński; kolejne na prośbę klientów |
| D4 | Kolejność | etap 1 przed 31.12.2026, potem etapy po kolei; równolegle tylko kroki bez wspólnych plików |
| D5 | Faktury cykliczne wystawiane same | tak, jako opcja włączana przez klienta, z podglądem i limitem; przypomnienia o płatności zostają wysyłane przez człowieka (decyzja zapisana w kodzie) |
| D6 | Najem prywatny w PIT-28 | tak (ten sam formularz); PIT-38 i inne dochody spoza firmy nie, poza kwotami z PIT-11 potrzebnymi w PIT-36 |
| D7 | Spółka cywilna i jawna na KPiR | tak, po etapach 4 i 5 (9.2) |
| D8 | Zeznania za 2026 r. (do 30.04.2027) | nie gonimy; pierwsze zeznania z FaktWay za 2027 r., a etap 5 powstaje w 2027 r. z pilotażem |
| D9 | Archiwum po rezygnacji | dostęp tylko do odczytu do końca okresu przechowywania, bezpłatnie (zaufanie przy przesiadce) |
| D10 | SMS | nie (koszt każdej wiadomości; mail i powiadomienie w telefonie działają) |
| D11 | Etap 1 a żelazny filtr (rekomendacja D-F1 filtra: R1 i R2 dopiero po fazie II filtra) | najpierw fazy filtra dla obszarów etapu 1 (faktury FA(3), KSeF, koszty, dane do przelewu); jeśli nie zdążą do ok. 1.12.2026, kroki 1.2-1.4 idą według obecnego protokołu naprawy z `/code-review` i kartą zmiany prawnej, bo 1.01.2027 to twardy termin |

---

## 7. Prawnik i księgowa

### 7.1 Nowe pytania do prawnika

Dopisane w kroku 0.1 do `docs/ksiegowosc/PYTANIA-DO-PRAWNIKA.md` jako
pytania 7-17 (pytania 1-6 dotyczą modułu księgowości); pytanie 18 dopisane
12.11.2026 przy zmianie art. 22p ustawy o PIT (krok 3.4). Prawnik dostaje jeden
pakiet razem z pytaniami planu „zero zgubionych faktur” (jego sekcja 9).

| # | Pytanie | Kroki |
|---|---|---|
| 7 | Linki do płatności: czy FaktWay świadczy usługę płatniczą, gdy tylko tworzy link u operatora klienta i odbiera potwierdzenie wpłaty? | 3.3 |
| 8 | Import wyciągu: RODO (prywatne operacje, dane kontrahentów), co i jak długo przechowywać | 3.2 |
| 9 | Wysyłka zeznań i deklaracji (PIT-28, PIT-36, PIT-36L, VAT-UE, VAT-8, VAT-9M, VAT-26) danymi autoryzującymi klienta: jak pytanie 3, czy potrzebne pełnomocnictwo | 5.5 |
| 10 | Plik KEDU dla ZUS: czy przygotowanie dokumentu, który klient sam wczytuje, wymaga pełnomocnictwa ZUS | 4.4 |
| 11 | Kadry i płace (jeśli P3): odpowiedzialność, dane pracowników (także o zdrowiu przy zwolnieniach), umowy powierzenia | 9.1 |
| 12 | Ulgi i wspólne rozliczenie: dane małżonka i dzieci (RODO), odpowiedzialność przy ulgach | 5.3 |
| 13 | Porównanie form opodatkowania, IP Box, ulga B+R i ostrzeżenie o podatku u źródła: czy to doradztwo podatkowe; bezpieczne sformułowania | 4.6, 5.4, 5.8 |
| 14 | KSeF bez plików (uprawnienie dla NIP FaktWay): umowa z klientem, odpowiedzialność, zabezpieczenie kodem firmy | 6.5 |
| 15 | Publiczne API: regulamin, odpowiedzialność za integracje klientów | 7.1 |
| 16 | Archiwum po rezygnacji i paczka na kontrolę: obowiązki po odejściu klienta | 6.4 |
| 17 | Interfejs po angielsku i ukraińsku: czy tłumaczenie regulaminu i treści podatkowych wiąże, czy wystarczy tłumaczenie pomocnicze | 8.2 |
| 18 | Co jest „datą wystawienia” faktury z KSeF na przełomie roku: P_1 czy data przesłania do KSeF (art. 3 Dz.U. 2026 poz. 1371)? Od tej daty zależy, czy rachunek spoza wykazu odbiera koszt w PIT | 3.4 |

### 7.2 Co sprawdza księgowa

Nowe złote przypadki są w drugim arkuszu `docs/ksiegowosc/ZLOTE-PRZYPADKI-2.md`
(krok 0.1); G1-G14 zostają w pierwszym. Każdy liczy księgowa i podpisuje,
a test sprawdza wynik co do grosza.

| # | Przypadek | Kroki |
|---|---|---|
| G15 | VAT kwartalny (V7K) z korektą w drugim miesiącu kwartału | 4.1 |
| G16 | Zaliczki PIT kwartalne (skala) i ryczałt kwartalny | 4.1 |
| G17 | Kasowy PIT: faktura zapłacona w następnym miesiącu i po dwóch latach | 4.2 |
| G18 | Mały ZUS Plus: podstawa z dochodu i z ryczałtu | 4.3 |
| G19 | Wakacje składkowe w miesiącu z chorobowym | 4.3 |
| G20 | Import usług z UE i spoza UE u czynnego i u zwolnionego (JPK, VAT-8, VAT-9M, VAT-UE) | 4.5, 4.6 |
| G21 | WDT i eksport w JPK i VAT-UE | 2.3, 4.5 |
| G22 | Samochód: 50 % VAT, 75 % PIT, limit 100 000 zł przy leasingu | 4.7 |
| G23 | Środek trwały: amortyzacja liniowa, degresywna, jednorazowa i sprzedaż | 5.1 |
| G24 | PIT-36 ze stratą z lat ubiegłych i ulgą na dziecko | 5.3 |
| G25 | PIT-36L z odliczeniem zdrowotnej | 5.3 |
| G26 | PIT-28 z dwiema stawkami i najmem | 5.2 |
| G27 | Roczna zdrowotna: ryczałt z przekroczeniem progu i liniowy | 5.7 |
| G28 | Złe długi: VAT i PIT wierzyciela i dłużnika | 3.5 |
| G29 | Faktura w EUR: kurs, zaliczka, różnica kursowa przy zapłacie | 2.1, 3.6 |
| G30 | Faktura do paragonu bez podwójnego przychodu | 1.2 |

Do tego księgowa sprawdza 10 faktur z KSeF TEST (kryterium G5 z
`GOTOWOSC-DO-WYDANIA.md`) po kroku 1.1 i po każdym nowym rodzaju faktury.

---

## 8. Żelazny filtr: jak każda funkcja przechodzi kontrolę

Poziomy pochodzą z mapy ryzyka sesji `zelazny-filtr` (notatka z 8.11.2026).
Pełny plan filtra: `docs/koordynacja/PLAN-ZELAZNY-FILTR.md` na gałęzi
`claude/zelazny-filtr-plan`, czeka na zgodę Bartosza. Gdy mapa się zmieni,
oznaczenia w sekcji 5 idą za nią.

| Poziom | Co znaczy | Kroki tego planu |
|---|---|---|
| R1, krytyczny | zły wynik zmienia kwotę podatku albo składki, termin, dokument dla urzędu albo kontrahenta (faktura, JPK, KSeF) albo przechowywanie danych | 1.1-1.6, 2.1-2.3, 2.5-2.10, 3.1-3.8, etapy 4 i 5, 6.2-6.5, 7.1, 7.3, 9.1, 9.2 |
| R2, wprowadza w błąd | nie jest dokumentem, ale może skłonić klienta do złej decyzji o pieniądzach (szacunki, pulpit, przypomnienia, teksty o podatkach, regulamin, eksporty dla księgowych) | 2.4, 6.1, 7.2, 8.1-8.3, 9.3, 9.4 |
| R3, pomocniczy | kod, którego używają R1 i R2 (daty, strefa Warszawy, formatowanie kwot, odczyt stronami) | części wielu kroków |
| R0 | bez ryzyka prawnego (wygląd, logowanie, analityka) | 0.1, 8.4, 8.5 |

**Co musi mieć krok R1 albo R2** (z mapy filtra): regułę w rejestrze przepisów
(artykuł, źródło, data obowiązywania), czerwony test, niezmienniki, porównanie
z wyrocznią (przy R1: testowy KSeF, bramka MF, e-mikrofirma, e-Płatnik, złote
przypadki), walidację XSD przy plikach, kartę zmiany prawnej w PR i drugiego
czytelnika z listą kontrolną. Zmiana oczekiwanych kwot, przepisów albo
parametrów wymaga etykiety Bartosza w PR.

**Brama dla klientów.** Niezależnie od filtra wszystko, co dzieje się w module
księgowości (ewidencja, KPiR, JPK, rozliczenia, deklaracje, zeznania, ZUS),
zostaje za wyłącznikiem `ksiegowosc` do bramy B1-B5 z planu księgowości, a złote
przypadki podpisują dwie niezależne księgowe. Zasada nadrzędna zostaje: gdy
czegoś nie da się potwierdzić, program nie pokazuje kwoty, tylko komunikat
z wyjściem.

**Kolejność wobec filtra.** Rekomendacja D-F1 filtra mówi, że kroki R1 i R2
ruszają, gdy faza II filtra obejmie ich obszar. Prawie cały ten plan to R1,
a etap 1 ma twardy termin 1.01.2027, dlatego decyzja D11 w sekcji 6.

### 8.1 Na czym sprawdzamy wynik

Według notatki „Źródła prawdy” z 8.11.2026 (analiza zlecona przez Bartosza).
Wzorce od najmocniejszego:
1. system państwowy, który sam liczy albo przyjmuje dokument;
2. dokumenty, które prawdziwe firmy złożyły i urząd przyjął (pilotaż, za
   zgodą firm);
3. dwie niezależne księgowe;
4. urzędowe przykłady z broszur, objaśnień i poradników;
5. druga, niezależna implementacja;
6. na końcu programy konkurencji, tylko do ręcznego sprawdzenia kilku
   przypadków.

| Obszar | Wzorzec | Już mamy | Czego brakuje | Kroki |
|---|---|---|---|---|
| Faktury FA(3) i KSeF | schemat FA(3), dokumentacja KSeF 2.0 (CIRFMF), KSeF TEST, przykładowe faktury MF | XSD FA(3) lokalnie; próba wysyłki na prawdziwym KSeF TEST (H1a planu zero) | automatyczna wysyłka każdego rodzaju (H1b); certyfikat typu Offline na TEST; uprawnienie do samofakturowania na TEST | 1.1-1.5, 2.1-2.10, 6.2, 6.5 |
| JPK_V7M i JPK_V7K | XSD i broszura JPK_V7(3), testowa bramka MF, e-mikrofirma | XSD; próba K6.0 na bramce testowej (status 200, UPO) | sumy kontrolne z broszury jako testy; porównanie z e-mikrofirmą pole po polu, ręcznie przed każdą zmianą | 1.2, 3.5, 4.1, 4.5 |
| JPK_EWP, JPK_PKPIR, JPK_ST | XSD, broszury i formularze interaktywne MF, rozporządzenie o KPiR | XSD EWP i PKPIR | XSD i przykłady JPK_ST; próba wysyłki z zeznaniem na teście | 5.1, 5.6 |
| VAT-UE, VAT-8, VAT-9M, VAT-26, zeznania PIT | XSD e-Deklaracji, formularze interaktywne MF, e-Urząd Skarbowy (Twój e-PIT liczy podatek z wpisanych danych) | nic | wzory na dany rok; potwierdzenie środowiska testowego bramki e-Deklaracji; ręczna lista porównań z e-Urzędem co rok | 4.6, 4.7, 5.2-5.5 |
| Składki ZUS, DRA, roczna zdrowotna | tabele ZUS, e-Płatnik w eZUS (sam liczy DRA), import KEDU w ePłatniku, kalkulator składki zdrowotnej ZUS | tabele 2026 odtworzone co do grosza (K1) | konto płatnika do porównań (człowiek, co rok); ZUS nie ma środowiska testowego | 4.3, 4.4, 5.7 |
| Stawki, progi, limity roku | Dziennik Ustaw, Monitor Polski, tabele ZUS, limity MF | rejestr parametrów 2026 i 2027 ze źródłami, podpis księgowej (D7 planu księgowości) | parametry nowych obszarów (diety, odsetki, limity aut, Mały ZUS Plus); czujka ELI API | 2.9, 3.8, 4.3, 4.7 |
| Reguły liczenia (PIT, ryczałt, odliczenia, złe długi, różnice kursowe, amortyzacja) | teksty jednolite ustaw (ISAP), objaśnienia MF, przykłady z podatki.gov.pl i zus.pl | szkielety złotych przypadków G1-G14 | G15-G30 podpisane przez dwie niezależne księgowe (B4); druga niezależna implementacja | 3.5, 3.6, 4.1-4.8, 5.1-5.9 |
| Kursy walut | API NBP (tabela A) i reguły z ustaw | klient NBP | testy na archiwalnych tabelach z dniami wolnymi i przełomem roku | 2.1, 3.6 |
| Kontrahenci i rachunki | GUS (BIR), biała lista MF (API), VIES | GUS, status NIP na białej liście, VIES w walidacji | sprawdzenie rachunku podpięte przy kosztach; testy każdego stanu odpowiedzi API | 2.3, 3.4 |
| Terminy i dni wolne | ustawa o dniach wolnych, Ordynacja podatkowa (art. 12 § 5), terminy z ustaw | kalendarz z testami | nowe terminy (kwartalne, roczne, VAT-26, ZAW-NR, wniosek RWS) w tym samym kalendarzu | 4.1, 4.3, 4.7, 5.2, 7.3 |
| Eksporty dla biur i przeprowadzka | próbny import w programie docelowym; pliki eksportu z programów | JPK_FA, CSV | konta próbne Optimy, Subiekta, Symfonii i Wapro; pliki z kont próbnych Fakturowni, inFaktu, wFirmy i IFIRMY | 6.1, 6.3 |
| Prawdziwe dane | dokumenty z pilotażu przyjęte przez urząd i ZUS (UPO, stan konta w PUE ZUS) | nic | firmy pilotażowe i ich zgoda na porównanie 12 miesięcy (B6) | wszystkie kroki R1 |

### 8.2 Funkcje bez wzorca: ryzyko wprost

Dla tych rzeczy nie ma systemu państwowego ani urzędowego przykładu, który
potwierdzi wynik. Sprawdzą je tylko księgowa, niezmienniki i druga niezależna
implementacja, więc ryzyko błędu zostaje wyższe niż przy reszcie planu:
- kadry i płace (9.1): lista płac, zaliczka PIT pracownika, PPK i potrącenia;
  ZUS sprawdzi tylko składki;
- pełna księgowość spółek (9.5): systemy, które przyjmują sprawozdania,
  sprawdzają format, a nie poprawność;
- podział wyniku między wspólników spółki cywilnej i jawnej (9.2);
- porównanie form opodatkowania (5.8): to symulacja, a ryzykiem jest porada;
- kwalifikacja dochodu i kosztów w IP Box i uldze B+R (5.4);
- podatek u źródła przy zakupach z zagranicy (4.6): tylko ostrzeżenie, bez
  liczenia;
- kaucja na fakturze (2.7), noty odsetkowe (2.9), różnice kursowe (3.6),
  zawieszenie i zamknięcie firmy (5.9): brak urzędowych przykładów, liczy
  księgowa;
- tryb awaryjny KSeF (1.5): awarii nie da się wywołać na zamówienie, zostają
  testy terminów;
- tłumaczenia etykiet faktury i aplikacji (2.2, 8.2): nie ma urzędowego
  słownika.

---

## 9. Kalendarz przepisów, który ustawia kolejność

| Data | Co się dzieje | Krok |
|---|---|---|
| 31.12.2026 | ostatni dzień: faktury z kas i paragony z NIP jako faktury uproszczone, sprzedaż do 10 000 zł poza KSeF; projekt odroczenia kar KSeF ma wejść w życie | 1.2-1.6 |
| 1.01.2027 | KSeF dla wszystkich; faktura do paragonu w KSeF; numer KSeF w tytule przelewu; księgi w programie dla wszystkich na PIT | etap 1 |
| 1.01.2027 albo 1.01.2028 | kary z art. 106ni (zależnie od uchwalenia projektu) | etap 1 |
| 15.02-30.04.2027 | zeznania za 2026; JPK_PKPIR, JPK_EWP i JPK_ST za 2026 dla grupy V7M | 5.2-5.6 (decyzja D8) |
| 20.05.2027 | roczne rozliczenie zdrowotnej za 2026 | 5.7 |
| 31.12.2027 | koniec zwolnień z kasy z obecnego rozporządzenia | 9.3 |
| 2028 | zeznania, JPK z księgami i roczna zdrowotna za 2027 dla wszystkich klientów FaktWay | etap 5 |
| 30.06.2030 | koniec odwrotnego obciążenia dla gazu, energii i uprawnień do emisji (według projektu) | 2.7 |

Co roku (czujka filtra): płaca minimalna (wrzesień), prognozowane przeciętne
wynagrodzenie (ustawa budżetowa), przeciętne wynagrodzenie za IV kwartał
(styczeń), limity w euro (kurs z października), tabele ZUS (grudzień),
stopa wypadkowa (kwiecień), nowe wzory formularzy i schematy JPK.

---

## 10. Zasady pracy dla sesji

1. Jeden krok to jedna gałąź `claude/kompletna-<krok>-<temat>` od świeżego
   `origin/main` i jeden PR (duży krok: kilka PR po kolei). Naprawy po drodze
   według protokołu z `AGENTS.md`: najpierw czerwony test.
2. Numer migracji: `node scripts/dev/nastepna-migracja.mjs` (od 00207 bez
   wiersza w rejestrze `docs/koordynacja/CLAUDE-DO-CODEXA.md`, tabela jest
   zamrożona; opis i „przed/PO wdrożeniu” w nagłówku pliku migracji,
   w linii `-- KIEDY WGRAĆ: …`). Nowe tabele z `tenant_id`, RLS
   i testem w `tests/rls-*.test.ts`; nowe kolumny w `tenants` z jawnym
   GRANT SELECT (00112).
3. Kroki z modułu księgowości za wyłącznikiem `ksiegowosc` (osobny obszar
   na każdy krok w `lib/ksiegowosc/wylacznik.ts`); pozostałe według decyzji
   D2. Każdy krok R1 i R2 spełnia wymagania filtra z sekcji 8.
4. Każdy nowy rodzaj faktury i każda zmiana generatora: XSD lokalnie, próba
   na KSeF TEST, `pnpm verify:fa3` (runbook `docs/runbooks/fa3-ksef.md`).
5. Liczby w testach na sztywno (crony, zadania) zmieniasz świadomie,
   z komentarzem.
6. Wygląd: nowe ekrany z komponentów Finory; istniejące ekrany na Macu tylko
   według decyzji D1; zmiany „na telefon” za prefiksami (`max-sm:`,
   `sm:hidden`); każdy ekran działa w telefonie.
7. Teksty: bez trybu rozkazującego przy podatkach, bez „AI”, bez długich
   myślników i plakietek; każdy brak ma komunikat, co zrobić.
8. Przed PR: `pnpm typecheck`, eslint na zmienionych plikach, pełny
   `pnpm vitest run`, przy zmianach w `app/` także `pnpm build`; na Macu
   najwyżej jeden pełny build naraz. Potem `/code-review`.
9. Scalanie, migracje na `db-1` i wdrożenie tylko na polecenie Bartosza
   (`AGENTS.md`).
10. Po kroku: wiersz w dzienniku, nowy „Następny krok”, raport (status, tabela
    weryfikacji, numer PR, co dalej) i STOP.

---

## 11. Źródła (odczyt 8.11.2026)

**KSeF**
- Zakres obowiązkowego KSeF, wyłączenia, noty korygujące, faktury z kas do
  końca 2026: https://ksef.podatki.gov.pl/informacje-ogolne-ksef-20/zakres-obowiazkowego-ksef/ (zmiana 06.02.2026)
- Tryby szczególne: https://ksef.podatki.gov.pl/informacje-ogolne-ksef-20/tryby-szczegolne-wystawiania-faktur/ (zmiana 24.02.2026); tabela trybów, wersja 12: https://ksef.podatki.gov.pl/media/iipln3md/tryby-wystawiania-faktur-tabela-wersja-12.pdf
- Numer KSeF i identyfikator zbiorczy w płatnościach: https://ksef.podatki.gov.pl/informacje-ogolne-ksef-20/numer-ksef-i-zbiorczy-identyfikator/ (zmiana 06.02.2026)
- Przechowywanie faktur w KSeF (10 lat): https://ksef.podatki.gov.pl/ksef-news/zasady-obowiazywania-ksef-i-przepisy-prawne/
- Odroczenie kar do końca 2027 r. (projekt, Rada Ministrów): https://www.podatki.gov.pl/aktualnosci/rada-ministrow-za-odroczeniem-kar-za-bledy-w-ksef-i-przedluzeniem-odwrotnego-obciazenia-vat (22.10.2026)
- Faktury do paragonów od 2027 r. (projekt zmiany rozporządzenia o kasach, źródła branżowe do potwierdzenia w Dzienniku Ustaw): https://ksiegowosc.infor.pl/wiadomosci/7614495,zmiany-w-kasach-fiskalnych-od-1-stycznia-2027-r-bedzie-nowelizacja-najwazniejszego-rozporzadzenia.html ; https://ksiegowosc.infor.pl/ksef/7697833,zmiany-ksef-2027-przelewy-na-nowych-zasadach-koniec-paragonow-z-nipem-i-najmniejsze-firmy-objete-obowiazkiem-efakturowania.html (7.11.2026)
- Faktura do paragonu (art. 106b ust. 5, 3 miesiące): objaśnienia MF „Paragony fiskalne” z 16.10.2020: https://www.gov.pl/attachment/d0dad28f-849a-4336-acc3-7d71fccb32e5

**VAT**
- Ustawa o VAT (ISAP): https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=WDU20040540535
- Rozliczenie miesięczne i kwartalne, metoda kasowa, VAT-UE, VAT-8: https://www.biznes.gov.pl/pl/portal/00232
- VAT w handlu międzynarodowym (import usług, VAT-UE, VAT-9M): https://www.biznes.gov.pl/pl/portal/00272
- JPK_VAT z deklaracją od 1.02.2026 (broszura): https://podatki.gov.pl/media/wgbkrejs/broszura-jpk_vat-z-deklaracj%C4%85-od-1-lutego-2026-r.pdf
- Biała lista: https://www.biznes.gov.pl/pl/portal/00226
- e-Deklaracje (UBD, dane autoryzujące): https://www.podatki.gov.pl/e-deklaracje/informacje-podstawowe (aktualizacja 13.10.2026)
- OSS (objaśnienia MF z 2021): https://www.podatki.gov.pl/media/b0mptv5d/objasnienia-podatkowe-vat-e-commerce.pdf
- Kasy: rozporządzenie o zwolnieniach (Dz.U. 2024 poz. 1902): https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=WDU20240001902 ; https://www.biznes.gov.pl/pl/portal/00243

**PIT**
- Limity 2026: https://podatki.gov.pl/pit/limity (15.12.2025)
- Zaliczki kwartalne (skala): https://www.biznes.gov.pl/pl/portal/00264
- Kasowy PIT: https://www.biznes.gov.pl/pl/portal/005347
- KPiR, środki trwałe, ewidencja wyposażenia: https://www.biznes.gov.pl/pl/portal/00233 ; https://www.biznes.gov.pl/pl/portal/00260
- Księgi w programie i struktury JPK w PIT: https://www.gov.pl/web/finanse/nowe-zasady-dokumentacji-ksiegowej-w-podatku-pit-od-2026-r-wazne-informacje (16.10.2025); JPK_PD: https://podatki.gov.pl/podatki-firmowe/jednolity-plik-kontrolny/jpk_pd/jpk_pd ; broszura JPK_ST(1): https://www.podatki.gov.pl/media/jikpuwwp/broszura_informacyjna_dot_jpk_st-1.pdf
- Limity samochodów od 2026 r.: odpowiedź MF na interpelację nr 11803 z 24.09.2025: https://api.sejm.gov.pl/sejm/term10/interpellations/attachment/ATTDLZHXM/i11803-o1.pdf
- Złe długi w PIT (ustawa o zatorach płatniczych, Dz.U. 2019 poz. 1649): https://isap.sejm.gov.pl/isap.nsf/download.xsp/WDU20190001649/T/D20191649L.pdf
- Art. 22p PIT od 1.01.2027, biała lista bez skutku w PIT dla faktur od tego dnia (ustawa z 18.09.2026 r., Dz.U. 2026 poz. 1371, art. 1 pkt 2 i art. 3; odczyt 11.11.2026): metadane https://api.sejm.gov.pl/eli/acts/DU/2026/1371 , tekst tylko w PDF https://api.sejm.gov.pl/eli/acts/DU/2026/1371/text.pdf

**ZUS**
- DRA co miesiąc: https://www.biznes.gov.pl/pl/portal/00287
- Import KEDU w ePłatniku: https://www.zus.pl/portal/pomoc/epl0017.html
- Mały ZUS Plus: https://www.biznes.gov.pl/pl/portal/00284
- Wakacje składkowe: https://www.biznes.gov.pl/pl/portal/ou710
- Roczne rozliczenie zdrowotnej (DRA za kwiecień, 20 maja): komunikaty ZUS, do potwierdzenia na zus.pl w kroku 5.7

**Rynek**
- `docs/launch/analiza-rynku-2026-10/CO-DODAC-500.md`, `FAKTWAY-1-0.md`,
  `badanie-liderzy-surowe.json` (poza gitem, 28-29.10.2026); Fakturownia
  sprawdzona 8.11.2026 przez sesję zlecającą.

---

## 12. Dziennik

| Data | Krok | PR | Stan | Uwagi |
|---|---|---|---|---|
| 8.11.2026 | plan | #485 | do zatwierdzenia | spis kodu `279e2b4c`, przepisy ze źródeł urzędowych, luki wobec liderów, poziomy ryzyka z mapy żelaznego filtra; czeka na decyzje z sekcji 6 |
| 8.11.2026 | plan: wzorce | #485 | do zatwierdzenia | na prośbę sesji zlecającej: przy 51 krokach z ryzykiem wzorzec do sprawdzenia wyniku i czego brakuje (według notatki „Źródła prawdy”), tabela wzorców według obszaru (8.1) i lista funkcji bez wzorca jako ryzyko wprost (8.2) |
| 8.11.2026 | decyzje z sekcji 6 | #485 | przyjęte | Bartosz: „tak przyjmuje” na pytanie o rekomendacje z sekcji 6; przyjęte wszystkie (P1-P6, D1-D11) |
| 9.11.2026 | 0.1 | #485 | gotowe do scalenia | hasło w `AGENTS.md`; pytania 7-17 w `PYTANIA-DO-PRAWNIKA.md`; arkusz G15-G30 w `ZLOTE-PRZYPADKI-2.md` (puste wyniki do policzenia przez księgową); szkic rejestru przepisów w `REJESTR-PRZEPISOW-KOMPLETNA.md` (44 wpisy, pola rejestru żelaznego filtra) |
| 9.11.2026 | niespójność z 2.6: cennik | #487 | gotowe do scalenia | sesja „cennik”: cennik, pomoc, komunikaty limitu i karta FLO bez obietnicy ręcznego wpisu kosztu; test czerwony przed poprawką; CI zielone |
| 9.11.2026 | 1.4, część 1 | #498 | gotowe do scalenia (D11) | tytuł przelewu z numerem KSeF w PDF faktury, mailu, przypomnieniach 1-3, wezwaniu i na ekranie faktury; przy MPP sam numer KSeF; najwyżej 140 znaków; CI zielone; identyfikator zbiorczy w części 2 |
| 9.11.2026 | 8.5, część 1 | #506 | gotowe do scalenia | zalogowane urządzenia, wylogowanie na odległość, historia logowań; migracja 00174 przed wdrożeniem; mail o nowym urządzeniu w części 2; ustalenia w PR (limit czasu sesji GoTrue do decyzji Bartosza) |
| 9.11.2026 | 1.2, część 1 | #509 | gotowe do scalenia (D11) | faktura do paragonu: formularz, FA(3) z `FP`, PDF, widok; KSeF TEST przyjął (scenariusz 14 w teście tygodniowym); moduł księgowości i JPK odmawiają przy FP do części 2; bez migracji; CI zielone |
| 9.11.2026 | 3.1 | #510 | gotowe do scalenia | wpłaty częściowe z historią i cofaniem (rozszerzona tabela `payments`); migracja 00176 przed wdrożeniem; CI zielone; dalej zdarzenie o wpłacie (8.1) i wyciąg (3.2) |
| 9.11.2026 | 1.3, część 1 | #517 | gotowe do scalenia (D11) | paragon z NIP z datą od 1.01.2027 bez odliczenia VAT (JPK_V7M, „Ten miesiąc”, kafle), z informacją przy koszcie; OCR zapisywał paragon z NIP jako `invoice`, więc rodzaj idzie z odczytu OCR; PIT bez zmian do odpowiedzi księgowej; łączenie FP ze skrzynki z paragonem w części 2 |
| 9.11.2026 | 8.1, część 1 | #519 | czeka na decyzję Bartosza (CI czerwone słusznie) | zdarzenie o wpłacie z `paymentId`; push „Otrzymana płatność” i „Wpłata częściowa”; przypomnienia anulowane tylko przy pełnej zapłacie |
| 9.11.2026 | 8.5, część 2 | #518 | gotowe do scalenia po #506 (stos) | mail o logowaniu z nowego urządzenia (przeglądarka, system, sieć /24 albo /48); jedna sesja to najwyżej jeden mail (klucz dostawcy) |
| 9.11.2026 | 1.3, naprawa: paragon z NIP powyżej 450 zł | #520 | gotowe do scalenia po #517 (stos) | błąd działający dziś: paragon z NIP powyżej 450 zł dawał odliczenie VAT (art. 106e ust. 5 pkt 3); próg w groszach |
| 9.11.2026 | 1.2, naprawa: FP w raportach i po terminie | #521 | gotowe do scalenia po #509 (stos) | KPiR w Raportach, Excel, szacunek i przepływy bez sumy w okresie z FP (komunikat); FP poza przypomnieniami i listą po terminie |
| 9.11.2026 | 8.5, naprawa: zaufany adres IP | #522 | gotowe do scalenia po #506 (stos) | ustawienia konta i eksport portalu biorą IP jak `logAudit`, nie z podrabialnego pierwszego wpisu X-Forwarded-For |
| 9.11.2026 | protokół: `singletonKey` | #523 | gotowe do scalenia | `AGENTS.md`, punkt 5: `singletonKey` w pg-boss (polityka `standard`) nie deduplikuje; 4 miejsca z kluczem mają drugą ochronę, Stripe chroniony |
| 9.11.2026 | 1.3, część 2 | #524 | gotowe do scalenia po #517 (stos) | FP ze skrzynki łączona z paragonem z NIP (pewne dopasowanie samo, reszta jako ostrzeżenie i wybór klienta); migracja 00175 przed wdrożeniem |
| 9.11.2026 | 1.3, naprawa: OCR i paragon z NIP | #525 | gotowe do scalenia po #517 (stos) | OCR zapisuje paragon z NIP jako `simplified_invoice`, a nie `invoice`; kwoty bez zmian, nowa etykieta „Faktura uproszczona” |
| 9.11.2026 | 3.4, część 1 | #531 | gotowe do scalenia po #498 (stos) | termin, rachunek i MPP z FA(3) skrzynki; lista „Do zapłaty” z tytułem przelewu; oznaczenie zapłaty z cofnięciem; biała lista z trzema wynikami (naprawa: błąd API był „poza wykazem”, prefiks PL nie pasował); migracja 00177 przed wdrożeniem; plik przelewów w części 2 |
| 9.11.2026 | 6.4, część 1 | #533 | gotowe do scalenia | archiwum ZIP (XML z KSeF, PDF, UPO, zdjęcia, CSV, spis braków) i paczka na kontrolę z JPK_FA; migracja 00178 przed wdrożeniem; usuwanie wygasłych paczek w części 2; tryb tylko do odczytu po rezygnacji czeka na pytanie 16 |
| 9.11.2026 | 9.3, część 1 | #541 | gotowe do scalenia | licznik sprzedaży dla osób prywatnych i limit kasy fiskalnej 20 000 zł (proporcjonalnie w roku rozpoczęcia), § 5 ust. 1 rozporządzenia o zwolnieniach z kas; sekcja na /analizy/sprzedaz |
| 9.11.2026 | 3.2, część 1 | #549 | gotowe do scalenia po #510 (stos) | import wyciągu (MT940, CAMT.053, CSV PKO); wpłata zapisuje się po potwierdzeniu klienta; RODO: tylko uznania w PLN, „Pomiń” usuwa dane osób trzecich; migracja 00180 przed wdrożeniem |
| 9.11.2026 | 2.10 | #552 | gotowe do scalenia | strona faktury dla nabywcy `/faktura/<token>` bez logowania; token 256 bitów, w bazie skrót, 90 dni; migracja 00179 przed wdrożeniem; przed udostępnieniem test zabezpieczeń |
| 9.11.2026 | 6.2, część 1 | #557 | gotowe do scalenia | koszty i pliki kosztów w portalu księgowej; nowy limit prób w portalu; kwoty w walucie z kodem waluty |
| 10.11.2026 | 7.1, część 1 | #573 | gotowe do scalenia | klucze API firmy, odczyt faktur i kosztów, OpenAPI i /api/docs; zastępuje #554 i #555 (skan sekretów, test RLS, CodeQL); migracja 00181 przed wdrożeniem; API wyłączone flagą `publicApiEnabled` |
| 10.11.2026 | 7.1, część 2 | #583 | gotowe do scalenia po #573 (stos) | `POST /api/v1/invoices` z `Idempotency-Key`, ta sama walidacja i numeracja co formularz; migracja 00184 przed wdrożeniem |
| 10.11.2026 | 3.4, część 2 | #575 | gotowe do scalenia po #531 (stos) | plik przelewów Elixir-0 (ING, mBank), MPP tylko przy rachunku w ING albo mBanku, biała lista z dowodem; rachunek firmy w ustawieniach (migracja 00183 przed wdrożeniem); przed udostępnieniem próbny import w banku |
| 10.11.2026 | 7.3 | #568 | gotowe do scalenia | adres iCal z należnościami, fakturami cyklicznymi i terminami podatków i ZUS (przy włączonym module); migracja 00182 przed wdrożeniem |
| 10.11.2026 | 6.2, część 2 | #582 | gotowe do scalenia | ekran „Moi klienci” dla księgowej z wieloma firmami; migracja 00185 przed wdrożeniem |
| 10.11.2026 | 8.1, część 1 (zmiana) | #519 | gotowe do scalenia po #510 (stos) | wariant „sam push” przyjęty według rekomendacji, do potwierdzenia przy scalaniu: job tylko powiadamia, anulowanie przypomnień w funkcjach bazy 00158 i 00176 |
| 10.11.2026 | 8.5, limit sesji | #564 | gotowe do scalenia po #506 (stos) | wylogowanie po 30 dniach bezczynności przyjęte według rekomendacji, do potwierdzenia przy scalaniu; na produkcji zmienna GoTrue (runbook `docs/runbooks/limit-sesji-gotrue.md`) |
| 11.11.2026 | 1.6, część 1 | #585 | gotowe do scalenia | artykuł pomocy „Zmiany od 1 stycznia 2027”: 5 punktów z linkami do źródeł urzędowych; projekt kasowy opisany jako projekt |
| 11.11.2026 | 3.2, część 2 | #590 | gotowe do scalenia po #549 (stos) | przelewy do ZUS (rachunek składkowy z NRS) i do urzędu (mikrorachunek) z wyciągu jako zapłaty rozliczeń; jedno kliknięcie tylko przy pewnym dopasowaniu, z „Cofnij”; migracja 00189 przed wdrożeniem (numer zmieniony z 00186, który zajmuje #579 planu skalowania) |
| 11.11.2026 | naprawa: symbole w tytule przelewu | #591 | gotowe do scalenia | symbole formularza na mikrorachunek według Dz.U. 2025 poz. 1305: skala PIT, liniowy PPL, VAT JPK-V7M (do potwierdzenia przez księgową), ryczałt PPE bez zmian |
| 11.11.2026 | 7.1, część 3 | #595 | gotowe do scalenia po #583 (stos) | webhooki: faktura przyjęta w KSeF, nowy koszt, wpłata; podpis HMAC, ponowienia do 12 h, wyłączenie po 20 nieudanych; migracja 00187 przed wdrożeniem; zmienna `WEBHOOK_SECRETS_ENCRYPTION_KEY` w aplikacji i workerze |
| 11.11.2026 | 8.1, część 2 | #600 | gotowe do scalenia | dzwonek z powiadomieniami: nowa faktura zakupu ze skrzynki, faktura przyjęta i odrzucona w KSeF, termin podatku; osobny wpis dla każdej osoby w firmie, oznaczanie przeczytanych; migracja 00188 przed wdrożeniem |
| 11.11.2026 | 6.4, część 2 | #602 | gotowe do scalenia po #533 (stos) | raz na dobę usuwa plik paczki archiwum godzinę po wygaśnięciu linku, tylko z katalogu tego zlecenia; wiersz zostaje jako historia ze znacznikiem i audytem; migracja 00190 przed wdrożeniem; po wdrożeniu sprawdzić wersjonowanie bucketu |
| 11.11.2026 | scalanie zbiorcze | #587, #588 | gotowe do scalenia | A (#587): 24 PR bez D11, migracje 00174, 00176, 00178-00182, 00184, 00185, 00187-00190; B (#588): 9 PR etapu 1 według D11, migracje 00175, 00177, 00183; po scaleniu pierwszej poprawić „następny wolny” w rejestrze drugiej; składowe PR zamknąć z odesłaniem |
| 11.11.2026 | rejestr migracji | #579, #590 | ustalenie | 00186 zajmuje wcześniejszy #579 planu skalowania, więc #590 dostał 00189; rejestr w #579 ma „następny wolny 00187”, a 00187-00190 zajmują PR tego planu, więc kolejna migracja skalowania od 00191 |
| 11.11.2026 | 1.4, część 2 | #603 | gotowe do scalenia po #575 (stos, D11) | identyfikator zbiorczy KSeF na liście „Do zapłaty” dla co najmniej 2 faktur jednego dostawcy (art. 108g ustawy o VAT, płatności od 1.01.2027); zapisany identyfikator nie powstaje drugi raz; migracja 00191 przed wdrożeniem; wywołanie KSeF z akcji, nie z joba (do potwierdzenia); próba na KSeF TEST po wdrożeniu |
| 11.11.2026 | 7.2 | #604 | gotowe do scalenia po #595 (stos) | łącze MCP tylko do odczytu (faktury, należności, koszty) na kluczach API, za flagą `publicApiEnabled`; bez migracji |
| 11.11.2026 | 6.1, część 1 | #607 | gotowe do scalenia (format wstrzymany) | eksport EDI++ dla Subiekta i Rewizora według specyfikacji InsERT 1.05; wstrzymany do próbnego importu w programie biura (decyzja Igora z 29.09.2026) |
| 11.11.2026 | 6.2, część 3 | #608 | gotowe do scalenia po #600 (stos) | komentarze i prośby o dokument przy koszcie, z wpisem w dzwonku dla pozostałych członków firmy; migracja 00192 przed wdrożeniem, po 00188 |
| 11.11.2026 | 2.9, część 1 | #609 | gotowe do scalenia | nota obciążeniowa i uznaniowa poza KSeF: numer NO/n/rok i NU/n/rok z bazy, PDF, mail z kluczem idempotencji; wystawionej nie zmienia nikt; migracja 00193 przed wdrożeniem; nota odsetkowa w części 2 |
| 11.11.2026 | 8.4, część 1 | #610 | gotowe do scalenia | audyt dostępności (WCAG 2.1 AA): 19 ustaleń i 10 testów do napisania; poprawki po scaleniu gałęzi zbiorczych; ramki pól wymagają decyzji o wyglądzie |
| 11.11.2026 | 9.4 | #611 | gotowe do scalenia po #541 (stos) | licznik progu OSS: sprzedaż dla konsumentów z innych krajów UE netto, próg 42 000 zł z ustawy (art. 22a ust. 1 pkt 3), rok bieżący i poprzedni, ostrzeżenie od 80 %; bez migracji |
| 11.11.2026 | build | #612 | do decyzji Bartosza | pułap sterty buildu 5120 MB (`Dockerfile`, CI, test); gałąź zbiorcza z 30 PR przekraczała 4096 MB; przed wdrożeniem swap na app-1 co najmniej 10 GB albo budowa przez GitHub Actions |
| 11.11.2026 | 3.7 | #613 | gotowe do scalenia po #510 (stos) | dowody KP i KW z numerem z bazy i raport kasowy; wystawionego nie zmienia nikt, korekta przez storno; migracja 00194 przed wdrożeniem |
| 11.11.2026 | scalanie zbiorcze A+B | #614 | gotowe do scalenia (możliwość) | #587 i #588 jednym ruchem, konflikty między nimi rozwiązane; zawiera #612 |
| 11.11.2026 | 6.2, część 4 | #615 | gotowe do scalenia | uprawnienie biura rachunkowego w KSeF po NIP z FaktWay, za flagą `ksefPermissionsEnabled`; migracja 00195 przed wdrożeniem; próba na KSeF TEST po wdrożeniu |
| 11.11.2026 | 3.2, część 3 | #616 | gotowe do scalenia po #614 (stos) | przelewy do dostawców z wyciągu jako zapłaty kosztów z listy „Do zapłaty”; propozycje tylko w przeglądarce (RODO); migracja 00196 przed wdrożeniem; przy scalaniu A i B osobno przestawić bazę na main |
| 11.11.2026 | 8.1, część 3 | #617 | scalone do A (#587) | wpis w dzwonku przy wpłacie do faktury („Otrzymana płatność”, „Wpłata częściowa”); migracja 00197 przed wdrożeniem |
| 11.11.2026 | 2.5 | #642 | gotowe do scalenia | serie numeracji faktur: własny wzór ({RRRR}, {MM}, {M}, {N}), seria domyślna każdego rodzaju, podpowiedź numeru dla zwykłej, zaliczkowej, końcowej i korekty; numer z licznika nadaje baza pod blokadą serii (dwa wystawienia naraz: dwa kolejne numery), numer zajęty w KSeF nie wraca z licznika; firma bez serii numeruje jak dotąd; migracja 00199 przed wdrożeniem; decyzje według rekomendacji do potwierdzenia przy scalaniu (opis PR); test RLS z wyścigiem w CI |
| 11.11.2026 | 8.4, część 2 | #618 | scalone w #620 (6a65c1ce) | etykiety korekty, `main` i `h1` w logowaniu, semantyka panelu pomocy |
| 11.11.2026 | 2.8, wydruk zbiorczy | #619 | scalone w #629 (39b8e713) | audyt pobrania paczki PDF faktur |
| 11.11.2026 | 2.4 | #621 | scalone w #639 (f1ec9aba); 00198 wgrana na db-1 11.11 (#644) | proforma i oferta: numeracja PRO i OF, PDF, mail, zamiana w fakturę |
| 11.11.2026 | 8.4, część 2b | #632 | scalone w #639 (f1ec9aba) | A-13, A-14, A-15, A-16, A-19 |
| 11.11.2026 | 2.5 | #642 | zamknięty, zastąpiony przez #643 | trzy czerwone kontrole (identyfikator pola serii, CodeQL, gitleaks); #643 to jeden commit od main |
| 12.11.2026 | 2.5 | #643 | gotowe do scalenia po etykiecie `zgoda:wiedza-prawna` (nadaje Bartosz) | serie numeracji z licznikiem pod blokadą serii, migracja 00199 **przed** wdrożeniem; mapa ryzyka i karta filtra uzupełnione po #504; drugi czytelnik bez blokad, uwagi: pierwszy numer serii tylko w bieżącym okresie, luka po usunięciu szkicu, który nie jest ostatni (pytanie do księgowej) |
| 12.11.2026 | 3.4, zmiana prawa | #651 | gotowe do scalenia (CI 19 z 19) | art. 22p PIT od 1.01.2027 (Dz.U. 2026 poz. 1371): zdanie o koszcie w PIT przy rachunku spoza wykazu tylko dla faktur wystawionych przed 2027 r. (P_1, a bez niego data kosztu); VAT i ZAW-NR bez zmian; pytanie 18 do prawnika; przed scaleniem porównać cytaty z PDF ustawy; bez migracji |
| 13.11.2026 | 2.5 | #643 | scalone w #713 (6d0ffd4f) i wdrożone 13.11; 00199 wgrana na db-1 13.11 | po #504 dopisane do mapy ryzyka i karta filtra z przeglądem drugiego czytelnika; etykieta `zgoda:wiedza-prawna` na zbiorczym #713 |
| 13.11.2026 | 3.4, zmiana prawa | #651 | scalone i wdrożone 13.11 (koordynator) | cytaty z art. 1 pkt 2, art. 3 i art. 6 Dz.U. 2026 poz. 1371 potwierdzone w oficjalnym PDF (RP-BL-01) |
| 13.11.2026 | 8.4, część 3 | #712 | gotowe do scalenia (CI 19 z 19) | A-01, A-05, A-06: błędy pól powiązane z polami, stały blok błędów z odnośnikami i fokusem, wynik NIP ogłaszany; wygląd bez zmian poza nowym blokiem (wzorzec znaczników 10 z 10 jak w main); po #713 pole serii w bloku błędów; dalej: A-01 dla zaliczki i końcowej, `closeButton` toastu do decyzji (D1) |
| 13.11.2026 | 2.6, część 1 | #714 | gotowe do scalenia (CI 19 z 19) | ekran katalogu `/produkty` na tabeli `products` (lista, szukanie, dodaj, edytuj, archiwizuj, usuń nieużyty), kody GTU ze schematu FA(3), audyt, menu obok proform; bez migracji; dalej: podpowiedź w formularzu, GTU i PKWiU w pozycjach, cena brutto, ceny dla kontrahenta |
| 13.11.2026 | 1.2, część 2 | #715 | gotowe do scalenia po etykiecie `zgoda:wiedza-prawna` | faktura do paragonu w JPK_V7M (typ dokumentu FP, pełne kwoty, poza podatkiem należnym i deklaracją; paragon z miesiąca pliku: odmowa), w ewidencji i KPiR poza przychodem przy pokryciu raportem kasy; RP-FP-01 i RP-FP-02 w `filtr/przepisy/ksiegowosc.json`; pytania G30 nr 3 i 4 do księgowej |

| 14.11.2026 | 1.2, 2.6 część 1, 8.4 część 3 | #725 | scalone (c8222ef5, koordynator) | zbiorczy z #712, #714, #715 i #724 w najnowszych wersjach; #653 zamknięty jako zastąpiony przez #724 |
| 14.11.2026 | 8.4, część 3b | #741 | scalone w #755 (d7885e91) | A-01 w formularzach zaliczki i rozliczającej: komunikaty z `id` i `role="alert"`, pola z `aria-invalid` i `aria-describedby`, w pozycjach per pole; jedyna zmiana wyglądu to czerwona ramka pól z błędem, jak w głównym formularzu po #712; R3 |
| 14.11.2026 | 2.2, część 1 | #742 | scalone w #755 (d7885e91); 00203 przed wdrożeniem (Bartosz) | logo firmy na PDF faktur, proform i ofert (PNG i JPEG do 2 MB, metadane usuwane, plik w `tenants/<id>/logo/`), sekcja w Ustawieniach → Firma, CHECK i wyzwalacz w 00203 (00201 ma #716, 00202 #738); bez logo PDF bajt w bajt jak dotąd; dalej: logo na notach i wezwaniu do zapłaty |
| 14.11.2026 | 2.6, część 2a | #743 | scalone w #755 (d7885e91) | podpowiedź produktów z katalogu w polu nazwy pozycji (combobox w kartach i w siatce): wstawia nazwę, jednostkę, cenę netto i stawkę; u firmy zwolnionej z VAT stawka z podatkiem nie zastępuje „zw”; R1 bez migracji i bez etykiety; dalej: licznik użyć produktu przy zapisie faktury, podpowiedź w zaliczce, korekcie i proformie |
| 14.11.2026 | ustalenie przy 2.6, część 2b | #747 | scalone w #755 (d7885e91) | FA(3): klasyfikacja pozycji (GTIN, PKWiU, CN) po `P_7` w trzech generatorach, zgodnie z XSD (dotąd plik z kodem w pozycji nie przechodził walidacji); osobne ustalenie do części 2b: typ kodu zgadywany po długości i filtr gubiący PKWiU z kropkami w rozliczającej i korekcie |
| 14.11.2026 | przegląd #714 | n/d | bez zmiany | uwaga o cenie „zawsze zmienionej” w edycji produktu nieprawdziwa: PostgREST zwraca NUMERIC jako liczbę (`lib/ksef/duplicate-decision-types.ts:87`), pokazuje to test `tests/unit/produkty-akcje.test.ts:89-93` |
| 13.11.2026 | 8.5, naprawa: bomba czasowa w teście | #727 | scalony 14.11 w zbiorczym „Scalenie #733 … #721, #736” (przed 8.12.2026 15:40 UTC) | `sesje-urzadzenia.test.ts`: jawny zegar `NOW` w bloku listy urządzeń i przypadek dla domyślnego zegara; bez zmian w kodzie aplikacji; ustalenie z zamiatania przy #720 |
| 14.11.2026 | 2.6, część 2 (licznik użyć) | #753 | scalone w #755 (d7885e91); 00204 przed wdrożeniem (Bartosz) | licznik użyć i data ostatniego użycia produktu przy zapisie faktury (RPC `product_usage_record`, 00204), także szybka faktura z telefonu (przeniesione do `lib/invoices/issue-regular.ts` przy składaniu #755); decyzja Bartosza z 14.11: licznik startuje od zera, bez przeliczania starych faktur i bez zmian danych na produkcji |
| 14.11.2026 | dziennik | #748 | scalone w #755 (d7885e91) | wiersze 14.11 i „Następny krok” przed rundą 3 |
| 14.11.2026 | ustalenie FZ-008 (żelazny filtr) | #760 | gotowe do scalenia przez kolejkę (kontrole odświeżone 15.11) | faktura VAT za abonament od brutto przechodzi walidację wysyłki: kwoty w groszach całkowitych, VAT pozycji od netto albo od brutto (art. 106e ust. 1 pkt 14, ust. 7, 9 i 11), brutto pozycji = netto + VAT; dotąd ok. 10 % kwot po kodzie rabatowym (np. 20,99 zł) kończyło się odmową walidacji. Sprawdzenie produkcji (Bartosz, 14.11): `stripe_payments` pusta, żadna faktura za abonament nie padła, więc wyjście operatora dla padniętych faktur niepotrzebne. Osobne ustalenia: korekta faktury liczonej od brutto liczy od netto (R1, osobny PR), eksport Comarch Optima liczy VAT od netto (format wstrzymany), FP bez metody od brutto (2.6, cena brutto), kształt FA(3) faktury za abonament (P_9A i P_11 przy VAT od brutto; pytanie do księgowej) |
| 14.11.2026 | 2.6, część 2b-1 | #768 | gotowe do scalenia przez kolejkę po etykietach `zgoda:wiedza-prawna` i `zgoda:zmiana-filtra` (Bartosz) | PKWiU w pozycji zwykłej faktury z jawnym typem kodu: pole „Dodaj PKWiU”, PKWiU z katalogu, plik FA(3) (`PKWiU` po `P_7`, bez zgadywania po długości), wypełnianie z innej faktury; bez migracji (kod w `fa3_data`). GTU w całości do 2b-2, bo JPK_V7M dziś GTU nie wykazuje. Do 2b-3: rozliczająca i korekta (typ kodu, PKWiU z kropkami, stan „przed” z kodem), PKWiU w szczegółach faktury i na PDF |
| 15.11.2026 | ustalenie FZ-008; 2.6, część 2b-1 | #760, #768 | scalone 15.11 (cac28970, 450ec64f), wdrożone 16.11 (koordynator) | bez migracji |
| 15.11.2026 | 2.6, część 2b-2 | #788 | scalone 15.11 (2fb104c4), wdrożone 16.11 (koordynator) | GTU w pozycji zwykłej faktury: przycisk „Dodaj GTU” (GTU_01 do GTU_13), GTU z katalogu, `GTU` po `P_12` w FA(3), `GTU_xx` w wierszu sprzedaży JPK_V7M (także FP i faktura z importu z poprawnym GTU, która dotąd wstrzymywała plik); nowy RP-JPK-GTU-01 i zmieniona interpretacja RP-FP-02 w `filtr/przepisy/ksiegowosc.json`; korekta faktury z GTU w JPK_V7M odmawia z numerami i kodami do części 2b-3b; bez migracji |
| 16.11.2026 | naprawa: niestabilny test LIM-05 | #812 | scalone 16.11 (8bf49723) | `tests/unit/anthropic-limit-czasu.test.ts` z atrapą przygotowania obrazu (`@/lib/ocr/image-for-api`): zimny import sharp w prawdziwym czasie rozjeżdżał udawany zegar, a hook przed pushem padał przy każdej zmianie w kodzie, który importuje OCR; bez zmian w kodzie aplikacji |
| 17.11.2026 | 2.8, szablon maila | #811 | scalone 17.11 (4258db79); 00208 przed wdrożeniem | własny temat i treść maila z fakturą z polami (numer, sprzedawca, kwota, termin, tytuł przelewu), podgląd i powrót do domyślnego; bez tabeli idzie mail domyślny |
| 17.11.2026 | 2.8, autozapis | #814 | scalone 17.11 (e9879afe); 00207 przed wdrożeniem | formularz zwykłej faktury sam zapisuje kopię roboczą i przy następnym otwarciu proponuje jej przywrócenie; kopie starsze niż 30 dni usuwa nocne zadanie; bez tabeli „Autozapis niedostępny” |
| 17.11.2026 | 2.8, ustawienia domyślne | #818 | scalone 17.11 (71734383); 00209 przed wdrożeniem | domyślna forma i termin płatności nowej faktury, adres księgowej, do której idzie kopia maila z fakturą |
| 17.11.2026 | 8.4, A-01 w pozostałych formularzach | #824, #826 | scalone 17.11 (22c8eb48, 770165f5) | komunikaty błędów powiązane z polami w proformie i ofercie, notach, MPP i dacie zapłaty kosztu (#824, R3) oraz w arkuszu faktury cyklicznej (#826, R1 przez obszar `faktury.cykliczne`); A-01 zamknięte, `closeButton` toastu dalej czeka na D1 |
| 17.11.2026 | 1.6, część 2a | #825 | scalone 17.11 (e7bd0892) | baner na pulpicie i wpis w pomocy o zmianach od 1.01.2027 (KSeF dla wszystkich, faktura do paragonu, numer KSeF w tytule przelewu), R2; zamknięcie banera zapamiętane w przeglądarce (wiersz w polityce cookies); zostają: mail do klientów i zamknięcie na wszystkich urządzeniach (decyzja Bartosza), część 2b (faktury spoza KSeF w historii) |
| 17.11.2026 | 8.1, faktury za abonament | #829 | scalone 17.11 (df70147a) | lista faktur za abonament FaktWay na stronie Abonament: płatność, numer faktury, stan w KSeF; R1 bez migracji; pobieranie PDF tej faktury przez klienta czeka na decyzję Bartosza |
| 16.11.2026 | 2.6, część 2b-3a | #813 | czeka na etykietę `zgoda:wiedza-prawna` (Bartosz) | PKWiU z jawnym typem w fakturze rozliczającej i korekcie: dotąd typ kodu zgadywany po długości, a PKWiU z kropkami (np. 62.01.11.0) odpadał z pliku; R1 bez migracji |
| 17.11.2026 | 2.6, część 2b-3b | #820 (stos na #813) | czeka na etykietę `zgoda:wiedza-prawna` (Bartosz) | PKWiU i GTU w wierszach korekty „przed” i „po” (kody z `fa3_data.lines` faktury korygowanej); JPK_V7M wykazuje GTU korekty dla pozycji, których dotyczy (MF, pytanie 8), a odmawia tylko tam, gdzie FaktWay kodów nie zna; R1 bez migracji |
| 17.11.2026 | ustalenie z #760: korekta faktury liczonej od brutto | #828 (stos na #820) | czeka na etykietę `zgoda:wiedza-prawna` (Bartosz) | stan „przed” co do grosza (np. 20,99 zł: VAT 3,92, nie 3,93) i VAT od brutto w korekcie kwotowej faktury liczonej od brutto (art. 106e ust. 7, 9, 10 i 11, art. 106j ust. 2 pkt 5); korekta pozycji („przed/po”) takiej faktury odmawia z drogą wyjścia; R1 bez migracji |
| 17.11.2026 | osobne ustalenia | n/d | do zrobienia | (1) ostrzeżenie importu (`lib/import/imported-invoice-row.ts:246`) i podpowiedź operatora (`lib/admin/ksef-operator-policy.ts:239`) nadal mówią, że GTU wstrzymuje JPK_V7M, a reguła 15 bramy oryginału (`lib/ksef/duplicate-original-gate.ts:138`) kieruje pliki FaktWay z GTU do przeglądu operatora, choć po #788 generator pisze GTU, a JPK_V7M je wykazuje; (2) aplikacja mobilna proponuje korektę „przed/po” faktury liczonej od brutto, którą serwer po #828 odrzuci (plan aplikacji mobilnej); (3) wzorzec WIEDZA `lib/**/schemas/**` mapy ryzyka obejmuje schemat formularza faktury (`lib/schemas/invoice-form.ts`), więc każda zmiana formularza wymaga `zgoda:wiedza-prawna` (plan żelaznego filtra); (4) zaliczka i faktura rozliczająca bez pola GTU (pytanie do księgowej w RP-JPK-GTU-01); (5) stan „przed” po korekcie kwotowej w łańcuchu korekt: w toku u nocnego zespołu (#822, KOR-02); (6) eksport Comarch Optima liczy VAT od netto (format wstrzymany) |
| 17.11.2026 | czeka na ludzi | n/d | zapisane | 2.8 jeden PDF z wielu faktur (Bartosz: nowa zależność `pdf-lib`); 6.4 tryb tylko do odczytu po rezygnacji (prawnik, pytanie 16, i cztery decyzje Bartosza); mail do klientów o zmianach z 2027 r. i zamknięcie banera na wszystkich urządzeniach (Bartosz); strażnik tekstów pomocy, który dziś nie pozwala pisać o FP i proformie (Bartosz); PDF faktury za abonament dla klienta (Bartosz); kształt FA(3) faktury za abonament (`P_9A` i `P_11` przy VAT od brutto) oraz GTU w zaliczce i rozliczającej (księgowa); reszta jak w sekcji 7 |
| 17.11.2026 | dziennik | #831 | scalone 17.11 (cdec2dbd) | wiersze 15-17.11 |
| 17.11.2026 | 8.1, część 2 | #832 | scalone 17.11 (a2f28def) | pasek odczytu zdjęcia po udostępnieniu z telefonu (`?paragon=`): czytamy, gotowe z linkiem do kosztu, porażka z prawdziwą drogą wyjścia, trwa dłużej; pytania wspólną pętlą `startPollLoop`; R3 |
| 17.11.2026 | 2.6, część 2b-3c | #833 | scalone 17.11 (74309835); 00210 przed wdrożeniem | PKWiU i GTU pozycji w szczegółach faktury, na PDF i na stronie dla nabywcy (druga linia pod nazwą tylko przy kodach, D1), `PDF_RENDERER_VERSION` 8 |
| 17.11.2026 | 2.6, część 2b-3a | #813 | scalone 17.11 (9c605b13) | |
| 17.11.2026 | teksty GTU i FP w imporcie i u operatora | #836 | scalone 17.11 (401cdc66) | ostrzeżenie importu i podpowiedź operatora mówią tylko, który JPK nie powstanie; osobne ustalenie z 2b-2 zamknięte (reguła 15 bramy oryginału bez zmian) |
| 22.11.2026 | 2.6, część 2b-3b | #820 | scalone 22.11 (195d0ce8) | |
| 22.11.2026 | 2.2, logo na notach | #838 | scalone 22.11 (bac4e8fb) | logo firmy na PDF noty obciążeniowej i uznaniowej; bez logo wydruk bajt w bajt jak dotąd; PDF wezwania i UPO bez zmian (sesja filtra) |
| 22.11.2026 | 2.8, numer zamówienia | #840 | scalone 22.11 (8a2593b3) | numer i data zamówienia na zwykłej fakturze: formularz, FA(3) `WarunkiTransakcji/Zamowienia`, PDF (`PDF_RENDERER_VERSION` 9), szczegóły; data w granicach `TDataU` czytanych z XSD |
| 22.11.2026 | 3.8, część 1 | #834 | w toku: poprawka CI | koszt wpisany ręcznie (formularz, akcja, kategoria jako opis w KPiR, odmowa faktury już obecnej w Kosztach); CI: od 00127 klient sesji nie wstawia kosztów (`REVOKE INSERT … FROM authenticated`), więc zapis idzie funkcją w bazie (migracja), a strażnik tekstów o wpisie ręcznym zmieniony świadomie |
| 22.11.2026 | korekta od brutto | #828 | czeka na etykietę po ostatnim pushu (4572bcec) | dwa commity tylko w testach: wyrocznia bez −0 i stały przypadek 0,01 zł (59f49e25), jawny limit czasu testu „przegląd do 2000 zł” (4572bcec) |
| 22.11.2026 | naprawa: ilość × cena i VAT od netto do grosza | #842 (stos na #828) | czeka na `zgoda:wiedza-prawna` i numery FZ | iloczyn i VAT od netto na liczbach zmiennoprzecinkowych zaokrąglały połówkę grosza w dół (2,5 × 3,33 = 8,32 zamiast 8,33; 23 % od 35,50 = 8,16 zamiast 8,17; art. 106e ust. 11), także na produkcji; teraz grosze całkowite (BigInt), a korekta bierze stan przed z zapisu (`invoice_line_items`), więc stare faktury przechodzą korektę bez zmiany kwot |
| 22.11.2026 | ceny brutto (a), (c) | #835, #837 (stos na #842) | czekają na `zgoda:wiedza-prawna`; 00211 (#837) przed wdrożeniem | (a) liczenie i plik FA(3): `P_9B`, `P_11A`, VAT od sumy brutto stawki, RP-FA-BRUTTO-01 (pewność niska, pytanie do księgowej); (c) cena brutto na PDF, w szczegółach, na stronie nabywcy i w JPK_FA; formularz (b) po strażnikach FA(3) i bramy oryginału |
| 22.11.2026 | import: sama stawka „oo” | #874 | gotowe do scalenia | ostrzeżenie, że JPK_V7M nie powstanie (JPK_FA powstaje), ostrzeżenia importu bez długich myślników |
| 22.11.2026 | osobne ustalenia | n/d | do zrobienia | (1) VAT od netto na liczbach zmiennoprzecinkowych jeszcze w pięciu miejscach (`jpk-fa-generator.ts:471, 600`, `comarch-optima-generator.ts:176`, import `fa3-line-amounts.ts:107`, `correction-amount-change.ts:38` i `issue-correction.ts:901`; w korekcie kwotowej ok. 1,3 % połówek grosza daje odmowę z wyjściem), osobny PR po #842; (2) korekty „przed/po” zapisane przed #842 bez `recordedAmounts`: JPK i ponowne budowanie pliku mogą odjechać o grosz (zapytanie w „Po wdrożeniu” #842); (3) `lineVatMatchesRate` przyjmuje VAT od brutto przy fakturze w cenach netto i maskuje błąd metody (po odpowiedzi księgowej o abonament); (4) podgląd faktury w telefonie liczy po staremu (`mobile/src/lib/faktura/wystawienie.ts:163-184`) i nie pokazuje ceny brutto, tak samo API v1 i MCP (plan aplikacji mobilnej, API); (5) kursy walut liczone tym samym iloczynem (`lib/ocr/currency.ts:74-75`, `lib/oss/prog.ts:98`); (6) etykiety procedury marży z długim myślnikiem (`lib/xml/fa3-annotations.ts:177-179`) i tryb rozkazujący w odmowie JPK_V7M (`jpk-v7m-generator.ts:88`); (7) podwójny koszt (koszt ze zdjęcia albo ręczny i ta sama faktura ze Skrzynki KSeF) to FZ-022 sesji filtra |
| 22.11.2026 | czeka na ludzi | n/d | zapisane | 1.6 część 2b, faktury spoza KSeF w historii (plan bez kodu: księgowa: BFK w JPK_V7M, KPiR, zakres dat; prawnik: tekst i retencja PDF; Bartosz: odczyt PDF i zapis jako przyjęta bez numeru KSeF z migracją); 2.9 część 2, potwierdzenie salda (plan bez kodu: Bartosz wariant z numerem i migracją albo wydruk na żądanie; księgowa: należności czy także zobowiązania, korekty; prawnik: uznanie długu i przedawnienie), nota odsetkowa (rejestr stawek, przykłady księgowej) i kompensata; RP-FA-BRUTTO-01 (księgowa: same `P_9B`/`P_11A` czy także `P_9A`/`P_11`, VAT od sumy stawki czy przy pozycjach, `WartoscWierszyFaktur` w JPK_FA) |
| 22.11.2026 | korekta od brutto | #828 | scalone 22.11 (b8f17b03) | |
| 22.11.2026 | import: sama stawka „oo”; dziennik | #874, #875 | scalone 22.11 (f4d62230, 44bc7304) | #875: wiersze 17-22.11 |
| 22.11.2026 | 3.8, część 1 | #834 | scalone 22.11 (7d19ddc5); 00212 przed wdrożeniem | koszt wpisany ręcznie zapisuje funkcja w bazie `expense_create_manual` (SECURITY DEFINER), bo od 00127 klient sesji nie wstawia kosztów; dalsze kroki: komunikat z wyjściem zamiast jednego „Nie udało się zapisać kosztu” przy odmowie funkcji (`lib/expenses/manual-expense.ts:223`, np. 42501), `NOTIFY pgrst` na końcu 00212 jak w sąsiednich migracjach (skrypt wgrywania robi go sam); osobne ustalenie: funkcję można wywołać wprost przez PostgREST, z pominięciem sprawdzeń akcji (suma kontrolna NIP, powtórzona faktura, zwolnienie z VAT) |
| 22.11.2026 | naprawa: ilość × cena i VAT od netto do grosza | #842 | scalone 22.11 (328ce22e) | FZ-023 (rejestr `docs/filtr/USTALENIA.md`); po wdrożeniu zapytanie z opisu PR do FZ-026 (korekty „przed/po” zapisane przed #842 bez `recordedAmounts`) |
| 22.11.2026 | ceny brutto (a), (c) | #835, #837 | scalone 22.11 (8a287276, 0340cddc); 00211 przed wdrożeniem | |
| 22.11.2026 | ceny brutto: strażnicy | #880 | scalone 22.11 (a6261c0e) | strażnik FA(3) (`lib/bezpieczniki/fa3.ts`) i brama oryginału znają `P_11A` (VAT od sumy brutto stawki); stawka bez podatku w cenach brutto dostaje odmowę z wyjściem „Wystaw fakturę w cenach netto”; `ORIGINAL_GATE_RULES` 2. Znane granice (generator takich plików nie pisze): stawka z pozycjami w cenach netto i brutto naraz bez porównania 02 (`fa3.ts:210-218`), pozycja bez `P_11` i `P_11A` wyłącza kontrole 02 i 03 całej faktury (`fa3.ts:188-192`), brama nie porównuje `P_9B` × `P_8B` z `P_11A` |
| 22.11.2026 | ceny brutto: wyłącznik | #884 | scalone 22.11 (6e97de8b) | `grossPricesEnabled` w `global_feature_flags`, bez migracji: brak wiersza albo błąd odczytu znaczy wyłączony; pilnowany w zapisie faktury, w kolejce KSeF i przed wysyłką; stan: `./scripts/ops/ceny-brutto.sh stan`, runbook `docs/runbooks/ceny-brutto-wylacznik.md`. Przed pierwszym włączeniem: (1) odmowa „Wyślij ponownie” faktury w cenach brutto każe wystawić ją od nowa, a plik faktury `failed` mógł już dotrzeć do KSeF (`lib/invoices/ceny-brutto-wylacznik-wspolne.ts:38, 44`): poprawić tekst albo runbook (operator najpierw uzgadnia `failed` i `sending`); (2) test na pełnym runnerze `runSubmitInvoice`, że wcześniejsza wysyłka przy wyłączonej fladze jest uzgadniana, a nie odrzucana; (3) wiersz runbooka w tabeli runbooków `AGENTS.md` |
| 22.11.2026 | VAT od netto do grosza w pozostałych miejscach | #881 | `zgoda:wiedza-prawna` od Bartosza, czeka na kolejkę | FZ-025: korekta kwotowa (VAT od netto w groszach całkowitych), JPK_FA, eksport Comarch Optima (zapisany VAT pozycji ma pierwszeństwo, więc stara faktura z VAT 4,01 zostaje przy 4,01), import FA(3). Dalsze kroki: odmowa korekty kwotowej („Podaj VAT od netto”, `lib/invoices/issue-correction.ts:901-906`) bez kwoty i w trybie rozkazującym; test odmowy sprawdza tylko `success === false` (`tests/unit/vat-od-netto-reszta.test.ts:128`); nieaktualny opis funkcji w `lib/import/fa3-line-amounts.ts:99`; poza fakturami te same iloczyny w FLO (`lib/flo/functions/tax-setaside.ts:131-148`, `vat-limit.ts:135`, R2) |
| 22.11.2026 | ceny brutto (b): formularz | #885 | `zgoda:wiedza-prawna` od Bartosza, czeka na kolejkę | wybór „Ceny netto” albo „Ceny brutto” w zwykłej fakturze i FP, podgląd pozycji i sum jak serwer (VAT od sumy brutto stawki), podkład („Duplikuj”, „Wypełnij”, autozapis, import z `P_9B`) bez ceny 0 zł; za wyłącznikiem #884 (B4.0, zasada 2), więc do włączenia klient nie widzi wyboru |
| 22.11.2026 | osobne ustalenia (cd.) | n/d | do zrobienia | (8) telefon: wzór, korekta i edycja faktury w cenach brutto wpisują cenę netto 0,00 (`mobile/src/lib/dane/mapowanie.ts:206-208`, `mobile/src/app/(zakladki)/faktury/nowa/[rodzaj].tsx:136`), a faktura na 0 zł jest legalna; poprawka przed włączeniem cen brutto (plan aplikacji mobilnej); (9) API v1 i MCP oddają przy fakturze w cenach brutto `unit_price_net: null` bez ceny brutto (`lib/api/v1/invoices.ts:160`, `lib/api/mcp/tools.ts:154-158, 188`); (10) korekta faktury w cenach brutto odmawia komunikatem bez słowa o cenach brutto (`lib/invoices/issue-correction.ts:332-336`), do kroku (e); (11) pusta cena w podkładzie daje w formularzu angielski komunikat Zoda (`lib/schemas/invoice-form.ts`, `unitPriceNet: z.number()` bez własnego komunikatu dla braku wartości; obszar wiedzy prawnej); (12) dwa osobne odczyty wyłącznika (strona formularza i podkład): przy przestawieniu flagi między nimi podkład w cenach brutto trafiłby do formularza w cenach netto z ceną 0,00 (okno milisekund; zamyka je jeden odczyt przekazany do podkładu); (13) firma zwolniona z VAT widzi wybór „Ceny brutto”, który zawsze kończy się odmową przy stawce (kosmetyka) |
| 22.11.2026 | czeka na ludzi (cd.) | n/d | zapisane | włączenie cen brutto: Bartosz, po odpowiedzi księgowej na RP-FA-BRUTTO-01, po poprawce telefonu (ustalenie 8) i punktach „przed pierwszym włączeniem” z #884, po próbie na KSeF TEST (runbook `ceny-brutto-wylacznik`) |
| 23.11.2026 | dziennik | #886 | scalone 23.11 (481fa2f0) | wiersze 22.11 |
| 23.11.2026 | VAT od netto do grosza w pozostałych miejscach; ceny brutto (b) | #881, #885 | scalone 22.11 (ccea51ae, aa2839b6) | |
| 23.11.2026 | ceny brutto (d): katalog | #887 | scalone 23.11 (54a53c7f); 00213 przed wdrożeniem | cena brutto produktu (`products.default_price_gross`) obok ceny netto, żadna nie jest wyliczana z drugiej; pole w oknie produktu, kolumna w katalogu i cena brutto z podpowiedzi w fakturze w cenach brutto tylko przy włączonym wyłączniku (#884), zapis nowej ceny brutto przy wyłączonym albo nieczytelnym dostaje odmowę z wyjściem; produkt bez ceny brutto nie wstawia do pozycji niczego (brak, nie 0) i cofa cenę brutto wstawioną wcześniej z katalogu |
| 23.11.2026 | ceny brutto (e), część 1 | #888 | w kolejce scalania | korekta faktury w cenach brutto (FaktWay i import z `P_9B`) odmawia z przyczyną („jest w cenach brutto”) i wyjściem (pomoc FaktWay) zamiast „ma pozycję bez pełnej ilości lub ceny”; dotyczy każdego rodzaju korekty, bo stan przed liczy się z pozycji. Część 2 (plik KOR z `P_9B` i `P_11A`) po odpowiedzi księgowej na RP-FA-BRUTTO-01 |
| 23.11.2026 | pasek odczytu zdjęcia: koszt wpisany ręcznie | #889 | w kolejce scalania | przy nieudanym odczycie i nieprzyjętym zdjęciu link „wpisz koszt ręcznie” do `/expenses/new` (#834) obok Kosztów; R3 |
| 23.11.2026 | korekta kwotowa: kwoty w odmowie | #890 | gotowe do scalenia | dalszy krok #881: odmowa VAT od netto podaje wpisaną zmianę VAT, zmianę VAT od netto do grosza i zmianę brutto oraz pola, w które je wpisać; test sprawdza treść |
| 23.11.2026 | osobne ustalenia (cd.) | n/d | do zrobienia | (14) zmiana stawki produktu na bez podatku przy ukrytym polu ceny brutto (wyłącznik wyłączony) zostawia zapisaną cenę brutto; faktura w cenach brutto taką pozycję odrzuci z wyjściem (#887); (15) import z `P_9B` nie zapisuje ceny brutto w katalogu (`lib/import/import-engine.ts`, wierny import C5b; #887); (16) edycja produktu przy błędzie odczytu pokazuje „Nie znaleziono produktu” zamiast komunikatu o błędzie odczytu (`app/actions/produkty.ts`, #887); (17) przycisk „Korekta” przy fakturze w cenach brutto na liście, w szczegółach i w telefonie, choć korekta odmawia (#888); (18) „Napisz do nas, a przygotujemy korektę z Tobą” (`CORRECTION_HELP_STEP`) nie ma runbooka dla operatora (#888) |
| 23.11.2026 | dziennik | #891 | scalone 23.11 (075b5dca) | wiersze 23.11 (#886-#890) |
| 23.11.2026 | ceny brutto (e), część 1; pasek odczytu; kwoty w odmowie korekty kwotowej | #888, #889, #890 | scalone 22-23.11 (2aec2b40, 8f15a937, d3c38793) | |
| 23.11.2026 | wyłącznik cen brutto: „Wyślij ponownie” bez drugiej faktury w KSeF | #892 | scalone 23.11 (497e7b15) | punkt 1 „przed pierwszym włączeniem” z #884: odmowa ponowienia faktury w cenach brutto przy wyłączonym prosi, żeby nie wystawiać jej od nowa, i kieruje do pomocy (plik z wcześniejszej próby mógł już być w KSeF, a odmowa w kolejce pada przed uzgodnieniem z joba); runbook `ceny-brutto-wylacznik.md`, „Jak wyłączyć”: `sending` czeka do końca wysyłki, `failed` uzgadnia operator „Tylko uzgodnij” w `/admin/ksef` |
| 23.11.2026 | naprawa FZ-029: ROZ, reszta stawki ujemna o grosz | #898 | scalone 23.11 (fe0c6f51) | test losowy filtra (NZ-FA-05, `tests/filtr/xsd/fa3-rozliczenie.test.ts`) wyrzucał PR z kolejki (ziarno -1393428064): `settlementVatSummaries` odmawiał „zaliczki przekraczają wartość zamówienia”, gdy netto albo VAT reszty stawki wychodziło ujemne o grosz z zaokrąglenia rozbicia na fakturach zaliczkowych (np. 2 × 0,32 zł z VAT 0,03 przy 5 %); teraz odmowa tylko przy ujemnej reszcie brutto, a P_13/P_14 to zamówienie minus zaliczki (art. 106f ust. 3, RP-FA-ROZ-01); poprawka obejmuje plik FA(3), zapis ROZ i JPK_FA |
| 23.11.2026 | wyłącznik cen brutto: test pełnego runnera | #901 | gotowe do scalenia | punkt 2 „przed pierwszym włączeniem” z #884: prawdziwy `runSubmitInvoice` przy wyłączonym wyłączniku uzgadnia fakturę w cenach brutto z otwartą wysyłką (`sent`, „Tylko uzgodnij”, zamiar) i zapisuje numer KSeF, bez POST i bez odczytu wyłącznika; z bramką wstawioną przed uzgodnieniem (próba bez commita) 3 z 3 czerwonych. Punkt 3 (wiersz runbooka w `AGENTS.md`) dopisuje koordynator |
| 23.11.2026 | osobne ustalenia (cd.) | n/d | do zrobienia | (19) rozbicie z faktury zaliczkowej nie ma górnej granicy odchyłki od wzoru, więc przy błędnych danych ujemny składnik reszty ROZ może być większy niż grosz (`lib/ksef/fa3-advance-generator.ts:570`, #898); (20) FLO sprawdza przekroczenie zaliczek sumą, a generator stawką (`lib/flo/functions/invoice-final.ts:148`, #898); (21) ścieżka nowego testu w polu `testy` RP-FA-ROZ-01 i pytanie do księgowej o ujemne P_13/P_14 w ROZ (osobny PR z `zgoda:wiedza-prawna`, #898) |
| 23.11.2026 | czeka na ludzi (cd.) | n/d | zapisane | księgowa: czy faktura rozliczająca może mieć ujemne P_13_x albo P_14_x o grosz, gdy rozbicie zaliczek zaokrągliło inaczej niż zamówienie (RP-FA-ROZ-01, ustalenie 21); osobne ustalenie 18 (runbook „przygotujemy korektę z Tobą”): procedurę pomocy opisuje Bartosz albo Igor |
| 23.11.2026 | wyłącznik cen brutto: test pełnego runnera; dziennik | #901, #903 | scalone 23.11 (5ec9c35b, 704a0ad0) | #903: wiersze 23.11 (#891-#901, FZ-029) |
| 23.11.2026 | naprawa FZ-032: paczka archiwum mimo faktury zakupu ze Skrzynki bez danych stron | #906 | scalone 23.11 (da2256de) | wydruk tylko faktury z nazwą i adresem obu stron (`hasPrintableParties`); bez nich spis paczki podaje brak PDF z powodem, a oryginałem zostaje plik XML z KSeF w paczce; inny błąd wydruku daje brak PDF z powodem `PDF_FAILED` i wpis w logu zamiast błędu całej paczki. Uwaga N5 czytelnika, świadomie: `catch` obejmuje też błędy przejściowe, więc taka faktura zostaje w paczce bez PDF zamiast ponowienia joba (wydruk to wizualizacja, powód w spisie jest prawdziwy) |
| 23.11.2026 | naprawa FZ-033, część: paczka archiwum czyta okres i pliki faktur stronami z licznikiem | #908 | scalone 23.11 (8e4b8cfc) | faktury, koszty, XML i UPO okresu przez helpery stronicowania z licznikiem (`readCompletePagesByKey`, `readAllByIdInList`): limit serwera 1000 wierszy albo zapis w trakcie odczytu daje ponowienie zamiast paczki z brakiem albo dublem. FZ-033 naprawione częściowo: FLO przejął Masło, test NZ-WSP-08 na `lib/archiwum` w #915. Uwaga N2 czytelnika: po wyczerpaniu prób z powodu zapisu w trakcie odczytu komunikat joba jest ogólny (wyjście „zleć ją ponownie” jest), osobne ustalenie 23 |
| 24.11.2026 | osobne ustalenia 14 i 16: katalog produktów | #914, #913 | scalone 23-24.11 (980f2ad6, bafd27e5) | #914 (14): podpowiedź produktu ze stawką bez podatku (zw, oo, np, np II) nie wstawia zapisanej ceny brutto do faktury w cenach brutto, dane w bazie bez zmian; uwaga N1 czytelnika, świadomie: zmiana stawki produktu nie czyści ceny brutto (ciche nadpisanie danych klienta). #913 (16): błąd odczytu przy edycji i usunięciu produktu mówi „Nie udało się odczytać produktu… Spróbuj ponownie za chwilę.” zamiast „Nie znaleziono produktu”; uwaga N1 czytelnika: sam tekst „Nie znaleziono produktu w tej organizacji.” nie podaje wyjścia, osobne ustalenie 22 |
| 24.11.2026 | NZ-WSP-08 obejmuje `lib/archiwum` | #915 | scalone 24.11 (4b24fe9a), `zgoda:zmiana-filtra` od Bartosza | drugie wyjście z FZ-033: test strukturalny NZ-WSP-08 pilnuje też odczytów paczki archiwum; odczyty paczki z nazwą tabeli wprost, bez zmiany zachowania; lista zleceń paczki (`readArchiveOrders`, `limit` 5) w wyjątkach `OGRANICZONE` |
| 24.11.2026 | osobne ustalenie 13: firma zwolniona z VAT bez wyboru „Ceny brutto” | #918 | scalone 24.11 (031994eb) | firma zwolniona podmiotowo (art. 113) nie widzi wyboru „Ceny netto / Ceny brutto” ani podkładu w cenach brutto; zwolnienie przedmiotowe (art. 43) zostawia wybór, bo czynny podatnik sprzedaje też ze stawką 23, 8 albo 5 %; R3 |
| 24.11.2026 | osobne ustalenie 9: API v1 i MCP z ceną brutto | #919 | scalone 24.11 (6000dbc9) | pole `unit_price_gross` w pozycji faktury (`GET /api/v1/invoices/{id}`, MCP `get_invoice`, opis OpenAPI i `/api/docs`) z dokumentu faktury, jak PDF i szczegóły (`documentGrossPrices`); faktura w cenach netto i odpowiedź `POST /invoices` mają `null`; R2 |
| 24.11.2026 | osobne ustalenie 17: „Korekta” przy fakturze, której formularz korekty odmawia | #920 | gotowe do scalenia (CI w toku) | lista, pulpit i szczegóły bez „Korekta” przy pozycji bez ceny netto albo ilości (faktura w cenach brutto, plik z KSeF z `P_9B`); szczegóły pokazują zamiast linku ten sam powód z wyjściem co formularz; R3. Telefon liczy przycisk po swojej stronie (osobne ustalenie 24) |
| 24.11.2026 | FZ-037 | n/d | u sesji filtra | pojedynczy PDF faktury zakupu ze Skrzynki KSeF bez danych stron (`/api/invoices/[id]/pdf`, telefon) kończy się błędem 500 zamiast odmowy z wyjściem; ta sama przyczyna co FZ-032, paczka archiwum pomija już taki PDF z powodem (#906) |
| 24.11.2026 | osobne ustalenia (cd.) | n/d | do zrobienia | (22) „Nie znaleziono produktu w tej organizacji.” bez wyjścia (`app/actions/produkty.ts`, #913); (23) ogólny komunikat joba paczki archiwum po wyczerpaniu prób przy zapisie w trakcie odczytu (`lib/jobs/runners/document-archive.ts`, #908); (24) przycisk „Korekta” w telefonie przy fakturze, której formularz korekty odmawia (plan aplikacji mobilnej; formularz po wejściu odmawia z wyjściem) |

**Następny krok:** #920 przez kolejkę. Dalej bez ludzi: osobne ustalenia 19 (granica odchyłki rozbicia zaliczki w ROZ), 22 i 23 (teksty z wyjściem), 20 (FLO, u Masła); dalsze kroki #834 (komunikat przy odmowie funkcji 00212, niska wartość); 1.1 C2-C4 (plan zero); 2.1 waluty, potem 2.3 z RP-EX-01; 6.2 część 5, 6.3 (po plikach z kont próbnych), 9.1 kadry na koniec (P3). Ustalenia 8 i 24 (telefon) w planie aplikacji mobilnej; FZ-037 u sesji filtra. Czeka na księgową: ceny brutto (e) część 2 i włączenie cen brutto (RP-FA-BRUTTO-01), ujemne P_13/P_14 w ROZ (RP-FA-ROZ-01).
