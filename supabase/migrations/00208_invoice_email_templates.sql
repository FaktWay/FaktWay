-- ═══════════════════════════════════════════════════════════════
-- 00208: własny szablon maila z fakturą (plan kompletnej aplikacji,
-- docs/koordynacja/PLAN-KOMPLETNA-APLIKACJA.md, krok 2.8 „Wygoda wystawiania
-- i wysyłki”, część: własny szablon maila).
--
-- KIEDY WGRAĆ: PRZED wdrożeniem kodu. Addytywna: jedna nowa tabela z polityką
-- RLS, bez zmian istniejących tabel, funkcji i indeksów. Stara wersja
-- aplikacji tabeli nie zna. Nowa wersja bez tabeli (PostgREST: PGRST205)
-- wysyła mail domyślny (odczyt szablonu zwraca brak), a ekran ustawień
-- pokazuje szablon domyślny.
-- DROP/DML: brak. Bez DROP, TRUNCATE, DELETE i UPDATE przy wgraniu.
--
-- Po co: mail z fakturą miał jeden stały temat i jedną stałą treść
-- (`sendInvoiceEmail`). Firma chce pisać do nabywców własnymi słowami, z numerem
-- faktury, kwotą i terminem w temacie i w treści.
--
-- invoice_email_templates: jeden wiersz na firmę (PK: tenant_id).
--   subject: temat, 1 do 120 znaków, w jednym wierszu.
--   body: treść, 1 do 2000 znaków, zwykły tekst; akapity po pustym wierszu.
--   Pola w nawiasach klamrowych ({numer}, {sprzedawca}, {kwota}, {termin},
--   {tytul_przelewu}) sprawdza i podstawia aplikacja (`lib/email/invoice-email-template.ts`);
--   baza pilnuje tylko długości i jednowierszowego tematu. Nieznane pole w zapisanym
--   szablonie aplikacja traktuje jak brak szablonu (mail domyślny).
--   Brak wiersza = mail domyślny. „Przywróć domyślny” usuwa wiersz.
--   updated_at, updated_by: kiedy i kto zmienił (osoba może zniknąć po usunięciu konta).
--
-- Co szablon zmienia, a czego nie: temat i akapity powitania. Tabela z kwotą,
-- terminem płatności i tytułem przelewu oraz stopka o przetwarzaniu danych są
-- w mailu zawsze, a pole {kwota} to kwota z PDF (`invoiceEmailAmount`).
--
-- RLS (public.get_current_tenant_id(): nagłówek x-active-org i aktywne
-- członkostwo, 00037): odczyt dla każdego aktywnego członka aktywnej firmy
-- (wysyła mail także członek), zapis, zmiana i usunięcie tylko dla właściciela
-- i administratora (public.has_org_role, 00037). Księgowa i członek nie zmienią
-- szablonu. service_role ma pełny dostęp. anon: nic.
--
-- Dane osobowe: brak (tekst szablonu pisze firma; dane nabywcy podstawia
-- aplikacja przy wysyłce i nie zapisuje ich tutaj). Znika z firmą (ON DELETE CASCADE).
--
-- Ponowienie: zapis to upsert po kluczu głównym, usunięcie jest idempotentne.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.invoice_email_templates (
  tenant_id UUID PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT invoice_email_templates_subject_check CHECK (
    char_length(subject) BETWEEN 1 AND 120 AND subject !~ '[\r\n]' AND subject ~ '[^[:space:]]'
  ),
  CONSTRAINT invoice_email_templates_body_check CHECK (
    char_length(body) BETWEEN 1 AND 2000 AND body ~ '[^[:space:]]'
  )
);

COMMENT ON TABLE public.invoice_email_templates IS
  'Własny szablon maila z fakturą (krok 2.8 planu kompletnej aplikacji, 00208): temat i treść z polami {numer}, {sprzedawca}, {kwota}, {termin}, {tytul_przelewu}. Brak wiersza = mail domyślny.';

ALTER TABLE public.invoice_email_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "invoice_email_templates_select_members" ON public.invoice_email_templates;
CREATE POLICY "invoice_email_templates_select_members" ON public.invoice_email_templates
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_current_tenant_id());

DROP POLICY IF EXISTS "invoice_email_templates_insert_owner_admin" ON public.invoice_email_templates;
CREATE POLICY "invoice_email_templates_insert_owner_admin" ON public.invoice_email_templates
  FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  );

DROP POLICY IF EXISTS "invoice_email_templates_update_owner_admin" ON public.invoice_email_templates;
CREATE POLICY "invoice_email_templates_update_owner_admin" ON public.invoice_email_templates
  FOR UPDATE TO authenticated
  USING (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  )
  WITH CHECK (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  );

DROP POLICY IF EXISTS "invoice_email_templates_delete_owner_admin" ON public.invoice_email_templates;
CREATE POLICY "invoice_email_templates_delete_owner_admin" ON public.invoice_email_templates
  FOR DELETE TO authenticated
  USING (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  );

REVOKE ALL ON public.invoice_email_templates FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoice_email_templates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoice_email_templates TO service_role;
