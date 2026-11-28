import 'server-only';

import type { DocumentBlockParam, TextBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';
import * as Sentry from '@sentry/nextjs';

import { checkTenantAiBudget, recordTenantAiUsage } from '@/lib/ai/tenant-ai-budget';
import { getAnthropic, OCR_MODEL } from '@/lib/anthropic/client';
import {
  czyPdf,
  ODCZYT_PDF_INSTRUKCJE,
  ODCZYT_PDF_SYSTEM,
  odczytPdfSchema,
  PDF_SPOZA_KSEF_LIMIT_BYTES,
  PDF_SPOZA_KSEF_LIMIT_LABEL,
  PDF_SPOZA_KSEF_RECZNIE,
  wypelnienieZOdczytu,
  type OdczytPdf,
  type WypelnienieZPdf,
} from '@/lib/import/outside-ksef-pdf';
import { czySpozaKsefWlaczone, SPOZA_KSEF_NIEZNANE, SPOZA_KSEF_WYLACZONE } from '@/lib/import/outside-ksef-wylacznik';
import { isAnthropicMocked } from '@/lib/test-mode';
import { formatUploadSize } from '@/lib/upload-limit';

/**
 * Odczyt PDF faktury wystawionej poza KSeF (krok 1.6, część 2b, PR D; D25 a).
 * Woła ją trasa `/api/uploads/spoza-ksef` po bramce z `lib/uploads/server.ts`
 * (sesja, 2FA, firma, rola). Nic nie zapisuje w bazie ani w magazynie: wynik
 * wypełnia formularz, a zapisuje człowiek (`dodajFakturaSpozaKsef`).
 *
 * Ten sam dzienny i miesięczny limit co odczyt kosztów (`checkTenantAiBudget`,
 * rodzaj `ocr`), z tą samą tabelą zużycia. Ponowienie od zera: odczyt nie ma
 * efektu poza zużyciem budżetu AI, więc ponowienie kosztuje jedno rozpoznanie
 * i nie rozmnaża żadnych danych. Błąd modelu albo śmieć w odpowiedzi to
 * komunikat z wyjściem „wpisz ręcznie”, nigdy puste wypełnienie bez słowa.
 *
 * Model dostaje PDF jako dokument i polecenie, że treść faktury to dane, nie
 * polecenia; odpowiedź przechodzi schemat, a potem mapowanie z odmowami D22.
 */

export type WynikOdczytuPdf =
  | { success: true; wypelnienie: WypelnienieZPdf }
  | { success: false; status: number; error: string };

const BLAD_ODCZYTU = `Nie udało się odczytać tego PDF. ${PDF_SPOZA_KSEF_RECZNIE}`;

function rozbierz(tekst: string): OdczytPdf | null {
  const json = tekst
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();
  try {
    const wynik = odczytPdfSchema.safeParse(JSON.parse(json));
    return wynik.success ? wynik.data : null;
  } catch {
    return null;
  }
}

/** Odpowiedź atrapy dla E2E (`E2E_MOCK_ANTHROPIC`): deterministyczna, bez wołania modelu. */
const ATRAPA: OdczytPdf = {
  document_kind: 'faktura_vat',
  number: 'E2E/1/2026',
  issue_date: '2026-03-10',
  sale_date: null,
  buyer_name: 'Nabywca E2E Sp. z o.o.',
  buyer_nip: '5260001246',
  currency: 'PLN',
  lines: [{ name: 'Usługa E2E', net: 100, vat_rate: '23', vat: 23, gross: 123, exemption_basis: null, gtu: null }],
  confidence: 0.95,
  notes: null,
};

export async function odczytajPdfSpozaKsef({ tenantId, file }: { tenantId: string; file: File }): Promise<WynikOdczytuPdf> {
  try {
    if (!(await czySpozaKsefWlaczone())) return { success: false, status: 403, error: SPOZA_KSEF_WYLACZONE };
  } catch {
    return { success: false, status: 503, error: SPOZA_KSEF_NIEZNANE };
  }

  if (!czyPdf(new Uint8Array(await file.slice(0, 8).arrayBuffer()))) {
    return { success: false, status: 400, error: `To nie jest plik PDF. ${PDF_SPOZA_KSEF_RECZNIE}` };
  }
  if (file.size > PDF_SPOZA_KSEF_LIMIT_BYTES) {
    return {
      success: false,
      status: 413,
      error: `PDF ma ${formatUploadSize(file.size)}, a można wgrać najwyżej ${PDF_SPOZA_KSEF_LIMIT_LABEL}. ${PDF_SPOZA_KSEF_RECZNIE}`,
    };
  }

  if (isAnthropicMocked()) return { success: true, wypelnienie: wypelnienieZOdczytu(ATRAPA) };

  const budzet = await checkTenantAiBudget(tenantId, 'ocr');
  if (!budzet.allowed) return { success: false, status: 429, error: `${budzet.message} ${PDF_SPOZA_KSEF_RECZNIE}` };

  const dane = Buffer.from(await file.arrayBuffer()).toString('base64');
  const dokument: DocumentBlockParam = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: dane } };
  const polecenie: TextBlockParam = { type: 'text', text: ODCZYT_PDF_INSTRUKCJE };

  try {
    const odpowiedz = await getAnthropic().messages.create({
      model: OCR_MODEL,
      max_tokens: 4096,
      system: ODCZYT_PDF_SYSTEM,
      messages: [{ role: 'user', content: [dokument, polecenie] }],
    });
    await recordTenantAiUsage(tenantId, { inputTokens: odpowiedz.usage.input_tokens, outputTokens: odpowiedz.usage.output_tokens });
    const blok = odpowiedz.content.find((c) => c.type === 'text');
    const odczyt = blok && blok.type === 'text' ? rozbierz(blok.text) : null;
    if (!odczyt) return { success: false, status: 422, error: BLAD_ODCZYTU };
    return { success: true, wypelnienie: wypelnienieZOdczytu(odczyt) };
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'outside-ksef.pdf-odczyt' } });
    return { success: false, status: 502, error: `Odczyt PDF chwilowo nie działa. ${PDF_SPOZA_KSEF_RECZNIE}` };
  }
}
