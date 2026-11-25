-- ═══════════════════════════════════════════════════════════════
-- 00215: kopia faktury z KSeF łączy się z kosztem z KSeF (FZ-022,
-- decyzja D29 z docs/koordynacja/DECYZJE-2026-11-25.md; RP-KOSZT-01)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem. Nowa tabela, indeksy, wyzwalacz i dwie
-- funkcje; bez DROP tabel i kolumn, bez zmiany istniejących danych. Stary kod
-- tabeli nie czyta, a wyzwalacz działa tylko na kopiach połączonych z kosztem
-- z KSeF, których bez nowego kodu i bez KOSZTY_LACZ_KOPIE_KSEF=true nie ma.
--
-- Jeden dokument, dwa koszty: faktura z KSeF (koszt ze Skrzynki, od 2026 r.
-- oryginał, art. 106na ust. 3 ustawy o VAT) i jej kopia spoza KSeF (zdjęcie,
-- wpis ręczny, import) z tym samym kluczem dokumentu co odczyt z #839
-- (`lib/expenses/jeden-koszt-dokumentu.ts`): NIP sprzedawcy z 10 cyfr, numer
-- bez odstępów i wielkimi literami, rok wystawienia. Wzór jak 00175 (faktura
-- do paragonu):
--   linked     kopia wypada z KPiR i z odliczenia (`is_deductible = false`,
--              wartość sprzed połączenia w `copy_was_deductible`); koszt,
--              odliczenie i numer KSeF idą z kosztu z KSeF. Najwyżej jedno
--              połączenie na koszt z KSeF i na kopię. Kategoria nadana kopii
--              ręcznie przechodzi na koszt z KSeF, chyba że jemu klient też
--              nadał ją ręcznie.
--   candidate  zadanie „Połącz koszty” do decyzji klienta: kilka kopii albo
--              miesiąc złożony. Odmowa odczytu z #839 zostaje, dopóki klient
--              nie zdecyduje.
--   dismissed  ślad decyzji „to osobne koszty” albo rozłączenia: ponowienie
--              runnera nie odtwarza ani zadania, ani połączenia.
--
-- Bezpiecznik D29, miesiąc złożony (dla miesiąca wystawienia obu kosztów):
-- rozliczenie w module (`tax_settlements`), wysyłka JPK_V7M z FaktWay na
-- bramkę produkcyjną MF (bez odrzuconej i przerwanej) albo udany eksport KPiR
-- lub JPK_V7M za okres z tym miesiącem (jak „okresy złożone” w
-- scripts/ops/koszt-dwa-razy.sql). Wtedy bez łączenia, tylko zadanie.
-- Łączą się tylko koszty, które dziś oba liczą się w KPiR (`is_deductible`):
-- klient, który już wyłączył jeden z nich (wyjście z odmowy #839), zdecydował
-- sam, a koszt z KSeF czekający na przegląd waluty nie wchodzi do KPiR.
--
-- Zapis tylko przez dwie funkcje dla service_role (wzór 00127 i 00175):
-- runnery skrzynki i zdjęć (`link_ksef_expense_copy`) i decyzja klienta
-- z akcji serwerowej po MFA (`decide_ksef_expense_copy`, członkostwo
-- sprawdzane w bazie, audyt w tej samej transakcji). Klient tylko czyta
-- swoją firmę.
-- ═══════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS public.expense_ksef_copies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  -- Koszt z faktury w KSeF (Skrzynka).
  ksef_expense_id UUID NOT NULL,
  -- Kopia tej samej faktury spoza KSeF.
  copy_expense_id UUID NOT NULL,
  status TEXT NOT NULL,
  copy_was_deductible BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT expense_ksef_copies_status_check
    CHECK (status IN ('linked', 'candidate', 'dismissed')),
  CONSTRAINT expense_ksef_copies_two_documents_check
    CHECK (ksef_expense_id <> copy_expense_id),
  CONSTRAINT expense_ksef_copies_linked_restore_check
    CHECK (status <> 'linked' OR copy_was_deductible IS NOT NULL),
  CONSTRAINT expense_ksef_copies_pair_unique
    UNIQUE (tenant_id, ksef_expense_id, copy_expense_id),
  -- Cel kluczy obcych „ten sam tenant”: uq_expenses_tenant_id_id z 00175.
  CONSTRAINT expense_ksef_copies_ksef_same_tenant_fk
    FOREIGN KEY (tenant_id, ksef_expense_id)
    REFERENCES public.expenses (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT expense_ksef_copies_copy_same_tenant_fk
    FOREIGN KEY (tenant_id, copy_expense_id)
    REFERENCES public.expenses (tenant_id, id) ON DELETE CASCADE
);

-- Jedna kopia na koszt z KSeF i jeden koszt z KSeF na kopię.
CREATE UNIQUE INDEX IF NOT EXISTS uq_expense_ksef_copies_linked_ksef
  ON public.expense_ksef_copies (tenant_id, ksef_expense_id)
  WHERE status = 'linked';
CREATE UNIQUE INDEX IF NOT EXISTS uq_expense_ksef_copies_linked_copy
  ON public.expense_ksef_copies (tenant_id, copy_expense_id)
  WHERE status = 'linked';
CREATE INDEX IF NOT EXISTS idx_expense_ksef_copies_copy
  ON public.expense_ksef_copies (tenant_id, copy_expense_id);

ALTER TABLE public.expense_ksef_copies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "expense_ksef_copies_select_own_tenant" ON public.expense_ksef_copies;
CREATE POLICY "expense_ksef_copies_select_own_tenant" ON public.expense_ksef_copies
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_current_tenant_id());

