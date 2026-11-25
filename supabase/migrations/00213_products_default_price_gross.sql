-- ═══════════════════════════════════════════════════════════════
-- 00213: cena brutto produktu w katalogu (plan cen brutto, PR (d);
-- docs/koordynacja/PLAN-KOMPLETNA-APLIKACJA.md, krok 2.6)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem. Addytywna: jedna nowa kolumna
-- `products.default_price_gross` (NUMERIC(15,2), pusta, nieujemna), bez zmian
-- danych, polityk i indeksów. Stara aplikacja kolumny nie czyta i nie pisze.
-- Nowa czyta ją w liście katalogu i w podpowiedzi przy pozycji faktury, więc
-- bez tej migracji lista katalogu kończy się komunikatem błędu odczytu (nie
-- pustą listą), a podpowiedź informacją, że katalog jest niedostępny.
-- DROP/DML: brak. Bez DROP, TRUNCATE, DELETE i UPDATE: istniejące produkty
-- dostają pustą cenę brutto (NULL), cena netto zostaje bez zmian.
--
-- Po co: faktura w cenach brutto (art. 106e ust. 7 i 8 ustawy o VAT, FA(3)
-- `P_9B`, RP-FA-BRUTTO-01) ma cenę jednostkową brutto zamiast netto. Katalog
-- trzyma cenę brutto obok ceny netto i żadnej nie wylicza z drugiej: faktura
-- w cenach netto bierze `default_price_net`, faktura w cenach brutto
-- `default_price_gross`. Brak ceny to NULL, nigdy 0. Zapis i ekran ceny brutto
-- są za wyłącznikiem `grossPricesEnabled` (#884, `app/actions/produkty.ts`);
-- kolumna działa pod tą samą polityką RLS co reszta wiersza (00013).
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS default_price_gross NUMERIC(15, 2)
    CHECK (default_price_gross IS NULL OR default_price_gross >= 0);

COMMENT ON COLUMN public.products.default_price_gross IS
  'Cena jednostkowa brutto produktu dla faktury w cenach brutto (00213); NULL = brak, nie 0.';

NOTIFY pgrst, 'reload schema';
