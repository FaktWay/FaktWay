import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

/**
 * Krok 1.6, część 2b, PR D (D40): oryginał PDF faktury spoza KSeF ma okres
 * przechowywania faktury. Retencja (`cron.retention-delete`) kasuje pliki
 * z kluczy zebranych z wiersza, więc klucz oryginału musi być wśród nich
 * i musi być czytany z bazy. Atrapa tylko magazynu i klienta bazy.
 */

vi.mock('@/lib/storage/r2', () => ({ listInvoiceAttemptXmls: async () => [] }));
vi.mock('@/lib/storage/glacier', () => ({ deleteFromGlacier: async () => undefined }));
vi.mock('@/lib/storage/r2-client', () => ({ getR2Client: () => ({ send: async () => ({}) }), getR2Config: () => ({ bucketName: 'b' }) }));

import { collectInvoiceStorageKeys } from '@/lib/retention/invoice-files';

const bezPowiazan = {
  from: () => {
    const q = { select: () => q, eq: () => q, then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok) };
    return q;
  },
} as never;

describe('retencja plików faktury spoza KSeF', () => {
  it('klucz oryginału PDF trafia do plików kasowanych razem z fakturą', async () => {
    const klucz = 'tenants/t1/outside-ksef/i1.pdf';
    const klucze = await collectInvoiceStorageKeys(bezPowiazan, {
      id: 'i1',
      tenant_id: 't1',
      outside_ksef_original_path: klucz,
      issue_date: '2026-03-10',
    });
    expect(klucze.r2).toContain(klucz);
    expect(klucze.foreign).toBe(0);
  });

  it('klucz oryginału spoza katalogu firmy nie jest kasowany', async () => {
    const klucze = await collectInvoiceStorageKeys(bezPowiazan, {
      id: 'i1',
      tenant_id: 't1',
      outside_ksef_original_path: 'tenants/t2/outside-ksef/i1.pdf',
    });
    expect(klucze.r2).toEqual([]);
    expect(klucze.foreign).toBe(1);
  });

  it('runner retencji czyta kolumnę z klucza oryginału (inaczej plik zostałby na zawsze)', () => {
    const zrodlo = readFileSync('lib/jobs/runners/retention-delete.ts', 'utf8');
    expect(zrodlo).toMatch(/\.select\('[^']*outside_ksef_original_path/);
  });
});
