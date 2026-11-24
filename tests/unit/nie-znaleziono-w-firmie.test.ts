import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));

import { deleteContractor, updateContractor } from '@/lib/contractors/manage';
import { describeResetError } from '@/lib/invoices/ksef-send-policy';
import { describeKsefSendError } from '@/lib/invoices/ksef-send-step';
import { sendRegularDraft } from '@/lib/invoices/send-draft';

/**
 * Osobne ustalenie 25 z dziennika planu (uwaga N1 czytelnika #924): kontrahent
 * i faktura, których nie ma w firmie, dawały goły tekst „Nie znaleziono … w tej
 * organizacji.”, bez powodu i bez wyjścia (protokół napraw, punkt 4), a przy
 * kontrahencie i szkicu ten sam tekst wracał też po błędzie odczytu bazy, więc
 * klient szukał rzeczy, która istnieje, zamiast spróbować ponownie (jak
 * ustalenie 16 przy produktach).
 *
 * Prawdziwe funkcje zapisu i wysyłki; atrapa tylko zapytania do bazy.
 */

const KONTRAHENT_BRAK = 'Nie znaleziono kontrahenta w tej firmie. Mógł go usunąć ktoś inny albo w innej karcie wybrano inną firmę. Odśwież listę kontrahentów.';
const FAKTURA_BRAK = 'Nie znaleziono faktury w tej firmie. Mogła zostać usunięta albo w innej karcie wybrano inną firmę. Odśwież listę faktur.';

/** Zapytanie PostgREST zwracające `result` (odczyt jednego wiersza albo zapis z `.select()`). */
function db(result: { data: unknown; error: { message: string } | null }) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'update', 'delete', 'eq', 'in', 'is']) q[m] = () => q;
  q.maybeSingle = async () => result;
  q.then = (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => Promise.resolve(result).then(ok, fail);
  return { from: () => q } as never;
}

const CTX = { tenantId: 'ten-1', userId: 'user-1' };
const EDYCJA = { name: 'Klient sp. z o.o.', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa', email: '' };

describe('kontrahent, którego nie ma w firmie (ustalenie 25)', () => {
  it('edycja bez wiersza: powód i wyjście, w tej firmie', async () => {
    expect(await updateContractor(db({ data: null, error: null }), 'c-1', EDYCJA, CTX as never))
      .toEqual({ success: false, reason: 'not_found', error: KONTRAHENT_BRAK });
  });

  it('edycja przy błędzie odczytu: spróbuj ponownie, a nie „nie znaleziono”', async () => {
    const r = await updateContractor(db({ data: null, error: { message: 'connection failure' } }), 'c-1', EDYCJA, CTX as never);
    expect(r).toEqual({
      success: false,
      reason: 'failed',
      error: 'Nie udało się odczytać kontrahenta, więc zmian nie zapisaliśmy. Spróbuj ponownie za chwilę.',
    });
  });

  it('usunięcie bez wiersza: powód i wyjście', async () => {
    expect(await deleteContractor(db({ data: [], error: null }), 'c-1', CTX as never))
      .toEqual({ success: false, reason: 'not_found', error: KONTRAHENT_BRAK });
  });
});

describe('faktura, której nie ma w firmie (ustalenie 25)', () => {
  it('wysyłka szkicu bez wiersza: powód i wyjście', async () => {
    expect(await sendRegularDraft({ supabase: db({ data: null, error: null }), userId: 'user-1', tenantId: 'ten-1' } as never, 'inv-1'))
      .toEqual({ success: false, reason: 'not_found', error: FAKTURA_BRAK });
  });

  it('wysyłka szkicu przy błędzie odczytu: spróbuj ponownie, a nie „nie znaleziono”', async () => {
    expect(await sendRegularDraft({ supabase: db({ data: null, error: { message: 'connection failure' } }), userId: 'user-1', tenantId: 'ten-1' } as never, 'inv-1'))
      .toEqual({
        success: false,
        reason: 'refused',
        error: 'Nie udało się odczytać faktury, więc jej nie wysłaliśmy. Spróbuj ponownie za chwilę.',
      });
  });

  it('ponowna wysyłka i przywrócenie wysyłki bez faktury (P0002): powód i wyjście', () => {
    expect(describeKsefSendError({ code: 'P0002', message: 'x' }, { kind: 'requeue', actorUserId: 'user-1' })).toBe(FAKTURA_BRAK);
    expect(describeResetError({ code: 'P0002', message: 'x' })).toBe(FAKTURA_BRAK);
  });
});