REVOKE ALL ON public.expense_ksef_copies FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.expense_ksef_copies TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.expense_ksef_copies TO service_role;

COMMENT ON TABLE public.expense_ksef_copies IS
  'Copy of a KSeF purchase invoice outside KSeF (photo, manual, import) vs the KSeF cost: linked removes the copy from KPiR and VAT; candidate is a merge task awaiting the client; dismissed records the decision (FZ-022, D29).';

-- Klucz dokumentu kosztu jak `kluczDokumentuKosztu` (lib/expenses/jeden-koszt-dokumentu.ts);
-- NULL bez NIP-u z 10 cyfr albo bez numeru.
CREATE OR REPLACE FUNCTION public.expense_document_key(p_seller_nip text, p_document_number text, p_issue_date date)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN length(regexp_replace(coalesce(p_seller_nip, ''), '[^0-9]', '', 'g')) = 10
     AND regexp_replace(coalesce(p_document_number, ''), '[[:space:]]', '', 'g') <> ''
    THEN regexp_replace(coalesce(p_seller_nip, ''), '[^0-9]', '', 'g')
      || '|' || upper(regexp_replace(coalesce(p_document_number, ''), '[[:space:]]', '', 'g'))
      || '|' || coalesce(extract(year FROM p_issue_date)::int::text, '')
  END
$$;

