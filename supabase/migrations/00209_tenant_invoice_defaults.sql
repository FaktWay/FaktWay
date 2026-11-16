-- ═══════════════════════════════════════════════════════════════
-- 00209: domyślne ustawienia firmy dla nowej faktury (plan kompletnej
-- aplikacji, docs/koordynacja/PLAN-KOMPLETNA-APLIKACJA.md, krok 2.8 „Wygoda
-- wystawiania i wysyłki”, część: domyślne ustawienia).
--
-- KIEDY WGRAĆ: PRZED wdrożeniem kodu. Addytywna: jedna nowa tabela z polityką
-- RLS, bez zmian istniejących tabel, funkcji i indeksów. Stara wersja
-- aplikacji tabeli nie zna. Nowa wersja bez tabeli (PostgREST: PGRST205)
-- działa jak dotąd: formularz nowej faktury startuje od przelewu i 14 dni,
-- mail z fakturą idzie bez kopii do księgowej, a ekran ustawień pokazuje
-- ustawienia domyślne.
-- DROP/DML: brak. Bez DROP, TRUNCATE, DELETE i UPDATE przy wgraniu.
--
-- Po co: każda nowa faktura zaczynała od przelewu i 14 dni, a firma, która
-- zwykle płaci gotówką albo daje 30 dni, poprawiała to za każdym razem.
-- Księgowa dostawała faktury tylko wtedy, gdy ktoś jej je przesłał.
--
-- tenant_invoice_defaults: jeden wiersz na firmę (PK: tenant_id). Każde pole
--   może być puste, a puste znaczy „jak dotąd” (przelew, 14 dni, bez kopii).
--   payment_method: transfer, cash, card albo other (jak w formularzu faktury).
--   payment_days: termin płatności w dniach od wystawienia, 0 do 90.
--   accountant_copy_email: adres księgowej, do której idzie OSOBNA wiadomość
--   z kopią maila z fakturą (nie ukryta kopia: nabywca nie widzi adresu
--   księgowej, a księgowa nie dostaje adresu nabywcy; wysyła aplikacja,
--   `lib/invoices/invoice-copy-email.ts`). Format adresu sprawdza baza w
--   zakresie jednego adresu bez odstępów, resztę aplikacja.
--   updated_at, updated_by: kiedy i kto zmienił (osoba może zniknąć po
--   usunięciu konta). „Przywróć domyślne” usuwa wiersz.
--
-- To tylko PODPOWIEDZI dla nowego formularza i adres kopii: nic nie zmienia
-- kwot ani zapisanych faktur. Formularz bierze je, gdy nie ma podkładu
-- (podkład z faktury, faktura cykliczna i proforma mają pierwszeństwo).
--
-- RLS (public.get_current_tenant_id(): nagłówek x-active-org i aktywne
-- członkostwo, 00037): odczyt dla każdego aktywnego członka aktywnej firmy
-- (formularz i wysyłkę maila obsługuje też członek), zapis, zmiana
-- i usunięcie tylko dla właściciela i administratora (public.has_org_role,
-- 00037). Księgowa i członek nie zmienią ustawień. service_role ma pełny
-- dostęp. anon: nic.
--
-- Dane osobowe: adres e-mail księgowej (dane kontaktowe osoby trzeciej,
-- wpisane przez firmę). Znika z firmą (ON DELETE CASCADE) albo po „Przywróć
-- domyślne”. Eksport danych konta osoby go nie obejmuje: to dane firmy, nie
-- osoby (wpis `updated_by` wskazuje tylko, kto zmienił). Adres trafia do
-- audytu wysyłki kopii (`invoice.emailed`, `metadata.recipient`), jak adres
-- nabywcy.
--
-- Ponowienie: zapis to upsert po kluczu głównym, usunięcie jest idempotentne.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.tenant_invoice_defaults (
  tenant_id UUID PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  payment_method TEXT,
  payment_days INTEGER,
  accountant_copy_email TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT tenant_invoice_defaults_method_check CHECK (
    payment_method IS NULL OR payment_method IN ('transfer', 'cash', 'card', 'other')
  ),
  CONSTRAINT tenant_invoice_defaults_days_check CHECK (
    payment_days IS NULL OR payment_days BETWEEN 0 AND 90
  ),
  CONSTRAINT tenant_invoice_defaults_copy_email_check CHECK (
    accountant_copy_email IS NULL
    OR (char_length(accountant_copy_email) <= 254 AND accountant_copy_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
  )
);

COMMENT ON TABLE public.tenant_invoice_defaults IS
  'Domyślne ustawienia firmy dla nowej faktury (krok 2.8 planu kompletnej aplikacji, 00209): forma płatności, termin w dniach, adres księgowej dla kopii maila z fakturą. Puste pole = jak dotąd.';

ALTER TABLE public.tenant_invoice_defaults ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_invoice_defaults_select_members" ON public.tenant_invoice_defaults;
CREATE POLICY "tenant_invoice_defaults_select_members" ON public.tenant_invoice_defaults
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_current_tenant_id());

DROP POLICY IF EXISTS "tenant_invoice_defaults_insert_owner_admin" ON public.tenant_invoice_defaults;
CREATE POLICY "tenant_invoice_defaults_insert_owner_admin" ON public.tenant_invoice_defaults
  FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  );

DROP POLICY IF EXISTS "tenant_invoice_defaults_update_owner_admin" ON public.tenant_invoice_defaults;
CREATE POLICY "tenant_invoice_defaults_update_owner_admin" ON public.tenant_invoice_defaults
  FOR UPDATE TO authenticated
  USING (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  )
  WITH CHECK (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  );

DROP POLICY IF EXISTS "tenant_invoice_defaults_delete_owner_admin" ON public.tenant_invoice_defaults;
CREATE POLICY "tenant_invoice_defaults_delete_owner_admin" ON public.tenant_invoice_defaults
  FOR DELETE TO authenticated
  USING (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  );

REVOKE ALL ON public.tenant_invoice_defaults FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_invoice_defaults TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_invoice_defaults TO service_role;
