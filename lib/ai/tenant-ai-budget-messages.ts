/**
 * Komunikaty odmowy budżetu AI firmy (`checkTenantAiBudget`
 * w `lib/ai/tenant-ai-budget.ts`), w osobnym pliku bez importów.
 *
 * Czyta je też tłumaczenie błędu odczytu dla klienta
 * (`lib/ocr/komunikat-dla-klienta.ts`): odmowa budżetu już jest zdaniem dla
 * klienta, więc przechodzi bez zmian. Gdyby stałe leżały w
 * `tenant-ai-budget.ts`, testy, które podmieniają ten moduł atrapą
 * (`vi.mock` z fabryką), zostawiałyby tłumaczenie bez tych zdań i odmowa
 * zamieniałaby się w zdanie ogólne.
 */

export const TENANT_AI_BUDGET_UNAVAILABLE_MESSAGE =
  'Automatyczne rozpoznawanie dokumentów jest chwilowo niedostępne. Spróbuj ponownie później.';

export const TENANT_AI_BUDGET_MONTHLY_MESSAGE =
  'Wykorzystano miesięczny limit odczytu dokumentów, wróci od następnego miesiąca.';

export const TENANT_AI_BUDGET_DAILY_MESSAGE = 'Wykorzystano dzienny limit odczytu dokumentów, wróci w ciągu 24 godzin.';

export const TENANT_AI_BUDGET_MESSAGES = [
  TENANT_AI_BUDGET_UNAVAILABLE_MESSAGE,
  TENANT_AI_BUDGET_MONTHLY_MESSAGE,
  TENANT_AI_BUDGET_DAILY_MESSAGE,
] as const;
