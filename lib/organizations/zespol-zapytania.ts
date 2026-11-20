/**
 * Kolumny zapytań zakładki Zespół (strona `settings/team` i trasa telefonu
 * `GET /zespol`): jedno miejsce, żeby strona i telefon nie rozjechały się
 * w osadzeniu `users`.
 *
 * `memberships` ma dwa klucze obce do `users` (`user_id`, `invited_by`),
 * a `organization_join_requests` dwa (`requested_by_user_id`, `decided_by`),
 * więc samo `users!inner(name)` kończy się w PostgREST błędem PGRST201
 * („more than one relationship was found”): strona nie pokazywała ani jednego
 * członka, a telefon odpowiadał 503. Osadzenie wymaga podpowiedzi klucza
 * (`users!<nazwa_klucza>`); test na prawdziwej bazie: `tests/rls-zespol-embed.test.ts`.
 */

/**
 * Członkowie: `!inner` zostaje jak w pierwotnym zapytaniu (RLS `users` pokazuje
 * tylko członków z aktywnym członkostwem we wspólnej firmie).
 */
export const ZESPOL_CZLONKOWIE_KOLUMNY = 'id, user_id, role, status, joined_at, users!memberships_user_id_fkey!inner(name)';

/**
 * Prośby o dołączenie BEZ `!inner`: wnioskodawca nie ma jeszcze członkostwa,
 * więc RLS `users` (`shares_active_org_with`) ukrywa jego wiersz, a złączenie
 * wewnętrzne wycięłoby całą prośbę. Imię bywa wtedy puste (`null`), prośba
 * zostaje na liście (strona dopowiada e-mail z `auth.users`).
 */
export const ZESPOL_PROSBY_KOLUMNY = 'id, requested_by_user_id, message, created_at, users!organization_join_requests_requested_by_user_id_fkey(name)';
