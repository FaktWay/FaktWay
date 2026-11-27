-- ═══════════════════════════════════════════════════════════════
-- 00222: przyczyna korekty (decyzja D35 z docs/koordynacja/DECYZJE-2026-11-25.md,
-- reguły NZ-VAT-05 i RP-KOR-01)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem. Tylko nowa kolumna dopuszczająca null
-- w `invoices`; istniejące wiersze zostają bez zmian (null = przyczyna
-- nieznana, okres jak dotąd: dzień wystawienia korekty). Stary kod kolumny
-- nie zna i nie zapisuje, więc kolejność nie psuje niczego.
--
-- Wyzwalacze zamrożenia treści (00119, 00122, 00132) porównują wyliczoną
-- listę kolumn, w której nowej kolumny nie ma, a zapis przy wystawieniu
-- korekty to INSERT; więc nic jej nie blokuje. Zmiana przyczyny po
-- przyjęciu przez KSeF nie jest zamrożona wyzwalaczem, ale żaden kod
-- aplikacji jej po wystawieniu nie zmienia.
--
-- Wartości: blad_rachunkowy (błąd rachunkowy albo oczywista omyłka),
-- blad_w_dniu_sprzedazy (inny błąd istniejący w dniu sprzedaży),
-- nowa_okolicznosc (przyczyna zaistniała po sprzedaży).
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS correction_cause text
  CONSTRAINT invoices_correction_cause_check
  CHECK (correction_cause IS NULL
         OR correction_cause IN ('blad_rachunkowy', 'blad_w_dniu_sprzedazy', 'nowa_okolicznosc'));

COMMENT ON COLUMN public.invoices.correction_cause IS
  'Przyczyna korekty wybrana przez klienta (D35): ustala okres korekty w VAT, PIT i ryczałcie. Null: nieznana (korekty sprzed 00222).';
