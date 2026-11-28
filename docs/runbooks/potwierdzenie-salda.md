# Potwierdzenie salda: operacje na wystawionych dokumentach

Dokument „Potwierdzenie salda” (PS/n/rok, migracje 00216 i 00218) jest po
wystawieniu niezmienny. Klient poprawia błąd nowym dokumentem (numer rośnie,
stary zostaje w historii).

## Usunięcie dokumentu (tylko za zgodą Bartosza)

Wyzwalacz `a_guard_balance_confirmation_delete` odrzuca każdy DELETE, także dla
`service_role` i właściciela bazy: usunięcie zostawia dziurę w serii PS, a
dokument mógł już trafić do kontrahenta. Wyjątki: kasowanie kaskadowe przy
usunięciu firmy (RODO) i sesja operatora z flagą w jednej transakcji:

```sql
BEGIN;
SET LOCAL app.allow_balance_confirmation_delete = 'on';
DELETE FROM public.balance_confirmation_emails WHERE confirmation_id = '<id>';
DELETE FROM public.balance_confirmations WHERE id = '<id>';
COMMIT;
```

Przed usunięciem sprawdź `audit_logs` (`balance_confirmation.issued`,
`balance_confirmation.emailed`) i zapisz decyzję. Numeru nie da się
odzyskać; kolejny dokument dostaje następny numer serii.

## Zmiana treści

Wyzwalacz `a_guard_balance_confirmation_update` odrzuca każdą zmianę treści.
Błąd systemu naprawia się SQL-em jako postgres za zgodą Bartosza, z
`ALTER TABLE ... DISABLE TRIGGER` na czas jednej transakcji i wpisem w dzienniku.
