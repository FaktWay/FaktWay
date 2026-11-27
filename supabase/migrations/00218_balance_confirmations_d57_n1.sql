-- ═══════════════════════════════════════════════════════════════
-- 00218: potwierdzenie salda, warstwa bazy po przeglądzie (plan kompletnej
-- aplikacji, krok 2.9, część 2; decyzja D57 w docs/koordynacja/DECYZJE-2026-11-25.md
-- i uwaga N1 drugiego czytelnika PR #958).
--
-- KIEDY WGRAĆ: PRZED wdrożeniem. Addytywna: dwa powody pominięcia w liście
-- pominiętych (nowa definicja dwóch funkcji z 00216 przez CREATE OR REPLACE,
-- ta sama sygnatura) i jeden wyzwalacz BEFORE DELETE. Bez DROP tabel i kolumn,
-- bez TRUNCATE, bez zmiany istniejących danych. Kod aplikacji, który zna nowe
-- powody, jest za wyłącznikiem balanceConfirmationsEnabled (domyślnie wyłączony).
--
-- 1. N1: wystawionego potwierdzenia salda nie da się usunąć. Usunięcie
--    zostawia dziurę w serii PS/n/rok (numer nie wraca), a dokument mógł już
--    pójść do kontrahenta. Wyzwalacz a_guard_balance_confirmation_delete
--    odrzuca DELETE także dla service_role i właściciela bazy. Wolne jest
--    tylko kasowanie kaskadowe przy usunięciu firmy (RODO; pg_trigger_depth()
--    > 1) i sesja operatora z flagą app.allow_balance_confirmation_delete = 'on'
--    (SET LOCAL w transakcji; PostgREST jej nie ustawi). Błędny dokument
--    poprawia się nowym; usunięcie to decyzja Bartosza (runbook
--    docs/runbooks/potwierdzenie-salda.md).
-- 2. D57: dwa nowe powody pominięcia faktury w liniach potwierdzenia:
--      advance_settled      zaliczka z resztą do zapłaty, którą odjęła faktura
--                           rozliczająca przyjęta w KSeF (wpłaty zwykle nie
--                           oznaczono; dziś nie trafiała ani do salda, ani na listę);
--      awaiting_ksef_number faktura w kolejce, w wysyłce albo z trybu offline
--                           (queued, sending, offline_queued): jeszcze bez numeru KSeF.
--    Zostają bez zmian: corrected, correction_due, advance_settlement,
--    imported, foreign_currency. Saldo (pozycje) liczy się jak dotąd: tylko
--    faktury przyjęte w KSeF.
-- ═══════════════════════════════════════════════════════════════


-- ─── wyzwalacz: wystawionego dokumentu nie usuwa nikt (N1) ──────
CREATE OR REPLACE FUNCTION public.guard_balance_confirmation_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  -- Kasowanie kaskadowe z usuwanej firmy (RODO): wyzwalacz kluczy obcych to poziom 1, ten 2.
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  IF current_setting('app.allow_balance_confirmation_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Balance confirmation % cannot be deleted; issue a new balance confirmation instead', OLD.number
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_balance_confirmation_delete() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_guard_balance_confirmation_delete ON public.balance_confirmations;
CREATE TRIGGER a_guard_balance_confirmation_delete
  BEFORE DELETE ON public.balance_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.guard_balance_confirmation_delete();

COMMENT ON FUNCTION public.guard_balance_confirmation_delete() IS
  '00218: wystawionego potwierdzenia salda nie usuwa nikt (dziura w serii PS); wolne tylko kasowanie kaskadowe z firmy i sesja operatora z app.allow_balance_confirmation_delete = on.';

CREATE OR REPLACE FUNCTION public.balance_confirmation_omitted_valid(p_omitted jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_omitted) IS DISTINCT FROM 'array' THEN false
    WHEN jsonb_array_length(p_omitted) > 5000 THEN false
    ELSE NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_omitted) AS e(item)
       WHERE CASE
         WHEN jsonb_typeof(e.item) IS DISTINCT FROM 'object' THEN true
         WHEN (SELECT count(*) FROM jsonb_object_keys(e.item)) <> 9 THEN true
         WHEN NOT (e.item ?& ARRAY['invoiceId', 'number', 'ksefNumber', 'issueDate', 'kind', 'type', 'currency',
                                   'gross', 'reason']) THEN true
         WHEN jsonb_typeof(e.item -> 'invoiceId') IS DISTINCT FROM 'string'
           OR (e.item ->> 'invoiceId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN true
         WHEN jsonb_typeof(e.item -> 'number') IS DISTINCT FROM 'string'
           OR char_length(btrim(e.item ->> 'number')) NOT BETWEEN 1 AND 256 THEN true
         WHEN jsonb_typeof(e.item -> 'ksefNumber') NOT IN ('string', 'null') THEN true
         WHEN jsonb_typeof(e.item -> 'issueDate') IS DISTINCT FROM 'string'
           OR (e.item ->> 'issueDate') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN true
         WHEN NOT COALESCE(e.item ->> 'kind' IN ('regular', 'correction', 'advance', 'final'), false) THEN true
         WHEN jsonb_typeof(e.item -> 'type') NOT IN ('string', 'null') THEN true
         WHEN jsonb_typeof(e.item -> 'currency') NOT IN ('string', 'null') THEN true
         WHEN jsonb_typeof(e.item -> 'currency') = 'string' AND char_length(e.item ->> 'currency') > 16 THEN true
         WHEN jsonb_typeof(e.item -> 'gross') IS DISTINCT FROM 'number' THEN true
         WHEN (e.item ->> 'gross')::numeric <= 0
           OR (e.item ->> 'gross')::numeric > 1000000000
           OR (e.item ->> 'gross')::numeric <> round((e.item ->> 'gross')::numeric, 2) THEN true
         WHEN NOT COALESCE(e.item ->> 'reason' IN ('corrected', 'correction_due', 'advance_settlement', 'imported',
                                                    'foreign_currency', 'advance_settled', 'awaiting_ksef_number'), false) THEN true
         ELSE false
       END
    )
  END;
$$;

COMMENT ON FUNCTION public.balance_confirmation_omitted_valid(jsonb) IS
  '00218: faktury pominięte w potwierdzeniu salda: do 5000 {invoiceId, number, ksefNumber, issueDate, kind, type, currency, gross, reason} z powodem corrected, correction_due, advance_settlement, advance_settled, awaiting_ksef_number, imported albo foreign_currency.';

CREATE OR REPLACE FUNCTION public.balance_confirmation_lines(
  p_tenant_id uuid,
  p_nip text,
  p_ksef_environment text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH korekty AS (
    -- Faktury tej firmy, do których jest korekta, w każdym statusie i kierunku (loadTenantChildIds).
    SELECT DISTINCT c.parent_invoice_id AS invoice_id
      FROM public.invoices AS c
     WHERE c.tenant_id = p_tenant_id
       AND c.parent_invoice_id IS NOT NULL
  ),
  rozliczenia AS (
    -- Zaliczki wskazane przez fakturę rozliczającą tej firmy (ROZ w każdym statusie)
    -- i czy któraś z tych ROZ jest przyjęta w KSeF w środowisku aplikacji.
    SELECT z.invoice_id,
           bool_or(COALESCE(c.ksef_status = 'accepted' AND c.ksef_environment = p_ksef_environment, false)) AS w_ksef
      FROM public.invoices AS c
     CROSS JOIN LATERAL unnest(c.advance_invoice_ids) AS z(invoice_id)
     WHERE c.tenant_id = p_tenant_id
       AND cardinality(c.advance_invoice_ids) > 0
     GROUP BY z.invoice_id
  ),
  faktury AS (
    SELECT i.id,
           i.origin,
           i.invoice_kind,
           i.invoice_type,
           i.currency,
           i.issue_date,
           i.payment_due_date,
           i.ksef_status,
           i.gross_total,
           i.paid_amount,
           COALESCE(NULLIF(btrim(i.internal_number), ''), NULLIF(btrim(i.ksef_number), ''), 'bez numeru') AS numer,
           NULLIF(btrim(i.ksef_number), '') AS numer_ksef,
           (
             (i.invoice_kind = 'regular' AND i.invoice_type IN ('VAT', 'UPR'))
             OR (i.invoice_kind = 'advance' AND i.invoice_type = 'ZAL')
             OR (i.invoice_kind = 'final' AND i.invoice_type = 'ROZ')
           ) AS rodzaj_naleznosci,
           -- Faktura do paragonu jest zapłacona przy kasie (isReceiptInvoiceColumns): każdy zapis paragonu
           -- albo Fa/FP = 1 z importu KSeF.
           (
             ((i.fa3_data -> 'receipt') IS NOT NULL AND jsonb_typeof(i.fa3_data -> 'receipt') <> 'null')
             OR COALESCE((i.fa3_data -> 'ksefMarkers' ->> 'fp') = 'true', false)
           ) AS paragon,
           -- Data zapłaty z FA(3) zapisana przy imporcie (settledFilterOps).
           (i.fa3_data -> 'parsed' ->> 'paidDate') IS NOT NULL AS zaplacona_wg_fa3,
           CASE
             WHEN i.invoice_kind = 'final'
                  AND i.gross_total IS NOT NULL
                  AND (i.payment_data ->> 'amountDue') ~ '^[0-9]+(\.[0-9]+)?$'
             THEN LEAST((i.payment_data ->> 'amountDue')::numeric, i.gross_total)
             ELSE i.gross_total
           END AS do_zaplaty,
           k.invoice_id IS NOT NULL AS ma_korekte,
           r.invoice_id IS NOT NULL AS ma_rozliczenie,
           COALESCE(r.w_ksef, false) AS rozliczenie_w_ksef
      FROM public.invoices AS i
      LEFT JOIN korekty AS k ON k.invoice_id = i.id
      LEFT JOIN rozliczenia AS r ON r.invoice_id = i.id
     WHERE i.tenant_id = p_tenant_id
       AND i.direction = 'outgoing'
       AND (
         (i.ksef_status = 'accepted' AND i.ksef_environment = p_ksef_environment)
         -- D57: faktura czeka na numer KSeF; środowisko zapisuje dopiero przyjęcie (save-accepted),
         -- więc przed nim jest puste.
         OR (i.ksef_status IN ('queued', 'sending', 'offline_queued')
             AND (i.ksef_environment IS NULL OR i.ksef_environment = p_ksef_environment))
       )
       AND i.payment_status IN ('unpaid', 'partial', 'overdue')
       AND i.gross_total > 0
       AND i.paid_amount >= 0
       AND public.balance_confirmation_buyer_nip(i.buyer_nip, i.buyer_data) = p_nip
  ),
  policzone AS (
    SELECT f.*,
           round(f.do_zaplaty, 2) AS kwota_do_zaplaty,
           GREATEST(round(f.do_zaplaty - f.paid_amount, 2), 0) AS reszta
      FROM faktury AS f
  ),
  sklasyfikowane AS (
    SELECT p.*,
           CASE
             WHEN p.paragon OR p.reszta <= 0 THEN NULL
             WHEN p.origin IS DISTINCT FROM 'app' THEN CASE WHEN NOT p.zaplacona_wg_fa3 THEN 'imported' END
             WHEN p.ksef_status IN ('queued', 'sending', 'offline_queued') THEN
               CASE WHEN p.rodzaj_naleznosci OR p.invoice_kind = 'correction' THEN 'awaiting_ksef_number' END
             WHEN p.invoice_kind = 'correction' THEN 'correction_due'
             WHEN NOT COALESCE(p.rodzaj_naleznosci, false) THEN NULL
             WHEN p.ma_korekte THEN 'corrected'
             WHEN p.ma_rozliczenie THEN CASE WHEN p.rozliczenie_w_ksef THEN 'advance_settled' ELSE 'advance_settlement' END
             WHEN p.currency IS NOT NULL AND p.currency <> 'PLN' THEN 'foreign_currency'
             ELSE 'item'
           END AS klasa
      FROM policzone AS p
  )
  SELECT jsonb_build_object(
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'invoiceId', s.id,
               'number', s.numer,
               'ksefNumber', s.numer_ksef,
               'issueDate', s.issue_date,
               'dueDate', s.payment_due_date,
               'kind', s.invoice_kind,
               'type', s.invoice_type,
               'gross', round(s.gross_total, 2),
               'amountDue', s.kwota_do_zaplaty,
               'paid', round(s.paid_amount, 2),
               'outstanding', s.reszta
             ) ORDER BY s.issue_date, s.numer, s.id)
        FROM sklasyfikowane AS s
       WHERE s.klasa = 'item'
    ), '[]'::jsonb),
    'omitted', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'invoiceId', s.id,
               'number', s.numer,
               'ksefNumber', s.numer_ksef,
               'issueDate', s.issue_date,
               'kind', s.invoice_kind,
               'type', s.invoice_type,
               'currency', s.currency,
               'gross', round(s.gross_total, 2),
               'reason', s.klasa
             ) ORDER BY s.issue_date, s.numer, s.id)
        FROM sklasyfikowane AS s
       WHERE s.klasa IS NOT NULL
         AND s.klasa <> 'item'
    ), '[]'::jsonb)
  );
$$;

COMMENT ON FUNCTION public.balance_confirmation_lines(uuid, text, text) IS
  '00218: pozycje (należności jak getReceivables, tylko faktury przyjęte w KSeF) i pominięte faktury jednej firmy dla jednego NIP nabywcy, z powodami z D57; tylko wewnątrz funkcji SECURITY DEFINER.';
