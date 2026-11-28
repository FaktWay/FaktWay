-- 00223_outside_ksef_usuwanie_przez_wlasciciela.sql
-- KIEDY WGRAĆ: PRZED wdrożeniem (addytywna: poluzowanie tylko dla origin = 'outside_ksef', którego stary kod nie zapisuje).
--
-- Plan kompletnej aplikacji, krok 1.6 część 2b, zabezpieczenia po przeglądach
-- #990 i #991 (D23: klient może usunąć wpis spoza KSeF zawsze, akcją z audytem).
-- Akcja removeOutsideKsefInvoiceAction usuwa wiersz sesją klienta (RLS), a baza
-- odmawiała tego dwa razy: polityka z 00002 pozwala usunąć tylko szkic, a
-- wyzwalacze 00132 (guard_invoice_pending_content i guard_invoice_delivery_history)
-- odmawiają DELETE każdej faktury przyjętej. Ta migracja:
--  1. dodaje politykę DELETE invoices_delete_own_tenant_outside_ksef: własna firma
--     i TYLKO origin = 'outside_ksef' (polityki są sumowane przez OR, więc zwykła
--     faktura dalej usuwa się wyłącznie jako szkic);
--  2. w obu wyzwalaczach pomija odmowę DELETE dla origin = 'outside_ksef'. Ciała
--     znak w znak z 00132; jedyna zmiana to warunek na pochodzenie w gałęzi DELETE.
--     Pochodzenia nie da się nadać ani zdjąć po zapisie (00221), więc zwykłej
--     faktury przyjętej nie da się „przebrać” za wpis spoza KSeF, żeby ją usunąć.
--     Kształt wiersza (accepted, bez numeru KSeF i XML, bez śladów wysyłki)
--     pilnuje invoices_outside_ksef_shape (00221).
-- Pozycje faktury znikają kaskadą (ON DELETE CASCADE).
--
-- Wyjście przy odmowie (protokół, pkt 4): klient widzi komunikat akcji; operator:
-- usunięcie przez service_role (wyzwalacze przepuszczają tę rolę).
--
-- Wycofanie: DROP POLICY invoices_delete_own_tenant_outside_ksef i przywrócenie
-- ciał obu funkcji z 00132.

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS "invoices_delete_own_tenant_outside_ksef" ON public.invoices;
CREATE POLICY "invoices_delete_own_tenant_outside_ksef"
  ON public.invoices FOR DELETE
  TO authenticated
  USING (
    tenant_id = public.get_current_tenant_id()
    AND origin = 'outside_ksef'
  );

