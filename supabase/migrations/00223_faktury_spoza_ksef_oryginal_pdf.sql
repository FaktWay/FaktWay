-- 00223_faktury_spoza_ksef_oryginal_pdf.sql
-- KIEDY WGRAĆ: PRZED wdrożeniem (czysto addytywna: trzy puste kolumny; stary kod ich nie zna i nie zapisuje).
--
-- Plan kompletnej aplikacji, krok 1.6 część 2b, PR D (D25 b, D40): oryginał PDF
-- faktury wystawionej poza KSeF zostaje przy wpisie, z okresem przechowywania
-- faktury, i trafia do archiwum ZIP. To NIE jest `pdf_storage_path` (tamto to
-- pamięć podręczna wydruku generowanego przez FaktWay, kasowana i odnawiana).
--
-- Co robi:
--  1. invoices.outside_ksef_original_path (klucz obiektu w magazynie),
--     outside_ksef_original_sha256 (skrót SHA-256 pliku) i
--     outside_ksef_original_size (bajty).
--  2. invoices_outside_ksef_original_shape: kolumny są albo wszystkie puste,
--     albo wszystkie wypełnione, i tylko dla origin = 'outside_ksef' (zwykła
--     faktura nie ma „oryginału PDF”, jej oryginałem jest XML z KSeF);
--     klucz leży w katalogu tej firmy (tenants/<firma>/outside-ksef/).
--
-- Wyjście przy odmowie bazy (protokół, pkt 4): akcja wgrania oryginału
-- (lib/import/outside-ksef-oryginal.ts) zwraca klientowi komunikat z nazwą
-- faktury; wpis zostaje bez oryginału i klient może wgrać plik jeszcze raz.
-- Ścieżka operatora: poprawka wiersza przez service_role z tą samą kontrolą.
--
-- Wycofanie: DROP CONSTRAINT invoices_outside_ksef_original_shape, potem DROP
-- trzech kolumn; wcześniej usunąć pliki z magazynu
-- (SELECT outside_ksef_original_path FROM public.invoices WHERE
-- outside_ksef_original_path IS NOT NULL).

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS outside_ksef_original_path text,
  ADD COLUMN IF NOT EXISTS outside_ksef_original_sha256 text,
  ADD COLUMN IF NOT EXISTS outside_ksef_original_size integer;

ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_outside_ksef_original_shape;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_outside_ksef_original_shape
  CHECK (
    (outside_ksef_original_path IS NULL
      AND outside_ksef_original_sha256 IS NULL
      AND outside_ksef_original_size IS NULL)
    OR (
      origin = 'outside_ksef'
      AND outside_ksef_original_path IS NOT NULL
      AND outside_ksef_original_sha256 ~ '^[0-9a-f]{64}$'
      AND outside_ksef_original_size IS NOT NULL
      AND outside_ksef_original_size > 0
      AND outside_ksef_original_path LIKE 'tenants/' || tenant_id::text || '/outside-ksef/%'
    )
  ) NOT VALID;

-- NOT VALID + VALIDATE: nowa kolumna jest pusta, więc walidacja jest natychmiastowa i bez długiej blokady.
ALTER TABLE public.invoices VALIDATE CONSTRAINT invoices_outside_ksef_original_shape;

COMMIT;