REVOKE ALL ON FUNCTION public.expense_document_key(text, text, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expense_document_key(text, text, date) TO service_role;

-- Miesiąc złożony (bezpiecznik D29) dla pierwszego dnia miesiąca `p_okres`.
CREATE OR REPLACE FUNCTION public.expense_period_filed(p_tenant_id uuid, p_okres date)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT EXISTS (
      SELECT 1 FROM public.tax_settlements AS s
       WHERE s.tenant_id = p_tenant_id AND s.okres = p_okres
    )
    OR EXISTS (
      SELECT 1 FROM public.jpk_submissions AS j
       WHERE j.tenant_id = p_tenant_id AND j.okres = p_okres
         AND j.srodowisko = 'produkcja' AND j.stan NOT IN ('odrzucona', 'przerwana')
    )
    OR EXISTS (
      SELECT 1 FROM public.export_jobs AS x
       WHERE x.tenant_id = p_tenant_id AND x.status = 'completed'
         AND x.format::text IN ('kpir_excel', 'jpk_v7m')
         AND x.period_start <= (p_okres + interval '1 month' - interval '1 day')::date
         AND x.period_end >= p_okres
    )
$$;

REVOKE ALL ON FUNCTION public.expense_period_filed(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expense_period_filed(uuid, date) TO service_role;

-- Połączona kopia nie wraca do KPiR edycją klienta (podwójny koszt i odliczenie).
-- Wyjście: „Rozłącz” przy koszcie (`decide_ksef_expense_copy` bez wybranej kopii).
CREATE OR REPLACE FUNCTION public.guard_linked_ksef_copy_expense()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF NEW.is_deductible IS TRUE
     AND OLD.is_deductible IS DISTINCT FROM TRUE
     AND EXISTS (
       SELECT 1 FROM public.expense_ksef_copies AS m
        WHERE m.tenant_id = OLD.tenant_id
          AND m.copy_expense_id = OLD.id
          AND m.status = 'linked'
     ) THEN
    RAISE EXCEPTION 'Ten koszt to kopia faktury z KSeF, więc koszt i VAT liczą się z faktury z KSeF. Żeby wliczyć kopię, najpierw trzeba rozłączyć koszty przyciskiem „Rozłącz”.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_linked_ksef_copy_expense() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS b_guard_linked_ksef_copy_expense ON public.expenses;
CREATE TRIGGER b_guard_linked_ksef_copy_expense
  BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.guard_linked_ksef_copy_expense();

-- Runnery skrzynki i zdjęć (service_role) po zapisie kosztu: `p_expense_id`
-- to koszt, który właśnie powstał (z KSeF albo kopia). Baza sama liczy klucz,
-- szuka jedynego kosztu z KSeF tego dokumentu i jego kopii, sprawdza
-- bezpiecznik miesiąca złożonego i jednorazowość. Zwraca: linked, candidates,
-- already_linked, dismissed, no_candidates, no_ksef_original, ambiguous_ksef,
-- not_deductible, not_applicable. Ponowienie od zera: połączenie albo zadanie
-- już jest (także odrzucone przez klienta), więc drugie wykonanie nic nie zmienia.
CREATE OR REPLACE FUNCTION public.link_ksef_expense_copy(
  p_tenant_id uuid,
  p_expense_id uuid,
  p_auto_link boolean
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_klucz text;
  v_ksef_ids uuid[];
  v_ksef public.expenses%ROWTYPE;
  v_ids uuid[];
  v_copy public.expenses%ROWTYPE;
  v_kategoria boolean;
  v_nowe integer;
BEGIN
  IF current_user <> 'service_role'
     OR p_tenant_id IS NULL OR p_expense_id IS NULL OR p_auto_link IS NULL THEN
    RAISE EXCEPTION 'Invalid KSeF copy link request'
      USING ERRCODE = '42501';
  END IF;

  SELECT public.expense_document_key(e.seller_nip, e.document_number, e.issue_date) INTO v_klucz
    FROM public.expenses AS e
   WHERE e.id = p_expense_id AND e.tenant_id = p_tenant_id;
  IF v_klucz IS NULL THEN RETURN 'not_applicable'; END IF;

  -- Dokładnie jeden koszt z KSeF tego dokumentu (dwa koszty z KSeF z tym samym
  -- numerem, np. faktura i korekta, to dla KSeF dwa dokumenty: bez łączenia).
  SELECT array_agg(e.id ORDER BY e.id) INTO v_ksef_ids
    FROM public.expenses AS e
   WHERE e.tenant_id = p_tenant_id
     AND e.source = 'ksef_inbox' AND e.ksef_invoice_id IS NOT NULL
     AND public.expense_document_key(e.seller_nip, e.document_number, e.issue_date) = v_klucz;
  IF coalesce(cardinality(v_ksef_ids), 0) = 0 THEN RETURN 'no_ksef_original'; END IF;
  IF cardinality(v_ksef_ids) > 1 THEN RETURN 'ambiguous_ksef'; END IF;

  -- Blokada wiersza kosztu z KSeF szereguje równoległe przebiegi (skrzynka
  -- i zdjęcie tej samej faktury) i decyzję klienta.
  SELECT e.* INTO v_ksef FROM public.expenses AS e
   WHERE e.id = v_ksef_ids[1] AND e.tenant_id = p_tenant_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_applicable'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.expense_ksef_copies AS m
     WHERE m.tenant_id = p_tenant_id AND m.ksef_expense_id = v_ksef.id AND m.status = 'linked'
  ) THEN
    RETURN 'already_linked';
  END IF;
  IF v_ksef.is_deductible IS DISTINCT FROM TRUE THEN RETURN 'not_deductible'; END IF;

  -- Kopie: koszty spoza KSeF tej firmy z tym samym kluczem, liczone w KPiR,
  -- niepołączone z innym kosztem z KSeF ani z fakturą do paragonu (00175).
  PERFORM 1 FROM public.expenses AS e
   WHERE e.tenant_id = p_tenant_id
     AND e.source IS DISTINCT FROM 'ksef_inbox' AND e.ksef_invoice_id IS NULL
     AND public.expense_document_key(e.seller_nip, e.document_number, e.issue_date) = v_klucz
   ORDER BY e.id
   FOR UPDATE;
  SELECT array_agg(e.id ORDER BY e.id) INTO v_ids
    FROM public.expenses AS e
   WHERE e.tenant_id = p_tenant_id
     AND e.source IS DISTINCT FROM 'ksef_inbox' AND e.ksef_invoice_id IS NULL
     AND e.is_deductible IS TRUE
     AND public.expense_document_key(e.seller_nip, e.document_number, e.issue_date) = v_klucz
     AND NOT EXISTS (
       SELECT 1 FROM public.expense_ksef_copies AS m
        WHERE m.tenant_id = p_tenant_id AND m.copy_expense_id = e.id
          AND (m.status = 'linked' OR (m.ksef_expense_id = v_ksef.id AND m.status = 'dismissed'))
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.expense_receipt_matches AS r
        WHERE r.tenant_id = p_tenant_id AND r.receipt_expense_id = e.id AND r.status = 'linked'
     );
  IF coalesce(cardinality(v_ids), 0) = 0 THEN
    IF EXISTS (
      SELECT 1 FROM public.expense_ksef_copies AS m
       WHERE m.tenant_id = p_tenant_id AND m.ksef_expense_id = v_ksef.id AND m.status = 'dismissed'
    ) THEN
      RETURN 'dismissed';
    END IF;
    RETURN 'no_candidates';
  END IF;

  -- Samo łączy się tylko jedna kopia, która nie czeka już na decyzję klienta,
  -- przy miesiącach obu kosztów niezłożonych (bezpiecznik D29).
  IF p_auto_link AND cardinality(v_ids) = 1 THEN
    SELECT e.* INTO v_copy FROM public.expenses AS e
     WHERE e.id = v_ids[1] AND e.tenant_id = p_tenant_id;
    IF NOT EXISTS (
         SELECT 1 FROM public.expense_ksef_copies AS m
          WHERE m.tenant_id = p_tenant_id AND m.copy_expense_id = v_copy.id AND m.status = 'candidate'
       )
       AND NOT public.expense_period_filed(p_tenant_id, date_trunc('month', v_ksef.issue_date)::date)
       AND NOT public.expense_period_filed(p_tenant_id, date_trunc('month', v_copy.issue_date)::date) THEN
      INSERT INTO public.expense_ksef_copies (tenant_id, ksef_expense_id, copy_expense_id, status, copy_was_deductible)
      VALUES (p_tenant_id, v_ksef.id, v_copy.id, 'linked', v_copy.is_deductible);
      UPDATE public.expenses AS e
         SET is_deductible = false
       WHERE e.id = v_copy.id AND e.tenant_id = p_tenant_id;
      -- Kategoria nadana kopii ręcznie przechodzi na koszt z KSeF (chyba że jemu też nadano ją ręcznie).
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
        p_tenant_id, NULL, 'expense.ksef_copy_linked', 'expense', v_ksef.id,
        jsonb_build_object('copyExpenseId', v_copy.id, 'by', 'auto',
                           'copyWasDeductible', v_copy.is_deductible,
                           'categoryFromCopy', v_kategoria)
      );
      RETURN 'linked';
    END IF;
  END IF;

  INSERT INTO public.expense_ksef_copies (tenant_id, ksef_expense_id, copy_expense_id, status)
  SELECT p_tenant_id, v_ksef.id, x.id, 'candidate'
    FROM unnest(v_ids) AS x(id)
  ON CONFLICT (tenant_id, ksef_expense_id, copy_expense_id) DO NOTHING;
  GET DIAGNOSTICS v_nowe = ROW_COUNT;

  IF v_nowe > 0 THEN
    -- Koszt z KSeF czeka na decyzję klienta: w Skrzynce status „Nowa”.
    UPDATE public.expenses AS e
       SET is_reviewed = false
     WHERE e.id = v_ksef.id AND e.tenant_id = p_tenant_id;

    INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
    VALUES (
      p_tenant_id, NULL, 'expense.ksef_copy_candidates', 'expense', v_ksef.id,
      jsonb_build_object('copyExpenseIds', to_jsonb(v_ids), 'autoLinkRequested', p_auto_link)
    );
  END IF;
  RETURN 'candidates';
END;
$$;

REVOKE ALL ON FUNCTION public.link_ksef_expense_copy(uuid, uuid, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.link_ksef_expense_copy(uuid, uuid, boolean)
  TO service_role;

-- Decyzja klienta z akcji serwerowej (service_role po MFA i wyborze firmy).
-- p_copy_expense_id: wybrana kopia z zadania „Połącz koszty”; NULL: „to osobne
-- koszty”, czyli odrzucenie zadania albo rozłączenie („Rozłącz”: kopia wraca do
-- KPiR z wartością sprzed połączenia; kategoria kosztu z KSeF zostaje). Zwraca:
-- linked, separated, stale. Połączenie przez klienta nie patrzy na bezpiecznik
-- miesiąca złożonego: klient decyduje świadomie (zadanie pokazuje miesiące).
CREATE OR REPLACE FUNCTION public.decide_ksef_expense_copy(
  p_tenant_id uuid,
  p_ksef_expense_id uuid,
  p_actor_user_id uuid,
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
     OR p_actor_user_id IS NULL THEN
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

  SELECT e.* INTO v_ksef FROM public.expenses AS e
   WHERE e.id = p_ksef_expense_id
     AND e.tenant_id = p_tenant_id
     AND e.source = 'ksef_inbox'
     AND e.ksef_invoice_id IS NOT NULL
   FOR UPDATE;
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
                         'categoryFromCopy', v_kategoria)
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

REVOKE ALL ON FUNCTION public.decide_ksef_expense_copy(uuid, uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.decide_ksef_expense_copy(uuid, uuid, uuid, uuid)
  TO service_role;

COMMIT;

-- PostgREST na self-hosted trzyma podpisy RPC w pamięci podręcznej.
NOTIFY pgrst, 'reload schema';
