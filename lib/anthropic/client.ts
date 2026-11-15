import Anthropic from '@anthropic-ai/sdk';

export const OCR_MODEL = process.env.ANTHROPIC_OCR_MODEL ?? 'claude-sonnet-4-6';

/*
 * Limity czasu wywołań modelu (LIM-05, plan skalowania 3000).
 *
 * Bez nich SDK brało 600 s na próbę i 2 ponowienia: połączenie, które stanęło,
 * trzymało wywołanie do ok. 30 min (na produkcji ok. 15 min, bo undici
 * przerywa po 300 s bez nagłówków). Kolejka OCR bierze jedno zadanie naraz,
 * więc to był przestój odczytu zdjęć dla wszystkich firm.
 *
 * Limit SDK obejmuje jedną próbę do nadejścia nagłówków odpowiedzi. Bez
 * strumienia nagłówki przychodzą razem z całą wiadomością, więc to limit na
 * całe wywołanie. Przy strumieniu limit obejmuje tylko początek, resztę
 * pilnuje wywołujący (czat pomocy: `lib/support/chat.ts`). Próba przerwana po
 * limicie mogła zostać u dostawcy policzona, stąd jedno ponowienie, nie dwa.
 */

/**
 * Domyślne dla klienta, bo bez własnych opcji wołają go tylko joby: OCR
 * (`lib/ocr/engine.ts`) i kategoryzacja (`lib/categorization/ai-classifier.ts`).
 * Najdłuższe uczciwe wywołanie to OCR (`OCR_MODEL`, `max_tokens` 2048), które
 * SDK szacuje ostrożnie na 57,6 s (128 000 tokenów na godzinę). Limit to
 * ok. dwa takie szacunki. Najgorszy przypadek: 2 próby po 120 s i ok. 0,5 s
 * przerwy, czyli ok. 4 min.
 */
export const ANTHROPIC_WORKER_LIMITS = { timeout: 120_000, maxRetries: 1 } as const;

/**
 * Wywołania, na które czeka człowiek albo które mają gotowy zapas (czat
 * pomocy, Flo z szablonem). Odpowiedzi do 1024 tokenów; SDK szacuje 400
 * tokenów na 11,25 s. Najgorszy przypadek: 2 próby po 20 s, ok. 40 s do
 * komunikatu o błędzie albo szablonu.
 */
export const ANTHROPIC_REQUEST_LIMITS = { timeout: 20_000, maxRetries: 1 } as const;

let cachedClient: Anthropic | null = null;

/**
 * Lazy init — bez tego `next build` padałby przy imporcie łańcucha
 * (np. route → server action → categorization → ai-classifier), nawet gdy
 * build nie woła OCR. Na Vercel trzeba ustawić ANTHROPIC_API_KEY w env
 * projektu; błąd dopiero przy pierwszym wywołaniu API.
 */
export function getAnthropic(): Anthropic {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY missing');
  }
  cachedClient = new Anthropic({ apiKey, ...ANTHROPIC_WORKER_LIMITS });
  return cachedClient;
}
