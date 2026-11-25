-- ════════════════════════════════════════════════════════════════
-- FZ-022 (reguła RP-KOSZT-01): ten sam dokument kosztu dwa razy. TYLKO ODCZYT.
-- Woła go scripts/ops/koszt-dwa-razy.sh:
--   psql -X -q -v ON_ERROR_STOP=1 -v firma=<uuid albo pusto> -v lista=0|1 -v szczegoly=0|1
--        -v srodowisko=test|demo|production -f koszt-dwa-razy.sql
-- Runbook: docs/runbooks/koszt-dwa-razy.md. Test na bazie: tests/rls-koszt-dwa-razy-skrypt.test.ts
-- (wynik zgodny z `zdublowanyDokument` z lib/expenses/jeden-koszt-dokumentu.ts).
--
-- Ta sama reguła co odczyty KPiR, JPK_V7M i kart (koszty z „Uwzględnij
-- w KPiR”): dokument to NIP sprzedawcy (10 cyfr), numer bez odstępów (te same
-- znaki co `\s` w JS, także twarda spacja), wielkimi literami, i rok
-- wystawienia, bez względu na rodzaj. Odmowa, gdy w grupie jest koszt z KSeF
-- i koszt spoza KSeF, albo dwa koszty spoza KSeF to kopia: to samo brutto albo
-- (faktury) ta sama kolumna KPiR; dwa paragony tylko przy tym samym dniu
-- i brutto. Jak w aplikacji (`filterExpensesForKsefEnvironment`) koszt
-- powiązany z fakturą liczy się tylko, gdy faktura jest ze środowiska KSeF
-- aplikacji (`srodowisko`, KSEF_ENV). Koszty reprezentacji zostają (odpadają
-- tylko w KPiR modułu).
--
-- Grupa to rok (KPiR modułu, karty kosztów z kilku miesięcy); raport KPiR,
-- eksport i JPK_V7M czytają miesiąc albo okres zadania, więc osobno liczba
-- miesięcy, w których oba koszty grupy są w tym samym miesiącu.
--
-- Domyślnie same liczby (bez NIP-ów, numerów i kwot). lista=1: firmy z odmową
-- (id firmy i liczby, bez NIP-ów, numerów i kwot), do kontaktu przy okresach
-- złożonych. Szczegóły grup tylko dla jednej firmy (szczegoly=1 wymaga firmy;
-- pilnuje tego .sh i warunek niżej).
-- ════════════════════════════════════════════════════════════════

BEGIN READ ONLY;

SELECT (:'srodowisko' IN ('test', 'demo', 'production')) AS jest_srodowisko \gset
\if :jest_srodowisko
\else
\echo 'Podaj środowisko KSeF aplikacji (-v srodowisko=test|demo|production).'
ROLLBACK;
\quit
\endif

\if :szczegoly
SELECT (:'firma' <> '') AS jest_firma \gset
\if :jest_firma
\else
\echo 'Szczegóły tylko dla jednej firmy (--firma <uuid>).'
ROLLBACK;
\quit
\endif
\endif

\echo '=== Ten sam dokument kosztu dwa razy (FZ-022, RP-KOSZT-01)'

