# Joby w tle — pg-boss (runbook)

Od 18 sierpnia 2026 wszystkie joby chodzą na **pg-boss** w naszym Postgresie
(schemat `pgboss` na `db-1`). Inngest odpięty 02.10.2026 (etap 10) — bez
ścieżki powrotu. Dostępy i zmienne: `AGENTS.md`, sekcja
„Infrastruktura i dostępy” (`source .agents/infra.env`).

## Jak to działa

| Element | Gdzie | Co robi |
|---|---|---|
| Wysyłka zadania | aplikacja web, `lib/jobs/enqueue.ts` | `sendJobEvent` → kolejka z `EVENT_QUEUE_MAP` (`lib/jobs/queues.ts`); zdarzenie może iść do kilku kolejek |
| Worker | Coolify **id=2**, `lib/jobs/worker.ts` | odbiera kolejki, prowadzi crony (`CRON_JOBS`), healthcheck HTTP dla Coolify |
| Rejestracja jobów | `lib/jobs/handlers/*` | kolejka → ciało joba z `lib/jobs/runners/*`, limity (`batchSize`, `groupConcurrency`), `onExhausted` |
| Ponowienia | wrapper workera | licznik `__attempt` w danych, harmonogram jak w Inngest; po wyczerpaniu `onExhausted` |
| Dziennik przebiegów | `inngest_run_log` (`lib/jobs/run-log.ts`) | każdy przebieg: sukces / błąd, czas; czyta go monitor alarmów i `/admin/system` |
| Heartbeat | cron `cron.ops-heartbeat` → `OPS_HEARTBEAT_URL` | ping co minutę do Healthchecks; **brak pinga = alarm** |

Wdrożenie zawsze obejmuje **web (id=1) i worker (id=2)** — worker importuje
szeroki przekrój `lib/**`, a stan mieszany psuje joby (AGENTS.md, pułapka 3).

## Stan kolejek

Najszybciej: bramka Telegrama, `/kolejki` (funkcja `ops.queues()`, 00100) —
zaległe, aktywne i nieudane z 24 h per kolejka.

Z `db-1` (tylko odczyt):

```bash
source .agents/infra.env
ssh -i $K root@$DB "docker exec $PGC psql -U postgres -d postgres -c \"
  SELECT name, state, count(*), min(created_on) AS najstarsze
    FROM pgboss.job
   WHERE state IN ('created','retry','active','failed')
   GROUP BY 1, 2 ORDER BY 1, 2;\""
```

Crony: ostatnie uruchomienie = `max(created_on)` dla kolejki `cron.*`.

## Logi workera

```bash
source .agents/infra.env
ssh -i $K root@$APP 'C=$(docker ps --format "{{.Names}}" | grep "^$WORKER_PREFIX");
  docker logs --since 30m $C 2>&1 | tail -100'
```

Logger workera maskuje pola z NIP-em i adresem e-mail (`lib/jobs/logger.ts`).
Błędy jobów idą do Sentry (worker od 01.10.2026).

## Typowe sytuacje