CREATE OR REPLACE FUNCTION public.guard_invoice_pending_content()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_locked boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_user IN ('authenticated', 'anon') AND (
      NEW.ksef_status IS DISTINCT FROM 'draft'
      OR NEW.ksef_number IS NOT NULL
      OR NEW.ksef_environment IS NOT NULL
      OR NEW.ksef_accepted_at IS NOT NULL
      OR NEW.xml_storage_path IS NOT NULL
      OR NEW.offline_qr_offline IS NOT NULL
      OR NEW.offline_qr_certyfikat IS NOT NULL
      OR NEW.offline_idempotency_key IS NOT NULL
      OR NEW.submitted_to_ksef_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Client invoice must start as a draft without KSeF delivery evidence'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_locked := OLD.ksef_status IN ('queued', 'offline_queued', 'sending')
      OR OLD.offline_idempotency_key IS NOT NULL
      OR OLD.submitted_to_ksef_at IS NOT NULL
      -- 00223: wpis spoza KSeF (00221) nie ma historii dostawy; klient usuwa go sam (D23).
      OR (current_user IN ('authenticated', 'anon') AND OLD.ksef_status = 'accepted'
          AND OLD.origin IS DISTINCT FROM 'outside_ksef');
    IF v_locked THEN
      RAISE EXCEPTION 'KSeF document cannot be deleted by this role'
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  -- Incoming imports can be accepted without a local submission timestamp.
  -- Their trusted server-side enrichment remains possible; client edits do not.
  v_locked := OLD.ksef_status IN ('queued', 'offline_queued', 'sending')
    OR NEW.ksef_status IN ('queued', 'offline_queued', 'sending')
    OR OLD.offline_idempotency_key IS NOT NULL
    OR OLD.submitted_to_ksef_at IS NOT NULL
    OR (current_user IN ('authenticated', 'anon') AND
        (OLD.ksef_status = 'accepted' OR NEW.ksef_status = 'accepted'));
  IF v_locked AND ROW(
    NEW.tenant_id, NEW.direction, NEW.internal_number,
    NEW.invoice_type, NEW.invoice_kind, NEW.origin,
    NEW.issue_date, NEW.sale_date, NEW.seller_nip, NEW.buyer_nip,
    NEW.seller_data, NEW.buyer_data, NEW.payment_data,
    NEW.payment_due_date, NEW.currency, NEW.notes,
    NEW.net_total, NEW.vat_total, NEW.gross_total, NEW.fa3_data,
    NEW.is_b2c, NEW.buyer_id_type, NEW.buyer_pesel,
    NEW.buyer_id_number, NEW.parent_invoice_id,
    NEW.correction_reason, NEW.correction_type, NEW.advance_amount,
    NEW.advance_invoice_ids
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id, OLD.direction, OLD.internal_number,
    OLD.invoice_type, OLD.invoice_kind, OLD.origin,
    OLD.issue_date, OLD.sale_date, OLD.seller_nip, OLD.buyer_nip,
    OLD.seller_data, OLD.buyer_data, OLD.payment_data,
    OLD.payment_due_date, OLD.currency, OLD.notes,
    OLD.net_total, OLD.vat_total, OLD.gross_total, OLD.fa3_data,
    OLD.is_b2c, OLD.buyer_id_type, OLD.buyer_pesel,
    OLD.buyer_id_number, OLD.parent_invoice_id,
    OLD.correction_reason, OLD.correction_type, OLD.advance_amount,
    OLD.advance_invoice_ids
  ) THEN
    RAISE EXCEPTION 'KSeF document content is immutable for this role'
      USING ERRCODE = '42501';
  END IF;

  -- 00132: stan dostawy zmienia wyłącznie serwer (RPC z 00131 i worker).
  -- Dawny wyjątek „klient: draft → queued” usunięty — kolejkowanie robi
  -- enqueue_ksef_send w transakcji ze zleceniem pg-boss.
  IF current_user IN ('authenticated', 'anon') AND (
    NEW.ksef_status IS DISTINCT FROM OLD.ksef_status
    OR NEW.ksef_number IS DISTINCT FROM OLD.ksef_number
    OR NEW.ksef_environment IS DISTINCT FROM OLD.ksef_environment
    OR NEW.ksef_accepted_at IS DISTINCT FROM OLD.ksef_accepted_at
    OR NEW.xml_storage_path IS DISTINCT FROM OLD.xml_storage_path
    OR NEW.offline_qr_offline IS DISTINCT FROM OLD.offline_qr_offline
    OR NEW.offline_qr_certyfikat IS DISTINCT FROM OLD.offline_qr_certyfikat
    OR NEW.offline_idempotency_key IS DISTINCT FROM OLD.offline_idempotency_key
    OR NEW.submitted_to_ksef_at IS DISTINCT FROM OLD.submitted_to_ksef_at
  ) THEN
    RAISE EXCEPTION 'KSeF delivery state is server-managed'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_invoice_pending_content()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.guard_invoice_delivery_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_historical boolean;
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.last_attempt_at IS NOT NULL
       OR COALESCE(NEW.submission_attempts, 0) <> 0
       OR NEW.last_error IS NOT NULL
       OR NEW.last_error_code IS NOT NULL
       OR NEW.last_error_field IS NOT NULL
       OR NEW.last_error_suggestion IS NOT NULL THEN
      RAISE EXCEPTION 'Client cannot create KSeF delivery history'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- 00132: historia = stan failed/rejected albo pola wysyłki na wierszu.
  -- Diagnostyka (last_attempt_at, submission_attempts, last_error*) opisuje
  -- próby, nie dowodzi kontaktu — po reset_ksef_send (00131) szkic jest
  -- edytowalny, bo reset zdejmuje pola wysyłki tylko wtedy, gdy dowodu nie ma.
  v_historical := OLD.ksef_status IN ('failed', 'rejected')
    OR OLD.offline_idempotency_key IS NOT NULL
    OR OLD.submitted_to_ksef_at IS NOT NULL
    OR OLD.ksef_number IS NOT NULL
    OR OLD.ksef_environment IS NOT NULL
    OR OLD.ksef_accepted_at IS NOT NULL
    OR OLD.xml_storage_path IS NOT NULL
    OR OLD.offline_qr_offline IS NOT NULL
    OR OLD.offline_qr_certyfikat IS NOT NULL;

  IF TG_OP = 'DELETE' THEN
    -- 00223: wpis spoza KSeF (00221) nie ma historii dostawy; klient usuwa go sam (D23).
    -- Pochodzenia nie da się zmienić po zapisie (trg_guard_outside_ksef_origin, 00221).
    IF OLD.origin IS DISTINCT FROM 'outside_ksef'
       AND (OLD.ksef_status IS DISTINCT FROM 'draft' OR v_historical) THEN
      RAISE EXCEPTION 'KSeF invoice with delivery history cannot be deleted by client'
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF v_historical AND ROW(
    NEW.tenant_id, NEW.direction, NEW.internal_number,
    NEW.invoice_type, NEW.invoice_kind, NEW.origin,
    NEW.issue_date, NEW.sale_date, NEW.seller_nip, NEW.buyer_nip,
    NEW.seller_data, NEW.buyer_data, NEW.payment_data,
    NEW.payment_due_date, NEW.currency, NEW.notes,
    NEW.net_total, NEW.vat_total, NEW.gross_total, NEW.fa3_data,
    NEW.is_b2c, NEW.buyer_id_type, NEW.buyer_pesel,
    NEW.buyer_id_number, NEW.parent_invoice_id,
    NEW.correction_reason, NEW.correction_type, NEW.advance_amount,
    NEW.advance_invoice_ids
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id, OLD.direction, OLD.internal_number,
    OLD.invoice_type, OLD.invoice_kind, OLD.origin,
    OLD.issue_date, OLD.sale_date, OLD.seller_nip, OLD.buyer_nip,
    OLD.seller_data, OLD.buyer_data, OLD.payment_data,
    OLD.payment_due_date, OLD.currency, OLD.notes,
    OLD.net_total, OLD.vat_total, OLD.gross_total, OLD.fa3_data,
    OLD.is_b2c, OLD.buyer_id_type, OLD.buyer_pesel,
    OLD.buyer_id_number, OLD.parent_invoice_id,
    OLD.correction_reason, OLD.correction_type, OLD.advance_amount,
    OLD.advance_invoice_ids
  ) THEN
    RAISE EXCEPTION 'KSeF legal content with delivery history is immutable'
      USING ERRCODE = '42501';
  END IF;

  -- 00132: żadne przejście stanu z sesji klienta (dawny wyjątek draft → queued usunięty).
  IF NEW.ksef_status IS DISTINCT FROM OLD.ksef_status THEN
    RAISE EXCEPTION 'KSeF delivery transition is server-managed'
      USING ERRCODE = '42501';
  END IF;

  IF ROW(
    NEW.last_attempt_at, NEW.submission_attempts, NEW.last_error,
    NEW.last_error_code, NEW.last_error_field, NEW.last_error_suggestion
  ) IS DISTINCT FROM ROW(
    OLD.last_attempt_at, OLD.submission_attempts, OLD.last_error,
    OLD.last_error_code, OLD.last_error_field, OLD.last_error_suggestion
  ) THEN
    RAISE EXCEPTION 'KSeF delivery diagnostics are server-managed'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_invoice_delivery_history()
  FROM PUBLIC, anon, authenticated;

COMMIT;