WITH k AS (
  SELECT e.id, e.tenant_id, e.issue_date, e.gross_amount, e.kpir_column::text AS kolumna,
         coalesce(e.document_type, 'invoice') AS rodzaj,
         (e.source = 'ksef_inbox' OR e.ksef_invoice_id IS NOT NULL) AS z_ksef,
         CASE WHEN e.source = 'ksef_inbox' OR e.ksef_invoice_id IS NOT NULL THEN 'ksef' ELSE e.source::text END AS zrodlo,
         (coalesce(e.document_type, 'invoice') IN ('receipt', 'simplified_invoice')
          OR (coalesce(e.document_type, 'invoice') = 'invoice'
              AND NOT (e.source = 'ksef_inbox' OR e.ksef_invoice_id IS NOT NULL)
              AND e.ocr_extracted_data ->> 'document_type' = 'simplified_invoice')) AS paragon,
         regexp_replace(coalesce(e.seller_nip, ''), '\D', '', 'g') AS nip,
         upper(regexp_replace(coalesce(e.document_number, ''), '[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]', '', 'g')) AS numer,
         extract(year FROM e.issue_date)::int AS rok,
         date_trunc('month', e.issue_date::timestamp)::date AS miesiac
    FROM public.expenses AS e
    LEFT JOIN public.invoices AS i ON i.id = e.ksef_invoice_id
   WHERE e.is_deductible
     AND (e.ksef_invoice_id IS NULL OR i.ksef_environment::text = :'srodowisko')
     AND (:'firma' = '' OR e.tenant_id::text = :'firma')
),
klucze AS (
  SELECT * FROM k WHERE length(nip) = 10 AND numer <> ''
),
grupy AS (
  SELECT tenant_id, nip, numer, rok, count(*) AS ile,
         count(*) FILTER (WHERE z_ksef) AS z_ksef,
         count(*) FILTER (WHERE NOT z_ksef) AS spoza,
         count(DISTINCT gross_amount) AS kwot
    FROM klucze
   GROUP BY tenant_id, nip, numer, rok
  HAVING count(*) > 1
),
kopie AS (
  SELECT DISTINCT a.tenant_id, a.nip, a.numer, a.rok
    FROM klucze AS a
    JOIN klucze AS b
      ON b.tenant_id = a.tenant_id AND b.nip = a.nip AND b.numer = a.numer AND b.rok = a.rok AND b.id > a.id
   WHERE NOT a.z_ksef AND NOT b.z_ksef
     AND CASE WHEN a.paragon OR b.paragon
              THEN a.issue_date = b.issue_date AND a.gross_amount = b.gross_amount
              ELSE a.gross_amount = b.gross_amount OR (a.kolumna IS NOT NULL AND a.kolumna = b.kolumna)
         END
),
g AS (
  SELECT gr.*,
         CASE
           WHEN gr.z_ksef > 0 AND gr.spoza > 0 THEN 'z KSeF i spoza KSeF'
           WHEN gr.spoza = 0 THEN 'same z KSeF'
           WHEN kp.tenant_id IS NOT NULL THEN 'kopie spoza KSeF'
           ELSE 'spoza KSeF, różne kwoty i kolumny'
         END AS wzor,
         ((gr.z_ksef > 0 AND gr.spoza > 0) OR kp.tenant_id IS NOT NULL) AS odmowa
    FROM grupy AS gr
    LEFT JOIN kopie AS kp USING (tenant_id, nip, numer, rok)
),
grupy_m AS (
  SELECT tenant_id, nip, numer, rok, miesiac,
         count(*) FILTER (WHERE z_ksef) AS z_ksef,
         count(*) FILTER (WHERE NOT z_ksef) AS spoza
    FROM klucze
   GROUP BY tenant_id, nip, numer, rok, miesiac
  HAVING count(*) > 1
),
kopie_m AS (
  SELECT DISTINCT a.tenant_id, a.nip, a.numer, a.rok, a.miesiac
    FROM klucze AS a
    JOIN klucze AS b
      ON b.tenant_id = a.tenant_id AND b.nip = a.nip AND b.numer = a.numer AND b.rok = a.rok AND b.miesiac = a.miesiac AND b.id > a.id
   WHERE NOT a.z_ksef AND NOT b.z_ksef
     AND CASE WHEN a.paragon OR b.paragon
              THEN a.issue_date = b.issue_date AND a.gross_amount = b.gross_amount
              ELSE a.gross_amount = b.gross_amount OR (a.kolumna IS NOT NULL AND a.kolumna = b.kolumna)
         END
),
miesiace AS (
  SELECT DISTINCT gm.tenant_id, gm.miesiac
    FROM grupy_m AS gm
    LEFT JOIN kopie_m AS km USING (tenant_id, nip, numer, rok, miesiac)
   WHERE (gm.z_ksef > 0 AND gm.spoza > 0) OR km.tenant_id IS NOT NULL
),
okresy AS (
  -- Okresy złożone: udany eksport KPiR albo JPK_V7M i przyjęta wysyłka JPK modułu na bramkę produkcyjną MF.
  SELECT ej.tenant_id, ej.period_start AS od, ej.period_end AS do_dnia
    FROM public.export_jobs AS ej
   WHERE ej.status = 'completed' AND ej.format::text IN ('kpir_excel', 'jpk_v7m')
  UNION
  SELECT js.tenant_id, js.okres, (js.okres + interval '1 month' - interval '1 day')::date
    FROM public.jpk_submissions AS js
   WHERE js.stan = 'przyjeta' AND js.srodowisko = 'produkcja'
),
zlozone AS (
  -- Co najmniej dwa koszty tej samej grupy z odmową w jednym złożonym okresie.
  SELECT DISTINCT kl.tenant_id
    FROM klucze AS kl
    JOIN g ON g.odmowa AND g.tenant_id = kl.tenant_id AND g.nip = kl.nip AND g.numer = kl.numer AND g.rok = kl.rok
    JOIN okresy AS o ON o.tenant_id = kl.tenant_id AND kl.issue_date BETWEEN o.od AND o.do_dnia
   GROUP BY kl.tenant_id, kl.nip, kl.numer, kl.rok, o.od, o.do_dnia
  HAVING count(*) > 1
)
SELECT co, ile FROM (
  SELECT 0 AS lp, 'koszty przeczytane (z „Uwzględnij w KPiR”, ze środowiska KSeF aplikacji)' AS co, count(*) AS ile FROM k
  UNION ALL SELECT 1, 'firmy z odmową', count(DISTINCT tenant_id) FROM g WHERE odmowa
  UNION ALL SELECT 2, 'grupy z odmową', count(*) FROM g WHERE odmowa
  UNION ALL SELECT 3, 'grupy z odmową: z KSeF i spoza KSeF', count(*) FROM g WHERE wzor = 'z KSeF i spoza KSeF'
  UNION ALL SELECT 4, 'grupy z odmową: kopie spoza KSeF', count(*) FROM g WHERE wzor = 'kopie spoza KSeF'
  UNION ALL SELECT 5, 'grupy z odmową i różną kwotą brutto (do sprawdzenia: mogą być fałszywą odmową)', count(*) FROM g WHERE odmowa AND kwot > 1
  UNION ALL SELECT 6, 'firmy z grupą do sprawdzenia', count(DISTINCT tenant_id) FROM g WHERE odmowa AND kwot > 1
  UNION ALL SELECT 7, 'grupy bez odmowy: same z KSeF', count(*) FROM g WHERE wzor = 'same z KSeF'
  UNION ALL SELECT 8, 'grupy bez odmowy: spoza KSeF, różne kwoty i kolumny', count(*) FROM g WHERE wzor = 'spoza KSeF, różne kwoty i kolumny'
  UNION ALL SELECT 9, 'firmy z odmową w okresie już złożonym (dwa koszty grupy w eksporcie KPiR albo JPK_V7M albo w przyjętej wysyłce JPK)', count(*) FROM zlozone
  UNION ALL SELECT 10, 'miesiące z odmową (oba koszty w tym samym miesiącu: raport KPiR, eksport i JPK_V7M za miesiąc)', count(*) FROM miesiace
  UNION ALL SELECT 11, 'firmy z odmową w co najmniej jednym miesiącu', count(DISTINCT tenant_id) FROM miesiace
) AS liczby
ORDER BY lp;

