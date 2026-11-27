-- 00221_faktury_spoza_ksef.sql
-- KIEDY WGRAĆ: PRZED wdrożeniem (czysto addytywna; stary kod nie zna origin = 'outside_ksef' i go nie zapisuje).
--
-- Plan kompletnej aplikacji, krok 1.6 część 2b, PR A (decyzje D19-D25):
-- faktury wystawione w 2026 r. poza KSeF, dopisane przez klienta do historii.
-- Wpis liczy się w KPiR albo ewidencji przychodów, w JPK_V7M (BFK) i na Pulpicie,
-- ale FaktWay go nie wystawia i nie wysyła do KSeF. Ta migracja daje tylko bazę;
-- schemat Zod jest w lib/import/outside-ksef-schema.ts (#977), akcja i ekran
-- przyjdą w kolejnych PR za wyłącznikiem (domyślnie wyłączonym).
--
-- Co robi:
--  1. invoices_origin_check + 'outside_ksef' (zbiór zamknięty, jak w 00065).
--  2. invoices_outside_ksef_shape: dla origin = 'outside_ksef' wiersz ma jeden
--     dozwolony kształt: sprzedaż (outgoing), zwykła (regular), przyjęta
--     (accepted, bo tylko takie czytają KPiR, ewidencja i JPK), bez numeru KSeF,
--     bez pliku XML, bez śladów wysyłki i trybu offline, PLN, z numerem
--     dokumentu i ze środowiskiem KSeF (test, demo, production), bo księgi
--     filtrują po środowisku aplikacji.
--  3. invoices_outside_ksef_issue_date_2026 (D21): data wystawienia od
--     2026-01-01 do 2026-12-31. Wyjątki z art. 145m i 145n kończą się
--     31.12.2026; faktur z 2025 r. i starszych nie dopisujemy.
--  4. guard_outside_ksef_origin (wyzwalacz): środowisko wpisu musi być równe
--     środowisku firmy (tenants.ksef_verified_environment), gdy firma je ma;
--     pochodzenia 'outside_ksef' nie da się nadać ani zdjąć po zapisie
--     (zwykła faktura nie zmieni się w „poza KSeF” i odwrotnie).
--  5. ksef_upo_expected: dla 'outside_ksef' false (UPO nie istnieje).
--  6. ksef_lifecycle_violations: I3 pomija 'outside_ksef' (faktura bez numeru
--     KSeF i bez XML nie jest naruszeniem cyklu życia). Ciało znak w znak z 00156,
--     jedyna zmiana to warunek `i.origin <> 'outside_ksef'` w bloku I3.
--     ksef_lifecycle_violations_without_i3 (00186) bez zmian, bo nie ma I3.
--
-- Wyjście przy odmowie bazy (protokół, pkt 4): blokady z 2-4 widzi klient jako
-- komunikat akcji z nazwą dokumentu (akcja w kolejnym PR mapuje kody
-- OUTSIDE_KSEF_*); ścieżka operatora: poprawka wiersza przez service_role
-- z tą samą kontrolą.
--
-- Wycofanie: DROP TRIGGER trg_guard_outside_ksef_origin, DROP CONSTRAINT obu
-- CHECK i przywrócenie ciał funkcji z 00186 i 00156; wcześniej zero wierszy
-- z origin = 'outside_ksef' (SELECT count(*) FROM public.invoices WHERE
-- origin = 'outside_ksef').

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. Pochodzenie
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_origin_check;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_origin_check
  CHECK (origin IN ('app', 'ksef_import', 'ksef_inbox', 'file_import', 'ocr', 'outside_ksef'));

COMMENT ON COLUMN public.invoices.origin IS
  'Skąd wziął się dokument. Znacznik TRWAŁY — w odróżnieniu od notes, którego klient może dotknąć. Wszystko poza ''app'' jest wykluczone z oceny terminowości kontrahenta (K-03) i z kontroli ciągłości numeracji. ''outside_ksef'' (00221): faktura wystawiona w 2026 r. poza KSeF, dopisana przez klienta do historii; liczy się w księgach, nie ma numeru KSeF ani pliku XML.';

-- 2. Kształt wiersza
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_outside_ksef_shape;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_outside_ksef_shape
  CHECK (
    origin <> 'outside_ksef'
    OR (
      direction = 'outgoing'
      AND invoice_kind = 'regular'
      AND ksef_status = 'accepted'
      AND ksef_number IS NULL
      AND xml_storage_path IS NULL
      AND submitted_to_ksef_at IS NULL
      AND offline_qr_offline IS NULL
      AND offline_qr_certyfikat IS NULL
      AND offline_idempotency_key IS NULL
      AND currency = 'PLN'
      AND internal_number IS NOT NULL
      AND ksef_environment IN ('test', 'demo', 'production')
    )
  );

-- 3. Zakres dat (D21)
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_outside_ksef_issue_date_2026;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_outside_ksef_issue_date_2026
  CHECK (
    origin <> 'outside_ksef'
    OR issue_date BETWEEN DATE '2026-01-01' AND DATE '2026-12-31'
  );

-- 4. Środowisko firmy i niezmienność pochodzenia
CREATE OR REPLACE FUNCTION public.guard_outside_ksef_origin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_env text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.origin IS DISTINCT FROM OLD.origin
     AND (NEW.origin = 'outside_ksef' OR OLD.origin = 'outside_ksef') THEN
    RAISE EXCEPTION 'OUTSIDE_KSEF_ORIGIN_IMMUTABLE: pochodzenia faktury spoza KSeF nie da się nadać ani zdjąć po zapisie'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.origin = 'outside_ksef' THEN
    SELECT t.ksef_verified_environment INTO v_env
      FROM public.tenants t
     WHERE t.id = NEW.tenant_id;
    IF v_env IS NOT NULL AND NEW.ksef_environment IS DISTINCT FROM v_env THEN
      RAISE EXCEPTION 'OUTSIDE_KSEF_ENVIRONMENT: środowisko wpisu (%) różni się od środowiska KSeF firmy (%)',
        NEW.ksef_environment, v_env
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_outside_ksef_origin() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_outside_ksef_origin ON public.invoices;
CREATE TRIGGER trg_guard_outside_ksef_origin
  BEFORE INSERT OR UPDATE OF origin, ksef_environment, tenant_id ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.guard_outside_ksef_origin();

COMMENT ON FUNCTION public.guard_outside_ksef_origin() IS
  '00221: faktura spoza KSeF ma środowisko równe środowisku firmy (tenants.ksef_verified_environment), gdy firma je ma; pochodzenie outside_ksef jest niezmienne po zapisie.';

-- 5. UPO
CREATE OR REPLACE FUNCTION public.ksef_upo_expected(i public.invoices)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT CASE
    WHEN i.origin = 'outside_ksef' THEN false
    ELSE i.origin IS DISTINCT FROM 'ksef_import'
      OR public.ksef_upo_expected_submission(i.tenant_id, i.id, i.ksef_number)
  END
$$;
COMMENT ON FUNCTION public.ksef_upo_expected(public.invoices) IS
  'UPO istnieje tylko dla faktur wysłanych sesją FaktWay (00155, decyzja Bartosza 22.10.2026): true dla faktur spoza historii KSeF; dla origin = ksef_import tylko, gdy ksef_upo_expected_submission znajdzie wpis naszej wysyłki; dla origin = outside_ksef zawsze false (00221, nie było sesji KSeF). 00186: bez SET i bez podzapytania, więc planista wkleja ją w zapytanie (I3, upo-retry-stale, raport). Pole wyliczane PostgREST; EXECUTE tylko service_role.';

-- 6. Strażnik cyklu życia (00156, I3 bez outside_ksef)
CREATE OR REPLACE FUNCTION public.ksef_lifecycle_violations()
RETURNS TABLE (invariant text, invoice_id uuid, tenant_id uuid, detail jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- I1: queued > 15 min bez zlecenia w pg-boss.
  RETURN QUERY
    SELECT 'I1'::text, i.id, i.tenant_id,
           jsonb_build_object('updated_at', i.updated_at)
      FROM public.invoices i
     WHERE i.direction = 'outgoing'
       AND i.ksef_status = 'queued'
       AND i.updated_at < now() - interval '15 minutes'
       AND NOT EXISTS (
         SELECT 1 FROM pgboss.job j
          WHERE j.name = 'invoice.submit.requested'
            AND j.state IN ('created', 'retry', 'active')
            AND j.data->>'invoiceId' = i.id::text
       );

  -- I2: sending dłużej niż dzierżawa (15 min) + 15 min, albo bez znacznika przejęcia.
  RETURN QUERY
    SELECT 'I2'::text, i.id, i.tenant_id,
           jsonb_build_object('submitted_to_ksef_at', i.submitted_to_ksef_at, 'owner', i.ksef_send_owner)
      FROM public.invoices i
     WHERE i.direction = 'outgoing'
       AND i.ksef_status = 'sending'
       AND (i.submitted_to_ksef_at IS NULL OR i.submitted_to_ksef_at < now() - interval '30 minutes');

  -- I3: accepted bez numeru / środowiska / pliku XML albo bez wiersza UPO.
  -- 00155: brak UPO tylko, gdy UPO jest oczekiwane (ksef_upo_expected — faktury
  -- wysłane sesją FaktWay; historia z KSeF go nie ma, decyzja Bartosza 22.10.2026).
  RETURN QUERY
    SELECT 'I3'::text, i.id, i.tenant_id,
           jsonb_build_object(
             'ksef_number', i.ksef_number IS NOT NULL,
             'ksef_environment', i.ksef_environment,
             'xml_storage_path', i.xml_storage_path IS NOT NULL,
             'upo', EXISTS (SELECT 1 FROM public.upo_receipts u WHERE u.invoice_id = i.id)
           )
      FROM public.invoices i
     WHERE i.direction = 'outgoing'
       AND i.ksef_status = 'accepted'
       AND i.origin <> 'outside_ksef'
       AND (
         i.ksef_number IS NULL
         OR i.ksef_environment IS NULL
         OR i.xml_storage_path IS NULL
         OR (public.ksef_upo_expected(i) AND NOT EXISTS (SELECT 1 FROM public.upo_receipts u WHERE u.invoice_id = i.id))
       );

  -- I3K (00156): faktura zapisana z KSeF decyzją (zapis oryginału) bez sesji UPO
  -- albo bez daty nadania — trwały sygnał (T4, C6). Liczona od wpisów number_taken
  -- z decyzją importu (mało wierszy), nie od fa3_data wszystkich przyjętych faktur.
  -- Rzut identyfikatora tylko po sprawdzeniu wzorca (CASE). I3 K nie pokazuje:
  -- K ma zawsze wiersz upo_receipts (INV-18), a ksef_upo_expected(K) = true
  -- (sesja oryginału na K albo znacznik X z numerem K w ksef_submissions).
  RETURN QUERY
    SELECT 'I3K'::text, k.id, k.tenant_id,
           jsonb_build_object(
             'ksef_number', k.ksef_number,
             'no_session', NOT EXISTS (SELECT 1 FROM public.ksef_submissions s
                                        WHERE s.invoice_id = k.id AND s.tenant_id = k.tenant_id
                                          AND s.response_ksef_number = k.ksef_number
                                          AND s.session_reference_number IS NOT NULL),
             'no_date', k.ksef_accepted_at IS NULL,
             'upo_status', (SELECT u.status FROM public.upo_receipts u WHERE u.invoice_id = k.id))
      FROM public.invoices k
     WHERE k.id IN (SELECT CASE WHEN m.original_check->'decision'->>'importedInvoiceId'
                                     ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                THEN (m.original_check->'decision'->>'importedInvoiceId')::uuid END
                      FROM public.ksef_submissions m
                     WHERE m.status = 'number_taken'
                       AND m.original_check->'decision' ? 'importedInvoiceId')
       AND k.direction = 'outgoing'
       AND k.ksef_status = 'accepted'
       AND k.origin = 'ksef_import'
       AND (k.ksef_accepted_at IS NULL
            OR (NOT EXISTS (SELECT 1 FROM public.upo_receipts u
                             WHERE u.invoice_id = k.id AND u.status IN ('downloaded', 'archived'))
                AND NOT EXISTS (SELECT 1 FROM public.ksef_submissions s
                                 WHERE s.invoice_id = k.id AND s.tenant_id = k.tenant_id
                                   AND s.response_ksef_number = k.ksef_number
                                   AND s.session_reference_number IS NOT NULL)));

  -- I4: failed / rejected z kodem spoza katalogu albo z trzymanym przejęciem.
  RETURN QUERY
    SELECT 'I4'::text, i.id, i.tenant_id,
           jsonb_build_object('last_error_code', i.last_error_code, 'owner', i.ksef_send_owner)
      FROM public.invoices i
     WHERE i.direction = 'outgoing'
       AND i.ksef_status IN ('failed', 'rejected')
       AND (
         i.ksef_send_owner IS NOT NULL
         OR i.last_error_code IS NULL
         OR NOT EXISTS (SELECT 1 FROM public.ksef_error_codes c WHERE c.code = i.last_error_code)
       );

  -- I5: otwarty wpis `sent` albo zamiar `intent` starszy niż 48 h, a faktura nie jest w sending.
  -- 00148: bez faktur czekających na decyzję klienta (blokada decyzji NULL) — te są w I5D.
  -- 00156: bez przeglądu pliku (provenance-review — I5R; cron go nie uzgadnia, bez pętli);
  -- NULL <> … = NULL, więc I5D też wypada; recheck-needed zostaje w I5 (cron robi nową
  -- ocenę, INV-25).
  RETURN QUERY
    SELECT 'I5'::text, s.invoice_id, s.tenant_id,
           jsonb_build_object('attempted_at', s.attempted_at, 'session', s.session_reference_number,
                              'ksef_status', i.ksef_status, 'submission_status', s.status)
      FROM public.ksef_submissions s
      JOIN public.invoices i ON i.id = s.invoice_id
     WHERE s.status IN ('sent', 'intent')
       AND s.attempted_at < now() - interval '48 hours'
       AND i.ksef_status <> 'sending'
       AND public.ksef_duplicate_decision_blocker(s.invoice_id, s.tenant_id) <> 'provenance-review';  -- 00156: NULL (czeka na klienta) = I5D, przegląd = I5R

  -- I5D (00148): faktura czeka na decyzję klienta — nierozstrzygnięty 440 z kompletnymi
  -- danymi oryginału (blokada decyzji = NULL). I5R (00156): poprawna brama review —
  -- przegląd pliku z oznaczeniem FaktWay przez operatora (blokada provenance-review).
  -- Osobno od I5: cron żadnej z nich nie uzgadnia; alarm krytyczny I5D nie liczy
  -- (chyba że środowisko się nie zgadza), I5R po 72 h; raport — osobne wiersze.
  -- Jedno zapytanie, blokada liczona raz na fakturę (OFFSET 0 w podzapytaniu
  -- bocznym: bez niego planista wkleja wywołanie STABLE w CASE i WHERE).
  RETURN QUERY
    SELECT CASE WHEN b.code IS NULL THEN 'I5D' ELSE 'I5R' END, i.id, i.tenant_id,
           jsonb_build_object(
             'original_ksef_number', m.original_ksef_number,
             'reason', m.original_check->>'reason',
             'env', m.original_check->>'env',
             'checked_at', m.original_check->>'checkedAt',
             'attempted_at', m.attempted_at,
             'last_attempt_at', i.last_attempt_at,
             'problems', m.original_check->'importGate'->'problems')
      FROM public.invoices i
      CROSS JOIN LATERAL (
        SELECT s.original_ksef_number, s.original_check, s.attempted_at
          FROM public.ksef_submissions s
         WHERE s.invoice_id = i.id AND s.tenant_id = i.tenant_id
           AND s.status IN ('intent', 'sent') AND s.original_ksef_number IS NOT NULL
         ORDER BY s.attempted_at DESC NULLS LAST, s.id
         LIMIT 1) m
      CROSS JOIN LATERAL (
        SELECT public.ksef_duplicate_decision_blocker(i.id, i.tenant_id) AS code
        OFFSET 0) b
     WHERE i.direction = 'outgoing'
       AND i.ksef_status = 'failed'
       AND i.last_error_code = 'KSEF_DUPLICATE_RECONCILE'
       AND (b.code IS NULL OR b.code = 'provenance-review');

  -- I9: failed / rejected z numerem KSeF — stan sprzeczny, nic automatycznie.
  RETURN QUERY
    SELECT 'I9'::text, i.id, i.tenant_id,
           jsonb_build_object('ksef_number', i.ksef_number)
      FROM public.invoices i
     WHERE i.direction = 'outgoing'
       AND i.ksef_status IN ('failed', 'rejected')
       AND i.ksef_number IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.ksef_lifecycle_violations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ksef_lifecycle_violations() TO service_role;
COMMENT ON FUNCTION public.ksef_lifecycle_violations() IS
  'Naruszenia inwariantów cyklu życia faktury I1–I5, I9 (docs/architecture/cykl-zycia-faktury-ksef.md) oraz: I3 — brak UPO tylko, gdy ksef_upo_expected (00155), bez faktur spoza KSeF (00221); I5 także faktflow-original bez oceny pliku albo z recheckNeeded (cron robi nową ocenę), bez faktur czekających na klienta i bez przeglądu pliku; I5D — faktura czeka na decyzję klienta przy nierozstrzygniętym 440 (00148; nie alarm krytyczny, w raporcie osobno); I5R — przegląd pliku z oznaczeniem FaktWay przez operatora (00156); I3K — faktura zapisana z KSeF decyzją bez sesji UPO albo bez daty nadania (00156). I6–I8 realizuje cron i indeks unikalny numeru.';


NOTIFY pgrst, 'reload schema';

COMMIT;
