import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { komunikatBleduOdczytu } from '@/lib/ocr/komunikat-dla-klienta';
import { isUuid } from '@/lib/supabase/active-org';
import type { Database } from '@/types/database';

/**
 * Stan zadania odczytu (OCR) kosztu: do odpytywania po wgraniu zdjęcia.
 * Do M9 planu aplikacji mobilnej to było ciało `getOcrJobStatusAction`
 * (`app/actions/expenses.ts`); teraz woła je akcja strony (klient z sesji
 * w ciasteczkach) i trasa `GET /api/mobile/v1/wydatki/odczyt/{id}` (klient
 * z tokenem telefonu). W obu RLS pokazuje tylko zadania aktywnej firmy.
 *
 * Trzy wyniki, bo ekran musi odróżnić „zadania nie ma” od „nie wiem”:
 *  - zadanie jest → `success: true` z wierszem;
 *  - brak wiersza (albo RLS go nie pokazuje; dla użytkownika to to samo)
 *    → `retryable: false`: dalsze pytanie nic nie zmieni, ekran kończy czekanie;
 *  - błąd odczytu (chwilowa awaria bazy, sieci, PostgREST) → `retryable: true`:
 *    stan zadania jest nieznany, więc ekran pyta dalej. Wcześniej błąd ginął
 *    i wyglądał jak brak zadania: ekran pokazywał porażkę, klient wgrywał
 *    zdjęcie drugi raz i powstawał drugi wydatek (E16).
 * Treść błędu bazy nie trafia ani do klienta, ani do logu serwera (tam
 * sam kod).
 *
 * Każdy błąd odczytu traktujemy jako chwilowy, także trwałe jak 42501
 * (brak uprawnień). Uproszczenie świadome: rozróżnianie kodów nic by nie
 * dało, bo ekran i tak przestaje pytać po czasie, a pomyłka w drugą stronę
 * (chwilowy uznany za trwały) to znów drugi wydatek z tego samego zdjęcia.
 *
 * Błąd odczytu wychodzi zdaniem dla klienta (`komunikatBleduOdczytu`), nie
 * zapisem z `ocr_jobs.error_message`. Zapis zostaje techniczny dla operatora
 * i raportu dziennego: angielski tekst SDK, odpowiedź modelu z treścią
 * paragonu, klucz pliku z magazynu (LIM-05, punkt 9 z #782).
 */

export interface OcrJobStatusRow {
  id: string;
  status: Database['public']['Enums']['ocr_status'];
  /** Zdanie dla klienta, nie zapis z bazy: tylko przy `failed`, w innych stanach `null`. */
  error_message: string | null;
  expense_id: string | null;
  extracted_data: Database['public']['Tables']['ocr_jobs']['Row']['extracted_data'];
}

export type OcrJobStatusResult =
  | { success: true; job: OcrJobStatusRow }
  | { success: false; retryable: false; error: string }
  | { success: false; retryable: true; error: string };

/** Zadania nie ma: także identyfikator spoza UUID (argument z przeglądarki albo telefonu). */
export const OCR_JOB_MISSING = { success: false as const, retryable: false as const, error: 'Job nie istnieje' };

const OCR_JOB_UNKNOWN = {
  success: false as const,
  retryable: true as const,
  error: 'Nie mogę teraz sprawdzić stanu odczytu',
};

export async function readOcrJobStatus(supabase: SupabaseClient<Database>, ocrJobId: unknown): Promise<OcrJobStatusResult> {
  // Nie-UUID to nie chwilowy błąd, tylko zadanie, którego nie ma: bez zapytania do bazy.
  if (!isUuid(ocrJobId)) return OCR_JOB_MISSING;

  const { data: job, error } = await supabase
    .from('ocr_jobs')
    .select('id, status, error_message, expense_id, extracted_data')
    .eq('id', ocrJobId)
    .maybeSingle();

  if (error) {
    console.error('[getOcrJobStatusAction] odczyt ocr_jobs nieudany', { code: error.code });
    return OCR_JOB_UNKNOWN;
  }

  if (!job) return OCR_JOB_MISSING;

  // Zdanie tylko przy `failed`. W innych stanach `null`, także gdy w bazie
  // został stary zapis: udane ponowienie go nie czyści (`mark-processing`
  // i `mark-completed` w process-ocr), więc niepusty zapis nie znaczy, że ten
  // odczyt się nie udał. Porażka bez zapisu dostaje zdanie ogólne.
  const errorMessage = job.status === 'failed' ? komunikatBleduOdczytu(job.error_message) : null;
  return { success: true, job: { ...job, error_message: errorMessage } };
}
