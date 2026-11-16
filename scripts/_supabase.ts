/**
 * Supabase admin client dla skryptów CLI (tsx).
 *
 * Różni się od `lib/supabase/server.ts`:
 *   - używa `@supabase/supabase-js` (nie `@supabase/ssr`)
 *   - nie dotyka `next/headers::cookies()` (Node.js context, brak requestu)
 *   - service_role key - BYPASS RLS (używaj tylko w zaufanych skryptach dev/ops)
 *   - limity czasu workera pg-boss (`lib/supabase/fetch-timeout.ts`, LIM-05):
 *     odczyt 60 s, zapis 120 s, zamiast 300 s undici przy zawieszonej bazie
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { createSupabaseFetch, enableWorkerSupabaseTimeouts } from '../lib/supabase/fetch-timeout';

export function createScriptAdminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL nie jest ustawione');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY nie jest ustawione');

  // Skrypt pracuje jak worker: klucz serwisowy (bez limitu w bazie) i duże paczki.
  enableWorkerSupabaseTimeouts();
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: createSupabaseFetch() },
  });
}

export { bufferToByteaLiteral } from '../lib/supabase/bytea';