\echo '=== Pary źródeł w grupach (ksef, ocr_photo, manual, import)'

WITH k AS (
  SELECT e.id, e.tenant_id, e.issue_date, e.gross_amount, e.kpir_column::text AS kolumna,
         coalesce(e.document_type, 'invoice') AS rodzaj,
         (e.source = 'ksef_inbox' OR e.ksef_invoice_id IS NOT NULL) AS z_ksef,
         CASE WHEN e.source = 'ksef_inbox' OR e.ksef_invoice_id IS NOT NULL THEN 'ksef' ELSE e.source::text END AS zrodlo,
         (coalesce(e.document_type, 'invoice') IN ('receipt', 'simplified_invoice')
          OR (coalesce(e.document_type, 'invoice') = 'invoice'
              AND NOT (e.source = 'ksef_inbox' OR e.ksef_invoice_id IS NOT NULL)
              AND e.ocr_extracted_data ->> 'document_type' = 'simplified_invoice')) AS paragon,
         regexp_replace(coalesce(e.seller_nip, ''), '\D', '', 'g') AS nip,
         upper(regexp_replace(coalesce(e.document_number, ''), '[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]', '', 'g')) AS numer,
         extract(year FROM e.issue_date)::int AS rok,
         date_trunc('month', e.issue_date::timestamp)::date AS miesiac
    FROM public.expenses AS e
    LEFT JOIN public.invoices AS i ON i.id = e.ksef_invoice_id
   WHERE e.is_deductible
     AND (e.ksef_invoice_id IS NULL OR i.ksef_environment::text = :'srodowisko')
     AND (:'firma' = '' OR e.tenant_id::text = :'firma')
),
klucze AS (
  SELECT * FROM k WHERE length(nip) = 10 AND numer <> ''
),
grupy AS (
  SELECT tenant_id, nip, numer, rok,
         string_agg(zrodlo, '+' ORDER BY zrodlo) AS zrodla
    FROM klucze
   GROUP BY tenant_id, nip, numer, rok
  HAVING count(*) > 1
)
SELECT zrodla AS zrodla_w_grupie, count(*) AS grup, count(DISTINCT tenant_id) AS firm
  FROM grupy
 GROUP BY zrodla
 ORDER BY grup DESC, zrodla;

