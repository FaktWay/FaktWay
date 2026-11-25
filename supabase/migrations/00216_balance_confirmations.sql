-- ═══════════════════════════════════════════════════════════════
-- 00216: potwierdzenie salda z kontrahentem (plan kompletnej aplikacji,
-- docs/koordynacja/PLAN-KOMPLETNA-APLIKACJA.md, krok 2.9, część 2, PR A;
-- decyzje D26, D27 i D28 w docs/koordynacja/DECYZJE-2026-11-25.md).
--
-- KIEDY WGRAĆ: PRZED wdrożeniem. Addytywna: dwie nowe tabele, nowe funkcje,
-- jeden wyzwalacz i wiersz wyłącznika balanceConfirmationsEnabled = false
-- w global_feature_flags (ON CONFLICT DO NOTHING). Bez DROP tabel i kolumn,
-- bez TRUNCATE, bez zmiany istniejących danych. Stara wersja aplikacji nowych
-- obiektów nie zna, a kod, który je woła (PR B i C), stoi za wyłącznikiem.
--
-- Dokument „Potwierdzenie salda” (PS/<kolejny>/<rok>) zestawia należności
-- firmy od jednego kontrahenta na dziś: faktury sprzedaży z kwotą brutto,
-- wpłatami i kwotą do zapłaty (D27). Nie jest fakturą ani notą, nie trafia do
-- KSeF, KPiR, ewidencji ani raportów. Treści dokumentu i odmów dla klienta
-- są w aplikacji (PR B); tu tylko kody odmów.
--
-- 1. Saldo liczy baza, nie klient. balance_confirmation_lines bierze faktury
--    aktywnej firmy z tym samym warunkiem co Pulpit i tabela Kontrahenci
--    (getReceivables w lib/dashboard/receivables.ts, widok invoices_overdue
--    z 00145, my_organizations_summary z 00185), zawężone do NIP kontrahenta
--    po normalizacji jak normalizeNip (lib/contractors/overview.ts):
--    sprzedaż z FaktWay (origin = app) przyjęta w KSeF w środowisku aplikacji
--    (argument, KSEF_ENV), pary rodzaj i typ VAT/UPR, ZAL, ROZ, bez faktury do
--    paragonu, bez dzieci tej firmy w dowolnym statusie (korekta przez
--    parent_invoice_id, ROZ przez advance_invoice_ids), stan płatności
--    otwarty, PLN albo bez waluty, do zapłaty po wpłatach powyżej zera.
--    Do zapłaty ROZ to reszta po zaliczkach z payment_data.amountDue (ten sam
--    wzór co wyzwalacz i widok z 00145). Kwoty co do grosza (round, numeric).
-- 2. Zestawienie nie milczy o fakturach, których nie umie policzyć
--    (protokół napraw, pkt 4). Faktury kontrahenta poza saldem, ale z kwotą
--    do zapłaty, trafiają na listę pominiętych z powodem:
--      corrected           faktura z korektą (saldo po korektach w osobnym PR, D27 K4);
--      correction_due      faktura korygująca z kwotą do zapłaty;
--      advance_settlement  zaliczka z fakturą rozliczającą, której nie ma
--                          w KSeF (szkic, odrzucona);
--      imported            faktura z importu bez daty zapłaty (FaktWay nie zna jej wpłat);
--      foreign_currency    faktura w walucie obcej.
--    Wystawienie z niepustą listą wymaga jawnego p_without_omitted = true
--    („Wystaw bez tych dokumentów”); lista zostaje w dokumencie i w audycie.
-- 3. Dokument powstaje tylko z treści, którą klient widział: podgląd
--    (balance_confirmation_preview) oddaje odcisk md5 całej treści (kontrahent,
--    firma, dzień salda, środowisko, pozycje, pominięte). Wystawienie liczy
--    treść od nowa i z innym odciskiem odmawia (changed). Ta sama treść drugi
--    raz (dwa kliknięcia, ponowienie) oddaje ten sam dokument i numer:
--    UNIQUE (tenant_id, fingerprint) i wyszukanie pod blokadą serii.
-- 4. Numer nadaje tylko issue_balance_confirmation: seria na firmę i rok dnia
--    salda, blokada transakcyjna serii, UNIQUE serii i CHECK zgodności numeru
--    z serią i datą. Dokument, audyt i numer w jednej transakcji.
-- 5. Wystawionego dokumentu nie zmienia nikt: klient ma tylko SELECT,
--    a wyzwalacz a_guard_balance_confirmation_update odrzuca każdą zmianę
--    treści, także kluczem serwisowym i właścicielem bazy (poza zerowaniem
--    kluczy obcych przy usunięciu kontrahenta albo konta, RODO). Poprawka to
--    nowy dokument. Błąd systemu: SQL-em jako postgres za zgodą Bartosza.
-- 6. Historia wysyłek mailem: balance_confirmation_emails, zapis tylko przez
--    record_balance_confirmation_email, raz na klucz idempotencji maila
--    (przedrostek saldo/<id>/), z audytem w tej samej transakcji.
--
-- Kto: każdy aktywny członek firmy (owner, admin, member, accountant), jak przy
-- notach (00193) i fakturach. Firma, rola i osoba z sesji
-- (get_current_tenant_id, has_org_role, auth.uid()), nigdy z argumentów.
-- Kontrahent i faktury tylko aktywnej firmy; kontrahent innej firmy wygląda
-- jak brak kontrahenta.
--
-- Wyłącznik (D27 i D28 mają średnią pewność: zakres potwierdza księgowa, tekst
-- prawnik): podgląd i wystawienie odmawiają (disabled), dopóki w
-- global_feature_flags nie ma balanceConfirmationsEnabled = true. Odczyt
-- wystawionych dokumentów i zapis wysyłki działają zawsze.
--
-- Odmowy (status refused, kod): disabled, contractor_not_found,
-- contractor_nip_missing, contractor_incomplete, issuer_incomplete,
-- environment_unknown (przyjęta faktura kontrahenta bez środowiska KSeF,
-- jak błąd getReceivables), too_many, changed, nothing_due,
-- omitted_not_confirmed. Nieznane środowisko w argumencie to błąd wywołania
-- 22023, nie puste saldo.
--
-- Uprawnienia: domyślne granty Supabase dają nowej tabeli ALL (także TRUNCATE,
-- które omija RLS) i nowej funkcji EXECUTE dla anon i authenticated, dlatego
-- najpierw REVOKE ALL, potem jawne granty. service_role czyta obie tabele
-- (nocna kopia). Funkcje wewnętrzne (firma w argumencie) wykonuje tylko
-- właściciel, czyli funkcje SECURITY DEFINER z tej migracji.
-- ═══════════════════════════════════════════════════════════════

