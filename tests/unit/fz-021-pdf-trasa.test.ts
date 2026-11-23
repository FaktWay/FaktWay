import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), pdf: vi.fn(), capture: vi.fn() }));

vi.mock('@/lib/supabase/auth-context', () => ({ resolveApiUserAndActiveOrg: mocks.auth }));
vi.mock('@/lib/pdf/invoice-pdf', () => ({ generateInvoicePdf: mocks.pdf }));
vi.mock('@sentry/nextjs', () => ({ captureException: mocks.capture }));

import { GET } from '@/app/api/invoices/[id]/pdf/route';

/** FZ-021: odmowa PDF faktury w walucie innej niż PLN to 409 z tekstem odmowy (ekran pokazuje go zamiast ogólnego błędu). */

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ ok: true, tenantId: 'tenant-a' });
});

describe('FZ-021: trasa PDF przy walucie innej niż PLN', () => {
  it('409 z tekstem odmowy, bez zgłoszenia błędu do Sentry', async () => {
    const error = 'Faktura FZ/7/2026 jest w walucie EUR. Wydruk PDF w FaktWay pokazuje kwoty tylko w złotych, więc go nie tworzymy.';
    mocks.pdf.mockResolvedValue({ success: false, code: 'CURRENCY_NOT_SUPPORTED', error });
    const odpowiedz = await GET(new Request('https://example.test/api/invoices/x/pdf'), { params: Promise.resolve({ id: 'x' }) });
    expect(odpowiedz.status).toBe(409);
    expect(await odpowiedz.json()).toEqual({ error });
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});
