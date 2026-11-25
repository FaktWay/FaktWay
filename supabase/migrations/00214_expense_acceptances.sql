-- ═══════════════════════════════════════════════════════════════
-- 00214: akceptacja kosztu przez księgową (plan
-- docs/koordynacja/PLAN-KOMPLETNA-APLIKACJA.md, krok 6.2, część 5a)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem, po 00197 (rozszerza listę rodzajów
-- app_notifications z 00197). Nowa tabela, trzy funkcje i zmiana jednego
-- CHECK-a; bez DROP tabel i kolumn, bez zmiany istniejących danych. Bez tej
-- migracji sekcja „Akceptacja księgowej” na ekranie kosztu pokazuje „Nie udało
-- się wczytać akceptacji kosztu” ze „Spróbuj ponownie”, a reszta ekranu kosztu
-- działa bez zmian.
--
-- ZMIANA CHECK: app_notifications_kind_check z 00197 dostaje rodzaj
-- expense_needs_changes (księgowa oznaczyła koszt „Do poprawy”). DROP
-- CONSTRAINT IF EXISTS i ADD CONSTRAINT z tą samą nazwą i pełną listą: siedem
-- rodzajów z 00197 bez zmian plus jeden nowy. Istniejące wiersze mają rodzaje
-- z 00197, więc spełniają nowy warunek (sprawdzenie przy ADD CONSTRAINT niczego
-- nie odrzuci; krótka blokada app_notifications na czas przejścia po
-- wierszach). Kto dopisze kolejny rodzaj, bierze pełną listę z tej migracji
-- (pilnuje tego test koszt-watek-migracja).
--
-- 1. expense_acceptances: ostatnia decyzja księgowej przy koszcie (jeden
--    wiersz na koszt): accepted („Zaakceptowany”) albo needs_changes („Do
--    poprawy”, z powodem 1-2000 znaków, nie same białe znaki). Decyzja dotyczy
--    treści kosztu z chwili decyzji: odcisku pól księgowych
--    (expense_acceptance_fingerprint). Zmiana któregoś z nich daje stan
--    nieaktualny („Zmieniony po akceptacji”), a zmiana płatności, notatki albo
--    daty zapisu nie (updated_at zmienia każdy UPDATE, dlatego odcisk, nie
--    data). Przegląd kosztu przez firmę (is_reviewed) też nie: pola, które
--    przegląd zmienia, są w odcisku. Historia decyzji jest w audit_logs. Akceptacja nie zmienia kosztu,
--    KPiR, VAT ani raportów: żaden z nich jej nie czyta. Wiersz znika razem
--    z kosztem albo firmą (ON DELETE CASCADE), a po usunięciu konta zostaje bez
--    osoby (SET NULL).
--
-- 2. Kto: decyzję zapisuje tylko aktywny członek aktywnej firmy z rolą
--    accountant (rola z memberships, osoba z auth.uid(), nigdy z argumentów).
--    Pozostałe role firmy (owner, admin, member) dostają odmowę role, a ktoś
--    spoza firmy albo zawieszony 42501. Stan widzą ci, którzy widzą koszt
--    (ten sam warunek co wątek z 00192). Klucz użytkownika ma na tabeli tylko
--    SELECT; zapis wyłącznie przez expense_acceptance_decide.
--
-- 3. expense_acceptance_decide(): decyzja dla odcisku, który widziała księgowa
--    (p_fingerprint z expense_acceptance_state). Inny odcisk to odmowa changed
--    (koszt zmienił się od otwarcia strony). Blokada wiersza kosztu: edycja
--    w tej samej chwili idzie po kolei. Ta sama decyzja, odcisk i powód drugi
--    raz zwraca exists bez audytu i dzwonka. „Do poprawy” dopisuje wpis
--    w dzwonku pozostałych aktywnych członków (bez autora decyzji; inna
--    księgowa tej firmy też go dostaje) z linkiem do
--    sekcji akceptacji; klucz obiektu to nowy identyfikator decyzji, więc
--    kolejne „Do poprawy” to kolejne wpisy, a wiersz, audyt i dzwonek zapisują
--    się w jednej transakcji. Każda zapisana decyzja ma wiersz audit_logs
--    (expense.accepted, expense.needs_changes) z rolą i odciskiem, bez treści
--    powodu. Tytuł, treść i link wpisu w dzwonku buduje baza z danych kosztu
--    i osoby, nie z argumentów.
--
-- 4. expense_acceptance_state(): SECURITY INVOKER, więc z RLS czytającego:
--    NULL, gdy kosztu nie widzi; inaczej odcisk bieżącej treści, ostatnia
--    decyzja i czy dotyczy bieżącej treści (is_current).
--
-- audit_logs: ip_address i user_agent zostają puste jak w 00158 i 00192 (baza
-- nie zna adresu klienta).
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.app_notifications
  DROP CONSTRAINT IF EXISTS app_notifications_kind_check,
  ADD CONSTRAINT app_notifications_kind_check CHECK (kind IN ('inbox_new', 'invoice_accepted', 'invoice_rejected', 'tax_deadline', 'expense_comment', 'expense_document_request', 'payment_received', 'expense_needs_changes'));

