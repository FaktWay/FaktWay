-- ═══════════════════════════════════════════════════════════════
-- 00217: decyzja klienta o kopii faktury z KSeF nie łączy przy koszcie z KSeF
-- poza KPiR (FZ-022, decyzja D29; poprawka do 00215 po przeglądzie interfejsu)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem, po 00215. Tylko nowa treść jednej funkcji
-- (CREATE OR REPLACE z tym samym podpisem i uprawnieniami); bez zmian tabel
-- i danych. Bez niej przycisk „Połącz koszty” przy koszcie z KSeF wyłączonym
-- z KPiR wyjąłby z KPiR oba koszty.
--
-- `link_ksef_expense_copy` (runner) już odmawia, gdy koszt z KSeF nie liczy
-- się w KPiR (`not_deductible`). `decide_ksef_expense_copy` (wybór klienta
-- w zadaniu „Połącz koszty”) tego nie sprawdzał: klient, który zgodnie
-- z wyjściem z odmowy wyłączył koszt z KSeF, mógł potem połączyć kopię i oba
-- koszty wypadały z KPiR, VAT i JPK bez odmowy. Teraz łączenie zwraca
-- `not_deductible` i niczego nie zapisuje; rozłączenie i „to osobne
-- dokumenty” bez zmian.
-- ═══════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.decide_ksef_expense_copy(
  p_tenant_id uuid,
  p_ksef_expense_id uuid,
  p_actor_user_id uuid,
  p_ksef_environment text,
  p_copy_expense_id uuid DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_linked public.expense_ksef_copies%ROWTYPE;
  v_copy public.expenses%ROWTYPE;
  v_ksef public.expenses%ROWTYPE;
  v_kategoria boolean;
  v_dismissed integer;
BEGIN
  IF current_user <> 'service_role'
     OR p_tenant_id IS NULL OR p_ksef_expense_id IS NULL
     OR p_actor_user_id IS NULL
     OR p_ksef_environment IS NULL OR p_ksef_environment NOT IN ('test', 'demo', 'production') THEN
    RAISE EXCEPTION 'Invalid KSeF copy decision'
      USING ERRCODE = '42501';
  END IF;

  -- FOR SHARE szereguje decyzję z równoległym odebraniem członkostwa.
  PERFORM 1 FROM public.memberships AS m
   WHERE m.organization_id = p_tenant_id
     AND m.user_id = p_actor_user_id
     AND m.status = 'active'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active organization membership'
      USING ERRCODE = '42501';
  END IF;

  -- Łączenie: koszt z KSeF z faktury przyjętej w środowisku aplikacji (jak w odczytach).
  -- Rozłączenie i „to osobne koszty” (bez wybranej kopii) w każdym środowisku: para połączona
  -- przed zmianą KSEF_ENV musi mieć wyjście (kopia wraca do KPiR).
  SELECT e.* INTO v_ksef FROM public.expenses AS e
   WHERE e.id = p_ksef_expense_id
     AND e.tenant_id = p_tenant_id
     AND e.source = 'ksef_inbox'
     AND e.ksef_invoice_id IS NOT NULL
     AND (p_copy_expense_id IS NULL OR EXISTS (
       SELECT 1 FROM public.invoices AS i
        WHERE i.id = e.ksef_invoice_id AND i.tenant_id = e.tenant_id
          AND i.direction = 'incoming' AND i.ksef_status = 'accepted'
          AND i.ksef_environment::text = p_ksef_environment
     ))
   FOR UPDATE OF e;
  IF NOT FOUND THEN RETURN 'stale'; END IF;

  PERFORM 1 FROM public.expense_ksef_copies AS m
   WHERE m.tenant_id = p_tenant_id AND m.ksef_expense_id = p_ksef_expense_id
   FOR UPDATE;

  IF p_copy_expense_id IS NOT NULL THEN
    IF NOT EXISTS (
         SELECT 1 FROM public.expense_ksef_copies AS m
          WHERE m.tenant_id = p_tenant_id AND m.ksef_expense_id = p_ksef_expense_id
            AND m.copy_expense_id = p_copy_expense_id AND m.status = 'candidate')
       OR EXISTS (
         SELECT 1 FROM public.expense_ksef_copies AS m
          WHERE m.tenant_id = p_tenant_id AND m.status = 'linked'
            AND (m.ksef_expense_id = p_ksef_expense_id
                 OR m.copy_expense_id = p_copy_expense_id)) THEN
      RETURN 'stale';
    END IF;

    SELECT e.* INTO v_copy FROM public.expenses AS e
     WHERE e.id = p_copy_expense_id AND e.tenant_id = p_tenant_id
       AND e.source IS DISTINCT FROM 'ksef_inbox' AND e.ksef_invoice_id IS NULL
     FOR UPDATE;
    IF NOT FOUND THEN RETURN 'stale'; END IF;
    -- Jak przy łączeniu przez runner (00215): koszt z KSeF poza KPiR nie przejmuje kopii, bo połączenie wyjęłoby
    -- z KPiR oba koszty (kopia też wypada), a dokument zniknąłby z KPiR, VAT i JPK bez odmowy odczytu.
    IF v_ksef.is_deductible IS DISTINCT FROM TRUE THEN RETURN 'not_deductible'; END IF;

    UPDATE public.expense_ksef_copies AS m
       SET status = 'linked', copy_was_deductible = v_copy.is_deductible, updated_at = now()
     WHERE m.tenant_id = p_tenant_id AND m.ksef_expense_id = p_ksef_expense_id
       AND m.copy_expense_id = p_copy_expense_id;
    UPDATE public.expense_ksef_copies AS m
       SET status = 'dismissed', updated_at = now()
     WHERE m.tenant_id = p_tenant_id AND m.ksef_expense_id = p_ksef_expense_id
       AND m.copy_expense_id <> p_copy_expense_id AND m.status = 'candidate';
    UPDATE public.expenses AS e
       SET is_deductible = false
     WHERE e.id = v_copy.id AND e.tenant_id = p_tenant_id;
    v_kategoria := coalesce(v_copy.categorization_method = 'manual', false)
      AND v_ksef.categorization_method IS DISTINCT FROM 'manual'
      AND v_copy.kpir_column IS NOT NULL;
    IF v_kategoria THEN
      UPDATE public.expenses AS e
         SET kpir_column = v_copy.kpir_column,
             category_label = v_copy.category_label,
             categorization_method = 'manual'
       WHERE e.id = v_ksef.id AND e.tenant_id = p_tenant_id;
    END IF;

    INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
    VALUES (
      p_tenant_id, p_actor_user_id, 'expense.ksef_copy_linked', 'expense', p_ksef_expense_id,
      jsonb_build_object('copyExpenseId', v_copy.id, 'by', 'client',
                         'copyWasDeductible', v_copy.is_deductible,
                         'categoryFromCopy', v_kategoria,
                         'ksefCategoryBefore', CASE WHEN v_kategoria THEN jsonb_build_object(
                           'kpirColumn', v_ksef.kpir_column, 'categoryLabel', v_ksef.category_label,
                           'method', v_ksef.categorization_method) END)
    );
    RETURN 'linked';
  END IF;

  SELECT m.* INTO v_linked FROM public.expense_ksef_copies AS m
   WHERE m.tenant_id = p_tenant_id AND m.ksef_expense_id = p_ksef_expense_id
     AND m.status = 'linked';
  IF FOUND THEN
    UPDATE public.expenses AS e
       SET is_deductible = v_linked.copy_was_deductible
     WHERE e.id = v_linked.copy_expense_id AND e.tenant_id = p_tenant_id;
  END IF;

  UPDATE public.expense_ksef_copies AS m
     SET status = 'dismissed', updated_at = now()
   WHERE m.tenant_id = p_tenant_id AND m.ksef_expense_id = p_ksef_expense_id
     AND m.status IN ('linked', 'candidate');
  GET DIAGNOSTICS v_dismissed = ROW_COUNT;
  IF v_dismissed = 0 THEN RETURN 'stale'; END IF;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    p_tenant_id, p_actor_user_id, 'expense.ksef_copy_separated', 'expense', p_ksef_expense_id,
    jsonb_build_object('unlinkedCopyExpenseId', v_linked.copy_expense_id, 'dismissed', v_dismissed)
  );
  RETURN 'separated';
END;
$$;

REVOKE ALL ON FUNCTION public.decide_ksef_expense_copy(uuid, uuid, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.decide_ksef_expense_copy(uuid, uuid, uuid, text, uuid)
  TO service_role;

COMMIT;

-- PostgREST na self-hosted trzyma podpisy RPC w pamięci podręcznej.
NOTIFY pgrst, 'reload schema';
