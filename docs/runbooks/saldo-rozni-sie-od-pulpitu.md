# Potwierdzenie salda: saldo różni się od Pulpitu (alarm `saldo.mismatch`)

Krok 2.9, część 2 (decyzja D26, uwaga N6 drugiego czytelnika PR B).

## Co się stało

Akcja podglądu albo wystawienia potwierdzenia salda liczy saldo kontrahenta
w bazie (`balance_confirmation_preview`) i porównuje je z należnościami
z Pulpitu (`getReceivables`, rozkład po NIP nabywcy, `lib/saldo/oblicz.ts`,
`matchesReceivables`). Muszą się zgadzać te same faktury i ta sama kwota do
zapłaty każdej z nich co do grosza. Gdy się nie zgadzają, dokument NIE
powstaje, a klient widzi tekst `BALANCE_TEXTS.pulpitMismatch` z prośbą o
kontakt przez Pomoc. W Sentry pojawia się komunikat „Potwierdzenie salda: saldo
z bazy różne od należności Pulpitu” z tagiem `action:saldo.mismatch` i polami
`tenantId`, `contractorId`. Nic nie zostało zapisane ani wysłane: sprawa jest
bezpieczna, tylko blokuje klienta.

## Co sprawdza operator

1. Z alarmu weź `tenantId` i `contractorId`. Otwórz kontrahenta w tabeli
   `contractors` (NIP, nazwa).
2. Wypisz faktury sprzedaży tego NIP w tabeli `invoices` (`direction`
   sprzedaż, `buyer_nip` po usunięciu spacji i myślników) z kolumnami
   `id, internal_number, ksef_status, ksef_environment, invoice_kind,
   invoice_type, currency, gross_total, paid_amount, payment_data,
   payment_status`. Tak jak Pulpit i podgląd, bierze się faktury z
   `payment_status` w (`unpaid`, `partial`, `overdue`), przyjęte w KSeF, w
   złotych, rodzaju regular, advance albo final.
3. Porównaj z listą „Faktury” i z Pulpitem tej firmy. Najczęstsze przyczyny:
   - faktura jest w jednym zestawieniu, a w drugim nie (różnica w warunku
     należności albo faktura zmieniła stan w trakcie: wpłata, korekta, nowy
     numer KSeF między dwoma odczytami);
   - ta sama faktura z inną kwotą: zaliczki i faktura rozliczająca
     (`payment_data.amountDue`, `outstandingOf`), wpłata częściowa;
   - NIP nabywcy zapisany inaczej w kontrahencie niż w fakturze;
   - faktura z innego środowiska KSeF niż `KSEF_ENV` aplikacji.
4. Jeśli to chwilowa zmiana stanu, poproś klienta o odświeżenie podglądu:
   powtórzony podgląd zwykle przechodzi, a alarm był jednorazowy.
5. Jeśli różnica jest stała, to błąd jednego z dwóch sposobów liczenia.
   Nie omijaj porównania i nie wystawiaj dokumentu ręcznie w bazie. Zapisz
   przykład (faktura, kwota z Pulpitu, kwota z podglądu) i załóż naprawę
   według „Protokołu naprawy błędu” (czerwony test na prawdziwej ścieżce,
   w obu liczeniach naraz). Obszar R1: karta zmiany prawnej i drugi czytelnik.

## Co powiedzieć klientowi

Że sprawdzamy różnicę, a dokument nie wyszedł. Gdy przyczyna jest po stronie
danych klienta (np. NIP kontrahenta), poproś o poprawkę w Kontrahentach i
ponowienie podglądu.

## Czego nie robić

- Nie wyłączaj porównania z Pulpitem, żeby „odblokować” klienta.
- Nie zmieniaj ręcznie wystawionych dokumentów (wyzwalacze ich pilnują).
- Wyłącznik `balanceConfirmationsEnabled` wstrzymuje podgląd, wystawienie i
  wysyłkę mailem, a pobranie PDF już wystawionych dokumentów zostaje.