CREATE TABLE IF NOT EXISTS public.expense_acceptances (
  expense_id UUID PRIMARY KEY REFERENCES public.expenses(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  decision TEXT NOT NULL,
  reason TEXT,
  -- md5 pól księgowych kosztu z chwili decyzji (expense_acceptance_fingerprint).
  fingerprint TEXT NOT NULL,
  decided_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT expense_acceptances_decision_check CHECK (decision IN ('accepted', 'needs_changes')),
  CONSTRAINT expense_acceptances_reason_check CHECK (
    (decision = 'accepted' AND reason IS NULL)
    OR (decision = 'needs_changes' AND reason IS NOT NULL AND char_length(reason) BETWEEN 1 AND 2000 AND reason ~ '[^[:space:]]')
  ),
  CONSTRAINT expense_acceptances_fingerprint_check CHECK (fingerprint ~ '^[0-9a-f]{32}$')
);

COMMENT ON TABLE public.expense_acceptances IS
  'Akceptacja kosztu przez księgową (krok 6.2 planu kompletnej aplikacji, część 5a): ostatnia decyzja accepted albo needs_changes z odciskiem treści kosztu. Zapis tylko przez expense_acceptance_decide (00214); nie wpływa na KPiR, VAT ani raporty.';

-- Sprzątanie i odczyt po firmie.
CREATE INDEX IF NOT EXISTS expense_acceptances_tenant_idx
  ON public.expense_acceptances (tenant_id);

ALTER TABLE public.expense_acceptances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "expense_acceptances_select_cost_readers" ON public.expense_acceptances;
CREATE POLICY "expense_acceptances_select_cost_readers" ON public.expense_acceptances
  FOR SELECT TO authenticated
  USING (
    tenant_id = public.get_current_tenant_id()
    AND EXISTS (
      SELECT 1
        FROM public.expenses AS e
       WHERE e.id = expense_acceptances.expense_id
         AND e.tenant_id = expense_acceptances.tenant_id
    )
  );

REVOKE ALL ON public.expense_acceptances FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.expense_acceptances TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.expense_acceptances TO service_role;

-- ─── Odcisk treści kosztu: pola, które idą do ksiąg i ewidencji ───
-- Rodzaj i numer dokumentu, data, sprzedawca (nazwa, NIP, adres), kwoty,
-- stawka, VAT do odliczenia, odliczenie tak albo nie, kolumna KPiR, kategoria
-- (opis w KPiR), plik dokumentu, faktura KSeF, pochodzenie kosztu i dane
-- z odczytu (z nich lib/exports/data-fetcher.ts bierze rodzaj dokumentu w KPiR
-- i JPK oraz kurs i potwierdzenie kwot w złotych). Bez płatności, notatki, dat
-- zapisu i przeglądu firmy (is_reviewed): ich zmiana nie unieważnia akceptacji.
CREATE OR REPLACE FUNCTION public.expense_acceptance_fingerprint(p_expense public.expenses)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT md5(jsonb_build_array(
    p_expense.document_type,
    p_expense.document_number,
    p_expense.issue_date,
    p_expense.seller_name,
    p_expense.seller_nip,
    p_expense.seller_address,
    p_expense.net_amount,
    p_expense.vat_amount,
    p_expense.gross_amount,
    p_expense.vat_rate,
    p_expense.vat_deductible_amount,
    p_expense.is_deductible,
    p_expense.kpir_column,
    p_expense.category_label,
    p_expense.source_file_path,
    p_expense.ksef_invoice_id,
    p_expense.source,
    p_expense.ocr_extracted_data
  )::text);
$$;

COMMENT ON FUNCTION public.expense_acceptance_fingerprint(public.expenses) IS
  'Akceptacja kosztu (00214): md5 pól księgowych kosztu (z pochodzeniem i danymi z odczytu); bez płatności, notatki, dat zapisu i przeglądu firmy.';

REVOKE ALL ON FUNCTION public.expense_acceptance_fingerprint(public.expenses) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.expense_acceptance_fingerprint(public.expenses) TO authenticated, service_role;

-- ─── Decyzja księgowej ───
-- Zwraca status: decided, exists (ta sama decyzja dla tej samej treści) albo
-- refused z kodem (role, invalid_decision, empty_reason, reason_too_long,
-- not_found, changed).
CREATE OR REPLACE FUNCTION public.expense_acceptance_decide(
  p_expense_id UUID,
  p_decision TEXT,
  p_reason TEXT,
  p_fingerprint TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_tenant UUID;
  v_role TEXT;
  v_expense public.expenses%ROWTYPE;
  v_fingerprint TEXT;
  v_reason TEXT;
  v_existing public.expense_acceptances%ROWTYPE;
  v_decided_at TIMESTAMPTZ;
  v_key UUID := gen_random_uuid();
  v_name TEXT;
  v_label TEXT;
  v_excerpt TEXT;
  v_notified INTEGER := 0;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Expense acceptance requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant := public.get_current_tenant_id();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  SELECT m.role INTO v_role
    FROM public.memberships AS m
   WHERE m.organization_id = v_tenant
     AND m.user_id = v_user
     AND m.status = 'active'
     AND m.role IN ('owner', 'admin', 'member', 'accountant');
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Insufficient role for expense acceptance' USING ERRCODE = '42501';
  END IF;
  IF v_role <> 'accountant' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'role');
  END IF;

  IF p_decision IS NULL OR p_decision NOT IN ('accepted', 'needs_changes') THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_decision');
  END IF;
  -- Powód tylko przy „Do poprawy”; przy akceptacji zostaje NULL.
  IF p_decision = 'needs_changes' THEN
    -- Białe znaki z obu końców (spacje, tabulatory, nowe linie); w środku zostają.
    v_reason := regexp_replace(COALESCE(p_reason, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g');
    IF v_reason = '' THEN
      RETURN jsonb_build_object('status', 'refused', 'code', 'empty_reason');
    END IF;
    IF char_length(v_reason) > 2000 THEN
      RETURN jsonb_build_object('status', 'refused', 'code', 'reason_too_long');
    END IF;
  END IF;

  -- Koszt aktywnej firmy: ten sam warunek co expenses_select_own_tenant (00034).
  -- Koszt innej firmy wygląda jak brak kosztu. Blokada wiersza: edycja kosztu
  -- w tej samej chwili czeka na koniec decyzji albo decyzja na koniec edycji.
  SELECT e.* INTO v_expense
    FROM public.expenses AS e
   WHERE e.id = p_expense_id
     AND e.tenant_id = v_tenant
   FOR UPDATE OF e;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_found');
  END IF;

  v_fingerprint := public.expense_acceptance_fingerprint(v_expense);
  IF p_fingerprint IS NULL OR p_fingerprint <> v_fingerprint THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'changed', 'expense_id', p_expense_id);
  END IF;

  SELECT a.* INTO v_existing
    FROM public.expense_acceptances AS a
   WHERE a.expense_id = p_expense_id
   FOR UPDATE OF a;
  IF FOUND
     AND v_existing.decision = p_decision
     AND v_existing.fingerprint = v_fingerprint
     AND v_existing.reason IS NOT DISTINCT FROM v_reason
  THEN
    RETURN jsonb_build_object(
      'status', 'exists', 'expense_id', p_expense_id, 'decision', p_decision,
      'decided_at', v_existing.decided_at, 'notified', 0
    );
  END IF;

  INSERT INTO public.expense_acceptances (expense_id, tenant_id, decision, reason, fingerprint, decided_by, decided_at)
  VALUES (p_expense_id, v_tenant, p_decision, v_reason, v_fingerprint, v_user, now())
  ON CONFLICT (expense_id) DO UPDATE
     SET tenant_id = EXCLUDED.tenant_id,
         decision = EXCLUDED.decision,
         reason = EXCLUDED.reason,
         fingerprint = EXCLUDED.fingerprint,
         decided_by = EXCLUDED.decided_by,
         decided_at = EXCLUDED.decided_at
  RETURNING decided_at INTO v_decided_at;

  IF p_decision = 'needs_changes' THEN
    -- Sprzedawca bez nazwy w metadanych KSeF ma w koszcie „Nieznany” (auto-categorize-inbox).
    v_label := COALESCE(left(NULLIF(btrim(v_expense.document_number), ''), 60), 'bez numeru')
      || CASE
           WHEN NULLIF(btrim(v_expense.seller_name), '') IS NULL OR btrim(v_expense.seller_name) = 'Nieznany' THEN ''
           ELSE ' od ' || left(btrim(v_expense.seller_name), 120)
         END;
    SELECT NULLIF(btrim(u.name), '') INTO v_name FROM public.users AS u WHERE u.id = v_user;
    v_excerpt := regexp_replace(v_reason, '[[:space:]]+', ' ', 'g');
    IF char_length(v_excerpt) > 140 THEN
      v_excerpt := left(v_excerpt, 139) || '…';
    END IF;

    INSERT INTO public.app_notifications (tenant_id, user_id, kind, object_key, title, body, link)
    SELECT v_tenant,
           m.user_id,
           'expense_needs_changes',
           v_key::text,
           'Koszt do poprawy',
           COALESCE(left(v_name, 80) || ' (księgowy)', 'Księgowy') || ' prosi o poprawę kosztu ' || v_label || ': ' || v_excerpt,
           '/expenses/' || p_expense_id::text || '#akceptacja'
      FROM public.memberships AS m
     WHERE m.organization_id = v_tenant
       AND m.status = 'active'
       AND m.role IN ('owner', 'admin', 'member', 'accountant')
       AND m.user_id <> v_user
    ON CONFLICT ON CONSTRAINT app_notifications_klucz_unikalny DO NOTHING;
    GET DIAGNOSTICS v_notified = ROW_COUNT;
  END IF;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant, v_user,
    CASE p_decision WHEN 'accepted' THEN 'expense.accepted' ELSE 'expense.needs_changes' END,
    'expense', p_expense_id,
    jsonb_build_object('role', v_role, 'fingerprint', v_fingerprint, 'notified', v_notified)
  );

  RETURN jsonb_build_object(
    'status', 'decided', 'expense_id', p_expense_id, 'decision', p_decision,
    'decided_at', v_decided_at, 'notified', v_notified
  );
END;
$$;

COMMENT ON FUNCTION public.expense_acceptance_decide(UUID, TEXT, TEXT, TEXT) IS
  'Akceptacja kosztu (00214): decyzja księgowej aktywnej firmy dla odcisku treści, który widziała, z wpisem audit_logs i przy „Do poprawy” wpisem w dzwonku pozostałych członków; ta sama decyzja dla tej samej treści zwraca exists. Tylko authenticated.';

REVOKE ALL ON FUNCTION public.expense_acceptance_decide(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.expense_acceptance_decide(UUID, TEXT, TEXT, TEXT) TO authenticated;

-- ─── Stan akceptacji dla ekranu kosztu ───
-- RLS czytającego: NULL, gdy kosztu nie widzi.
CREATE OR REPLACE FUNCTION public.expense_acceptance_state(p_expense_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'current_fingerprint', public.expense_acceptance_fingerprint(e),
    'decision', a.decision,
    'reason', a.reason,
    'decided_by', a.decided_by,
    'decided_at', a.decided_at,
    'is_current', COALESCE(a.fingerprint = public.expense_acceptance_fingerprint(e), false)
  )
    FROM public.expenses AS e
    LEFT JOIN public.expense_acceptances AS a
      ON a.expense_id = e.id
     AND a.tenant_id = e.tenant_id
   WHERE e.id = p_expense_id
     AND e.tenant_id = public.get_current_tenant_id();
$$;

COMMENT ON FUNCTION public.expense_acceptance_state(UUID) IS
  'Akceptacja kosztu (00214): odcisk bieżącej treści kosztu, ostatnia decyzja księgowej i czy dotyczy bieżącej treści; z RLS czytającego.';

REVOKE ALL ON FUNCTION public.expense_acceptance_state(UUID) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.expense_acceptance_state(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
