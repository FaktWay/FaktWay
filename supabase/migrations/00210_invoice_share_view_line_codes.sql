-- ═══════════════════════════════════════════════════════════════
-- 00210: PKWiU i GTU pozycji na stronie faktury dla nabywcy (plan kompletnej
-- aplikacji, krok 2.6, część 2b-3c)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem. Tylko CREATE OR REPLACE FUNCTION widoku
-- `invoice_share_link_view` (00179) z dwoma nowymi polami pozycji; bez zmian
-- tabel i danych. Stara aplikacja nowe pola pomija (schemat pozycji je
-- odrzuca jako nieznane), nowa przyjmuje widok bez nich (pola opcjonalne).
--
-- Kody pozycji leżą w dokumencie faktury (`fa3_data.lines[].pkwiuCode`,
-- `gtuCode`, po `ordinal`), a `invoice_line_items` nie ma ich kolumn. Widok
-- dokłada do pozycji `pkwiu_code` i `gtu_code` z tego samego dokumentu, z którego
-- powstał plik FA(3); nabywca widzi je i tak w pliku XML i na PDF. Reszta
-- `fa3_data` dalej nie wychodzi poza bazę. Ciało funkcji poza blokiem pozycji
-- bez zmian (skopiowane z 00179).
-- ═══════════════════════════════════════════════════════════════

-- Odczyt publiczny: dane jednej faktury po skrócie tokenu albo NULL.
-- `p_count_open`: otwarcie strony liczy się do `open_count`, pobranie pliku nie.
CREATE OR REPLACE FUNCTION public.invoice_share_link_view(
  p_token_hash TEXT,
  p_count_open BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_link_id UUID;
  v_tenant_id UUID;
  v_invoice_id UUID;
  v_expires_at TIMESTAMPTZ;
  v_result JSONB;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;

  SELECT l.id, l.tenant_id, l.invoice_id, l.expires_at
    INTO v_link_id, v_tenant_id, v_invoice_id, v_expires_at
    FROM public.invoice_share_links l
   WHERE l.token_hash = p_token_hash
     AND l.revoked_at IS NULL
     AND l.expires_at > pg_catalog.now();

  IF v_link_id IS NULL OR NOT public.invoice_shareable(v_tenant_id, v_invoice_id) THEN
    RETURN NULL;
  END IF;

  SELECT pg_catalog.jsonb_build_object(
    'link_id', v_link_id,
    'tenant_id', i.tenant_id,
    'invoice_id', i.id,
    'expires_at', v_expires_at,
    'ksef_environment', i.ksef_environment,
    'xml_storage_path', i.xml_storage_path,
    'xml_sha256', pg_catalog.lower(x.sha256_hash),
    'invoice', pg_catalog.jsonb_build_object(
      'internal_number', i.internal_number,
      'invoice_type', i.invoice_type,
      'invoice_kind', i.invoice_kind::text,
      'issue_date', i.issue_date,
      'sale_date', i.sale_date,
      'currency', i.currency,
      'net_total', i.net_total,
      'vat_total', i.vat_total,
      'gross_total', i.gross_total,
      'notes', i.notes,
      'ksef_number', i.ksef_number,
      'ksef_accepted_at', i.ksef_accepted_at,
      'split_payment', COALESCE(i.fa3_data -> 'annotations' -> 'splitPayment' = '1'::jsonb, false),
      'seller', pg_catalog.jsonb_build_object(
        'name', i.seller_data ->> 'name',
        'nip', i.seller_data ->> 'nip',
        'address_line1', i.seller_data -> 'address' ->> 'addressLine1',
        'address_line2', i.seller_data -> 'address' ->> 'addressLine2',
        'country_code', i.seller_data -> 'address' ->> 'countryCode'
      ),
      'buyer', pg_catalog.jsonb_build_object(
        'name', i.buyer_data ->> 'name',
        'nip', i.buyer_data ->> 'nip',
        'vat_ue_number', i.buyer_data ->> 'vatUeNumber',
        'address_line1', i.buyer_data -> 'address' ->> 'addressLine1',
        'address_line2', i.buyer_data -> 'address' ->> 'addressLine2',
        'country_code', i.buyer_data -> 'address' ->> 'countryCode'
      ),
      'payment', pg_catalog.jsonb_build_object(
        'method', i.payment_data ->> 'method',
        'due_date', i.payment_data ->> 'dueDate',
        'bank_account', i.payment_data ->> 'bankAccount',
        'bank_name', i.payment_data ->> 'bankName',
        'swift', i.payment_data ->> 'swift'
      ),
      'lines', COALESCE((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'ordinal', li.ordinal,
          'name', li.name,
          'unit', li.unit,
          'quantity', li.quantity,
          'unit_price_net', li.unit_price_net,
          'vat_rate', li.vat_rate,
          'net_amount', li.net_amount,
          'vat_amount', li.vat_amount,
          'gross_amount', li.gross_amount,
          -- 00210: PKWiU i GTU pozycji z dokumentu faktury (`fa3_data.lines`, po numerze
          -- pozycji), te same co w pliku FA(3); poprawność kodu sprawdza aplikacja.
          'pkwiu_code', d.pkwiu_code,
          'gtu_code', d.gtu_code
        ) ORDER BY li.ordinal)
          FROM public.invoice_line_items li
          LEFT JOIN LATERAL (
            SELECT l ->> 'pkwiuCode' AS pkwiu_code, l ->> 'gtuCode' AS gtu_code
              FROM pg_catalog.jsonb_array_elements(
                     CASE WHEN pg_catalog.jsonb_typeof(i.fa3_data -> 'lines') = 'array'
                          THEN i.fa3_data -> 'lines'
                          ELSE '[]'::jsonb
                     END
                   ) AS l
             WHERE l ->> 'ordinal' = li.ordinal::text
             LIMIT 1
          ) d ON true
         WHERE li.invoice_id = i.id
      ), '[]'::jsonb)
    )
  )
    INTO v_result
    FROM public.invoices i
    JOIN public.xml_documents x
      ON x.tenant_id = i.tenant_id
     AND x.invoice_id = i.id
     AND x.storage_path = i.xml_storage_path
   WHERE i.tenant_id = v_tenant_id
     AND i.id = v_invoice_id;

  IF v_result IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_count_open THEN
    UPDATE public.invoice_share_links
       SET open_count = open_count + 1,
           last_opened_at = pg_catalog.now()
     WHERE id = v_link_id
       AND revoked_at IS NULL;
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.invoice_share_link_view(TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_share_link_view(TEXT, BOOLEAN) TO service_role;

NOTIFY pgrst, 'reload schema';
