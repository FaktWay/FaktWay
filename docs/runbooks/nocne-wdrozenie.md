# Nocne wdrożenie

> Decyzja Bartosza z 15.11.2026: wdrożenia robi noc, a migracje addytywne wgrywa
> automat po kontroli. Sesje agentów nie czekają już na człowieka, żeby ich kod
> trafił na produkcję.
> Jedną linią: `./scripts/ops/zainstaluj-nocne-wdrozenie.sh --sprawdz` (stan),
> `--wstrzymaj` i `--wznow` (wyłącznik), `--teraz` (to samo od razu).
> Powiązane: [`wgrywanie-migracji.md`](wgrywanie-migracji.md), [`wdrozenie-produkcji.md`](wdrozenie-produkcji.md), [`scalanie-pr.md`](scalanie-pr.md), [`backup-restore.md`](backup-restore.md).

## Jak to działa

Co noc o 03:30 czasu Warszawy timer systemd na `ops-1` uruchamia
`scripts/ops/nocne-wdrozenie.sh` na świeżej kopii repo (publiczne, bez
poświadczeń). Skrypt przypina SHA `origin/main` na cały przebieg i idzie po
kolei. Każda bramka, która nie przepuści, kończy przebieg bez zmian na
produkcji i wysyła powód na Telegram.

| Krok | Co sprawdza albo robi | Gdy nie przejdzie |
|---|---|---|
| 1 | Plik `/etc/faktway-nocne/STOP`, okno 01:00 do 05:59, blokada przed drugim przebiegiem | koniec, raport „wstrzymane” |
| 2 | Co działa na app-1 (worker i aplikacja na jednym SHA); cel już wdrożony? | koniec; stan mieszany to 🔴 |
| 3 | CI na SHA zielone (w tym obecne „Typecheck + Lint + Unit tests”, „Next build”, „RLS isolation”), oba obrazy w GHCR, brak wdrożeń w Coolify, 4 GB wolne na app-1 | koniec, raport ⚠️ z powodem |
| 4 | Migracje z SHA, których nie ma w `schema_migrations`: kontrola (`kontrola-migracji.mjs`), kolejność, kopia bazy do 26 h | koniec, 🔴 z listą i poleceniem |
| 5 | Migracje „PRZED” (`wgraj-migracje.sh`, pliki z tego SHA, `lock_timeout` 15 s) | koniec bez wdrożenia, 🔴 |
| 6 | Worker (`id=2`), potem aplikacja (`id=1`), obrazy z GHCR (`wdroz-produkcje.sh --obraz`), kontrola po wdrożeniu | **ratunek**: powrót obu na poprzedni SHA |
| 7 | Migracje „PO wdrożeniu” | 🔴, kod działa, wgraj ręcznie |
| 8 | Raport ✅ z listą zmian; ping Healthchecks | |

Ratunek jest bezpieczny, bo migracje „PRZED” są addytywne: stary kod działa
z nowym schematem. Migracje „PO wdrożeniu” przy porażce w ogóle nie ruszają.

## Co przychodzi rano

| Wiadomość | Znaczy | Co robisz |
|---|---|---|
| ✅ wdrożono `abcd1234` | wszystko poszło, kontenery na nowym SHA | nic |
| ⚠️ wstrzymane | jest plik STOP | `--wznow`, gdy chcesz wdrażać |
| ⚠️ CI na `…` nie jest zielone | czerwony lub niekompletny `main` | napraw `main`; jutro noc spróbuje z nowym SHA |
| ⚠️ obrazów `…` nie ma w GHCR | build po scaleniu nie skończył się albo pakiet jest prywatny | „Packages” w organizacji: pakiety `faktway-runner` i `faktway-worker` muszą być Public; build: `gh run list --workflow obrazy.yml` |
| ⚠️ Coolify ma aktywne wdrożenia | ktoś wdrażał ręcznie w nocy | nic, jutro ponowi |
| ⚠️ za mało miejsca na app-1 | dysk poniżej 4 GB | `docker image prune` na app-1, zostaw poprzednią wersję |
| ⚠️ wdrożony kod jest nowszy | ktoś wdrożył coś spoza `main` albo nowszego | zazwyczaj nic; sprawdź `coolify-zrodlo.sh stan` |
| 🔴 stan produkcji niejasny / różne commity | po przerwanym wdrożeniu worker i aplikacja stoją na różnych SHA | `./scripts/ops/coolify-zrodlo.sh stan`, potem `./scripts/ops/wdroz-produkcje.sh --obraz <sha>` |
| 🔴 migracje czekają na człowieka | kontrola zatrzymała migrację (powód w wiadomości) | sekcja „Migracje zatrzymane” niżej |
| 🔴 kopia bazy nieświeża | `backup_log` nie ma udanej kopii z 26 h | [`backup-restore.md`](backup-restore.md); migracje i wdrożenie czekają |
| 🔴 migracja „przed” nie weszła | transakcja się cofnęła, kodu nie wdrożono | log w `/var/log/faktway-nocne/`; popraw migrację nowym PR |
| 🔴 wdrożenie padło, wróciłem na `…` | nowy obraz nie wstał, produkcja na starym | log wdrożenia w raporcie; napraw `main` |
| 🔴 wdrożenie padło I ratunek się nie udał | produkcja w stanie niejasnym | od razu: `./scripts/ops/kontrola-faktur-ksef.sh`, `coolify-zrodlo.sh stan` |

