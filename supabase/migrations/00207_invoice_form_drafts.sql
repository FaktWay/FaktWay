-- ═══════════════════════════════════════════════════════════════
-- 00207: autozapis formularza zwykłej faktury (plan kompletnej aplikacji,
-- docs/koordynacja/PLAN-KOMPLETNA-APLIKACJA.md, krok 2.8 „Wygoda wystawiania
-- i wysyłki”, część: autozapis szkicu).
--
-- KIEDY WGRAĆ: PRZED wdrożeniem kodu. Addytywna: jedna nowa tabela z polityką
-- RLS, bez zmian istniejących tabel, funkcji i indeksów. Stara wersja
-- aplikacji tabeli nie zna. Nowa wersja bez tabeli (PostgREST: PGRST205)
-- działa jak dotąd, a autozapis po cichu nic nie zapisuje (formularz pokazuje
-- „Autozapis niedostępny”, wystawianie i zwykły szkic nie zależą od tabeli).
-- DROP/DML: brak. Bez DROP, TRUNCATE, DELETE i UPDATE przy wgraniu.
--
-- Po co: formularz faktury (`components/invoices/invoice-form.tsx`) trzymał
-- wpisane dane tylko w przeglądarce. Odświeżenie karty, wygaśnięcie sesji
-- albo zamknięcie okna kasowało całą pracę. Pełny zapis szkicu (tabela
-- `invoices`) wymaga poprawnego formularza (NIP, numer, pozycje) i zajmuje
-- numer z serii, więc nie nadaje się do zapisu co kilka sekund. Autozapis
-- trzyma więc surowe wartości formularza, także niedokończone, w osobnej
-- tabeli roboczej. To NIE jest faktura ani szkic faktury: nie ma numeru,
-- nie trafia do list, KSeF, JPK ani raportów i nie zajmuje numeru z serii.
--
-- invoice_form_drafts: jeden wiersz na otwarcie formularza i osobę
--   (PK: firma + osoba + request_key). request_key to ten sam klucz, który
--   formularz wysyła jako `numberRequestKey` przy zapisie faktury (00199,
--   `invoices.number_request_key`). Ponowny autozapis tego samego otwarcia
--   nadpisuje ten sam wiersz (upsert po PK), więc nie ma drugiego szkicu.
--   Gdy faktura z tym kluczem już istnieje, aplikacja nie pokazuje wiersza
--   do przywrócenia i go usuwa.
--   form_values: surowe wartości formularza (JSON), do 200000 znaków.
--   updated_at: kiedy zapisano. Aplikacja ignoruje wiersze starsze niż
--   30 dni i usuwa je przy kolejnym autozapisie tej osoby.
--
-- RLS: osoba widzi i zmienia tylko własne wiersze w aktywnej firmie
--   (public.get_current_tenant_id(): nagłówek x-active-org i aktywne
--   członkostwo, 00037, oraz user_id = auth.uid()). Księgowa i inni
--   członkowie firmy nie widzą cudzych roboczych wartości. service_role ma
--   pełny dostęp (obsługa i sprzątanie). anon: nic.
--
-- Dane osobowe: wiersz może zawierać dane nabywcy wpisane w formularzu.
--   Znikają przy usunięciu konta osoby albo firmy (ON DELETE CASCADE) i po
--   zapisie faktury z tego formularza.
--
-- Ponowienie: zapis to upsert po kluczu głównym, więc powtórzenie po
-- zerwanym połączeniu daje ten sam wiersz.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.invoice_form_drafts (
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  request_key UUID NOT NULL,
  form_values JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, request_key),
  CONSTRAINT invoice_form_drafts_form_values_check CHECK (
    jsonb_typeof(form_values) = 'object' AND octet_length(form_values::text) <= 200000
  )
);

COMMENT ON TABLE public.invoice_form_drafts IS
  'Autozapis formularza zwykłej faktury (krok 2.8 planu kompletnej aplikacji, 00207): surowe wartości, także niedokończone. To nie jest faktura ani szkic faktury: bez numeru, poza listami, KSeF i JPK.';

CREATE INDEX IF NOT EXISTS invoice_form_drafts_osoba_idx
  ON public.invoice_form_drafts (tenant_id, user_id, updated_at DESC);

ALTER TABLE public.invoice_form_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "invoice_form_drafts_own" ON public.invoice_form_drafts;
CREATE POLICY "invoice_form_drafts_own" ON public.invoice_form_drafts
  FOR ALL TO authenticated
  USING (tenant_id = public.get_current_tenant_id() AND user_id = auth.uid())
  WITH CHECK (tenant_id = public.get_current_tenant_id() AND user_id = auth.uid());

REVOKE ALL ON public.invoice_form_drafts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoice_form_drafts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoice_form_drafts TO service_role;