-- ─── Białe znaki i NIP jak normalizeNip ─────────────────────────
-- Te same znaki co \s w JavaScript (lib/contractors/overview.ts,
-- normalizeNip): tabulator do CR, spacja, NBSP, U+1680, U+2000-U+200A,
-- U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF (pilnuje test
-- tests/unit/saldo-migracja.test.ts).
CREATE OR REPLACE FUNCTION public.balance_confirmation_strip_space(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT regexp_replace(
    p_value,
    '[' || chr(9) || '-' || chr(13) || chr(32) || chr(160) || chr(5760) || chr(8192) || '-' || chr(8202)
        || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279) || ']',
    '',
    'g'
  );
$$;

COMMENT ON FUNCTION public.balance_confirmation_strip_space(text) IS
  '00216: usuwa białe znaki z tego samego zbioru co \s w JavaScript (normalizeNip).';

CREATE OR REPLACE FUNCTION public.balance_confirmation_nip(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT NULLIF(upper(replace(public.balance_confirmation_strip_space(p_value), '-', '')), '');
$$;

COMMENT ON FUNCTION public.balance_confirmation_nip(text) IS
  '00216: NIP do porównań jak normalizeNip: bez białych znaków i myślników, wielkie litery; pusty to NULL.';

-- NIP nabywcy faktury jak buyerNipOf (lib/dashboard/receivables.ts):
-- buyer_nip, gdy nie jest pusty, a bez niego buyer_data.nip (tylko tekst).
CREATE OR REPLACE FUNCTION public.balance_confirmation_buyer_nip(p_buyer_nip text, p_buyer_data jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN public.balance_confirmation_strip_space(p_buyer_nip) <> '' THEN public.balance_confirmation_nip(p_buyer_nip)
    WHEN jsonb_typeof(p_buyer_data -> 'nip') = 'string' THEN public.balance_confirmation_nip(p_buyer_data ->> 'nip')
  END;
$$;

COMMENT ON FUNCTION public.balance_confirmation_buyer_nip(text, jsonb) IS
  '00216: znormalizowany NIP nabywcy faktury jak buyerNipOf i normalizeNip w aplikacji.';

-- ─── Funkcje sprawdzające treść dokumentu (CHECK) ───────────────
-- CASE pilnuje kolejności: najpierw typ, dopiero potem rzutowanie na liczbę,
-- żeby zła treść kończyła się naruszeniem CHECK, a nie błędem rzutowania.
CREATE OR REPLACE FUNCTION public.balance_confirmation_items_valid(p_items jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN false
    WHEN jsonb_array_length(p_items) NOT BETWEEN 1 AND 1000 THEN false
    ELSE NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_items) AS e(item)
       WHERE CASE
         WHEN jsonb_typeof(e.item) IS DISTINCT FROM 'object' THEN true
         WHEN (SELECT count(*) FROM jsonb_object_keys(e.item)) <> 11 THEN true
         WHEN NOT (e.item ?& ARRAY['invoiceId', 'number', 'ksefNumber', 'issueDate', 'dueDate', 'kind', 'type',
                                   'gross', 'amountDue', 'paid', 'outstanding']) THEN true
         WHEN jsonb_typeof(e.item -> 'invoiceId') IS DISTINCT FROM 'string'
           OR (e.item ->> 'invoiceId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN true
         WHEN jsonb_typeof(e.item -> 'number') IS DISTINCT FROM 'string'
           OR char_length(btrim(e.item ->> 'number')) NOT BETWEEN 1 AND 256 THEN true
         WHEN jsonb_typeof(e.item -> 'ksefNumber') NOT IN ('string', 'null') THEN true
         WHEN jsonb_typeof(e.item -> 'ksefNumber') = 'string' AND char_length(e.item ->> 'ksefNumber') > 64 THEN true
         WHEN jsonb_typeof(e.item -> 'issueDate') IS DISTINCT FROM 'string'
           OR (e.item ->> 'issueDate') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN true
         WHEN jsonb_typeof(e.item -> 'dueDate') NOT IN ('string', 'null') THEN true
         WHEN jsonb_typeof(e.item -> 'dueDate') = 'string'
              AND (e.item ->> 'dueDate') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN true
         WHEN NOT COALESCE(
                (e.item ->> 'kind' = 'regular' AND e.item ->> 'type' IN ('VAT', 'UPR'))
                OR (e.item ->> 'kind' = 'advance' AND e.item ->> 'type' = 'ZAL')
                OR (e.item ->> 'kind' = 'final' AND e.item ->> 'type' = 'ROZ'),
                false) THEN true
         WHEN jsonb_typeof(e.item -> 'gross') IS DISTINCT FROM 'number'
           OR jsonb_typeof(e.item -> 'amountDue') IS DISTINCT FROM 'number'
           OR jsonb_typeof(e.item -> 'paid') IS DISTINCT FROM 'number'
           OR jsonb_typeof(e.item -> 'outstanding') IS DISTINCT FROM 'number' THEN true
         WHEN (e.item ->> 'gross')::numeric <= 0
           OR (e.item ->> 'gross')::numeric > 1000000000
           OR (e.item ->> 'amountDue')::numeric < 0
           OR (e.item ->> 'paid')::numeric < 0
           OR (e.item ->> 'outstanding')::numeric <= 0 THEN true
         WHEN (e.item ->> 'gross')::numeric <> round((e.item ->> 'gross')::numeric, 2)
           OR (e.item ->> 'amountDue')::numeric <> round((e.item ->> 'amountDue')::numeric, 2)
           OR (e.item ->> 'paid')::numeric <> round((e.item ->> 'paid')::numeric, 2)
           OR (e.item ->> 'outstanding')::numeric <> round((e.item ->> 'outstanding')::numeric, 2) THEN true
         -- Do zapłaty nie więcej niż brutto; poza ROZ do zapłaty to całe brutto (amountDueOf).
         WHEN (e.item ->> 'amountDue')::numeric > (e.item ->> 'gross')::numeric THEN true
         WHEN e.item ->> 'kind' <> 'final'
              AND (e.item ->> 'amountDue')::numeric <> (e.item ->> 'gross')::numeric THEN true
         -- Do zapłaty po wpłatach = do zapłaty z faktury minus wpłaty (outstandingOf).
         WHEN (e.item ->> 'outstanding')::numeric
              <> (e.item ->> 'amountDue')::numeric - (e.item ->> 'paid')::numeric THEN true
         ELSE false
       END
    )
  END;
$$;

COMMENT ON FUNCTION public.balance_confirmation_items_valid(jsonb) IS
  '00216: pozycje potwierdzenia salda: 1-1000 faktur {invoiceId, number, ksefNumber, issueDate, dueDate, kind, type, gross, amountDue, paid, outstanding}; rodzaje VAT/UPR, ZAL, ROZ; kwoty do grosza; outstanding = amountDue - paid > 0.';

CREATE OR REPLACE FUNCTION public.balance_confirmation_items_total(p_items jsonb)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN NULL
    ELSE (
      SELECT COALESCE(sum(CASE WHEN jsonb_typeof(e.item -> 'outstanding') = 'number'
                               THEN (e.item ->> 'outstanding')::numeric END), 0)
        FROM jsonb_array_elements(p_items) AS e(item)
    )
  END;
$$;

COMMENT ON FUNCTION public.balance_confirmation_items_total(jsonb) IS
  '00216: saldo dokumentu: suma kwot do zapłaty pozycji (CHECK balance_confirmations_total_check).';

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
                                                    'foreign_currency'), false) THEN true
         ELSE false
       END
    )
  END;
