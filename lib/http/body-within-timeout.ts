/**
 * Treść odpowiedzi HTTP w tym samym limicie czasu co nagłówki (LIM-05, plan
 * skalowania 3000).
 *
 * `fetch` kończy się, gdy przyjdą nagłówki, a treść czyta się dopiero potem
 * (`text()`, `arrayBuffer()`). Zegar skasowany zaraz po nagłówkach zostawia
 * odczyt treści bez limitu: serwer, który wysłał nagłówki i stanął, trzyma
 * wywołującego tak długo, jak żyje gniazdo (w undici do 300 s ciszy, a przy
 * kapiących bajtach bez końca).
 *
 * `bodyWithinTimeout` przepuszcza treść przez `signal` wywołującego. Po jego
 * przerwaniu odczyt pada powodem przerwania (`AbortError`, gdy `abort()` bez
 * argumentu), a źródło jest zamykane, więc połączenie wraca wolne. Działa też
 * wtedy, gdy samo `fetch` sygnału nie słucha (atrapa w teście, `fetch`
 * opakowany przez bibliotekę). Błąd sieci w trakcie treści przechodzi bez
 * zmian.
 *
 * Wywołujący kasuje zegar dopiero po przeczytaniu całej treści (`finally`).
 * Nowa odpowiedź ma ten sam status i nagłówki, ale bez `url` i `redirected`.
 */
export function bodyWithinTimeout(response: Response, signal: AbortSignal): Response {
  if (!response.body) return response;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  // Błąd przerwania albo sieci dostaje czytający `readable`; tu tylko
  // wyciszamy odrzucenie samego przepięcia.
  response.body.pipeTo(writable, { signal }).catch(() => {});
  return new Response(readable, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