Brak wiadomości, gdy nic nie było do wdrożenia, jest normalny (cichy dzień).
Jeśli skonfigurowano Healthchecks (`NOCNE_HC_URL`, okres 1 dzień, karencja 3 h),
zniknięcie pingu to alarm, że noc się w ogóle nie odbyła.

## Migracje: co przechodzi automatycznie

`kontrola-migracji.mjs` czyta migrację bez komentarzy, tekstów w apostrofach
i ciał funkcji (te przy wgraniu się nie wykonują; ciało bloku `DO` tak). Przepuszcza
wzorce addytywne: `CREATE`, `ALTER TABLE ... ADD`, zastępowanie
(`DROP POLICY/TRIGGER/FUNCTION/INDEX/VIEW/CONSTRAINT`, `DROP NOT NULL`),
`GRANT` i `REVOKE`, `INSERT`, `COMMENT`.

Zatrzymuje (wymaga człowieka): `DROP TABLE/SCHEMA/DATABASE/ROLE/TYPE/SEQUENCE/EXTENSION`,
`DROP COLUMN`, `TRUNCATE`, `DELETE FROM`, `UPDATE` na wierszach, `RENAME` w
`ALTER TABLE`, zmianę typu kolumny, wyłączenie RLS, `SUPERUSER` i `BYPASSRLS`,
`ALTER SYSTEM`, `COPY ... PROGRAM`. Zatrzymuje też migrację bez linii fazy w nagłówku
i taką, w której numer „PRZED” jest wyższy niż numer „PO wdrożeniu”
(kolejności numerów nie da się wtedy zachować przy jednym wdrożeniu).

Nagłówek każdej nowej migracji ma linię `-- Wdrożenie: PRZED` albo `-- Wdrożenie: PO`
z powodem (starsze `-- KIEDY WGRAĆ: PRZED|PO wdrożeniu` też działają). Z 187
istniejących migracji kontrola zatrzymałaby 9, wszystkie sprzed 00164, które
robią `UPDATE`, `DELETE` albo `DROP COLUMN`; migracje od 00164 przechodzą (poza 00200,
wgraną już bez nagłówka fazy).

### Migracje zatrzymane

Wiadomość 🔴 podaje numer i powód. Wtedy `main` zostaje bez wdrożenia, dopóki
migracja nie wejdzie, więc nie odkładaj tego na później.

1. Przeczytaj plik. Przy `UPDATE` i `DELETE FROM` policz najpierw dotknięte wiersze
   (`SELECT count(*)` z tym samym warunkiem); tysiące wierszy to pytanie do właściciela.
2. Wgraj ręcznie według [`wgrywanie-migracji.md`](wgrywanie-migracji.md) (psql w jednej
   transakcji, wpis w `schema_migrations`, `NOTIFY pgrst`). `wgraj-migracje.sh` też odmówi:
   ta sama kontrola, odmowa jest świadoma.
3. Następna noc zobaczy migrację w `schema_migrations` i wdroży resztę. Pilne: `--teraz`.

Brak linii fazy albo zła kolejność numerów to poprawka nagłówka albo numeru nowym PR.

## Sterowanie

| Chcesz | Polecenie |
|---|---|
| zobaczyć stan (timer, STOP, narzędzia, ostatni log) | `./scripts/ops/zainstaluj-nocne-wdrozenie.sh --sprawdz` |
| nie wdrażać dziś i dalej | `--wstrzymaj` (plik `/etc/faktway-nocne/STOP`) |
| wznowić | `--wznow` |
| wdrożyć teraz, z tymi samymi bramkami i raportem | `--teraz` (dzienne wdrożenie jest decyzją Bartosza, `AGENTS.md`, niezmiennik 4) |
| tylko zobaczyć plan, nic nie zmieniając | `./scripts/ops/nocne-wdrozenie.sh --sucho` (z Maca albo z ops-1) |
| wdrożyć konkretny SHA z main | `/usr/local/sbin/faktway-nocne-wdrozenie --teraz --sha <40 znaków>` na ops-1 |
| log ostatniego przebiegu | `/var/log/faktway-nocne/` na ops-1, `journalctl -u faktway-nocne-wdrozenie` |
| odinstalować | `--odinstaluj` (timer, wrapper, env, klucz) |