$$;

COMMENT ON FUNCTION public.balance_confirmation_omitted_valid(jsonb) IS
  '00216: faktury pominięte w potwierdzeniu salda: do 5000 {invoiceId, number, ksefNumber, issueDate, kind, type, currency, gross, reason} z powodem corrected, correction_due, advance_settlement, imported albo foreign_currency.';

CREATE OR REPLACE FUNCTION public.balance_confirmation_party_valid(p_party jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_party) IS DISTINCT FROM 'object' THEN false
    ELSE char_length(btrim(COALESCE(p_party ->> 'name', ''))) BETWEEN 1 AND 512
     AND char_length(btrim(COALESCE(p_party ->> 'nip', ''))) BETWEEN 1 AND 32
     AND char_length(COALESCE(p_party ->> 'addressLine1', '')) <= 512
     AND char_length(COALESCE(p_party ->> 'addressLine2', '')) <= 512
     AND char_length(COALESCE(p_party ->> 'email', '')) <= 254
  END;
$$;

COMMENT ON FUNCTION public.balance_confirmation_party_valid(jsonb) IS
  '00216: migawka strony dokumentu (firma, kontrahent): nazwa i NIP niepuste, adres do 512 znaków na wiersz, e-mail do 254.';

REVOKE ALL ON FUNCTION public.balance_confirmation_strip_space(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.balance_confirmation_nip(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.balance_confirmation_buyer_nip(text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.balance_confirmation_items_valid(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.balance_confirmation_items_total(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.balance_confirmation_omitted_valid(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.balance_confirmation_party_valid(jsonb) FROM PUBLIC, anon;
-- Czyste funkcje bez dostępu do danych; CHECK wykonuje je z uprawnieniami piszącego (serwis w testach i kopii).
GRANT EXECUTE ON FUNCTION public.balance_confirmation_strip_space(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.balance_confirmation_nip(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.balance_confirmation_buyer_nip(text, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.balance_confirmation_items_valid(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.balance_confirmation_items_total(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.balance_confirmation_omitted_valid(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.balance_confirmation_party_valid(jsonb) TO authenticated, service_role;

-- ─── balance_confirmations: wystawione dokumenty ────────────────
CREATE TABLE public.balance_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  contractor_id uuid,
  -- Numer PS/<kolejny>/<rok> nadaje tylko issue_balance_confirmation.
  number text NOT NULL,
  number_year integer NOT NULL,
  number_seq integer NOT NULL,
  -- Dzień salda (w tej wersji dzień wystawienia w Polsce).
  as_of date NOT NULL,
  ksef_environment text NOT NULL,
  currency text NOT NULL DEFAULT 'PLN',
  counterparty jsonb NOT NULL,
  issuer jsonb NOT NULL,
  items jsonb NOT NULL,
  total numeric(14,2) NOT NULL,
  omitted jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- md5 treści, którą klient widział w podglądzie (balance_confirmation_build).
  fingerprint text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  -- SET NULL przy usunięciu konta (RODO, jak 00154 i 00193).
  issued_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT balance_confirmations_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT balance_confirmations_number_unique UNIQUE (tenant_id, number_year, number_seq),
  CONSTRAINT balance_confirmations_fingerprint_unique UNIQUE (tenant_id, fingerprint),
  CONSTRAINT balance_confirmations_contractor_same_tenant_fk
    FOREIGN KEY (tenant_id, contractor_id)
    REFERENCES public.contractors (tenant_id, id)
    ON DELETE SET NULL (contractor_id),
  CONSTRAINT balance_confirmations_number_check CHECK (
    number_seq >= 1
    AND number_year = EXTRACT(YEAR FROM as_of)::integer
    AND number = 'PS/' || number_seq::text || '/' || number_year::text
  ),
  CONSTRAINT balance_confirmations_as_of_check CHECK (as_of >= DATE '2026-01-01'),
  CONSTRAINT balance_confirmations_environment_check CHECK (ksef_environment IN ('test', 'demo', 'production')),
  -- W tej wersji tylko złote (faktury w walucie obcej są na liście pominiętych).
  CONSTRAINT balance_confirmations_currency_check CHECK (currency = 'PLN'),
  CONSTRAINT balance_confirmations_counterparty_check CHECK (public.balance_confirmation_party_valid(counterparty)),
  CONSTRAINT balance_confirmations_issuer_check CHECK (public.balance_confirmation_party_valid(issuer)),
  CONSTRAINT balance_confirmations_items_check CHECK (public.balance_confirmation_items_valid(items)),
  CONSTRAINT balance_confirmations_total_check CHECK (total > 0 AND total = public.balance_confirmation_items_total(items)),
  CONSTRAINT balance_confirmations_omitted_check CHECK (public.balance_confirmation_omitted_valid(omitted)),
  CONSTRAINT balance_confirmations_fingerprint_check CHECK (fingerprint ~ '^[0-9a-f]{32}$')
);

COMMENT ON TABLE public.balance_confirmations IS
  '00216 (krok 2.9 cz. 2): wystawione potwierdzenie salda z kontrahentem (należności na dzień salda). Nie jest fakturą ani notą, nie trafia do KSeF, KPiR ani raportów. Powstaje tylko przez issue_balance_confirmation; wystawionego nie zmienia nikt (wyzwalacz a_guard_balance_confirmation_update).';
COMMENT ON COLUMN public.balance_confirmations.items IS
  '00216: migawka pozycji z chwili wystawienia: invoiceId, number, ksefNumber, issueDate, dueDate, kind, type, gross, amountDue (dla ROZ reszta po zaliczkach), paid, outstanding.';
COMMENT ON COLUMN public.balance_confirmations.omitted IS
  '00216: faktury kontrahenta, których saldo nie obejmuje, z powodem (corrected, correction_due, advance_settlement, imported, foreign_currency); wystawione świadomie (p_without_omitted).';
COMMENT ON COLUMN public.balance_confirmations.counterparty IS
  '00216: migawka kontrahenta z bazy firmy w chwili wystawienia: name, nip, countryCode, addressLine1, addressLine2, email.';
COMMENT ON COLUMN public.balance_confirmations.issuer IS
  '00216: migawka danych firmy (tenants) w chwili wystawienia: name, nip, countryCode, addressLine1, addressLine2.';

CREATE INDEX idx_balance_confirmations_tenant_issued
  ON public.balance_confirmations (tenant_id, issued_at DESC);
CREATE INDEX idx_balance_confirmations_contractor
  ON public.balance_confirmations (tenant_id, contractor_id, issued_at DESC);

-- ─── wyzwalacz: wystawionego dokumentu nie zmienia nikt ─────────
-- Bez wyjątku dla roli (także service_role, postgres i akcja klucza obcego).
-- Wolne są tylko zerowania kluczy obcych (usunięcie kontrahenta albo konta).
-- Nowe kolumny są zamrożone z automatu: porównanie całego wiersza poza listą
-- wolnych kolumn.
CREATE OR REPLACE FUNCTION public.guard_balance_confirmation_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_free constant text[] := ARRAY['contractor_id', 'issued_by'];
BEGIN
  IF (to_jsonb(NEW) - v_free) IS DISTINCT FROM (to_jsonb(OLD) - v_free)
     OR (NEW.contractor_id IS NOT NULL AND NEW.contractor_id IS DISTINCT FROM OLD.contractor_id)
     OR (NEW.issued_by IS NOT NULL AND NEW.issued_by IS DISTINCT FROM OLD.issued_by) THEN
    RAISE EXCEPTION 'Balance confirmation % is final; issue a new balance confirmation instead of editing it', OLD.number
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_balance_confirmation_update() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER a_guard_balance_confirmation_update
  BEFORE UPDATE ON public.balance_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.guard_balance_confirmation_update();

-- ─── RLS: odczyt członków aktywnej firmy, zapis tylko przez RPC ─
ALTER TABLE public.balance_confirmations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "balance_confirmations_select_own_tenant" ON public.balance_confirmations
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_current_tenant_id());

REVOKE ALL ON public.balance_confirmations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.balance_confirmations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.balance_confirmations TO service_role;

-- ─── balance_confirmation_emails: historia wysyłek mailem ───────
CREATE TABLE public.balance_confirmation_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  confirmation_id uuid NOT NULL,
  recipient text NOT NULL,
  -- Klucz idempotencji maila (Resend, 24 h): dokument, skrót adresu i numer wysyłki.
  idempotency_key text NOT NULL,
  provider_message_id text,
  sent_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT balance_confirmation_emails_key_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT balance_confirmation_emails_confirmation_fk
    FOREIGN KEY (tenant_id, confirmation_id)
    REFERENCES public.balance_confirmations (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT balance_confirmation_emails_recipient_check CHECK (
    char_length(recipient) BETWEEN 3 AND 254
    AND recipient = lower(recipient)
    AND recipient ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  CONSTRAINT balance_confirmation_emails_key_check CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  CONSTRAINT balance_confirmation_emails_message_check CHECK (
    provider_message_id IS NULL OR char_length(provider_message_id) BETWEEN 1 AND 200
  )
);

COMMENT ON TABLE public.balance_confirmation_emails IS
  '00216 (krok 2.9 cz. 2): wysyłki potwierdzenia salda mailem do kontrahenta. Zapis tylko RPC record_balance_confirmation_email, raz na klucz idempotencji maila.';

CREATE INDEX idx_balance_confirmation_emails_confirmation
  ON public.balance_confirmation_emails (tenant_id, confirmation_id, sent_at);

ALTER TABLE public.balance_confirmation_emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY "balance_confirmation_emails_select_own_tenant" ON public.balance_confirmation_emails
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_current_tenant_id());

REVOKE ALL ON public.balance_confirmation_emails FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.balance_confirmation_emails TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.balance_confirmation_emails TO service_role;

-- ─── Funkcje wewnętrzne: firma z sesji, pozycje, treść z odciskiem ─
-- Firma, osoba i rola z sesji; każdy aktywny członek jak przy notach (00193).
CREATE OR REPLACE FUNCTION public.balance_confirmation_session_tenant()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Balance confirmations require a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_org_role(v_tenant_id, 'owner')
          OR public.has_org_role(v_tenant_id, 'admin')
          OR public.has_org_role(v_tenant_id, 'member')
          OR public.has_org_role(v_tenant_id, 'accountant')) THEN
    RAISE EXCEPTION 'Insufficient role for balance confirmations' USING ERRCODE = '42501';
  END IF;
  RETURN v_tenant_id;
END;
$$;

COMMENT ON FUNCTION public.balance_confirmation_session_tenant() IS
  '00216: aktywna firma z sesji (nagłówek x-active-org) dla aktywnego członka z rolą owner, admin, member albo accountant; inaczej 42501.';

-- Pozycje i pominięte faktury jednej firmy dla jednego NIP (warunek jak
-- getReceivables; opis w nagłówku, pkt 1 i 2). Kolejność: data wystawienia,
-- numer, id.
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
       AND i.ksef_status = 'accepted'
       AND i.ksef_environment = p_ksef_environment
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
             WHEN p.invoice_kind = 'correction' THEN 'correction_due'
             WHEN NOT COALESCE(p.rodzaj_naleznosci, false) THEN NULL
             WHEN p.ma_korekte THEN 'corrected'
             WHEN p.ma_rozliczenie THEN CASE WHEN NOT p.rozliczenie_w_ksef THEN 'advance_settlement' END
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
  '00216: pozycje (należności jak getReceivables) i pominięte faktury jednej firmy dla jednego NIP nabywcy; tylko wewnątrz funkcji SECURITY DEFINER tej migracji.';

-- Cała treść dokumentu z odciskiem albo odmowa z kodem; dla podglądu
-- i wystawienia ta sama droga, więc odcisk podglądu zgadza się z wystawieniem,
-- dopóki dane się nie zmienią.
CREATE OR REPLACE FUNCTION public.balance_confirmation_build(
  p_tenant_id uuid,
  p_contractor_id uuid,
  p_ksef_environment text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  -- Dzień salda: dziś w Polsce, nie w strefie serwera.
  v_today date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_contractor public.contractors%ROWTYPE;
  v_tenant public.tenants%ROWTYPE;
  v_nip text;
  v_counterparty jsonb;
  v_issuer jsonb;
  v_unknown integer;
  v_lines jsonb;
  v_total numeric;
  v_fingerprint text;
BEGIN
  SELECT * INTO v_contractor
    FROM public.contractors AS k
   WHERE k.id = p_contractor_id
     AND k.tenant_id = p_tenant_id;
  -- Kontrahent innej firmy wygląda jak brak kontrahenta.
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'contractor_not_found');
  END IF;
  v_nip := public.balance_confirmation_nip(v_contractor.nip);
  IF v_nip IS NULL THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'contractor_nip_missing');
  END IF;
  v_counterparty := jsonb_build_object(
    'name', btrim(COALESCE(v_contractor.name, '')),
    'nip', btrim(COALESCE(v_contractor.nip, '')),
    'countryCode', COALESCE(NULLIF(btrim(COALESCE(v_contractor.address ->> 'countryCode', '')), ''), 'PL'),
    'addressLine1', btrim(COALESCE(v_contractor.address ->> 'addressLine1', '')),
    'addressLine2', btrim(COALESCE(v_contractor.address ->> 'addressLine2', '')),
    'email', NULLIF(btrim(COALESCE(v_contractor.email, '')), '')
  );
  IF NOT public.balance_confirmation_party_valid(v_counterparty) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'contractor_incomplete');
  END IF;

  SELECT * INTO v_tenant
    FROM public.tenants AS t
   WHERE t.id = p_tenant_id;
  v_issuer := jsonb_build_object(
    'name', btrim(COALESCE(v_tenant.name, '')),
    'nip', btrim(COALESCE(v_tenant.nip, '')),
    'countryCode', COALESCE(NULLIF(btrim(COALESCE(v_tenant.address_json ->> 'countryCode', '')), ''), 'PL'),
    'addressLine1', btrim(COALESCE(v_tenant.address_json ->> 'addressLine1', '')),
    'addressLine2', btrim(COALESCE(v_tenant.address_json ->> 'addressLine2', ''))
  );
  IF v_issuer ->> 'addressLine1' = '' OR v_issuer ->> 'addressLine2' = ''
     OR NOT public.balance_confirmation_party_valid(v_issuer) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'issuer_incomplete');
  END IF;

  -- Przyjęta faktura kontrahenta bez znanego środowiska KSeF to błąd danych,
  -- nie ciche zero (jak getReceivables): te same kandydatki należności.
  SELECT count(*) INTO v_unknown
    FROM public.invoices AS i
   WHERE i.tenant_id = p_tenant_id
     AND i.direction = 'outgoing'
     AND i.origin = 'app'
     AND i.ksef_status = 'accepted'
     AND i.payment_status IN ('unpaid', 'partial', 'overdue')
     AND i.invoice_kind IN ('regular', 'advance', 'final')
     AND i.invoice_type IN ('VAT', 'UPR', 'ZAL', 'ROZ')
     AND i.gross_total > 0
     AND (i.ksef_environment IS NULL OR i.ksef_environment NOT IN ('test', 'demo', 'production'))
     AND public.balance_confirmation_buyer_nip(i.buyer_nip, i.buyer_data) = v_nip;
  IF v_unknown > 0 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'environment_unknown', 'count', v_unknown);
  END IF;

  v_lines := public.balance_confirmation_lines(p_tenant_id, v_nip, p_ksef_environment);
  IF jsonb_array_length(v_lines -> 'items') > 1000 OR jsonb_array_length(v_lines -> 'omitted') > 5000 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'too_many');
  END IF;
  SELECT COALESCE(sum((e.item ->> 'outstanding')::numeric), 0) INTO v_total
    FROM jsonb_array_elements(v_lines -> 'items') AS e(item);

  v_fingerprint := md5(jsonb_build_object(
    'version', 1,
    'contractorId', p_contractor_id,
    'asOf', v_today,
    'environment', p_ksef_environment,
    'counterparty', v_counterparty,
    'issuer', v_issuer,
    'items', v_lines -> 'items',
    'omitted', v_lines -> 'omitted'
  )::text);

  RETURN jsonb_build_object(
    'status', 'ok',
    'contractor_id', p_contractor_id,
    'as_of', v_today,
    'environment', p_ksef_environment,
    'currency', 'PLN',
    'counterparty', v_counterparty,
    'issuer', v_issuer,
    'items', v_lines -> 'items',
    'omitted', v_lines -> 'omitted',
    'total', v_total,
    'fingerprint', v_fingerprint
  );
END;
$$;

COMMENT ON FUNCTION public.balance_confirmation_build(uuid, uuid, text) IS
  '00216: treść potwierdzenia salda (kontrahent, firma, dzień salda, pozycje, pominięte, saldo) z odciskiem md5 albo odmowa z kodem; tylko wewnątrz funkcji SECURITY DEFINER tej migracji.';

REVOKE ALL ON FUNCTION public.balance_confirmation_session_tenant() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.balance_confirmation_lines(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.balance_confirmation_build(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

-- ─── RPC: podgląd (saldo liczone w bazie, bez zapisu) ───────────
CREATE OR REPLACE FUNCTION public.balance_confirmation_preview(
  p_contractor_id uuid,
  p_ksef_environment text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
BEGIN
  v_tenant_id := public.balance_confirmation_session_tenant();
  -- Środowisko z aplikacji (KSEF_ENV). Inna wartość to błąd wywołania, a nie puste saldo.
  IF p_ksef_environment IS NULL OR p_ksef_environment NOT IN ('test', 'demo', 'production') THEN
    RAISE EXCEPTION 'Balance confirmation: unknown KSeF environment' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.global_feature_flags AS g
     WHERE g.flag = 'balanceConfirmationsEnabled' AND g.enabled
  ) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'disabled');
  END IF;
  RETURN public.balance_confirmation_build(v_tenant_id, p_contractor_id, p_ksef_environment);
END;
$$;

COMMENT ON FUNCTION public.balance_confirmation_preview(uuid, text) IS
  '00216: podgląd potwierdzenia salda kontrahenta aktywnej firmy: pozycje, pominięte, saldo i odcisk treści do wystawienia. Bez zapisu.';

REVOKE ALL ON FUNCTION public.balance_confirmation_preview(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.balance_confirmation_preview(uuid, text) TO authenticated;

-- ─── RPC: wystawienie (numer, migawka, audyt) ───────────────────
CREATE OR REPLACE FUNCTION public.issue_balance_confirmation(
  p_contractor_id uuid,
  p_ksef_environment text,
  p_fingerprint text,
  p_without_omitted boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_snapshot jsonb;
  v_as_of date;
  v_year integer;
  v_seq integer;
  v_number text;
  v_existing public.balance_confirmations%ROWTYPE;
  v_id uuid;
  v_item_count integer;
  v_omitted_count integer;
BEGIN
  v_tenant_id := public.balance_confirmation_session_tenant();
  IF p_ksef_environment IS NULL OR p_ksef_environment NOT IN ('test', 'demo', 'production') THEN
    RAISE EXCEPTION 'Balance confirmation: unknown KSeF environment' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.global_feature_flags AS g
     WHERE g.flag = 'balanceConfirmationsEnabled' AND g.enabled
  ) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'disabled');
  END IF;

  -- Treść liczona od nowa w bazie; liczb od klienta nie bierzemy.
  v_snapshot := public.balance_confirmation_build(v_tenant_id, p_contractor_id, p_ksef_environment);
  IF v_snapshot ->> 'status' IS DISTINCT FROM 'ok' THEN
    RETURN v_snapshot;
  END IF;
  -- Klient wystawia tylko to, co widział w podglądzie.
  IF p_fingerprint IS NULL OR p_fingerprint IS DISTINCT FROM v_snapshot ->> 'fingerprint' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'changed');
  END IF;
  v_item_count := jsonb_array_length(v_snapshot -> 'items');
  IF v_item_count = 0 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'nothing_due');
  END IF;
  v_omitted_count := jsonb_array_length(v_snapshot -> 'omitted');
  IF v_omitted_count > 0 AND p_without_omitted IS DISTINCT FROM true THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'omitted_not_confirmed', 'omitted_count', v_omitted_count);
  END IF;

  -- Jedna seria na firmę i rok dnia salda. Blokada transakcyjna serii, potem
  -- wyszukanie tej samej treści i kolejny numer: w READ COMMITTED każde
  -- polecenie funkcji widzi dokumenty zatwierdzone przez poprzednika.
  -- UNIQUE serii i odcisku pilnują dubli także bez blokady.
  v_as_of := (v_snapshot ->> 'as_of')::date;
  v_year := EXTRACT(YEAR FROM v_as_of)::integer;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('balance_confirmation:' || v_tenant_id::text || ':' || v_year::text, 0)
  );

  SELECT * INTO v_existing
    FROM public.balance_confirmations AS b
   WHERE b.tenant_id = v_tenant_id
     AND b.fingerprint = v_snapshot ->> 'fingerprint';
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'already_issued', 'id', v_existing.id, 'number', v_existing.number);
  END IF;

  SELECT COALESCE(max(b.number_seq), 0) + 1 INTO v_seq
    FROM public.balance_confirmations AS b
   WHERE b.tenant_id = v_tenant_id
     AND b.number_year = v_year;
  v_number := 'PS/' || v_seq::text || '/' || v_year::text;

  INSERT INTO public.balance_confirmations (
    tenant_id, contractor_id, number, number_year, number_seq, as_of, ksef_environment, currency,
    counterparty, issuer, items, total, omitted, fingerprint, issued_by
  ) VALUES (
    v_tenant_id, p_contractor_id, v_number, v_year, v_seq, v_as_of, p_ksef_environment, 'PLN',
    v_snapshot -> 'counterparty', v_snapshot -> 'issuer', v_snapshot -> 'items',
    (v_snapshot ->> 'total')::numeric, v_snapshot -> 'omitted', v_snapshot ->> 'fingerprint', auth.uid()
  )
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant_id, auth.uid(), 'balance_confirmation.issued', 'balance_confirmation', v_id,
    jsonb_build_object(
      'number', v_number,
      'asOf', v_as_of,
      'contractorId', p_contractor_id,
      'total', (v_snapshot ->> 'total')::numeric,
      'items', v_item_count,
      'omitted', v_omitted_count,
      'environment', p_ksef_environment
    )
  );

  RETURN jsonb_build_object('status', 'issued', 'id', v_id, 'number', v_number);
