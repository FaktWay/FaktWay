---
name: migracja
description: Wgranie migracji SQL z main na db-1 i weryfikacja (schema_migrations, NOTIFY pgrst, PostgREST). Agent robi to sam po kontroli; DROP, TRUNCATE, DELETE, UPDATE tylko za zgodą Bartosza.
---

1. Przeczytaj `docs/runbooks/wgrywanie-migracji.md`.
2. Tylko pliki z `origin/main`. Kontrolę robi `scripts/ops/kontrola-migracji.mjs` (woła ją `wgraj-migracje.sh`): przepuszcza wzorce addytywne i odmawia `DROP TABLE`/`DROP COLUMN`, `TRUNCATE`, `DELETE FROM`, `UPDATE` na wierszach, `RENAME` i zmiany typu kolumny. Odmowa znaczy: zgoda Bartosza w tej rozmowie i wgranie ręczne według runbooka (przy `UPDATE` najpierw policz dotknięte wiersze). Reszty nie pytasz o zgodę.
3. Nagłówek (`-- KIEDY WGRAĆ: PRZED wdrożeniem …` albo `PO wdrożeniu …`) mówi, kiedy wgrać; trzymaj się tej kolejności względem wdrożenia. Co noc robi to samo `nocne-wdrozenie.sh`, więc bez pilnej potrzeby zostaw to nocy.
4. Uruchom `./scripts/ops/wgraj-migracje.sh <numery>` (jedna transakcja na plik, `schema_migrations`, `NOTIFY pgrst`, test PostgREST-a).
5. Po wgraniu: typy z produkcji w najbliższym PR (`types/database.ts`, sekcja „Typy bazy” w runbooku). Stanu „wgrana na db-1” nie dopisuje się do repo: jest w `supabase_migrations.schema_migrations` (rejestr w `CLAUDE-DO-CODEXA.md` jest zamrożony od 00207). Numer nowej migracji: `node scripts/dev/nastepna-migracja.mjs`.
