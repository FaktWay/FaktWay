import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ logo: vi.fn(), auth: vi.fn(), get: vi.fn(), flag: vi.fn(), capture: vi.fn() }));

vi.mock('@/lib/supabase/auth-context', () => ({ resolveApiUserAndActiveOrg: mocks.auth }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('@/lib/saldo/baza', () => ({ getBalanceConfirmation: mocks.get }));
vi.mock('@/lib/saldo/wylacznik', () => ({ czyPotwierdzenieSaldaWlaczone: mocks.flag }));
vi.mock('@/lib/pdf/logo-odczyt', () => ({ loadCompanyPdfLogo: mocks.logo }));
vi.mock('@sentry/nextjs', () => ({ captureException: mocks.capture }));

import { GET } from '@/app/api/saldo/[id]/pdf/route';

/** D59: przy wyłączonym wyłączniku PDF już wystawionego potwierdzenia salda da się pobrać. */

const ID = '00215215-3333-4000-8000-000000000001';
const strona = { name: 'Firma', nip: '1234567890', countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa', email: null };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ ok: true, tenantId: 'tenant-a' });
  mocks.flag.mockResolvedValue(false);
  mocks.logo.mockResolvedValue({ logo: null, key: null });
  mocks.get.mockResolvedValue({
    id: ID, tenantId: 'tenant-a', number: 'PS/1/2026', asOf: '2026-11-25', issuedAt: '2026-11-25T09:30:00.000Z', contractorId: null,
    counterparty: strona, issuer: strona, items: [], omitted: [], total: 0,
  });
});

describe('trasa PDF potwierdzenia salda przy wyłączonym wyłączniku (D59)', () => {
  it('oddaje plik PDF i nie pyta o wyłącznik', async () => {
    const odpowiedz = await GET(new Request('https://example.test/x'), { params: Promise.resolve({ id: ID }) });
    expect(odpowiedz.status, String(mocks.capture.mock.calls[0]?.[0])).toBe(200);
    expect(odpowiedz.headers.get('Content-Type')).toBe('application/pdf');
    expect(Buffer.from(await odpowiedz.arrayBuffer()).subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(mocks.flag).not.toHaveBeenCalled();
  });
});