END;
$$;

COMMENT ON FUNCTION public.issue_balance_confirmation(uuid, text, text, boolean) IS
  '00216: wystawia potwierdzenie salda z treści liczonej w bazie, tylko dla odcisku z podglądu; kolejny numer PS/n/rok, migawka i audyt balance_confirmation.issued w jednej transakcji. Ta sama treść drugi raz oddaje ten sam dokument.';

REVOKE ALL ON FUNCTION public.issue_balance_confirmation(uuid, text, text, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.issue_balance_confirmation(uuid, text, text, boolean) TO authenticated;

-- ─── RPC: zapis wysyłki mailem (raz na klucz, audyt) ────────────
CREATE OR REPLACE FUNCTION public.record_balance_confirmation_email(
  p_confirmation_id uuid,
  p_recipient text,
  p_idempotency_key text,
  p_provider_message_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_doc public.balance_confirmations%ROWTYPE;
  v_recipient text := lower(btrim(COALESCE(p_recipient, '')));
  v_message_id text := NULLIF(btrim(COALESCE(p_provider_message_id, '')), '');
  v_prefix text;
  v_email_id uuid;
BEGIN
  v_tenant_id := public.balance_confirmation_session_tenant();

  SELECT * INTO v_doc
    FROM public.balance_confirmations AS b
   WHERE b.id = p_confirmation_id
     AND b.tenant_id = v_tenant_id;
  -- Dokument innej firmy wygląda jak brak dokumentu.
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_found');
  END IF;
  -- Klucz tego dokumentu (PR B: lib/saldo/mail.ts).
  v_prefix := 'saldo/' || p_confirmation_id::text || '/';
  IF p_idempotency_key IS NULL OR left(p_idempotency_key, char_length(v_prefix)) IS DISTINCT FROM v_prefix THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_key');
  END IF;

  INSERT INTO public.balance_confirmation_emails (
    tenant_id, confirmation_id, recipient, idempotency_key, provider_message_id, sent_by
  ) VALUES (
    v_tenant_id, p_confirmation_id, v_recipient, p_idempotency_key, v_message_id, auth.uid()
  )
  ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_email_id;

  -- Ponowienie z tym samym kluczem: wysyłka jest już w historii, bez drugiego wpisu i audytu.
  IF v_email_id IS NULL THEN
    RETURN jsonb_build_object('status', 'already_recorded');
  END IF;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant_id, auth.uid(), 'balance_confirmation.emailed', 'balance_confirmation', p_confirmation_id,
    jsonb_build_object(
      'number', v_doc.number,
      'recipient', v_recipient,
      'emailId', v_email_id,
      'providerMessageId', v_message_id
    )
  );

  RETURN jsonb_build_object('status', 'recorded', 'email_id', v_email_id);
END;
$$;

COMMENT ON FUNCTION public.record_balance_confirmation_email(uuid, text, text, text) IS
  '00216: zapisuje wysyłkę potwierdzenia salda mailem (raz na klucz idempotencji) i audyt balance_confirmation.emailed w jednej transakcji.';

REVOKE ALL ON FUNCTION public.record_balance_confirmation_email(uuid, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_balance_confirmation_email(uuid, text, text, text) TO authenticated;

-- ─── Wyłącznik: wiersz wyłączony ────────────────────────────────
-- WŁĄCZNIK, nie hamulec: false albo brak wiersza = podgląd i wystawienie
-- odmawiają (disabled). Włącza Bartosz po potwierdzeniu zakresu przez
-- księgową (D27) i tekstu przez prawnika (D28).
INSERT INTO public.global_feature_flags (flag, enabled, note)
VALUES (
  'balanceConfirmationsEnabled',
  false,
  'Potwierdzenie salda z kontrahentem (krok 2.9 cz. 2 planu kompletnej aplikacji, migracja 00216). '
  'Włączyć po potwierdzeniu zakresu przez księgową (D27) i tekstu dokumentu przez prawnika (D28).'
)
ON CONFLICT (flag) DO NOTHING;

NOTIFY pgrst, 'reload schema';