Ręczne `wdroz-produkcje.sh --obraz` nadal działa i nie koliduje z nocą: bramka
„Coolify ma aktywne wdrożenia” i blokada przebiegu chronią przed nakładaniem.
Po ręcznym wdrożeniu noc zobaczy, że produkcja już jest na celu.

## Instalacja jednorazowa (Bartosz)

Kolejność ma znaczenie.

1. **Pakiety GHCR publiczne** (obowiązkowe, jeszcze przed pierwszym wdrożeniem z obrazu).
   Pakiety pod nazwą organizacji (`ghcr.io/faktway/faktway-runner` i `…-worker`) powstały
   jako prywatne, a `app-1` pobiera obrazy bez logowania. GitHub → organizacja FaktWay →
   Packages → pakiet → Package settings → Change visibility → Public, dla obu. Sprawdzenie:
   `./scripts/ops/nocne-wdrozenie.sh --sucho` nie może pisać „GHCR nie wydał anonimowego tokenu”.
2. **Scal PR z nocnym wdrożeniem** (to się dzieje przez kolejkę scalania, `scalanie-pr.md`).
3. **Dopisz do `.agents/infra.env`** (poza gitem):
   `NOCNE_TELEGRAM_TOKEN=` (ten sam bot co `TELEGRAM_BOT_TOKEN` aplikacji),
   `NOCNE_TELEGRAM_CHAT_IDS=` (jak `TELEGRAM_ALERT_CHAT_IDS`, po przecinku),
   opcjonalnie `NOCNE_HC_URL=` (Healthchecks: okres 1 dzień, karencja 3 h).
4. **Uruchom** `./scripts/ops/zainstaluj-nocne-wdrozenie.sh`. Instalator: dołoży Node i
   narzędzia na ops-1, wygeneruje klucz, wpisze go do `authorized_keys` na trzech
   serwerach, sprawdzi łączność, wyśle wiadomość próbną na Telegram i zrobi przebieg
   `--sucho`.
5. **Pierwsze wdrożenie po przeniesieniu repo do organizacji zrób ręcznie**
   (`./scripts/ops/wdroz-produkcje.sh --obraz`, ok. 10 minut): przestawia Coolify na nazwę
   obrazu organizacji i pokazuje na żywo, że pobranie działa. Potem noc.

## Bezpieczeństwo

- Runner jedzie na kopii `main` i na zielonym CI: kod, który wykonuje się z uprawnieniami
  produkcji, przeszedł kolejkę scalania, filtr i drugiego czytelnika. To ta sama ufność,
  jaką ma wdrożenie z obrazu zbudowanego z `main`.
- Klucz `faktway_nocne_ed25519` leży na ops-1 bez hasła (timer musi działać bez człowieka).
  W `authorized_keys` ma `from=` (tylko z ops-1), `no-pty`, `no-port-forwarding`,
  `no-agent-forwarding`, `no-X11-forwarding`. ops-1 już dziś steruje wdrożeniami (Coolify wdraża na
  app-1), ale klucz dodaje mu dostęp do db-1 z poziomu skryptu: traktuj ops-1 jak host o podwyższonym
  ryzyku (zapora chmurowa, tylko klucze). `--odinstaluj` usuwa klucz ze wszystkich trzech.
- Token Telegrama leży w `/etc/faktway-nocne.env` (0600) i idzie do `curl` przez stdin,
  nie w linii poleceń ani w logu.
- Skrypt nic nie kasuje i nie cofa danych. Jedyne „cofnięcie” to powrót obrazów na poprzedni SHA.
- Migracje zawsze z SHA przypiętego na początku przebiegu (`WGRAJ_REF`), nie z nowszego `main`.

## Czego nie robi

- Nie wgrywa migracji z `DROP`, `TRUNCATE`, `DELETE`, `UPDATE` (powyżej) ani bez fazy w nagłówku.
- Nie cofa kodu na starszy SHA, gdy produkcja jest nowsza od celu.
- Nie zmienia zmiennych środowiskowych w Coolify ani nie rusza bramki Telegram (`ops/bramka`).
- Nie wdraża, gdy CI na `main` jest czerwone, niekompletne albo w toku po 20 minutach.
- Nie wdraża aplikacji mobilnej (`mobile/`): to osobny tor ze sklepami.