\if :lista
\echo '=== Firmy z odmową (id firmy, grupy z odmową, w tym do sprawdzenia, okres już złożony)'

WITH k AS (
  SELECT e.id, e.tenant_id, e.issue_date, e.gross_amount, e.kpir_column::text AS kolumna,
         coalesce(e.document_type, 'invoice') AS rodzaj,
         (e.source = 'ksef_inbox' OR e.ksef_invoice_id IS NOT NULL) AS z_ksef,
         CASE WHEN e.source = 'ksef_inbox' OR e.ksef_invoice_id IS NOT NULL THEN 'ksef' ELSE e.source::text END AS zrodlo,
         (coalesce(e.document_type, 'invoice') IN ('receipt', 'simplified_invoice')
          OR (coalesce(e.document_type, 'invoice') = 'invoice'
              AND NOT (e.source = 'ksef_inbox' OR e.ksef_invoice_id IS NOT NULL)
              AND e.ocr_extracted_data ->> 'document_type' = 'simplified_invoice')) AS paragon,
         regexp_replace(coalesce(e.seller_nip, ''), '\D', '', 'g') AS nip,
         upper(regexp_replace(coalesce(e.document_number, ''), '[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]', '', 'g')) AS numer,
         extract(year FROM e.issue_date)::int AS rok,
         date_trunc('month', e.issue_date::timestamp)::date AS miesiac
    FROM public.expenses AS e
    LEFT JOIN public.invoices AS i ON i.id = e.ksef_invoice_id
   WHERE e.is_deductible
     AND (e.ksef_invoice_id IS NULL OR i.ksef_environment::text = :'srodowisko')
     AND (:'firma' = '' OR e.tenant_id::text = :'firma')
),
klucze AS (
  SELECT * FROM k WHERE length(nip) = 10 AND numer <> ''
),
grupy AS (
  SELECT tenant_id, nip, numer, rok,
         count(*) FILTER (WHERE z_ksef) AS z_ksef,
         count(*) FILTER (WHERE NOT z_ksef) AS spoza,
         count(DISTINCT gross_amount) AS kwot
    FROM klucze
   GROUP BY tenant_id, nip, numer, rok
  HAVING count(*) > 1
),
kopie AS (
  SELECT DISTINCT a.tenant_id, a.nip, a.numer, a.rok
    FROM klucze AS a
    JOIN klucze AS b
      ON b.tenant_id = a.tenant_id AND b.nip = a.nip AND b.numer = a.numer AND b.rok = a.rok AND b.id > a.id
   WHERE NOT a.z_ksef AND NOT b.z_ksef
     AND CASE WHEN a.paragon OR b.paragon
              THEN a.issue_date = b.issue_date AND a.gross_amount = b.gross_amount
              ELSE a.gross_amount = b.gross_amount OR (a.kolumna IS NOT NULL AND a.kolumna = b.kolumna)
         END
),
g AS (
  SELECT gr.*, ((gr.z_ksef > 0 AND gr.spoza > 0) OR kp.tenant_id IS NOT NULL) AS odmowa
    FROM grupy AS gr
    LEFT JOIN kopie AS kp USING (tenant_id, nip, numer, rok)
),
okresy AS (
  SELECT ej.tenant_id, ej.period_start AS od, ej.period_end AS do_dnia
    FROM public.export_jobs AS ej
   WHERE ej.status = 'completed' AND ej.format::text IN ('kpir_excel', 'jpk_v7m')
  UNION
  SELECT js.tenant_id, js.okres, (js.okres + interval '1 month' - interval '1 day')::date
    FROM public.jpk_submissions AS js
   WHERE js.stan = 'przyjeta' AND js.srodowisko = 'produkcja'
),
zlozone AS (
  SELECT DISTINCT kl.tenant_id
    FROM klucze AS kl
    JOIN g ON g.odmowa AND g.tenant_id = kl.tenant_id AND g.nip = kl.nip AND g.numer = kl.numer AND g.rok = kl.rok
    JOIN okresy AS o ON o.tenant_id = kl.tenant_id AND kl.issue_date BETWEEN o.od AND o.do_dnia
   GROUP BY kl.tenant_id, kl.nip, kl.numer, kl.rok, o.od, o.do_dnia
  HAVING count(*) > 1
)
SELECT g.tenant_id AS firma, count(*) AS grup_z_odmowa,
       count(*) FILTER (WHERE g.kwot > 1) AS do_sprawdzenia,
       (z.tenant_id IS NOT NULL) AS okres_zlozony
  FROM g
  LEFT JOIN zlozone AS z ON z.tenant_id = g.tenant_id
 WHERE g.odmowa
 GROUP BY g.tenant_id, z.tenant_id
 ORDER BY okres_zlozony DESC, grup_z_odmowa DESC, g.tenant_id;
