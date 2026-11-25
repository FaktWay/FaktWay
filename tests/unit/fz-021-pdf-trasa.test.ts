import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), pdf: vi.fn(), capture: vi.fn() }));

vi.mock('@/lib/supabase/auth-context', () => ({ resolveApiUserAndActiveOrg: mocks.auth }));
vi.mock('@/lib/pdf/invoice-pdf', () => ({ generateInvoicePdf: mocks.pdf }));
vi.mock('@sentry/nextjs', () => ({ captureException: mocks.capture }));

import { GET } from '@/app/api/invoices/[id]/pdf/route';

/**
 * FZ-021 i FZ-037: odmowa PDF faktury w walucie innej niż PLN albo bez pełnych danych do wydruku to 409
 * z tekstem odmowy (ekran pokazuje go zamiast ogólnego „Nie udało się pobrać PDF faktury.”).
 */

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ ok: true, tenantId: 'tenant-a' });
});

describe('trasa PDF: odmowy z tekstem (FZ-021, FZ-037)', () => {
  it.each([
    ['CURRENCY_NOT_SUPPORTED', 'Faktura FZ/7/2026 jest w walucie EUR. Wydruk PDF w FaktWay pokazuje kwoty tylko w złotych, więc go nie tworzymy.'],
    [
      'PRINT_DATA_MISSING',
      'Faktura FZ/7/2026 nie ma w FaktWay pełnych danych sprzedawcy, nabywcy albo płatności (tak jest przy fakturze zakupu ze Skrzynki KSeF), więc wydruku PDF nie tworzymy.',
    ],
  ])('%s: 409 z tekstem odmowy, bez zgłoszenia błędu do Sentry', async (code, error) => {
    mocks.pdf.mockResolvedValue({ success: false, code, error });
    const odpowiedz = await GET(new Request('https://example.test/api/invoices/x/pdf'), { params: Promise.resolve({ id: 'x' }) });
    expect(odpowiedz.status).toBe(409);
    expect(await odpowiedz.json()).toEqual({ error });
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});
