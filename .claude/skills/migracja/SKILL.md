---
name: migracja
description: Wgranie migracji SQL z main na db-1 i weryfikacja (schema_migrations, NOTIFY pgrst, PostgREST). Agent robi to sam po kontroli; DROP, TRUNCATE, DELETE, UPDATE tylko za zgodą Bartosza.
---

1. Przeczytaj `docs/runbooks/wgrywanie-migracji.md`.
2. Tylko pliki z `origin/main`. Kontrolę robi `scripts/ops/kontrola-migracji.mjs` (woła ją `wgraj-migracje.sh`): przepuszcza wzorce addytywne i odmawia `DROP TABLE`/`DROP COLUMN`, `TRUNCATE`, `DELETE FROM`, `UPDATE` na wierszach, `RENAME` i zmiany typu kolumny. Odmowa znaczy: zgoda Bartosza w tej rozmowie i wgranie ręczne według runbooka (przy `UPDATE` najpierw policz dotknięte wiersze). Reszty nie pytasz o zgodę.
3. Nagłówek (`-- Wdrożenie: PRZED` albo `PO`) mówi, kiedy wgrać; trzymaj się tej kolejności względem wdrożenia. Co noc robi to samo `nocne-wdrozenie.sh`, więc bez pilnej potrzeby zostaw to nocy.
4. Uruchom `./scripts/ops/wgraj-migracje.sh <numery>` (jedna transakcja na plik, `schema_migrations`, `NOTIFY pgrst`, test PostgREST-a).
5. Po wgraniu: w najbliższym PR stan „wgrana na db-1 DD.MM” w rejestrze `docs/koordynacja/CLAUDE-DO-CODEXA.md` i typy z produkcji (`types/database.ts`, sekcja „Typy bazy” w runbooku).
