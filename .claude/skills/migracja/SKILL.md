---
name: migracja
description: Wgranie migracji SQL z main na db-1 i weryfikacja (schema_migrations, NOTIFY pgrst, PostgREST). Tylko na wyraźne polecenie Bartosza.
disable-model-invocation: true
---

1. Przeczytaj `docs/runbooks/wgrywanie-migracji.md`.
2. Tylko pliki z `origin/main`. Przeczytaj każdy plik: `DROP TABLE`/`DROP COLUMN`/`TRUNCATE`/`DELETE FROM` poza ciałem funkcji wymaga linii `-- DROP/DML:` i zgody Bartosza w tej rozmowie. `UPDATE` na istniejących wierszach: najpierw policz dotknięte wiersze.
3. Nagłówek mówi „PRZED” czy „PO wdrożeniu”; trzymaj się tej kolejności względem `/wdrozenie`.
4. Uruchom `./scripts/ops/wgraj-migracje.sh <numery>` (jedna transakcja na plik, `schema_migrations`, `NOTIFY pgrst`, test PostgREST-a).
5. Po wgraniu: typy z produkcji w najbliższym PR (`types/database.ts`, sekcja „Typy bazy” w runbooku). Stanu „wgrana na db-1” nie dopisuje się do repo: jest w `supabase_migrations.schema_migrations` (rejestr w `CLAUDE-DO-CODEXA.md` jest zamrożony od 00207). Numer nowej migracji: `node scripts/dev/nastepna-migracja.mjs`.