\endif

\if :szczegoly
\echo '=== Szczegóły grup firmy (NIP, numer, rok, wzór, odmowa, koszty: id, źródło, data, brutto, kolumna, rodzaj)'

WITH k AS (
  SELECT e.id, e.tenant_id, e.issue_date, e.gross_amount, e.kpir_column::text AS kolumna,
         coalesce(e.document_type, 'invoice') AS rodzaj,
         (e.source = 'ksef_inbox' OR e.ksef_invoice_id IS NOT NULL) AS z_ksef,
         CASE WHEN e.source = 'ksef_inbox' OR e.ksef_invoice_id IS NOT NULL THEN 'ksef' ELSE e.source::text END AS zrodlo,
         (coalesce(e.document_type, 'invoice') IN ('receipt', 'simplified_invoice')
          OR (coalesce(e.document_type, 'invoice') = 'invoice'
              AND NOT (e.source = 'ksef_inbox' OR e.ksef_invoice_id IS NOT NULL)
              AND e.ocr_extracted_data ->> 'document_type' = 'simplified_invoice')) AS paragon,
         regexp_replace(coalesce(e.seller_nip, ''), '\D', '', 'g') AS nip,
         upper(regexp_replace(coalesce(e.document_number, ''), '[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]', '', 'g')) AS numer,
         extract(year FROM e.issue_date)::int AS rok,
         date_trunc('month', e.issue_date::timestamp)::date AS miesiac
    FROM public.expenses AS e
    LEFT JOIN public.invoices AS i ON i.id = e.ksef_invoice_id
   WHERE e.is_deductible
     AND (e.ksef_invoice_id IS NULL OR i.ksef_environment::text = :'srodowisko')
     AND e.tenant_id::text = :'firma'
),
klucze AS (
  SELECT * FROM k WHERE length(nip) = 10 AND numer <> ''
),
grupy AS (
  SELECT tenant_id, nip, numer, rok,
         count(*) FILTER (WHERE z_ksef) AS z_ksef,
         count(*) FILTER (WHERE NOT z_ksef) AS spoza
    FROM klucze
   GROUP BY tenant_id, nip, numer, rok
  HAVING count(*) > 1
),
kopie AS (
  SELECT DISTINCT a.tenant_id, a.nip, a.numer, a.rok
    FROM klucze AS a
    JOIN klucze AS b
      ON b.tenant_id = a.tenant_id AND b.nip = a.nip AND b.numer = a.numer AND b.rok = a.rok AND b.id > a.id
   WHERE NOT a.z_ksef AND NOT b.z_ksef
     AND CASE WHEN a.paragon OR b.paragon
              THEN a.issue_date = b.issue_date AND a.gross_amount = b.gross_amount
              ELSE a.gross_amount = b.gross_amount OR (a.kolumna IS NOT NULL AND a.kolumna = b.kolumna)
         END
)
SELECT gr.nip, gr.numer, gr.rok,
       CASE
         WHEN gr.z_ksef > 0 AND gr.spoza > 0 THEN 'z KSeF i spoza KSeF'
         WHEN gr.spoza = 0 THEN 'same z KSeF'
         WHEN kp.tenant_id IS NOT NULL THEN 'kopie spoza KSeF'
         ELSE 'spoza KSeF, różne kwoty i kolumny'
       END AS wzor,
       ((gr.z_ksef > 0 AND gr.spoza > 0) OR kp.tenant_id IS NOT NULL) AS odmowa,
       string_agg(format('%s %s %s %s %s %s', kl.id, kl.zrodlo, kl.issue_date, kl.gross_amount, coalesce(kl.kolumna, '-'), kl.rodzaj),
                  ' ; ' ORDER BY kl.issue_date, kl.id) AS koszty
  FROM grupy AS gr
  LEFT JOIN kopie AS kp USING (tenant_id, nip, numer, rok)
  JOIN klucze AS kl ON kl.tenant_id = gr.tenant_id AND kl.nip = gr.nip AND kl.numer = gr.numer AND kl.rok = gr.rok
 GROUP BY gr.nip, gr.numer, gr.rok, gr.z_ksef, gr.spoza, kp.tenant_id
 ORDER BY gr.rok, gr.nip, gr.numer;
\endif

ROLLBACK;
