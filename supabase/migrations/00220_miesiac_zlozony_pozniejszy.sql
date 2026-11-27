-- ═══════════════════════════════════════════════════════════════
-- 00220: miesiąc złożony także wtedy, gdy zgłoszenie jest za późniejszy
-- miesiąc (FZ-022, decyzja D65 z docs/koordynacja/DECYZJE-2026-11-25.md;
-- poprawka do `expense_period_filed` z 00215)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem, po 00215. Tylko nowa treść jednej funkcji
-- (CREATE OR REPLACE z tym samym podpisem i uprawnieniami); bez zmian tabel
-- i danych. Stary kod funkcję woła tak samo, więc kolejność nie psuje niczego.
--
-- Dlaczego: zaliczkę PIT za dalsze miesiące ustala się jako różnicę między
-- podatkiem od dochodu od początku roku a sumą zaliczek za miesiące poprzednie
-- (art. 44 ust. 3f ustawy o PIT), a nadwyżkę VAT przenosi się na następne
-- okresy (art. 87 ust. 1 ustawy o VAT). Zmiana kosztu z marca zmienia więc
-- kwoty złożonego kwietnia; zgłoszenie za kwiecień przy marcu bez zgłoszenia
-- w FaktWay znaczy zwykle, że marzec złożono poza FaktWay.
--
-- Od teraz złożony jest miesiąc `p_okres`, jeśli za ten albo za którykolwiek
-- późniejszy miesiąc jest: rozliczenie PIT, VAT albo zdrowotnej (`okres >=
-- p_okres`), wysyłka JPK_V7M na bramkę produkcyjną poza odrzuconą i przerwaną
-- (`okres >= p_okres`), udany eksport KPiR albo JPK_V7M kończący się nie
-- wcześniej niż ten miesiąc (`period_end >= p_okres`). Skutek najgorszy:
-- zadanie „Połącz koszty” zamiast cichego połączenia.
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.expense_period_filed(p_tenant_id uuid, p_okres date)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT EXISTS (
      SELECT 1 FROM public.tax_settlements AS s
       WHERE s.tenant_id = p_tenant_id AND s.okres >= p_okres
         AND s.rodzaj IN ('pit', 'vat', 'zdrowotna')
    )
    OR EXISTS (
      SELECT 1 FROM public.jpk_submissions AS j
       WHERE j.tenant_id = p_tenant_id AND j.okres >= p_okres
         AND j.srodowisko = 'produkcja' AND j.stan NOT IN ('odrzucona', 'przerwana')
    )
    OR EXISTS (
      SELECT 1 FROM public.export_jobs AS x
       WHERE x.tenant_id = p_tenant_id AND x.status = 'completed'
         AND x.format::text IN ('kpir_excel', 'jpk_v7m')
         AND x.period_end >= p_okres
    )
$$;

REVOKE ALL ON FUNCTION public.expense_period_filed(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expense_period_filed(uuid, date) TO service_role;
