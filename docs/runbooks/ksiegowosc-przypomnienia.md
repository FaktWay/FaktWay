# Przypomnienia o terminach w module księgowości

Zadanie `cron.ksiegowosc-terminy` (`lib/jobs/runners/ksiegowosc-terminy.ts`)
codziennie o 08:00 wysyła firmom w pilotażu przypomnienia 5 i 1 dzień przed
terminem: push do członków firmy, mail do właściciela i wpis w dzwonku. Każdy
etap ma swój dzień, więc przypomnienie, którego nie wysłano w jego dniu, nie
wraca następnego dnia (następny etap, 1 dzień przed, wychodzi normalnie).

Ponowienia: 4 (`PONOWIENIA_TERMINOW`, ok. 10 s, 30 s, 1 min i 5 min), potem
zadanie kończy się błędem. Wpis w `tax_notifications` (etap `termin-N:RRRR-MM-DD`)
chroni przed drugim przypomnieniem przy ponowieniu.

## Błąd odczytu danych

| Co | Kiedy | Co się dzieje |
|---|---|---|
| Rozliczenia (`BLAD_ODCZYTU_ROZLICZEN`) | każdy termin | ponowienie; po ostatniej próbie przypomnienie tej firmy przepada (bez odczytu zapłat nie wiadomo, co jest zapłacone) |
| Dane VAT (`BLAD_ODCZYTU_VAT`, D32 z FZ-030) | tylko w dniu przypomnienia o VAT (20. i 24. przed terminem 25.) | ponowienie; ostatnia próba wysyła przypomnienie z VAT bez kwoty („Bez oznaczonej zapłaty: VAT.”) i zapisuje w Sentry błąd z `krok: vat-ostatnia-proba` |

Błąd odczytu VAT w inny dzień (np. 15. przed terminem ryczałtu i ZUS) niczego
nie zatrzymuje, bo przypomnienie VAT nie dotyczy.

## Co zrobić

1. Sentry, `area: ksiegowosc.terminy`: firma (`tenantId`), miesiąc, etap.
2. Przyczyna błędu VAT: „Ten miesiąc” tej firmy za ten miesiąc pokazuje ten sam
   błąd odczytu. Stałe przyczyny spotykane w kodzie: korekta, której faktura
   pierwotna nie jest przyjęta w tym środowisku KSeF; worker bez `KSEF_ENV`;
   firma usunięta w trakcie zadania.
3. Po naprawie przyczyny nic nie trzeba wysyłać ręcznie: następny etap
   przypomnienia wyjdzie sam, a „Ten miesiąc” pokazuje kwoty od razu.
