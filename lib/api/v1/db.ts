import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { createSupabaseFetch } from '@/lib/supabase/fetch-timeout';

/**
 * Klient bazy dla jednego żądania `/api/v1`: klucz anon (jak przeglądarka)
 * i token roli `api_key_client` z `mintApiKeyToken`. Polityki RLS z 00181
 * widzą wtedy tylko firmę i zakres klucza. Nigdy klucz serwisowy.
 *
 * Każde wywołanie ma limit czasu (`createSupabaseFetch`, LIM-05): odczyt 10 s,
 * zapis 30 s, także `api_key_session()`. Po limicie wynik ma `error`, a trasa
 * odpowiada 503, zamiast trzymać żądanie do 300 s.
 */
export function createApiKeyDbClient(
  token: string,
  target: { url?: string; anonKey?: string } = {},
): SupabaseClient {
  const url = target.url ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = target.anonKey ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('Brak adresu albo klucza anon Supabase');
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: createSupabaseFetch(), headers: { Authorization: `Bearer ${token}` } },
  });
}
