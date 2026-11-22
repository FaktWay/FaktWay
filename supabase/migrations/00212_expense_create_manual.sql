-- ═══════════════════════════════════════════════════════════════
-- 00212: zapis kosztu wpisanego ręcznie przez funkcję (krok 3.8 planu
-- kompletnej aplikacji, część 1)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem. Jedna nowa funkcja, bez zmiany tabel i danych,
-- bez DROP i bez DELETE. Bez tej migracji formularz „Wpisz ręcznie” odpowiada
-- „Nie udało się zapisać kosztu”, a reszta Kosztów działa bez zmian.
--
-- PO CO: 00127 odebrała rolę authenticated uprawnienie INSERT na public.expenses
-- (klient sesji nie może podrobić kosztu z KSeF), więc polityka
-- expenses_insert_own_tenant (00034) jest dla niej martwa. Koszt wpisany ręcznie
-- powstaje klientem sesji, więc zapis idzie przez funkcję SECURITY DEFINER
-- (wzór: expense_comment_add z 00192). INSERT dla authenticated NIE wraca.
--
-- CO ROBI FUNKCJA: firma z get_current_tenant_id(), członkostwo aktywne,
-- created_by = auth.uid(), source = 'manual' na sztywno, pola KSeF, odczytu
-- i pliku puste. Kształt kosztu sprawdza sama (kwoty nieujemne i z groszami,
-- brutto = netto + VAT, kolumna KPiR kosztowa, VAT do odliczenia 0 albo cały
-- VAT i 0 poza fakturą), bo nie ufa klientowi. Błąd kształtu: 23514, brak sesji,
-- firmy albo roli: 42501. Strażnik pochodzenia (00123) przepuszcza zapis, bo w
-- funkcji current_user to właściciel funkcji, nie authenticated; i tak wstawia
-- tylko source 'manual'.
--
-- PONOWIENIE: funkcja nie ma klucza zapisu; ochronę przed bliźniakiem (2 minuty)
-- i odmowę powtórzonej faktury robi akcja przed wywołaniem. Drugie wywołanie
-- funkcji tworzy drugi koszt, a wiersz jest tym samym krokiem co audyt w akcji
-- (zapis jest pojedynczym INSERT, więc nie ma stanu połowicznego).
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.expense_create_manual(
  p_seller_name TEXT,
  p_seller_nip TEXT,
  p_document_type TEXT,
  p_document_number TEXT,
  p_issue_date DATE,
  p_net_amount NUMERIC,
  p_vat_amount NUMERIC,
  p_gross_amount NUMERIC,
  p_vat_deductible_amount NUMERIC,
  p_kpir_column TEXT,
  p_category_label TEXT,
  p_notes TEXT,
  p_is_deductible BOOLEAN
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_tenant UUID;
  v_role TEXT;
  v_id UUID;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Manual expenses require a session' USING ERRCODE = '42501';
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
    RAISE EXCEPTION 'Insufficient role for manual expenses' USING ERRCODE = '42501';
  END IF;

  IF p_seller_name IS NULL OR pg_catalog.char_length(pg_catalog.btrim(p_seller_name)) NOT BETWEEN 1 AND 500
     OR p_category_label IS NULL OR pg_catalog.char_length(pg_catalog.btrim(p_category_label)) NOT BETWEEN 1 AND 200
     OR (p_document_number IS NOT NULL AND pg_catalog.char_length(p_document_number) > 200)
     OR (p_notes IS NOT NULL AND pg_catalog.char_length(p_notes) > 10000)
     OR (p_seller_nip IS NOT NULL AND p_seller_nip !~ '^[0-9]{10}$')
  THEN
    RAISE EXCEPTION 'Invalid manual expense text fields' USING ERRCODE = '23514';
  END IF;
  IF p_document_type IS NULL OR p_document_type NOT IN ('invoice', 'receipt', 'other') THEN
    RAISE EXCEPTION 'Invalid manual expense document type' USING ERRCODE = '23514';
  END IF;
  IF p_kpir_column IS NULL OR p_kpir_column NOT IN ('col_10', 'col_11', 'col_12', 'col_13', 'col_15') THEN
    RAISE EXCEPTION 'Invalid manual expense KPiR column' USING ERRCODE = '23514';
  END IF;
  IF p_issue_date IS NULL
     OR p_issue_date < DATE '2010-01-01'
     OR p_issue_date > (pg_catalog.timezone('Europe/Warsaw', pg_catalog.now()))::DATE
  THEN
    RAISE EXCEPTION 'Invalid manual expense date' USING ERRCODE = '23514';
  END IF;
  IF p_net_amount IS NULL OR p_vat_amount IS NULL OR p_gross_amount IS NULL OR p_vat_deductible_amount IS NULL
     OR p_net_amount < 0 OR p_vat_amount < 0 OR p_gross_amount <= 0 OR p_vat_deductible_amount < 0
     OR p_net_amount <> pg_catalog.round(p_net_amount, 2)
     OR p_vat_amount <> pg_catalog.round(p_vat_amount, 2)
     OR p_gross_amount <> pg_catalog.round(p_gross_amount, 2)
     OR p_gross_amount > 9999999999.99
     OR p_gross_amount <> p_net_amount + p_vat_amount
     OR p_vat_deductible_amount NOT IN (0, p_vat_amount)
     OR (p_document_type <> 'invoice' AND p_vat_deductible_amount <> 0)
     OR p_is_deductible IS NULL
  THEN
    RAISE EXCEPTION 'Invalid manual expense amounts' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.expenses (
    tenant_id, created_by, source,
    seller_name, seller_nip, document_number, document_type, issue_date,
    net_amount, vat_amount, gross_amount, vat_deductible_amount,
    kpir_column, category_label, categorization_method,
    notes, is_reviewed, is_deductible
  )
  VALUES (
    v_tenant, v_user, 'manual',
    pg_catalog.btrim(p_seller_name), p_seller_nip, p_document_number, p_document_type, p_issue_date,
    p_net_amount, p_vat_amount, p_gross_amount, p_vat_deductible_amount,
    p_kpir_column::public.kpir_column, pg_catalog.btrim(p_category_label), 'manual',
    p_notes, TRUE, p_is_deductible
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.expense_create_manual(TEXT, TEXT, TEXT, TEXT, DATE, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, BOOLEAN) IS
  'Koszt wpisany ręcznie (krok 3.8 planu kompletnej aplikacji): jedyna droga klienta sesji do nowego wiersza expenses po REVOKE INSERT z 00127. Źródło na sztywno manual, firma i osoba z sesji.';

REVOKE ALL ON FUNCTION public.expense_create_manual(TEXT, TEXT, TEXT, TEXT, DATE, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.expense_create_manual(TEXT, TEXT, TEXT, TEXT, DATE, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, BOOLEAN) TO authenticated;
