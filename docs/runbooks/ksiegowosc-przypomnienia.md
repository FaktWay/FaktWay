# Przypomnienia o terminach w module księgowości

Zadanie `cron.ksiegowosc-terminy` (`lib/jobs/runners/ksiegowosc-terminy.ts`)
codziennie o 08:00 wysyła firmom w pilotażu przypomnienia 5 i 1 dzień przed
terminem: push do członków firmy, mail do właściciela i wpis w dzwonku. Termin
z kalendarza (`lib/ksiegowosc/kalendarz.ts`) przy dniu wolnym przesuwa się na
następny dzień roboczy, więc przypomnienia o VAT (termin 25.) wychodzą zwykle
20. i 24., a np. przy terminie 27.04 dnia 22. i 26. Każdy etap ma swój dzień:
przypomnienie, którego nie wysłano w jego dniu, nie wraca następnego dnia.

Ponowienia: 4 (`PONOWIENIA_TERMINOW`, ok. 10 s, 30 s, 1 min i 5 min), potem
zadanie kończy się błędem. Wpis w `tax_notifications` (etap `termin-N:RRRR-MM-DD`)
chroni przed drugim przypomnieniem przy ponowieniu.

## Błąd odczytu danych

| Co | Kiedy | Co się dzieje |
|---|---|---|
| Rozliczenia, profil, ewidencja, KPiR (`bladOdczytu`, D63 z FZ-041) | każdy termin | ponowienie; ostatnia próba idzie dalej jak miesiąc bez kwot (przypomnienie bez kwoty), w Sentry błąd z `krok: odczyt-ostatnia-proba` |
| KPiR roku poprzedniego, składka zdrowotna w styczniu (`bladOdczytuPoprzedniego`, D63) | termin ZUS za styczeń | ponowienie; ostatnia próba: zdrowotna bez kwoty i bez zdania po zapłacie, w Sentry `krok: kpir-poprzedni-ostatnia-proba` |
| „Wyliczone” (`cron.ksiegowosc-miesiac`, D63) | dni uruchomień crona | błąd odczytu (miesiąc, VAT, KPiR poprzedniego roku) to ponowienie; ostatnia próba wysyła bez pozycji z błędem albo pomija, w Sentry `krok: odczyt-ostatnia-proba` |
| Dane VAT (`BLAD_ODCZYTU_VAT`, D32 z FZ-030) | tylko w dniu przypomnienia o VAT | ponowienie; ostatnia próba idzie dalej jak przy braku: VAT bez oznaczonej zapłaty wychodzi bez kwoty („Bez oznaczonej zapłaty: VAT.”), a VAT oznaczony jako zapłacony nie dostaje przypomnienia (błąd odczytu to nie brak z danych); w Sentry błąd z `krok: vat-ostatnia-proba` |

Błąd odczytu VAT w inny dzień (np. 15. przed terminem ryczałtu i ZUS) niczego
nie zatrzymuje, bo przypomnienie VAT nie dotyczy.

## Co zrobić

1. Sentry, `area: ksiegowosc.terminy`: firma (`tenantId`), miesiąc, etap.
2. Przyczyna błędu VAT jest w Sentry z `area: ksiegowosc.vat` (ta sama firma
   i miesiąc; `lib/ksiegowosc/vat-dane.ts` i `lib/ksiegowosc/ten-miesiac-dane.ts`,
   `krok: czytaj-vat`). „Ten miesiąc” pokazuje tylko ogólny komunikat o błędzie
   odczytu. Stałe przyczyny spotykane w kodzie: korekta, której faktura
   pierwotna nie jest przyjęta w tym środowisku KSeF; worker bez `KSEF_ENV`;
   firma usunięta w trakcie zadania.
3. Po naprawie przyczyny przypomnienie z tego dnia samo nie wróci. Po etapie
   „5 dni przed” następny etap („1 dzień przed”) wyjdzie normalnie. Po etapie
   „1 dzień przed” następnego nie ma, a ręcznej wysyłki w repo nie ma: Bartosz
   decyduje, czy uprzedzić firmę inną drogą (jak przy PRZ-02 w
   [`filtr.md`](filtr.md)); firmę wskazuje `tenantId` z Sentry.
