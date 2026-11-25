import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, memoryDb, type MemoryDb, type Row } from '../helpers/fake-supabase-memory';

/**
 * GET /api/saldo/[id]/pdf (krok 2.9, część 2, PR B): PDF wystawionego
 * potwierdzenia salda dla członka aktywnej firmy. Firma ze zweryfikowanego
 * członkostwa, odczyt klientem z sesji (RLS 00215); dokument innej firmy
 * i zły identyfikator to 404, zepsuty wiersz to 500 bez PDF.
 */

const TENANT = 'ten-1';
const DOK = '00215215-3333-4000-8000-000000000001';
const OBCY = '00215215-3333-4000-8000-000000000002';
const ZEPSUTY = '00215215-3333-4000-8000-000000000003';

const m = vi.hoisted(() => ({ ctx: vi.fn(), client: vi.fn(), sentry: vi.fn() }));

vi.mock('@/lib/supabase/auth-context', () => ({ resolveApiUserAndActiveOrg: m.ctx }));
vi.mock('@/lib/supabase/server', () => ({ createClient: m.client }));
vi.mock('@sentry/nextjs', () => ({ captureException: m.sentry }));
vi.mock('@/lib/pdf/logo-odczyt', () => ({ loadCompanyPdfLogo: vi.fn().mockResolvedValue({ logo: null, key: null }) }));

import { GET } from '@/app/api/saldo/[id]/pdf/route';

const strona = { name: 'Firma', nip: '1234567890', countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' };
const pozycja = {
  invoiceId: '00215215-2222-4000-8000-000000000001', number: 'FV/1/2026', ksefNumber: null, issueDate: '2026-10-01',
  dueDate: null, kind: 'regular', type: 'VAT', gross: 100, amountDue: 100, paid: 0, outstanding: 100,
};

function dokument(extra: Row = {}): Row {
  return {
    id: DOK, tenant_id: TENANT, contractor_id: null, number: 'PS/3/2026', as_of: '2026-11-25', currency: 'PLN',
    counterparty: strona, issuer: strona, items: [pozycja], omitted: [], total: 100, issued_at: '2026-11-25T09:30:00.000Z', ...extra,
  };
}

let db: MemoryDb;

function get(id: string) {
  return GET(new Request(`http://localhost/api/saldo/${id}/pdf`), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  db = memoryDb({
    balance_confirmations: [dokument(), dokument({ id: OBCY, tenant_id: 'ten-2' }), dokument({ id: ZEPSUTY, items: [{ invoiceId: 'x' }] })],
  });
  m.ctx.mockResolvedValue({ ok: true, userId: 'u-1', tenantId: TENANT, role: 'member' });
  m.client.mockResolvedValue(fakeSupabase(db));
});

describe('GET /api/saldo/[id]/pdf', () => {
  it('PDF wystawionego dokumentu z nazwą pliku z numeru, bez pamięci podręcznej', async () => {
    const res = await get(DOK);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="potwierdzenie-salda-PS-3-2026.pdf"');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('dokument innej firmy i zły identyfikator: 404', async () => {
    expect((await get(OBCY)).status).toBe(404);
    expect((await get('nie-uuid')).status).toBe(404);
  });

  it('wiersz w nieznanym kształcie: 500 z alarmem, bez PDF', async () => {
    const res = await get(ZEPSUTY);
    expect(res.status).toBe(500);
    expect(m.sentry).toHaveBeenCalledTimes(1);
  });

  it('bez sesji: status z kontekstu', async () => {
    m.ctx.mockResolvedValueOnce({ ok: false, status: 401, error: 'unauthorized' });
    expect((await get(DOK)).status).toBe(401);
  });
});