| Objaw | Co sprawdzić | Co zrobić |
|---|---|---|
| Alarm Healthchecks (brak pinga) | czy kontener workera działa; logi; czy baza odpowiada | restart workera w Coolify albo wdrożenie; po starcie zaległe zadania wykonają się same |
| Zadania czekają w `created` | logi workera (czy kolejka „aktywna”), limity `groupConcurrency` | jeśli worker żyje, a kolejka stoi — restart workera |
| Faktury wiszą w „Wysyłanie” | `docs/runbooks/hamulce-ksef.md`, „Faktura utknęła w wysyłce (I1/I2)”; `ksef_submissions` | żywe zlecenie w pg-boss — czekać (worker przejmie po dzierżawie i uzgodni po numerach referencyjnych, #126); bez zlecenia ponad 30 min — `./scripts/ops/zwolnij-utknieta-wysylke.sh <id>` |
| Wyłączyć crony (test, przełączanie) | — | `WORKER_DISABLE_SCHEDULES=true` na workerze — worker czyści też zapisany harmonogram |
| Skrzynka KSeF nie nadąża (`stale_inbox_sync`, rośnie `oldestLagSeconds` w linii `ksef.inbox.dispatch`) | `docs/runbooks/skrzynka-ksef-pojemnosc.md` | więcej slotów: `KSEF_INBOX_POLL_SLOTS` i restart workera; wzór pojemności w tym runbooku |
| Sentry „Powiadomienie o wyniku wysyłki faktury nie doszło do klienta” (A5 #3) | `extra`: `invoiceId`, `tenantId`, kolejka (`…succeeded.notify` = przyjęta, `…failed.notify` = odrzucona albo czeka na decyzję), `error`; trzy próby: od razu, po 5 min, po 30 min | klient nie dostał e-maila (push mógł dojść — e-mail ponawiany osobno). Daj znać klientowi ręcznie o stanie faktury; przy duplikacie 440 — „Przypomnij klientowi” w `/admin/ksef/<id>`. Ostrzeżenie „Karta FLO nieudana” w logu workera nie zatrzymuje powiadomienia |
| Sentry „Sprzątanie paczek archiwum: klucz pliku spoza katalogu zlecenia, plik zostaje w magazynie” (`cron.document-archive-cleanup`, 00190) | `extra.archiveIds`; `select id, tenant_id, status, file_key, expires_at, file_deleted_at from document_archives where id = '<id>';` | zadanie nie usuwa pliku, którego klucz nie leży wprost w `exports/<firma>/archiwum/<zlecenie>/`; klient widzi paczkę jako wygasłą i może zlecić nową. Sprawdź ten jeden obiekt w MinIO (`mc stat`); jeśli to plik tej paczki, usuń tylko ten klucz (bez usuwania po prefiksie), potem znacznik i wpis audytu jedną funkcją: `select public.mark_document_archive_file_deleted('<id>', '<file_key>');` |
| Sentry „Sprzątanie paczek archiwum: błąd magazynu …, ponowienie” albo wyczerpane próby `cron.document-archive-cleanup` | logi workera, MinIO na `ops-1` | wiersze bez znacznika czekają, nic w bazie ręcznie; po naprawie magazynu ponowienie albo następny przebieg (04:30) usunie pliki same |
| Archiwum, błąd przejściowy: błędy `cron.archive-old-invoices` w `/admin/system` albo Sentry po wyczerpanych próbach; w logu workera `step FAIL: glacier-<id>` z „Archiwum: nie można odczytać skrótu XML faktury <id> (…)”, w nawiasie `57014` (limit czasu zapytania), od `PGRST000` do `PGRST003` (PostgREST bez połączenia z bazą albo z wyczerpaną pulą połączeń), „bez kodu: ” z treścią strony błędu (502, 503 albo 504 bramki), „bez kodu: TimeoutError” (limit czasu klienta), „bez kodu: TypeError: …”, np. „TypeError: fetch failed” (worker nie połączył się z bramką albo bazą, a biblioteka ponowiła odczyt już 3 razy) albo „odpowiedź bazy bez listy wierszy i bez błędu” | czy błąd wraca w kolejnych próbach i nocach; jeśli wraca, logi PostgREST i Konga, a przy „fetch failed” także to, czy worker dosięga bramki | dotyczy też trzech wierszy niżej: faktura zostaje bez znaczników archiwum, a jej XML w R2, więc klient nic nie traci; dopóki błąd trwa, każdy przebieg staje na tej fakturze, a dalsze czekają. Przy błędzie przejściowym nic ręcznie: weźmie ją ponowienie albo następny przebieg (3:00) |
| Archiwum, błąd trwały: ten sam komunikat, w nawiasie `42501`, `PGRST2xx` albo `PGRST3xx`, każda próba tak samo | `42501`: czy worker ma klucz `service_role` (`SUPABASE_SERVICE_ROLE_KEY`) i czy rola czyta `xml_documents`. `PGRST2xx` (np. `PGRST205`, brak tabeli): czy migracje są wgrane i schemat PostgREST przeładowany (`wgrywanie-migracji.md`). `PGRST3xx` (JWT): czy klucz pasuje do sekretu JWT bazy (`rotacja-kluczy.md`) | naprawa konfiguracji, zmiana zmiennych tylko za zgodą Bartosza; w `xml_documents` i `invoices` nic ręcznie. Po naprawie ponowienie albo następny przebieg zarchiwizuje fakturę ze sprawdzonym skrótem |
| Archiwum, duble dowodu: komunikat z „kilka wierszy xml_documents tej faktury” | zapytanie o duble z nagłówka `supabase/migrations/00164_xml_documents_one_per_invoice.sql` (tylko odczyt) i czy jest indeks `uq_xml_documents_tenant_invoice` | rozstrzyga Bartosz według nagłówka 00164, potem następny przebieg zarchiwizuje fakturę ze sprawdzonym skrótem |
| Archiwum, plik niezgodny z dowodem: `step FAIL: glacier-<id>` z „R2: hash mismatch for "<ścieżka>". Expected <skrót>, got <skrót>”; „Expected , got …” to pusty skrót w wierszu dowodu; ostrzeżenie „wiersz xml_documents faktury <id> wskazuje inną ścieżkę pliku niż faktura” przed nim to wiersz wskazujący inny plik (konflikt przy zapisie dowodu) | tylko odczyt: wiersz `xml_documents` faktury (`storage_path`, `sha256_hash`), `invoices.xml_storage_path`, skrót pliku w MinIO i `request_payload_hash` przyjętej wysyłki w `ksef_submissions` | niczego nie nadpisuj. Który plik jest właściwy, rozstrzyga oryginał z KSeF (`ksef-error-codes.md`, „Faktura przyjęta bez wiersza `xml_documents`”, punkty 1 i 4); poprawkę wiersza albo pliku zatwierdza Bartosz. Potem następny przebieg zarchiwizuje fakturę ze sprawdzonym skrótem |

**Nie kasuj** wierszy w `pgboss.*` ręcznie bez uzgodnienia — to także historia
przebiegów i ochrona przed podwójnym wykonaniem.
